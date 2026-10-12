import { tool } from '@openai/agents';
import { z } from 'zod';
import { guardAgentAction } from '../guardrails/production.js';

export function inspectRuntimeConfiguration(env = process.env) {
  const allowed = guardAgentAction('inspect_runtime_configuration');
  if (!allowed.allowed) return allowed;
  return {
    ok: true,
    status: 'read_only',
    hosting: 'Hostinger VPS',
    checks: {
      openai_api_key_present: Boolean(env.OPENAI_API_KEY),
      github_read_token_present: Boolean(env.GITHUB_READ_TOKEN || env.GITHUB_TOKEN),
      database_url_present: Boolean(env.DATABASE_URL),
      health_url_present: Boolean(env.LIVINGFINDS_PUBLIC_HEALTH_URL),
    },
    secret_values_returned: false,
    database_queries_executed: false,
    amazon_ads_requests_executed: false,
    deployments_executed: false,
  };
}

export async function inspectVpsHealth(env = process.env) {
  const allowed = guardAgentAction('inspect_vps_health');
  if (!allowed.allowed) return allowed;
  const configured = env.LIVINGFINDS_PUBLIC_HEALTH_URL;
  if (!configured) return { ok: false, status: 'not_configured', reason: 'LIVINGFINDS_PUBLIC_HEALTH_URL ausente; health check não executado.' };
  let url;
  try { url = new URL(configured); } catch { return { ok: false, status: 'blocked', reason: 'URL de health inválida.' }; }
  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  const isLivingFinds = url.hostname === 'livingfinds.com.br' || url.hostname.endsWith('.livingfinds.com.br');
  if ((!isLoopback && !isLivingFinds) || (url.protocol !== 'https:' && !(isLoopback && url.protocol === 'http:')) || url.username || url.password) {
    return { ok: false, status: 'blocked', reason: 'Health check aceita apenas HTTPS de livingfinds.com.br ou loopback HTTP.' };
  }
  const started = Date.now();
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000) });
    return { ok: response.ok, status: response.ok ? 'healthy' : 'unhealthy', http_status: response.status, latency_ms: Date.now() - started, body_read: false };
  } catch (error) {
    return { ok: false, status: 'failed', latency_ms: Date.now() - started, error: String(error?.message || error) };
  }
}

export const inspectRuntimeConfigurationTool = tool({
  name: 'inspect_runtime_configuration',
  description: 'Informa apenas se configurações essenciais estão presentes; nunca retorna valores de secrets.',
  parameters: z.object({}),
  async execute() { return inspectRuntimeConfiguration(); },
});

export const inspectVpsHealthTool = tool({
  name: 'inspect_vps_health',
  description: 'Faz um GET sem credenciais no health endpoint HTTPS público autorizado ou loopback; não altera o VPS.',
  parameters: z.object({}),
  async execute() { return await inspectVpsHealth(); },
});
