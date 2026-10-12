import { readAllEntityPages } from './v6siaEvidencePaging.ts';

Deno.test('V6SIA reads every cursor page and deduplicates stable record IDs without truncation', async () => {
  const all = Array.from({ length: 2350 }, (_, index) => ({ id: `row-${index}`, value: index }));
  let calls = 0;
  const entity = { filter: async (_query: any, options: any) => {
    calls++;
    const start = options.cursor ? Number(options.cursor) : 0;
    const items = all.slice(start, start + options.limit);
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

Deno.test('V6SIA refuses a legacy array at the page limit because more data may be hidden', async () => {
  const result = await readAllEntityPages({ filter: async () => [{ id: 'one' }, { id: 'two' }] }, {}, '-date', 2);
  if (result.complete || result.rows?.length !== 2) throw new Error('exact-limit legacy response may be truncated');
});
