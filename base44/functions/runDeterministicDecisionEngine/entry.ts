/**
 * runDeterministicDecisionEngine — Módulo B: Motor Determinístico Diário
 *
 * REGRA ABSOLUTA: Este módulo NÃO chama Claude, nenhum LLM, nenhuma IA.
 * Carrega regras vigentes do banco e executa decisões puramente calculadas.
 *
 * Guardrails financeiros: lidos de Configurações > Metas de Performance via getPerformanceSettings.
 *   Fonte única — nenhum valor fixo hardcoded neste motor.
 *   Toda ação passa pela fila com idempotency_key
 *
 * v3: Metodologia oficial Amazon Ads / MRC incorporada:
 *   - Cliques usados são SEMPRE líquidos pós-GIVT/SIVT (padrão da API — não confundir com cliques brutos)
 *   - Janela de atribuição primária: 14 dias (sales14d/orders14d) conforme escopo MRC
 *   - Evidência mínima: clicks_14d >= 8 E impressions >= 50 (clique exige impressão prévia validada)
 *   - CVR (clicks→orders) incluído como sinal de qualidade nas regras de ACoS
 *   - Dados considerados "estáveis" após 30 dias; entre D-1 e D-30 podem sofrer revisão por SIVT retroativo
 *   - Janela de lookback máxima 90 dias para decisões de rollback/reprocessamento
 *   - CTR mínimo de 0.05% como filtro de qualidade de impressão (garante renderização real do criativo)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ── Constantes de fallback — usadas APENAS se getPerformanceSettings falhar ──
// Fonte real: Configurações > Metas de Performance (carregado no início do handler)
const FALLBACK_MIN_BID = 0.40;
const FALLBACK_MAX_BID = 1.00;
const FALLBACK_MAX_BID_CHANGE_PCT = 0.20;
const FALLBACK_DAILY_BUDGET_CAP = 56;
const FALLBACK_TARGET_ACOS = 10;
const FALLBACK_MAX_ACOS = 15;

// ── Constantes de qualidade de dados (Metodologia MRC/Amazon Ads) ─────────────
// Cliques retornados pela API são SEMPRE líquidos pós-GIVT/SIVT — não há cliques brutos
// disponíveis via API de relatórios (fora do escopo MRC de relatórios programáticos).
// Evidência mínima para decisão confiável:
const MIN_CLICKS_FOR_DECISION = 8;        // cliques líquidos mínimos (14d) — evita ruído estatístico
const MIN_IMPRESSIONS_FOR_DECISION = 50;  // impressões mínimas — garante criativo renderizado (clique exige impressão prévia)
const MIN_CTR_QUALITY = 0.0005;           // CTR mínimo 0.05% — descarta tráfego não-humano residual não filtrado
const ATTRIBUTION_WINDOW_DAYS = 14;       // janela primária de atribuição Amazon SP (sales14d/orders14d)
const DATA_STABLE_DAYS = 30;              // dados finais e imutáveis após 30 dias (sem mais ajustes SIVT retroativos)
const DATA_REVISABLE_DAYS = 90;           // janela máxima de reprocessamento por incidentes de qualidade
const MIN_SPEND_FOR_DECISION = 3.0;       // gasto mínimo em R$ para ter sinal confiável

const CONFLICT_PRIORITY = {
  financial_safety: 1, stock: 2, profit: 3, budget_limit: 4,
  protected_rules: 5, dedup: 6, pause_loss: 7, reduce_bid: 8,
  maintenance: 9, increase_bid: 10, expansion: 11, campaign_creation: 12,
};

// ── Regras nativas de estoque ────────────────────────────────────────────────
// Executadas automaticamente em TODOS os ciclos, independente do banco de regras.
// Prioridade máxima (priority: 2 = stock) — sobrescrevem regras externas para o
// mesmo entity neste ciclo. Cooldown por chave de idempotência diária.
//
// Classificação por dias de cobertura (estoque ÷ velocidade de venda):
//   ZERADO   :   0 un  → bid mínimo (MIN_BID) — não anunciar sem produto
//   CRÍTICO  : < 7 dias → reduzir bid 25% — preservar estoque residual
//   BAIXO    : 7–21 dias → reduzir bid 10% — desacelerar saída
//   SAUDÁVEL : 21–60 dias → sem ação (zona neutra)
//   ALTO     : 60–90 dias → aumentar bid 10% — acelerar giro
//   EXCESSO  : > 90 dias → aumentar bid 15% — liquidação agressiva
//
// Quando não há histórico de vendas (stockVelocity = 0), cobertura = 999 dias
// mas o produto NÃO entra nas regras de boost — exige pelo menos 1 venda nos 30d.

// STOCK_RULES são geradas dinamicamente no handler após carregar settings
// para usar min_bid/max_bid configurados. Ver função buildStockRules(settings).

// ACOS_RULES são geradas dinamicamente no handler após carregar settings.
// Ver função buildAcosRules(settings).

// ── Factory de regras nativas — usa settings configurados ─────────────────────

function buildStockRules(settings: any) {
  const MIN_BID = settings.min_bid;
  const MAX_BID = settings.max_bid;
  return [
    {
      rule_key: 'stock_zero',
      label: 'Sem estoque — bid mínimo',
      cooldown_hours: 24,
      matches: (d: any) => d.stock === 0,
      action: (_d: any) => MIN_BID,
      reason: `Produto sem estoque. Bid reduzido ao mínimo configurado (R$${MIN_BID}).`,
      goal_protected: 'Bid Mínimo',
      is_boost: false,
    },
    {
      rule_key: 'stock_critical_pause',
      label: 'Estoque crítico (< 7 dias) — reduzir bid',
      cooldown_hours: 48,
      matches: (d: any) => d.stock > 0 && d.stock_coverage_days < 7,
      action: (d: any) => Math.max(MIN_BID, d.current_bid * (1 - settings.max_bid_decrease_percent / 100 * 0.75)),
      reason: `Estoque crítico: < 7 dias de cobertura. Bid reduzido respeitando Bid Mínimo R$${MIN_BID}.`,
      goal_protected: 'Bid Mínimo',
      is_boost: false,
    },
    {
      rule_key: 'stock_low_reduce',
      label: 'Estoque baixo (7–21 dias) — reduzir bid 10%',
      cooldown_hours: 48,
      matches: (d: any) => d.stock > 0 && d.stock_coverage_days >= 7 && d.stock_coverage_days < 21,
      action: (d: any) => Math.max(MIN_BID, d.current_bid * 0.90),
      reason: `Estoque baixo: 7–21 dias de cobertura. Bid reduzido 10% respeitando mínimo R$${MIN_BID}.`,
      goal_protected: 'Bid Mínimo',
      is_boost: false,
    },
    {
      rule_key: 'stock_high_boost',
      label: 'Estoque alto (60–90 dias) — aumentar bid',
      cooldown_hours: 48,
      matches: (d: any) => d.stock > 0 && d.stock_velocity > 0 && d.stock_coverage_days >= 60 && d.stock_coverage_days < 90,
      action: (d: any) => Math.min(MAX_BID, d.current_bid * 1.10),
      reason: `Estoque alto: 60–90 dias de cobertura. Bid aumentado 10% respeitando máximo R$${MAX_BID}.`,
      goal_protected: 'Bid Máximo',
      is_boost: true,
    },
    {
      rule_key: 'stock_excess_liquidate',
      label: 'Excesso de estoque (> 90 dias) — aumentar bid',
      cooldown_hours: 48,
      matches: (d: any) => d.stock > 0 && d.stock_velocity > 0 && d.stock_coverage_days >= 90,
      action: (d: any) => Math.min(MAX_BID, d.current_bid * 1.15),
      reason: `Excesso de estoque: > 90 dias de cobertura. Bid aumentado 15% respeitando máximo R$${MAX_BID}.`,
      goal_protected: 'Bid Máximo',
      is_boost: true,
    },
  ];
}

function buildAcosRules(settings: any) {
  const MIN_BID = settings.min_bid;
  const MAX_BID = settings.max_bid;
  const MAX_INCREASE_PCT = settings.max_bid_increase_percent / 100;
  const MAX_DECREASE_PCT = settings.max_bid_decrease_percent / 100;
  const TARGET_ACOS = settings.target_acos;
  const MAX_ACOS = settings.max_acos;
  const TARGET_ROAS = settings.target_roas;
  const MAX_CPC = settings.max_cpc;
  const ENFORCE_CPC = settings.enforce_max_cpc;

  return [
    {
      rule_key: 'acos_above_max',
      label: `ACoS acima do máximo (>${MAX_ACOS}%) — reduzir bid ${Math.round(MAX_DECREASE_PCT * 100)}%`,
      cooldown_hours: 72,
      matches: (d: any) =>
        d.acos_14d !== null &&
        d.clicks_14d >= MIN_CLICKS_FOR_DECISION &&
        d.impressions_14d >= MIN_IMPRESSIONS_FOR_DECISION &&
        d.spend_14d >= MIN_SPEND_FOR_DECISION &&
        (d.impressions_14d > 0 ? d.clicks_14d / d.impressions_14d : 0) >= MIN_CTR_QUALITY &&
        d.acos_14d > MAX_ACOS,
      action: (d: any) => {
        const cvr = d.clicks_14d > 0 ? (d.orders_14d || 0) / d.clicks_14d : 0;
        const factor = 1 - (cvr < 0.005 && d.spend_14d >= 10 ? MAX_DECREASE_PCT : MAX_DECREASE_PCT * 0.75);
        return Math.max(MIN_BID, d.current_bid * factor);
      },
      reason_fn: (d: any) => {
        const cvr = d.clicks_14d > 0 ? ((d.orders_14d || 0) / d.clicks_14d * 100).toFixed(2) : '0.00';
        return `ACoS 14d: ${d.acos_14d.toFixed(1)}% ACIMA do máximo configurado ${MAX_ACOS}%. CVR: ${cvr}%. Bid reduzido. Meta protegida: ACoS Máximo. [Configurações > Metas de Performance]`;
      },
      goal_protected: 'ACoS Máximo',
      is_boost: false,
    },
    {
      rule_key: 'acos_above_target',
      label: `ACoS entre alvo e máximo (${TARGET_ACOS}%–${MAX_ACOS}%) — reduzir bid levemente`,
      cooldown_hours: 72,
      matches: (d: any) =>
        d.acos_14d !== null &&
        d.clicks_14d >= MIN_CLICKS_FOR_DECISION &&
        d.impressions_14d >= MIN_IMPRESSIONS_FOR_DECISION &&
        d.spend_14d >= MIN_SPEND_FOR_DECISION &&
        (d.impressions_14d > 0 ? d.clicks_14d / d.impressions_14d : 0) >= MIN_CTR_QUALITY &&
        d.acos_14d > TARGET_ACOS && d.acos_14d <= MAX_ACOS,
      action: (d: any) => Math.max(MIN_BID, d.current_bid * (1 - Math.min(0.10, MAX_DECREASE_PCT * 0.5))),
      reason_fn: (d: any) => {
        const ctr = d.impressions_14d > 0 ? (d.clicks_14d / d.impressions_14d * 100).toFixed(3) : '0.000';
        return `ACoS 14d: ${d.acos_14d.toFixed(1)}% acima do alvo ${TARGET_ACOS}% (zona de atenção). CTR: ${ctr}%. Bid reduzido levemente. Meta protegida: ACoS Alvo. [Configurações > Metas de Performance]`;
      },
      goal_protected: 'ACoS Alvo',
      is_boost: false,
    },
    {
      rule_key: 'acos_below_target',
      label: `ACoS abaixo do alvo (<${TARGET_ACOS * 0.7}%) — aumentar bid`,
      cooldown_hours: 72,
      matches: (d: any) =>
        d.acos_14d !== null &&
        d.clicks_14d >= MIN_CLICKS_FOR_DECISION &&
        d.impressions_14d >= MIN_IMPRESSIONS_FOR_DECISION &&
        d.spend_14d >= MIN_SPEND_FOR_DECISION &&
        (d.impressions_14d > 0 ? d.clicks_14d / d.impressions_14d : 0) >= MIN_CTR_QUALITY &&
        (d.orders_14d || 0) >= 1 &&
        d.sales_14d > 0 &&
        d.acos_14d < TARGET_ACOS * 0.7 &&
        // Guardrails adicionais configurados
        (!ENFORCE_CPC || MAX_CPC <= 0 || (d.cpc_14d || d.cpc || 0) <= MAX_CPC) &&
        (TARGET_ROAS <= 0 || (d.roas_14d || 0) >= TARGET_ROAS),
      action: (d: any) => {
        const pct = Math.min(MAX_INCREASE_PCT, 0.08);
        return Math.min(MAX_BID, d.current_bid * (1 + pct));
      },
      reason_fn: (d: any) => {
        const cvr = d.clicks_14d > 0 ? ((d.orders_14d || 0) / d.clicks_14d * 100).toFixed(2) : '0.00';
        const ctr = d.impressions_14d > 0 ? (d.clicks_14d / d.impressions_14d * 100).toFixed(3) : '0.000';
        return `ACoS 14d: ${d.acos_14d.toFixed(1)}% abaixo do alvo ${TARGET_ACOS}% (espaço para crescer). CVR: ${cvr}% | CTR: ${ctr}%. Bid aumentado respeitando máximo R$${MAX_BID}. Meta protegida: ACoS Alvo + Bid Máximo. [Configurações > Metas de Performance]`;
      },
      goal_protected: 'ACoS Alvo',
      is_boost: true,
    },
    {
      rule_key: 'cpc_above_max',
      label: `CPC acima do máximo (>R$${MAX_CPC}) — reduzir bid`,
      cooldown_hours: 48,
      matches: (d: any) =>
        ENFORCE_CPC && MAX_CPC > 0 &&
        d.clicks_14d >= MIN_CLICKS_FOR_DECISION &&
        d.spend_14d >= MIN_SPEND_FOR_DECISION &&
        (d.clicks_14d > 0 ? d.spend_14d / d.clicks_14d : 0) > MAX_CPC,
      action: (d: any) => {
        const pct = Math.min(MAX_DECREASE_PCT, 0.20);
        return Math.max(MIN_BID, d.current_bid * (1 - pct));
      },
      reason_fn: (d: any) => {
        const currentCpc = d.clicks_14d > 0 ? (d.spend_14d / d.clicks_14d).toFixed(2) : '—';
        return `CPC 14d: R$${currentCpc} ACIMA do máximo configurado R$${MAX_CPC}. Bid reduzido ${Math.round(Math.min(MAX_DECREASE_PCT, 0.20) * 100)}%. Meta protegida: CPC Máximo (Enforçar CPC ativo). [Configurações > Metas de Performance]`;
      },
      goal_protected: 'CPC Máximo',
      is_boost: false,
    },
    {
      rule_key: 'high_cvr_scale_opportunity',
      label: 'CVR alto + ACoS OK — escalar bid',
      cooldown_hours: 96,
      matches: (d: any) => {
        const cvr = d.clicks_14d > 0 ? (d.orders_14d || 0) / d.clicks_14d : 0;
        const ctr = d.impressions_14d > 0 ? d.clicks_14d / d.impressions_14d : 0;
        const currentCpc = d.clicks_14d > 0 ? d.spend_14d / d.clicks_14d : 0;
        return (
          d.acos_14d !== null &&
          d.clicks_14d >= MIN_CLICKS_FOR_DECISION * 2 &&
          d.impressions_14d >= MIN_IMPRESSIONS_FOR_DECISION * 2 &&
          ctr >= MIN_CTR_QUALITY &&
          cvr >= 0.03 &&
          d.acos_14d <= TARGET_ACOS * 0.9 &&
          (d.orders_14d || 0) >= 2 &&
          (!ENFORCE_CPC || MAX_CPC <= 0 || currentCpc <= MAX_CPC)
        );
      },
      action: (d: any) => Math.min(MAX_BID, d.current_bid * Math.min(1 + MAX_INCREASE_PCT * 0.25, 1.05)),
      reason_fn: (d: any) => {
        const cvr = d.clicks_14d > 0 ? ((d.orders_14d || 0) / d.clicks_14d * 100).toFixed(2) : '0.00';
        return `CVR: ${cvr}% (alta intenção) + ACoS 14d: ${d.acos_14d.toFixed(1)}% dentro do alvo ${TARGET_ACOS}%. Bid +${Math.round(Math.min(MAX_INCREASE_PCT * 0.25, 0.05) * 100)}% respeitando máximo R$${MAX_BID}. Meta protegida: Bid Máximo + ACoS Alvo. [Configurações > Metas de Performance]`;
      },
      goal_protected: 'Bid Máximo',
      is_boost: true,
    },
  ];
}

function uuid() { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }

function evaluateCondition(cond, entity) {
  // null/undefined métricas: retornar false imediatamente para evitar comparações incorretas
  const rawVal = entity[cond.metric];
  if (rawVal === null || rawVal === undefined) return false;
  const val = rawVal;
  switch (cond.operator) {
    case 'equals': return val === cond.value;
    case 'not_equals': return val !== cond.value;
    case 'greater_than': return val > cond.value;
    case 'greater_than_or_equal': return val >= cond.value;
    case 'less_than': return val < cond.value;
    case 'less_than_or_equal': return val <= cond.value;
    case 'between': return val >= cond.value[0] && val <= cond.value[1];
    case 'in': return Array.isArray(cond.value) && cond.value.includes(val);
    case 'not_in': return Array.isArray(cond.value) && !cond.value.includes(val);
    case 'days_since': {
      if (!entity[cond.metric]) return false;
      const ageDays = (Date.now() - new Date(entity[cond.metric]).getTime()) / 86400000;
      return ageDays >= (cond.value || 0);
    }
    default: return false;
  }
}

function entityMatchesRule(rule, entity) {
  return (rule.conditions || []).every(cond => evaluateCondition(cond, entity));
}

function calculateActionValue(rule, entity, settings: any) {
  const action = rule.action;
  const currentBid = entity.current_bid || entity.bid || 0.25;
  const MIN_BID = settings.min_bid;
  const MAX_BID = settings.max_bid;
  const MAX_BID_CHANGE_PCT = settings.max_bid_increase_percent / 100;
  const MAX_BID_REDUCE_PCT = settings.max_bid_decrease_percent / 100;

  switch (action.type) {
    case 'increase_bid_percent': {
      const pct = Math.min(action.value / 100, MAX_BID_CHANGE_PCT);
      return Math.min(currentBid * (1 + pct), MAX_BID);
    }
    case 'decrease_bid_percent': {
      const pct = Math.min(action.value / 100, MAX_BID_REDUCE_PCT);
      return Math.max(currentBid * (1 - pct), MIN_BID);
    }
    case 'set_bid':
      return Math.min(Math.max(action.value, MIN_BID), MAX_BID);
    default:
      return action.value;
  }
}

function resolveRuleConflicts(ruleA, ruleB) {
  const typeA = ruleA.action?.type || '';
  const typeB = ruleB.action?.type || '';
  const categoryOf = (t) => {
    if (['pause_campaign', 'pause_keyword'].includes(t)) return 'pause_loss';
    if (['decrease_bid_percent', 'set_bid'].includes(t)) return 'reduce_bid';
    if (['increase_bid_percent'].includes(t)) return 'increase_bid';
    if (['create_exact_keyword', 'create_phrase_keyword', 'create_broad_keyword', 'create_campaign'].includes(t)) return 'expansion';
    return 'maintenance';
  };
  const prioA = CONFLICT_PRIORITY[categoryOf(typeA)] || 99;
  const prioB = CONFLICT_PRIORITY[categoryOf(typeB)] || 99;
  return prioA <= prioB ? { execute: ruleA, skip: ruleB } : { execute: ruleB, skip: ruleA };
}

// ── Sazonalidade inline ───────────────────────────────────────────────────────

function getBrazilEventsForYear(year) {
  function lastFridayNov(y) {
    const d = new Date(y, 11, 0);
    while (d.getDay() !== 5) d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  function secondSunday(y, month) {
    const d = new Date(y, month - 1, 1);
    let s = 0;
    while (s < 2) { if (d.getDay() === 0) s++; if (s < 2) d.setDate(d.getDate() + 1); }
    return d.toISOString().slice(0, 10);
  }
  const bf = lastFridayNov(year);
  const cm = new Date(bf); cm.setDate(cm.getDate() + 3);
  return [
    { name: 'Ano Novo', type: 'holiday', date: `${year}-01-01`, pre: 3, post: 2, demand: 'moderate_peak', cpc: 'low' },
    { name: 'Tiradentes', type: 'holiday', date: `${year}-04-21`, pre: 1, post: 1, demand: 'low_demand', cpc: 'none' },
    { name: 'Dia do Trabalho', type: 'holiday', date: `${year}-05-01`, pre: 1, post: 1, demand: 'low_demand', cpc: 'none' },
    { name: 'Dia dos Namorados', type: 'valentines_day', date: `${year}-06-12`, pre: 14, post: 2, demand: 'moderate_peak', cpc: 'moderate' },
    { name: 'Independência', type: 'holiday', date: `${year}-09-07`, pre: 1, post: 1, demand: 'low_demand', cpc: 'none' },
    { name: 'Dia das Crianças', type: 'childrens_day', date: `${year}-10-12`, pre: 21, post: 2, demand: 'high_peak', cpc: 'high' },
    { name: 'Finados', type: 'holiday', date: `${year}-11-02`, pre: 1, post: 1, demand: 'low_demand', cpc: 'none' },
    { name: 'Proclamação da República', type: 'holiday', date: `${year}-11-15`, pre: 1, post: 1, demand: 'low_demand', cpc: 'none' },
    { name: 'Black Friday', type: 'black_friday', date: bf, pre: 14, post: 3, demand: 'very_high_peak', cpc: 'very_high' },
    { name: 'Cyber Monday', type: 'cyber_monday', date: cm.toISOString().slice(0, 10), pre: 0, post: 2, demand: 'very_high_peak', cpc: 'very_high' },
    { name: 'Pré-Natal', type: 'pre_christmas', date: `${year}-12-24`, pre: 30, post: 0, demand: 'high_peak', cpc: 'high' },
    { name: 'Natal', type: 'christmas', date: `${year}-12-25`, pre: 0, post: 3, demand: 'high_peak', cpc: 'very_high' },
    { name: 'Reveillon', type: 'new_year', date: `${year}-12-31`, pre: 5, post: 3, demand: 'moderate_peak', cpc: 'moderate' },
    { name: 'Dia das Mães', type: 'mothers_day', date: secondSunday(year, 5), pre: 21, post: 2, demand: 'high_peak', cpc: 'high' },
    { name: 'Dia dos Pais', type: 'fathers_day', date: secondSunday(year, 8), pre: 14, post: 2, demand: 'high_peak', cpc: 'moderate' },
    { name: 'Volta às Aulas Fev', type: 'back_to_school', date: `${year}-02-01`, pre: 14, post: 7, demand: 'moderate_peak', cpc: 'low' },
    { name: 'Volta às Aulas Ago', type: 'back_to_school', date: `${year}-08-01`, pre: 14, post: 7, demand: 'moderate_peak', cpc: 'low' },
  ];
}

function getSeasonalCtx(dateStr, customEvents) {
  const date = new Date(dateStr + 'T12:00:00');
  const dow = date.getDay();
  const dom = parseInt(dateStr.slice(8, 10));
  const year = parseInt(dateStr.slice(0, 4));
  const isWeekend = dow === 0 || dow === 6;
  const allEvents = [
    ...getBrazilEventsForYear(year - 1),
    ...getBrazilEventsForYear(year),
    ...getBrazilEventsForYear(year + 1),
    ...(customEvents || []),
  ];
  const matched = [];
  for (const ev of allEvents) {
    const evDate = new Date((ev.peak_date || ev.date) + 'T12:00:00');
    const preMs = (ev.pre || ev.pre_event_days || 0) * 86400000;
    const postMs = (ev.post || ev.post_event_days || 0) * 86400000;
    const endDate = ev.end ? new Date(ev.end + 'T12:00:00') : evDate;
    if (date >= new Date(evDate.getTime() - preMs) && date <= new Date(endDate.getTime() + postMs)) {
      const daysTo = Math.round((evDate.getTime() - date.getTime()) / 86400000);
      const phase = daysTo > 0 ? 'pre_event' : (date > endDate ? 'post_event' : 'active');
      matched.push({ name: ev.name, type: ev.event_type || ev.type, phase, days_to: daysTo, demand: ev.demand || 'normal', cpc: ev.cpc || 'none' });
    }
  }
  const prio = { very_high_peak: 5, high_peak: 4, moderate_peak: 3, normal: 2, uncertain: 1, low_demand: 0 };
  matched.sort((a, b) => (prio[b.demand] || 0) - (prio[a.demand] || 0));
  const primary = matched[0] || null;
  const demandLevel = primary?.demand || (isWeekend ? 'uncertain' : 'normal');
  return {
    is_weekend: isWeekend,
    is_saturday: dow === 6,
    is_sunday: dow === 0,
    is_holiday: matched.some(e => ['holiday', 'christmas', 'new_year'].includes(e.type)),
    is_start_of_month: dom <= 5,
    is_end_of_month: dom >= 26,
    is_payday_week: dom >= 4 && dom <= 10,
    seasonal_event_name: primary?.name || null,
    seasonal_phase: primary?.phase || 'normal',
    expected_demand_level: demandLevel,
    expected_cpc_pressure: primary?.cpc || 'none',
    is_strong_event: ['very_high_peak', 'high_peak'].includes(demandLevel),
    is_pre_event: primary?.phase === 'pre_event',
    is_low_demand: demandLevel === 'low_demand',
  };
}

// Retorna true se ação de aumento deve ser bloqueada por sazonalidade
function seasonalBlocksIncrease(seasonalCtx, weekendCtx, hasSales, hasStock, stockDays) {
  const hasAdequateStock = hasStock && (stockDays == null || stockDays >= 7);
  // Bloquear em baixa demanda
  if (seasonalCtx.is_low_demand) return true;
  // Bloquear em feriado sem vendas
  if (seasonalCtx.is_holiday && !hasSales) return true;
  // Bloquear em fim de semana com histórico ruim
  if (seasonalCtx.is_weekend && weekendCtx?.weekend_performs_better === false) return true;
  // Bloquear se estoque insuficiente em evento forte
  if (seasonalCtx.is_strong_event && !hasAdequateStock) return true;
  return false;
}

function buildSeasonalContextPayload(seasonalCtx) {
  return JSON.stringify({
    is_weekend: seasonalCtx.is_weekend,
    is_holiday: seasonalCtx.is_holiday,
    seasonal_event_name: seasonalCtx.seasonal_event_name,
    seasonal_phase: seasonalCtx.seasonal_phase,
    expected_demand_level: seasonalCtx.expected_demand_level,
    expected_cpc_pressure: seasonalCtx.expected_cpc_pressure,
  });
}

// ── Handler principal ────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const correlationId = uuid();
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const base44 = createClientFromRequest(req);

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
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

    // ── 0. Carregar Metas de Performance (Fonte Única) ────────────────────
    // OBRIGATÓRIO: todas as decisões de bid/budget/acos usam esses valores.
    // Fallback em cascata: PerformanceSettings → AutopilotConfig → defaults do sistema.
    let settings: any = null;
    try {
      const psList = await base44.asServiceRole.entities.PerformanceSettings.filter(
        { amazon_account_id: aid }, '-updated_at', 1
      );
      if (psList.length > 0) {
        const ps = psList[0];
        settings = {
          primary_metric: ps.primary_goal || 'acos',
          strategic_goal: ps.objective || 'profitability',
          target_acos: Number(ps.target_acos ?? FALLBACK_TARGET_ACOS),
          max_acos: Number(ps.max_acos ?? FALLBACK_MAX_ACOS),
          target_roas: Number(ps.target_roas ?? 4),
          target_tacos: Number(ps.target_tacos ?? 5),
          max_tacos: Number(ps.max_tacos ?? 10),
          daily_budget_cap: Number(ps.daily_budget_limit ?? FALLBACK_DAILY_BUDGET_CAP),
          target_cpc: Number(ps.target_cpc ?? 0.60),
          max_cpc: Number(ps.max_cpc ?? 1.00),
          enforce_max_cpc: ps.max_cpc > 0,
          impressions_goal_enabled: Boolean(ps.impressions_goal_enabled ?? false),
          min_bid: Number(ps.min_bid ?? FALLBACK_MIN_BID),
          max_bid: Number(ps.max_bid ?? FALLBACK_MAX_BID),
          max_bid_increase_percent: Number(ps.max_bid_increase_pct ?? 20),
          max_bid_decrease_percent: Number(ps.max_bid_decrease_pct ?? 20),
          min_campaign_budget: Number(ps.minimum_campaign_budget ?? 15),
          budget_increment_allowed: Number(ps.campaign_budget_increment ?? 5),
          weekly_campaign_capacity: Number(ps.weekly_campaign_capacity ?? 10),
          pacing_enabled: Boolean(ps.pacing_enabled ?? true),
          dayparting_enabled: Boolean(ps.dayparting_enabled ?? true),
          placement_optimization_enabled: Boolean(ps.placement_optimization_enabled ?? true),
          max_top_of_search_adjustment: Number(ps.top_of_search_limit ?? 0),
          max_rest_of_search_adjustment: Number(ps.rest_of_search_limit ?? 0),
          max_product_pages_adjustment: Number(ps.product_page_limit ?? 0),
          ai_auto_optimization_enabled: Boolean(ps.ai_auto_optimization ?? false),
          settings_source: 'PerformanceSettings',
        };
      }
    } catch {}

    if (!settings) {
      // Fallback: AutopilotConfig
      try {
        const apList = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }, null, 1);
        if (apList.length > 0) {
          const cfg = apList[0];
          settings = {
            primary_metric: 'acos',
            strategic_goal: cfg.objective || 'profitability',
            target_acos: Number(cfg.target_acos ?? FALLBACK_TARGET_ACOS),
            max_acos: Number(cfg.maximum_acos ?? FALLBACK_MAX_ACOS),
            target_roas: Number(cfg.target_roas ?? 4),
            target_tacos: Number(cfg.target_tacos ?? 5),
            max_tacos: Number(cfg.maximum_tacos ?? 10),
            daily_budget_cap: Number(cfg.total_daily_budget ?? cfg.daily_budget_limit ?? FALLBACK_DAILY_BUDGET_CAP),
            target_cpc: Number(cfg.target_cpc ?? 0.60),
            max_cpc: Number(cfg.maximum_cpc ?? 1.00),
            enforce_max_cpc: Boolean(cfg.cpc_enforcement ?? true),
            impressions_goal_enabled: Boolean(cfg.impressions_goal_enabled ?? false),
            min_bid: Number(cfg.min_bid ?? FALLBACK_MIN_BID),
            max_bid: Number(cfg.max_bid ?? FALLBACK_MAX_BID),
            max_bid_increase_percent: Number(cfg.max_bid_increase_pct ?? 20),
            max_bid_decrease_percent: Number(cfg.max_bid_decrease_pct ?? 20),
            min_campaign_budget: 15,
            budget_increment_allowed: 5,
            weekly_campaign_capacity: 10,
            pacing_enabled: Boolean(cfg.budget_optimization_enabled ?? true),
            dayparting_enabled: Boolean(cfg.dayparting_enabled ?? true),
            placement_optimization_enabled: Boolean(cfg.placement_optimization_enabled ?? true),
            max_top_of_search_adjustment: Number(cfg.top_of_search_limit ?? 0),
            max_rest_of_search_adjustment: Number(cfg.rest_of_search_limit ?? 0),
            max_product_pages_adjustment: Number(cfg.product_page_limit ?? 0),
            ai_auto_optimization_enabled: Boolean(cfg.ai_auto_optimization ?? false),
            settings_source: 'AutopilotConfig',
          };
        }
      } catch {}
    }

    // Defaults absolutos se nenhuma configuração encontrada
    if (!settings) {
      settings = {
        primary_metric: 'acos', strategic_goal: 'profitability',
        target_acos: FALLBACK_TARGET_ACOS, max_acos: FALLBACK_MAX_ACOS,
        target_roas: 4, target_tacos: 5, max_tacos: 10,
        daily_budget_cap: FALLBACK_DAILY_BUDGET_CAP,
        target_cpc: 0.60, max_cpc: 1.00, enforce_max_cpc: true,
        impressions_goal_enabled: false,
        min_bid: FALLBACK_MIN_BID, max_bid: FALLBACK_MAX_BID,
        max_bid_increase_percent: 20, max_bid_decrease_percent: 20,
        min_campaign_budget: 15, budget_increment_allowed: 5, weekly_campaign_capacity: 10,
        pacing_enabled: true, dayparting_enabled: true, placement_optimization_enabled: true,
        max_top_of_search_adjustment: 0, max_rest_of_search_adjustment: 0, max_product_pages_adjustment: 0,
        ai_auto_optimization_enabled: false, settings_source: 'system_defaults',
      };
    }

    // Construir regras nativas com os parâmetros configurados
    const STOCK_RULES = buildStockRules(settings);
    const ACOS_RULES = buildAcosRules(settings);

    // ── 1. Regras vigentes ────────────────────────────────────────────────
    const allRules = await base44.asServiceRole.entities.DecisionRule.filter({ amazon_account_id: aid, status: 'active' });
    const activeRules = allRules.filter(r => {
      if (r.effective_from && new Date(r.effective_from) > new Date()) return false;
      if (r.effective_until && new Date(r.effective_until) < new Date()) return false;
      return true;
    }).sort((a, b) => (a.priority || 100) - (b.priority || 100));

    // Regras de estoque nativas rodam sempre — mesmo sem regras no banco.

    // ── 2. Dados em paralelo ──────────────────────────────────────────────
    const [keywords, campaigns, products, customSeasonalEvents, metricsRaw, salesDailyRaw, unifiedRaw] = await Promise.all([
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, '-spend', 500),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 200),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 100),
      base44.asServiceRole.entities.SeasonalityCalendar.filter({ amazon_account_id: aid, enabled: true }).catch(() => []),
      base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 200).catch(() => []),
      base44.asServiceRole.entities.SalesDaily.filter({ amazon_account_id: aid }, '-date', 500).catch(() => []),
      base44.asServiceRole.entities.UnifiedAdsMetricsDaily.filter({ amazon_account_id: aid }, '-date', 300).catch(() => []),
    ]);

    // ── 2b. Agregar SalesDaily por ASIN (últimos 30 dias) ─────────────────
    // Métricas reais de pedidos vindas do SP-API Orders Report
    const salesByAsin = new Map(); // asin → { total_revenue, total_units, orders_count, avg_ticket, dates: Set }
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    for (const s of salesDailyRaw) {
      if (!s.asin || s.date < thirtyDaysAgo) continue;
      if (!salesByAsin.has(s.asin)) salesByAsin.set(s.asin, { total_revenue: 0, total_units: 0, orders_count: 0, dates: new Set() });
      const entry = salesByAsin.get(s.asin);
      entry.total_revenue += s.ordered_product_sales || 0;
      entry.total_units += s.units_ordered || 0;
      if ((s.units_ordered || 0) > 0) entry.orders_count++;
      if (s.date) entry.dates.add(s.date);
    }
    // Finalizar métricas derivadas por ASIN
    const salesMetricsByAsin = new Map();
    for (const [asin, s] of salesByAsin.entries()) {
      const activeDays = s.dates.size || 1;
      salesMetricsByAsin.set(asin, {
        real_revenue_30d: s.total_revenue,
        real_units_30d: s.total_units,
        real_orders_30d: s.orders_count,
        real_avg_ticket: s.orders_count > 0 ? s.total_revenue / s.orders_count : 0,
        real_revenue_per_day: s.total_revenue / activeDays,
        has_real_sales: s.total_units > 0,
      });
    }

    // ── 2c. Agregar UnifiedAdsMetricsDaily por campaign_id (14d) ─────────────
    // Métricas de qualidade: impressão share, topo de pesquisa, halo, tráfego inválido
    const unifiedCutoff14d = new Date(Date.now() - ATTRIBUTION_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
    const unifiedByCampaign = new Map();
    for (const m of unifiedRaw) {
      if (!m.campaign_id || !m.date || m.date < unifiedCutoff14d) continue;
      if (!unifiedByCampaign.has(m.campaign_id)) {
        unifiedByCampaign.set(m.campaign_id, {
          impression_share_sum: 0, top_of_search_sum: 0, rows: 0,
          invalid_clicks: 0, invalid_impressions: 0, clicks: 0, impressions: 0,
          promoted_sales: 0, halo_purchases: 0, budget_at_risk: false,
        });
      }
      const e = unifiedByCampaign.get(m.campaign_id);
      if (m.impression_share > 0) e.impression_share_sum += m.impression_share;
      if (m.top_of_search_impression_share > 0) e.top_of_search_sum += m.top_of_search_impression_share;
      e.invalid_clicks += m.invalid_clicks || 0;
      e.invalid_impressions += m.invalid_impressions || 0;
      e.clicks += m.clicks || 0;
      e.impressions += m.impressions || 0;
      e.promoted_sales += m.promoted_sales || 0;
      e.halo_purchases += m.halo_purchases || 0;
      if (m.budget_at_risk) e.budget_at_risk = true;
      e.rows++;
    }
    // Calcular médias e taxas
    for (const [, e] of unifiedByCampaign.entries()) {
      e.avg_impression_share = e.rows > 0 ? e.impression_share_sum / e.rows : 0;
      e.avg_top_of_search = e.rows > 0 ? e.top_of_search_sum / e.rows : 0;
      e.avg_invalid_click_rate = e.clicks > 0 ? e.invalid_clicks / e.clicks : 0;
    }

    // TACoS real por ASIN: gasto ads / receita real
    // Fonte primária: CampaignMetricsDaily (tem campaign_id); Campaigns têm asin
    const adsSpendByAsin = new Map();
    const adsSpendByCampaign = new Map();
    for (const m of metricsRaw) {
      if (m.campaign_id) {
        adsSpendByCampaign.set(m.campaign_id, (adsSpendByCampaign.get(m.campaign_id) || 0) + (m.spend || 0));
      }
      if (m.asin) {
        adsSpendByAsin.set(m.asin, (adsSpendByAsin.get(m.asin) || 0) + (m.spend || 0));
      }
    }
    // Para campanhas com ASIN: acumular spend por ASIN via campaign
    for (const c of campaigns) {
      if (!c.asin || !c.campaign_id) continue;
      const campaignSpend = adsSpendByCampaign.get(c.campaign_id) || adsSpendByCampaign.get(c.amazon_campaign_id) || 0;
      adsSpendByAsin.set(c.asin, (adsSpendByAsin.get(c.asin) || 0) + campaignSpend);
    }
    for (const [asin, metrics] of salesMetricsByAsin.entries()) {
      const spend = adsSpendByAsin.get(asin) || 0;
      metrics.real_tacos_pct = metrics.real_revenue_30d > 0 ? (spend / metrics.real_revenue_30d) * 100 : null;
      metrics.ads_spend_30d = spend;
    }

    // TACoS por campanha: para keywords sem ASIN, usar o TACoS da campanha
    // Calculado como: spend da campanha / receita real do ASIN da campanha
    const tacosByCampaignId = new Map();
    for (const c of campaigns) {
      if (!c.asin) continue;
      const campaignSpend = adsSpendByCampaign.get(c.campaign_id) || adsSpendByCampaign.get(c.amazon_campaign_id) || 0;
      const asinSales = salesMetricsByAsin.get(c.asin);
      if (asinSales?.real_revenue_30d > 0 && campaignSpend > 0) {
        const tacos = (campaignSpend / asinSales.real_revenue_30d) * 100;
        if (c.campaign_id) tacosByCampaignId.set(c.campaign_id, tacos);
        if (c.amazon_campaign_id) tacosByCampaignId.set(c.amazon_campaign_id, tacos);
      }
    }

    // TACoS de conta: soma de todo spend / soma de toda receita real
    const totalAdsSpend30d = Array.from(adsSpendByCampaign.values()).reduce((s, v) => s + v, 0);
    const totalRealRevenue30d = Array.from(salesMetricsByAsin.values()).reduce((s, m) => s + m.real_revenue_30d, 0);
    const accountTacos = totalRealRevenue30d > 0 ? (totalAdsSpend30d / totalRealRevenue30d) * 100 : null;

    // ── 3. Contexto sazonal ───────────────────────────────────────────────
    const seasonalCtx = getSeasonalCtx(today, customSeasonalEvents);

    // Análise FDS vs dias úteis (últimos 30 dias)
    const cutStart = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);
    const cutEnd = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const byDate = {};
    for (const m of metricsRaw) {
      if (!m.date || m.date < cutStart || m.date > cutEnd) continue;
      if (!byDate[m.date]) byDate[m.date] = { spend: 0, sales: 0, orders: 0, clicks: 0 };
      byDate[m.date].spend += m.spend || 0;
      byDate[m.date].sales += m.sales || 0;
      byDate[m.date].orders += m.orders || 0;
      byDate[m.date].clicks += m.clicks || 0;
    }
    const wd = { spend: 0, sales: 0, orders: 0, clicks: 0, days: 0 };
    const we = { spend: 0, sales: 0, orders: 0, clicks: 0, days: 0 };
    for (const [d, v] of Object.entries(byDate)) {
      const dow2 = new Date(d + 'T12:00:00').getDay();
      const b = (dow2 === 0 || dow2 === 6) ? we : wd;
      b.spend += v.spend; b.sales += v.sales; b.orders += v.orders; b.clicks += v.clicks; b.days++;
    }
    const wdCvr = wd.clicks > 0 ? wd.orders / wd.clicks : null;
    const weCvr = we.clicks > 0 ? we.orders / we.clicks : null;
    const wdAcos = wd.sales > 0 ? wd.spend / wd.sales * 100 : null;
    const weAcos = we.sales > 0 ? we.spend / we.sales * 100 : null;
    const weekendPerformsBetter = (wdCvr != null && weCvr != null && we.days >= 2 && wd.days >= 5)
      ? (weCvr > wdCvr * 1.05 && (wdAcos == null || weAcos == null || weAcos <= wdAcos * 1.25))
      : null;
    const weekendCtx = { weekend_performs_better: weekendPerformsBetter };

    // ── 4. Validar qualidade dos dados (Metodologia MRC) ─────────────────
    // Dados Amazon SP são considerados "revisáveis" por até 30 dias (ajustes SIVT retroativos).
    // Após 30 dias são finais e imutáveis. Incidentes raros podem gerar revisão até 90 dias.
    // Motor exige sincronização recente (< 48h) para garantir que os dados incluem
    // os últimos ajustes de filtragem GIVT/SIVT aplicados retroativamente pela Amazon.
    const dataAge = account.last_sync_at
      ? (Date.now() - new Date(account.last_sync_at).getTime()) / 3600000
      : 999;
    if (dataAge > 48) {
      return Response.json({
        ok: false, skipped: true,
        reason: `Dados desatualizados (${Math.round(dataAge)}h sem sync). Motor bloqueado: cliques líquidos pós-GIVT/SIVT podem estar desatualizados.`,
        correlationId,
        mrc_note: 'Amazon Ads aplica filtragem SIVT retroativa em até 30 dias. Dados sem sync recente podem refletir cliques brutos ainda não filtrados.',
      });
    }

    // Verificar se há dados dentro da janela de atribuição MRC (14d)
    const latestMetricDate = metricsRaw.length > 0
      ? metricsRaw.reduce((max, m) => m.date > max ? m.date : max, '2000-01-01')
      : null;
    const metricDataAge = latestMetricDate
      ? (Date.now() - new Date(latestMetricDate).getTime()) / 86400000
      : 999;
    const dataWithin14dWindow = metricDataAge <= ATTRIBUTION_WINDOW_DAYS;

    // ── 5. Guardrail: budget total (usa settings configurados) ───────────
    const totalActiveBudget = campaigns
      .filter(c => c.state === 'enabled' || c.status === 'enabled')
      .reduce((s, c) => s + (c.daily_budget || 0), 0);
    const suggestedTotalBudget = settings.daily_budget_cap;

    // ── 6. Índices ────────────────────────────────────────────────────────
    const productMap = new Map(products.map(p => [p.asin, p]));

    // Mapear campaign_id → asin (para keywords sem asin direto)
    const campaignAsinMap = new Map();
    for (const c of campaigns) {
      if (c.campaign_id && c.asin) campaignAsinMap.set(c.campaign_id, c.asin);
      if (c.amazon_campaign_id && c.asin) campaignAsinMap.set(c.amazon_campaign_id, c.asin);
    }

    const recentExecs = await base44.asServiceRole.entities.RuleExecution.filter(
      { amazon_account_id: aid }, '-created_date', 300
    );
    const lastExecByRuleEntity = new Map();
    for (const ex of recentExecs) {
      const k = `${ex.rule_key}|${ex.entity_id}`;
      if (!lastExecByRuleEntity.has(k)) lastExecByRuleEntity.set(k, ex);
    }
    const usedIdemKeys = new Set(
      recentExecs.filter(e => (e.created_date || '').slice(0, 10) === today).map(e => e.idempotency_key).filter(Boolean)
    );

    const actionsToEnqueue = [];
    const conflicts = [];
    const stats = { evaluated: 0, matched: 0, skipped_cooldown: 0, skipped_dup: 0, skipped_stock: 0, skipped_seasonal: 0, enqueued: 0, stock_rules_applied: 0, acos_rules_applied: 0 };
    const entityChangedThisCycle = new Map();
    const scopedEntities = { keyword: keywords, campaign: campaigns };

    const seasonalPayload = buildSeasonalContextPayload(seasonalCtx);

    // ── 7a. Regras nativas de estoque (prioridade máxima) ─────────────────
    // Executam sobre keywords com asin resolvido, independente do banco de regras.
    for (const kw of keywords) {
      const entityId = kw.keyword_id || kw.id;
      if (!entityId) continue;

      const resolvedAsin = kw.asin || campaignAsinMap.get(kw.campaign_id) || null;
      if (!resolvedAsin) continue;

      const product = productMap.get(resolvedAsin);
      if (!product) continue;

      const realSales = salesMetricsByAsin.get(resolvedAsin) || {};
      const stockQty = product.fba_inventory || 0;
      const realUnits30d = realSales.real_units_30d || 0;
      const stockVelocity = realUnits30d / 30;
      const stockCoverageDays = stockVelocity > 0 ? stockQty / stockVelocity : 999;

      const entityData = {
        ...kw,
        current_bid: kw.current_bid || kw.bid || 0.25,
        stock: stockQty,
        stock_coverage_days: stockCoverageDays,
        stock_velocity: stockVelocity,
      };

      for (const sr of STOCK_RULES) {
        if (!sr.matches(entityData)) continue;

        // Guardrail sazonal: não aumentar bid em baixa demanda ou feriado sem vendas
        if (sr.is_boost) {
          if (seasonalCtx.is_low_demand) continue;
          if (seasonalCtx.is_holiday && !realSales.has_real_sales) continue;
        }

        // Cooldown — usa created_date (campo real do banco) com fallback para executed_at
        const lastExecSR = lastExecByRuleEntity.get(`${sr.rule_key}|${entityId}`);
        if (lastExecSR) {
          const lastTs = lastExecSR.created_date || lastExecSR.executed_at;
          if (lastTs) {
            const hoursAgo = (Date.now() - new Date(lastTs).getTime()) / 3600000;
            if (hoursAgo < sr.cooldown_hours) continue;
          }
        }

        const iKey = `stock|${aid}|${sr.rule_key}|${entityId}|${today}`;
        if (usedIdemKeys.has(iKey)) continue;

        // Conflito com ação já agendada para esta entity neste ciclo
        if (entityChangedThisCycle.has(entityId)) continue;

        const newBid = sr.action(entityData);
        actionsToEnqueue.push({
          amazon_account_id: aid,
          correlation_id: correlationId,
          rule_key: sr.rule_key,
          rule_version: 1,
          entity_type: 'keyword',
          entity_id: entityId,
          campaign_id: kw.campaign_id,
          keyword_id: kw.keyword_id,
          asin: resolvedAsin,
          action_type: 'set_bid',
          value_before: entityData.current_bid,
          value_after: newBid,
          idempotency_key: iKey,
          status: 'pending',
          seasonal_context: seasonalPayload,
          reason: `${sr.reason} (cobertura: ${Math.round(stockCoverageDays)}d, estoque: ${stockQty}un, velocidade: ${stockVelocity.toFixed(2)}un/dia)`,
          stock_coverage_days: stockCoverageDays,
          stock_qty: stockQty,
        });
        entityChangedThisCycle.set(entityId, sr.rule_key);
        stats.stock_rules_applied++;
        stats.enqueued++;
        break; // apenas uma regra de estoque por keyword por ciclo
      }
    }

    // ── 7b. Regras nativas de ACoS por ASIN (30 dias) com meta dinâmica ─────────
    // Meta de ACoS calculada automaticamente por produto a partir da margem bruta:
    //   target_acos_asin = gross_margin_pct × (1 - safety_buffer)
    //   safety_buffer = 0.20 (reserva 20% da margem para lucro líquido)
    //   Limites: mínimo 5%, máximo 30%
    //   Fallback: globalTargetAcos → 10%
    //
    // Lógica: se a margem bruta é 30%, o máximo que posso gastar em ads é
    //         30% × 0.80 = 24% do faturamento, mantendo 6% de lucro líquido.

    const ACOS_SAFETY_BUFFER = 0.20; // 20% de reserva de margem para lucro
    const ACOS_MIN = 5;              // nunca usar meta abaixo de 5%
    const ACOS_MAX = 30;             // nunca usar meta acima de 30%

    // Meta global de ACoS vem dos settings configurados (não mais do AutopilotConfig diretamente)
    const globalTargetAcos = settings.target_acos;

    const profitLearnings = await base44.asServiceRole.entities.ProductProfitabilityLearning.filter(
      { amazon_account_id: aid }, null, 200
    ).catch(() => []);

    // Construir mapa asin → meta_acos calculada por produto
    // Fonte: ProductProfitabilityLearning.gross_margin_pct (margem bruta real dos últimos 30d)
    const acosByAsin = new Map(); // asin → target_acos calculado
    const acosBySkuIdx = new Map(); // sku → learning (para join com Product via sku)
    for (const pl of profitLearnings) {
      if (pl.sku) acosBySkuIdx.set(pl.sku, pl);
    }
    for (const p of products) {
      const asin = p.asin;
      if (!asin) continue;
      // Buscar learning: por ASIN direto ou via SKU
      const pl = profitLearnings.find(l => l.asin === asin) || (p.sku ? acosBySkuIdx.get(p.sku) : null);
      if (!pl) continue;
      const grossMargin = Number(pl.gross_margin_pct || 0);
      if (grossMargin <= 0) {
        // Margem negativa → produto bloqueado, não gerar meta (motor não atua)
        continue;
      }
      // Meta dinâmica: margem bruta × (1 - buffer de segurança)
      const dynTarget = grossMargin * (1 - ACOS_SAFETY_BUFFER);
      const clamped = Math.min(ACOS_MAX, Math.max(ACOS_MIN, dynTarget));
      acosByAsin.set(asin, Math.round(clamped * 10) / 10); // arredondar para 1 casa
    }

    const acosTargetSource = acosByAsin.size > 0 ? 'dynamic_per_product' : 'global_config';

    // Agregar métricas de ads por ASIN — JANELA 14d (escopo MRC primário de atribuição SP)
    // Cliques e impressões aqui são LÍQUIDOS pós-GIVT/SIVT (padrão da Amazon Ads API).
    // A API não expõe cliques brutos — apenas cliques válidos pós-filtragem são reportados.
    // Dados de D-1 a D-30 podem ainda sofrer ajustes retroativos de SIVT; após 30d são finais.
    const fourteenDaysAgo = new Date(Date.now() - ATTRIBUTION_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
    const adMetricsByAsin = new Map(); // asin → { spend_14d, sales_14d, clicks_14d, orders_14d, impressions_14d }
    for (const m of metricsRaw) {
      if (!m.campaign_id) continue;
      if (m.date && m.date < fourteenDaysAgo) continue; // apenas janela 14d MRC
      const asin = campaignAsinMap.get(m.campaign_id) || null;
      if (!asin) continue;
      if (!adMetricsByAsin.has(asin)) adMetricsByAsin.set(asin, { spend: 0, sales: 0, clicks: 0, orders: 0, impressions: 0 });
      const a = adMetricsByAsin.get(asin);
      a.spend += m.spend || 0;
      a.sales += m.sales || 0;
      a.clicks += m.clicks || 0;
      a.orders += m.orders || 0;
      a.impressions += m.impressions || 0;
    }

    // Persistir metas calculadas em Product.break_even_acos_pct (batch, sem bloquear pipeline)
    const productUpdates = [];
    for (const [asin, dynTarget] of acosByAsin.entries()) {
      const p = productMap.get(asin);
      if (p && p.id && Math.abs((p.break_even_acos_pct || 0) - dynTarget) > 0.5) {
        productUpdates.push({ id: p.id, break_even_acos_pct: dynTarget });
      }
    }
    if (productUpdates.length > 0) {
      base44.asServiceRole.entities.Product.bulkUpdate(productUpdates).catch(() => {});
    }

    for (const kw of keywords) {
      const entityId = kw.keyword_id || kw.id;
      if (!entityId) continue;

      // Pular keywords que já receberam ação de estoque neste ciclo
      if (entityChangedThisCycle.has(entityId)) continue;

      const resolvedAsin = kw.asin || campaignAsinMap.get(kw.campaign_id) || null;
      if (!resolvedAsin) continue;

      const adMetrics = adMetricsByAsin.get(resolvedAsin);
      if (!adMetrics) continue;

      // Meta por produto (dinâmica) com fallback para global
      const effectiveTargetAcos = acosByAsin.get(resolvedAsin) ?? globalTargetAcos;
      if (effectiveTargetAcos <= 0) continue;

      // ACoS calculado na janela 14d (escopo MRC primário) — cliques líquidos pós-GIVT/SIVT
      const acos14d = adMetrics.sales > 0 ? (adMetrics.spend / adMetrics.sales) * 100 : null;
      const ctr14d = adMetrics.impressions > 0 ? adMetrics.clicks / adMetrics.impressions : 0;
      const cvr14d = adMetrics.clicks > 0 ? (adMetrics.orders || 0) / adMetrics.clicks : 0;

      const entityData = {
        current_bid: kw.current_bid || kw.bid || 0.25,
        // Janela MRC 14d (campos renomeados para clareza)
        acos_14d: acos14d,
        spend_14d: adMetrics.spend,
        sales_14d: adMetrics.sales,
        clicks_14d: adMetrics.clicks,
        orders_14d: adMetrics.orders || 0,
        impressions_14d: adMetrics.impressions,
        ctr_14d: ctr14d,
        cvr_14d: cvr14d,
        target_acos: effectiveTargetAcos,
        // Compatibilidade com regras externas que ainda usam campos 30d
        acos_30d: acos14d,
        spend_30d: adMetrics.spend,
        sales_30d: adMetrics.sales,
        clicks_30d: adMetrics.clicks,
      };

      for (const ar of ACOS_RULES) {
        if (!ar.matches(entityData)) continue;

        // Guardrail sazonal para boost
        if (ar.is_boost) {
          if (seasonalCtx.is_low_demand) continue;
          const product = productMap.get(resolvedAsin);
          if (seasonalCtx.is_holiday && !salesMetricsByAsin.get(resolvedAsin)?.has_real_sales) continue;
          if (product?.inventory_status === 'out_of_stock') continue;
        }

        // Cooldown
        const lastExecAR = lastExecByRuleEntity.get(`${ar.rule_key}|${entityId}`);
        if (lastExecAR) {
          const lastTs = lastExecAR.created_date || lastExecAR.executed_at;
          if (lastTs && (Date.now() - new Date(lastTs).getTime()) / 3600000 < ar.cooldown_hours) continue;
        }

        const iKey = `acos|${aid}|${ar.rule_key}|${entityId}|${today}`;
        if (usedIdemKeys.has(iKey)) continue;

        const newBid = ar.action(entityData);
        const isDynamic = acosByAsin.has(resolvedAsin);
        actionsToEnqueue.push({
          amazon_account_id: aid,
          correlation_id: correlationId,
          rule_key: ar.rule_key,
          rule_version: 1,
          entity_type: 'keyword',
          entity_id: entityId,
          campaign_id: kw.campaign_id,
          keyword_id: kw.keyword_id,
          asin: resolvedAsin,
          action_type: 'set_bid',
          value_before: entityData.current_bid,
          value_after: newBid,
          idempotency_key: iKey,
          status: 'pending',
          seasonal_context: seasonalPayload,
          reason: ar.reason_fn(entityData) + (isDynamic ? ` [meta dinâmica por produto: ${effectiveTargetAcos}%]` : ' [meta global]'),
        });
        entityChangedThisCycle.set(entityId, ar.rule_key);
        stats.acos_rules_applied++;
        stats.enqueued++;
        break; // uma regra de ACoS por keyword por ciclo
      }
    }

    // ── 7c. Regras externas do banco de dados (opcional — roda mesmo se vazio) ──
    for (const rule of activeRules) {
      const entities = scopedEntities[rule.scope] || [];

      for (const entity of entities) {
        stats.evaluated++;
        const entityId = entity.keyword_id || entity.campaign_id || entity.id;
        if (!entityId) continue;

        const resolvedAsinEarly = entity.asin || campaignAsinMap.get(entity.campaign_id) || null;
        const product = resolvedAsinEarly ? productMap.get(resolvedAsinEarly) : null;
        const isOutOfStock = product?.inventory_status === 'out_of_stock';

        // Guardrail estoque
        if (isOutOfStock && ['increase_bid_percent', 'activate_campaign', 'activate_keyword', 'create_exact_keyword'].includes(rule.action.type)) {
          stats.skipped_stock++;
          continue;
        }

        // Enriquecer com métricas reais de pedidos do SP-API (SalesDaily)
        // Resolver ASIN da keyword: campo direto ou via campaign_id
        const resolvedAsin = entity.asin || campaignAsinMap.get(entity.campaign_id) || null;
        const realSales = resolvedAsin ? (salesMetricsByAsin.get(resolvedAsin) || {}) : {};

        // TACoS em cascata: ASIN direto → campanha → conta
        const tacosValue = realSales.real_tacos_pct !== undefined && realSales.real_tacos_pct !== null
          ? realSales.real_tacos_pct
          : (tacosByCampaignId.get(entity.campaign_id) ?? accountTacos ?? null);

        const stockQty = product?.fba_inventory || 0;
        const realUnits30d = realSales.real_units_30d || 0;
        // Velocidade de venda: unidades vendidas por dia (últimos 30d)
        const stockVelocity = realUnits30d / 30;
        // Dias de cobertura: com o estoque atual, quantos dias durariam as vendas
        const stockCoverageDays = stockVelocity > 0 ? stockQty / stockVelocity : 999;

        // Métricas da keyword agregadas na janela 14d do ASIN (cliques líquidos pós-GIVT/SIVT)
        const asinAdMetrics14d = adMetricsByAsin.get(resolvedAsin || '') || null;
        const entityData = {
          ...entity,
          current_bid: entity.current_bid || entity.bid || 0.25,
          current_budget: entity.daily_budget || 0,
          stock: stockQty,
          stock_days: stockCoverageDays,
          // Métricas reais de faturamento (SP-API Orders)
          real_revenue_30d: realSales.real_revenue_30d || 0,
          real_units_30d: realUnits30d,
          real_orders_30d: realSales.real_orders_30d || 0,
          real_avg_ticket: realSales.real_avg_ticket || 0,
          real_revenue_per_day: realSales.real_revenue_per_day || 0,
          has_real_sales: realSales.has_real_sales || false,
          real_tacos_pct: tacosValue,
          ads_spend_30d: realSales.ads_spend_30d || 0,
          stock_velocity: stockVelocity,
          stock_coverage_days: stockCoverageDays,
          // acos da keyword (próprio da entidade keyword)
          acos: entity.acos || (entity.spend > 0 && entity.sales > 0 ? entity.spend / entity.sales * 100 : 0),
          // Métricas janela 14d (Metodologia MRC — cliques líquidos, atribuição primária SP)
          clicks_14d: asinAdMetrics14d?.clicks || 0,
          impressions_14d: asinAdMetrics14d?.impressions || 0,
          spend_14d: asinAdMetrics14d?.spend || 0,
          sales_14d: asinAdMetrics14d?.sales || 0,
          orders_14d: asinAdMetrics14d?.orders || 0,
          acos_14d: asinAdMetrics14d?.sales > 0 ? (asinAdMetrics14d.spend / asinAdMetrics14d.sales) * 100 : null,
          ctr_14d: asinAdMetrics14d?.impressions > 0 ? asinAdMetrics14d.clicks / asinAdMetrics14d.impressions : 0,
          cvr_14d: asinAdMetrics14d?.clicks > 0 ? (asinAdMetrics14d.orders || 0) / asinAdMetrics14d.clicks : 0,
          // Métricas unificadas (Unified Reports) — disponíveis se conta tem acesso
          ...(() => {
            const u = unifiedByCampaign.get(entity.campaign_id) || null;
            return {
              unified_impression_share: u?.avg_impression_share || 0,
              unified_top_of_search: u?.avg_top_of_search || 0,
              unified_invalid_click_rate: u?.avg_invalid_click_rate || 0,
              unified_halo_purchases: u?.halo_purchases || 0,
              unified_promoted_sales: u?.promoted_sales || 0,
              unified_budget_at_risk: u?.budget_at_risk || false,
            };
          })(),
        };

        if (!entityMatchesRule(rule, entityData)) continue;
        stats.matched++;

        // Guardrail sazonal — apenas para ações de aumento
        const isIncreaseAction = ['increase_bid_percent', 'redistribute_budget', 'activate_campaign', 'activate_keyword', 'create_exact_keyword', 'create_phrase_keyword', 'create_broad_keyword', 'create_campaign'].includes(rule.action.type);
        if (isIncreaseAction) {
          // Considerar vendas reais (SP-API) além de vendas de ads
          const hasSales = (entityData.sales || entityData.orders || 0) > 0 || entityData.has_real_sales;
          const hasStock = !isOutOfStock;
          const stockDays = product?.stock_days || null;
          if (seasonalBlocksIncrease(seasonalCtx, weekendCtx, hasSales, hasStock, stockDays)) {
            stats.skipped_seasonal++;
            continue;
          }
        }

        // Guardrail cooldown — usa created_date com fallback para executed_at
        const lastExec = lastExecByRuleEntity.get(`${rule.rule_key}|${entityId}`);
        if (lastExec) {
          const lastTs = lastExec.created_date || lastExec.executed_at;
          if (lastTs) {
            const hoursAgo = (Date.now() - new Date(lastTs).getTime()) / 3600000;
            if (hoursAgo < (rule.cooldown_hours || 72)) {
              stats.skipped_cooldown++;
              continue;
            }
          }
        }

        // Resolver conflito com ação já agendada para esta entidade
        const existingRuleKey = entityChangedThisCycle.get(entityId);
        if (existingRuleKey) {
          const existingRule = activeRules.find(r => r.rule_key === existingRuleKey);
          if (existingRule) {
            const resolution = resolveRuleConflicts(existingRule, rule);
            conflicts.push({
              amazon_account_id: aid,
              correlation_id: correlationId,
              rule_key_a: existingRule.rule_key,
              rule_key_b: rule.rule_key,
              entity_id: entityId,
              resolution: `execute:${resolution.execute.rule_key}`,
              rule_executed: resolution.execute.rule_key,
              rule_skipped: resolution.skip.rule_key,
              resolved_at: now,
            });
            if (resolution.execute.rule_key !== rule.rule_key) continue;
          }
        }

        const newValue = calculateActionValue(rule, entityData, settings);
        const iKey = `det|${aid}|${rule.rule_key}|${entityId}|${today}`;
        if (usedIdemKeys.has(iKey)) { stats.skipped_dup++; continue; }

        if (rule.action.type === 'redistribute_budget' && totalActiveBudget > settings.daily_budget_cap) continue;

        actionsToEnqueue.push({
          amazon_account_id: aid,
          correlation_id: correlationId,
          rule_key: rule.rule_key,
          rule_version: rule.version || 1,
          entity_type: rule.scope,
          entity_id: entityId,
          campaign_id: entity.campaign_id,
          keyword_id: entity.keyword_id,
          asin: entity.asin,
          action_type: rule.action.type,
          value_before: entityData.current_bid || entityData.current_budget || 0,
          value_after: newValue,
          idempotency_key: iKey,
          status: 'pending',
          seasonal_context: seasonalPayload,
          // Métricas reais de faturamento registradas junto à ação
          real_revenue_30d: entityData.real_revenue_30d || 0,
          real_tacos_pct: entityData.real_tacos_pct,
          has_real_sales: entityData.has_real_sales,
        });
        entityChangedThisCycle.set(entityId, rule.rule_key);
        stats.enqueued++;
      }
    }

    // ── 8. Gravar ─────────────────────────────────────────────────────────
    for (const c of conflicts.slice(0, 50)) {
      await base44.asServiceRole.entities.RuleConflict.create(c).catch(() => {});
    }
    for (let i = 0; i < actionsToEnqueue.length; i += 50) {
      await base44.asServiceRole.entities.RuleExecution.bulkCreate(actionsToEnqueue.slice(i, i + 50));
    }

    return Response.json({
      ok: true,
      correlationId,
      active_rules: activeRules.length,
      data_age_hours: Math.round(dataAge),
      total_active_budget: Math.round(totalActiveBudget * 100) / 100,
      suggested_total_budget: suggestedTotalBudget,
      budget_within_limits: totalActiveBudget <= settings.daily_budget_cap,
      performance_settings: {
        source: settings.settings_source,
        target_acos: settings.target_acos,
        max_acos: settings.max_acos,
        target_roas: settings.target_roas,
        target_tacos: settings.target_tacos,
        daily_budget_cap: settings.daily_budget_cap,
        min_bid: settings.min_bid,
        max_bid: settings.max_bid,
        max_bid_increase_percent: settings.max_bid_increase_percent,
        max_bid_decrease_percent: settings.max_bid_decrease_percent,
        enforce_max_cpc: settings.enforce_max_cpc,
        max_cpc: settings.max_cpc,
      },
      seasonal_context: { event: seasonalCtx.seasonal_event_name, demand: seasonalCtx.expected_demand_level, is_weekend: seasonalCtx.is_weekend },
      sales_daily_enrichment: { asins_with_real_sales: salesMetricsByAsin.size, records_loaded: salesDailyRaw.length },
      stock_rules: { applied: stats.stock_rules_applied },
      acos_rules: {
        applied: stats.acos_rules_applied,
        target_acos_global: globalTargetAcos,
        target_acos_source: acosTargetSource,
        dynamic_targets_calculated: acosByAsin.size,
        product_targets_updated: productUpdates.length,
        sample_targets: Array.from(acosByAsin.entries()).slice(0, 5).map(([asin, t]) => ({ asin, target_acos: t })),
      },
      // Diagnóstico de qualidade de dados (Metodologia MRC/Amazon Ads)
      mrc_data_quality: {
        click_type: 'net_valid_clicks_post_givt_sivt', // API retorna sempre cliques líquidos
        attribution_window_days: ATTRIBUTION_WINDOW_DAYS,
        data_stable_after_days: DATA_STABLE_DAYS,
        data_within_14d_window: dataWithin14dWindow,
        latest_metric_date: latestMetricDate,
        metric_data_age_days: Math.round(metricDataAge * 10) / 10,
        min_clicks_threshold: MIN_CLICKS_FOR_DECISION,
        min_impressions_threshold: MIN_IMPRESSIONS_FOR_DECISION,
        min_ctr_quality: MIN_CTR_QUALITY,
        note: metricDataAge > DATA_STABLE_DAYS
          ? 'Dados fora da janela revisável (>30d) — considerados finais pela Amazon'
          : 'Dados dentro da janela revisável SIVT — podem sofrer pequenos ajustes retroativos',
      },
      stats,
      conflicts_resolved: conflicts.length,
      actions_enqueued: actionsToEnqueue.length,
      unified_enrichment: {
        campaigns_with_unified_data: unifiedByCampaign.size,
        records_loaded: unifiedRaw.length,
      },
    });

  } catch (error) {
    console.error('[runDeterministicDecisionEngine]', error.message);
    return Response.json({ ok: false, error: error.message, correlationId }, { status: 500 });
  }
});