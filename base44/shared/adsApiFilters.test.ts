import { assertEquals } from 'jsr:@std/assert@1';
import { includeFilter } from './adsApiFilters.ts';

Deno.test('Amazon Ads v3 include filters serialize as objects', () => {
  assertEquals(includeFilter(['ENABLED', 'PAUSED']), { include: ['ENABLED', 'PAUSED'] });
});

Deno.test('include filters copy caller arrays', () => {
  const values = ['AUTO'];
  const filter = includeFilter(values);
  values.push('MANUAL');
  assertEquals(filter, { include: ['AUTO'] });
});
