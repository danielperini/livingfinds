import { assertEquals } from 'jsr:@std/assert@1';
import { evaluateAiAutopilotGate } from './aiAutopilotPolicy.ts';

Deno.test('oportunidade exige 85%', () => {
  assertEquals(evaluateAiAutopilotGate({ action: 'increase_bid', confidence: 0.849 }).allowed, false);
  assertEquals(evaluateAiAutopilotGate({ action: 'increase_bid', confidence: 0.85 }).allowed, true);
});
Deno.test('prevenção de prejuízo exige 80%', () => {
  assertEquals(evaluateAiAutopilotGate({ action: 'reduce_bid', confidence: 79 }).allowed, false);
  assertEquals(evaluateAiAutopilotGate({ action: 'reduce_bid', confidence: 80 }).allowed, true);
});
Deno.test('ação neutra não é bloqueada por este gate', () => {
  assertEquals(evaluateAiAutopilotGate({ action: 'confirm_remote_state', confidence: 0 }).allowed, true);
});
