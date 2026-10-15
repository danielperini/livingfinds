import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = (name) => readFileSync(
  new URL(`../../.github/workflows/${name}`, import.meta.url),
  'utf8',
);

test('deploy does not automatically trigger campaign recovery or bid reconciliation', () => {
  const recovery = workflow('recover-stale-campaigns.yml');
  const reconciliation = workflow('repair-bid-confirmations-after-deploy.yml');

  assert.doesNotMatch(recovery, /^\s+workflow_run:/m);
  assert.match(recovery, /^\s+workflow_dispatch:/m);
  assert.doesNotMatch(reconciliation, /^\s+workflow_run:/m);
  assert.match(reconciliation, /^\s+workflow_dispatch:/m);
});

test('campaign budget cap retains its schedule without a deploy hook', () => {
  const budgetCap = workflow('enforce-campaign-budget-cap.yml');

  assert.doesNotMatch(budgetCap, /^\s+workflow_run:/m);
  assert.match(budgetCap, /^\s+workflow_dispatch:/m);
  assert.match(budgetCap, /^\s+- cron: '\*\/30 \* \* \* \*'$/m);
});
