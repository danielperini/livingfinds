import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/proactive-growth-cycle.yml', import.meta.url), 'utf8');

test('scheduled growth uses durable run IDs for analysis, execution, and confirmation', () => {
  const start = workflow.indexOf('const startRun = async');
  const engine = workflow.indexOf('const engineRunId = await startRun');
  const execute = workflow.indexOf('const executionRunId = await startRun');
  const confirm = workflow.indexOf('const confirmationRunId = await startRun');
  assert.ok(start >= 0 && engine > start && execute > engine && confirm > execute);
  assert.ok(workflow.includes('/api/motor-runs'));
  assert.ok(workflow.includes('/api/motor-runs/'));
  assert.ok(workflow.includes('method: \\"POST\\"'));
  assert.match(workflow, /MOTOR_RUN_PROGRESS=/);
});

test('partial analysis keeps the existing revalidated queue drain, while unknown outcomes are not replayed', () => {
  assert.match(workflow, /\[\\"partial\\", \\"failed\\"\].includes\(engineRun.status\)/);
  assert.match(workflow, /decisão aprovada é revalidada individualmente pelo executor/);
  assert.match(workflow, /\[\\"interrupted\\", \\"remote_unknown\\"\].includes\(executionRun.status\)/);
  assert.match(workflow, /sem repetição automática/);
});

test('scheduled workflow is serialized, bounded, and emits a consultable timeout', () => {
  assert.match(workflow, /cron: '15 10,18 \* \* \*'/);
  assert.match(workflow, /group: deploy-vps[\s\S]*?cancel-in-progress: false/);
  assert.match(workflow, /timeout-minutes: 90/);
  assert.match(workflow, /25 \* 60 \* 1000/);
  assert.match(workflow, /execução continua consultável e não será reenviada/);
  assert.match(workflow, /\$1=\[redacted\]/);
});
