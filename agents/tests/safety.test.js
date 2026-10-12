import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { guardAgentAction, isAgentActionAllowed } from '../guardrails/production.js';
import { readRepositoryFile, resolveRepositoryFile, proposeRepositoryPatch } from '../tools/repository.js';
import { runAllowlistedTests, safeTestEnvironment } from '../tools/tests.js';
import { inspectRuntimeConfiguration, inspectVpsHealth } from '../tools/diagnostics.js';
import { createLivingFindsEngineer } from '../livingfindsEngineer.js';

test('allowlist admits read-only capabilities and blocks protected actions', () => {
  assert.equal(isAgentActionAllowed('read_repository_file'), true);
  for (const action of ['amazon_campaign_write', 'amazon_budget_or_bid_change', 'database_write', 'secret_access', 'deploy', 'main_branch_write', 'destructive_filesystem_operation', 'arbitrary_shell']) {
    assert.equal(isAgentActionAllowed(action), false, action);
    assert.equal(guardAgentAction(action).status, 'blocked');
  }
});

test('repository reader rejects traversal, secrets, and partial large files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lf-agent-'));
  try {
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'ok.ts'), 'export const ok = true;');
    await writeFile(path.join(root, '.env'), 'SECRET=do-not-read');
    await writeFile(path.join(root, 'src', 'large.ts'), 'x'.repeat(64 * 1024 + 1));
    await writeFile(path.join(root, 'private.md'), 'internal secret');
    await (await import('node:fs/promises')).symlink(path.join(root, 'private.md'), path.join(root, 'src', 'alias.ts'));
    assert.equal((await readRepositoryFile('src/ok.ts', root)).content, 'export const ok = true;');
    assert.equal(resolveRepositoryFile('../outside.ts', root).status, 'blocked');
    assert.equal(resolveRepositoryFile('.env', root).status, 'blocked');
    assert.equal((await readRepositoryFile('src/large.ts', root)).status, 'not_read');
    assert.equal((await readRepositoryFile('src/alias.ts', root)).status, 'blocked');
    const proposal = await proposeRepositoryPatch({ path: 'src/ok.ts', rationale: 'test', diff: '--- a/src/ok.ts' });
    assert.equal(proposal.written, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('test runner accepts only fixed safe suites and strips unrelated process secrets', async () => {
  const env = safeTestEnvironment({ PATH: '/bin', OPENAI_API_KEY: 'must-not-pass', DATABASE_URL: 'must-not-pass' });
  assert.deepEqual(env, { CI: '1', PATH: '/bin' });
  assert.equal((await runAllowlistedTests('unknown')).status, 'blocked');
  assert.equal((await runAllowlistedTests('v6sia')).command.startsWith('deno test '), true);
});

test('diagnostics disclose configuration presence only and do not call an unset health URL', async () => {
  const result = inspectRuntimeConfiguration({ OPENAI_API_KEY: 'secret', DATABASE_URL: 'postgres://secret' });
  assert.equal(result.checks.openai_api_key_present, true);
  assert.equal(result.checks.database_url_present, true);
  assert.equal(JSON.stringify(result).includes('postgres://secret'), false);\n  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
  assert.equal((await inspectVpsHealth({})).status, 'not_configured');
});

test('SDK agent has a fixed model persona and no Amazon, DB-write, deployment or shell tools', () => {
  const agent = createLivingFindsEngineer();
  assert.equal(agent.name, 'Living Finds Principal Engineer');
  assert.equal(agent.model, 'gpt-6-luna');
  const names = agent.tools.map((item) => item.name);
  assert.deepEqual(names, [
    'read_repository_file',
    'propose_patch',
    'run_allowlisted_tests',
    'inspect_github_actions',
    'inspect_vps_health',
    'inspect_runtime_configuration',
  ]);
  assert.equal(names.some((name) => /amazon.*write|database.*write|deploy|shell/i.test(name)), false);
});
