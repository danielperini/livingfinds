export const storage = new Map<string, any[]>();
export const sql = {
  async unsafe(query: string, params: any[] = []) {
    if (/^\s*CREATE/i.test(query)) return [];
    const table = query.match(/(?:FROM|INTO|UPDATE)\s+"([^"]+)"/i)?.[1];
    if (!table) throw new Error(`Unexpected SQL: ${query}`);
    const rows = storage.get(table) || [];
    if (/^SELECT/i.test(query)) {
      const idFilter = /"id" = \$1/.test(query);
      const matches = idFilter ? rows.filter(row => row.id === params[0]) : rows;
      const offset = Number(query.match(/OFFSET (\d+)/)?.[1] || 0);
      const limit = Number(query.match(/LIMIT (\d+)/)?.[1] || matches.length);
      return matches.slice(offset, offset + limit);
    }
    if (/^INSERT/i.test(query)) {
      const row = { id: params[0], data: params[2] };
      storage.set(table, [...rows.filter(item => item.id !== row.id), row]);
      return [row];
    }
    if (/^UPDATE/i.test(query)) {
      const row = rows.find(row => row.id === params[0]);
      if (!row) return [];
      row.data = { ...row.data, ...params[1] };
      return [row];
    }
    throw new Error(`Unexpected SQL: ${query}`);
  },
};
