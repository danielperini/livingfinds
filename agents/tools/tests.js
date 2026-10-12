import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tool } from '@openai/agents';
import { z } from 'zod';
import { guardAgentAction } from '../guardrails/production.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const TEST_SUITES = Object.freeze({
  v6sia: {
    command: 'deno',
    args: ['test', '--node-modules-dir=auto',
      'base44/shared/v6siaFailurePolicy.test.ts',
      'base44/shared/v6siaReviewEvidence.test.ts',
      'base44/shared/v6siaEvidencePaging.test.ts',
      'base44/shared/v6siaLifecycle.e2e.test.ts',
      'server/src/sdk/integrations.test.ts'],
  },
  frontend_contracts: {
    command: 'npm',
    args: ['run', 'test:ui-contract'],
  },
});

export function safeTestEnvironment(env = process.env) {
  const safe = { CI: '1' };
  for (const name of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR']) {
    if (env[name]) safe[name] = env[name];
  }
  return safe;
}

export async function runAllowlistedTests(suite) {
  const allowed = guardAgentAction('run_allowlisted_tests');
  if (!allowed.allowed) return allowed;
  const config = TEST_SUITES[suite];
  if (!config) return { ok: false, status: 'blocked', reason: 'Suíte não permitida; selecione v6sia ou frontend_contracts.' };
  try {
    const result = await execFileAsync(config.command, config.args, {
      cwd: REPO_ROOT,
      timeout: 5 * 60 * 1000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      shell: false,
      env: safeTestEnvironment(),
    });
    return { ok: true, status: 'passed', suite, command: [config.command, ...config.args].join(' '), stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      ok: false,
      status: error?.code === 'ENOENT' ? 'unavailable' : error?.code === 'ETIMEDOUT' ? 'timeout' : 'failed',
      suite,
      command: [config.command, ...config.args].join(' '),
      output_complete: !['ENOBUFS', 'ETIMEDOUT'].includes(error?.code),
      stdout: String(error?.stdout || ''),
      stderr: String(error?.stderr || error?.message || ''),
      exit_code: error?.code === 'ENOENT' ? null : Number(error?.code) || null,
    };
  }
}

export const runAllowlistedTestsTool = tool({
  name: 'run_allowlisted_tests',
  description: 'Executa apenas as suítes v6sia ou frontend_contracts definidas no código, sem aceitar comandos livres.',
  parameters: z.object({ suite: z.enum(['v6sia', 'frontend_contracts']) }),
  async execute({ suite }) {
    return await runAllowlistedTests(suite);
  },
});
