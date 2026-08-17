/**
 * Testes do filtro de especificidade (entregável #2).
 * Rodar: deno test base44/shared/keywordSpecificity.test.ts
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { evaluateKeywordSpecificity } from './keywordSpecificity.ts';

Deno.test('bloqueia termo curto/genérico do briefing: "café elétrico"', () => {
  const r = evaluateKeywordSpecificity('café elétrico');
  assertEquals(r.specific, false);
  assert(r.reasons.length > 0);
});

Deno.test('bloqueia termo de 1 palavra genérico: "produto"', () => {
  assertEquals(evaluateKeywordSpecificity('produto').specific, false);
});

Deno.test('bloqueia "kit" (1 palavra, blocklist)', () => {
  assertEquals(evaluateKeywordSpecificity('kit').specific, false);
});

Deno.test('bloqueia string vazia', () => {
  assertEquals(evaluateKeywordSpecificity('').specific, false);
});

Deno.test('aprova long-tail com especificação: "cafeteira elétrica 220v inox 15 xícaras"', () => {
  const r = evaluateKeywordSpecificity('cafeteira elétrica 220v inox 15 xícaras');
  assertEquals(r.specific, true);
});

Deno.test('aprova long-tail sem número: "cafeteira elétrica programável preta"', () => {
  assertEquals(evaluateKeywordSpecificity('cafeteira elétrica programável preta').specific, true);
});

Deno.test('aprova 2 palavras com número: "cafeteira 220v"', () => {
  // 2 palavras (+1) + dígito (+1) = 2 >= threshold
  assertEquals(evaluateKeywordSpecificity('cafeteira 220v').specific, true);
});

Deno.test('config customizada: Daniel adiciona categoria à blocklist', () => {
  const cfg = { blocklist: ['produto', 'cafeteira', 'café', 'cafe'] };
  // "cafeteira elétrica" vira só 1 token não-genérico -> penalizado
  const r = evaluateKeywordSpecificity('cafeteira elétrica', cfg);
  assertEquals(r.specific, false);
});

Deno.test('threshold customizado mais rígido barra mais', () => {
  const strict = evaluateKeywordSpecificity('cafeteira 220v', { threshold: 3 });
  assertEquals(strict.specific, false);
});

Deno.test('reasons explicam o bloqueio (auditoria #4)', () => {
  const r = evaluateKeywordSpecificity('café elétrico');
  assert(r.reasons.some((x) => x.includes('especificidade')));
});
