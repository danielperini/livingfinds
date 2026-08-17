/**
 * executeDaypartingViaAgent — Executa dayparting diretamente via API Amazon.
 * Usado pelo agente Amazon Ads Operator para aplicar Schedule Bid Rules nativas.
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

    const { campaign_id, amazon_account_id, dayparting_windows, original_bid = 0.50, mode = 'native' } = await req.json();

    if (!campaign_id || !amazon_account_id) {
      return Response.json({ error: 'campaign_id and amazon_account_id required' }, { status: 400 });
    }

    // Carregar conta Amazon
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id });
    if (!accounts.length) {
      return Response.json({ error: 'Account not found' }, { status: 404 });
    }

    const account = accounts[0];
    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');

    if (!refreshToken || !profileId) {
      return Response.json({ error: 'Amazon credentials missing' }, { status: 400 });
    }

    const now = new Date();
    const results = {
      campaign_id,
      rules_created: [] as any[],
      errors: [] as string[],
      mode,
      original_bid,
      strategy_changed: false,
    };

    // === 1. MUDAR ESTRATÉGIA PARA DYNAMIC DOWN ONLY ===
    try {
      const updateCampaignPayload = {
        campaignId: campaign_id,
        bidding: {
          strategy: 'dynamicDownOnly',
        },
      };

      const resp = await adsRequest('PUT', '/sp/campaigns', updateCampaignPayload, refreshToken, profileId, 'application/vnd.spCampaign.v5+json');
      
      if ([200, 207].includes(resp.status)) {
        results.strategy_changed = true;
        
        await base44.asServiceRole.entities.Campaign.update(campaign_id, {
          bidding_strategy: 'dynamic_down_only',
        });

        await base44.asServiceRole.entities.CampaignCreationLog.create({
          amazon_account_id,
          user_id: user.id,
          operation_type: 'update_bid',
          entity_type: 'campaign',
          entity_id: campaign_id,
          campaign_id,
          rule_applied: 'Dayparting: mudança para dynamic down only',
          rationale: 'Estratégia necessária para dayparting seguro',
          status: 'success',
          amazon_response: JSON.stringify(resp.data).slice(0, 500),
          request_id: resp.requestId,
          created_at: now.toISOString(),
        });
      }
    } catch (e) {
      results.errors.push(`Erro estratégia: ${e.message}`);
    }

    // === 2. CRIAR SCHEDULE BID RULES ===
    if (mode === 'native' || mode === 'hybrid') {
      const dayNames = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

      for (const [dayStr, windows] of Object.entries(dayparting_windows || {})) {
        const dayIndex = parseInt(dayStr);
        const dayName = dayNames[dayIndex] || 'MON';

        for (const window of (windows as any[])) {
          const { startHour, endHour, targetBidPct } = window;
          
          // Calcular aumento necessário (base 50% no modo hybrid)
          const baseBidPct = mode === 'hybrid' ? 50 : 100;
          const increasePct = ((targetBidPct / baseBidPct) - 1) * 100;
          const cappedIncreasePct = Math.min(Math.max(increasePct, 0), 100); // 0 a 100%

          if (cappedIncreasePct <= 0) continue;

          const ruleName = `DAYPART-${campaign_id.slice(-6)}-${dayName}-${startHour}H-${endHour}H-${Math.round(cappedIncreasePct)}`;

          const rulePayload = {
            name: ruleName,
            campaignId: campaign_id,
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
              amazon_account_id,
              campaign_id,
              rule_type: 'bid_schedule',
              days_of_week: [dayIndex],
              start_hour: startHour,
              end_hour: endHour,
              adjustment_type: 'percentage',
              adjustment_value: cappedIncreasePct,
              status: 'active',
              amazon_rule_id: ruleId,
              confidence: 85,
              rationale: `Dayparting via agente: ${startHour}h-${endHour}h ${dayName}`,
              created_by: 'agent',
              approved_by: user.id,
              approved_at: now.toISOString(),
              executed_at: now.toISOString(),
              created_at: now.toISOString(),
              updated_at: now.toISOString(),
            });

            await base44.asServiceRole.entities.CampaignCreationLog.create({
              amazon_account_id,
              user_id: user.id,
              operation_type: 'create_campaign',
              entity_type: 'campaign',
              entity_id: campaign_id,
              campaign_id,
              rule_applied: ruleName,
              rationale: `Dayparting via agente: +${cappedIncreasePct}% ${startHour}h-${endHour}h ${dayName}`,
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

    return Response.json({
      ok: true,
      results,
      executed_at: now.toISOString(),
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});