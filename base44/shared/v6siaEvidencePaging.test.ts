import { readAllEntityPages } from './v6siaEvidencePaging.ts';

Deno.test('V6SIA reads every cursor page and deduplicates stable record IDs without truncation', async () => {
  const all = Array.from({ length: 2350 }, (_, index) => ({ id: `row-${index}`, value: index }));
  let calls = 0;
  const entity = { filter: async (_query: any, options: any, positionalLimit?: number) => {
    calls++;
    const cursor = typeof options === 'object' ? options.cursor : null;
    const limit = typeof options === 'string' ? positionalLimit : options.limit;
    const start = cursor ? Number(cursor) : 0;
    const items = all.slice(start, start + limit);
    const end = start + items.length;
    return { items, has_more: end < all.length, next_cursor: end < all.length ? String(end) : null };
  } };
  const result = await readAllEntityPages(entity, { amazon_account_id: 'a1' }, '-date', 1000);
  if (!result.complete || result.rows?.length !== 2350 || calls !== 3) throw new Error('all rows and pages must be read');
});

Deno.test('V6SIA marks a failed later page incomplete and preserves rows already read', async () => {
  let calls = 0;
  const entity = { filter: async () => {
    calls++;
    if (calls === 1) return { items: Array.from({ length: 3 }, (_, i) => ({ id: `r${i}` })), has_more: true, next_cursor: 'next' };
    throw new Error('temporary database failure');
  } };
  const result = await readAllEntityPages(entity, {}, '-date', 3);
  if (result.complete || result.rows?.length !== 3 || !result.error) throw new Error('partial reads must never appear complete');
});

Deno.test('V6SIA rejects missing or repeating cursors instead of silently dropping later pages', async () => {
  const noCursor = await readAllEntityPages({ filter: async () => ({ items: [{ id: 'one' }], has_more: true }) }, {}, '-date', 1);
  const repeating = await readAllEntityPages({ filter: async (_q: any, options: any) => ({ items: [{ id: options.cursor ? 'two' : 'one' }], has_more: true, next_cursor: 'same' }) }, {}, '-date', 1);
  if (noCursor.complete || repeating.complete || !noCursor.error || !repeating.error) throw new Error('cursor failure must be explicit');
});

Deno.test('Hostinger entity filters receive positional sort/limit/offset and all array pages are read', async () => {
  const all = Array.from({ length: 5 }, (_, index) => ({ id: `row-${index}` }));
  const offsets: number[] = [];
  const entity = { filter: async (_query: any, order: any, limit: any, offset: any) => {
    if (typeof order !== 'string' || order !== '-date' || limit !== 2) throw new Error('wrong Hostinger filter arguments');
    offsets.push(offset);
    return all.slice(offset, offset + limit);
  } };
  const result = await readAllEntityPages(entity, {}, '-date', 2);
  if (!result.complete || result.rows?.length !== 5 || offsets.join(',') !== '0,2,4') throw new Error('all offset pages must be read');
});

Deno.test('Hostinger offset pagination deduplicates records across overlapping pages', async () => {
  let calls = 0;
  const result = await readAllEntityPages({ filter: async () => {
    calls++;
    return calls === 1 ? [{ id: 'one' }, { id: 'two' }] : [{ id: 'two' }];
  } }, {}, '-date', 2);
  if (!result.complete || result.rows?.length !== 2) throw new Error('duplicate IDs must be removed');
});

Deno.test('Hostinger offset pagination detects a repeated full page', async () => {
  const result = await readAllEntityPages({ filter: async () => [{ id: 'one' }, { id: 'two' }] }, {}, '-date', 2);
  if (result.complete || result.rows?.length !== 2 || !result.error) throw new Error('repeated full page must be incomplete');
});
