/**
 * runDailyAdsOptimization — Job diário de otimização completa.
 * Executa todas as etapas de sincronização e gera ações de otimização via IA.
 * SEGURANÇA: Apenas reduções pequenas de bid são auto-aplicadas. Todo o resto requer aprovação.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const tokenCache = {};

async function getAdsToken() {
  const cached = tokenCache['ads'];
  if (cached && cached.expires_at > Date.now()) return cached.access_token;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: Deno.env.get('ADS_REFRESH_TOKEN'),
    client_id: Deno.env.get('ADS_CLIENT_ID'),
    client_secret: Deno.env.get('ADS_CLIENT_SECRET'),
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token failed');
  tokenCache['ads'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function getAdsBaseUrl() {
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsRequest(method, path, body) {
  const token = await getAdsToken();
  const res = await fetch(`${getAdsBaseUrl()}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
      'Amazon-Advertising-API-Scope': String(Deno.env.get('ADS_PROFILE_ID')),
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return await res.json();
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id } = body;
    if (!amazon_account_id) return Response.json({ error: 'amazon_account_id required' }, { status: 400 });

    const now = new Date().toISOString();
    const logSteps = [];

    // ── 1. Buscar regras de budget ──
    const budgetRules = await base44.asServiceRole.entities.BudgetRule.filter({ amazon_account_id });
    const budgetRule = budgetRules[0] || { target_acos: 25, target_roas: 4, bid_decrease_step: 0.25, bid_increase_step: 0.10, min_bid: 0.10, max_bid: 5.0, auto_apply_bid_reduction: false };
    logSteps.push('budget_rules_loaded');

    // ── 2. Buscar campanhas, keywords e produtos ──
    const [campaigns, keywords, products] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id }, '-spend', 500),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id }, '-spend', 1000),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id }, null, 500),
    ]);
    logSteps.push(`data_loaded: ${campaigns.length} campanhas, ${keywords.length} keywords, ${products.length} produtos`);

    // ── 3. Atualizar dias_running nas campanhas criadas pelo app ──
    const appCampaigns = campaigns.filter(c => c.created_by_app && c.start_date);
    for (const c of appCampaigns) {
      const startDate = new Date(c.start_date);
      const daysRunning = Math.floor((Date.now() - startDate.getTime()) / 86400000);
      const newPhase = daysRunning < 3 ? 'new' : daysRunning < 7 ? 'learning' : daysRunning < 30 ? 'optimizing' : 'stable';
      if (c.days_running !== daysRunning || c.launch_phase !== newPhase) {
        await base44.asServiceRole.entities.Campaign.update(c.id, { days_running: daysRunning, launch_phase: newPhase });
      }
    }
    logSteps.push('campaign_phases_updated');

    // ── 4. Verificar produtos sem campanha que precisam de uma ──
    const productsNeedingCampaign = products.filter(p =>
      p.should_activate_campaign && !p.has_campaign &&
      p.status === 'active' && p.inventory_status !== 'out_of_stock'
    );

    const newCampaignActions = [];
    for (const p of productsNeedingCampaign) {
      newCampaignActions.push({
        amazon_account_id,
        action: 'create_auto_campaign',
        asin: p.asin,
        current_value: null,
        new_value: 0.25,
        reason: `Produto ${p.asin} marcado para ativar campanha e ainda não tem campanha criada`,
        evidence: `Produto ativo, estoque: ${p.inventory_status}, is_new: ${p.is_new_asin}`,
        risk_level: 'low',
        requires_approval: false,
      });
    }

    // ── 5. Análise IA de keywords ──
    const targetAcos = budgetRule.target_acos || 25;
    const targetRoas = budgetRule.target_roas || 4;
    const bidDecreaseStep = budgetRule.bid_decrease_step || 0.25;
    const bidIncreaseStep = budgetRule.bid_increase_step || 0.10;
    const minBid = budgetRule.min_bid || 0.10;
    const maxBid = budgetRule.max_bid || 5.0;
    const autoApplyReduction = budgetRule.auto_apply_bid_reduction || false;

    const keywordActions = [];

    for (const kw of keywords) {
      if ((kw.state || kw.status) === 'archived') continue;
      const currentBid = kw.current_bid || kw.bid || 0.25;
      const acos = kw.acos || 0;
      const roas = kw.roas || 0;
      const clicks = kw.clicks || 0;
      const spend = kw.spend || 0;
      const sales = kw.sales || 0;

      // Keyword com gasto alto, sem venda e ACoS alto → reduzir bid
      if (clicks >= 10 && spend > 3 && sales === 0 && acos === 0) {
        const newBid = Math.max(currentBid - bidDecreaseStep, minBid);
        if (newBid < currentBid) {
          keywordActions.push({
            amazon_account_id,
            action: 'update_bid',
            asin: kw.asin,
            campaign_id: kw.campaign_id,
            ad_group_id: kw.ad_group_id,
            keyword_id: kw.keyword_id,
            keyword: kw.keyword || kw.keyword_text,
            current_value: currentBid,
            new_value: newBid,
            reason: `${clicks} cliques, $${spend.toFixed(2)} gasto, zero vendas → reduzir bid`,
            evidence: `Sem conversão após ${clicks} cliques. ACoS: N/A. Spend: $${spend.toFixed(2)}`,
            risk_level: 'low',
            requires_approval: !autoApplyReduction,
          });
        }
      }
      // ACoS acima da meta → reduzir bid
      else if (acos > targetAcos * 1.5 && clicks >= 5) {
        const newBid = Math.max(currentBid - bidDecreaseStep, minBid);
        if (newBid < currentBid) {
          keywordActions.push({
            amazon_account_id,
            action: 'update_bid',
            asin: kw.asin,
            campaign_id: kw.campaign_id,
            ad_group_id: kw.ad_group_id,
            keyword_id: kw.keyword_id,
            keyword: kw.keyword || kw.keyword_text,
            current_value: currentBid,
            new_value: newBid,
            reason: `ACoS ${acos.toFixed(1)}% está ${((acos / targetAcos - 1) * 100).toFixed(0)}% acima da meta (${targetAcos}%)`,
            evidence: `Spend: $${spend.toFixed(2)}, Vendas: $${sales.toFixed(2)}, ACoS: ${acos.toFixed(1)}%`,
            risk_level: 'medium',
            requires_approval: true,
          });
        }
      }
      // Bom ROAS e ACoS abaixo da meta → aumentar bid
      else if (roas >= targetRoas && acos < targetAcos * 0.8 && sales > 0 && clicks >= 10) {
        const newBid = Math.min(currentBid + bidIncreaseStep, maxBid, currentBid * 1.15);
        if (newBid > currentBid) {
          keywordActions.push({
            amazon_account_id,
            action: 'update_bid',
            asin: kw.asin,
            campaign_id: kw.campaign_id,
            ad_group_id: kw.ad_group_id,
            keyword_id: kw.keyword_id,
            keyword: kw.keyword || kw.keyword_text,
            current_value: currentBid,
            new_value: Number(newBid.toFixed(2)),
            reason: `ROAS ${roas.toFixed(2)}x acima da meta e ACoS ${acos.toFixed(1)}% abaixo do alvo → aumentar bid para capturar mais tráfego`,
            evidence: `Spend: $${spend.toFixed(2)}, Vendas: $${sales.toFixed(2)}, ROAS: ${roas.toFixed(2)}x`,
            risk_level: 'medium',
            requires_approval: true,
          });
        }
      }

      // Keyword candidata à negativação (após avaliação)
      if (clicks >= 15 && spend > 5 && sales === 0) {
        keywordActions.push({
          amazon_account_id,
          action: 'negative_keyword',
          asin: kw.asin,
          campaign_id: kw.campaign_id,
          ad_group_id: kw.ad_group_id,
          keyword_id: kw.keyword_id,
          keyword: kw.keyword || kw.keyword_text,
          current_value: currentBid,
          new_value: null,
          reason: `${clicks} cliques e $${spend.toFixed(2)} sem nenhuma venda. Candidata à negativação.`,
          evidence: `Clicks: ${clicks}, Spend: $${spend.toFixed(2)}, Sales: $0. CTR: ${(kw.ctr || 0).toFixed(2)}%`,
          risk_level: 'high',
          requires_approval: true,
        });
      }
    }

    // ── 6. Análise de budget por campanha ──
    const budgetActions = [];
    const activeCampaigns = campaigns.filter(c => (c.state || c.status) === 'enabled');
    const currentTotalBudget = activeCampaigns.reduce((s, c) => s + (c.daily_budget || 0), 0);
    const totalBudgetLimit = budgetRule.total_daily_budget || 100;

    // Campanhas com ACoS muito alto → sugerir redução de budget
    for (const c of activeCampaigns) {
      if ((c.acos || 0) > targetAcos * 2 && (c.spend || 0) > 10) {
        const newBudget = Math.max((c.daily_budget || 10) * 0.8, 5);
        budgetActions.push({
          amazon_account_id,
          action: 'update_budget',
          campaign_id: c.campaign_id,
          asin: c.asin,
          current_value: c.daily_budget,
          new_value: Number(newBudget.toFixed(2)),
          reason: `ACoS ${(c.acos || 0).toFixed(1)}% está muito acima da meta. Reduzir budget em 20%.`,
          evidence: `Spend: $${(c.spend || 0).toFixed(2)}, Vendas: $${(c.sales || 0).toFixed(2)}, ACoS: ${(c.acos || 0).toFixed(1)}%`,
          risk_level: 'medium',
          requires_approval: true,
        });
      }
      // Produto sem estoque → pausar campanha
      const product = products.find(p => p.asin === c.asin);
      if (product && product.inventory_status === 'out_of_stock') {
        budgetActions.push({
          amazon_account_id,
          action: 'pause_campaign',
          campaign_id: c.campaign_id,
          asin: c.asin,
          current_value: null,
          new_value: null,
          reason: `ASIN ${c.asin} sem estoque. Pausar campanha para evitar gasto desnecessário.`,
          evidence: `inventory_status: out_of_stock`,
          risk_level: 'high',
          requires_approval: true,
        });
      }
    }

    // ── 7. Campanhas que completaram 7 dias de AUTO → criar campanha MANUAL ──
    const manualCampaignActions = [];
    const autoGraduatingCampaigns = campaigns.filter(c =>
      c.targeting_type === 'AUTO' && (c.days_running || 0) >= 7 &&
      c.launch_phase === 'optimizing' && !c.manual_campaign_created &&
      (c.clicks || 0) >= 20 && (c.sales || 0) > 0
    );
    for (const c of autoGraduatingCampaigns) {
      manualCampaignActions.push({
        amazon_account_id,
        action: 'create_manual_campaign',
        campaign_id: c.campaign_id,
        asin: c.asin,
        current_value: null,
        new_value: null,
        reason: `Campanha AUTO completou 7 dias com dados suficientes. Criar campanha MANUAL com keywords vencedoras.`,
        evidence: `Dias: ${c.days_running}, Cliques: ${c.clicks}, Vendas: $${(c.sales || 0).toFixed(2)}`,
        risk_level: 'medium',
        requires_approval: true,
      });
    }

    // ── 8. Salvar todas as ações no banco ──
    const allActions = [...newCampaignActions, ...keywordActions, ...budgetActions, ...manualCampaignActions];
    let actionsCreated = 0;

    if (allActions.length > 0) {
      for (let i = 0; i < allActions.length; i += 100) {
        const batch = allActions.slice(i, i + 100);
        await base44.asServiceRole.entities.AgentAction.bulkCreate(batch);
        actionsCreated += batch.length;
      }
    }

    // ── 9. Auto-aplicar reduções de bid aprovadas (se habilitado) ──
    let autoApplied = 0;
    if (autoApplyReduction) {
      const autoActions = allActions.filter(a => a.action === 'update_bid' && !a.requires_approval && a.new_value < a.current_value);
      for (const action of autoActions.slice(0, 20)) {
        try {
          await adsRequest('PUT', '/v2/sp/keywords', [{ keywordId: action.keyword_id, bid: action.new_value }]);
          // Registrar no BidHistory
          await base44.asServiceRole.entities.BidHistory.create({
            amazon_account_id,
            entity_type: 'keyword',
            entity_id: action.keyword_id,
            keyword: action.keyword,
            asin: action.asin,
            old_bid: action.current_value,
            new_bid: action.new_value,
            reason: action.reason,
            status: 'executed',
            applied_by: 'autopilot',
            created_at: now,
            executed_at: now,
          });
          // Atualizar keyword no banco
          const kws = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id, keyword_id: action.keyword_id });
          if (kws.length > 0) {
            await base44.asServiceRole.entities.Keyword.update(kws[0].id, { current_bid: action.new_value, bid: action.new_value });
          }
          autoApplied++;
        } catch (e) {
          console.error(`Failed to auto-apply bid for ${action.keyword_id}:`, e.message);
        }
      }
    }

    // ── 10. Log do ciclo ──
    await base44.asServiceRole.entities.SyncRun.create({
      amazon_account_id,
      operation: 'dailyOptimization',
      status: 'success',
      records_received: campaigns.length + keywords.length + products.length,
      records_upserted: actionsCreated,
      started_at: new Date(startTime).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
    });

    await base44.asServiceRole.entities.LearningEvent.create({
      amazon_account_id,
      event_type: 'daily_optimization',
      entity_type: 'account',
      entity_id: amazon_account_id,
      observation: `Otimização diária: ${actionsCreated} ações geradas (${keywordActions.length} keywords, ${budgetActions.length} budget, ${newCampaignActions.length} novas campanhas, ${manualCampaignActions.length} campanhas manuais). Auto-aplicadas: ${autoApplied}.`,
      recorded_at: now,
    });

    return Response.json({
      ok: true,
      actions_created: actionsCreated,
      auto_applied: autoApplied,
      breakdown: {
        keyword_actions: keywordActions.length,
        budget_actions: budgetActions.length,
        new_campaigns: newCampaignActions.length,
        manual_campaigns: manualCampaignActions.length,
      },
      duration_ms: Date.now() - startTime,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});