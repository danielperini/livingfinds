import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyDeployReceipt } from './verify-deploy-receipt.mjs';
import { verifyPublicDeploy, requiredFunctions } from './verify-public-deploy.mjs';

const bash = process.env.BASH_TEST_PATH || (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
const sha = 'a'.repeat(40);
// docker compose exec -T attaches stdin even without a TTY. Simulate that behavior.
const script = `set -Eeuo pipefail\nprintf 'STARTED\\n'\nresult="$(cat >/dev/null; printf read_only)"\nprintf 'DEPLOY_VERIFIED_SHA=${sha}\\n'\n`;

const healthy = { release_sha: sha, db: true, scheduler: { enabled: true }, motor_worker: { enabled: true } };
const responseFor = (url, health = healthy) => new Response(JSON.stringify(url.includes('/health') ? health : { functions: requiredFunctions }));

test('public verification retries a restart 502 then confirms exact release and capabilities', async () => {
  let calls = 0;
  const result = await verifyPublicDeploy({ base: 'https://example.test', sha, wait: async () => {}, fetchFn: async (url, options) => {
    assert.ok(options.signal);
    return ++calls <= 2 ? new Response('', { status: 502 }) : responseFor(url);
  }});
  assert.equal(result.attempt, 2);
});

test('public verification rejects old release, missing worker or missing functions despite HTTP 200', async () => {
  for (const health of [{ ...healthy, release_sha: 'old' }, { ...healthy, motor_worker: undefined }]) {
    await assert.rejects(verifyPublicDeploy({ base: 'https://example.test', sha, attempts: 1, fetchFn: async (url) => responseFor(url, health) }), /PUBLIC_DEPLOY_VERIFY=failed/);
  }
  await assert.rejects(verifyPublicDeploy({ base: 'https://example.test', sha, attempts: 1, fetchFn: async (url) => new Response(JSON.stringify(url.includes('/health') ? healthy : { functions: [] })) }), /missing_functions=startMotorExecution/);
});

test('public verification gives a bounded diagnostic after request timeouts', async () => {
  let calls = 0;
  await assert.rejects(verifyPublicDeploy({ base: 'https://example.test', sha, attempts: 2, wait: async () => {}, fetchFn: async () => {
    calls++;
    throw new DOMException('mock timeout', 'TimeoutError');
  }}), /request_error=TimeoutError/);
  assert.equal(calls, 4);
});

test('reproduces false success when a child consumes a streamed deployment script', () => {
  const result = spawnSync(bash, ['-s'], { input: script, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'STARTED\n');
  assert.throws(() => verifyDeployReceipt(result.stdout, sha), /without confirming/);
});

test('file execution survives a child reading stdin and confirms the release', () => {
  const directory = mkdtempSync(join(tmpdir(), 'livingfinds-deploy-'));
  try {
    const path = join(directory, 'deploy.sh');
    writeFileSync(path, script);
    const result = spawnSync(bash, [path.replaceAll('\\', '/')], { input: '', encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotThrow(() => verifyDeployReceipt(result.stdout, sha));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('receipt rejects missing, old and merely echoed release markers', () => {
  for (const output of ['', `DEPLOY_VERIFIED_SHA=${'b'.repeat(40)}`, `echo "DEPLOY_VERIFIED_SHA=${sha}"`]) {
    assert.throws(() => verifyDeployReceipt(output, sha));
  }
  assert.throws(() => verifyDeployReceipt('', ''));
});

test('remote script parses and workflow requires both SSH success and receipt', () => {
  const remote = new URL('./deploy-vps.sh', import.meta.url);
  const result = spawnSync(bash, ['-n'], { input: readFileSync(remote, 'utf8'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(workflow, /set -Eeuo pipefail/);
  assert.match(workflow, /bash \$remote_script" <\/dev\/null \| tee/);
  assert.match(workflow, /node scripts\/verify-deploy-receipt.mjs/);
  assert.doesNotMatch(workflow, /bash -s" <<'REMOTE'/);
});

test('file execution preserves a real failure and does not emit a receipt', () => {
  const directory = mkdtempSync(join(tmpdir(), 'livingfinds-deploy-'));
  try {
    const path = join(directory, 'deploy.sh');
    writeFileSync(path, `set -Eeuo pipefail\nfalse\necho DEPLOY_VERIFIED_SHA=${sha}\n`);
    const result = spawnSync(bash, [path.replaceAll('\\', '/')], { input: '', encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.throws(() => verifyDeployReceipt(result.stdout, sha));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
