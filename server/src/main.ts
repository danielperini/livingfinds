/**
 * main.ts — servidor HTTP do Living Finds self-hosted.
 *
 * Serve três coisas na mesma origem:
 *  1. O FRONTEND (React build em FRONTEND_DIR) — SPA com fallback para index.html.
 *  2. A API compatível com Base44 que o @base44/sdk do front chama:
 *       /api/apps/:appId/entities/:Entity[...]   (GET/POST/PUT/PATCH/DELETE, /bulk, /update-many, User/me)
 *       /api/apps/:appId/functions/:name         (POST -> invoca a função)
 *  3. Rotas diretas /functions/:name (uso programático, protegidas por API_TOKEN) + /health.
 */
import { join, extname } from 'jsr:@std/path@1';
import { contentType } from 'jsr:@std/media-types@1';
import { loadFunctions, registry } from './registry.ts';
import { startScheduler } from './scheduler.ts';
import { healthcheck, query } from './db.ts';
import { makeEntities } from './sdk/entities.ts';
import { makeIntegrations } from './sdk/integrations.ts';

const PORT = Number(Deno.env.get('PORT') ?? 8000);
const API_TOKEN = Deno.env.get('API_TOKEN') ?? '';
const ADMIN_PASSWORD = Deno.env.get('ADMIN_PASSWORD') ?? '';
// Token de sessão retornado após login. Reutiliza API_TOKEN se definido.
const SESSION_TOKEN = API_TOKEN || ADMIN_PASSWORD;
const FRONTEND_DIR = Deno.env.get('FRONTEND_DIR') ?? join(import.meta.dirname!, '..', '..', 'dist');
const entities = makeEntities();
const ADMIN_EMAIL = 'contato@livingfinds.com.br';
const ADMIN_NAME = 'Daniel Perini';

type AuthUser = {
  id: string;
  email: string;
  full_name: string;
  role: string;
  password_hash: string | null;
  password_salt: string | null;
};

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const pairs = hex.match(/.{1,2}/g) ?? [];
  return new Uint8Array(pairs.map((pair) => Number.parseInt(pair, 16)));
}

async function passwordHash(password: string, salt: Uint8Array): Promise<string> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 210_000 },
    material,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function ensureAdminUser(): Promise<AuthUser> {
  await query(`
    create table if not exists app_auth_users (
      id text primary key,
      email text not null unique,
      full_name text not null,
      role text not null default 'admin',
      password_hash text,
      password_salt text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      password_changed_at timestamptz
    )
  `);
  await query(
    `insert into app_auth_users (id, email, full_name, role)
     values ($1, $2, $3, 'admin')
     on conflict (id) do update set
       email = excluded.email,
       full_name = excluded.full_name,
       role = 'admin',
       updated_at = now()`,
    [Deno.env.get('DEFAULT_USER_ID') ?? 'system', ADMIN_EMAIL, ADMIN_NAME],
  );
  const users = await query<AuthUser>(
    'select id, email, full_name, role, password_hash, password_salt from app_auth_users where id = $1 limit 1',
    [Deno.env.get('DEFAULT_USER_ID') ?? 'system'],
  );
  return users[0];
}

async function verifyAdminPassword(password: string, user: AuthUser): Promise<boolean> {
  if (user.password_hash && user.password_salt) {
    const candidate = await passwordHash(password, hexToBytes(user.password_salt));
    return constantTimeEqual(candidate, user.password_hash);
  }
  return Boolean(ADMIN_PASSWORD) && constantTimeEqual(password, ADMIN_PASSWORD);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function defaultUser() {
  return {
    id: Deno.env.get('DEFAULT_USER_ID') ?? 'system',
    email: ADMIN_EMAIL,
    full_name: ADMIN_NAME,
    role: 'admin',
  };
}

function authorized(req: Request): boolean {
  if (!SESSION_TOKEN) return true;
  const auth = req.headers.get('authorization') ?? '';
  return (auth.startsWith('Bearer ') && auth.slice(7) === SESSION_TOKEN) ||
    req.headers.get('x-api-token') === SESSION_TOKEN;
}

// Valida token para rotas de API (entities/functions). Só aplica se ADMIN_PASSWORD estiver definida.
function apiAuthorized(req: Request): boolean {
  if (!ADMIN_PASSWORD) return true;
  return authorized(req);
}

async function invokeFn(name: string, req: Request): Promise<Response> {
  const fn = registry.get(name);
  if (!fn) return json({ ok: false, error: `Função '${name}' não encontrada` }, 404);
  try {
    return await fn(req);
  } catch (e) {
    console.error(`[main] erro em ${name}:`, (e as Error).message);
    return json({ ok: false, error: (e as Error).message }, 500);
  }
}

// ── API compatível com o @base44/sdk ────────────────────────────────────────
async function handleEntities(req: Request, url: URL, entity: string, rest: string): Promise<Response> {
  // deno-lint-ignore no-explicit-any
  const repo = (entities as any)[entity];
  const m = req.method;

  if (entity === 'User' && rest === '/me') {
    return json(defaultUser()); // GET/PUT — single-tenant
  }
  if (rest === '/bulk') {
    if (m === 'POST') return json(await repo.bulkCreate(await req.json().catch(() => [])));
    if (m === 'PUT') return json(await repo.bulkUpdate(await req.json().catch(() => [])));
  }
  if (rest === '/update-many' && (m === 'PATCH' || m === 'POST')) {
    const b = await req.json().catch(() => ({}));
    return json(await repo.updateMany(b?.query ?? {}, b?.data ?? {}));
  }
  const idm = rest.match(/^\/([^/]+)$/);
  if (idm) {
    const id = decodeURIComponent(idm[1]);
    if (m === 'GET') return json(await repo.get(id));
    if (m === 'PUT' || m === 'PATCH') return json(await repo.update(id, await req.json().catch(() => ({}))));
    if (m === 'DELETE') return json(await repo.delete(id));
  }
  if (rest === '' || rest === '/') {
    if (m === 'GET') {
      const sp = url.searchParams;
      const special = new Set(['sort', 'limit', 'skip', 'fields', 'q']);
      // O @base44/sdk manda o filtro como parâmetro `q` = JSON (ex.: q={"user_id":"..."}).
      // deno-lint-ignore no-explicit-any
      let where: Record<string, any> = {};
      const qParam = sp.get('q');
      if (qParam) {
        try { where = JSON.parse(qParam); } catch { /* q inválido -> filtro vazio */ }
      }
      // Também aceita filtros como params soltos (robustez p/ outros clientes).
      for (const [k, v] of sp) if (!special.has(k)) where[k] = v;
      const sort = sp.get('sort') ?? undefined;
      const limit = sp.get('limit') ? Number(sp.get('limit')) : undefined;
      const skip = sp.get('skip') ? Number(sp.get('skip')) : undefined;
      return json(await repo.filter(where, sort, limit, skip));
    }
    if (m === 'POST') return json(await repo.create(await req.json().catch(() => ({}))));
    if (m === 'DELETE') return json(await repo.deleteMany(await req.json().catch(() => ({}))));
  }
  return json({ error: 'método/rota de entidade não suportado' }, 404);
}

async function handleApi(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  let m: RegExpMatchArray | null;

  // /api/apps/:appId/functions/:name
  if ((m = path.match(/^\/api\/apps\/[^/]+\/functions\/([A-Za-z0-9_]+)\/?$/))) {
    return await invokeFn(m[1], req);
  }
  // /api/apps/:appId/entities/:Entity[/rest...]
  if ((m = path.match(/^\/api\/apps\/[^/]+\/entities\/([A-Za-z0-9_]+)(\/.*)?$/))) {
    return await handleEntities(req, url, m[1], m[2] ?? '');
  }
  // /api/apps/:appId/integration-endpoints/Core/:name  (InvokeLLM, SendEmail, UploadFile...)
  if ((m = path.match(/\/integration-endpoints\/Core\/([A-Za-z0-9_]+)\/?$/))) {
    const payload = await req.json().catch(() => ({}));
    // deno-lint-ignore no-explicit-any
    const core = makeIntegrations().Core as any;
    if (typeof core[m[1]] === 'function') return json(await core[m[1]](payload));
    return json({ ok: false, error: `Core.${m[1]} não implementado` });
  }
  // Telemetria/logs/agents/auth externos -> no-op benigno (o app não depende do retorno)
  if (/\/(analytics|app-logs|log-user-in-app|agents|external-auth|app-user-auth|users\/invite)/.test(path)) {
    return json({ ok: true });
  }
  // Rota não tratada: não derruba o app — responde vazio e loga para eu implementar se precisar.
  console.warn(`[api] rota não tratada -> {} : ${req.method} ${path}`);
  return json({});
}

// ── Frontend estático (SPA) ─────────────────────────────────────────────────
async function serveStatic(url: URL): Promise<Response> {
  let path = decodeURIComponent(url.pathname);
  if (path === '/' || path === '') path = '/index.html';
  const filePath = join(FRONTEND_DIR, path);
  try {
    const data = await Deno.readFile(filePath);
    const ct = contentType(extname(filePath)) ?? 'application/octet-stream';
    return new Response(data, { headers: { 'content-type': ct } });
  } catch {
    // Asset com extensão que não existe (ex.: manifest.json, .png) -> 404 real
    // (evita servir HTML no lugar de um .json e gerar erro de parse no navegador).
    if (extname(path)) return json({ error: 'not found' }, 404);
    // Rota do SPA (sem extensão) -> index.html
    try {
      const idx = await Deno.readFile(join(FRONTEND_DIR, 'index.html'));
      return new Response(idx, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    } catch {
      return json({ ok: true, service: 'livingfinds-backend', note: 'frontend não buildado em FRONTEND_DIR' }, 200);
    }
  }
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === '/manifest.json') {
    return json({
      name: 'Living Finds', short_name: 'Living Finds', start_url: '/',
      display: 'standalone', background_color: '#0f1115', theme_color: '#0f1115',
      icons: [{ src: '/logo.jpg', sizes: '1600x1600', type: 'image/jpeg' }],
    });
  }
  if (path === '/health') {
    return json({ ok: true, service: 'livingfinds-backend', functions: registry.size, db: await healthcheck() });
  }
  if (path === '/functions' && req.method === 'GET') {
    return json({ functions: [...registry.keys()].sort() });
  }
  // ── Auth endpoints ──────────────────────────────────────────────────────────
  if (path === '/api/auth/login' && req.method === 'POST') {
    if (!ADMIN_PASSWORD) return json({ ok: true, token: 'selfhosted' });
    const body = await req.json().catch(() => ({}));
    const user = await ensureAdminUser();
    if (!await verifyAdminPassword(String(body.password ?? ''), user)) {
      return json({ ok: false, error: 'Senha incorreta' }, 401);
    }
    return json({ ok: true, token: SESSION_TOKEN });
  }
  if (path === '/api/auth/profile' && req.method === 'GET') {
    if (!apiAuthorized(req)) return json({ ok: false, error: 'Não autorizado' }, 401);
    const user = await ensureAdminUser();
    return json({ id: user.id, email: user.email, full_name: user.full_name, role: user.role });
  }
  if (path === '/api/auth/change-password' && req.method === 'POST') {
    if (!apiAuthorized(req)) return json({ ok: false, error: 'Não autorizado' }, 401);
    const body = await req.json().catch(() => ({}));
    const currentPassword = String(body.current_password ?? '');
    const newPassword = String(body.new_password ?? '');
    if (newPassword.length < 10) {
      return json({ ok: false, error: 'A nova senha deve ter pelo menos 10 caracteres.' }, 400);
    }
    const user = await ensureAdminUser();
    if (!await verifyAdminPassword(currentPassword, user)) {
      return json({ ok: false, error: 'A senha atual está incorreta.' }, 401);
    }
    if (constantTimeEqual(currentPassword, newPassword)) {
      return json({ ok: false, error: 'A nova senha deve ser diferente da senha atual.' }, 400);
    }
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await passwordHash(newPassword, salt);
    await query(
      `update app_auth_users
       set password_hash = $1, password_salt = $2, password_changed_at = now(), updated_at = now()
       where id = $3`,
      [hash, bytesToHex(salt), user.id],
    );
    return json({ ok: true, message: 'Senha alterada com sucesso.' });
  }
  if (path === '/api/auth/logout') {
    return json({ ok: true });
  }
  if (path.startsWith('/api/')) {
    // Rotas públicas (public-settings, chamadas sem auth do AuthContext)
    const isPublic = path.startsWith('/api/apps/public/');
    if (!isPublic && !apiAuthorized(req)) {
      return json({ ok: false, error: 'Não autorizado' }, 401);
    }
    return await handleApi(req, url);
  }
  // rota direta protegida por token (uso programático)
  const direct = path.match(/^\/functions\/([A-Za-z0-9_]+)\/?$/);
  if (direct) {
    if (!authorized(req)) return json({ ok: false, error: 'Não autorizado' }, 401);
    return await invokeFn(direct[1], req);
  }
  // qualquer outra coisa -> frontend
  return await serveStatic(url);
}

console.log('[main] carregando funções...');
const { loaded, failed } = await loadFunctions();
if (failed.length) console.warn('[main] funções que não carregaram:', failed.join(', '));

startScheduler();

console.log(`[main] Living Finds ouvindo na porta ${PORT} (${loaded} funções, frontend em ${FRONTEND_DIR})`);
Deno.serve({ port: PORT }, handler);
