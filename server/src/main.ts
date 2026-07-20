/**
 * main.ts — servidor HTTP do backend self-hosted do Living Finds.
 *
 * - Carrega as 311 funções Deno no registry (sem alterá-las).
 * - Expõe POST /functions/:name  -> executa o handler da função.
 * - Protege a borda com API_TOKEN (header Authorization: Bearer ... ou x-api-token).
 *   Chamadas internas (service role) não passam por aqui — vão direto pelo registry.
 * - Sobe o scheduler (crons da janela noturna etc.).
 */
import { loadFunctions, registry } from './registry.ts';
import { startScheduler } from './scheduler.ts';
import { healthcheck } from './db.ts';

const PORT = Number(Deno.env.get('PORT') ?? 8000);
const API_TOKEN = Deno.env.get('API_TOKEN') ?? '';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function authorized(req: Request): boolean {
  if (!API_TOKEN) return true; // sem token configurado = aberto (dev)
  const auth = req.headers.get('authorization') ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const alt = req.headers.get('x-api-token') ?? '';
  return bearer === API_TOKEN || alt === API_TOKEN;
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === '/health' || path === '/') {
    const db = await healthcheck();
    return json({ ok: true, service: 'livingfinds-backend', functions: registry.size, db });
  }

  if (path === '/functions' && req.method === 'GET') {
    return json({ functions: [...registry.keys()].sort() });
  }

  const m = path.match(/^\/functions\/([A-Za-z0-9_]+)\/?$/);
  if (m) {
    if (!authorized(req)) return json({ ok: false, error: 'Não autorizado' }, 401);
    const name = m[1];
    const fn = registry.get(name);
    if (!fn) return json({ ok: false, error: `Função '${name}' não encontrada` }, 404);
    try {
      return await fn(req);
    } catch (e) {
      console.error(`[main] erro em ${name}:`, (e as Error).message);
      return json({ ok: false, error: (e as Error).message }, 500);
    }
  }

  return json({ ok: false, error: 'Rota desconhecida' }, 404);
}

console.log('[main] carregando funções...');
const { loaded, failed } = await loadFunctions();
if (failed.length) console.warn('[main] funções que não carregaram:', failed.join(', '));

startScheduler();

console.log(`[main] Living Finds backend ouvindo na porta ${PORT} (${loaded} funções)`);
Deno.serve({ port: PORT }, handler);
