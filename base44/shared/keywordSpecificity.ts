/**
 * keywordSpecificity.ts — Filtro determinístico de especificidade de palavras-chave.
 *
 * Objetivo (entregável #2): bloquear termos curtos/genéricos (ex.: "café elétrico") de virarem
 * campanhas manuais dedicadas, favorecendo cauda média/longa (long-tail) mais específica.
 *
 * É uma função PURA (sem I/O) — fácil de testar e de calibrar. Toda rejeição devolve `reasons`
 * legíveis, para registrar POR QUE o termo foi barrado (sinergia com o log de decisão, #4).
 *
 * Os limiares são configuráveis via AutopilotConfig, para o Daniel calibrar sem mexer no código:
 *   keyword_min_words, keyword_min_chars, keyword_specificity_threshold, generic_keyword_blocklist
 */

export interface SpecificityConfig {
  minWords: number;
  minChars: number;
  threshold: number;
  blocklist: string[];
}

export const DEFAULT_SPECIFICITY_CONFIG: SpecificityConfig = {
  minWords: 2, // termos de 1 palavra são head-terms genéricos por natureza
  minChars: 6,
  threshold: 2, // pontuação mínima de especificidade para aprovar
  // Termos comerciais universalmente genéricos (NÃO inclui categorias específicas de propósito —
  // o Daniel pode adicionar "café", "cafeteira" etc. via AutopilotConfig.generic_keyword_blocklist).
  blocklist: [
    'produto', 'produtos', 'item', 'itens', 'coisa', 'coisas', 'comprar', 'compra',
    'barato', 'barata', 'baratos', 'melhor', 'melhores', 'oferta', 'ofertas',
    'promocao', 'promocao', 'loja', 'online', 'frete', 'gratis', 'gratis', 'kit',
    'novo', 'nova', 'original', 'qualidade', 'preco', 'preco', 'top', 'bom', 'boa',
  ],
};

export interface SpecificityResult {
  specific: boolean;
  score: number;
  wordCount: number;
  charLen: number;
  hasDigit: boolean;
  allGeneric: boolean;
  reasons: string[];
}

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

function normalize(term: string): string {
  return stripAccents(String(term ?? '').toLowerCase())
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Avalia a especificidade de um termo. `specific=false` => deve ser barrado, com `reasons`.
 */
export function evaluateKeywordSpecificity(
  term: string,
  config: Partial<SpecificityConfig> = {},
): SpecificityResult {
  const cfg: SpecificityConfig = { ...DEFAULT_SPECIFICITY_CONFIG, ...config };
  const norm = normalize(term);
  const tokens = norm ? norm.split(' ') : [];
  const wordCount = tokens.length;
  const charLen = norm.replace(/\s/g, '').length;
  const hasDigit = /\d/.test(norm);

  const blockset = new Set(cfg.blocklist.map((w) => normalize(w)));
  const nonGeneric = tokens.filter((t) => !blockset.has(t));
  const allGeneric = wordCount > 0 && nonGeneric.length === 0;

  const reasons: string[] = [];
  let score = 0;

  if (wordCount >= 3) score += 2;
  else if (wordCount === 2) score += 1;
  else reasons.push('termo de 1 palavra (head-term genérico)');

  if (hasDigit) score += 1; // números costumam indicar especificação (voltagem, tamanho, quantidade)
  if (charLen >= 15) score += 1;

  if (allGeneric) {
    score -= 2;
    reasons.push('todos os termos estão na blocklist de genéricos');
  }
  if (wordCount <= 2 && !hasDigit && nonGeneric.length <= 1) {
    score -= 1;
    reasons.push('curto, sem especificação (número/atributo) e pouca substância');
  }

  const belowMinWords = wordCount < cfg.minWords;
  const belowMinChars = charLen < cfg.minChars;
  if (belowMinWords) reasons.push(`menos de ${cfg.minWords} palavras`);
  if (belowMinChars) reasons.push(`menos de ${cfg.minChars} caracteres`);

  const specific = !belowMinWords && !belowMinChars && score >= cfg.threshold;
  if (!specific && score < cfg.threshold) {
    reasons.push(`especificidade ${score} abaixo do mínimo ${cfg.threshold}`);
  }

  return { specific, score, wordCount, charLen, hasDigit, allGeneric, reasons };
}

/** Lê a config de especificidade a partir de um registro AutopilotConfig (com defaults). */
// deno-lint-ignore no-explicit-any
export function specificityConfigFrom(ap: any): Partial<SpecificityConfig> {
  const out: Partial<SpecificityConfig> = {};
  if (typeof ap?.keyword_min_words === 'number') out.minWords = ap.keyword_min_words;
  if (typeof ap?.keyword_min_chars === 'number') out.minChars = ap.keyword_min_chars;
  if (typeof ap?.keyword_specificity_threshold === 'number') out.threshold = ap.keyword_specificity_threshold;
  if (Array.isArray(ap?.generic_keyword_blocklist) && ap.generic_keyword_blocklist.length) {
    // mescla a blocklist do usuário com a padrão
    out.blocklist = [...DEFAULT_SPECIFICITY_CONFIG.blocklist, ...ap.generic_keyword_blocklist];
  }
  return out;
}
