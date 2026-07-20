/**
 * export-from-base44.ts — Exporta os dados reais de produção do Base44 para o Postgres.
 *
 * Usa a API Base44 (header api_key), pagina cada entidade e faz upsert no Postgres via o shim
 * (preservando id, created_date, updated_date). Idempotente (ON CONFLICT).
 *
 * Uso:
 *   deno run --allow-net --allow-env --allow-read scripts/export-from-base44.ts            # todas as entidades
 *   deno run ... scripts/export-from-base44.ts Product Campaign Keyword                    # só algumas
 */
import { join } from 'jsr:@std/path@1';
import stripJsonComments from 'strip-json-comments';
import { makeEntities } from '../src/sdk/entities.ts';
import { sql } from '../src/db.ts';

const APPID = Deno.env.get('BASE44_APP_ID');
const KEY = Deno.env.get('BASE44_API_KEY');
const BASE = Deno.env.get('BASE44_API_BASE') ?? 'https://api.base44.app/api/apps';
if (!APPID || !KEY) {
  console.error('BASE44_APP_ID / BASE44_API_KEY ausentes no ambiente (.env).');
  Deno.exit(1);
}
const PAGE = 200;
const MAX = Number(Deno.env.get('MAX_PER_ENTITY') ?? 100000);

// Lê os nomes das entidades a partir dos .jsonc
const entitiesDir = join(import.meta.dirname!, '..', '..', 'base44', 'entities');
const names: string[] = [];
for await (const d of Deno.readDir(entitiesDir)) {
  if (d.isFile && d.name.endsWith('.jsonc')) {
    try {
      const s = JSON.parse(stripJsonComments(await Deno.readTextFile(join(entitiesDir, d.name))));
      if (s?.name) names.push(s.name);
    } catch { /* ignora schema inválido */ }
  }
}
names.sort();
const only = Deno.args.length ? new Set(Deno.args) : null;
const targets = only ? names.filter((n) => only.has(n)) : names;

const e = makeEntities();

async function fetchPage(entity: string, offset: number): Promise<unknown[]> {
  // A API Base44 pagina com `skip` (não `offset`).
  const res = await fetch(`${BASE}/${APPID}/entities/${entity}?limit=${PAGE}&skip=${offset}`, {
    headers: { api_key: KEY! },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

console.log(`Exportando ${targets.length} entidade(s) do Base44 → Postgres...\n`);
const summary: { name: string; total: number; err?: string }[] = [];
let grand = 0;

for (const name of targets) {
  let offset = 0, total = 0, err: string | undefined;
  try {
    while (offset < MAX) {
      const page = await fetchPage(name, offset);
      if (page.length === 0) break;
      for (const rec of page) {
        await e[name].create(rec as Record<string, unknown>);
        total++;
      }
      if (page.length < PAGE) break;
      offset += PAGE;
    }
  } catch (ex) {
    err = (ex as Error).message;
  }
  grand += total;
  summary.push({ name, total, err });
  console.log(`${err ? '⚠️ ' : '✅'} ${name}: ${total}${err ? ` (erro: ${err})` : ''}`);
}

console.log(`\n📦 ${summary.length} entidades, ${grand} registros importados no Postgres.`);
await sql.end();
