import {
  analyzeSearchTermLanguage,
  hasHardAttributeConflict,
  termFamilyKey,
} from './searchTermIntelligencePolicy.ts';

export const DEFAULT_MAX_EXACT_KEYWORDS_PER_CLUSTER = 5;

export type ManualClusterKeyword = {
  keywordText: string;
  asin?: string | null;
  intentCluster?: string | null;
  maturityStage?: string | null;
};

export type ManualClusterDecision = {
  allowed: boolean;
  reason: string;
  duplicate: boolean;
  activeExactCount: number;
  candidateFamily: string;
};

function normalizedIntent(value: unknown): string {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
}

function useCaseTokens(value: unknown): string[] {
  const protectedTokens = analyzeSearchTermLanguage(value).protectedTokens;
  return protectedTokens.filter((token) => ['banheiro', 'cozinha', 'escritorio', 'quarto'].includes(token));
}

export function deriveCommercialIntentCluster(term: unknown): string {
  const analysis = analyzeSearchTermLanguage(term);
  const useCases = useCaseTokens(term);
  const features = analysis.protectedTokens.filter((token) =>
    ['sensor', 'automatica', 'alexa', 'wifi', 'biometria'].includes(token)
  );
  const parts = [...useCases, ...features].filter(Boolean);
  if (parts.length) return normalizedIntent(parts.join('_'));
  const family = termFamilyKey(term);
  return normalizedIntent(family.split(' ').slice(0, 3).join('_')) || 'GENERAL';
}

export function areCommerciallyCoherentTerms(a: unknown, b: unknown): boolean {
  const left = termFamilyKey(a);
  const right = termFamilyKey(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (hasHardAttributeConflict(left, right)) return false;

  const leftUse = useCaseTokens(left);
  const rightUse = useCaseTokens(right);
  if (leftUse.length && rightUse.length && !leftUse.some((token) => rightUse.includes(token))) return false;

  const leftIntent = deriveCommercialIntentCluster(left);
  const rightIntent = deriveCommercialIntentCluster(right);
  return leftIntent === rightIntent;
}

export function evaluateManualExactCluster(input: {
  candidateKeyword: string;
  candidateAsin?: string | null;
  candidateIntentCluster?: string | null;
  candidateMaturityStage?: string | null;
  existingKeywords: ManualClusterKeyword[];
  maxExactKeywords?: number;
  winnerIsolation?: boolean;
}): ManualClusterDecision {
  const candidateFamily = termFamilyKey(input.candidateKeyword);
  const maxExactKeywords = Math.max(1, Math.min(5, Number(input.maxExactKeywords || DEFAULT_MAX_EXACT_KEYWORDS_PER_CLUSTER)));
  const active = (input.existingKeywords || []).filter((row) => String(row.keywordText || '').trim());

  if (!candidateFamily) {
    return { allowed: false, reason: 'EMPTY_TERM_FAMILY', duplicate: false, activeExactCount: active.length, candidateFamily };
  }

  if (input.winnerIsolation === true) {
    if (active.length > 0) {
      return { allowed: false, reason: 'WINNER_REQUIRES_SINGLETON_CAMPAIGN', duplicate: false, activeExactCount: active.length, candidateFamily };
    }
    return { allowed: true, reason: 'WINNER_SINGLETON_ALLOWED', duplicate: false, activeExactCount: 0, candidateFamily };
  }

  const duplicate = active.some((row) => termFamilyKey(row.keywordText) === candidateFamily);
  if (duplicate) {
    return { allowed: false, reason: 'TERM_FAMILY_ALREADY_COVERED', duplicate: true, activeExactCount: active.length, candidateFamily };
  }

  if (active.length >= maxExactKeywords) {
    return { allowed: false, reason: 'MANUAL_CLUSTER_CAP_REACHED', duplicate: false, activeExactCount: active.length, candidateFamily };
  }

  const candidateAsin = String(input.candidateAsin || '').toUpperCase();
  const candidateIntent = normalizedIntent(input.candidateIntentCluster || deriveCommercialIntentCluster(input.candidateKeyword));
  const candidateStage = String(input.candidateMaturityStage || 'MANUAL_CLUSTERED').toUpperCase();

  for (const row of active) {
    if (candidateAsin && row.asin && String(row.asin).toUpperCase() !== candidateAsin) {
      return { allowed: false, reason: 'ASIN_MISMATCH', duplicate: false, activeExactCount: active.length, candidateFamily };
    }
    const rowIntent = normalizedIntent(row.intentCluster || deriveCommercialIntentCluster(row.keywordText));
    if (candidateIntent && rowIntent && candidateIntent !== rowIntent) {
      return { allowed: false, reason: 'INTENT_CLUSTER_MISMATCH', duplicate: false, activeExactCount: active.length, candidateFamily };
    }
    const rowStage = String(row.maturityStage || 'MANUAL_CLUSTERED').toUpperCase();
    if (rowStage === 'WINNER' || rowStage === 'ISOLATED' || candidateStage === 'WINNER' || candidateStage === 'ISOLATED') {
      return { allowed: false, reason: 'WINNER_MUST_BE_ISOLATED', duplicate: false, activeExactCount: active.length, candidateFamily };
    }
    if (!areCommerciallyCoherentTerms(row.keywordText, input.candidateKeyword)) {
      return { allowed: false, reason: 'COMMERCIAL_INTENT_MISMATCH', duplicate: false, activeExactCount: active.length, candidateFamily };
    }
  }

  return { allowed: true, reason: active.length ? 'COHERENT_CLUSTER_APPEND_ALLOWED' : 'NEW_CLUSTER_ALLOWED', duplicate: false, activeExactCount: active.length, candidateFamily };
}

export function buildTermLifecycleIdempotencyKey(input: {
  accountId: string;
  asin: string;
  termFamily: string;
  transition: string;
  action: string;
  window: string;
}): string {
  return [
    input.accountId,
    String(input.asin || '').toUpperCase(),
    termFamilyKey(input.termFamily),
    String(input.transition || '').toUpperCase(),
    String(input.action || '').toUpperCase(),
    String(input.window || ''),
  ].join('|');
}
