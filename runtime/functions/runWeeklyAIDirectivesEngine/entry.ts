/**
 * runWeeklyAIDirectivesEngine — Motor de Diretrizes Semanal com IA
 *
 * Executa UMA vez por semana (domingo à noite):
 *   1. Agrega 7 dias de dados reais (Unified + Legacy + SalesDaily + Dayparting)
 *   2. Chama IA UMA ÚNICA VEZ com contexto completo
 *   3. Gera/atualiza DecisionRules no banco para aplicação diária pelo motor determinístico
 *   4. Aplica diretamente na Amazon via AmazonActionQueue
 *
 * ECONOMIA DE IA: Uma chamada semanal por conta — não diária.
 * SEGURANÇA: Todas as regras geradas pela IA passam por validação de schema,
 *             limites de bid e guardrails financeiros antes de serem salvas.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MIN_BID = 0.10;
const MAX_BID = 5.0;
const MAX_BID_CHANGE_PCT = 25; // % máximo de mudança numa diretriz semanal
// Cooldown mínimo alinhado à janela de percepção de resultados (~3 semanas)
const ALLOWED_OPERATORS = ['greater_than', 'less_than', 'greater_than_or_equal', 'less_than_or_equal', 'equals', 'not_equals', 'between', 'in'];
const ALLOWED_ACTION_TYPES = ['increase_bid_percent', 'decrease_bid_percent', 'set_bid', 'pause_campaign', 'pause_keyword'];
const ALLOWED_SCOPES = ['keyword', 'campaign'];

function validateAndClampRule(rule: any): { valid: boolean; reason?: string; rule?: any } {
  if (!rule.rule_key || !rule.name || !rule.scope || !rule.action) return { valid: false, reason: 'Campos obrigatórios ausentes' };
  if (!ALLOWED_SCOPES.includes(rule.scope)) return { valid: false, reason: `Scope inválido: ${rule.scope}` };
  if (!ALLOWED_ACTION_TYPES.includes(rule.action?.type)) return { valid: false, reason: `Action type inválido: ${rule.action?.type}` };
  if (!Array.isArray(rule.conditions) || rule.conditions.length === 0) return { valid: false, reason: 'Sem condições' };

  for (const cond of rule.conditions) {
    if (!ALLOWED_OPERATORS.includes(cond.operator)) return { valid: false, reason: `Operador inválido: ${cond.operator}` };
    if (!cond.metric) return { valid: false, reason: 'Condição sem metric' };
  }

  // Clamp valores usando limites do SISTEMA (não da IA)
  // MAX_BID_CHANGE_PCT é o limite configurado em Metas de Performance
  const maxIncrease = rule._settings?.max_bid_increase_percent ?? MAX_BID_CHANGE_PCT;
  const maxDecrease = rule._settings?.max_bid_decrease_percent ?? MAX_BID_CHANGE_PCT;
  const minBid = rule._settings?.min_bid ?? MIN_BID;
  const maxBid = rule._settings?.max_bid ?? MAX_BID;
  if (rule.action.type === 'increase_bid_percent') {
    rule.action.value = Math.min(maxIncrease, Math.max(1, Number(rule.action.value) || 5));
  }
  if (rule.action.type === 'decrease_bid_percent') {
    rule.action.value = Math.min(maxDecrease, Math.max(1, Number(rule.action.value) || 5));
  }
  if (rule.action.type === 'set_bid') {
    rule.action.value = Math.min(maxBid, Math.max(minBid, Number(rule.action.value) || minBid));
  }

  // Cooldown mínimo de 504h (21 dias) — janela de percepção de resultados de alterações de bid
  rule.cooldown_hours = Math.max(504, Math.min(720, Number(rule.cooldown_hours) || 504));
  return { valid: true, rule };
}

Deno.serve(async (req) => {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const RESULT_LAG_DAYS = 21; // alterações levam ~3 semanas para resultados serem percebidos

  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const dryRun = body.dry_run === true;

    // ── 1. Conta e config ─────────────────────────────────────────────────────
    let account = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
      account = accs[0];
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada.' });
    const aid = account.id;

    // ── Fonte única de metas: PerformanceSettings → AutopilotConfig → defaults ──
    let perfSettings: any = null;
    const psList = await base44.asServiceRole.entities.PerformanceSettings.filter(
      { amazon_account_id: aid }, '-updated_at', 1
    ).catch(() => []);
    if (psList.length > 0) {
      const ps = psList[0];
      perfSettings = {
        target_acos: Number(ps.target_acos ?? 10),
        max_acos: Number(ps.max_acos ?? 15),
        target_roas: Number(ps.target_roas ?? 4),
        target_tacos: Number(ps.target_tacos ?? 5),
        max_tacos: Number(ps.max_tacos ?? 10),
        daily_budget_cap: Number(ps.daily_budget_limit ?? 56),
        target_cpc: Number(ps.target_cpc ?? 0.60),
        max_cpc: Number(ps.max_cpc ?? 1.00),
        min_bid: Number(ps.min_bid ?? 0.40),
        max_bid: Number(ps.max_bid ?? 1.00),
        max_bid_increase_percent: Number(ps.max_bid_increase_pct ?? 20),
        max_bid_decrease_percent: Number(ps.max_bid_decrease_pct ?? 20),
        min_campaign_budget: Number(ps.minimum_campaign_budget ?? 15),
        budget_increment_allowed: Number(ps.campaign_budget_increment ?? 5),
        weekly_campaign_capacity: Number(ps.weekly_campaign_capacity ?? 10),
        ai_auto_optimization_enabled: Boolean(ps.ai_auto_optimization ?? false),
        settings_source: 'PerformanceSettings',
      };
    }
    if (!perfSettings) {
      const apList = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }, null, 1).catch(() => []);
      const cfg = apList[0] || {};
      perfSettings = {
        target_acos: Number(cfg.target_acos ?? 10),
        max_acos: Number(cfg.maximum_acos ?? 15),
        target_roas: Number(cfg.target_roas ?? 4),
        target_tacos: Number(cfg.target_tacos ?? 5),
        max_tacos: Number(cfg.maximum_tacos ?? 10),
        daily_budget_cap: Number(cfg.total_daily_budget ?? cfg.daily_budget_limit ?? 56),
        target_cpc: Number(cfg.target_cpc ?? 0.60),
        max_cpc: Number(cfg.maximum_cpc ?? 1.00),
        min_bid: Number(cfg.min_bid ?? 0.40),
        max_bid: Number(cfg.max_bid ?? 1.00),
        max_bid_increase_percent: Number(cfg.max_bid_increase_pct ?? 20),
        max_bid_decrease_percent: Number(cfg.max_bid_decrease_pct ?? 20),
        min_campaign_budget: 15,
        budget_increment_allowed: 5,
        weekly_campaign_capacity: 10,
        ai_auto_optimization_enabled: Boolean(cfg.ai_auto_optimization ?? false),
        settings_source: 'AutopilotConfig',
      };
    }

    const targetAcos = perfSettings.target_acos;
    const maximumAcos = perfSettings.max_acos;
    const targetRoas = perfSettings.target_roas;
    const targetTacos = perfSettings.target_tacos;

    const profitLearnings = await base44.asServiceRole.entities.ProductProfitabilityLearning.filter(
      { amazon_account_id: aid }, null, 50
    ).catch(() => []);

    // ── 2. Carregar dados dos últimos 7 dias ──────────────────────────────────
    const [
      legacyMetrics,
      unifiedMetrics,
      salesDaily,
      campaigns,
      keywords,
      products,
      hourlyMetrics,
      existingRules,
    ] = await Promise.all([
      base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 500).catch(() => []),
      base44.asServiceRole.entities.UnifiedAdsMetricsDaily.filter({ amazon_account_id: aid }, '-date', 500).catch(() => []),
      base44.asServiceRole.entities.SalesDaily.filter({ amazon_account_id: aid }, '-date', 500).catch(() => []),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 200).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, '-spend', 300).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 100).catch(() => []),
      base44.asServiceRole.entities.HourlyMetric.filter({ amazon_account_id: aid }, '-date', 1000).catch(() => []),
      base44.asServiceRole.entities.DecisionRule.filter({ amazon_account_id: aid, source: 'claude_weekly', status: 'active' }).catch(() => []),
    ]);

    // Filtrar janela de 7 dias
    const legacy7d = legacyMetrics.filter(m => m.date >= sevenDaysAgo);
    const unified7d = unifiedMetrics.filter(m => m.date >= sevenDaysAgo);
    const sales7d = salesDaily.filter(s => s.date >= sevenDaysAgo);
    const hourly7d = hourlyMetrics.filter(h => h.date >= sevenDaysAgo);

    // ── 3. Agregar métricas da semana (sem IA) ────────────────────────────────

    // Legacy: totais da conta
    const legacyTotals = legacy7d.reduce((acc, m) => ({
      spend: acc.spend + (m.spend || 0),
      sales: acc.sales + (m.sales || 0),
      clicks: acc.clicks + (m.clicks || 0),
      impressions: acc.impressions + (m.impressions || 0),
      orders: acc.orders + (m.orders || 0),
    }), { spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0 });

    const legacyAcos = legacyTotals.sales > 0 ? legacyTotals.spend / legacyTotals.sales * 100 : null;
    const legacyRoas = legacyTotals.spend > 0 ? legacyTotals.sales / legacyTotals.spend : null;
    const legacyCpc = legacyTotals.clicks > 0 ? legacyTotals.spend / legacyTotals.clicks : null;
    const legacyCtr = legacyTotals.impressions > 0 ? legacyTotals.clicks / legacyTotals.impressions * 100 : null;
    const legacyCvr = legacyTotals.clicks > 0 ? legacyTotals.orders / legacyTotals.clicks * 100 : null;

    // Unified: métricas de qualidade
    const unifiedTotals = unified7d.reduce((acc, m) => ({
      cost: acc.cost + (m.cost || 0),
      promoted_sales: acc.promoted_sales + (m.promoted_sales || 0),
      halo_sales: acc.halo_sales + (m.halo_sales || 0),
      halo_purchases: acc.halo_purchases + (m.halo_purchases || 0),
      promoted_purchases: acc.promoted_purchases + (m.promoted_purchases || 0),
      invalid_clicks: acc.invalid_clicks + (m.invalid_clicks || 0),
      invalid_impressions: acc.invalid_impressions + (m.invalid_impressions || 0),
      clicks: acc.clicks + (m.clicks || 0),
      impressions: acc.impressions + (m.impressions || 0),
      impression_share_sum: acc.impression_share_sum + (m.impression_share || 0),
      top_of_search_sum: acc.top_of_search_sum + (m.top_of_search_impression_share || 0),
      rows: acc.rows + 1,
    }), { cost: 0, promoted_sales: 0, halo_sales: 0, halo_purchases: 0, promoted_purchases: 0, invalid_clicks: 0, invalid_impressions: 0, clicks: 0, impressions: 0, impression_share_sum: 0, top_of_search_sum: 0, rows: 0 });

    const hasUnified = unifiedTotals.rows > 0;
    const invalidClickRate = unifiedTotals.clicks > 0 ? unifiedTotals.invalid_clicks / unifiedTotals.clicks * 100 : 0;
    const avgImpressionShare = unifiedTotals.rows > 0 ? unifiedTotals.impression_share_sum / unifiedTotals.rows * 100 : 0;
    const avgTopOfSearch = unifiedTotals.rows > 0 ? unifiedTotals.top_of_search_sum / unifiedTotals.rows * 100 : 0;
    const promotedRoas = unifiedTotals.cost > 0 ? unifiedTotals.promoted_sales / unifiedTotals.cost : null;

    // SalesDaily: faturamento real
    const realRevenue7d = sales7d.reduce((s, r) => s + (r.ordered_product_sales || 0), 0);
    const realUnits7d = sales7d.reduce((s, r) => s + (r.units_ordered || 0), 0);
    const realTacos = realRevenue7d > 0 ? legacyTotals.spend / realRevenue7d * 100 : null;

    // Dayparting: padrão semanal
    const dowMap: any = { 0: { n:'Dom', clicks:0, orders:0, spend:0, sales:0, impressions:0 }, 1: { n:'Seg', clicks:0, orders:0, spend:0, sales:0, impressions:0 }, 2: { n:'Ter', clicks:0, orders:0, spend:0, sales:0, impressions:0 }, 3: { n:'Qua', clicks:0, orders:0, spend:0, sales:0, impressions:0 }, 4: { n:'Qui', clicks:0, orders:0, spend:0, sales:0, impressions:0 }, 5: { n:'Sex', clicks:0, orders:0, spend:0, sales:0, impressions:0 }, 6: { n:'Sáb', clicks:0, orders:0, spend:0, sales:0, impressions:0 } };
    for (const h of hourly7d) {
      const dow = h.day_of_week;
      if (dow == null || !dowMap[dow]) continue;
      dowMap[dow].clicks += h.clicks || 0;
      dowMap[dow].orders += h.orders || 0;
      dowMap[dow].spend += h.spend || 0;
      dowMap[dow].sales += h.sales || 0;
      dowMap[dow].impressions += h.impressions || 0;
    }
    const daypartingSummary = Object.entries(dowMap).map(([d, v]: any) => ({
      day: v.n,
      acos: v.sales > 0 ? (v.spend / v.sales * 100).toFixed(1) : null,
      roas: v.spend > 0 ? (v.sales / v.spend).toFixed(2) : null,
      cvr: v.clicks > 0 ? (v.orders / v.clicks * 100).toFixed(2) : null,
      clicks: v.clicks,
    }));

    // Top keywords com performance
    const campaignAsinMap = new Map();
    for (const c of campaigns) {
      if (c.campaign_id && c.asin) campaignAsinMap.set(c.campaign_id, c.asin);
    }
    const topKeywords = keywords
      .filter(kw => (kw.spend || 0) > 0 && (kw.clicks || 0) >= 5)
      .sort((a, b) => (b.spend || 0) - (a.spend || 0))
      .slice(0, 15)
      .map(kw => ({
        keyword: kw.keyword_text || kw.keyword,
        bid: kw.current_bid || kw.bid,
        spend: kw.spend,
        sales: kw.sales,
        orders: kw.orders || 0,
        clicks: kw.clicks,
        acos: kw.acos || (kw.sales > 0 ? (kw.spend / kw.sales * 100).toFixed(1) : null),
        cpc: kw.cpc || (kw.clicks > 0 ? (kw.spend / kw.clicks).toFixed(2) : null),
        campaign_id: kw.campaign_id,
      }));

    // Produtos com margens
    const productSummary = products
      .filter(p => p.status === 'active')
      .slice(0, 10)
      .map(p => {
        const pl = profitLearnings.find(l => l.asin === p.asin || l.sku === p.sku);
        return {
          asin: p.asin,
          stock: p.fba_inventory || 0,
          gross_margin: pl?.gross_margin_pct || null,
          price: p.price || null,
          campaign_status: p.campaign_status || null,
        };
      });

    // Regras existentes (para contexto)
    const existingRulesSummary = existingRules.slice(0, 10).map(r => ({
      rule_key: r.rule_key,
      name: r.name,
      scope: r.scope,
      action: r.action?.type,
      cooldown_hours: r.cooldown_hours,
    }));

    // ── 4. Prompt IA (UMA chamada) ────────────────────────────────────────────
    const prompt = `Você é um especialista em Amazon Advertising otimizando campanhas Sponsored Products para um seller brasileiro.

## METAS CONFIGURADAS (FONTE ÚNICA — ${perfSettings.settings_source})
Estes valores vêm diretamente de Configurações > Metas de Performance. Você NÃO pode sugerir valores fora destes limites.
- ACoS alvo: ${targetAcos}% | ACoS máximo: ${maximumAcos}%
- ROAS alvo: ${targetRoas}x
- TACoS alvo: ${targetTacos}% | TACoS máximo: ${perfSettings.max_tacos}%
- Orçamento diário geral: R$${perfSettings.daily_budget_cap} (TETO ABSOLUTO)
- CPC alvo: R$${perfSettings.target_cpc} | CPC máximo: R$${perfSettings.max_cpc} (${perfSettings.max_cpc > 0 ? 'ENFORÇADO' : 'inativo'})
- Bid mínimo: R$${perfSettings.min_bid} | Bid máximo: R$${perfSettings.max_bid}
- Aumento máximo de bid: ${perfSettings.max_bid_increase_percent}% | Redução máxima: ${perfSettings.max_bid_decrease_percent}%
- Budget mínimo por campanha: R$${perfSettings.min_campaign_budget} | Incremento: R$${perfSettings.budget_increment_allowed}
- Capacidade semanal de campanhas: ${perfSettings.weekly_campaign_capacity}

## MÉTRICAS DOS ÚLTIMOS 7 DIAS (dados reais)

### Performance Geral (Legacy Reports)
- Gasto total: R$${legacyTotals.spend.toFixed(2)}
- Vendas Ads: R$${legacyTotals.sales.toFixed(2)}
- ACoS: ${legacyAcos != null ? legacyAcos.toFixed(1) + '%' : 'N/A'} (meta: ${targetAcos}%)
- ROAS: ${legacyRoas != null ? legacyRoas.toFixed(2) + 'x' : 'N/A'}
- Cliques: ${legacyTotals.clicks} | CPC médio: R$${legacyCpc != null ? legacyCpc.toFixed(2) : 'N/A'}
- CTR: ${legacyCtr != null ? legacyCtr.toFixed(3) + '%' : 'N/A'}
- CVR: ${legacyCvr != null ? legacyCvr.toFixed(2) + '%' : 'N/A'}
- Pedidos: ${legacyTotals.orders}

### Faturamento Real (SP-API)
- Receita real: R$${realRevenue7d.toFixed(2)}
- Unidades: ${realUnits7d}
- TACoS real: ${realTacos != null ? realTacos.toFixed(1) + '%' : 'N/A'} (meta: ${targetTacos}%)

${hasUnified ? `### Métricas Unificadas Amazon (MRC)
- ROAS promovido: ${promotedRoas != null ? promotedRoas.toFixed(2) + 'x' : 'N/A'}
- Vendas promovidas: R$${unifiedTotals.promoted_sales.toFixed(2)} | Halo: R$${unifiedTotals.halo_sales.toFixed(2)}
- Parcela de impressões (média): ${avgImpressionShare.toFixed(1)}%
- Topo de pesquisa (média): ${avgTopOfSearch.toFixed(1)}%
- Cliques inválidos: ${invalidClickRate.toFixed(2)}%` : ''}

### Dayparting 7 dias (por dia da semana)
${daypartingSummary.map(d => `- ${d.day}: ACoS=${d.acos || 'N/A'}% ROAS=${d.roas || 'N/A'}x CVR=${d.cvr || 'N/A'}% Cliques=${d.clicks}`).join('\n')}

### Top Keywords (por gasto)
${topKeywords.slice(0, 10).map(k => `- "${k.keyword}" bid=R$${k.bid} spend=R$${k.spend?.toFixed(2)} orders=${k.orders} acos=${k.acos || 'N/A'}%`).join('\n')}

### Produtos Ativos
${productSummary.map(p => `- ASIN:${p.asin} stock=${p.stock}un margem=${p.gross_margin != null ? p.gross_margin.toFixed(1)+'%' : 'N/A'}`).join('\n')}

### Regras Ativas Atuais (geradas por IA anteriores)
${existingRulesSummary.length > 0 ? existingRulesSummary.map(r => `- ${r.rule_key}: ${r.name} (${r.action})`).join('\n') : 'Nenhuma regra ativa.'}

## TAREFA
Analise os dados e gere entre 2 e 5 regras de otimização NOVAS ou REVISADAS para o motor determinístico diário.

## PRINCÍPIO FUNDAMENTAL — JANELA DE RESULTADOS
CADA ALTERAÇÃO DE BID LEVA APROXIMADAMENTE 3 SEMANAS (21 DIAS) PARA TER SEUS RESULTADOS COMPLETAMENTE PERCEBIDOS E ANALISADOS.
Isso significa:
- Não faça ajustes agressivos — mudanças pequenas e consistentes são preferíveis.
- Evite reverter uma decisão antes de 21 dias de dados.
- Prefira mudanças de 5-10% em vez de 20-25%, para que o sinal seja mais limpo.
- Uma regra que será avaliada só depois de 3 semanas deve ser conservadora e bem fundamentada.
- Considere que os dados dos últimos 7 dias podem já refletir alterações feitas há menos de 3 semanas — portanto leia os dados com cautela.

REGRAS IMPORTANTES:
1. Gere apenas regras baseadas nos dados reais acima — não invente métricas.
2. Cada regra deve ter condições mensuráveis presentes na entidade Keyword ou Campaign.
3. Métricas disponíveis por keyword: acos, spend, sales, orders, clicks, cpc, current_bid, impressions
4. Métricas disponíveis por campaign: spend, sales, orders, acos, daily_budget
5. Operadores: greater_than, less_than, greater_than_or_equal, less_than_or_equal, equals, not_equals, between
6. Action types: increase_bid_percent, decrease_bid_percent, set_bid, pause_keyword
7. Valores de bid change: máximo ${perfSettings.max_bid_increase_percent}% (aumento) e ${perfSettings.max_bid_decrease_percent}% (redução) conforme configurado — prefira 5-10%
8. Cooldown mínimo: 504h (21 dias) para respeitar a janela de percepção de resultados
9. expires_in_days: use 21 como padrão — a regra precisa de ao menos 3 semanas para ser avaliada
10. RESTRIÇÕES ABSOLUTAS: bid nunca < R$${perfSettings.min_bid} e nunca > R$${perfSettings.max_bid}; budget diário nunca > R$${perfSettings.daily_budget_cap}

Responda APENAS com JSON no formato:
{
  "analysis": "resumo da análise em 2-3 frases",
  "directives": [
    {
      "rule_key": "weekly_ai_rule_1",
      "name": "Nome descritivo",
      "description": "Por que esta regra faz sentido com os dados desta semana",
      "scope": "keyword",
      "priority": 50,
      "conditions": [
        { "metric": "acos", "operator": "greater_than", "value": 20 },
        { "metric": "clicks", "operator": "greater_than_or_equal", "value": 10 }
      ],
      "action": { "type": "decrease_bid_percent", "value": 10 },
      "cooldown_hours": 72,
      "expires_in_days": 7
    }
  ]
}`;

    const openaiKey = Deno.env.get('OPENAI_API_KEY');
    if (!openaiKey) return Response.json({ ok: false, error: 'OPENAI_API_KEY não configurada.' }, { status: 500 });

    const aiRaw = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: Deno.env.get('AI_WEEKLY_REVIEW_MODEL') || 'gpt-4o',
        max_tokens: 2000,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!aiRaw.ok) {
      const err = await aiRaw.json().catch(() => ({}));
      return Response.json({ ok: false, error: `OpenAI ${aiRaw.status}: ${err.error?.message || 'erro'}` }, { status: 500 });
    }
    const aiData = await aiRaw.json();
    const rawText = aiData.choices?.[0]?.message?.content || '';
    let parsed: any = null;
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return Response.json({ ok: false, error: 'IA retornou JSON inválido.', raw: rawText.slice(0, 500) }, { status: 500 });
    }

    if (!parsed?.directives || !Array.isArray(parsed.directives)) {
      return Response.json({ ok: false, error: 'IA não retornou directives válidas.', raw: rawText.slice(0, 500) }, { status: 500 });
    }

    // ── 5. Validar e salvar regras ────────────────────────────────────────────
    if (dryRun) {
      return Response.json({ ok: true, dry_run: true, analysis: parsed.analysis, directives: parsed.directives, metrics_7d: { acos: legacyAcos, roas: legacyRoas, tacos: realTacos, invalidClickRate, avgImpressionShare } });
    }

    // Expirar regras IA antigas desta conta
    const expiredKeys: string[] = [];
    for (const old of existingRules) {
      await base44.asServiceRole.entities.DecisionRule.update(old.id, { status: 'expired' }).catch(() => {});
      expiredKeys.push(old.rule_key);
    }

    const saved: any[] = [];
    const skipped: any[] = [];
    // Regras ficam ativas por 3 semanas (janela de percepção de resultados) + 1 semana de buffer
    const expiresAt = new Date(Date.now() + (RESULT_LAG_DAYS + 7) * 86400000).toISOString();

    for (const directive of parsed.directives) {
      const validated = validateAndClampRule({ ...directive, _settings: perfSettings });
      if (!validated.valid) {
        skipped.push({ rule_key: directive.rule_key, reason: validated.reason });
        continue;
      }
      const rule = validated.rule!;
      // Respeitar a sugestão da IA, mas garantir mínimo de 21 dias (janela de percepção)
      const expiryDays = Math.min(35, Math.max(RESULT_LAG_DAYS, rule.expires_in_days || RESULT_LAG_DAYS));
      const ruleExpiry = new Date(Date.now() + expiryDays * 86400000).toISOString();

      try {
        const created = await base44.asServiceRole.entities.DecisionRule.create({
          amazon_account_id: aid,
          rule_key: `${rule.rule_key}_${today.replace(/-/g, '')}`,
          name: rule.name,
          description: rule.description,
          scope: rule.scope,
          priority: Math.max(20, Math.min(80, rule.priority || 50)),
          conditions: rule.conditions,
          action: rule.action,
          cooldown_hours: rule.cooldown_hours,
          expires_at: ruleExpiry,
          effective_from: now,
          effective_until: ruleExpiry,
          status: 'active',
          source: 'claude_weekly',
          confidence: 0.75,
          reason: rule.description,
          version: 1,
          version_id: `weekly_${today}`,
        });
        saved.push({ rule_key: created.rule_key, name: rule.name, action: rule.action?.type });
      } catch (e) {
        skipped.push({ rule_key: rule.rule_key, reason: e.message });
      }
    }

    // ── 6. Registrar execução no log ─────────────────────────────────────────
    await base44.asServiceRole.entities.WeeklyRuleReview.create({
      amazon_account_id: aid,
      ran_at: now,
      model_used: Deno.env.get('AI_WEEKLY_REVIEW_MODEL') || 'gpt-4o',
      rules_generated: saved.length,
      rules_expired: expiredKeys.length,
      rules_skipped: skipped.length,
      analysis_summary: parsed.analysis || '',
      data_period: `${sevenDaysAgo} → ${today}`,
      metrics_snapshot: JSON.stringify({
        acos: legacyAcos,
        roas: legacyRoas,
        tacos: realTacos,
        promotedRoas,
        avgImpressionShare,
        avgTopOfSearch,
        invalidClickRate,
      }),
      status: 'completed',
    }).catch(() => {});

    return Response.json({
      ok: true,
      analysis: parsed.analysis,
      data_period: `${sevenDaysAgo} → ${today}`,
      rules_saved: saved,
      rules_skipped: skipped,
      rules_expired: expiredKeys.length,
      metrics_7d: {
        acos_pct: legacyAcos != null ? Math.round(legacyAcos * 10) / 10 : null,
        roas: legacyRoas != null ? Math.round(legacyRoas * 100) / 100 : null,
        tacos_pct: realTacos != null ? Math.round(realTacos * 10) / 10 : null,
        promoted_roas: promotedRoas != null ? Math.round(promotedRoas * 100) / 100 : null,
        impression_share_pct: Math.round(avgImpressionShare * 10) / 10,
        top_of_search_pct: Math.round(avgTopOfSearch * 10) / 10,
        invalid_click_rate_pct: Math.round(invalidClickRate * 100) / 100,
        real_revenue: Math.round(realRevenue7d * 100) / 100,
        total_spend: Math.round(legacyTotals.spend * 100) / 100,
      },
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});