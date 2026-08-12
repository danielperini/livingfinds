/**
 * Term Intelligence — política canônica de clusters de termos (PT-BR).
 *
 * Determinística e sem IA. Usada pelo backfill (runTermIntelligenceBackfill),
 * pela criação de campanhas manuais e pela reconciliação canônica.
 *
 * Regra estrutural:
 *  - MANUAL_CLUSTERED: 2..5 Exact coerentes por campanha temática
 *  - WINNER / ISOLATED: exatamente 1 Exact (campanha 1:1)
 */

export const MAX_EXACT_PER_CLUSTER = 5;
export const MIN_EXACT_PER_CLUSTER = 2;
export const DEFAULT_LOOKBACK_DAYS = 15;

// ── Normalização PT-BR ───────────────────────────────────────────────────────

const ABBREVIATIONS: Record<string, string> = {
  c: 'com',
  cm: 'com',
  p: 'para',
  pra: 'para',
  pro: 'para o',
  q: 'que',
  vc: 'voce',
  tbm: 'tambem',
  tb: 'tambem',
  qd: 'quando',
  pq: 'porque',
  eletronico: 'eletronico',
  autom: 'automatico',
  inox: 'inox',
};

const STEM_FIXES: Record<string, string> = {
  lixera: 'lixeira',
  lixeria: 'lixeira',
  eletronica: 'eletronico',
  eletronicas: 'eletronico',
  organizadores: 'organizador',
  automatica: 'automatico',
  automaticas: 'automatico',
  moedores: 'moedor',
  cafeteira: 'cafeteira',
  bolsas: 'bolsa',
};

const STOPWORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'a', 'o', 'as', 'os', 'e', 'em', 'no', 'na', 'um', 'uma']);

export function stripAccents(value: string): string {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function singularize(token: string): string {
  if (STEM_FIXES[token]) return STEM_FIXES[token];
  if (token.length > 4 && token.endsWith('oes')) return `${token.slice(0, -3)}ao`;
  if (token.length > 4 && token.endsWith('is')) return `${token.slice(0, -2)}l`;
  if (token.length > 3 && token.endsWith('s')) return token.slice(0, -1);
  return token;
}

/** Normalização determinística: acentos, abreviações, coloquial, plural. */
export function normalizePtBr(raw: string): string {
  const base = stripAccents(String(raw || ''))
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) return '';
  const tokens: string[] = [];
  for (const rawToken of base.split(' ')) {
    const expanded = ABBREVIATIONS[rawToken] || rawToken;
    for (const piece of expanded.split(' ')) {
      const token = singularize(piece);
      if (token) tokens.push(token);
    }
  }
  return tokens.join(' ');
}

// ── Hard attributes ──────────────────────────────────────────────────────────

/**
 * Atributos "duros": divergência entre dois termos bloqueia agrupamento
 * (com alexa ≠ sem alexa, 6L ≠ 20L, banheiro ≠ escritório).
 */
const HARD_ATTRIBUTE_GROUPS: Array<{ group: string; match: (normalized: string) => string | null }> = [
  {
    group: 'assistente',
    match: (t) => (/\bsem alexa\b|\bsem google\b/.test(t) ? 'sem_assistente' : /\balexa\b|\bgoogle home\b/.test(t) ? 'com_assistente' : null),
  },
  {
    group: 'capacidade',
    match: (t) => {
      const m = t.match(/\b(\d{1,3})\s?(l|litros?|ml|kg|g)\b/);
      return m ? `${m[1]}${m[2]}` : null;
    },
  },
  {
    group: 'ambiente',
    match: (t) => {
      const m = t.match(/\b(banheiro|cozinha|escritorio|quarto|sala|carro|外)\b/);
      return m ? m[1] : null;
    },
  },
  {
    group: 'energia',
    match: (t) => (/\bsem fio\b|\bbateria\b|\brecarregavel\b/.test(t) ? 'sem_fio' : /\bcom fio\b|\b110v\b|\b220v\b/.test(t) ? 'com_fio' : null),
  },
  {
    group: 'publico',
    match: (t) => {
      const m = t.match(/\b(infantil|bebe|adulto|pet|masculino|feminino)\b/);
      return m ? m[1] : null;
    },
  },
];

export function hardAttributes(normalized: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of HARD_ATTRIBUTE_GROUPS) {
    const value = item.match(normalized);
    if (value) out[item.group] = value;
  }
  return out;
}

export function hardAttributesConflict(a: string, b: string): boolean {
  const attrsA = hardAttributes(a);
  const attrsB = hardAttributes(b);
  for (const key of Object.keys(attrsA)) {
    if (attrsB[key] && attrsB[key] !== attrsA[key]) return true;
  }
  return false;
}

// ── Family key + intent cluster ──────────────────────────────────────────────

export function coreTokens(normalized: string): string[] {
  return normalized.split(' ').filter((token) => token && !STOPWORDS.has(token));
}

/** Chave estável de família de termos: núcleo lexical ordenado. */
export function termFamilyKey(normalized: string): string {
  const tokens = coreTokens(normalized).filter((t) => t.length > 2);
  const head = tokens.slice(0, 3).sort();
  return head.join('_') || coreTokens(normalized).join('_');
}

const INTENT_LEXICON: Array<{ intent: string; pattern: RegExp }> = [
  { intent: 'BRAND', pattern: /\b(original|marca|oficial)\b/ },
  { intent: 'PRICE_SENSITIVE', pattern: /\b(barat|promoc|desconto|custo beneficio)\w*/ },
  { intent: 'PREMIUM', pattern: /\b(profissional|premium|industrial|inox)\b/ },
  { intent: 'USE_CASE', pattern: /\b(para|viagem|casa|trabalho|presente)\b/ },
  { intent: 'ATTRIBUTE', pattern: /\b(automatico|sem fio|grande|pequeno|portatil)\b/ },
];

/** Cluster de intenção comercial: lexical + atributos duros. */
export function intentCluster(normalized: string): string {
  const family = termFamilyKey(normalized);
  let intent = 'GENERIC';
  for (const item of INTENT_LEXICON) {
    if (item.pattern.test(normalized)) { intent = item.intent; break; }
  }
  const attrs = hardAttributes(normalized);
  const attrKey = Object.keys(attrs).sort().map((k) => `${k}:${attrs[k]}`).join('|');
  return [family, intent, attrKey].filter(Boolean).join('#');
}

/** Dois termos podem coexistir no mesmo cluster temático? */
export function canCluster(normalizedA: string, normalizedB: string): { allowed: boolean; reason: string } {
  if (!normalizedA || !normalizedB) return { allowed: false, reason: 'empty_term' };
  if (normalizedA === normalizedB) return { allowed: false, reason: 'duplicate_term' };
  if (hardAttributesConflict(normalizedA, normalizedB)) return { allowed: false, reason: 'hard_attribute_conflict' };
  const tokensA = new Set(coreTokens(normalizedA));
  const tokensB = coreTokens(normalizedB);
  const shared = tokensB.filter((token) => tokensA.has(token)).length;
  const denominator = Math.max(tokensA.size, tokensB.length, 1);
  if (shared / denominator < 0.4) return { allowed: false, reason: 'low_lexical_overlap' };
  return { allowed: true, reason: 'coherent_cluster' };
}

// ── Validação estrutural contextual (substitui guard 1 keyword = 1 campanha) ─

export type StructureState = 'MANUAL_CLUSTERED' | 'WINNER' | 'ISOLATED' | 'AUTO' | 'UNKNOWN';

export function validateClusterCapacity(
  structureState: StructureState,
  currentExactCount: number,
): { allowed: boolean; reason: string; limit: number } {
  if (structureState === 'WINNER' || structureState === 'ISOLATED') {
    return { allowed: currentExactCount < 1, reason: currentExactCount < 1 ? 'winner_slot_free' : 'winner_must_stay_1_to_1', limit: 1 };
  }
  if (structureState === 'MANUAL_CLUSTERED') {
    const allowed = currentExactCount < MAX_EXACT_PER_CLUSTER;
    return { allowed, reason: allowed ? 'cluster_has_capacity' : 'cluster_hard_stop_5', limit: MAX_EXACT_PER_CLUSTER };
  }
  return { allowed: currentExactCount < MAX_EXACT_PER_CLUSTER, reason: 'default_cluster_limit', limit: MAX_EXACT_PER_CLUSTER };
}

// ── Economia: Safe CPC e bids ────────────────────────────────────────────────

/** Safe CPC sempre calculado com dados do PRÓPRIO ASIN. */
export function safeCpcForAsin(input: {
  price?: number;
  observedCpc?: number;
  conversionRate?: number;
  targetAcosPct?: number;
  contributionMarginPct?: number;
}): number {
  const price = Number(input.price || 0);
  const targetAcos = Math.max(1, Number(input.targetAcosPct || 15)) / 100;
  const marginPct = Math.min(0.95, Math.max(0.05, Number(input.contributionMarginPct || 25) / 100));
  // CVR conservadora: metade da observada, com piso de 2%.
  const cvr = Math.max(0.02, Number(input.conversionRate || 0) / 100 / 2 || 0.02);
  const economicCeiling = price > 0 ? price * Math.min(targetAcos, marginPct) * cvr : 0;
  const observed = Number(input.observedCpc || 0);
  const ceiling = economicCeiling > 0 ? economicCeiling : observed * 1.1;
  return Math.max(0.25, Math.round(Math.min(ceiling || 0.5, 5) * 100) / 100);
}

export function candidateBid(input: {
  observedCpc?: number;
  safeCpc: number;
  minBid?: number;
}): number {
  const min = Number(input.minBid || 0.25);
  const observed = Number(input.observedCpc || 0);
  const base = observed > 0 ? observed * 1.05 : input.safeCpc * 0.8;
  return Math.max(min, Math.round(Math.min(base, input.safeCpc) * 100) / 100);
}

/** Zero-delivery recovery: +8% na 1ª tentativa, +10% na 2ª, máx 2 tentativas. */
export function zeroDeliveryRecoveryBid(currentBid: number, attempt: number, safeCpc: number): number | null {
  if (attempt > 2) return null;
  const factor = attempt === 1 ? 1.08 : 1.10;
  const next = Math.round(Math.min(Number(currentBid || 0) * factor, safeCpc) * 100) / 100;
  return next > Number(currentBid || 0) ? next : null;
}

// ── Lifecycle de termos ──────────────────────────────────────────────────────

export type TermMaturity =
  | 'DISCOVERED' | 'QUALIFIED' | 'MANUAL_CLUSTERED' | 'PROVEN'
  | 'WINNER_CANDIDATE' | 'WINNER' | 'ISOLATED';

export function termMaturity(metrics: {
  clicks?: number;
  sameSkuOrders?: number;
  acos?: number;
  targetAcosPct?: number;
  distinctSaleDays?: number;
  promotedToManual?: boolean;
  isolated?: boolean;
  inStock?: boolean;
  buyable?: boolean;
}): TermMaturity {
  const clicks = Number(metrics.clicks || 0);
  const orders = Number(metrics.sameSkuOrders || 0);
  const acos = Number(metrics.acos || 0);
  const targetAcos = Number(metrics.targetAcosPct || 15);
  const saleDays = Number(metrics.distinctSaleDays || 0);
  const healthy = acos > 0 && acos <= targetAcos * 1.35;
  const sellable = metrics.inStock !== false && metrics.buyable !== false;

  if (metrics.isolated) return 'ISOLATED';
  if (orders >= 2 && saleDays >= 2 && healthy && sellable) return 'WINNER';
  if (orders >= 1 && metrics.promotedToManual) return 'WINNER_CANDIDATE';
  if (orders >= 1) return 'PROVEN';
  if (metrics.promotedToManual) return 'MANUAL_CLUSTERED';
  if (clicks >= 5) return 'QUALIFIED';
  return 'DISCOVERED';
}

// ── Classificação de campanhas e ação de reconciliação ───────────────────────

export type CampaignClassification =
  | 'STRUCTURALLY_VALID' | 'STRUCTURALLY_INCOMPLETE' | 'ZERO_DELIVERY' | 'LOW_CTR'
  | 'SERVING_NO_CONVERSION' | 'PROFITABLE' | 'PROVEN' | 'WINNER' | 'DECLINING'
  | 'DUPLICATE' | 'OVERFRAGMENTED' | 'UNDERCLUSTERED' | 'STOCK_BLOCKED' | 'BUYABILITY_BLOCKED';

export type ReconciliationAction =
  | 'KEEP' | 'REPAIR' | 'ADD_EXACT' | 'REMOVE_EXACT_AFTER_REPLACEMENT' | 'CREATE_CLUSTER'
  | 'MOVE_TERM_TO_CLUSTER' | 'PROMOTE_TERM' | 'ISOLATE_WINNER' | 'ADD_NEGATIVE_EXACT'
  | 'REDUCE_BID' | 'RECOVER_ZERO_DELIVERY' | 'PAUSE_KEYWORD' | 'PAUSE_CAMPAIGN'
  | 'ARCHIVE_INVALID_CAMPAIGN' | 'MERGE_STRUCTURE' | 'NO_ACTION';

export const ACTION_PRIORITY: Record<ReconciliationAction, number> = {
  REPAIR: 0,
  RECOVER_ZERO_DELIVERY: 1,
  ISOLATE_WINNER: 1,
  CREATE_CLUSTER: 2,
  ADD_EXACT: 2,
  MOVE_TERM_TO_CLUSTER: 3,
  PROMOTE_TERM: 3,
  MERGE_STRUCTURE: 4,
  REDUCE_BID: 5,
  ADD_NEGATIVE_EXACT: 5,
  REMOVE_EXACT_AFTER_REPLACEMENT: 6,
  PAUSE_KEYWORD: 6,
  PAUSE_CAMPAIGN: 7,
  ARCHIVE_INVALID_CAMPAIGN: 7,
  KEEP: 7,
  NO_ACTION: 7,
};

export function classifyCampaign(input: {
  exactKeywordCount: number;
  hasAdGroup: boolean;
  hasProductAd: boolean;
  impressions: number;
  clicks: number;
  spend: number;
  sales: number;
  orders: number;
  acos: number;
  targetAcosPct?: number;
  inStock: boolean;
  buyable: boolean;
  isWinnerStructure?: boolean;
}): CampaignClassification {
  const targetAcos = Number(input.targetAcosPct || 15);
  if (!input.buyable) return 'BUYABILITY_BLOCKED';
  if (!input.inStock) return 'STOCK_BLOCKED';
  if (!input.hasAdGroup || !input.hasProductAd || input.exactKeywordCount === 0) return 'STRUCTURALLY_INCOMPLETE';
  if (input.exactKeywordCount > MAX_EXACT_PER_CLUSTER) return 'OVERFRAGMENTED';
  if (!input.isWinnerStructure && input.exactKeywordCount === 1 && input.orders === 0) return 'UNDERCLUSTERED';
  if (input.impressions === 0) return 'ZERO_DELIVERY';
  if (input.clicks === 0) return 'LOW_CTR';
  if (input.orders === 0 && input.spend > 0) return 'SERVING_NO_CONVERSION';
  if (input.orders >= 2 && input.acos > 0 && input.acos <= targetAcos) return 'WINNER';
  if (input.orders >= 1 && input.acos > 0 && input.acos <= targetAcos * 1.35) return 'PROFITABLE';
  if (input.orders >= 1) return 'PROVEN';
  return 'STRUCTURALLY_VALID';
}

export function actionForClassification(classification: CampaignClassification): ReconciliationAction {
  switch (classification) {
    case 'STRUCTURALLY_INCOMPLETE': return 'REPAIR';
    case 'ZERO_DELIVERY': return 'RECOVER_ZERO_DELIVERY';
    case 'LOW_CTR': return 'REDUCE_BID';
    case 'SERVING_NO_CONVERSION': return 'REDUCE_BID';
    case 'OVERFRAGMENTED': return 'MOVE_TERM_TO_CLUSTER';
    case 'UNDERCLUSTERED': return 'ADD_EXACT';
    case 'DUPLICATE': return 'MERGE_STRUCTURE';
    case 'WINNER': return 'ISOLATE_WINNER';
    case 'STOCK_BLOCKED': return 'PAUSE_CAMPAIGN';
    case 'BUYABILITY_BLOCKED': return 'PAUSE_CAMPAIGN';
    default: return 'KEEP';
  }
}

/** Chave idempotente estável por ação planejada. */
export function actionIdempotencyKey(parts: {
  accountId: string;
  asin: string;
  action: string;
  target: string;
}): string {
  return [
    'ti',
    parts.accountId,
    String(parts.asin || '').toUpperCase(),
    parts.action,
    normalizePtBr(parts.target).replace(/\s+/g, '_') || 'na',
  ].join('|');
}