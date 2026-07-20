/**
 * generate-schema.ts — lê base44/entities/*.jsonc e gera server/schema.sql.
 *
 * Runtime usa tabelas-documento (id/created_date/updated_date/created_by/data jsonb), então o
 * schema pré-cria essas tabelas para todas as entidades. Para cada entidade também emitimos, em
 * comentário, o mapeamento tipado das propriedades (referência para futura normalização relacional).
 */
import { join } from 'jsr:@std/path@1';
import stripJsonComments from 'strip-json-comments';
import { toTable } from '../src/sdk/entities.ts';

function entitiesDir(): string {
  return (
    Deno.env.get('ENTITIES_DIR') ??
    join(import.meta.dirname!, '..', '..', 'base44', 'entities')
  );
}

// deno-lint-ignore no-explicit-any
type Schema = { name?: string; properties?: Record<string, any>; required?: string[] };

function pgType(prop: Record<string, unknown>): string {
  const t = prop.type;
  const f = prop.format;
  if (t === 'string' && f === 'date-time') return 'timestamptz';
  if (t === 'string' && f === 'date') return 'date';
  if (t === 'string') return 'text';
  if (t === 'integer') return 'bigint';
  if (t === 'number') return 'double precision';
  if (t === 'boolean') return 'boolean';
  if (t === 'array') return 'jsonb';
  if (t === 'object') return 'jsonb';
  return 'text';
}

async function main() {
  const dir = entitiesDir();
  const out: string[] = [];
  out.push('-- Gerado por scripts/generate-schema.ts — schema do backend self-hosted do Living Finds.');
  out.push('-- Modelo: cada entidade é uma tabela-documento; os campos ficam em `data` (jsonb).');
  out.push('-- O runtime também cria estas tabelas sob demanda; este arquivo serve p/ provisionar de uma vez.');
  out.push('');

  let count = 0;
  const files: string[] = [];
  for await (const d of Deno.readDir(dir)) {
    if (d.isFile && d.name.endsWith('.jsonc')) files.push(d.name);
  }
  files.sort();

  for (const file of files) {
    let schema: Schema;
    try {
      const raw = await Deno.readTextFile(join(dir, file));
      schema = JSON.parse(stripJsonComments(raw, { trailingCommas: true }));
    } catch (e) {
      out.push(`-- !! erro ao ler ${file}: ${(e as Error).message}`);
      continue;
    }
    const entity = schema.name ?? file.replace(/\.jsonc$/, '');
    const table = toTable(entity);
    const required = new Set(schema.required ?? []);

    out.push(`-- ===== ${entity} =====`);
    // referência de colunas tipadas (para futura normalização)
    for (const [k, v] of Object.entries(schema.properties ?? {})) {
      const nn = required.has(k) ? ' NOT NULL' : '';
      out.push(`--   ${k} ${pgType(v)}${nn}`);
    }
    out.push(`CREATE TABLE IF NOT EXISTS "${table}" (`);
    out.push('  id           text PRIMARY KEY,');
    out.push('  created_date timestamptz NOT NULL DEFAULT now(),');
    out.push('  updated_date timestamptz NOT NULL DEFAULT now(),');
    out.push('  created_by   text,');
    out.push("  data         jsonb NOT NULL DEFAULT '{}'::jsonb");
    out.push(');');
    out.push(`CREATE INDEX IF NOT EXISTS "${table}_data_gin" ON "${table}" USING gin (data);`);
    out.push(`CREATE INDEX IF NOT EXISTS "${table}_created_date" ON "${table}" (created_date DESC);`);
    out.push('');
    count++;
  }

  const target = join(import.meta.dirname!, '..', 'schema.sql');
  await Deno.writeTextFile(target, out.join('\n'));
  console.log(`[schema] ${count} tabelas geradas em ${target}`);
}

await main();
