// ═══════════════════════════════════════════════════════════════════════════
// OBJETIVOS ESTRATÉGICOS — presets de metas de performance
// Cada preset define os campos que serão sobrescritos ao aplicar o objetivo.
// Campos ausentes mantêm o valor atual do usuário.
// ═══════════════════════════════════════════════════════════════════════════

export const OBJECTIVE_PRESETS = {
  profitability: {
    label: 'Lucratividade',
    tagline: 'Reduzir ACoS e maximizar margem',
    icon: 'PiggyBank',
    daypartingNote: 'Dayparting com redução em horários ruins',
    values: {
      target_acos: 10, max_acos: 15, target_tacos: 5, max_tacos: 10,
      max_bid: 2, max_bid_increase_pct: 10, max_bid_decrease_pct: 25,
      dayparting_enabled: true, pacing_enabled: true, placement_optimization_enabled: true,
      top_of_search_limit: 20, impressions_goal_enabled: false, target_daily_impressions: 0,
    },
  },
  growth: {
    label: 'Crescimento',
    tagline: 'Aumentar vendas com ACoS controlado',
    icon: 'TrendingUp',
    daypartingNote: 'Dayparting com redução moderada',
    values: {
      target_acos: 18, max_acos: 25, target_tacos: 8, max_tacos: 12,
      max_bid: 3, max_bid_increase_pct: 20, max_bid_decrease_pct: 20,
      dayparting_enabled: true, pacing_enabled: true, placement_optimization_enabled: true,
      top_of_search_limit: 40, impressions_goal_enabled: false, target_daily_impressions: 0,
    },
  },
  launch: {
    label: 'Lançamento',
    tagline: 'Visibilidade máxima e primeira página',
    icon: 'Rocket',
    daypartingNote: 'Dayparting com pausas fora de pico',
    values: {
      target_acos: 30, max_acos: 50, target_tacos: 15, max_tacos: 25,
      max_bid: 4, max_bid_increase_pct: 30, max_bid_decrease_pct: 10,
      dayparting_enabled: true, pacing_enabled: true, placement_optimization_enabled: true,
      top_of_search_limit: 60, impressions_goal_enabled: true, target_daily_impressions: 5000,
    },
  },
  defense: {
    label: 'Defesa',
    tagline: 'Proteger posição e marca',
    icon: 'Shield',
    daypartingNote: 'Dayparting em manutenção, sem grandes cortes',
    values: {
      target_acos: 12, max_acos: 18,
      max_bid: 2.5, max_bid_increase_pct: 15, max_bid_decrease_pct: 15,
      dayparting_enabled: true, pacing_enabled: true, placement_optimization_enabled: true,
      top_of_search_limit: 50, impressions_goal_enabled: false,
    },
  },
  liquidation: {
    label: 'Liquidação',
    tagline: 'Girar estoque rapidamente',
    icon: 'PackageX',
    daypartingNote: 'Dayparting desativado',
    values: {
      target_acos: 40, max_acos: 70,
      max_bid: 1.5, max_bid_increase_pct: 5, max_bid_decrease_pct: 10,
      dayparting_enabled: false, pacing_enabled: false, placement_optimization_enabled: true,
      top_of_search_limit: 30, rest_of_search_limit: 30, product_page_limit: 30,
      impressions_goal_enabled: false,
    },
  },
  maintenance: {
    label: 'Manutenção',
    tagline: 'Estabilizar sem mudanças agressivas',
    icon: 'Wrench',
    daypartingNote: 'Dayparting com redução leve apenas',
    values: {
      target_acos: 10, max_acos: 14,
      max_bid_increase_pct: 5, max_bid_decrease_pct: 10,
      dayparting_enabled: true, pacing_enabled: true, placement_optimization_enabled: true,
      top_of_search_limit: 15, impressions_goal_enabled: false,
    },
  },
  aggressive_peak: {
    label: 'Agressivo em Pico',
    tagline: 'Boost máximo no horário de pico',
    icon: 'Zap',
    daypartingNote: 'Dayparting com boost em pico e pausa nos piores horários',
    values: {
      target_acos: 20, max_acos: 30,
      max_bid: 5, max_bid_increase_pct: 30, max_bid_decrease_pct: 15,
      dayparting_enabled: true, pacing_enabled: true, placement_optimization_enabled: true,
      top_of_search_limit: 70, impressions_goal_enabled: false,
    },
  },
  flex_stock: {
    label: 'Flex por Estoque',
    tagline: 'Agressividade ajustada ao estoque',
    icon: 'Boxes',
    daypartingNote: 'Reduz bids em estoque baixo e pausa sem estoque',
    values: {
      target_acos: 15, max_acos: 22, max_bid: 3,
      dayparting_enabled: true, pacing_enabled: true, placement_optimization_enabled: true,
      impressions_goal_enabled: false,
    },
  },
  custom: {
    label: 'Personalizado',
    tagline: 'Valores definidos manualmente',
    icon: 'Pencil',
    daypartingNote: null,
    values: null,
  },
};

/** true quando algum campo de goals diverge do preset do objetivo base */
export function divergesFromPreset(goals) {
  const preset = OBJECTIVE_PRESETS[goals?.objective];
  if (!preset?.values) return false;
  return Object.entries(preset.values).some(([k, v]) => {
    return String(goals[k] ?? '') !== String(v ?? '');
  });
}

/** Avisos de coerência entre objetivo e metas — não bloqueiam o save */
export function getCoherenceWarnings(goals) {
  const w = [];
  const obj = goals?.objective;
  const acos = Number(goals?.target_acos || 0);
  if (obj === 'profitability' && acos > 20) w.push('ACoS alvo acima de 20% é incomum para Lucratividade.');
  if (obj === 'maintenance' && acos > 20) w.push('ACoS alvo acima de 20% é incomum para Manutenção.');
  if (obj === 'launch' && acos > 0 && acos < 8) w.push('ACoS alvo abaixo de 8% é incomum para Lançamento.');
  if (obj === 'liquidation' && acos > 0 && acos < 15) w.push('ACoS alvo abaixo de 15% é incomum para Liquidação.');
  if (obj === 'liquidation' && goals?.pacing_enabled) w.push('Pacing normalmente fica desativado em Liquidação.');
  if (obj === 'maintenance' && Number(goals?.max_bid_increase_pct || 0) > 10) w.push('Aumentos de bid acima de 10% são incomuns em Manutenção.');
  if (obj === 'aggressive_peak' && !goals?.dayparting_enabled) w.push('Agressivo em Pico depende do Dayparting ativo.');
  if (Number(goals?.max_acos || 0) > 0 && Number(goals?.max_acos) < acos) w.push('ACoS máximo não pode ficar abaixo da meta de eficiência; será ajustado ao salvar.');
  if (Number(goals?.max_tacos || 0) > 0 && Number(goals?.max_tacos) < Number(goals?.target_tacos || 0)) w.push('TACoS máximo não pode ficar abaixo do TACoS alvo; será ajustado ao salvar.');
  if (Number(goals?.min_bid || 0) > Number(goals?.max_bid || 0)) w.push('Bid mínimo não pode superar o teto de lance; será ajustado ao salvar.');
  if (Number(goals?.target_cpc || 0) > Number(goals?.max_bid || 0)) w.push('CPC alvo não pode superar o teto de lance; será ajustado ao salvar.');
  return w;
}
