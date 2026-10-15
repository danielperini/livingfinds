export type EvidencePageRead<T> = {
  rows: T[] | null;
  error: string | null;
  complete: boolean;
};

export async function readAllEntityPages<T extends Record<string, unknown>>(
  entity: { filter: (...args: any[]) => Promise<any> },
  query: Record<string, unknown>,
  sort: string,
  pageSize = 1000,
): Promise<EvidencePageRead<T>> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let offset = 0;
  const seenCursors = new Set<string>();
  const pageFingerprints = new Set<string>();
  const safePageSize = Math.max(1, Math.min(1000, Math.floor(pageSize) || 1000));
  const maxPages = 100;
  try {
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
      // Hostinger's EntityRepo.filter contract is (query, sort, limit, offset).
      // Never pass cursor/options objects as the sort argument: it reaches
      // buildOrder(sort).startsWith() and fails the whole evidence snapshot.
      const page: any = await entity.filter(query, sort, safePageSize, offset);
      const items = Array.isArray(page) ? page : Array.isArray(page?.items) ? page.items as T[] : null;
      if (!items) return { rows: rows.length ? rows : null, error: 'Resposta de paginação inválida; consulta incompleta', complete: false };
      const fingerprint = items.map((item: T) => String(item?.id || JSON.stringify(item))).join('|');
      if (items.length && pageFingerprints.has(fingerprint)) {
        return { rows, error: 'A paginação repetiu uma página; consulta incompleta', complete: false };
      }
      if (items.length) pageFingerprints.add(fingerprint);
      for (const item of items) {
        const id = String(item?.id || '');
        if (!id) return { rows: rows.length ? rows : null, error: 'Registro sem identificador estável; deduplicação impossível e consulta incompleta', complete: false };
        if (!seen.has(id)) { rows.push(item); seen.add(id); }
      }
      offset += items.length;
      if (!Array.isArray(page) && page.has_more === true) {
        if (!items.length) return { rows, error: 'A paginação informou mais dados sem avançar o offset; consulta incompleta', complete: false };
        const next = String(page.next_cursor || '');
        if (!next) return { rows, error: 'Cursor ausente; consulta incompleta', complete: false };
        if (seenCursors.has(next)) return { rows, error: 'Cursor repetido; consulta incompleta', complete: false };
        seenCursors.add(next);
        continue;
      } else if (!Array.isArray(page) && page.has_more === false) {
        return { rows, error: null, complete: true };
      }
      if (items.length < safePageSize) return { rows, error: null, complete: true };
    }
    return { rows, error: `Limite de paginação atingido (${maxPages} páginas); consulta incompleta`, complete: false };
  } catch (error: any) {
    return { rows: rows.length ? rows : null, error: String(error?.message || error), complete: false };
  }
}
