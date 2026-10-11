import { assertEquals } from 'jsr:@std/assert@1';
import { assessAutomationStage } from './adsAutomationHealth.ts';

const now = Date.parse('2026-10-11T15:00:00.000Z');
const row = (operation: string, status: string, at: string, extra: Record<string, unknown> = {}) => ({
  operation, status, completed_at: at, ...extra,
});

Deno.test('does not use its own audit log as stage evidence', () => {
  assertEquals(assessAutomationStage([
    row('ads_automation_e2e_audit', 'success', '2026-10-11T14:59:00.000Z'),
  ], 'intraday_ads_report:persist', 45, now).state, 'unknown');
});

Deno.test('uses the newest matching stage record and ignores another stage', () => {
  const stage = assessAutomationStage([
    row('intraday_ads_report:request', 'success', '2026-10-11T14:50:00.000Z'),
    row('intraday_ads_report:persist', 'failed', '2026-10-11T14:58:00.000Z'),
    row('ads_decision_execution', 'success', '2026-10-11T14:59:00.000Z'),
  ], 'intraday_ads_report:persist', 45, now);
  assertEquals(stage.state, 'failed');
});

Deno.test('reports stale and absent evidence explicitly', () => {
  assertEquals(assessAutomationStage([
    row('confirm_executed_decisions', 'success', '2026-10-11T13:00:00.000Z'),
  ], 'confirm_executed_decisions', 45, now).state, 'stale');
  assertEquals(assessAutomationStage([], 'confirm_executed_decisions', 45, now).state, 'unknown');
});

Deno.test('distinguishes successful no-action cycles from failures', () => {
  assertEquals(assessAutomationStage([
    row('ads_decision_execution', 'success', '2026-10-11T14:59:00.000Z', { result_summary: '0 executadas, 0 com erro, 0 agendadas' }),
  ], 'ads_decision_execution', 45, now).state, 'no_actions');
  assertEquals(assessAutomationStage([
    row('ads_decision_execution', 'error', '2026-10-11T14:59:00.000Z'),
  ], 'ads_decision_execution', 45, now).state, 'failed');
});
