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

/**
 * Constrói a cláusula WHERE a partir de um objeto de filtro. Suporta igualdade simples e
 * operadores estilo Mongo: $in, $nin, $gt, $gte, $lt, $lte, $ne, $exists e $or.
 */
function buildWhere(where: Row, startIdx: number): { clause: string; params: unknown[] } {
  const params: unknown[] = [];
  const esc = (k: string) => k.replace(/'/g, "''");
  const colText = (k: string) => SYSTEM_FIELDS.has(k) ? q(k) : `(data->>'${esc(k)}')`;
  const colJson = (k: string) => SYSTEM_FIELDS.has(k) ? `to_jsonb(${q(k)})` : `(data->'${esc(k)}')`;
  const p = (v: unknown) => { params.push(v); return `$${startIdx + params.length - 1}`; };

  function condFor(key: string, value: unknown): string {
    if (value === null || value === undefined) return `${colText(key)} IS NULL`;
    // objeto de operadores { $in: [...], $gte: x, ... }
    if (typeof value === 'object' && !Array.isArray(value)) {
      const ops = value as Record<string, unknown>;
      const opKeys = Object.keys(ops);
      if (opKeys.some((k) => k.startsWith('$'))) {
        const clauses: string[] = [];
        for (const op of opKeys) {
          const v = ops[op];
          if (op === '$in' || op === '$nin') {
            const arr = (Array.isArray(v) ? v : [v]).map((x) => p(String(x)));
            if (!arr.length) { clauses.push(op === '$in' ? 'false' : 'true'); continue; }
            clauses.push(op === '$in'
              ? `${colText(key)} IN (${arr.join(',')})`
              : `(${colText(key)} NOT IN (${arr.join(',')}) OR ${colText(key)} IS NULL)`);
          } else if (op === '$gt' || op === '$gte' || op === '$lt' || op === '$lte') {
            const sqlOp = op === '$gt' ? '>' : op === '$gte' ? '>=' : op === '$lt' ? '<' : '<=';
            if (typeof v === 'number') {
              // número: compara como jsonb numérico (não estoura em linhas não-numéricas)
              clauses.push(`${colJson(key)} ${sqlOp} to_jsonb(${p(v)}::numeric)`);
            } else {
              // string (ex.: data ISO): comparação textual/lexical
              clauses.push(`${colText(key)} ${sqlOp} ${p(String(v))}`);
            }
          } else if (op === '$ne') {
            clauses.push(v === null ? `${colText(key)} IS NOT NULL` : `${colText(key)} IS DISTINCT FROM ${p(String(v))}`);
          } else if (op === '$exists') {
            const has = SYSTEM_FIELDS.has(key) ? `${q(key)} IS NOT NULL` : `(data ? '${esc(key)}')`;
            clauses.push(v ? has : `NOT (${has})`);
          }
        }
        return clauses.length ? `(${clauses.join(' AND ')})` : 'true';
      }
      // objeto comum -> compara como JSON textual
      return `${colText(key)} = ${p(JSON.stringify(value))}`;
    }
    return `${colText(key)} = ${p(SYSTEM_FIELDS.has(key) ? value : String(value))}`;
  }

  const parts: string[] = [];
  for (const [key, value] of Object.entries(where ?? {})) {
    if (key === '$or' && Array.isArray(value)) {
      const ors = value.map((sub) => Object.entries(sub as Row).map(([k, v]) => condFor(k, v)).join(' AND '));
      parts.push(`(${ors.filter(Boolean).map((c) => `(${c})`).join(' OR ')})`);
      continue;
    }
    parts.push(condFor(key, value));
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
    const cols = ['id', 'created_by', 'data'];
    const ph = ['$1', '$2', '$3::jsonb'];
    const vals: unknown[] = [id, system.created_by ?? null, data];
    // Preserva created_date/updated_date quando fornecidos (importante na migração de dados).
    if (system.created_date) { vals.push(system.created_date); cols.push('created_date'); ph.push(`$${vals.length}`); }
    if (system.updated_date) { vals.push(system.updated_date); cols.push('updated_date'); ph.push(`$${vals.length}`); }
    const rows = (await sql.unsafe(
      `INSERT INTO ${q(this.table)} (${cols.join(', ')})
       VALUES (${ph.join(', ')})
       ON CONFLICT (id) DO UPDATE SET data = ${q(this.table)}.data || EXCLUDED.data, updated_date = now()
       RETURNING *`,
      vals as unknown as string[],
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

  /**
   * Transição atômica de estado. Apenas um worker consegue trocar o status esperado,
   * evitando que a mesma decisão seja executada simultaneamente.
   */
  async claim(id: string, expectedStatuses: string[], patch: Row = {}): Promise<Row | null> {
    await ensureTable(this.table);
    const { data } = splitSystem(patch);
    const rows = (await sql.unsafe(
      `UPDATE ${q(this.table)}
          SET data = data || $3::jsonb,
              updated_date = now()
        WHERE id = $1
          AND data->>'status' = ANY($2::text[])
        RETURNING *`,
      [id, expectedStatuses, data] as unknown as string[],
    )) as unknown as Row[];
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /** Atualiza vários registros; cada item é { id, ...campos }. */
  async bulkUpdate(items: Row[] = []): Promise<Row[]> {
    const out: Row[] = [];
    for (const item of items) {
      if (!item || item.id == null) continue;
      const { id, ...patch } = item;
      const r = await this.update(String(id), patch);
      if (r) out.push(r);
    }
    return out;
  }

  /** updateMany(filtro, patch) — suporta patch estilo Mongo `{ $set: {...} }` ou objeto direto. */
  async updateMany(where: Row = {}, update: Row = {}): Promise<{ updated: number }> {
    const patch = update && typeof update === 'object' && update.$set ? update.$set : update;
    const matches = await this.filter(where, null, 100000);
    let updated = 0;
    for (const m of matches) {
      const r = await this.update(String(m.id), patch);
      if (r) updated++;
    }
    return { updated };
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
