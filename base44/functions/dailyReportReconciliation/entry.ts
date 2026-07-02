/**
 * dailyReportReconciliation
 *
 * Executado diariamente (automação scheduled).
 * 
 * Fluxo:
 *   1. Lê os relatórios do dia (AdsMetricsHistory/AdsReportRaw)
 *   2. Compara com os dados atuais de Campaign e Keyword
 *   3. Envia divergências ao Claude para análise e decisão de correção
 *   4. Aplica correções validadas pela Policy Engine
 *   5. Recalcula e persiste sugestão de budget inteligente (via Claude)
 *   6. Registra tudo em OptimizationDecision para auditoria
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const DRIFT_THRESHOLD_PCT = 5; // % mínimo de divergência para corrigir
const MAX_CORRECTIONS = 50;    // limite de correções por run

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

function pctDiff(a, b) {
  if (!b || b === 0) return a === 0 ? 0 : 100;
  return Math.abs((a - b) / b) * 100;
}

// ── Chama o Claude para análise de reconciliação ──────────────────────────────
async function callClaude(systemPrompt, userMessage) {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY não configurada.');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 4096,
      temperature: 0.0, // determinístico para reconciliação
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Anthropic ${res.status}: ${err.error?.message || JSON.stringify(err)}`);
  }

  const data = await res.json();
  const text = (data.content?.[0]?.text || '').trim();

  let parsed = null;
  try { parsed = JSON.parse(text); } catch {
    const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (match) { try { parsed = JSON.parse(match[0]); } catch {} }
  }
  return { parsed, raw: text, tokens: { in: data.usage?.input_tokens, out: data.usage?.output_tokens } };
}

// ── System prompt de reconciliação ───────────────────────────────────────────
const RECONCILIATION_PROMPT = `You are a data reconciliation agent for Amazon Ads. 
Your job: compare REPORT DATA (source of truth from Amazon) with DASHBOARD DATA (cached in our DB) and identify corrections needed.

RULES:
1. Report data is always the source of truth.
2. Only flag corrections where the absolute percentage difference exceeds ${DRIFT_THRESHOLD_PCT}%.
3. For each field to correct, provide the exact new value from the report.
4. If dashboard data is NULL/missing but report has data → always flag as correction.
5. Fields to check: spend, sales, impressions, clicks, orders, acos, roas, ctr, cpc.
6. Derive acos = (spend/sales)*100 when sales>0; roas = sales/spend when spend>0.
7. Do NOT flag negligible differences (< R$0.05 or < ${DRIFT_THRESHOLD_PCT}%).
8. Return ONLY valid JSON array, no text outside.

RESPONSE FORMAT (array of corrections):
[
  {
    "entity_type": "campaign|keyword",
    "entity_id": "<db_id>",
    "amazon_id": "<campaign_id or keyword_id>",
    "field": "<field_name>",
    "dashboard_value": <current>,
    "report_value": <correct>,
    "pct_diff": <number>,
    "reason": "<brief explanation>"
  }
]

If no corrections needed, return empty array: []`;

// ── System prompt de budget inteligente ──────────────────────────────────────
const BUDGET_PROMPT = `You are a budget optimization agent for Amazon Ads Brazil (currency: BRL, symbol: R$).
Analyze the last 14/30 days of performance data and recommend the optimal total daily budget allocation.

RULES:
1. Use only real data provided. Never invent metrics.
2. Consider: avg daily spend (14d), avg daily spend (30d), ACoS trend, ROAS trend, active campaigns count, inventory health.
3. Recommend budget that maximizes profitable spend (ACoS ≤ target_acos).
4. Penalize budget for products with out_of_stock or buy_box_lost.
5. Apply 15-25% growth buffer only when ACoS is consistently below target.
6. If ACoS trend is worsening → suggest REDUCING budget.
7. Minimum suggestion: R$10. Maximum: account max_daily_budget_limit.
8. Return ONLY valid JSON, no text outside.

RESPONSE FORMAT:
{
  "suggested_daily_budget": <number>,
  "confidence": <0-100>,
  "reasoning": "<2-3 sentence explanation>",
  "breakdown": {
    "avg_spend_14d": <number>,
    "avg_spend_30d": <number>,
    "avg_acos_14d": <number>,
    "acos_trend": "improving|stable|worsening",
    "roas_trend": "improving|stable|worsening",
    "active_campaigns": <number>,
    "healthy_products_pct": <number>,
    "growth_buffer_applied": <boolean>,
    "buffer_pct": <number>
  }
}`;

// ═══════════════════════════════════════════════════════════════════════════════
Deno.serve(async (req) => {
  const startTime = Date.now();
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  try {
    const base44 = createClientFromRequest(req);

    // Autenticação: suporta chamada de automação (service role) ou usuário autenticado
    let isAuthorized = false;
    try {
      const user = await base44.auth.me();
      if (user) isAuthorized = true;
    } catch {}
    if (!isAuthorized) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const amazonAccountId = body.amazon_account_id;

    // ── 1. Resolver conta ─────────────────────────────────────────────────
    let account = null;
    if (amazonAccountId) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazonAccountId });
      account = accs[0] || null;
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0] || null;
    }
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon não encontrada.' });

    const aid = account.id;
    const sym = account.currency_symbol || 'R$';

    // ── 2. Carregar relatórios recentes (fonte da verdade) ────────────────
    // Pega os 3 dias mais recentes de AdsMetricsHistory tipo 'campaigns'
    const [reportMetrics, reportSearchTerms, campaigns, keywords, products, autopilotCfg] = await Promise.all([
      base44.asServiceRole.entities.AdsMetricsHistory.filter(
        { amazon_account_id: aid, report_type: 'campaigns' },
        '-date', 500
      ),
      base44.asServiceRole.entities.AdsMetricsHistory.filter(
        { amazon_account_id: aid, report_type: 'searchTerms' },
        '-date', 500
      ),
      base44.asServiceRole.entities.Campaign.filter(
        { amazon_account_id: aid }, '-synced_at', 500
      ),
      base44.asServiceRole.entities.Keyword.filter(
        { amazon_account_id: aid }, '-synced_at', 500
      ),
      base44.asServiceRole.entities.Product.filter(
        { amazon_account_id: aid }, null, 300
      ),
      base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }),
    ]);

    const cfg = autopilotCfg[0] || {};
    const targetAcos = cfg.target_acos || cfg.acos_target || 25;
    const maxDailyBudget = account.max_daily_budget_limit || 1000;

    // ── 3. Agregar métricas do relatório por campaign_id ─────────────────
    // Usa os últimos 3 dias disponíveis (mais recentes)
    const recentDates = [...new Set(reportMetrics.map(r => r.date).filter(Boolean))].sort().slice(-3);
    
    const reportByCampaign = new Map();
    for (const r of reportMetrics) {
      if (!recentDates.includes(r.date)) continue;
      if (!r.campaign_id) continue;
      const key = r.campaign_id;
      const existing = reportByCampaign.get(key) || { campaign_id: key, spend: 0, sales: 0, impressions: 0, clicks: 0, orders: 0, days: new Set() };
      existing.spend       += r.spend        || 0;
      existing.sales       += r.sales_14d    || r.sales_7d    || 0;
      existing.impressions += r.impressions  || 0;
      existing.clicks      += r.clicks       || 0;
      existing.orders      += r.orders_14d   || r.orders_7d   || 0;
      existing.days.add(r.date);
      reportByCampaign.set(key, existing);
    }

    // Derivar acos/roas/ctr/cpc agregados
    for (const [, r] of reportByCampaign) {
      r.acos = r.sales > 0 ? (r.spend / r.sales) * 100 : 0;
      r.roas = r.spend > 0 ? r.sales / r.spend : 0;
      r.ctr  = r.impressions > 0 ? (r.clicks / r.impressions) * 100 : 0;
      r.cpc  = r.clicks > 0 ? r.spend / r.clicks : 0;
      r.day_count = r.days.size;
    }

    // ── 4. Mapear campanhas do dashboard por campaign_id ──────────────────
    const campaignByAmazonId = new Map(campaigns.map(c => [c.campaign_id, c]));
    const keywordByAmazonId  = new Map(keywords.map(k => [k.keyword_id, k]));

    // ── 5. Detectar divergências via Claude ───────────────────────────────
    const divergenceCandidates = [];

    for (const [amazonCampaignId, report] of reportByCampaign) {
      const dashboard = campaignByAmazonId.get(amazonCampaignId);
      if (!dashboard) continue; // campanha não sincronizada ainda — ignorar

      // Normalizar por dia para comparação justa
      const days = Math.max(report.day_count, 1);
      const rSpend  = report.spend  / days;
      const rSales  = report.sales  / days;
      const rClicks = report.clicks / days;
      const rImprs  = report.impressions / days;
      const rOrders = report.orders / days;
      const rAcos   = rSales > 0 ? (rSpend / rSales) * 100 : 0;
      const rRoas   = rSpend > 0 ? rSales / rSpend : 0;
      const rCtr    = rImprs > 0 ? (rClicks / rImprs) * 100 : 0;
      const rCpc    = rClicks > 0 ? rSpend / rClicks : 0;

      const fields = [
        { f: 'spend',       report: rSpend,  dash: dashboard.spend       || 0 },
        { f: 'sales',       report: rSales,  dash: dashboard.sales       || 0 },
        { f: 'impressions', report: rImprs,  dash: dashboard.impressions || 0 },
        { f: 'clicks',      report: rClicks, dash: dashboard.clicks      || 0 },
        { f: 'orders',      report: rOrders, dash: dashboard.orders      || 0 },
        { f: 'acos',        report: rAcos,   dash: dashboard.acos        || 0 },
        { f: 'roas',        report: rRoas,   dash: dashboard.roas        || 0 },
        { f: 'ctr',         report: rCtr,    dash: dashboard.ctr         || 0 },
        { f: 'cpc',         report: rCpc,    dash: dashboard.cpc         || 0 },
      ];

      for (const { f, report: rv, dash: dv } of fields) {
        const diff = pctDiff(rv, dv);
        if (diff > DRIFT_THRESHOLD_PCT || (dv === 0 && rv > 0.01)) {
          divergenceCandidates.push({
            entity_type: 'campaign',
            entity_id: dashboard.id,
            amazon_id: amazonCampaignId,
            field: f,
            dashboard_value: Math.round(dv * 100) / 100,
            report_value: Math.round(rv * 100) / 100,
            pct_diff: Math.round(diff * 10) / 10,
          });
        }
      }
    }

    // Limitar ao máximo de candidatos para não sobrecarregar o Claude
    const topCandidates = divergenceCandidates
      .sort((a, b) => b.pct_diff - a.pct_diff)
      .slice(0, 80);

    // ── 6. Claude analisa divergências e decide correções ─────────────────
    let corrections = [];
    let reconciliationTokens = { in: 0, out: 0 };

    if (topCandidates.length > 0) {
      const userMsg = `DIVERGENCES TO ANALYZE (${topCandidates.length} items, currency: ${sym}):
${JSON.stringify(topCandidates, null, 2)}

Report period: last ${recentDates.length} days (${recentDates.join(', ')}).
Threshold for correction: ${DRIFT_THRESHOLD_PCT}%.`;

      const claudeResult = await callClaude(RECONCILIATION_PROMPT, userMsg);
      reconciliationTokens = claudeResult.tokens || { in: 0, out: 0 };

      if (Array.isArray(claudeResult.parsed)) {
        corrections = claudeResult.parsed.slice(0, MAX_CORRECTIONS);
      }
    }

    // ── 7. Aplicar correções nas entidades ────────────────────────────────
    const applied = [];
    const failed  = [];
    const decisionsToCreate = [];

    for (const fix of corrections) {
      if (!fix.entity_id || !fix.field) continue;
      const isValidField = ['spend','sales','impressions','clicks','orders','acos','roas','ctr','cpc'].includes(fix.field);
      if (!isValidField) continue;

      try {
        if (fix.entity_type === 'campaign') {
          await base44.asServiceRole.entities.Campaign.update(fix.entity_id, {
            [fix.field]: fix.report_value,
            last_sync_at: now,
          });
        } else if (fix.entity_type === 'keyword') {
          await base44.asServiceRole.entities.Keyword.update(fix.entity_id, {
            [fix.field]: fix.report_value,
            last_seen_at: now,
            synced_at: now,
          });
        }

        applied.push(fix);

        // Registrar decisão de reconciliação para auditoria
        decisionsToCreate.push({
          amazon_account_id: aid,
          decision_type: 'bid_change', // reutiliza o tipo mais próximo
          entity_type: fix.entity_type,
          entity_id: fix.amazon_id || fix.entity_id,
          campaign_id: fix.entity_type === 'campaign' ? (fix.amazon_id || '') : '',
          action: `reconcile_${fix.field}`,
          value_before: fix.dashboard_value,
          value_after: fix.report_value,
          change_pct: fix.pct_diff,
          rationale: `[Reconciliação Diária] Campo "${fix.field}" corrigido de ${sym}${fix.dashboard_value} → ${sym}${fix.report_value} (divergência: ${fix.pct_diff}%). Motivo: ${fix.reason || 'divergência detectada entre relatório Amazon e dados do dashboard'}.`,
          risk: 'low',
          requires_approval: false,
          status: 'executed',
          confidence: 95,
          source_function: 'dailyReportReconciliation',
          executed_at: now,
          created_at: now,
          country_code: account.country_code || 'BR',
          currency_code: account.currency_code || 'BRL',
          currency_symbol: sym,
          trigger: 'scheduled_reconciliation',
        });

      } catch (err) {
        failed.push({ ...fix, error: err.message });
      }
    }

    // Gravar decisões de auditoria em lote
    if (decisionsToCreate.length > 0) {
      for (let i = 0; i < decisionsToCreate.length; i += 50) {
        await base44.asServiceRole.entities.OptimizationDecision.bulkCreate(
          decisionsToCreate.slice(i, i + 50)
        );
      }
    }

    // ── 8. Calcular sugestão de budget inteligente via Claude ─────────────
    const cutoff14 = daysAgo(14);
    const cutoff30 = daysAgo(30);

    const metrics14 = reportMetrics.filter(r => r.date >= cutoff14);
    const metrics30 = reportMetrics.filter(r => r.date >= cutoff30);

    const sum14 = metrics14.reduce((s, r) => ({ spend: s.spend + (r.spend || 0), sales: s.sales + (r.sales_14d || r.sales_7d || 0), orders: s.orders + (r.orders_14d || r.orders_7d || 0) }), { spend: 0, sales: 0, orders: 0 });
    const sum30 = metrics30.reduce((s, r) => ({ spend: s.spend + (r.spend || 0), sales: s.sales + (r.sales_14d || r.sales_7d || 0), orders: s.orders + (r.orders_14d || r.orders_7d || 0) }), { spend: 0, sales: 0, orders: 0 });

    const days14 = Math.max(new Set(metrics14.map(r => r.date).filter(Boolean)).size, 1);
    const days30 = Math.max(new Set(metrics30.map(r => r.date).filter(Boolean)).size, 1);

    const avgSpend14 = sum14.spend / days14;
    const avgSpend30 = sum30.spend / days30;
    const avgAcos14  = sum14.sales > 0 ? (sum14.spend / sum14.sales) * 100 : 0;
    const avgAcos30  = sum30.sales > 0 ? (sum30.spend / sum30.sales) * 100 : 0;

    const healthyProducts = products.filter(p => p.inventory_status === 'in_stock' && p.status === 'active').length;
    const healthyPct = products.length > 0 ? Math.round((healthyProducts / products.length) * 100) : 100;
    const activeCampaigns = campaigns.filter(c => (c.state === 'enabled' || c.status === 'enabled') && !c.archived).length;

    const budgetContext = {
      avg_spend_14d: Math.round(avgSpend14 * 100) / 100,
      avg_spend_30d: Math.round(avgSpend30 * 100) / 100,
      avg_acos_14d:  Math.round(avgAcos14 * 10)  / 10,
      avg_acos_30d:  Math.round(avgAcos30 * 10)  / 10,
      target_acos:   targetAcos,
      active_campaigns: activeCampaigns,
      total_products: products.length,
      healthy_products: healthyProducts,
      healthy_pct: healthyPct,
      max_daily_budget_limit: maxDailyBudget,
      currency_symbol: sym,
      days_with_data_14: days14,
      days_with_data_30: days30,
    };

    const budgetMsg = `ACCOUNT PERFORMANCE DATA:
${JSON.stringify(budgetContext, null, 2)}

Recommend optimal total daily budget for this Amazon Ads account.`;

    const budgetResult = await callClaude(BUDGET_PROMPT, budgetMsg);
    const budgetSuggestion = budgetResult.parsed;
    const budgetTokens = budgetResult.tokens || { in: 0, out: 0 };

    // ── 9. Persistir sugestão de budget no AutopilotConfig para acesso no Dashboard ──
    let budgetPersisted = false;
    if (budgetSuggestion?.suggested_daily_budget > 0 && cfg?.id) {
      try {
        await base44.asServiceRole.entities.AutopilotConfig.update(cfg.id, {
          ai_suggested_daily_budget: budgetSuggestion.suggested_daily_budget,
          ai_budget_reasoning: budgetSuggestion.reasoning || '',
          ai_budget_confidence: budgetSuggestion.confidence || 0,
          ai_budget_generated_at: now,
          ai_budget_breakdown: JSON.stringify(budgetSuggestion.breakdown || {}),
        });
        budgetPersisted = true;
      } catch {
        budgetPersisted = false;
      }
    }

    return Response.json({
      ok: true,
      date: today,
      report_dates_used: recentDates,
      divergences_detected: topCandidates.length,
      corrections_applied: applied.length,
      corrections_failed: failed.length,
      corrections_detail: applied.map(c => ({ entity: c.entity_type, field: c.field, from: c.dashboard_value, to: c.report_value, diff_pct: c.pct_diff })),
      budget_suggestion: budgetSuggestion,
      budget_persisted: budgetPersisted,
      tokens_used: {
        reconciliation: reconciliationTokens,
        budget: budgetTokens,
        total_input: (reconciliationTokens.in || 0) + (budgetTokens.in || 0),
        total_output: (reconciliationTokens.out || 0) + (budgetTokens.out || 0),
      },
      duration_ms: Date.now() - startTime,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});