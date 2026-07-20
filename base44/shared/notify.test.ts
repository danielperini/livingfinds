/**
 * Testes do notificador Discord (#5 / notificações). Rodar: deno test base44/shared/notify.test.ts
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { buildDiscordPayload } from './notify.ts';

const TS = '2026-07-17T03:00:00.000Z';

Deno.test('monta embed com título, cor e timestamp', () => {
  const p = buildDiscordPayload({ title: 'Reconexão necessária', message: 'Token caiu', level: 'error' }, TS);
  assertEquals(p.embeds[0].color, 15158332);
  assert(p.embeds[0].title.includes('Reconexão necessária'));
  assertEquals(p.embeds[0].timestamp, TS);
});

Deno.test('nível error usa emoji de alerta', () => {
  const p = buildDiscordPayload({ title: 'x', message: 'y', level: 'error' }, TS);
  assert(p.embeds[0].title.startsWith('🚨'));
});

Deno.test('campos viram fields do embed (máx 25)', () => {
  const fields = Array.from({ length: 30 }, (_, i) => ({ name: `n${i}`, value: `v${i}` }));
  const p = buildDiscordPayload({ title: 't', message: 'm', fields }, TS);
  assertEquals(p.embeds[0].fields.length, 25);
  assertEquals(p.embeds[0].fields[0].name, 'n0');
});

Deno.test('nível default é info (azul)', () => {
  const p = buildDiscordPayload({ title: 't', message: 'm' }, TS);
  assertEquals(p.embeds[0].color, 3447003);
});
