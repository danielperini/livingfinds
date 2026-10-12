import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/proactive-growth-cycle.yml', import.meta.url), 'utf8');

test('daily growth cycle drains and confirms approved work even when analysis reports a partial failure', () => {
  const engine = workflow.indexOf('const engineResult = await call(');
  const execute = workflow.indexOf('const executionResult = await call(');
  const confirm = workflow.indexOf('const confirmationResult = await call(');
  assert.ok(engine >= 0 && execute > engine && confirm > execute, 'engine, queue drain and confirmation must run in order');
  assert.match(workflow, /const problems = \[\];/);
  assert.match(workflow, /const review = await call\(\\"superviseV6SIA\\"/);
  assert.doesNotMatch(workflow, /if\s*\(!engineResult\.ok\)\s*throw/);
});

test('daily cycle is serialized, bounded, and redacts operational failure details', () => {
  assert.match(workflow, /cron: '15 10,18 \* \* \*'/);
  assert.match(workflow, /group: proactive-campaign-growth-cycle[\s\S]*?cancel-in-progress: false/);
  assert.match(workflow, /timeout-minutes: 45/);
  assert.match(workflow, /const safeText = value[\s\S]*?\[redacted\]/);
  assert.match(workflow, /correlation_id: cycleId/);
});
