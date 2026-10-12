import { tool } from '@openai/agents';
import { z } from 'zod';
import { guardAgentAction } from '../guardrails/production.js';

const REPOSITORY = 'danielperini/livingfinds';

export async function inspectRecentGithubActions() {
  const allowed = guardAgentAction('inspect_github_actions');
  if (!allowed.allowed) return allowed;
  const token = process.env.GITHUB_READ_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) return { ok: false, status: 'not_configured', reason: 'GITHUB_READ_TOKEN/GITHUB_TOKEN ausente; nenhuma chamada foi feita.' };
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/actions/runs?per_page=10`, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) return { ok: false, status: 'failed', http_status: response.status, reason: 'GitHub Actions não pôde ser consultado.' };
  const payload = await response.json();
  return {
    ok: true,
    status: 'read',
    scope: '10 execuções mais recentes; não equivale ao histórico completo',
    total_count_reported: payload.total_count ?? null,
    runs: (payload.workflow_runs || []).map((run) => ({
      name: run.name, status: run.status, conclusion: run.conclusion, event: run.event,
      branch: run.head_branch, commit: run.head_sha, run_number: run.run_number,
      created_at: run.created_at, url: run.html_url,
    })),
  };
}

export const inspectGithubActionsTool = tool({
  name: 'inspect_github_actions',
  description: 'Consulta somente leitura as 10 execuções recentes de Actions do Living Finds; nunca altera workflows ou branches.',
  parameters: z.object({}),
  async execute() {
    return await inspectRecentGithubActions();
  },
});
