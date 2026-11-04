import { assertEquals } from 'jsr:@std/assert@1';
import { aiTaskPolicy, selectAiModel } from './aiModelPolicy.ts';

Deno.test('usa modelo complexo configurado para revisão de decisões', () => {
  assertEquals(selectAiModel('complex_decision', 'modelo-complexo'), 'modelo-complexo');
  assertEquals(aiTaskPolicy('complex_decision').proposal_only, true);
});
Deno.test('usa modelo econômico padrão para análise repetitiva', () => {
  assertEquals(selectAiModel('repetitive_analysis'), 'gpt-4o-mini');
});
