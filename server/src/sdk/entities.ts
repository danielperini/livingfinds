/**
 * Camada de Entidades — reimplementa `base44.entities.<Entity>.<método>` sobre Postgres.
 *
 * Modelo de armazenamento: cada entidade é uma tabela "documento":
 *   ( id text pk, created_date timestamptz, updated_date timestamptz, created_by text, data jsonb )
 * Os campos do registro ficam em `data`; os campos de sistema (id/created_date/updated_date/created_by)
 * são colunas próprias. Isso reproduz a semântica flexível do Base44 e roda as 311 funções sem
 * precisar acertar o schema tipado de 116 entidades de antemão. A tabela é criada sob demanda.
 */
import { sql } from '../db.ts';

const SYSTEM_FIELDS = new Set(['id', 'created_date', 'updated_date', 'created_by']);
const ensured = new Set<string>();

/** PascalCase/CamelCase -> snake_case. Ex.: AIAnalysisCache -> ai_analysis_cache */
export function toTable(entity: string): string {
  return entity
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

function q(id: string): string {
  return '"' + id.replace(/"/g, '""') + '"';
}

async function ensureTable(table: string): Promise<void> {
  if (ensured.has(table)) return;
  const t = q(table);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${t} (
      id           text PRIMARY KEY,
      created_date timestamptz NOT NULL DEFAULT now(),
      updated_date timestamptz NOT NULL DEFAULT now(),
      created_by   text,
      data         jsonb NOT NULL DEFAULT '{}'::jsonb
    );
  `);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS ${q(table + '_data_gin')} ON ${t} USING gin (data);`);
  await sql.unsafe(
    `CREATE INDEX IF NOT EXISTS ${q(table + '_created_date')} ON ${t} (created_date DESC);`,
  );
  ensured.add(table);
}

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

function mapRow(row: Row): Row {
  const { id, created_date, updated_date, created_by } = row;
  let data = row.data;
  // postgres.js pode devolver jsonb como string (dependendo do driver/consulta) — normaliza.
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      data = {};
    }
  }
  return { id, created_date, updated_date, created_by, ...(data ?? {}) };
}

function splitSystem(payload: Row): { system: Row; data: Row } {
  const system: Row = {};
  const data: Row = {};
  for (const [k, v] of Object.entries(payload ?? {})) {
    if (SYSTEM_FIELDS.has(k)) system[k] = v;
    else data[k] = v;
  }
  return { system, data };
}

/** Constrói a cláusula WHERE a partir de um objeto de filtro { campo: valor }. */
function buildWhere(where: Row, startIdx: number): { clause: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  let i = startIdx;
  for (const [key, value] of Object.entries(where ?? {})) {
    if (value === null || value === undefined) {
      if (SYSTEM_FIELDS.has(key)) parts.push(`${q(key)} IS NULL`);
      else parts.push(`(data->>'${key.replace(/'/g, "''")}') IS NULL`);
      continue;
    }
    if (SYSTEM_FIELDS.has(key)) {
      parts.push(`${q(key)} = $${i++}`);
      params.push(value);
    } else {
      // comparação textual — cobre string/number/boolean de forma consistente
      parts.push(`(data->>'${key.replace(/'/g, "''")}') = $${i++}`);
      params.push(typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
  }
  return { clause: parts.length ? 'WHERE ' + parts.join(' AND ') : '', params };
}

/** '-campo' => ORDER BY campo DESC ; 'campo' => ASC. Usa jsonb (->) p/ ordenar número/data corretamente. */
function buildOrder(sort?: string | null): string {
  if (!sort) return 'ORDER BY created_date DESC';
  const desc = sort.startsWith('-');
  const field = desc ? sort.slice(1) : sort;
  const dir = desc ? 'DESC' : 'ASC';
  if (SYSTEM_FIELDS.has(field)) return `ORDER BY ${q(field)} ${dir}`;
  return `ORDER BY (data->'${field.replace(/'/g, "''")}') ${dir} NULLS LAST`;
}

export class EntityRepo {
  constructor(public readonly entity: string, public readonly table = toTable(entity)) {}

  async filter(where: Row = {}, sort?: string | null, limit?: number, offset?: number): Promise<Row[]> {
    await ensureTable(this.table);
    const { clause, params } = buildWhere(where, 1);
    let text = `SELECT * FROM ${q(this.table)} ${clause} ${buildOrder(sort)}`;
    if (typeof limit === 'number') text += ` LIMIT ${Math.max(0, Math.floor(limit))}`;
    if (typeof offset === 'number') text += ` OFFSET ${Math.max(0, Math.floor(offset))}`;
    const rows = (await sql.unsafe(text, params as string[])) as unknown as Row[];
    return rows.map(mapRow);
  }

  async list(sort?: string | null, limit?: number): Promise<Row[]> {
    return this.filter({}, sort, limit);
  }

  async get(id: string): Promise<Row | null> {
    await ensureTable(this.table);
    const rows = (await sql.unsafe(
      `SELECT * FROM ${q(this.table)} WHERE id = $1 LIMIT 1`,
      [id],
    )) as unknown as Row[];
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async findOne(where: Row = {}, sort?: string | null): Promise<Row | null> {
    const rows = await this.filter(where, sort, 1);
    return rows[0] ?? null;
  }

  async create(payload: Row = {}): Promise<Row> {
    await ensureTable(this.table);
    const { system, data } = splitSystem(payload);
    const id = system.id ?? crypto.randomUUID();
    // Passamos o OBJETO direto (postgres.js serializa como JSON uma única vez).
    // Passar string faria dupla codificação (viraria jsonb scalar string).
    const rows = (await sql.unsafe(
      `INSERT INTO ${q(this.table)} (id, created_by, data)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (id) DO UPDATE SET data = ${q(this.table)}.data || EXCLUDED.data, updated_date = now()
       RETURNING *`,
      [id, system.created_by ?? null, data] as unknown as string[],
    )) as unknown as Row[];
    return mapRow(rows[0]);
  }

  async bulkCreate(items: Row[] = []): Promise<Row[]> {
    const out: Row[] = [];
    for (const item of items) out.push(await this.create(item));
    return out;
  }

  async update(id: string, patch: Row = {}): Promise<Row | null> {
    await ensureTable(this.table);
    const { system, data } = splitSystem(patch);
    const rows = (await sql.unsafe(
      `UPDATE ${q(this.table)}
         SET data = data || $2::jsonb,
             created_by = COALESCE($3, created_by),
             updated_date = now()
       WHERE id = $1
       RETURNING *`,
      [id, data, system.created_by ?? null] as unknown as string[],
    )) as unknown as Row[];
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async delete(id: string): Promise<{ id: string }> {
    await ensureTable(this.table);
    await sql.unsafe(`DELETE FROM ${q(this.table)} WHERE id = $1`, [id]);
    return { id };
  }

  async deleteMany(where: Row = {}): Promise<{ deleted: number }> {
    await ensureTable(this.table);
    const { clause, params } = buildWhere(where, 1);
    const res = (await sql.unsafe(
      `WITH d AS (DELETE FROM ${q(this.table)} ${clause} RETURNING 1) SELECT count(*)::int AS n FROM d`,
      params as string[],
    )) as unknown as Row[];
    return { deleted: res[0]?.n ?? 0 };
  }
}

/** Proxy: base44.entities.QualquerEntidade -> EntityRepo sob demanda. */
export function makeEntities(): Record<string, EntityRepo> {
  const cache = new Map<string, EntityRepo>();
  return new Proxy({} as Record<string, EntityRepo>, {
    get(_t, prop: string) {
      if (typeof prop !== 'string') return undefined;
      let repo = cache.get(prop);
      if (!repo) {
        repo = new EntityRepo(prop);
        cache.set(prop, repo);
      }
      return repo;
    },
  });
}
