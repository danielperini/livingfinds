import { assessNoConversionEvidence } from './bidDecisionEvidence.ts';
import type { AttributionConfidence, DeteriorationLevel } from './decisionStatistics.ts';

export const DELIVERY_LEARNING_HOURS = 72;
export const ZERO_IMPRESSION_MAX_HOURS = 15 * 24;
export const MIN_IMPRESSIONS_NO_CLICK = 100;
export const MIN_HOURLY_CLICKS = 10;
export const MIN_HOURLY_SAMPLE_DAYS = 14;

const n = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const norm = (value: unknown): string => String(value || '').trim().toLowerCase();

export type ProductGate = {
  eligible: boolean;
  code: 'ELIGIBLE' | 'PRODUCT_NOT_FOUND' | 'PRODUCT_INACTIVE' | 'OUT_OF_STOCK' | 'LISTING_SUPPRESSED' | 'OFFER_INACTIVE' | 'NOT_BUYABLE';
  reversible: boolean;
};

export function productGate(product: any): ProductGate {
  if (!product) return { eligible: false, code: 'PRODUCT_NOT_FOUND', reversible: false };
  const status = norm(product.status || product.listing_status || product.offer_status);
  if (['inactive', 'inativo', 'closed', 'deleted', 'suppressed'].includes(status)) {
    return { eligible: false, code: 'PRODUCT_INACTIVE', reversible: true };
  }
  if (product.listing_suppressed === true || norm(product.ads_eligibility_status) === 'listing_suppressed') {
    return { eligible: false, code: 'LISTING_SUPPRESSED', reversible: true };
  }
  if (product.offer_active === false || ['offer_inactive', 'listing_inactive'].includes(norm(product.ads_eligibility_status))) {
    return { eligible: false, code: 'OFFER_INACTIVE', reversible: true };
  }
  if (product.listing_buyable === false || norm(product.ads_eligibility_status) === 'not_buyable') {
    return { eligible: false, code: 'NOT_BUYABLE', reversible: true };
  }
  const stock = n(
    product.fba_inventory ?? product.available_quantity ?? product.fulfillable_quantity ??
      product.inventory_quantity ?? product.stock_quantity,
    -1,
  );
  if (stock === 0 || norm(product.inventory_status) === 'out_of_stock') {
    return { eligible: false, code: 'OUT_OF_STOCK', reversible: true };
  }
  return { eligible: true, code: 'ELIGIBLE', reversible: true };
}

export type DeliveryInput = {
  ageHours: number;
  metricsFresh: boolean;
  impressions: number;
  clicks: number;
  orders: number;
  sales: number;
  spend: number;
  isManualExact: boolean;
  isAuto: boolean;
  maximumProfitableSpend: number;
  breakEvenAcos: number | null;
  targetAcos: number | null;
  matureClicks?: number | null;
  conversionRate?: number | null;
  fallbackConversionRate?: number | null;
  currentCpc?: number | null;
  safeCpc?: number | null;
  priorReduction?: boolean;
  persistentLowRelevance?: boolean;
  attributionConfidence?: AttributionConfidence;
  deteriorationLevel?: DeteriorationLevel;
  isNewProduct?: boolean;
};

export type DeliveryDecision = {
  code: string;
  action: 'monitor' | 'bootstrap_bid' | 'replace_term' | 'pause' | 'profit_guard';
  reason: string;
  confidence: number;
  evidence?: Record<string, unknown>;
};

export function classifyDelivery(input: DeliveryInput): DeliveryDecision {
  if (!input.metricsFresh) {
    return { code: 'MOTOR_MONITORING_METRICS_STALE', action: 'monitor', reason: 'Métricas ainda não estão frescas o bastante para uma ação segura.', confidence: 30 };
  }
  if (input.ageHours < DELIVERY_LEARNING_HOURS) {
    return { code: 'MOTOR_MONITORING_LEARNING', action: 'monitor', reason: 'Campanha ainda está na janela inicial de aprendizado de 72 horas.', confidence: 70 };
  }

  const economicsAvailable = input.maximumProfitableSpend > 0 || Boolean(input.breakEvenAcos && input.breakEvenAcos > 0);
  if (!economicsAvailable) {
    return {
      code: 'MOTOR_MONITORING_ECONOMICS_MISSING',
      action: 'monitor',
      reason: 'Economia do produto não está validada; o motor não aumenta bid, pausa ou substitui com base em suposição.',
      confidence: 25,
    };
  }

  if (input.impressions <= 0 && input.clicks <= 0 && input.spend <= 0) {
    if (input.isManualExact && input.ageHours <= ZERO_IMPRESSION_MAX_HOURS) {
      return { code: 'ZERO_IMPRESSION_BID_BOOTSTRAP', action: 'bootstrap_bid', reason: 'Sem impressão: testar até duas recuperações controladas de bid, respeitando o teto econômico.', confidence: 95 };
    }
    if (input.isManualExact) {
      return { code: 'ZERO_IMPRESSION_REPLACE_TERM', action: 'replace_term', reason: 'Sem impressão após a janela máxima: substituir a keyword, sem continuar aumentando bid.', confidence: 95 };
    }
    return { code: 'AUTO_ZERO_IMPRESSION_REVIEW', action: 'monitor', reason: 'Campanha automática sem impressão exige validação estrutural e de segmentações antes de novo gasto.', confidence: 85 };
  }

  if (input.impressions > 0 && input.clicks <= 0) {
    if (input.ageHours < ZERO_IMPRESSION_MAX_HOURS) {
      return { code: 'MOTOR_MONITORING_LOW_CTR_MATURITY', action: 'monitor', reason: 'A campanha ainda não completou 14 dias; relevância baixa será observada sem substituição prematura.', confidence: 70 };
    }
    if (input.impressions >= MIN_IMPRESSIONS_NO_CLICK && input.isManualExact) {
      return { code: 'IMPRESSIONS_NO_CLICK_REPLACE_TERM', action: 'replace_term', reason: 'Há entrega, mas a keyword não gera clique; aumentar bid elevaria exposição sem corrigir relevância.', confidence: 95 };
    }
    if (input.impressions >= MIN_IMPRESSIONS_NO_CLICK) {
      return { code: 'IMPRESSIONS_NO_CLICK_PAUSE', action: 'pause', reason: 'A campanha recebe impressões, mas não atrai cliques; pausar o desperdício e revisar segmentação.', confidence: 90 };
    }
    return { code: 'MOTOR_MONITORING_LOW_CTR_SAMPLE', action: 'monitor', reason: 'Amostra de impressões ainda insuficiente para concluir baixa relevância.', confidence: 60 };
  }

  if (input.clicks > 0 && input.orders <= 0 && input.sales <= 0) {
    const evidence = assessNoConversionEvidence({
      clicks: input.clicks,
      matureClicks: input.matureClicks,
      spend: input.spend,
      conversionRate: input.conversionRate,
      fallbackConversionRate: input.fallbackConversionRate,
      maximumAcquisitionSpend: input.maximumProfitableSpend,
      currentCpc: input.currentCpc,
      safeCpc: input.safeCpc,
      priorReduction: input.priorReduction,
      persistentLowRelevance: input.persistentLowRelevance,
      attributionConfidence: input.attributionConfidence,
      ageDays: input.ageHours / 24,
      isNewProduct: input.isNewProduct,
      deteriorationLevel: input.deteriorationLevel,
    });
    if (evidence.level === 'pause_candidate') {
      return {
        code: input.isManualExact ? 'CLICKS_NO_SALE_REPLACE_TERM' : 'CLICKS_NO_SALE_PAUSE',
        action: input.isManualExact ? 'replace_term' : 'pause',
        reason: `Perda persistente confirmada após redução anterior, janela madura e evidência probabilística (P=${Math.round((evidence.probability_below_sustainable || 0) * 100)}%).`,
        confidence: 96,
        evidence,
      };
    }
    if (evidence.level === 'reduce_soft' || evidence.level === 'reduce_strong') {
      return {
        code: evidence.level === 'reduce_strong' ? 'NO_CONVERSION_REDUCE_STRONG' : 'NO_CONVERSION_REDUCE_SOFT',
        action: 'profit_guard',
        reason: `Evidência ${evidence.level === 'reduce_strong' ? 'forte' : 'inicial'} de desperdício: reduzir bid ${Math.round(evidence.recommended_reduction_pct * 100)}% e reavaliar antes de pausar.`,
        confidence: evidence.level === 'reduce_strong' ? 88 : 75,
        evidence,
      };
    }
    return {
      code: evidence.internal_state === 'hold_for_attribution' ? 'MOTOR_HOLD_FOR_ATTRIBUTION' : 'MOTOR_MONITORING_NO_SALE_SAMPLE',
      action: 'monitor',
      reason: evidence.internal_state === 'hold_for_attribution'
        ? 'Conversões ainda podem entrar na janela de atribuição; nenhuma redução ou pausa será executada.'
        : 'A evidência probabilística e econômica ainda não é suficiente para reduzir ou pausar.',
      confidence: 65,
      evidence,
    };
  }

  if (input.sales > 0) {
    const acos = input.spend / input.sales * 100;
    if (input.breakEvenAcos && acos >= input.breakEvenAcos) {
      return { code: 'SALES_WITH_NEGATIVE_MARGIN', action: 'profit_guard', reason: `Campanha vende, mas o ACoS ${acos.toFixed(2)}% alcançou ou superou o break-even ${input.breakEvenAcos.toFixed(2)}%.`, confidence: 99 };
    }
    if (input.targetAcos && acos > input.targetAcos) {
      return { code: 'SALES_ABOVE_TARGET', action: 'profit_guard', reason: `Campanha vende acima do ACoS operacional ${input.targetAcos.toFixed(2)}%; reduzir exposição nos horários ruins.`, confidence: 95 };
    }
  }

  return { code: 'HEALTHY_OR_PROTECTED', action: 'monitor', reason: 'Campanha saudável ou ainda sem evidência determinística para alteração.', confidence: 90 };
}

export type HourlyProfitInput = {
  sampleDays: number;
  clicks: number;
  orders: number;
  sales: number;
  spend: number;
  maximumProfitableSpend: number;
  breakEvenAcos: number | null;
  targetAcos: number | null;
  attributionConfidence?: AttributionConfidence;
};

export function classifyCurrentHour(input: HourlyProfitInput): { action: 'pause' | 'enable' | 'hold'; code: string; reason: string } {
  const economicsAvailable = input.maximumProfitableSpend > 0 || Boolean(input.breakEvenAcos && input.breakEvenAcos > 0);
  if (!economicsAvailable) {
    return { action: 'hold', code: 'HOUR_ECONOMICS_MISSING', reason: 'Economia não validada; não alterar estado por horário.' };
  }
  if (input.attributionConfidence !== 'complete') {
    return { action: 'hold', code: 'HOUR_ATTRIBUTION_OPEN', reason: 'Janela de atribuição horária ainda aberta ou sem separação same-SKU; manter estado.' };
  }
  if (input.sampleDays < MIN_HOURLY_SAMPLE_DAYS || input.clicks < MIN_HOURLY_CLICKS) {
    return { action: 'hold', code: 'HOUR_SAMPLE_INSUFFICIENT', reason: 'Amostra horária insuficiente; manter estado atual.' };
  }
  if (input.sales <= 0) {
    const limit = input.maximumProfitableSpend;
    if (input.orders <= 0 && input.spend >= limit) {
      return { action: 'pause', code: 'UNPROFITABLE_HOUR_NO_SALES', reason: `Horário consome ${input.spend.toFixed(2)} sem venda; pausar até a próxima janela.` };
    }
    return { action: 'hold', code: 'HOUR_NO_SALE_BELOW_LIMIT', reason: 'Horário sem venda, mas ainda abaixo do limite de perda.' };
  }
  const acos = input.spend / input.sales * 100;
  if (input.breakEvenAcos && acos >= input.breakEvenAcos) {
    return { action: 'pause', code: 'UNPROFITABLE_HOUR_BREAK_EVEN', reason: `ACoS horário ${acos.toFixed(2)}% acima do break-even ${input.breakEvenAcos.toFixed(2)}%.` };
  }
  if (input.targetAcos && acos <= input.targetAcos && input.orders >= 2) {
    return { action: 'enable', code: 'PROFITABLE_HOUR', reason: `Horário comprovadamente rentável, ACoS ${acos.toFixed(2)}%.` };
  }
  return { action: 'hold', code: 'HOUR_WATCH', reason: 'Horário intermediário; manter bid defensivo e monitorar.' };
}

export function structuralLoss(economics: any, minBid: number): { blocked: boolean; reason: string } {
  if (!economics) return { blocked: false, reason: '' };
  const status = norm(economics.economics_status);
  const confidence = n(economics.final_economic_confidence, 0);
  if (status !== 'complete' && confidence < 80) return { blocked: false, reason: '' };

  const profitBeforeAds = n(economics.profit_before_ads ?? economics.contribution_margin_amount, 0);
  const breakEvenAcos = n(economics.break_even_acos ?? economics.contribution_margin_percent, 0);
  const safeMaxCpc = n(economics.safe_max_cpc, 0);
  if (profitBeforeAds <= 0) return { blocked: true, reason: 'Produto tem margem de contribuição nula ou negativa antes dos anúncios.' };
  if (breakEvenAcos > 0 && breakEvenAcos <= 3) return { blocked: true, reason: `Break-even ACoS de ${breakEvenAcos.toFixed(2)}% é estruturalmente inviável para publicidade contínua.` };
  if (safeMaxCpc > 0 && safeMaxCpc < minBid) return { blocked: true, reason: `CPC seguro ${safeMaxCpc.toFixed(2)} é inferior ao bid mínimo ${minBid.toFixed(2)}.` };
  return { blocked: false, reason: '' };
}
