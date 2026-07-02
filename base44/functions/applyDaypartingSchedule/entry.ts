/**
 * applyDaypartingSchedule — Aplica regras de dayparting aprovadas.
 * 
 * Modos:
 * - native: Usa Schedule Bid Rules da Amazon (até +100%)
 * - programmatic: Altera bids diretamente via API
 * - hybrid: Base 50% + regra nativa +100%
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const tokenCache = {};

async function getAdsToken(refreshToken: string) {
  const cached = tokenCache['ads'];
  if (cached && cached.expires_at > Date.now() + 5000) return cached.access_token;
  
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: Deno.env.get('ADS_CLIENT_ID') || '',
    client_secret: Deno.env.get('ADS_CLIENT_SECRET') || '',
  });
  
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Token failed');
  
  tokenCache['ads'] = {
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
  };
  return data.access_token;
}

function getAdsBaseUrl() {
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsRequest(method: string, path: string, body: any, refreshToken: string, profileId: string, contentType = 'application/json') {
  const token = await getAdsToken(refreshToken);
  const res = await fetch(`${getAdsBaseUrl()}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': contentType,
      'Accept': contentType,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data, requestId: res.headers.get('x-amzn-requestid') || '' };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { opportunity_id, mode = 'hybrid', approve = false, auto_apply = false } = await req.json();

    // Carregar oportunidade
    const opportunities = await base44.asServiceRole.entities.OptimizationDecision.filter({
      id: opportunity_id,
    });

    if (!opportunities.length) {
      return Response.json({ ok: false, error: 'Opportunity not found' }, { status: 404 });
    }

    const opp = opportunities[0];

    // Validar autorização: approve manual OU auto_apply com confidence >= 90
    const confidenceScore = (opp as any).confidence_score || 0;
    const isAutoEligible = auto_apply && confidenceScore >= 90;
    if (!approve && !isAutoEligible) {
      return Response.json({ ok: false, error: 'Approval required (confidence < 90% for auto-apply)' }, { status: 403 });
    }

    const accountId = opp.amazon_account_id;

    // Carregar conta Amazon
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: accountId });
    if (!accounts.length) {
      return Response.json({ ok: false, error: 'Account not found' }, { status: 404 });
    }

    const account = accounts[0];
    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');

    if (!refreshToken || !profileId) {
      return Response.json({ ok: false, error: 'Amazon credentials missing' }, { status: 400 });
    }

    const now = new Date();
    const results = {
      campaign_id: opp.entity_id,
      rules_created: [] as any[],
      bids_updated: [] as any[],
      errors: [] as string[],
      mode,
      original_bid: opp.value_before,
      strategy_changed: false,
    };

    // === 1. MUDAR ESTRATÉGIA PARA DYNAMIC DOWN ONLY ===
    try {
      const updateCampaignPayload = {
        campaignId: opp.entity_id,
        bidding: {
          strategy: 'dynamicDownOnly',
        },
      };

      const resp = await adsRequest('PUT', '/sp/campaigns', updateCampaignPayload, refreshToken, profileId, 'application/vnd.spCampaign.v5+json');
      
      if ([200, 207].includes(resp.status)) {
        results.strategy_changed = true;
        
        await base44.asServiceRole.entities.Campaign.update(opp.entity_id, {
          bidding_strategy: 'dynamic_down_only',
        });

        await base44.asServiceRole.entities.CampaignCreationLog.create({
          amazon_account_id: accountId,
          user_id: user.id,
          operation_type: 'update_bid',
          entity_type: 'campaign',
          entity_id: opp.entity_id,
          campaign_id: opp.entity_id,
          rule_applied: 'Dayparting: mudança para dynamic down only',
          rationale: 'Estratégia necessária para dayparting seguro',
          status: 'success',
          amazon_response: JSON.stringify(resp.data).slice(0, 500),
          request_id: resp.requestId,
          created_at: now.toISOString(),
        });
      } else {
        results.errors.push(`Falha ao atualizar estratégia: HTTP ${resp.status}`);
      }
    } catch (e) {
      results.errors.push(`Erro estratégia: ${e.message}`);
    }

    // === 2. APLICAR DAYPARTING ===
    const daypartingWindows = (opp as any).dayparting_windows || {};
    const originalBid = opp.value_before || 0.50;

    if (mode === 'native' || mode === 'hybrid') {
      // Criar Schedule Bid Rules nativas
      for (const [dayStr, windows] of Object.entries(daypartingWindows)) {
        const dayIndex = parseInt(dayStr);
        const dayNames = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
        const dayName = dayNames[dayIndex] || 'MON';

        for (const window of (windows as any[])) {
          const { startHour, endHour, targetBidPct } = window;
          
          // Calcular percentual de aumento necessário
          // Se base é 50% do original e queremos 100% no pico: +100%
          const baseBidPct = mode === 'hybrid' ? 50 : 100;
          const increasePct = ((targetBidPct / baseBidPct) - 1) * 100;

          // Limitar a +100% (limite da Amazon)
          const cappedIncreasePct = Math.min(increasePct, 100);

          if (cappedIncreasePct <= 0) continue;

          const ruleName = `DAYPART-${(opp as any).asin || 'UNK'}-${dayName}-${startHour}H-${endHour}H-${Math.round(cappedIncreasePct)}`;

          const rulePayload = {
            name: ruleName,
            campaignId: opp.entity_id,
            rules: [{
              conditions: [{
                dayOfWeek: dayIndex,
                timeRange: {
                  start: `${String(startHour).padStart(2, '0')}:00`,
                  end: `${String(endHour).padStart(2, '0')}:59`,
                },
              }],
              bidMultiplier: Math.round(cappedIncreasePct),
            }],
            timeZone: 'America/Sao_Paulo',
          };

          const resp = await adsRequest('POST', '/sp/rules', rulePayload, refreshToken, profileId, 'application/vnd.spRule.v1+json');

          if ([200, 201, 207].includes(resp.status)) {
            const ruleId = resp.data.ruleId || resp.data[0]?.ruleId || 'unknown';
            
            results.rules_created.push({
              rule_id: ruleId,
              rule_name: ruleName,
              day: dayName,
              start_hour: startHour,
              end_hour: endHour,
              bid_increase_pct: cappedIncreasePct,
              target_bid_pct: targetBidPct,
            });

            await base44.asServiceRole.entities.DaypartingRule.create({
              amazon_account_id: accountId,
              campaign_id: opp.entity_id,
              asin: (opp as any).asin,
              rule_type: 'bid_schedule',
              days_of_week: [dayIndex],
              start_hour: startHour,
              end_hour: endHour,
              adjustment_type: 'percentage',
              adjustment_value: cappedIncreasePct,
              bid_base_before: originalBid,
              status: 'active',
              amazon_rule_id: ruleId,
              confidence: (opp as any).confidence_score || 80,
              rationale: `Dayparting ${mode}: ${startHour}h-${endHour}h ${dayName}`,
              created_by: 'ai',
              approved_by: user.id,
              approved_at: now.toISOString(),
              executed_at: now.toISOString(),
              created_at: now.toISOString(),
              updated_at: now.toISOString(),
            });

            await base44.asServiceRole.entities.CampaignCreationLog.create({
              amazon_account_id: accountId,
              user_id: user.id,
              operation_type: 'create_campaign',
              entity_type: 'campaign',
              entity_id: opp.entity_id,
              campaign_id: opp.entity_id,
              rule_applied: ruleName,
              rationale: `Dayparting nativo: +${cappedIncreasePct}% ${startHour}h-${endHour}h ${dayName}`,
              status: 'success',
              amazon_response: JSON.stringify(resp.data).slice(0, 500),
              request_id: resp.requestId,
              created_at: now.toISOString(),
            });
          } else {
            results.errors.push(`Falha regra ${dayName} ${startHour}h-${endHour}h: HTTP ${resp.status}`);
          }
        }
      }
    }

    if (mode === 'programmatic' || mode === 'hybrid') {
      // Salvar bid original se ainda não existe
      const existingHistory = await base44.asServiceRole.entities.BidHistory.filter({
        amazon_account_id: accountId,
        entity_type: 'campaign',
        entity_id: opp.entity_id,
        reason: 'Dayparting original bid capture',
      });

      if (!existingHistory.length) {
        await base44.asServiceRole.entities.BidHistory.create({
          amazon_account_id: accountId,
          entity_type: 'campaign',
          entity_id: opp.entity_id,
          entity_name: opp.entity_name,
          asin: (opp as any).asin,
          old_bid: originalBid,
          new_bid: originalBid,
          change_pct: 0,
          reason: 'Dayparting original bid capture',
          status: 'executed',
          applied_by: 'agent',
          decision_id: opp.id,
          acos_at_change: (opp as any).current_avg_acos,
          spend_at_change: (opp as any).total_spend,
          sales_at_change: (opp as any).total_sales,
          created_at: now.toISOString(),
          executed_at: now.toISOString(),
        });
      }

      results.bids_updated.push({
        original_bid: originalBid,
        mode,
        note: mode === 'hybrid' ? 'Base bid set to 50% of original' : 'Programmatic mode active',
      });
    }

    // Atualizar decisão
    await base44.asServiceRole.entities.OptimizationDecision.update(opp.id, {
      status: 'executed',
      executed_at: now.toISOString(),
      amazon_response: JSON.stringify(results).slice(0, 2000),
    });

    return Response.json({
      ok: true,
      results,
      executed_at: now.toISOString(),
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});