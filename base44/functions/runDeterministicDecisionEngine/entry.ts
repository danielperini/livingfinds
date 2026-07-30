/**
 * runDeterministicDecisionEngine â€” Motor EstratÃ©gico Unificado v6
 *
 * FILOSOFIA v6:
 *   Busca simultÃ¢nea de: lucro sustentÃ¡vel, crescimento de vendas, visibilidade,
 *   impression share, proteÃ§Ã£o de margem, distribuiÃ§Ã£o de orÃ§amento, expansÃ£o de
 *   vencedores e reduÃ§Ã£o de desperdÃ­cio.
 *
 *   Dados econÃ´micos funcionam como: limite Â· proteÃ§Ã£o Â· fator de intensidade Â·
 *   prioridade Â· indicador de risco â€” NÃƒO como bloqueio absoluto ao crescimento.
 *
 * NOVIDADES v6 vs v5:
 *   - Estados de oportunidade: low_visibility / emerging_opportunity /
 *     profitable_opportunity / high_growth_opportunity / budget_constrained /
 *     visibility_constrained / conversion_constrained / insufficient_data / no_opportunity
 *   - visibility_score (0â€“1) e visibility_opportunity_score
 *   - growth_tolerance_factor (1.05 padrÃ£o): permite teste atÃ© 5% alÃ©m do limite
 *   - Custo parcial nÃ£o bloqueia â€” permite aumento conservador (â‰¤5%)
 *   - CenÃ¡rios Aâ€“E de crescimento com intensidade graduada
 *   - simulate_growth: projeta CPA/ACoS esperado antes de aplicar
 *   - last_growth_action_at / growth_cooldown_until / growth_evaluation_due_at
 *   - Novos rule_keys de crescimento e novos decision_type labels
 *   - low_visibility â‰  low_performance (distinÃ§Ã£o explÃ­cita)
 *   - Aumento de budget para campanhas limitadas por orÃ§amento
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { runImmediateBudgetRescue } from '../../shared/immediateBudgetRescue.ts';
import { calculateInventoryCoverage, calculateObservedWindowDays } from '../../shared/decisionMetrics.ts';
import {
  assessNoConversionEvidence,
  calculateExpectedClicksPerOrder,
  calculateMaximumEconomicCpc,
} from '../../shared/bidDecisionEvidence.ts';
import {
  calculateSmoothedSameSkuCvr,
} from '../../shared/skuEconomicGuard.ts';

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// HIERARQUIA CANÃ”NICA DE DECISÃƒO v7
// P1: SeguranÃ§a (token, dados, estoque, listing, estrutura)
// P2: ProteÃ§Ã£o de Rentabilidade (ACoS, margem, lucro pÃ³s-ads, winners)
// P3: Meta Principal ACoS 10â€“15%
//     <10%: preservar eficiÃªncia, nÃ£o forÃ§ar escala
//     10â€“15%: zona ideal, manter
//     15â€“break-even: reduÃ§Ã£o gradual
//     >break-even: reduzir ou pausar entidade especÃ­fica
// P4: Crescimento (somente apÃ³s P2)
// P5: Visibilidade (somente se nÃ£o comprometer ACoS)
// P6: ExperimentaÃ§Ã£o
//
// GUARDRAILS DETERMINÃSTICOS (executados antes de qualquer lote de pausas):
//   account_campaign_floor_guardrail: nunca zerar campanhas se hÃ¡ estoque
//   pause_batch_guard: >30% exige force_batch=true; >50% bloqueia
//   winner_protection: orders_14d>0 AND acos_14d<=target â†’ nunca pausar
//   stale_decision_guard: revalidar decisÃµes obsoletas antes de executar
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// â”€â”€ Guardrail: zero campanhas â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function checkZeroCampaignGuard(
  planned_pauses: any[],
  all_campaigns: any[],
  products: any[],
  force_batch = false,
): { allowed: boolean; reason: string } {
  const active = all_campaigns.filter(c => {
    const s = String(c.state || c.status || '').toLowerCase();
    return s === 'enabled';
  }).length;

  if (active === 0) return { allowed: true, reason: 'no_active_campaigns' }; // nada para proteger

  const activeAfter = active - planned_pauses.length;
  const hasStock = products.some((p: any) => Number(p.fba_inventory || 0) > 0);

  if (activeAfter <= 0 && hasStock) {
    return { allowed: false, reason: `ZERO_CAMPAIGN_GUARD: pausar ${planned_pauses.length} reduziria ativas de ${active} para ${activeAfter}. Estoque presente â€” bloqueado.` };
  }

  const pct = active > 0 ? planned_pauses.length / active : 0;
  if (pct > 0.50) {
    return { allowed: false, reason: `BATCH_PAUSE_GUARD_50PCT: ${planned_pauses.length}/${active} (${Math.round(pct * 100)}%) excede 50% â€” bloqueado automaticamente.` };
  }
  if (pct > 0.30 && !force_batch) {
    return { allowed: false, reason: `BATCH_PAUSE_GUARD_30PCT: ${planned_pauses.length}/${active} (${Math.round(pct * 100)}%) excede 30% â€” requer force_batch=true.` };
  }

  return { allowed: true, reason: 'ok' };
}

// â”€â”€ Guardrail: winner protection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function checkWinnerProtection(params: {
  orders_14d: number;
  acos_14d: number | null;
  target_acos: number | null;
  orders_30d?: number;
  roas_30d?: number;
  target_roas?: number;
  last_sale_at?: string | null;
  protected_high_performance?: boolean;
  recent_sale_protection_hours: number;
}): { protected: boolean; reason: string } {
  const {
    orders_14d, acos_14d, target_acos,
    orders_30d = 0, roas_30d = 0, target_roas = 0,
    last_sale_at, protected_high_performance = false,
    recent_sale_protection_hours,
  } = params;

  if (protected_high_performance) return { protected: true, reason: 'protected_high_performance_flag' };

  if (orders_14d > 0 && acos_14d !== null && target_acos !== null && acos_14d <= target_acos) {
    return { protected: true, reason: `winner_14d: ${orders_14d}p, ACoS ${acos_14d.toFixed(1)}% â‰¤ meta ${target_acos}%` };
  }

  if ((orders_30d ?? 0) >= 2 && target_roas > 0 && roas_30d >= target_roas) {
    return { protected: true, reason: `winner_30d: ${orders_30d}p/30d, ROAS ${roas_30d.toFixed(2)}x â‰¥ meta` };
  }

  if (last_sale_at) {
    const hoursAgo = (Date.now() - new Date(last_sale_at).getTime()) / 3600000;
    if (hoursAgo <= recent_sale_protection_hours) {
      return { protected: true, reason: `recent_sale: Ãºltima venda hÃ¡ ${hoursAgo.toFixed(1)}h (proteÃ§Ã£o ${recent_sale_protection_hours}h)` };
    }
  }

  return { protected: false, reason: 'no_winner_criteria_met' };
}

// â”€â”€ Fallbacks do sistema â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const FB = {
  MIN_BID: 0.25, MAX_BID: 0.70,
  MAX_INCREASE_PCT: 0.10, MAX_DECREASE_PCT: 0.25,
  DAILY_BUDGET_CAP: 56,
  TARGET_ACOS: 10, MAX_ACOS: 15,
  TARGET_ROAS: 4, TARGET_TACOS: 5,
  SAFETY_FACTOR: 0.80,
  MIN_CONFIDENCE: 0.95,
  MIN_RELEVANCE: 0.95,
  COOLDOWN_HOURS: 48,               // bid_change_cooldown_hours = 48
  MATURATION_HOURS: 72,
  MIN_STOCK_DAYS: 7,
  // v6
  GROWTH_TOLERANCE_FACTOR: 1.05,
  MAX_GROWTH_FACTOR: 1.10,
  PARTIAL_COST_MAX_INCREASE: 0.05,
  GROWTH_COOLDOWN_HOURS: 48,        // alinhado ao bid_change_cooldown_hours
  // Sem vendas â€” revisÃ£o e pausa
  NO_SALES_FIRST_REVIEW_HOURS: 7 * 24,
  NO_SALES_SECOND_REVIEW_DAYS: 10,
  NO_SALES_CAMPAIGN_PAUSE_DAYS: 14,
  NEW_PRODUCT_MAX_LEARNING_DAYS: 14,
  // Zero impressÃµes
  ZERO_IMP_FIRST_REVIEW_HOURS: 7 * 24,
  ZERO_IMP_KEYWORD_PAUSE_DAYS: 15,
  ZERO_IMP_CAMPAIGN_PAUSE_DAYS: 21,
  // Baixas impressÃµes
  LOW_IMP_REVIEW_DAYS: 7,
  LOW_IMP_SECOND_REVIEW_DAYS: 14,
  LOW_IMP_KEYWORD_PAUSE_DAYS: 21,
  // EvidÃªncia mÃ­nima antes de pausar/agir
  MIN_CLICKS_BEFORE_PAUSE: 20,      // minimum_clicks_before_pause = 20
  MIN_CLICKS_FIRST_REVIEW: 10,      // minimum_clicks_first_review = 10
  MIN_CLICKS_SECOND_REVIEW: 15,     // minimum_clicks_second_review = 15
  MIN_IMP_BEFORE_PAUSE: 200,        // minimum_impressions_before_pause = 200
  // Thresholds de impressÃµes por janela
  LOW_IMP_THRESHOLD_7D: 50,         // low_impressions_threshold_7d = 50
  LOW_IMP_THRESHOLD_14D: 150,       // low_impressions_threshold_14d = 150
  // Freshness e proteÃ§Ã£o
  MIN_DATA_FRESHNESS_HOURS: 36,     // minimum_data_freshness_hours = 36
  RECENT_SALE_PROTECTION_HOURS: 72, // recent_sale_protection_hours = 72
  WINNER_PROTECTION_ENABLED: true,  // winner_protection_enabled = true
  PAUSE_MOST_SPECIFIC_FIRST: true,  // pause_most_specific_entity_first = true
};

// â”€â”€ MRC â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const MRC = {
  MIN_CLICKS: 20,                    // minimum_clicks_before_pause = 20
  MIN_IMPRESSIONS: 200,              // minimum_impressions_before_pause = 200
  MIN_SPEND: 12.0,                   // fallback; runtime usa maximum_profitable_cpa quando disponÃ­vel
  MIN_CTR: 0.0005,
  ATTRIBUTION_WINDOW: 14,
  DATA_STABLE_DAYS: 30,
  DATA_STALE_HOURS: 36,              // minimum_data_freshness_hours = 36
  LOW_VISIBILITY_IMPRESSIONS: 50,   // = low_impressions_threshold_7d
  LOW_IMPRESSION_SHARE: 0.05,
};

// â”€â”€ Hierarquia de prioridade â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const PRIORITY = {
  account_security: 1, data_quality: 2, stock: 3, offer_availability: 4,
  margin: 5, profit_erosion: 5, budget_global: 6, protect_high_performance: 7,
  waste_reduction: 8, maintenance: 9,
  // v6 novos â€” crescimento tem menos prioridade que proteÃ§Ã£o mas mais que manutenÃ§Ã£o
  low_visibility_growth: 9, emerging_growth: 10, profitable_growth: 10,
  scale: 10, budget_increase: 10, high_growth: 11, expansion: 11, create_campaign: 12,
};

// â”€â”€ Opportunity states â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
type OpportunityState =
  | 'no_opportunity' | 'insufficient_data' | 'low_visibility'
  | 'emerging_opportunity' | 'profitable_opportunity' | 'high_growth_opportunity'
  | 'budget_constrained' | 'visibility_constrained' | 'conversion_constrained';

// â”€â”€ Incrementos graduados por confianÃ§a â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function getGrowthIncrement(confidence: 'low' | 'moderate' | 'high' | 'very_high' | 'exceptional'): number {
  return { low: 0.03, moderate: 0.05, high: 0.08, very_high: 0.10, exceptional: 0.15 }[confidence];
}

// â”€â”€ Calcular visibility score (0â€“1) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function calcVisibilityScore(params: {
  impressions_14d: number;
  impressions_30d: number;
  trend_3_vs_14: number; // positivo = crescendo
  cvr: number;
  stock_days: number;
  is_active: boolean;
  budget_consumed_pct: number; // 0â€“1
}): {
  visibility_score: number;
  visibility_status: 'very_low' | 'low' | 'moderate' | 'good' | 'high';
  is_low_visibility: boolean;
  trend_impressions: 'growing' | 'stable' | 'declining';
} {
  const { impressions_14d, impressions_30d, trend_3_vs_14, cvr, stock_days, is_active, budget_consumed_pct } = params;

  if (!is_active || stock_days <= 0) {
    return { visibility_score: 0, visibility_status: 'very_low', is_low_visibility: true, trend_impressions: 'stable' };
  }

  // Volume atual vs histÃ³rico (normalizado)
  const imp_norm = Math.min(1, impressions_14d / 5000); // 5000 impr/14d = mÃ¡ximo de referÃªncia
  // Trend
  const trend_score = trend_3_vs_14 > 0.10 ? 1.0 : trend_3_vs_14 > 0 ? 0.7 : trend_3_vs_14 > -0.10 ? 0.5 : 0.2;
  // CVR signal
  const cvr_score = cvr > 0.05 ? 1.0 : cvr > 0.02 ? 0.7 : cvr > 0 ? 0.4 : 0.2;
  // Budget nÃ£o saturado = oportunidade
  const budget_score = budget_consumed_pct < 0.95 ? 1.0 : 0.3;
  // Estoque
  const stock_score = stock_days >= 21 ? 1.0 : stock_days >= 7 ? 0.6 : 0.2;

  const visibility_score = Math.round(
    (imp_norm * 0.35 + trend_score * 0.25 + cvr_score * 0.20 + budget_score * 0.10 + stock_score * 0.10) * 100
  ) / 100;

  const status = visibility_score < 0.20 ? 'very_low'
    : visibility_score < 0.40 ? 'low'
    : visibility_score < 0.60 ? 'moderate'
    : visibility_score < 0.80 ? 'good' : 'high';

  const trend_impressions = trend_3_vs_14 > 0.05 ? 'growing' : trend_3_vs_14 < -0.05 ? 'declining' : 'stable';

  return {
    visibility_score,
    visibility_status: status,
    is_low_visibility: impressions_14d < MRC.LOW_VISIBILITY_IMPRESSIONS || status === 'very_low' || status === 'low',
    trend_impressions,
  };
}

// â”€â”€ Calcular opportunity score â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function calcOpportunityScore(params: {
  visibility_score: number;
  cvr: number;
  has_sales: boolean;
  acos_14d: number | null;
  target_acos: number | null;
  profit_protection_mode: string;
  stock_days: number;
  economic_confidence: 'complete' | 'partial' | 'none';
  impression_share: number; // 0â€“1, estimado
  cpc: number;
  safe_max_cpc: number;
  data_freshness: string;
}): {
  opportunity_score: number;
  opportunity_state: OpportunityState;
  growth_confidence: 'low' | 'moderate' | 'high' | 'very_high' | 'exceptional';
  can_grow: boolean;
  block_reason: string;
} {
  const {
    visibility_score, cvr, has_sales, acos_14d, target_acos, profit_protection_mode,
    stock_days, economic_confidence, impression_share, cpc, safe_max_cpc, data_freshness,
  } = params;

  // Hard blocks
  if (stock_days <= 0) return { opportunity_score: 0, opportunity_state: 'no_opportunity', growth_confidence: 'low', can_grow: false, block_reason: 'estoque_zero' };
  if (profit_protection_mode === 'paused') return { opportunity_score: 0, opportunity_state: 'no_opportunity', growth_confidence: 'low', can_grow: false, block_reason: 'lucro_negativo_confirmado' };
  if (data_freshness === 'stale') return { opportunity_score: 0, opportunity_state: 'insufficient_data', growth_confidence: 'low', can_grow: false, block_reason: 'dados_desatualizados' };

  // CPC acima do tolerado
  const cpc_ok = safe_max_cpc <= 0 || cpc <= safe_max_cpc * FB.GROWTH_TOLERANCE_FACTOR;
  if (!cpc_ok) return { opportunity_score: 0.1, opportunity_state: 'no_opportunity', growth_confidence: 'low', can_grow: false, block_reason: 'cpc_acima_do_limite' };

  // Lucro em erosÃ£o (defensive): crescimento conservador permitido
  const in_defensive = profit_protection_mode === 'defensive';
  const in_vigilant ß®¼öÚ$z{-®éÜj×–åöÖ÷VçBÀĞ¢'&VµöWfVåö6÷3¢6–äÖWFòæ'&VµöWfVâÀĞ¢F&vWEö6÷3¢6–äÖWFòçF&vWBÀĞ¢&öf—EögFW%öG3¢6–äÖWFòç&öf—EögFW%öG5óFBÀĞ¢ÒÀĞ¢Ò’“°Ğ¢VçF—G”6†ævVEF†—47–6ÆRç6WB†VçF—G”–BÂ'VÆT¶W’“°Ğ¢7FG2æ&–Eö–æ7&V6R²³°Ğ¢ĞĞ¢ĞĞ Ğ¢òò)H)HRâÖ÷F÷"FR&VG\:|:6òFR6õ2÷"¶W—v÷&B†f—&RÖæBÖf÷&vWB’)H)H)H)H)H)H Ğ¢&6SCBæ56W'f–6U&öÆRægVæ7F–öç2æ–çfö¶R‚w'Vä6÷4&–E&VGV7F–öäVæv–æRrÂ°Ğ¢Ö¦öåö66÷VçEö–C¢–BÀĞ¢÷6W'f–6U÷&öÆS¢G'VRÀĞ¢6÷W&6UögVæ7F–öã¢w'VäFWFW&Ö–æ—7F–4FV6—6–öäVæv–æRrÀĞ¢Ò’æ6F6‚‚‚’Óâ·Ò“°Ğ Ğ¢òò)H)H"â”ÔÔTD”DUô%TDtUEõ$U45TR‡7V'7F—GV’6Vì:&–ò2’)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H Ğ¢òòW†V7WF6–æ7&öæÖVçFS¢VÖVçF÷,:vÖVçFòFR6×æ†25&VçL:fV—26öĞĞ¢òò(šS“RRFRWF–Æ—¦:|:6òf–'VFvWBW6vR’„6×–vâæ7W'&VçE÷7VæB’ÀĞ¢òò6öæf—&ÖæÖ¦öâçFW2FRGVÆ—¦"Æö6ÆÖVçFRâ6ööÆF÷vâ#F‚Â³#RÖ‚àĞ¢6öç7B6×–vä'VFvWDFV6—6–öç3¢ç•µÒÒµÓ²òòÖçF–Fòf¦–ò(	B&W67VRW†V7WFF—&WFÖVçFPĞ¢v—B'Vä–ÖÖVF–FT'VFvWE&W67VR‡°Ğ¢–BÂæ÷rÂFöF’Â6÷'&VÆF–öä–BÂ&6SCBÀĞ¢6×–vç2Â6×v–æF÷tÖWG&–72Â6÷4'”6–âÂ&öGV7DÖÂ6×–vä6–äÖÀĞ¢WF†÷&—¦VDVÆ–v–&ÆT6–ç2Â6WGF–æw2ÂFFg&W6†æW72ÀĞ¢W6VD–FVÔ¶W—2ÂVçF—G”6†ævVEF†—47–6ÆRÂ66÷VçBÂ7FG2ÀĞ¢Ò“°Ğ Ğ¢òò)H)H2âwV&G&–ÂvÆö&ÂFR÷,:vÖVçFò)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H Ğ¢–b†'VFvWDwV&G&–Ä7F—fR’°Ğ¢FV6—6–öç2æf÷$V6‚‚†C¢ç’’Óâ°Ğ¢–b‚†Bæ7F–öâÓÓÒw6WEö&–BrÇÂBæ7F–öâÓÓÒw6WEö'VFvWBr’bbBçfÇVUögFW"âBçfÇVUö&Vf÷&R’°Ğ¢Bæ&÷fÅ÷7FGW2Òv&Æö6¶VEö'VFvWEö6s°Ğ¢Bç&F–öæÆR³Ò´$ÄõTTDó¢v7Fò"BG·&VÅ7VæE–W7FW&F’çFôf—†VBƒ"—ÒW†6VFWR6"BG·6WGF–æw2æF–Ç•ö'VFvWEö6ÕÖ°Ğ¢ĞĞ¢Ò“°Ğ¢ĞĞ Ğ¢òò6öÖ&–æ"FV6—<;VW2‡&W67VR¬:W†V7WF÷RF—&WFÖVçFR(	Bì:6òVçG&æòÆÄFV6—6–öç2Ğ¢6öç7BÆÄFV6—6–öç2Ò²ââæFV6—6–öç2Âââæ6×–vä'VFvWDFV6—6–öç5Ó°Ğ Ğ¢òò)H)HBâ&–÷&—¦:|:6ò)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H Ğ¢6öç7B5Dô4µõ%TÄU2ÒæWr6WB…²w7Fö6µ÷¦W&òrÂw7Fö6µö7&—F–6ÂrÂw7Fö6µöÆ÷ruÒ“°Ğ¢ÆÄFV6—6–öç2ç6÷'B‚†¢ç’Â#¢ç’’Óâ°Ğ¢6öç7B—57Fö6²Ò5Dô4µõ%TÄU2æ†2†ç'VÆUö¶W’ÇÂrr“°Ğ¢6öç7B$—57Fö6²Ò5Dô4µõ%TÄU2æ†2†"ç'VÆUö¶W’ÇÂrr“°Ğ¢–b†—57Fö6²ÓÒ$—57Fö6²’&WGW&â—57Fö6²òÓ¢°Ğ¢–b†ç&–÷&—G’ÓÒ"ç&–÷&—G’’&WGW&âç&–÷&—G’Ò"ç&–÷&—G“°Ğ¢6öç7BF—2Òç7Fö6µö6÷fW&vUöF—2óò“““°Ğ¢6öç7B$F—2Ò"ç7Fö6µö6÷fW&vUöF—2óò“““°Ğ¢–b„ÖF‚æ'2†F—2Ò$F—2’â’&WGW&âF—2Ò$F—3°Ğ¢&WGW&â†"æFV6—6–öå÷&–÷&—G•÷66÷&RÇÂ’Ò†æFV6—6–öå÷&–÷&—G•÷66÷&RÇÂ“°Ğ¢Ò“°Ğ Ğ¢òò)H)Hâw&f"÷F–Ö—¦F–öäFV6—6–öâ)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H Ğ¢ÆWB6fVBÒ°Ğ¢f÷"†ÆWB’Ò²’ÂÆÄFV6—6–öç2æÆVæwFƒ²’³ÒS’°Ğ¢6öç7B&F6‚ÒÆÄFV6—6–öç2ç6Æ–6R†’Â’²S“°Ğ¢v—B&6SCBæ56W'f–6U&öÆRæVçF—F–W2ä÷F–Ö—¦F–öäFV6—6–öâæ'VÆ´7&VFR€Ğ¢&F6‚æÖ‚†C¢ç’’Óâ‡°Ğ¢Ö¦öåö66÷VçEö–C¢–BÀĞ¢'Våö–C¢6÷'&VÆF–öä–BÀĞ¢FV6—6–öå÷G—S¢BæFV6—6–öå÷G—RÇÂv&–Eö6†ævRrÀĞ¢VçF—G•÷G—S¢BæVçF—G•÷G—RÇÂv¶W—v÷&BrÀĞ¢VçF—G•ö–C¢BæVçF—G•ö–BÀĞ¢6×–våö–C¢Bæ6×–våö–BÀĞ¢¶W—v÷&Eö–C¢Bæ¶W—v÷&Eö–BÀĞ¢¶W—v÷&E÷FW‡C¢Bæ¶W—v÷&E÷FW‡BÀĞ¢6–ã¢Bæ6–âÀĞ¢7F–öã¢Bæ7F–öâÀĞ¢fÇVUö&Vf÷&S¢BçfÇVUö&Vf÷&RÀĞ¢fÇVUögFW#¢BçfÇVUögFW"ÀĞ¢&F–öæÆS¢Bç&F–öæÆRÀĞ¢&—6³¢Bç&—6²ÇÂvÖVF—VÒrÀĞ¢6öæf–FVæ6S¢Bæ6öæf–FVæ6RÇÂÖF‚ç&÷VæB‚†Bæ÷÷'GVæ—G•÷66÷&RÇÂãƒ’¢’ÀĞ¢7FGW3¢v&÷fVBrÀĞ¢&÷fÅ÷7FGW3¢Bæ&÷fÅ÷7FGW2ÇÂvWFõö&÷fVBrÀĞ¢WF÷–Æ÷EöWF†÷&—¦VC¢G'VRÀĞ¢&WV—&W5ö&÷fÃ¢fÇ6RÀĞ¢–FV×÷FVæ7•ö¶W“¢Bæ–FV×÷FVæ7•ö¶W’ÀĞ¢6÷W&6UögVæ7F–öã¢w'VäFWFW&Ö–æ—7F–4FV6—6–öäVæv–æU÷crrÀĞ¢7&VFVEöC¢æ÷rÀĞ¢6V&6…ö–çFVçE÷G—S¢Bç6V&6…ö–çFVçCòæ–çFVçE÷G—RÀĞ¢6V&6…ö–çFVçEö6ÇW7FW#¢Bç6V&6…ö–çFVçCòæ6ÇW7FW"ÀĞ¢W&6†6Uö–çFVçC¢Bç6V&6…ö–çFVçCòçW&6†6Uö–çFVçBÀĞ¢W&6†6Uö–çFVçE÷66÷&S¢Bç6V&6…ö–çFVçCòçW&6†6Uö–çFVçE÷66÷&RÀĞ¢6WGF–æw5÷6÷W&6S¢Bç6WGF–æw5÷6÷W&6RÀĞ¢FF÷VÆ—G“¢FFg&W6†æW72À¢7Fö6µö6÷fW&vUöF—3¢Bç7Fö6µö6÷fW&vUöF—2À¢7Fö6µö6÷fW&vU÷v—F…ö–æ&÷VæEöF—3¢Bç7Fö6µö6÷fW&vU÷v—F…ö–æ&÷VæEöF—2À¢7Fö6µ÷G“¢Bç7Fö6µ÷G’À¢7Fö6µö–æ&÷VæE÷G“¢Bç7Fö6µö–æ&÷VæE÷G’À¢7Fö6µ÷&W6W'fVE÷G“¢Bç7Fö6µ÷&W6W'fVE÷G’À¢7Fö6µ÷W&vVæ7“¢Bç7Fö6µ÷W&vVæ7’À¢6ÆW5÷fVÆö6—G•öF–Ç“¢Bç6ÆW5÷fVÆö6—G•öF–Ç’À¢–çfVçF÷'•÷6–væÅ÷VÆ—G“¢Bæ–çfVçF÷'•÷6–væÅ÷VÆ—G’À¢7W'&VçEö73¢Bæ7W'&VçEö72À¢Ö†–×VÕöV6öæöÖ–5ö73¢BæÖ†–×VÕöV6öæöÖ–5ö72À¢7W'&VçEö6÷3¢Bæ7W'&VçEö6÷2À¢F&vWEö6÷3¢BçF&vWEö6÷2À¢W‡V7FVEö6Æ–6·5÷W%ö÷&FW#¢BæW‡V7FVEö6Æ–6·5÷W%ö÷&FW"À¢æõö6öçfW'6–öåö6Æ–6µö×VÇF—ÆS¢Bææõö6öçfW'6–öåö6Æ–6µö×VÇF—ÆRÀ¢Ö†–×VÕö7V—6—F–öå÷7VæC¢BæÖ†–×VÕö7V—6—F–öå÷7VæBÀ¢FV6—6–öåö6öæf–FVæ6UöÆWfVÃ¢BæFV6—6–öåö6öæf–FVæ6UöÆWfVÂÀ¢æW‡E÷&Wf–WuöF—3¢BææW‡E÷&Wf–WuöF—2À¢Ò’¢’æ6F6‚‚‚’ÓâµÒ“°Ğ¢6fVB³Ò&F6‚æÆVæwFƒ°Ğ¢ĞĞ Ğ¢òò)H)H"âF—7&"W†V7\:|:6ò–ÖVF–F†f—&RÖæBÖf÷&vWB’)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H Ğ¢–b‡6fVBâ’°Ğ¢&6SCBæ56W'f–6U&öÆRægVæ7F–öç2æ–çfö¶R‚vW†V7WFT&÷fVDFV6—6–öåVWVRrÂ°Ğ¢Ö¦öåö66÷VçEö–C¢–BÀĞ¢÷6W'f–6U÷&öÆS¢G'VRÀĞ¢Ò’æ6F6‚‚‚’Óâ·Ò“°Ğ¢ĞĞ Ğ¢òò)H)H"â'VÆTW†V7WF–öâ†VF—F÷&–’)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H Ğ¢6öç7BVF—E&V6÷&G2ÒÆÄFV6—6–öç2ç6Æ–6RƒÂ’æÖ‚†C¢ç’’Óâ‡°Ğ¢Ö¦öåö66÷VçEö–C¢–BÀĞ¢6÷'&VÆF–öåö–C¢6÷'&VÆF–öä–BÀĞ¢'VÆUö¶W“¢Bç'VÆUö¶W’ÇÂBæFV6—6–öå÷G—RÀĞ¢'VÆU÷fW'6–öã¢bÀĞ¢VçF—G•÷G—S¢BæVçF—G•÷G—RÇÂv¶W—v÷&BrÀĞ¢VçF—G•ö–C¢BæVçF—G•ö–BÀĞ¢6×–våö–C¢Bæ6×–våö–BÀĞ¢¶W—v÷&Eö–C¢Bæ¶W—v÷&Eö–BÀĞ¢6–ã¢Bæ6–âÀĞ¢7F–öå÷G—S¢Bæ7F–öâÀĞ¢fÇVUö&Vf÷&S¢BçfÇVUö&Vf÷&RÀĞ¢fÇVUögFW#¢BçfÇVUögFW"ÀĞ¢–FV×÷FVæ7•ö¶W“¢Bæ–FV×÷FVæ7•ö¶W’ÀĞ¢7FGW3¢wVæF–ærrÀĞ¢&V6öã¢Bç&F–öæÆSòç6Æ–6RƒÂS’ÀĞ¢6V&6…ö–çFVçE÷G—S¢Bç6V&6…ö–çFVçCòæ–çFVçE÷G—RÀĞ¢6WGF–æw5÷6÷W&6S¢Bç6WGF–æw5÷6÷W&6RÀĞ¢Ò’“°Ğ¢–b†VF—E&V6÷&G2æÆVæwF‚â’v—B&6SCBæ56W'f–6U&öÆRæVçF—F–W2å'VÆTW†V7WF–öâæ'VÆ´7&VFR†VF—E&V6÷&G2’æ6F6‚‚‚’Óâ·Ò“°Ğ Ğ¢òò)H)H&W7÷7Ff–æÂ)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H Ğ¢6öç7BF÷÷÷'GVæ—F–W2Ò÷÷'GVæ—F–W0Ğ¢æf–ÇFW"†òÓâòæ6åöw&÷rbbòæ÷÷'GVæ—G•÷66÷&RãÒã3Ğ¢ç6÷'B‚†Â"’Óâ"æ÷÷'GVæ—G•÷66÷&RÒæ÷÷'GVæ—G•÷66÷&RĞ¢ç6Æ–6RƒÂ#“°Ğ Ğ¢&WGW&â&W7öç6Ræ§6öâ‡°Ğ¢ö³¢G'VRÀĞ¢Væv–æS¢wVæ–f–VB×7G&FVv–2×c‚rÀĞ¢6÷'&VÆF–öä–BÀĞ¢FFög&W6†æW73¢FFg&W6†æW72ÀĞ¢FFövUö†÷W'3¢ÖF‚ç&÷VæB†FFvR’ÀĞ Ğ¢W&f÷&Öæ6U÷6WGF–æw3¢°Ğ¢6÷W&6S¢6WGF–æw2ç6÷W&6RÀĞ¢F&vWEö6÷3¢6WGF–æw2çF&vWEö6÷2ÀĞ¢Ö…ö6÷3¢6WGF–æw2æÖ…ö6÷2ÀĞ¢F&vWE÷&ö3¢6WGF–æw2çF&vWE÷&ö2ÀĞ¢F–Ç•ö'VFvWEö6¢6WGF–æw2æF–Ç•ö'VFvWEö6ÀĞ¢Ö–åö&–C¢6WGF–æw2æÖ–åö&–BÀĞ¢Ö…ö&–C¢6WGF–æw2æÖ…ö&–BÀĞ¢6fWG•öf7F÷#¢6WGF–æw2ç6fWG•öf7F÷"ÀĞ¢w&÷wF…÷FöÆW&æ6Uöf7F÷#¢6WGF–æw2æw&÷wF…÷FöÆW&æ6Uöf7F÷"ÀĞ¢w&÷wF…ö6ööÆF÷våö†÷W'3¢6WGF–æw2æw&÷wF…ö6ööÆF÷våö†÷W'2ÀĞ¢ÒÀĞ Ğ¢w&÷wF…÷öÆ–7“¢°Ğ¢FW67&—F–öã¢wcc¢FF÷2V6öì;FÖ–6÷26öÖòfF÷"Âì:6ò&Æ÷VV–ò'6öÇWFòrÀĞ¢'F–Åö6÷7EöÖ…ö–æ7&V6U÷7C¢d"å%D”Åô4õ5EôÔ…ô”ä5$T4R¢ÀĞ¢w&÷wF…÷FöÆW&æ6Uöf7F÷#¢6WGF–æw2æw&÷wF…÷FöÆW&æ6Uöf7F÷"ÀĞ¢66Væ&–÷3¢²t¢ÇV7&F—fò¶&—†÷f—2rÂt#¢ÇFö7g"¶&—†õ÷föÇVÖRrÂt3¢”ÔÔTD”DUô%TDtUEõ$U45TR(šS“RRWF–Æ—¦F–öâ’rÂtC¢&öGWFõöæ÷fò·6–æÂrÂtS¢F÷÷6V&6‚uÒÀĞ¢–æ7&VÖVçG3¢²Æ÷s¢s2RrÂÖöFW&FS¢sRRrÂ†–vƒ¢s‚RrÂfW'•ö†–vƒ¢sRrÂW†6WF–öæÃ¢sRRrÒÀĞ¢ÒÀĞ Ğ¢V6öæöÖ–5ö6öçFW‡C¢°Ğ¢&öGV7G5÷v—F…öG–æÖ–5÷F&vWC¢6÷4'”6–âç6—¦RÀĞ¢&VÅ÷7VæE÷–W7FW&F“¢ÖF‚ç&÷VæB‡&VÅ7VæE–W7FW&F’¢’òÀĞ¢'VFvWEö6¢6WGF–æw2æF–Ç•ö'VFvWEö6ÀĞ¢'VFvWEöwV&G&–Å÷G&–vvW&VC¢'VFvWDwV&G&–Ä7F—fRÀĞ¢&öGV7G5÷WFFVC¢&öGV7EWFFW2æÆVæwF‚ÀĞ¢V6öå÷&V6÷&G5÷WFFVC¢V6öåWFFW2æÆVæwF‚ÀĞ¢'VFvWE÷&V6Æ7VÆF–öã¢°Ğ¢7VæEó#Fƒ¢ÖF‚ç&÷VæB‡7VæC#F‚¢’òÀĞ¢6ÆW5ó#Fƒ¢ÖF‚ç&÷VæB‡6ÆW3#F‚¢’òÀĞ¢÷&FW'5ó#Fƒ¢÷&FW'3#F‚ÀĞ¢6÷5ó#Fƒ¢6÷3#F‚ÓÒçVÆÂòÖF‚ç&÷VæB†6÷3#F‚¢’ò¢çVÆÂÀĞ¢&ö5ó#Fƒ¢&ö3#F‚ÓÒçVÆÂòÖF‚ç&÷VæB‡&ö3#F‚¢’ò¢çVÆÂÀĞ¢&Wf–÷W5ö6¢'VFvWD66†ævVBòÖF‚ç&÷VæB‚‡6WGF–æw2æF–Ç•ö'VFvWEö6ò‡&V6Æ7VÆFVD'VFvWD6â6WGF–æw2æF–Ç•ö'VFvWEö6òã¢&V6Æ7VÆFVD'VFvWD6Â6WGF–æw2æF–Ç•ö'VFvWEö6òã“¢ã“R’’¢’ò¢6WGF–æw2æF–Ç•ö'VFvWEö6ÀĞ¢æWuö6¢&V6Æ7VÆFVD'VFvWD6ÀĞ¢6†ævVC¢'VFvWD66†ævVBÀĞ¢&V6öã¢'VFvWDF§W7E&V6öâÀĞ¢W6W%ö6¢VffV7F—fUW6W$6ÀĞ¢fuö'&VµöWfVåö6÷3¢ÖF‚ç&÷VæB†ft'&V´WfVâ¢’òÀĞ¢ÒÀĞ¢ÒÀĞ Ğ¢÷÷'GVæ—G•÷7VÖÖ'“¢°Ğ¢F÷FÅö¶W—v÷&G5öWfÇVFVC¢÷÷'GVæ—F–W2æÆVæwF‚ÀĞ¢6åöw&÷s¢÷÷'GVæ—F–W2æf–ÇFW"†òÓâòæ6åöw&÷r’æÆVæwF‚ÀĞ¢'•÷7FFS¢÷÷'GVæ—F–W2ç&VGV6R‚†63¢ç’Âò’Óâ²65¶òæ÷÷'GVæ—G•÷7FFUÒÒ†65¶òæ÷÷'GVæ—G•÷7FFUÒÇÂ’²²&WGW&â63²ÒÂ·Ò’ÀĞ¢F÷ö÷÷'GVæ—F–W3¢F÷÷÷'GVæ—F–W2ÀĞ¢ÒÀĞ Ğ¢&öf—EögFW%öG5÷7VÖÖ'“¢°Ğ¢&öGV7G5öæÇ—¦VC¢6÷4'”6–âç6—¦RÀĞ¢ÖöFUöæ÷&ÖÃ¢'&’æg&öÒ†6÷4'”6–âçfÇVW2‚’’æf–ÇFW"†ÒÓâÒç&öf—E÷&÷FV7F–öãòæÖöFRÓÓÒvæ÷&ÖÂr’æÆVæwF‚ÀĞ¢ÖöFU÷f–v–ÆçC¢'&’æg&öÒ†6÷4'”6–âçfÇVW2‚’’æf–ÇFW"†ÒÓâÒç&öf—E÷&÷FV7F–öãòæÖöFRÓÓÒwf–v–ÆçBr’æÆVæwF‚ÀĞ¢ÖöFUöFVfVç6—fS¢'&’æg&öÒ†6÷4'”6–âçfÇVW2‚’’æf–ÇFW"†ÒÓâÒç&öf—E÷&÷FV7F–öãòæÖöFRÓÓÒvFVfVç6—fRr’æÆVæwF‚ÀĞ¢ÖöFU÷W6VC¢'&’æg&öÒ†6÷4'”6–âçfÇVW2‚’’æf–ÇFW"†ÒÓâÒç&öf—E÷&÷FV7F–öãòæÖöFRÓÓÒwW6VBr’æÆVæwF‚ÀĞ¢W&÷6–öåöÆW'G3¢'&’æg&öÒ†6÷4'”6–âæVçG&–W2‚’Ğ¢æf–ÇFW"‚…²ÂÕÒ’ÓâÒç&öf—E÷&÷FV7F–öãòæÆW'BĞ¢æÖ‚…¶6–âÂÕÒ’Óâ‡°Ğ¢6–âÂÖöFS¢Òç&öf—E÷&÷FV7F–öâæÖöFRÂ&V6öã¢Òç&öf—E÷&÷FV7F–öâç&V6öâÀĞ¢&öf—EögFW%öG5óFC¢ÖF‚ç&÷VæB†Òç&öf—EögFW%öG5óFB¢’òÀĞ¢&öf—EögFW%öG5ó6C¢ÖF‚ç&÷VæB†Òç&öf—EögFW%öG5ó6B¢’òÀĞ¢Ò’’ÀĞ¢ÒÀĞ Ğ¢6V6öæÅö6öçFW‡C¢6V6öæÂÀĞ Ğ¢FV6—6–öç5övVæW&FVC¢ÆÄFV6—6–öç2æÆVæwF‚ÀĞ¢FV6—6–öç5÷6fVC¢6fVBÀĞ¢7FG2ÀĞ¢6¶—VEö6÷VçC¢6¶—VBæÆVæwF‚ÀĞ Ğ¢6÷5ö6ö×&—6öå÷7VÖÖ'“¢°Ğ¢F÷FÅö6×–vç5öæÇ—¦VC¢6×v–æF÷tÖWG&–72ç6—¦RÀĞ¢'VFvWEö–æ7&V6UöFV6—6–öç3¢7FG2æ'VFvWEö–æ7&V6RÀĞ¢ÒÀĞ Ğ¢WFõöFVGWÆ–6F–öã¢°Ğ¢GWÆ–6FW5ö&6†—fVC¢WFôGWÆ–6FW4&6†—fVBæÆVæwF‚ÀĞ¢&6†—fVEö6×–vç3¢WFôGWÆ–6FW4&6†—fVBÀĞ¢ÒÀĞ Ğ¢66÷VçEö6÷5ö6öçG&öÅöÆö÷¢°Ğ¢vV–v‡FVEö6÷3¢66÷VçEvV–v‡FVD6÷2ÀĞ¢¦öæS¢66÷VçD6÷5¦öæRç¦öæRÀĞ¢FW67&—F–öã¢66÷VçD6÷5¦öæRæFW67&—F–öâÀĞ¢7F–öã¢66÷VçD6÷5¦öæRæ7F–öâÀĞ¢fuö'&VµöWfVã¢ÖF‚ç&÷VæB†ft'&V´WfVä66÷VçB¢’òÀĞ¢÷'FföÆ–õ÷v÷'7Eö6×–vç3¢÷'FföÆ–õ&æ¶–ærç6Æ–6RƒÂR’æÖ‚‡#¢ç’’Óâ‡°Ğ¢6×–våö–C¢"æ–BÂÖ&v–æÅö6÷3¢"æÖ&v–æÅö6÷2Â&æ³¢"ç&æ²ÀĞ¢Ò’’ÀĞ¢ÒÀĞ Ğ¢wV&G&–Ç3¢°Ğ¢¦W&õö6×–våöwV&C¢tD•dòrÀĞ¢&F6…÷W6UöwV&C¢tD•dòƒ3RW†–vRf÷&6Uö&F6ƒ²SR&Æ÷VV–’rÀĞ¢v–ææW%÷&÷FV7F–öã¢tD•dò6ì;Fæ–6òf–WfÇVFUv–ææW%&÷FV7F–öâ‚’rÀĞ¢6÷5öçVÆÅöf—ƒ¢tD•dò‡6ÆW3Ó(i"6÷3ÖçVÆÂ’rÀĞ¢F&vWE÷&ö5öFW&—fVC¢òF&vWEö6÷2ÒG²‡6WGF–æw2çF&vWE÷&ö2ÇÂ’çFôf—†VBƒB—×†ÀĞ¢VffV7F—fU÷F&vWEö6÷5÷W%ö6–ã¢tD•dò†Ö–â†66÷VçE÷F&vWBÂ'&VµöWfVåö6–â’’rÀĞ¢Ö…ö&–Eö6†ævU÷W%ö7–6ÆS¢+G´4äôä”4Åô4ôäd”räÔ…ô$”Eô4„ätUõ5B¢ÒVÀĞ¢FFög&W6†æW75öÖ…ö†÷W'3¢4äôä”4Åô4ôäd”räDDôe$U4„äU55ôÔ…ô„õU%2ÀĞ¢F—'F–æuöwV&G&–Ã¢D•dò(	B6Æ÷BGVÃ¢G¶7W'&VçE6Æ÷D6Æ76–f–6F–öçÒ‚G¶7W'&VçDF÷t%%GÒòG¶7W'&VçD†÷W$%%GÖ‚%%B–ÀĞ¢Æ6VÖVçEöwV&G&–Ã¢D•dò(	BÆ–Ö—FW3¢Fõ2G·6WGF–æw2çF÷ööe÷6V&6…öÆ–Ö—GÒRÂ&õ2G·6WGF–æw2ç&W7Eööe÷6V&6…öÆ–Ö—GÒRÂG·6WGF–æw2ç&öGV7E÷vUöÆ–Ö—GÒVÀĞ¢–ÖÖVF–FUö'VFvWE÷&W67VS¢tD•dò(	B(šS“RRWF–Æ—¦F–öâ²6õ>(šGF&vWB²$ô>(šWF&vWB²6ööÆF÷vâ#F‚²6öæf—&Ö:|:6òÖ¦öârÀĞ¢ÒÀĞ¢æ÷FS¢tÖ÷F÷"cƒ¢†–W&'V–Õr+rvV–v‡FVB6õ2+rF&vWE÷&ö2FW&—fFò+rVffV7F—fU÷F&vWEö6÷2÷"4”â+r6VçG&ÄFW7G'V7F—fT7F–öäwV&B+rv–ææW%÷&÷FV7F–öâ6ì;Fæ–6ò+r+#RÖ‚&–B+r”ÔÔTD”DUô%TDtUEõ$U45TRrÀĞ¢Ò“°Ğ Ğ¢Ò6F6‚†W'&÷#¢ç’’°Ğ¢6öç6öÆRæW'&÷"‚u·'VäFWFW&Ö–æ—7F–4FV6—6–öäVæv–æR×c…ÒrÂW'&÷"æÖW76vR“°Ğ¢&WGW&â&W7öç6Ræ§6öâ‡²ö³¢fÇ6RÂW'&÷#¢W'&÷"æÖW76vRÂ6÷'&VÆF–öä–BÒÂ²7FGW3¢SÒ“°Ğ¢ĞĞ§Ò“°Ğ Ğ¢òò)H)H†VÇW"'V–ÆDFV6—6–öâ)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H Ğ¦gVæ7F–öâ'V–ÆDFV6—6–öâ†–C¢7G&–ærÂ6÷'&VÆF–öä–C¢7G&–ærÂ&×3¢ç’“¢ç’°Ğ¢6öç7B–çFVçE66÷&RÒ&×2ç6V&6…ö–çFVçCòçW&6†6Uö–çFVçE÷66÷&RÇÂãS°Ğ¢6öç7B7Fö6´F—2Ò&×2ç7Fö6µö6÷fW&vUöF—3°Ğ¢6öç7B—57Fö6´FV6—6–öâÒ&×2ç'VÆUö¶W’ÓÓÒw7Fö6µö7&—F–6ÂrÇÂ&×2ç'VÆUö¶W’ÓÓÒw7Fö6µöÆ÷rrÇÂ&×2ç'VÆUö¶W’ÓÓÒw7Fö6µ÷¦W&òs°Ğ¢6öç7B7Fö6´f7F÷"Ò—57Fö6´FV6—6–öàĞ¢òã Ğ¢¢7Fö6´F—2ÒçVÆÂòÖF‚æÖ–âƒÂ‡7Fö6´F—2ÇÂ’ò3’¢ã°Ğ¢6öç7B&–÷&—G”f7F÷"ÒÒ‚‡&×2ç&–÷&—G’ÇÂ’’ò2“°Ğ¢6öç7B&—6´f7F÷"Ò²Æ÷s¢ã’ÂÖVF—VÓ¢ãrÂ†–vƒ¢ãRÕ·&×2ç&—6²27G&–æuÒÇÂãs°Ğ¢6öç7B÷÷'GVæ—G”f7F÷"Ò&×2æ÷÷'GVæ—G•÷66÷&RÇÂ†—57Fö6´FV6—6–öâòã¢ãR“°Ğ Ğ¢6öç7BFV6—6–öå÷&–÷&—G•÷66÷&RÒ6Æ4FV6—6–öå66÷&R‡°Ğ¢÷÷'GVæ—G“¢÷÷'GVæ—G”f7F÷"ÀĞ¢V6öæöÖ–5ö–×7C¢—57Fö6´FV6—6–öâòã¢ã‚ÀĞ¢6öæf–FVæ6S¢ã’ÀĞ¢f—6–&–Æ—G•öv¢&×2çf—6–&–Æ—G•÷66÷&RÒçVÆÂòƒÒ&×2çf—6–&–Æ—G•÷66÷&R’¢ãRÀĞ¢–çfVçF÷'“¢7Fö6´f7F÷"ÀĞ¢6öçfW'6–öã¢&×2ç6–×VÆF–öãòæW‡V7FVEöFF—F–öæÅö÷&FW'2âòã¢–çFVçE66÷&RÀĞ¢vöÅöÆ–væÖVçC¢&—6´f7F÷"ÀĞ¢Ò“°Ğ Ğ¢&WGW&â°Ğ¢ââç&×2ÀĞ¢Ö¦öåö66÷VçEö–C¢–BÀĞ¢6÷'&VÆF–öåö–C¢6÷'&VÆF–öä–BÀĞ¢&–÷&—G“¢&×2ç&–÷&—G’ÇÂ’ÀĞ¢FV6—6–öå÷&–÷&—G•÷66÷&RÀĞ¢f–æÅö6öæf–FVæ6S¢&×2æ÷÷'GVæ—G•÷66÷&RÇÂãƒÀĞ¢Ó°Ğ§ĞĞ