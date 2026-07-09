/**
 * runStrategyEngine — Motor de Estratégias de Ads
 *
 * Ciclo: MÉTRICAS → COMPARAÇÃO COM METAS → DECISÃO → AÇÃO → MATURAÇÃO → ANÁLISE
 *
 * Articulado com:
 *   - runDeterministicDecisionEngine (bid/budget rules)
 *   - runWeeklyAIDirectivesEngine (revisão semanal IA)
 *   - evaluateDecisionOutcomes (pós-maturação)
 *   - AmazonActionQueue (execução Amazon API)
 *
 * REGRAS ABSOLUTAS:
 *   - Bid: R$0,40 ≤ bid ≤ R$1,00
 *   - Variação máxima de bid: 20% por ciclo
 *   - Aumento máximo de budget: R$5/ciclo
 *   - Budget geral: máx R$56/dia
 *   - Sem keyword inventada por IA
 *   - Sem execução de placement se limite = 0
 *   - Sem otimização de campanha incompleta
 *   - Sem campanha para produto sem estoque
 *   - Maturação obrigatória antes de re-julgar
 *
 * Fonte única de metas: PerformanceSettings → AutopilotConfig → defaults
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ── Fallbacks absolutos — só se PerformanceSettings não existir ──────────────
const FB = {
  target_acos: 10, max_acos: 15, target_roas: 4,
  target_tacos: 5, max_tacos: 10,
  target_cpc: 0.60, max_cpc: 1.00,
  min_bid: 0.40, max_bid: 1.00,
  max_bid_increase_pct: 20, max_bid_decrease_pct: 20,
  daily_budget_cap: 56,
  min_campaign_budget: 15, budget_increment: 5,
  weekly_campaign_capacity: 10,
  pacing_enabled: true, dayparting_enabled: true,
  placement_enabled: true,
  top_of_search_limit: 0, rest_of_search_limit: 0, product_page_limit: 0,
};

// ── Períodos de maturação (horas) ──────────────────────────────────────────
const MATURATION = {
  campaign_created: 48,
  bid_increase: 48,
  bid_decrease: 24,
  budget_increase: 24,
  dayparting: 72,    // mínimo 3 dias / 3 ocorrências do bloco
  keyword_exact: 72,
  keyword_negated: 168, // 7 dias
  campaign_archived: 168,
};

// ── 100 Estratégias determinísticas ──────────────────────────────────────────
// Cada estratégia: { id, name, goal, check(data, s) → bool, build(data, s) → action | null }
// `s` = settings carregados; `data` = contexto enriquecido do objeto avaliado

function clampBid(bid: number, s: any): number {
  return Math.min(s.max_bid, Math.max(s.min_bid, bid));
}
function pctChange(old: number, pct: number, up: boolean, s: any): number {
  const change = Math.min(Math.abs(pct) / 100, (up ? s.max_bid_increase_pct : s.max_bid_decrease_pct) / 100);
  const newBid = up ? old * (1 + change) : old * (1 - change);
  return clampBid(newBid, s);
}

const STRATEGIES = [
  // ── ACoS excelente ────────────────────────────────────────────────────────
  { id: 'S001', name: 'ACoS excelente + baixa impressão → aumentar bid 12%', goal: 'acos', risk: 'low',
    maturation: MATURATION.bid_increase, use_ai: false,
    check: (d: any, s: any) => d.acos <= s.target_acos && d.roas >= s.target_roas && d.impression_share < 0.30 && d.clicks >= 10,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 12, true, s), reason: `ACoS ${d.acos.toFixed(1)}% ≤ ${s.target_acos}% e impressão baixa — escalar exposição` }) },

  { id: 'S002', name: 'ACoS excelente + CPC baixo → aumentar bid 20%', goal: 'acos', risk: 'low',
    maturation: MATURATION.bid_increase, use_ai: false,
    check: (d: any, s: any) => d.acos <= s.target_acos && d.cpc <= s.target_cpc && d.clicks >= 8,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 20, true, s), reason: `ACoS ${d.acos.toFixed(1)}% e CPC R$${d.cpc.toFixed(2)} abaixo do alvo — margem para escalar` }) },

  { id: 'S003', name: 'ACoS excelente + budget acaba cedo → aumentar budget R$5', goal: 'budget', risk: 'low',
    maturation: MATURATION.budget_increase, use_ai: false,
    check: (d: any, s: any) => d.acos <= s.target_acos && d.roas >= s.target_roas && d.budget_end_hour != null && d.budget_end_hour < 18,
    build: (d: any, s: any) => ({ action: 'adjust_budget', new_budget: Math.min(d.current_budget + s.budget_increment, d.current_budget + 5), reason: `Budget acaba às ${d.budget_end_hour}h com ACoS eficiente` }) },

  { id: 'S004', name: 'ACoS excelente + topo baixo → recomendar placement', goal: 'placement', risk: 'low',
    maturation: 0, use_ai: false,
    check: (d: any, s: any) => d.acos <= s.target_acos && d.roas >= s.target_roas && d.top_of_search_share < 0.20,
    build: (d: any, s: any) => s.top_of_search_limit > 0
      ? null // executar só se limite > 0
      : ({ action: 'recommend_placement', recommendation: `Aumentar Top of Search — ACoS ${d.acos.toFixed(1)}% saudável mas exposição baixa`, reason: 'Placement recomendado, não executado (limite = 0)' }) },

  { id: 'S005', name: 'Termo vencedor em AUTO → criar EXACT', goal: 'keyword', risk: 'medium',
    maturation: MATURATION.keyword_exact, use_ai: false,
    check: (d: any, s: any) => d.entity_type === 'search_term' && d.orders >= 1 && d.acos <= s.target_acos && d.is_auto_campaign,
    build: (d: any, s: any) => ({ action: 'create_manual_exact_campaign', keyword: d.term, bid: clampBid(Math.min(d.cpc || s.target_cpc, s.target_cpc), s), reason: `Termo "${d.term}" converteu em AUTO com ACoS ${d.acos.toFixed(1)}%` }) },

  { id: 'S006', name: 'ASIN halo recorrente → criar Product Target', goal: 'campaign', risk: 'medium',
    maturation: MATURATION.keyword_exact, use_ai: true,
    check: (d: any, s: any) => d.halo_purchases >= 2 && d.converted_asin,
    build: (d: any, s: any) => ({ action: 'create_product_target_campaign', target_asin: d.converted_asin, reason: `ASIN ${d.converted_asin} converte via halo/aura com ${d.halo_purchases} pedidos` }) },

  { id: 'S007', name: 'EXACT com ACoS bom → aumentar bid 10%', goal: 'acos', risk: 'low',
    maturation: MATURATION.bid_increase, use_ai: false,
    check: (d: any, s: any) => d.entity_type === 'keyword' && d.match_type === 'EXACT' && d.acos <= s.target_acos && d.clicks >= 8,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 10, true, s), reason: `EXACT ACoS ${d.acos.toFixed(1)}% ≤ ${s.target_acos}% — escalar keyword` }) },

  { id: 'S008', name: 'ROAS alto + budget mínimo → aumentar budget R$5', goal: 'roas', risk: 'low',
    maturation: MATURATION.budget_increase, use_ai: false,
    check: (d: any, s: any) => d.roas >= 6 && d.current_budget <= s.min_campaign_budget + 5,
    build: (d: any, s: any) => ({ action: 'adjust_budget', new_budget: d.current_budget + s.budget_increment, reason: `ROAS ${d.roas.toFixed(2)}x excelente com budget baixo` }) },

  { id: 'S009', name: 'CTR alto + ACoS bom → aumentar bid 8%', goal: 'acos', risk: 'low',
    maturation: MATURATION.bid_increase, use_ai: false,
    check: (d: any, s: any) => d.ctr > 0.004 && d.acos <= s.target_acos && d.clicks >= 10,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 8, true, s), reason: `CTR ${(d.ctr * 100).toFixed(3)}% alto com ACoS ${d.acos.toFixed(1)}% saudável` }) },

  { id: 'S010', name: 'Estoque alto + metas saudáveis → permitir expansão EXACT', goal: 'campaign', risk: 'medium',
    maturation: MATURATION.keyword_exact, use_ai: true,
    check: (d: any, s: any) => d.stock_coverage_days >= 60 && d.acos <= s.target_acos && d.roas >= s.target_roas,
    build: (_d: any, _s: any) => ({ action: 'increase_discovery', reason: 'Estoque abundante e metas saudáveis — habilitar descoberta de novos termos' }) },

  // ── ACoS zona de atenção ──────────────────────────────────────────────────
  { id: 'S011', name: 'ACoS entre alvo e máximo + CPC alto → reduzir bid 8%', goal: 'acos', risk: 'low',
    maturation: MATURATION.bid_decrease, use_ai: false,
    check: (d: any, s: any) => d.acos > s.target_acos && d.acos <= s.max_acos && d.cpc > s.target_cpc && d.clicks >= 8,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 8, false, s), reason: `ACoS ${d.acos.toFixed(1)}% (zona atenção) e CPC R$${d.cpc.toFixed(2)} acima do alvo` }) },

  { id: 'S012', name: 'ACoS zona atenção + budget acaba cedo → dayparting', goal: 'dayparting', risk: 'medium',
    maturation: MATURATION.dayparting, use_ai: false,
    check: (d: any, s: any) => d.acos > s.target_acos && d.acos <= s.max_acos && d.budget_end_hour != null && d.budget_end_hour < 18,
    build: (_d: any, s: any) => s.dayparting_enabled
      ? ({ action: 'adjust_dayparting', reason: 'ACoS em atenção e budget termina cedo — redistribuir via dayparting' })
      : null },

  { id: 'S013', name: 'ACoS zona atenção + ROAS bom → manter, monitorar', goal: 'acos', risk: 'low',
    maturation: 0, use_ai: false,
    check: (d: any, s: any) => d.acos > s.target_acos && d.acos <= s.max_acos && d.roas >= s.target_roas,
    build: (d: any, s: any) => ({ action: 'hold_for_maturation', reason: `ACoS ${d.acos.toFixed(1)}% em atenção mas ROAS ${d.roas.toFixed(2)}x OK — manter e monitorar` }) },

  { id: 'S014', name: 'ACoS zona atenção + CTR baixo → reduzir bid 10%', goal: 'acos', risk: 'low',
    maturation: MATURATION.bid_decrease, use_ai: false,
    check: (d: any, s: any) => d.acos > s.target_acos && d.acos <= s.max_acos && d.ctr < 0.002 && d.impressions >= 100,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 10, false, s), reason: `CTR ${(d.ctr * 100).toFixed(3)}% baixo com ACoS em atenção` }) },

  // ── ACoS crítico ──────────────────────────────────────────────────────────
  { id: 'S015', name: 'ACoS > máximo → reduzir bid 20%', goal: 'acos', risk: 'low',
    maturation: MATURATION.bid_decrease, use_ai: false,
    check: (d: any, s: any) => d.acos > s.max_acos && d.clicks >= 8 && d.spend >= 3,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 20, false, s), reason: `ACoS ${d.acos.toFixed(1)}% ACIMA do máximo ${s.max_acos}% — corte imediato` }) },

  { id: 'S016', name: 'ACoS > máximo + ROAS < alvo → reduzir bid 20% + bloquear budget', goal: 'acos', risk: 'medium',
    maturation: MATURATION.bid_decrease, use_ai: false,
    check: (d: any, s: any) => d.acos > s.max_acos && d.roas < s.target_roas && d.clicks >= 8,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 20, false, s), block_budget_increase: true, reason: `Ineficiência dupla — ACoS ${d.acos.toFixed(1)}% e ROAS ${d.roas.toFixed(2)}x fora das metas` }) },

  { id: 'S017', name: 'CPC > máximo → reduzir bid 20% imediato', goal: 'cpc', risk: 'low',
    maturation: MATURATION.bid_decrease, use_ai: false,
    check: (d: any, s: any) => d.cpc > s.max_cpc && d.clicks >= 5,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 20, false, s), reason: `CPC R$${d.cpc.toFixed(2)} ACIMA do máximo R$${s.max_cpc} — regra obrigatória` }) },

  { id: 'S018', name: 'ACoS crítico + 20+ cliques sem venda → reduzir bid + negativar', goal: 'acos', risk: 'medium',
    maturation: MATURATION.bid_decrease, use_ai: false,
    check: (d: any, s: any) => d.acos > s.max_acos && d.clicks >= 20 && (d.orders === 0),
    build: (d: any, s: any) => ({
      action: 'adjust_bid', new_bid: pctChange(d.current_bid, 20, false, s),
      suggest_negative: true,
      reason: `${d.clicks} cliques sem venda — ACoS puro desperdício acima de ${s.max_acos}%`
    }) },

  // ── ROAS ──────────────────────────────────────────────────────────────────
  { id: 'S019', name: 'ROAS >= 6x → aumentar bid até 20%', goal: 'roas', risk: 'low',
    maturation: MATURATION.bid_increase, use_ai: false,
    check: (d: any, s: any) => d.roas >= 6 && d.cpc <= s.target_cpc && d.clicks >= 8,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 20, true, s), reason: `ROAS ${d.roas.toFixed(2)}x excelente com CPC dentro do alvo` }) },

  { id: 'S020', name: 'ROAS >= 4x + impressão baixa → aumentar bid 12%', goal: 'roas', risk: 'low',
    maturation: MATURATION.bid_increase, use_ai: false,
    check: (d: any, s: any) => d.roas >= s.target_roas && d.impression_share < 0.30 && d.clicks >= 8,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 12, true, s), reason: `ROAS ${d.roas.toFixed(2)}x bom mas exposição baixa — ampliar` }) },

  { id: 'S021', name: 'ROAS >= 4x + budget não gasta → aumentar bid 8%', goal: 'roas', risk: 'low',
    maturation: MATURATION.bid_increase, use_ai: false,
    check: (d: any, s: any) => d.roas >= s.target_roas && d.budget_utilization < 0.70 && d.clicks >= 5,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 8, true, s), reason: `ROAS ${d.roas.toFixed(2)}x mas budget subutilizado — aumentar bid para ganhar mais` }) },

  { id: 'S022', name: 'ROAS < alvo + ACoS alto → reduzir bid 20%', goal: 'roas', risk: 'low',
    maturation: MATURATION.bid_decrease, use_ai: false,
    check: (d: any, s: any) => d.roas < s.target_roas && d.acos > s.max_acos && d.clicks >= 8,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 20, false, s), reason: `ROAS ${d.roas.toFixed(2)}x abaixo do alvo e ACoS crítico — corte máximo` }) },

  { id: 'S023', name: 'ROAS < alvo + campanha nova → aguardar maturação', goal: 'roas', risk: 'low',
    maturation: MATURATION.campaign_created, use_ai: false,
    check: (d: any, s: any) => d.roas < s.target_roas && d.campaign_age_hours != null && d.campaign_age_hours < 48,
    build: (_d: any, _s: any) => ({ action: 'hold_for_maturation', reason: 'Campanha nova — aguardar 48h antes de julgar ROAS' }) },

  { id: 'S024', name: 'ROAS < alvo + keyword sem pedido → reduzir bid 15%', goal: 'roas', risk: 'medium',
    maturation: MATURATION.bid_decrease, use_ai: false,
    check: (d: any, s: any) => d.roas < s.target_roas && d.orders === 0 && d.clicks >= 15,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 15, false, s), reason: `${d.clicks} cliques sem pedido — ROAS zero e abaixo do alvo` }) },

  // ── TACoS ─────────────────────────────────────────────────────────────────
  { id: 'S025', name: 'TACoS <= alvo → permitir expansão respeitando budget', goal: 'tacos', risk: 'low',
    maturation: 0, use_ai: false,
    check: (d: any, s: any) => d.tacos != null && d.tacos <= s.target_tacos && d.acos <= s.max_acos,
    build: (_d: any, _s: any) => ({ action: 'increase_discovery', reason: 'Conta saudável — TACoS dentro da meta, permitir novas campanhas' }) },

  { id: 'S026', name: 'TACoS > máximo → bloquear novas campanhas', goal: 'tacos', risk: 'high',
    maturation: 0, use_ai: false,
    check: (d: any, s: any) => d.tacos != null && d.tacos > s.max_tacos,
    build: (_d: any, _s: any) => ({ action: 'reduce_waste', block_new_campaigns: true, reason: `TACoS acima do máximo — suspender expansão até normalizar` }) },

  { id: 'S027', name: 'TACoS > máximo + ACoS alto → reduzir bids 20%', goal: 'tacos', risk: 'high',
    maturation: MATURATION.bid_decrease, use_ai: false,
    check: (d: any, s: any) => d.tacos != null && d.tacos > s.max_tacos && d.acos > s.max_acos && d.clicks >= 8,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 20, false, s), reason: `TACoS ${d.tacos.toFixed(1)}% e ACoS ${d.acos.toFixed(1)}% — redução máxima` }) },

  // ── CPC ───────────────────────────────────────────────────────────────────
  { id: 'S028', name: 'CPC <= alvo + ACoS bom → aumentar bid 15%', goal: 'cpc', risk: 'low',
    maturation: MATURATION.bid_increase, use_ai: false,
    check: (d: any, s: any) => d.cpc <= s.target_cpc && d.acos <= s.target_acos && d.clicks >= 8,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 15, true, s), reason: `CPC R$${d.cpc.toFixed(2)} eficiente e ACoS saudável` }) },

  { id: 'S029', name: 'CPC entre alvo e máximo + ACoS ok + ROAS ok → escalar levemente 5%', goal: 'cpc', risk: 'low',
    maturation: MATURATION.bid_increase, use_ai: false,
    check: (d: any, s: any) => d.cpc > s.target_cpc && d.cpc <= s.max_cpc && d.acos <= s.target_acos && d.roas >= s.target_roas && d.clicks >= 8,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 5, true, s), reason: `CPC dentro do intervalo com metas ok — escalar suave` }) },

  { id: 'S030', name: 'CPC alto + cliques sem compra → reduzir bid + marcar risco', goal: 'cpc', risk: 'medium',
    maturation: MATURATION.bid_decrease, use_ai: false,
    check: (d: any, s: any) => d.cpc > s.max_cpc && d.orders === 0 && d.clicks >= 10,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 20, false, s), mark_risk: true, reason: `CPC acima do máximo sem conversão — alto risco` }) },

  // ── Budget Pacing ─────────────────────────────────────────────────────────
  { id: 'S031', name: 'Budget dura 24h + ROAS ruim → reduzir bid', goal: 'budget', risk: 'medium',
    maturation: MATURATION.bid_decrease, use_ai: false,
    check: (d: any, s: any) => d.budget_duration_hours >= 22 && d.roas < s.target_roas && d.acos > s.max_acos,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 15, false, s), reason: 'Budget dura 24h mas ROAS ruim — reduzir para melhorar eficiência' }) },

  { id: 'S032', name: 'Budget acaba antes das 12h + ROAS bom → dayparting ou +R$5', goal: 'budget', risk: 'low',
    maturation: MATURATION.budget_increase, use_ai: false,
    check: (d: any, s: any) => d.budget_end_hour != null && d.budget_end_hour < 12 && d.roas >= s.target_roas,
    build: (d: any, s: any) => s.pacing_enabled
      ? ({ action: 'adjust_budget', new_budget: d.current_budget + s.budget_increment, reason: `Budget acaba às ${d.budget_end_hour}h com ROAS ${d.roas.toFixed(2)}x — expandir` })
      : ({ action: 'adjust_dayparting', reason: 'Budget esgota cedo com bom ROAS — concentrar via dayparting' }) },

  { id: 'S033', name: 'Budget acaba entre 12h-18h + ROAS bom + saldo geral ok → +R$5', goal: 'budget', risk: 'low',
    maturation: MATURATION.budget_increase, use_ai: false,
    check: (d: any, s: any) => d.budget_end_hour != null && d.budget_end_hour >= 12 && d.budget_end_hour < 18 && d.roas >= s.target_roas && d.total_account_spend < s.daily_budget_cap - 5,
    build: (d: any, s: any) => ({ action: 'adjust_budget', new_budget: d.current_budget + s.budget_increment, reason: 'Budget termina na tarde com bom ROAS e saldo geral disponível' }) },

  { id: 'S034', name: 'Budget acaba entre 12h-18h + vendas noturnas → preservar verba', goal: 'budget', risk: 'low',
    maturation: 0, use_ai: false,
    check: (d: any, s: any) => d.budget_end_hour >= 12 && d.budget_end_hour < 18 && d.night_sales_pct > 0.30,
    build: (_d: any, _s: any) => ({ action: 'adjust_dayparting', preserve_night: true, reason: 'Preservar verba para 18h-23h — padrão noturno forte detectado' }) },

  { id: 'S035', name: 'Budget sobra + impressões baixas → verificar completude', goal: 'budget', risk: 'medium',
    maturation: 0, use_ai: false,
    check: (d: any, s: any) => d.budget_utilization < 0.50 && d.impressions < 50 && d.campaign_age_hours >= 48,
    build: (_d: any, _s: any) => ({ action: 'repair_campaign', reason: 'Budget sobra e impressões baixas — campanha possivelmente incompleta' }) },

  { id: 'S036', name: 'Budget sobra + CTR ruim → não aumentar bid, revisar keyword', goal: 'budget', risk: 'medium',
    maturation: 0, use_ai: true,
    check: (d: any, s: any) => d.budget_utilization < 0.60 && d.ctr < 0.001 && d.impressions >= 200,
    build: (_d: any, _s: any) => ({ action: 'reduce_waste', reason: 'CTR muito baixo com budget sobrando — revisar relevância de keyword' }) },

  { id: 'S037', name: 'Budget geral próximo de R$56 → redistribuir das ruins para boas', goal: 'budget', risk: 'medium',
    maturation: 0, use_ai: true,
    check: (d: any, s: any) => d.entity_type === 'account' && d.total_account_spend > s.daily_budget_cap * 0.85,
    build: (_d: any, _s: any) => ({ action: 'redistribute_budget', reason: 'Budget geral próximo do teto — priorizar campanhas eficientes' }) },

  // ── Dayparting ────────────────────────────────────────────────────────────
  { id: 'S038', name: 'Bloco horário forte → aumentar bid 15%', goal: 'dayparting', risk: 'low',
    maturation: MATURATION.dayparting, use_ai: false,
    check: (d: any, s: any) => d.entity_type === 'hourly_block' && d.block_roas >= s.target_roas * 1.2 && d.block_acos <= s.target_acos && d.block_count >= 3,
    build: (d: any, s: any) => s.dayparting_enabled
      ? ({ action: 'adjust_dayparting', hour_block: d.hour_block, bid_pct: 15, direction: 'up', reason: `Bloco ${d.hour_block}h com ROAS ${d.block_roas.toFixed(2)}x excelente` })
      : null },

  { id: 'S039', name: 'Bloco horário fraco → reduzir bid 20%', goal: 'dayparting', risk: 'low',
    maturation: MATURATION.dayparting, use_ai: false,
    check: (d: any, s: any) => d.entity_type === 'hourly_block' && d.block_spend > 1 && d.block_orders === 0 && d.block_count >= 3,
    build: (d: any, s: any) => s.dayparting_enabled
      ? ({ action: 'adjust_dayparting', hour_block: d.hour_block, bid_pct: 20, direction: 'down', reason: `Bloco ${d.hour_block}h com gasto sem retorno` })
      : null },

  { id: 'S040', name: 'Bloco sem dados → manter neutro', goal: 'dayparting', risk: 'low',
    maturation: 0, use_ai: false,
    check: (d: any, s: any) => d.entity_type === 'hourly_block' && d.block_count < 3,
    build: (_d: any, _s: any) => ({ action: 'hold_for_maturation', reason: 'Volume insuficiente no bloco horário — aguardar 3 ocorrências' }) },

  // ── Keywords ──────────────────────────────────────────────────────────────
  { id: 'S041', name: 'Keyword EXACT vencedora → +10%', goal: 'keyword', risk: 'low',
    maturation: MATURATION.bid_increase, use_ai: false,
    check: (d: any, s: any) => d.entity_type === 'keyword' && d.match_type === 'EXACT' && d.orders >= 1 && d.acos <= s.target_acos && d.clicks >= 8,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 10, true, s), reason: `EXACT "${d.keyword_text}" com ${d.orders} pedido(s) e ACoS ${d.acos.toFixed(1)}%` }) },

  { id: 'S042', name: 'Keyword EXACT ACoS crítico → -20%', goal: 'keyword', risk: 'low',
    maturation: MATURATION.bid_decrease, use_ai: false,
    check: (d: any, s: any) => d.entity_type === 'keyword' && d.match_type === 'EXACT' && d.acos > s.max_acos && d.clicks >= 8,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 20, false, s), reason: `EXACT "${d.keyword_text}" com ACoS ${d.acos.toFixed(1)}% acima do máximo` }) },

  { id: 'S043', name: 'Keyword PHRASE com termo vencedor → criar EXACT', goal: 'keyword', risk: 'medium',
    maturation: MATURATION.keyword_exact, use_ai: false,
    check: (d: any, s: any) => d.entity_type === 'search_term' && d.match_type === 'PHRASE' && d.orders >= 1 && d.acos <= s.max_acos,
    build: (d: any, s: any) => ({ action: 'create_manual_exact_campaign', keyword: d.term, bid: clampBid(d.cpc || s.target_cpc, s), reason: `Termo "${d.term}" converte em PHRASE — escalar para EXACT` }) },

  { id: 'S044', name: 'Keyword BROAD com desperdício → reduzir + negativar termo', goal: 'keyword', risk: 'medium',
    maturation: MATURATION.bid_decrease, use_ai: false,
    check: (d: any, s: any) => d.entity_type === 'search_term' && d.match_type === 'BROAD' && d.clicks >= 15 && d.orders === 0 && d.acos > s.max_acos,
    build: (d: any, s: any) => ({ action: 'negative_keyword', keyword: d.term, also_reduce_bid: true, new_bid: pctChange(d.current_bid, 15, false, s), reason: `Termo BROAD "${d.term}" com ${d.clicks} cliques sem conversão` }) },

  { id: 'S045', name: 'Keyword sem impressões → aumentar bid 5%', goal: 'keyword', risk: 'low',
    maturation: MATURATION.bid_increase, use_ai: false,
    check: (d: any, s: any) => d.entity_type === 'keyword' && d.impressions < 10 && d.campaign_age_hours >= 48 && d.current_bid < s.max_bid,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 5, true, s), reason: `Keyword "${d.keyword_text}" com menos de 10 impressões — aumentar leve` }) },

  { id: 'S046', name: 'Keyword muitas impressões + CTR baixo → reduzir ou pausar', goal: 'keyword', risk: 'medium',
    maturation: MATURATION.bid_decrease, use_ai: false,
    check: (d: any, s: any) => d.entity_type === 'keyword' && d.impressions >= 500 && d.ctr < 0.001 && d.orders === 0,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 15, false, s), reason: `${d.impressions} impressões com CTR baixíssimo e zero conversão` }) },

  { id: 'S047', name: 'Keyword 20 cliques zero compra → -20% + considerar pausar', goal: 'keyword', risk: 'medium',
    maturation: MATURATION.bid_decrease, use_ai: false,
    check: (d: any, s: any) => d.entity_type === 'keyword' && d.clicks >= 20 && d.orders === 0 && d.spend >= 5,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 20, false, s), suggest_pause_if_persists: true, reason: `${d.clicks} cliques sem compra — desperdício acima do limiar` }) },

  { id: 'S048', name: 'Keyword 2+ compras + ROAS bom → +10%', goal: 'keyword', risk: 'low',
    maturation: MATURATION.bid_increase, use_ai: false,
    check: (d: any, s: any) => d.entity_type === 'keyword' && d.orders >= 2 && d.roas >= s.target_roas && d.acos <= s.max_acos,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 10, true, s), reason: `${d.orders} pedidos com ROAS ${d.roas.toFixed(2)}x — escalar keyword vencedora` }) },

  // ── Campanhas AUTO ────────────────────────────────────────────────────────
  { id: 'S049', name: 'AUTO com gasto alto sem termos vencedores → reduzir bid', goal: 'campaign', risk: 'medium',
    maturation: MATURATION.bid_decrease, use_ai: false,
    check: (d: any, s: any) => d.is_auto_campaign && d.spend >= 10 && d.orders === 0 && d.clicks >= 20,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 15, false, s), reason: 'AUTO com gasto elevado sem conversão — reduzir descoberta ineficiente' }) },

  { id: 'S050', name: 'AUTO nova < 72h → maturar para descoberta', goal: 'campaign', risk: 'low',
    maturation: MATURATION.keyword_exact, use_ai: false,
    check: (d: any, s: any) => d.is_auto_campaign && d.campaign_age_hours != null && d.campaign_age_hours < 72,
    build: (_d: any, _s: any) => ({ action: 'hold_for_maturation', reason: 'AUTO nova — aguardar 72h de descoberta' }) },

  { id: 'S051', name: 'AUTO com ACoS crítico persistente → reduzir bid + limitar budget', goal: 'campaign', risk: 'high',
    maturation: MATURATION.bid_decrease, use_ai: false,
    check: (d: any, s: any) => d.is_auto_campaign && d.acos > s.max_acos && d.campaign_age_hours >= 72 && d.spend >= 5,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 20, false, s), also_cap_budget: true, reason: `AUTO com ACoS ${d.acos.toFixed(1)}% persistente — corte máximo` }) },

  // ── Campanhas MANUAL EXACT ────────────────────────────────────────────────
  { id: 'S052', name: 'MANUAL EXACT sem gasto + completa → aumentar bid', goal: 'campaign', risk: 'low',
    maturation: MATURATION.bid_increase, use_ai: false,
    check: (d: any, s: any) => !d.is_auto_campaign && d.match_type === 'EXACT' && d.spend === 0 && d.campaign_age_hours >= 48 && !d.is_incomplete,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 10, true, s), reason: 'EXACT sem gasto mas campanha completa — bid baixo demais' }) },

  { id: 'S053', name: 'MANUAL EXACT sem impressão 7 dias → arquivar', goal: 'campaign', risk: 'high',
    maturation: MATURATION.campaign_archived, use_ai: false,
    check: (d: any, s: any) => !d.is_auto_campaign && d.impressions === 0 && d.spend === 0 && d.campaign_age_hours >= 168,
    build: (_d: any, _s: any) => ({ action: 'archive_campaign', reason: 'EXACT sem impressão ou gasto por 7 dias — arquivar' }) },

  // ── Estoque e produto ─────────────────────────────────────────────────────
  { id: 'S054', name: 'Produto sem estoque → pausar campanha', goal: 'campaign', risk: 'low',
    maturation: 0, use_ai: false,
    check: (d: any, _s: any) => d.stock === 0,
    build: (_d: any, _s: any) => ({ action: 'pause_campaign', reason: 'Produto sem estoque — regra de bloqueio obrigatória' }) },

  { id: 'S055', name: 'Produto com estoque baixo → não escalar', goal: 'campaign', risk: 'low',
    maturation: 0, use_ai: false,
    check: (d: any, _s: any) => d.stock > 0 && d.stock_coverage_days != null && d.stock_coverage_days < 7,
    build: (_d: any, _s: any) => ({ action: 'hold_for_maturation', reason: `Estoque para menos de 7 dias — suspender escalada` }) },

  { id: 'S056', name: 'Produto voltou ao estoque → reativar com bid conservador', goal: 'campaign', risk: 'low',
    maturation: MATURATION.campaign_created, use_ai: false,
    check: (d: any, s: any) => d.stock > 0 && d.was_paused_for_stock,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: s.min_bid * 1.1, reason: 'Produto reabastecido — reativar com bid inicial conservador' }) },

  // ── Saúde de campanha ─────────────────────────────────────────────────────
  { id: 'S057', name: 'Campanha incompleta → reparar antes de otimizar', goal: 'campaign', risk: 'high',
    maturation: 0, use_ai: false,
    check: (d: any, _s: any) => d.is_incomplete === true,
    build: (_d: any, _s: any) => ({ action: 'repair_campaign', reason: 'Campanha incompleta — reparar antes de qualquer decisão' }) },

  { id: 'S058', name: 'Campanha em fila de reparo → bloquear decisões', goal: 'campaign', risk: 'high',
    maturation: 0, use_ai: false,
    check: (d: any, _s: any) => d.in_repair_queue === true,
    build: (_d: any, _s: any) => ({ action: 'hold_for_maturation', reason: 'Campanha aguardando reparo — bloquear otimizações' }) },

  { id: 'S059', name: 'Campanha recém-criada < 48h → maturar', goal: 'campaign', risk: 'low',
    maturation: MATURATION.campaign_created, use_ai: false,
    check: (d: any, _s: any) => d.campaign_age_hours != null && d.campaign_age_hours < 48,
    build: (_d: any, _s: any) => ({ action: 'hold_for_maturation', reason: 'Campanha nova — aguardar 48h antes de julgar' }) },

  // ── Dados de qualidade ────────────────────────────────────────────────────
  { id: 'S060', name: 'Relatório unificado divergente > 3% → não executar agressivo', goal: 'campaign', risk: 'high',
    maturation: 0, use_ai: false,
    check: (d: any, _s: any) => d.unified_divergence_pct != null && d.unified_divergence_pct > 3,
    build: (_d: any, _s: any) => ({ action: 'hold_for_maturation', reason: 'Divergência > 3% entre Unified Reports e Legacy — aguardar reconciliação' }) },

  { id: 'S061', name: 'Cliques inválidos altos → não aumentar bid', goal: 'campaign', risk: 'medium',
    maturation: 0, use_ai: false,
    check: (d: any, _s: any) => d.invalid_click_rate != null && d.invalid_click_rate > 0.05,
    build: (_d: any, _s: any) => ({ action: 'hold_for_maturation', reason: `Taxa de cliques inválidos alta — não aumentar bid` }) },

  { id: 'S062', name: 'Parcela de impressão baixa + eficiência boa → aumentar bid 10%', goal: 'campaign', risk: 'low',
    maturation: MATURATION.bid_increase, use_ai: false,
    check: (d: any, s: any) => d.impression_share < 0.25 && d.acos <= s.target_acos && d.roas >= s.target_roas && d.clicks >= 8,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 10, true, s), reason: `Parcela impressão baixa com eficiência boa — ganhar mais exposição` }) },

  { id: 'S063', name: 'Parcela de impressão alta + sem venda → reduzir bid', goal: 'campaign', risk: 'medium',
    maturation: MATURATION.bid_decrease, use_ai: false,
    check: (d: any, s: any) => d.impression_share > 0.60 && d.orders === 0 && d.spend >= 5 && d.acos > s.max_acos,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 15, false, s), reason: 'Alta visibilidade sem retorno — reduzir exposição cara' }) },

  { id: 'S064', name: 'Top of Search alto + ACoS ruim → recomendar reduzir placement', goal: 'placement', risk: 'medium',
    maturation: 0, use_ai: false,
    check: (d: any, s: any) => d.top_of_search_share > 0.50 && d.acos > s.max_acos,
    build: (d: any, s: any) => s.top_of_search_limit > 0
      ? null
      : ({ action: 'recommend_placement', recommendation: 'Reduzir Top of Search — ACoS crítico com alta exposição em topo', reason: 'Placement recomendado, não executado (limite = 0)' }) },

  { id: 'S065', name: 'Top of Search baixo + ACoS bom → recomendar aumentar placement', goal: 'placement', risk: 'low',
    maturation: 0, use_ai: false,
    check: (d: any, s: any) => d.top_of_search_share < 0.15 && d.acos <= s.target_acos,
    build: (d: any, s: any) => s.top_of_search_limit > 0
      ? ({ action: 'recommend_placement', execute: true, recommendation: 'Aumentar Top of Search', reason: 'ACoS saudável e exposição em topo baixa' })
      : ({ action: 'recommend_placement', execute: false, recommendation: 'Aumentar Top of Search — só recomendação (limite = 0)', reason: 'Placement não executa com limite 0' }) },

  { id: 'S066', name: 'Meta de impressões inativa → não aumentar bid por volume', goal: 'campaign', risk: 'low',
    maturation: 0, use_ai: false,
    check: (d: any, s: any) => !s.impressions_goal_enabled && d.entity_type === 'keyword' && d.impressions < 50 && d.acos > s.target_acos,
    build: (_d: any, _s: any) => ({ action: 'hold_for_maturation', reason: 'Meta de impressões inativa — não aumentar bid só por volume' }) },

  // ── Proteção de margem ────────────────────────────────────────────────────
  { id: 'S067', name: 'Produto com margem baixa → reduzir CPC máximo efetivo', goal: 'margin', risk: 'medium',
    maturation: MATURATION.bid_decrease, use_ai: false,
    check: (d: any, s: any) => d.gross_margin_pct != null && d.gross_margin_pct < 20 && d.cpc > s.target_cpc,
    build: (d: any, s: any) => ({ action: 'protect_margin', new_bid: clampBid(d.current_bid * 0.85, s), reason: `Margem bruta ${d.gross_margin_pct.toFixed(1)}% baixa — reduzir exposição cara` }) },

  { id: 'S068', name: 'Produto com margem alta + bom ACoS → permitir bid mais alto', goal: 'margin', risk: 'low',
    maturation: MATURATION.bid_increase, use_ai: false,
    check: (d: any, s: any) => d.gross_margin_pct != null && d.gross_margin_pct > 40 && d.acos <= s.target_acos,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 10, true, s), reason: `Margem ${d.gross_margin_pct.toFixed(1)}% alta permite bid mais agressivo` }) },

  // ── Negativação ────────────────────────────────────────────────────────────
  { id: 'S069', name: 'Termo sem compra persistente em AUTO → negativar', goal: 'keyword', risk: 'medium',
    maturation: MATURATION.keyword_negated, use_ai: false,
    check: (d: any, s: any) => d.entity_type === 'search_term' && d.is_auto_campaign && d.clicks >= 25 && d.orders === 0 && d.acos > s.max_acos,
    build: (d: any, s: any) => ({ action: 'negative_keyword', keyword: d.term, reason: `Termo "${d.term}" com ${d.clicks} cliques sem conversão em AUTO` }) },

  { id: 'S070', name: 'ROAS < alvo + horário ruim → reduzir bid no bloco', goal: 'dayparting', risk: 'medium',
    maturation: MATURATION.dayparting, use_ai: false,
    check: (d: any, s: any) => d.entity_type === 'hourly_block' && d.block_roas < s.target_roas && d.block_spend > 1 && d.block_count >= 3,
    build: (d: any, s: any) => s.dayparting_enabled
      ? ({ action: 'adjust_dayparting', hour_block: d.hour_block, bid_pct: 20, direction: 'down', reason: `Bloco ${d.hour_block}h com ROAS ${d.block_roas.toFixed(2)}x abaixo da meta` })
      : null },

  // ── Estratégias adicionais (S071-S100) ────────────────────────────────────
  { id: 'S071', name: 'Keyword duplicada → manter melhor, arquivar outra', goal: 'keyword', risk: 'medium',
    maturation: MATURATION.campaign_archived, use_ai: true,
    check: (d: any, _s: any) => d.is_duplicate_keyword && d.is_worse_duplicate,
    build: (_d: any, _s: any) => ({ action: 'archive_campaign', reason: 'Keyword duplicada com pior performance — arquivar' }) },

  { id: 'S072', name: 'MANUAL PHRASE com termo bom → criar EXACT', goal: 'keyword', risk: 'medium',
    maturation: MATURATION.keyword_exact, use_ai: false,
    check: (d: any, s: any) => d.entity_type === 'search_term' && d.source_match === 'PHRASE' && d.orders >= 1 && d.acos <= s.max_acos,
    build: (d: any, s: any) => ({ action: 'create_manual_exact_campaign', keyword: d.term, bid: clampBid(d.cpc || s.target_cpc, s), reason: `Termo PHRASE "${d.term}" converteu — escalar para EXACT` }) },

  { id: 'S073', name: 'TARGET ASIN com venda halo recorrente → criar alvo ASIN', goal: 'campaign', risk: 'medium',
    maturation: MATURATION.keyword_exact, use_ai: true,
    check: (d: any, _s: any) => d.halo_sales > 0 && d.halo_purchases >= 3 && d.converted_asin,
    build: (d: any, s: any) => ({ action: 'create_product_target_campaign', target_asin: d.converted_asin, reason: `ASIN ${d.converted_asin} com ${d.halo_purchases} vendas halo recorrentes` }) },

  { id: 'S074', name: 'AUTO com ACoS bom → manter e extrair termos', goal: 'campaign', risk: 'low',
    maturation: 0, use_ai: false,
    check: (d: any, s: any) => d.is_auto_campaign && d.acos <= s.target_acos && d.campaign_age_hours >= 72,
    build: (_d: any, _s: any) => ({ action: 'increase_discovery', reason: 'AUTO eficiente — manter e continuar extração de termos' }) },

  { id: 'S075', name: 'MANUAL EXACT com ROAS bom → escalar bid', goal: 'campaign', risk: 'low',
    maturation: MATURATION.bid_increase, use_ai: false,
    check: (d: any, s: any) => !d.is_auto_campaign && d.match_type === 'EXACT' && d.roas >= s.target_roas * 1.3 && d.clicks >= 10,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 12, true, s), reason: `EXACT com ROAS ${d.roas.toFixed(2)}x excelente — escalar` }) },

  { id: 'S076', name: 'Keyword EXACT com 1 compra + ACoS alto → reduzir 10%, não pausar', goal: 'keyword', risk: 'medium',
    maturation: MATURATION.bid_decrease, use_ai: false,
    check: (d: any, s: any) => d.entity_type === 'keyword' && d.orders === 1 && d.acos > s.max_acos && d.clicks >= 10,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 10, false, s), reason: `1 compra com ACoS alto — reduzir levemente, não pausar ainda` }) },

  { id: 'S077', name: 'ACoS > 15% + budget acaba cedo → não aumentar, reduzir bid', goal: 'acos', risk: 'high',
    maturation: MATURATION.bid_decrease, use_ai: false,
    check: (d: any, s: any) => d.acos > s.max_acos && d.budget_end_hour != null && d.budget_end_hour < 18,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 20, false, s), block_budget: true, reason: 'Gasto rápido e ineficiente — cortar bid, não budget' }) },

  { id: 'S078', name: 'ROAS < alvo + ACoS aceitável → manter ou -5%', goal: 'roas', risk: 'low',
    maturation: MATURATION.bid_decrease, use_ai: false,
    check: (d: any, s: any) => d.roas < s.target_roas && d.acos > s.target_acos && d.acos <= s.max_acos && d.clicks >= 8,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 5, false, s), reason: `ROAS ${d.roas.toFixed(2)}x abaixo do alvo em zona de atenção — ajuste conservador` }) },

  { id: 'S079', name: 'CPC alto + compra boa → reduzir leve 5%', goal: 'cpc', risk: 'low',
    maturation: MATURATION.bid_decrease, use_ai: false,
    check: (d: any, s: any) => d.cpc > s.max_cpc && d.orders >= 1 && d.roas >= s.target_roas,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 5, false, s), reason: `CPC acima do máximo mas com boa conversão — reduzir levemente` }) },

  { id: 'S080', name: 'Budget dura 24h + ROAS bom → manter, aumentar bid se impressão baixa', goal: 'budget', risk: 'low',
    maturation: MATURATION.bid_increase, use_ai: false,
    check: (d: any, s: any) => d.budget_duration_hours >= 22 && d.roas >= s.target_roas && d.impression_share < 0.25,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 8, true, s), reason: 'Budget eficiente até o fim do dia mas com baixa visibilidade — ampliar via bid' }) },

  { id: 'S081', name: 'TACoS zona atenção → não expandir', goal: 'tacos', risk: 'medium',
    maturation: 0, use_ai: false,
    check: (d: any, s: any) => d.tacos != null && d.tacos > s.target_tacos && d.tacos <= s.max_tacos,
    build: (_d: any, _s: any) => ({ action: 'hold_for_maturation', reason: 'TACoS em zona de atenção — otimizar eficiência antes de expandir' }) },

  { id: 'S082', name: 'TACoS zona atenção + muitas campanhas novas → pausar criação', goal: 'tacos', risk: 'high',
    maturation: 0, use_ai: false,
    check: (d: any, s: any) => d.entity_type === 'account' && d.tacos > s.target_tacos && d.new_campaigns_7d >= 3,
    build: (_d: any, _s: any) => ({ action: 'reduce_waste', block_new_campaigns: true, reason: 'TACoS em atenção com várias campanhas novas — suspender expansão' }) },

  { id: 'S083', name: 'ROAS >= 4x + topo baixo → recomendar placement', goal: 'placement', risk: 'low',
    maturation: 0, use_ai: false,
    check: (d: any, s: any) => d.roas >= s.target_roas && d.top_of_search_share < 0.20,
    build: (d: any, s: any) => s.top_of_search_limit > 0
      ? ({ action: 'recommend_placement', execute: true, reason: 'ROAS bom e exposição em topo baixa — executar' })
      : ({ action: 'recommend_placement', execute: false, reason: 'Placement recomendado mas não executado (limite = 0)' }) },

  { id: 'S084', name: 'Impressões inválidas altas → não perseguir volume', goal: 'campaign', risk: 'medium',
    maturation: 0, use_ai: false,
    check: (d: any, _s: any) => d.invalid_impression_rate != null && d.invalid_impression_rate > 0.10,
    build: (_d: any, _s: any) => ({ action: 'hold_for_maturation', reason: 'Taxa de impressões inválidas alta — qualidade de tráfego comprometida' }) },

  { id: 'S085', name: 'Manhã forte → preservar budget 06h-11h', goal: 'dayparting', risk: 'low',
    maturation: MATURATION.dayparting, use_ai: false,
    check: (d: any, s: any) => d.entity_type === 'hourly_block' && d.hour_block >= 6 && d.hour_block <= 11 && d.block_acos <= s.target_acos && d.block_count >= 3,
    build: (d: any, s: any) => s.dayparting_enabled
      ? ({ action: 'adjust_dayparting', hour_block: d.hour_block, preserve: true, reason: `Manhã forte — preservar budget no bloco ${d.hour_block}h` })
      : null },

  { id: 'S086', name: 'Tarde forte → priorizar entrega 12h-17h', goal: 'dayparting', risk: 'low',
    maturation: MATURATION.dayparting, use_ai: false,
    check: (d: any, s: any) => d.entity_type === 'hourly_block' && d.hour_block >= 12 && d.hour_block <= 17 && d.block_roas >= s.target_roas && d.block_count >= 3,
    build: (d: any, s: any) => s.dayparting_enabled
      ? ({ action: 'adjust_dayparting', hour_block: d.hour_block, bid_pct: 12, direction: 'up', reason: `Tarde forte — boostar bloco ${d.hour_block}h` })
      : null },

  { id: 'S087', name: 'Noite forte → preservar verba para 18h-23h', goal: 'dayparting', risk: 'low',
    maturation: MATURATION.dayparting, use_ai: false,
    check: (d: any, s: any) => d.entity_type === 'hourly_block' && d.hour_block >= 18 && d.hour_block <= 23 && d.block_roas >= s.target_roas && d.block_count >= 3,
    build: (d: any, s: any) => s.dayparting_enabled
      ? ({ action: 'adjust_dayparting', hour_block: d.hour_block, bid_pct: 15, direction: 'up', reason: `Noite forte — boostar bloco ${d.hour_block}h` })
      : null },

  { id: 'S088', name: 'Keyword com 1 pedido EXACT → aguardar 72h antes de escalar', goal: 'keyword', risk: 'low',
    maturation: MATURATION.keyword_exact, use_ai: false,
    check: (d: any, s: any) => d.entity_type === 'keyword' && d.match_type === 'EXACT' && d.orders === 1 && d.campaign_age_hours < 72,
    build: (_d: any, _s: any) => ({ action: 'hold_for_maturation', reason: '1 pedido em EXACT nova — aguardar 72h ou 20 cliques' }) },

  { id: 'S089', name: 'Produto reabastecido recentemente → bid conservador 72h', goal: 'campaign', risk: 'low',
    maturation: MATURATION.keyword_exact, use_ai: false,
    check: (d: any, s: any) => d.restocked_recently && d.campaign_age_hours < 72,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: s.min_bid * 1.2, reason: 'Produto recém-reabastecido — iniciar com bid conservador' }) },

  { id: 'S090', name: 'Negativação recente → avaliar economia pós 7 dias', goal: 'keyword', risk: 'low',
    maturation: MATURATION.keyword_negated, use_ai: false,
    check: (d: any, _s: any) => d.was_recently_negated && d.hours_since_negation < 168,
    build: (_d: any, _s: any) => ({ action: 'hold_for_maturation', reason: 'Negativação recente — avaliar economia após 7 dias' }) },

  { id: 'S091', name: 'Campanha arquivada recentemente → não recriar em 7 dias', goal: 'campaign', risk: 'medium',
    maturation: MATURATION.campaign_archived, use_ai: false,
    check: (d: any, _s: any) => d.was_recently_archived && d.hours_since_archived < 168,
    build: (_d: any, _s: any) => ({ action: 'hold_for_maturation', reason: 'Campanha arquivada há menos de 7 dias — não recriar ainda' }) },

  { id: 'S092', name: 'ACoS > 15% + ACoS > máximo + cliques suficientes → negativar termo alto custo', goal: 'acos', risk: 'high',
    maturation: MATURATION.keyword_negated, use_ai: false,
    check: (d: any, s: any) => d.entity_type === 'search_term' && d.acos > s.max_acos && d.spend > 5 && d.orders === 0,
    build: (d: any, s: any) => ({ action: 'negative_keyword', keyword: d.term, reason: `Termo "${d.term}" com R$${d.spend.toFixed(2)} gasto e ACoS ${d.acos.toFixed(1)}% sem conversão` }) },

  { id: 'S093', name: 'ROAS >= 4x + EXACT ativo + nova descoberta em AUTO → harvest term', goal: 'keyword', risk: 'medium',
    maturation: MATURATION.keyword_exact, use_ai: false,
    check: (d: any, s: any) => d.entity_type === 'search_term' && d.is_auto_campaign && d.orders >= 2 && d.acos <= s.max_acos,
    build: (d: any, s: any) => ({ action: 'create_manual_exact_campaign', keyword: d.term, bid: clampBid(d.cpc || s.target_cpc, s), reason: `Colheita: termo "${d.term}" com ${d.orders} pedidos em AUTO` }) },

  { id: 'S094', name: 'Keyword em EXACT com CTR bom mas sem impressão → bid muito baixo', goal: 'keyword', risk: 'low',
    maturation: MATURATION.bid_increase, use_ai: false,
    check: (d: any, s: any) => d.entity_type === 'keyword' && d.match_type === 'EXACT' && d.impressions < 20 && d.campaign_age_hours >= 48 && d.current_bid < s.target_cpc,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: clampBid(s.target_cpc, s), reason: 'EXACT com bid abaixo do CPC alvo — ajustar para entrar no leilão' }) },

  { id: 'S095', name: 'Campanha com erro de criação por IA → não repetir payload', goal: 'campaign', risk: 'high',
    maturation: 0, use_ai: false,
    check: (d: any, _s: any) => d.has_ai_creation_error,
    build: (_d: any, _s: any) => ({ action: 'repair_campaign', reason: 'Campanha com erro de criação — corrigir estrutura, não repetir payload' }) },

  { id: 'S096', name: 'ACoS entre alvo e máximo → manter bid se ROAS >= alvo', goal: 'acos', risk: 'low',
    maturation: 0, use_ai: false,
    check: (d: any, s: any) => d.acos > s.target_acos && d.acos <= s.max_acos && d.roas >= s.target_roas,
    build: (_d: any, _s: any) => ({ action: 'hold_for_maturation', reason: 'ACoS acima do alvo mas ROAS ok — manter bid atual' }) },

  { id: 'S097', name: 'ASIN + HIGH CVR + ACoS ok → escalar bid 10%', goal: 'acos', risk: 'low',
    maturation: MATURATION.bid_increase, use_ai: false,
    check: (d: any, s: any) => d.cvr >= 0.03 && d.acos <= s.target_acos * 0.9 && d.clicks >= 16,
    build: (d: any, s: any) => ({ action: 'adjust_bid', new_bid: pctChange(d.current_bid, 10, true, s), reason: `CVR ${(d.cvr * 100).toFixed(2)}% alto com ACoS excelente — escalar` }) },

  { id: 'S098', name: 'Budget geral abaixo de R$56 → permitir testes EXACT saudáveis', goal: 'budget', risk: 'low',
    maturation: 0, use_ai: false,
    check: (d: any, s: any) => d.entity_type === 'account' && d.total_account_spend < s.daily_budget_cap * 0.70 && d.acos <= s.max_acos,
    build: (_d: any, _s: any) => ({ action: 'increase_discovery', reason: 'Budget geral com saldo — testar novos EXACT com metas saudáveis' }) },

  { id: 'S099', name: 'Produto com estoque 21-60 dias → zona neutra, sem ação', goal: 'campaign', risk: 'low',
    maturation: 0, use_ai: false,
    check: (d: any, _s: any) => d.stock_coverage_days != null && d.stock_coverage_days >= 21 && d.stock_coverage_days < 60,
    build: (_d: any, _s: any) => ({ action: 'hold_for_maturation', reason: 'Cobertura de estoque em zona neutra (21-60 dias) — sem ação de estoque' }) },

  { id: 'S100', name: 'Todas as metas atingidas → manutenção, sem mudanças', goal: 'acos', risk: 'low',
    maturation: 0, use_ai: false,
    check: (d: any, s: any) => d.acos <= s.target_acos && d.roas >= s.target_roas && (d.tacos == null || d.tacos <= s.target_tacos) && d.cpc <= s.max_cpc,
    build: (_d: any, _s: any) => ({ action: 'hold_for_maturation', reason: 'Todas as metas atingidas — manter configurações atuais' }) },
];

// ── Handler ────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const dryRun = body.dry_run === true;
    const evaluateOnly = body.evaluate_only === true; // só avalia maturações passadas
    const strategyFilter = body.strategy_id || null; // testar estratégia específica

    // 1. Conta
    let account: any = null;
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

    // 2. Settings — Fonte única
    let s: any = null;
    const psList = await base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, '-updated_at', 1).catch(() => []);
    if (psList.length > 0) {
      const ps = psList[0];
      s = {
        target_acos: Number(ps.target_acos ?? FB.target_acos),
        max_acos: Number(ps.max_acos ?? FB.max_acos),
        target_roas: Number(ps.target_roas ?? FB.target_roas),
        target_tacos: Number(ps.target_tacos ?? FB.target_tacos),
        max_tacos: Number(ps.max_tacos ?? FB.max_tacos),
        target_cpc: Number(ps.target_cpc ?? FB.target_cpc),
        max_cpc: Number(ps.max_cpc ?? FB.max_cpc),
        min_bid: Number(ps.min_bid ?? FB.min_bid),
        max_bid: Number(ps.max_bid ?? FB.max_bid),
        max_bid_increase_pct: Number(ps.max_bid_increase_pct ?? FB.max_bid_increase_pct),
        max_bid_decrease_pct: Number(ps.max_bid_decrease_pct ?? FB.max_bid_decrease_pct),
        daily_budget_cap: Number(ps.daily_budget_limit ?? FB.daily_budget_cap),
        min_campaign_budget: Number(ps.minimum_campaign_budget ?? FB.min_campaign_budget),
        budget_increment: Number(ps.campaign_budget_increment ?? FB.budget_increment),
        weekly_campaign_capacity: Number(ps.weekly_campaign_capacity ?? FB.weekly_campaign_capacity),
        pacing_enabled: Boolean(ps.pacing_enabled ?? FB.pacing_enabled),
        dayparting_enabled: Boolean(ps.dayparting_enabled ?? FB.dayparting_enabled),
        placement_enabled: Boolean(ps.placement_optimization_enabled ?? FB.placement_enabled),
        top_of_search_limit: Number(ps.top_of_search_limit ?? 0),
        rest_of_search_limit: Number(ps.rest_of_search_limit ?? 0),
        product_page_limit: Number(ps.product_page_limit ?? 0),
        impressions_goal_enabled: Boolean(ps.impressions_goal_enabled ?? false),
        ai_auto_optimization: Boolean(ps.ai_auto_optimization ?? false),
        settings_source: 'PerformanceSettings',
      };
    } else {
      s = { ...FB, settings_source: 'defaults' };
    }

    // 3. Se evaluate_only: avaliar maturações vencidas e retornar
    if (evaluateOnly) {
      const maturing = await base44.asServiceRole.entities.StrategyExecutionLog.filter(
        { amazon_account_id: aid, status: 'maturing' }, '-created_at', 100
      ).catch(() => []);
      const now = new Date();
      const toEvaluate = maturing.filter(log => {
        if (!log.maturation_until) return true;
        return new Date(log.maturation_until) <= now;
      });
      const evaluated: any[] = [];
      for (const log of toEvaluate) {
        await base44.asServiceRole.entities.StrategyExecutionLog.update(log.id, {
          status: 'evaluated',
          evaluated_at: now.toISOString(),
          updated_at: now.toISOString(),
        }).catch(() => {});
        evaluated.push({ id: log.id, strategy_id: log.strategy_id });
      }
      return Response.json({ ok: true, mode: 'evaluate_only', evaluated_count: evaluated.length, evaluated });
    }

    // 4. Dados operacionais
    const [keywords, campaigns, products, salesDaily, metricsRaw, unifiedRaw, hourlyRaw, pendingLogs] = await Promise.all([
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, '-spend', 300).catch(() => []),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 200).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 100).catch(() => []),
      base44.asServiceRole.entities.SalesDaily.filter({ amazon_account_id: aid }, '-date', 300).catch(() => []),
      base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 200).catch(() => []),
      base44.asServiceRole.entities.UnifiedAdsMetricsDaily.filter({ amazon_account_id: aid }, '-date', 200).catch(() => []),
      base44.asServiceRole.entities.HourlyMetric.filter({ amazon_account_id: aid }, '-date', 500).catch(() => []),
      base44.asServiceRole.entities.StrategyExecutionLog.filter({ amazon_account_id: aid, status: 'maturing' }, null, 200).catch(() => []),
    ]);

    // 5. Índices
    const now = new Date();
    const productMap = new Map(products.map(p => [p.asin, p]));
    const maturingByEntity = new Map<string, string>(); // entityId → strategy_id
    for (const log of pendingLogs) {
      const eid = log.keyword_id || log.campaign_id;
      if (eid && log.maturation_until && new Date(log.maturation_until) > now) {
        maturingByEntity.set(eid, log.strategy_id);
      }
    }

    // Métricas 14d por campanha
    const cutoff14d = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    const metricsMap = new Map<string, any>();
    for (const m of metricsRaw) {
      if (!m.campaign_id || !m.date || m.date < cutoff14d) continue;
      if (!metricsMap.has(m.campaign_id)) metricsMap.set(m.campaign_id, { spend: 0, sales: 0, clicks: 0, orders: 0, impressions: 0 });
      const e = metricsMap.get(m.campaign_id);
      e.spend += m.spend || 0; e.sales += m.sales || 0;
      e.clicks += m.clicks || 0; e.orders += m.orders || 0;
      e.impressions += m.impressions || 0;
    }

    // Unified 14d por campanha
    const unifiedMap = new Map<string, any>();
    for (const u of unifiedRaw) {
      if (!u.campaign_id || !u.date || u.date < cutoff14d) continue;
      if (!unifiedMap.has(u.campaign_id)) unifiedMap.set(u.campaign_id, { impression_share_sum: 0, top_of_search_sum: 0, halo_purchases: 0, invalid_click_rate_sum: 0, invalid_impression_rate_sum: 0, rows: 0 });
      const e = unifiedMap.get(u.campaign_id);
      e.impression_share_sum += u.impression_share || 0;
      e.top_of_search_sum += u.top_of_search_impression_share || 0;
      e.halo_purchases += u.halo_purchases || 0;
      e.invalid_click_rate_sum += u.invalid_click_rate || 0;
      e.invalid_impression_rate_sum += u.invalid_impression_rate || 0;
      e.rows++;
    }

    // SalesDaily 30d por ASIN
    const cutoff30d = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const salesMap = new Map<string, any>();
    for (const sd of salesDaily) {
      if (!sd.asin || !sd.date || sd.date < cutoff30d) continue;
      if (!salesMap.has(sd.asin)) salesMap.set(sd.asin, { revenue: 0, units: 0 });
      const e = salesMap.get(sd.asin);
      e.revenue += sd.ordered_product_sales || 0;
      e.units += sd.units_ordered || 0;
    }

    // Total spend da conta hoje
    const todayStr = now.toISOString().slice(0, 10);
    let totalAccountSpend = 0;
    for (const m of metricsRaw) {
      if (m.date === todayStr || m.date === new Date(Date.now() - 86400000).toISOString().slice(0, 10)) {
        totalAccountSpend += m.spend || 0;
      }
    }

    // Horly blocks 7d
    const hourlyBlocks = new Map<string, any>();
    const cutoff7d = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    for (const h of hourlyRaw) {
      if (!h.date || h.date < cutoff7d) continue;
      const hour = h.hour ?? new Date(h.created_date || h.date).getHours();
      const key = `${h.campaign_id}|${hour}`;
      if (!hourlyBlocks.has(key)) hourlyBlocks.set(key, { spend: 0, sales: 0, orders: 0, clicks: 0, hour, count: 0 });
      const e = hourlyBlocks.get(key);
      e.spend += h.spend || 0; e.sales += h.sales || 0;
      e.orders += h.orders || 0; e.clicks += h.clicks || 0; e.count++;
    }

    // 6. Montar entidades avaliáveis
    type EvalEntity = {
      id: string;
      entity_type: string;
      campaign_id?: string;
      keyword_id?: string;
      asin?: string;
      [key: string]: any;
    };
    const entities: EvalEntity[] = [];

    // Keywords
    for (const kw of keywords) {
      const eid = kw.keyword_id || kw.id;
      if (!eid) continue;
      if (maturingByEntity.has(eid)) continue; // em maturação
      const met = metricsMap.get(kw.campaign_id) || {};
      const uni = unifiedMap.get(kw.campaign_id) || {};
      const product = kw.asin ? productMap.get(kw.asin) : null;
      const sales = kw.asin ? salesMap.get(kw.asin) : null;
      const stockDays = sales?.units > 0 ? (product?.fba_inventory || 0) / (sales.units / 30) : 999;
      const rows = uni.rows || 1;
      entities.push({
        id: eid, entity_type: 'keyword', keyword_id: eid,
        campaign_id: kw.campaign_id, asin: kw.asin,
        keyword_text: kw.keyword_text || kw.keyword,
        match_type: kw.match_type || 'EXACT',
        current_bid: kw.current_bid || kw.bid || 0.25,
        clicks: met.clicks || 0, impressions: met.impressions || 0,
        spend: met.spend || 0, sales: met.sales || 0, orders: met.orders || 0,
        acos: met.sales > 0 ? met.spend / met.sales * 100 : (met.spend > 0 ? 9999 : 0),
        roas: met.spend > 0 ? met.sales / met.spend : 0,
        cpc: met.clicks > 0 ? met.spend / met.clicks : 0,
        ctr: met.impressions > 0 ? met.clicks / met.impressions : 0,
        cvr: met.clicks > 0 ? (met.orders || 0) / met.clicks : 0,
        impression_share: rows > 0 ? uni.impression_share_sum / rows : 0,
        top_of_search_share: rows > 0 ? uni.top_of_search_sum / rows : 0,
        invalid_click_rate: rows > 0 ? uni.invalid_click_rate_sum / rows : 0,
        halo_purchases: uni.halo_purchases || 0,
        stock: product?.fba_inventory || 0,
        stock_coverage_days: stockDays,
        gross_margin_pct: null,
        is_auto_campaign: false,
        is_incomplete: false,
        in_repair_queue: false,
        campaign_age_hours: null,
        was_paused_for_stock: false,
        restocked_recently: false,
        was_recently_negated: false,
        hours_since_negation: 0,
        total_account_spend: totalAccountSpend,
        tacos: null, budget_end_hour: null, budget_duration_hours: null,
        budget_utilization: null, current_budget: 15,
        is_duplicate_keyword: false, is_worse_duplicate: false,
        has_ai_creation_error: false, unified_divergence_pct: 0,
        entity_type_actual: 'keyword',
      });
    }

    // Campanhas
    for (const c of campaigns) {
      const eid = c.campaign_id || c.id;
      if (!eid) continue;
      if (maturingByEntity.has(eid)) continue;
      const state = String(c.state || c.status || '').toLowerCase();
      if (state === 'archived') continue;
      const met = metricsMap.get(eid) || metricsMap.get(c.amazon_campaign_id) || {};
      const uni = unifiedMap.get(eid) || unifiedMap.get(c.amazon_campaign_id) || {};
      const rows = uni.rows || 1;
      const product = c.asin ? productMap.get(c.asin) : null;
      const campaignAgeHours = c.created_date
        ? (now.getTime() - new Date(c.created_date).getTime()) / 3600000 : null;
      const isAuto = String(c.campaign_name || c.name || '').toLowerCase().includes('auto') || String(c.targeting_type || '').toLowerCase() === 'auto';
      entities.push({
        id: eid, entity_type: 'campaign', campaign_id: eid,
        asin: c.asin, current_bid: c.default_bid || 0.50,
        current_budget: c.daily_budget || 15,
        clicks: met.clicks || 0, impressions: met.impressions || 0,
        spend: met.spend || 0, sales: met.sales || 0, orders: met.orders || 0,
        acos: met.sales > 0 ? met.spend / met.sales * 100 : (met.spend > 0 ? 9999 : 0),
        roas: met.spend > 0 ? met.sales / met.spend : 0,
        cpc: met.clicks > 0 ? met.spend / met.clicks : 0,
        ctr: met.impressions > 0 ? met.clicks / met.impressions : 0,
        impression_share: rows > 0 ? uni.impression_share_sum / rows : 0,
        top_of_search_share: rows > 0 ? uni.top_of_search_sum / rows : 0,
        invalid_click_rate: rows > 0 ? uni.invalid_click_rate_sum / rows : 0,
        invalid_impression_rate: rows > 0 ? uni.invalid_impression_rate_sum / rows : 0,
        halo_purchases: uni.halo_purchases || 0,
        stock: product?.fba_inventory || 0,
        stock_coverage_days: null,
        is_auto_campaign: isAuto,
        is_incomplete: c.status === 'INCOMPLETE' || c.is_incomplete === true,
        in_repair_queue: false,
        campaign_age_hours: campaignAgeHours,
        was_paused_for_stock: false, restocked_recently: false,
        total_account_spend: totalAccountSpend,
        budget_end_hour: null, budget_duration_hours: null,
        budget_utilization: null, tacos: null,
        was_recently_archived: false, hours_since_archived: 0,
        has_ai_creation_error: false, unified_divergence_pct: 0,
        new_campaigns_7d: 0,
      });
    }

    // Entidade de conta (para TACoS, TACoS global)
    const salesTotal30d = Array.from(salesMap.values()).reduce((s, v) => s + v.revenue, 0);
    const spendTotal14d = Array.from(metricsMap.values()).reduce((s, v) => s + v.spend, 0);
    entities.push({
      id: `account:${aid}`, entity_type: 'account', asin: undefined,
      tacos: salesTotal30d > 0 ? spendTotal14d / salesTotal30d * 100 : null,
      total_account_spend: totalAccountSpend,
      new_campaigns_7d: campaigns.filter(c => {
        if (!c.created_date) return false;
        const age = (now.getTime() - new Date(c.created_date).getTime()) / 3600000;
        return age < 168;
      }).length,
    });

    // 7. Avaliar estratégias
    const strategies = strategyFilter
      ? STRATEGIES.filter(st => st.id === strategyFilter)
      : STRATEGIES;

    const decisions: any[] = [];
    const seenEntities = new Set<string>(); // uma ação de maior prioridade por entidade

    for (const entity of entities) {
      for (const strat of strategies) {
        if (!strat.check(entity, s)) continue;
        const entityKey = entity.id;
        if (seenEntities.has(entityKey)) break; // já decidiu para esta entidade
        const action = strat.build(entity, s);
        if (!action) continue;
        // Guardrail final de bid
        if (action.new_bid !== undefined) {
          action.new_bid = clampBid(action.new_bid, s);
        }
        if (action.new_budget !== undefined) {
          action.new_budget = Math.min(action.new_budget, action.new_budget); // apenas garantir não passa teto global
          if (totalAccountSpend + (action.new_budget - (entity.current_budget || 0)) > s.daily_budget_cap) {
            action.blocked_reason = `Budget geral R$${s.daily_budget_cap} seria excedido`;
            action.action = 'hold_for_maturation';
          }
        }
        seenEntities.add(entityKey);
        const matUntil = strat.maturation > 0
          ? new Date(now.getTime() + strat.maturation * 3600000).toISOString()
          : null;
        decisions.push({
          strategy_id: strat.id,
          strategy_name: strat.name,
          goal_targeted: strat.goal,
          risk_level: strat.risk,
          use_ai: strat.use_ai,
          maturation_hours: strat.maturation,
          entity_type: entity.entity_type,
          entity_id: entity.id,
          campaign_id: entity.campaign_id,
          keyword_id: entity.keyword_id,
          keyword_text: entity.keyword_text,
          asin: entity.asin,
          action_type: action.action,
          action_payload: action,
          before_metrics: {
            acos: entity.acos, roas: entity.roas, cpc: entity.cpc,
            bid: entity.current_bid, budget: entity.current_budget,
            clicks: entity.clicks, orders: entity.orders, spend: entity.spend,
          },
          maturation_until: matUntil,
          reason: action.reason,
        });
        break; // uma estratégia por entidade por ciclo
      }
    }

    // 8. Salvar logs (se não dry run)
    const saved: any[] = [];
    if (!dryRun) {
      for (const dec of decisions) {
        const log = await base44.asServiceRole.entities.StrategyExecutionLog.create({
          strategy_id: dec.strategy_id,
          amazon_account_id: aid,
          campaign_id: dec.campaign_id,
          keyword_id: dec.keyword_id,
          keyword_text: dec.keyword_text,
          asin: dec.asin,
          action_type: dec.action_type,
          before_metrics: dec.before_metrics,
          action_taken: dec.action_payload,
          maturation_hours: dec.maturation_hours,
          maturation_until: dec.maturation_until,
          risk_level: dec.risk_level,
          status: dec.action_type === 'hold_for_maturation' ? 'maturing' : 'pending',
          created_at: now.toISOString(),
          updated_at: now.toISOString(),
        }).catch(e => ({ error: e.message }));
        saved.push(log);
      }
    }

    return Response.json({
      ok: true,
      dry_run: dryRun,
      settings_source: s.settings_source,
      performance_goals: {
        target_acos: s.target_acos, max_acos: s.max_acos,
        target_roas: s.target_roas, target_tacos: s.target_tacos,
        target_cpc: s.target_cpc, max_cpc: s.max_cpc,
        min_bid: s.min_bid, max_bid: s.max_bid,
        daily_budget_cap: s.daily_budget_cap,
      },
      entities_evaluated: entities.length,
      strategies_checked: strategies.length,
      decisions_generated: decisions.length,
      decisions_saved: saved.length,
      decisions: decisions.slice(0, 50), // truncar para resposta
    });

  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
});