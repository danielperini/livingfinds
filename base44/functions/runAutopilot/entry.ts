/**
 * runAutopilot — Motor de Decisão do Ads Autopilot LivingFinds
 * Analisa campanhas, keywords e produtos, gera decisões e alertas.
 * Se auto_apply_enabled=true, aplica ações permitidas via Amazon Ads API.
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
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
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

async function adsRequest(path, method = 'GET', body = null) {
  const token = await getAdsToken();
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
    'Amazon-Advertising-API-Scope': String(Deno.env.get('ADS_PROFILE_ID')),
    'Content-Type': 'application/json',
  };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${getAdsBaseUrl()}${path}`, opts);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Amazon API ${path}: ${res.status} ${err}`);
  }
  return res.json();
}

// ── Regras de decisão ──────────────────────────────────────────────

function evaluateCampaign(campaign, config) {
  const decisions = [];
  const alerts = [];
  const {
    acos_target, roas_target,
    max_bid_increase_pct, max_bid_decrease_pct,
    daily_budget_limit
  } = config;

  const { acos, roas, spend, sales, clicks, orders, daily_budget, name, campaign_id, state } = campaign;

  if (state === 'archived') return { decisions, alerts };
  if (!spend || spend < 1) return { decisions, alerts };

  // ALERTA: spend muito alto sem vendas
  if (spend > 20 && sales === 0) {
    alerts.push({
      alert_type: 'zero_sales',
      severity: 'critical',
      entity_type: 'campaign',
      entity_id: campaign_id,
      entity_name: name,
      message: `Campanha "${name}" gastou $${spend.toFixed(2)} sem nenhuma venda`,
      value: spend,
      threshold: 20,
    });
    decisions.push({
      action: 'pause_campaign',
      entity_type: 'campaign',
      entity_id: campaign_id,
      entity_name: name,
      current_value: daily_budget || 0,
      new_value: 0,
      change_pct: -100,
      reason: 'Campanha com gasto alto sem conversão',
      evidence: `Spend: $${spend?.toFixed(2)}, Vendas: $0, Cliques: ${clicks}`,
      risk_level: 'high',
      requires_approval: true,
    });
    return { decisions, alerts };
  }

  // ROAS abaixo da meta → reduzir orçamento
  if (roas !== null && roas > 0 && roas < roas_target * 0.5 && spend > 10) {
    const newBudget = Math.max((daily_budget || 10) * (1 - max_bid_decrease_pct / 100), 5);
    decisions.push({
      action: 'update_budget',
      entity_type: 'campaign',
      entity_id: campaign_id,
      entity_name: name,
      current_value: daily_budget || 0,
      new_value: Number(newBudget.toFixed(2)),
      change_pct: -max_bid_decrease_pct,
      reason: `ROAS ${roas.toFixed(2)}x abaixo da meta de ${roas_target}x`,
      evidence: `Spend: $${spend.toFixed(2)}, Vendas: $${sales.toFixed(2)}, ROAS: ${roas.toFixed(2)}x`,
      risk_level: 'medium',
      requires_approval: true,
    });
  }

  // ROAS acima da meta → aumentar orçamento
  if (roas !== null && roas > roas_target * 1.5 && spend > 5) {
    const newBudget = Math.min((daily_budget || 10) * (1 + max_bid_increase_pct / 100), daily_budget_limit / 5);
    decisions.push({
      action: 'update_budget',
      entity_type: 'campaign',
      entity_id: campaign_id,
      entity_name: name,
      current_value: daily_budget || 0,
      new_value: Number(newBudget.toFixed(2)),
      change_pct: max_bid_increase_pct,
      reason: `ROAS excelente ${roas.toFixed(2)}x — aumentar investimento`,
      evidence: `Spend: $${spend.toFixed(2)}, Vendas: $${sales.toFixed(2)}, Pedidos: ${orders}`,
      risk_level: 'low',
      requires_approval: false,
    });
  }

  // ACoS muito alto
  if (acos !== null && acos > acos_target * 2 && spend > 5) {
    alerts.push({
      alert_type: 'high_acos',
      severity: 'warning',
      entity_type: 'campaign',
      entity_id: campaign_id,
      entity_name: name,
      message: `ACoS ${acos.toFixed(1)}% está ${(acos / acos_target).toFixed(1)}x acima da meta`,
      value: acos,
      threshold: acos_target,
    });
  }

  return { decisions, alerts };
}

function evaluateKeyword(kw, config) {
  const decisions = [];
  const negatives = [];
  const { acos_target, min_bid, max_bid, max_bid_increase_pct, max_bid_decrease_pct } = config;

  const { keyword_id, keyword_text, match_type, bid, spend, sales, clicks, acos, campaign_id } = kw;

  if (kw.state === 'archived') return { decisions, negatives };
  if (!clicks || clicks < 3) return { decisions, negatives };

  // Keyword gasta e não converte → negativar
  if (clicks >= 10 && spend > 2 && sales === 0) {
    negatives.push({
      campaign_id,
      campaign_name: kw.campaign_name || '',
      ad_group_id: kw.ad_group_id,
      keyword_text: keyword_text || '',
      match_type: match_type || 'broad',
      clicks,
      spend,
      sales: 0,
      reason: `${clicks} cliques e $${spend.toFixed(2)} gastos sem nenhuma venda`,
    });
  }

  // ACoS acima da meta → reduzir bid
  if (acos !== null && acos > acos_target && bid > min_bid && clicks >= 5) {
    const reduction = Math.min((acos - acos_target) / acos_target, max_bid_decrease_pct / 100);
    const newBid = Math.max(bid * (1 - reduction), min_bid);
    if (newBid < bid - 0.01) {
      decisions.push({
        action: 'update_bid',
        entity_type: 'keyword',
        entity_id: keyword_id,
        entity_name: keyword_text || keyword_id,
        current_value: bid,
        new_value: Number(newBid.toFixed(2)),
        change_pct: -reduction * 100,
        reason: `ACoS ${acos.toFixed(1)}% acima da meta de ${acos_target}%`,
        evidence: `Cliques: ${clicks}, Spend: $${spend.toFixed(2)}, Vendas: $${sales.toFixed(2)}`,
        risk_level: 'low',
        requires_approval: false,
      });
    }
  }

  // ACoS abaixo da meta com bom volume → aumentar bid
  if (acos !== null && acos < acos_target * 0.7 && clicks >= 10 && sales > 0 && bid < max_bid) {
    const increase = Math.min(max_bid_increase_pct / 100, 0.10);
    const newBid = Math.min(bid * (1 + increase), max_bid);
    if (newBid > bid + 0.01) {
      decisions.push({
        action: 'update_bid',
        entity_type: 'keyword',
        entity_id: keyword_id,
        entity_name: keyword_text || keyword_id,
        current_value: bid,
        new_value: Number(newBid.toFixed(2)),
        change_pct: increase * 100,
        reason: `ACoS eficiente ${acos.toFixed(1)}% — escalar bid`,
        evidence: `Cliques: ${clicks}, Vendas: $${sales.toFixed(2)}, ACoS: ${acos.toFixed(1)}%`,
        risk_level: 'low',
        requires_approval: false,
      });
    }
  }

  return { decisions, negatives };
}

// ── Handler principal ──────────────────────────────────────────────

Deno.serve(async (req) => {
  const startTime = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const amazonAccountId = body.amazon_account_id;
    if (!amazonAccountId) return Response.json({ error: 'amazon_account_id required' }, { status: 400 });

    // Carregar configuração do autopilot
    const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: amazonAccountId });
    const config = configs[0] || {
      acos_target: 25, roas_target: 4, daily_budget_limit: 500,
      max_bid_increase_pct: 15, max_bid_decrease_pct: 20,
      min_bid: 0.10, max_bid: 5.00,
      auto_apply_enabled: false, approval_required: true,
    };

    // Criar run
    const run = await base44.asServiceRole.entities.AutopilotRun.create({
      amazon_account_id: amazonAccountId,
      status: 'running',
      trigger: body.trigger || 'manual',
      started_at: new Date().toISOString(),
    });

    // Carregar campanhas e keywords
    const [campaigns, keywords] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: amazonAccountId }, '-spend', 500),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: amazonAccountId }, '-spend', 2000),
    ]);

    const totalSpend = campaigns.reduce((s, c) => s + (c.spend || 0), 0);
    const totalSales = campaigns.reduce((s, c) => s + (c.sales || 0), 0);
    const avgAcos = totalSales > 0 ? (totalSpend / totalSales * 100) : 0;

    const allDecisions = [];
    const allAlerts = [];
    const allNegatives = [];

    // ALERTA: orçamento diário total
    if (totalSpend > config.daily_budget_limit * 0.9) {
      allAlerts.push({
        amazon_account_id: amazonAccountId,
        run_id: run.id,
        alert_type: 'budget_exceeded',
        severity: totalSpend > config.daily_budget_limit ? 'critical' : 'warning',
        entity_type: 'account',
        entity_id: amazonAccountId,
        entity_name: 'Conta',
        message: `Spend total $${totalSpend.toFixed(2)} atingiu ${((totalSpend / config.daily_budget_limit) * 100).toFixed(0)}% do limite diário`,
        value: totalSpend,
        threshold: config.daily_budget_limit,
      });
    }

    // Analisar campanhas
    for (const campaign of campaigns) {
      const { decisions, alerts } = evaluateCampaign(campaign, config);
      for (const d of decisions) allDecisions.push({ ...d, amazon_account_id: amazonAccountId, run_id: run.id });
      for (const a of alerts) allAlerts.push({ ...a, amazon_account_id: amazonAccountId, run_id: run.id });
    }

    // Analisar keywords
    for (const kw of keywords) {
      const { decisions, negatives } = evaluateKeyword(kw, config);
      for (const d of decisions) allDecisions.push({ ...d, amazon_account_id: amazonAccountId, run_id: run.id });
      for (const n of negatives) allNegatives.push({ ...n, amazon_account_id: amazonAccountId, status: 'pending' });
    }

    // Salvar decisões
    let decisionsCreated = 0;
    if (allDecisions.length > 0) {
      for (let i = 0; i < allDecisions.length; i += 200) {
        await base44.asServiceRole.entities.AutopilotDecision.bulkCreate(allDecisions.slice(i, i + 200));
        decisionsCreated += Math.min(200, allDecisions.length - i);
      }
    }

    // Salvar alertas
    if (allAlerts.length > 0) {
      await base44.asServiceRole.entities.AutopilotAlert.bulkCreate(allAlerts);
    }

    // Salvar sugestões de negativas
    if (allNegatives.length > 0) {
      for (let i = 0; i < allNegatives.length; i += 200) {
        await base44.asServiceRole.entities.NegativeKeywordSuggestion.bulkCreate(allNegatives.slice(i, i + 200));
      }
    }

    // Auto-apply decisões de baixo risco se habilitado
    let autoApplied = 0;
    if (config.auto_apply_enabled) {
      const autoDecisions = allDecisions.filter(d =>
        !d.requires_approval && d.risk_level === 'low' &&
        d.action === 'update_bid' && d.entity_type === 'keyword'
      );
      for (const d of autoDecisions.slice(0, 50)) {
        try {
          await adsRequest(`/v2/sp/keywords`, 'PUT', [{
            keywordId: d.entity_id,
            bid: d.new_value,
          }]);
          await base44.asServiceRole.entities.BidHistory.create({
            amazon_account_id: amazonAccountId,
            entity_type: 'keyword',
            entity_id: d.entity_id,
            entity_name: d.entity_name,
            bid_before: d.current_value,
            bid_after: d.new_value,
            change_pct: d.change_pct,
            reason: d.reason,
            applied_by: 'autopilot',
            decision_id: d.id,
          });
          autoApplied++;
        } catch (e) {
          console.error(`Failed to apply bid for ${d.entity_id}:`, e.message);
        }
      }
    }

    // Atualizar run
    await base44.asServiceRole.entities.AutopilotRun.update(run.id, {
      status: 'completed',
      campaigns_analyzed: campaigns.length,
      keywords_analyzed: keywords.length,
      decisions_generated: decisionsCreated,
      decisions_auto_applied: autoApplied,
      total_spend_analyzed: totalSpend,
      avg_acos: avgAcos,
      alerts_generated: allAlerts.length,
      completed_at: new Date().toISOString(),
    });

    return Response.json({
      ok: true,
      run_id: run.id,
      campaigns_analyzed: campaigns.length,
      keywords_analyzed: keywords.length,
      decisions_generated: decisionsCreated,
      decisions_auto_applied: autoApplied,
      alerts: allAlerts.length,
      negative_suggestions: allNegatives.length,
      total_spend: totalSpend,
      avg_acos: avgAcos,
      duration_ms: Date.now() - startTime,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});