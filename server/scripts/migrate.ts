/**
 * Aplica o schema-base e, em seguida, migrações incrementais uma única vez.
 * Migrações publicadas nunca devem ser alteradas ou removidas.
 */
import { basename, join } from 'jsr:@std/path@1';
import { sql } from '../src/db.ts';

const schemaFile = join(import.meta.dirname!, '..', 'schema.sql');
const migrationsDir = join(import.meta.dirname!, '..', 'migrations');

try {
  await sql.unsafe(await Deno.readTextFile(schemaFile));
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS app_schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const appliedRows = await sql<{ version: string }[]>`
    SELECT version FROM app_schema_migrations
  `;
  const applied = new Set(appliedRows.map((row) => row.version));
  const files: string[] = [];

  for await (const entry of Deno.readDir(migrationsDir)) {
    if (entry.isFile && /^\d+.*\.sql$/.test(entry.name)) files.push(entry.name);
  }
  files.sort();

  for (const name of files) {
    if (applied.has(name)) continue;
    const migration = await Deno.readTextFile(join(migrationsDir, name));
    await sql.begin(async (tx) => {
      await tx.unsafe(migration);
      await tx`INSERT INTO app_schema_migrations (version) VALUES (${name})`;
    });
    console.log(`[migrate] aplicada: ${basename(name)}`);
  }

  console.log('[migrate] schema e migrações aplicados com sucesso.');
} catch (e) {
  console.error('[migrate] falhou:', (e as Error).message);
  Deno.exit(1);
}

await sql.end();
