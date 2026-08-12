import { normalizeSearchTerm } from './searchTermHarvestPolicy.ts';

export type TermMaturityStage =
  | 'DISCOVERED'
  | 'QUALIFIED'
  | 'MANUAL_CLUSTERED'
  | 'PROVEN'
  | 'WINNER'
  | 'ISOLATED'
  | 'TEMPORAL_LEARNING'
  | 'DAYPART_OPTIMIZED'
  | 'DECLINING'
  | 'COOLDOWN'
  | 'RETEST'
  | 'REJECTED'
  | 'ARCHIVED';

export type SearchTermLanguageAnalysis = {
  rawTerm: string;
  normalizedTerm: string;
  canonicalTerm: string;
  normalizationFlags: string[];
  protectedTokens: string[];
  possibleTypo: boolean;
  possibleAbbreviation: boolean;
};

const ABBREVIATIONS: Record<string, string> = {
  'p': 'para',
  'p/': 'para',
  'pro': 'para o',
  'pra': 'para',
  'c': 'com',
  'c/': 'com',
  's': 'sem',
  's/': 'sem',
  'vc': 'voce',
  'tbm': 'tambem',
};

const COMMON_TYPOS: Record<string, string> = {
  'lixera': 'lixeira',
  'lixiera': 'lixeira',
  'eletroncia': 'eletronica',
  'eletonica': 'eletronica',
  'automaticaa': 'automatica',
};

const PROTECTED_PATTERNS = [
  /\b(?:nao|sem|com)\b/g,
  /\b\d{1,3}\s*l\b/g,
  /\b(?:inox|plastico|preta|branca|cinza|banheiro|cozinha|escritorio|quarto|sensor|automatica|alexa|wifi|biometria)\b/g,
  /\bporta\s+(?:de\s+)?(?:vidro|madeira|correr)\b/g,
];

function tokenize(value: string): string[] {
  return normalizeSearchTerm(value).split(' ').filter(Boolean);
}

export function analyzeSearchTermLanguage(value: unknown): SearchTermLanguageAnalysis {
  const rawTerm = String(value || '').trim();
  const normalizedTerm = normalizeSearchTerm(rawTerm);
  const flags = new Set<string>();
  let possibleTypo = false;
  let possibleAbbreviation = false;

  const expanded: string[] = [];
  for (const token of tokenize(normalizedTerm)) {
    const typo = COMMON_TYPOS[token];
    if (typo) {
      expanded.push(typo);
      possibleTypo = true;
      flags.add('TYPO_CORRECTION');
      continue;
    }
    const abbreviation = ABBREVIATIONS[token];
    if (abbreviation) {
      expanded.push(...abbreviation.split(' '));
      possibleAbbreviation = true;
      flags.add('ABBREVIATION_EXPANSION');
      continue;
    }
    expanded.push(token);
  }

  const canonicalTerm = expanded.join(' ').replace(/\s+/g, ' ').trim();
  if (canonicalTerm !== normalizedTerm) flags.add('LINGUISTIC_NORMALIZATION');
  if (rawTerm && rawTerm.toLowerCase() !== normalizedTerm) flags.add('ACCENT_OR_CASE_NORMALIZATION');

  const protectedTokens = new Set<string>();
  for (const pattern of PROTECTED_PATTERNS) {
    for (const match of canonicalTerm.matchAll(pattern)) {
      if (match[0]) protectedTokens.add(match[0]);
    }
  }

  return {
    rawTerm,
    normalizedTerm,
    canonicalTerm,
    normalizationFlags: [...flags],
    protectedTokens: [...protectedTokens].sort(),
    possibleTypo,
    possibleAbbreviation,
  };
}

export function termFamilyKey(value: unknown): string {
  return analyzeSearchTermLanguage(value).canonicalTerm;
}

export function hasHardAttributeConflict(source: unknown, candidate: unknown): boolean {
  const a = new Set(analyzeSearchTermLanguage(source).protectedTokens);
  const b = new Set(analyzeSearchTermLanguage(candidate).protectedTokens);

  const sizesA = [...a].filter((v) => /^\d{1,3}\s*l$/.test(v));
  const sizesB = [...b].filter((v) => /^\d{1,3}\s*l$/.test(v));
  if (sizesA.length && sizesB.length && !sizesA.some((v) => sizesB.includes(v))) return true;

  const exclusiveGroups = [
    ['inox', 'plastico'],
    ['preta', 'branca', 'cinza'],
    ['banheiro', 'cozinha', 'escritorio', 'quarto'],
    ['porta vidro', 'porta madeira', 'porta correr'],
  ];
  for (const group of exclusiveGroups) {
    const left = group.filter((v) => a.has(v));
    const right = group.filter((v) => b.has(v));
    if (left.length && right.length && !left.some((v) => right.includes(v))) return true;
  }

  if ((a.has('sem') && b.has('com')) || (a.has('com') && b.has('sem'))) return true;
  return false;
}

export function lifecycleFromEvidence(input: {
  sameSkuOrders: number;
  clicks: number;
  spend: number;
  sameSkuSales: number;
  alreadyExact: boolean;
  isolatedWinner?: boolean;
  declining?: boolean;
  cooldown?: boolean;
}): TermMaturityStage {
  if (input.cooldown) return 'COOLDOWN';
  if (input.declining) return 'DECLINING';
  if (input.isolatedWinner) return 'ISOLATED';
  if (input.sameSkuOrders >= 3 && input.sameSkuSales > 0) return 'PROVEN';
  if (input.alreadyExact && input.sameSkuOrders > 0) return 'MANUAL_CLUSTERED';
  if (input.sameSkuOrders > 0) return 'QUALIFIED';
  return 'DISCOVERED';
}

export function shouldEscalateToAi(input: {
  isNew?: boolean;
  sameSkuOrders?: number;
  significantSpendChange?: boolean;
  significantCvrChange?: boolean;
  matureZeroConversion?: boolean;
  winnerCandidate?: boolean;
  decliningWinner?: boolean;
  intentAmbiguity?: boolean;
  crossAsinOpportunity?: boolean;
  temporalEligibility?: boolean;
  semanticConflict?: boolean;
}): boolean {
  return Boolean(
    input.decliningWinner ||
    input.winnerCandidate ||
    input.semanticConflict ||
    input.intentAmbiguity ||
    input.crossAsinOpportunity ||
    input.temporalEligibility ||
    input.matureZeroConversion ||
    input.significantCvrChange ||
    input.significantSpendChange ||
    (input.isNew && Number(input.sameSkuOrders || 0) > 0)
  );
}
