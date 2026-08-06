import { base44 } from '@/api/base44Client';

/**
 * Remove o teto visual de 1.000 keywords/termos nas leituras analíticas.
 * Pagina até a origem não retornar novos registros, preservando a ordenação
 * solicitada e impedindo loops/duplicidades caso o backend ignore o offset.
 */
export function installUnlimitedKeywordReads() {
  if (typeof window === 'undefined' || window.__livingfindsUnlimitedKeywordReadsInstalled) return;

  const entity = base44?.entities?.Keyword;
  if (!entity || typeof entity.filter !== 'function') return;

  window.__livingfindsUnlimitedKeywordReadsInstalled = true;
  const originalFilter = entity.filter.bind(entity);

  entity.filter = async (query = {}, sort = null, limit = undefined, offset = undefined) => {
    const requestedLimit = Number(limit || 0);
    const shouldLoadAll = requestedLimit >= 1000 && (offset == null || Number(offset) === 0);
    if (!shouldLoadAll) return originalFilter(query, sort, limit, offset);

    const pageSize = 1000;
    const all = [];
    const seen = new Set();
    let pageOffset = 0;

    while (true) {
      const page = await originalFilter(query, sort, pageSize, pageOffset);
      if (!Array.isArray(page) || page.length === 0) break;

      let newRecords = 0;
      for (const row of page) {
        const key = row?.id || row?.keyword_id || `${row?.campaign_id || ''}:${row?.ad_group_id || ''}:${row?.keyword_text || row?.keyword || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(row);
        newRecords += 1;
      }

      if (page.length < pageSize || newRecords === 0) break;
      pageOffset += pageSize;
    }

    return all;
  };
}
