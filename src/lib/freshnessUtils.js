// ═══════════════════════════════════════════════════════════════════════════
// freshnessUtils.js — funções puras de tempo (sem dependências externas).
// Usado por DataFreshnessBadge e por qualquer card/tabela que queira exibir
// a origem e a idade de um dado.
// ═══════════════════════════════════════════════════════════════════════════

const HOUR_MS = 3600000;
const DAY_MS = 86400000;

/**
 * Classifica a idade de um timestamp em 3 níveis semânticos.
 * @param {string|number|Date|null} timestamp
 * @returns {{ level: 'fresh'|'stale'|'critical'|'unknown', ageMs: number|null }}
 *   fresh    => atualizado há menos de 6h
 *   stale    => entre 6h e 24h
 *   critical => mais de 24h (ou nulo/inválido)
 *   unknown  => timestamp ausente ou inválido (tratado como crítico visual)
 */
export function getFreshnessLevel(timestamp) {
  if (timestamp === null || timestamp === undefined || timestamp === '') {
    return { level: 'unknown', ageMs: null };
  }
  const ms = safeToMs(timestamp);
  if (ms === null) return { level: 'unknown', ageMs: null };

  const ageMs = Date.now() - ms;
  if (ageMs < 0) return { level: 'fresh', ageMs }; // data no futuro — considera fresco
  if (ageMs < 6 * HOUR_MS) return { level: 'fresh', ageMs };
  if (ageMs < 24 * HOUR_MS) return { level: 'stale', ageMs };
  return { level: 'critical', ageMs };
}

/**
 * Formata idade relativa em pt-BR: "agora mesmo", "há 5 min", "há 3h", "há 2 dias".
 * @param {string|number|Date|null} timestamp
 * @returns {string}
 */
export function formatRelativeTime(timestamp) {
  if (timestamp === null || timestamp === undefined || timestamp === '') return '—';
  const ms = safeToMs(timestamp);
  if (ms === null) return '—';

  const diff = Date.now() - ms;
  if (diff < 0) return 'agora mesmo'; // futuro
  if (diff < 60 * 1000) return 'agora mesmo';
  if (diff < 3600 * 1000) {
    const min = Math.floor(diff / 60000);
    return `há ${min} min`;
  }
  if (diff < 24 * 3600 * 1000) {
    const h = Math.floor(diff / 3600000);
    return `há ${h}h`;
  }
  const days = Math.floor(diff / DAY_MS);
  if (days === 1) return 'há 1 dia';
  if (days < 30) return `há ${days} dias`;
  const months = Math.floor(days / 30);
  if (months === 1) return 'há 1 mês';
  if (months < 12) return `há ${months} meses`;
  const years = Math.floor(days / 365);
  return years === 1 ? 'há 1 ano' : `há ${years} anos`;
}

/**
 * Formata timestamp exato para o tooltip (pt-BR, timezone do navegador).
 * @param {string|number|Date|null} timestamp
 * @returns {string}
 */
export function formatExactTimestamp(timestamp) {
  if (timestamp === null || timestamp === undefined || timestamp === '') return '—';
  const ms = safeToMs(timestamp);
  if (ms === null) return '—';
  return new Date(ms).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ─── helpers internos ───────────────────────────────────────────────────────

function safeToMs(timestamp) {
  if (timestamp instanceof Date) return isNaN(timestamp.getTime()) ? null : timestamp.getTime();
  if (typeof timestamp === 'number') return isNaN(timestamp) ? null : timestamp;
  if (typeof timestamp === 'string') {
    const t = timestamp.trim();
    if (!t) return null;
    const parsed = Date.parse(t);
    return isNaN(parsed) ? null : parsed;
  }
  return null;
}