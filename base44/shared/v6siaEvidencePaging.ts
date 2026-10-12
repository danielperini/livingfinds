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
  let cursor: string | null = null;
  try {
    while (true) {
      const page = cursor
        ? await entity.filter(query, { cursor, limit: pageSize })
        : await entity.filter(query, { sort, limit: pageSize });
      if (Array.isArray(page)) {
        for (const item of page as T[]) {
          const id = String(item?.id || '');
          if (!id || !seen.has(id)) { rows.push(item); if (id) seen.add(id); }
        }
        if (page.length >= pageSize) {
          return { rows, error: 'SDK não retornou cursor após atingir o limite da página; consulta incompleta', complete: false };
        }
        return { rows, error: null, complete: true };
      }
      const items = Array.isArray(page?.items) ? page.items as T[] : null;
      if (!items) return { rows: rows.length ? rows : null, error: 'Resposta de paginação inválida; consulta incompleta', complete: false };
      for (const item of items) {
        const id = String(item?.id || '');
        if (!id || !seen.has(id)) { rows.push(item); if (id) seen.add(id); }
      }
      if (!page.has_more) return { rows, error: null, complete: true };
      const next = String(page.next_cursor || '');
      if (!next || next === cursor) return { rows, error: 'Cursor ausente ou repetido; consulta incompleta', complete: false };
      cursor = next;
    }
  } catch (error: any) {
    return { rows: rows.length ? rows : null, error: String(error?.message || error), complete: false };
  }
}
