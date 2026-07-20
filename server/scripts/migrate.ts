/**
 * migrate.ts — aplica o server/schema.sql no Postgres apontado por DATABASE_URL.
 * Rode depois de `deno task schema`. Idempotente (tudo é CREATE ... IF NOT EXISTS).
 */
import { join } from 'jsr:@std/path@1';
import { sql } from '../src/db.ts';

const file = join(import.meta.dirname!, '..', 'schema.sql');

try {
  const ddl = await Deno.readTextFile(file);
  await sql.unsafe(ddl);
  console.log('[migrate] schema aplicado com sucesso.');
} catch (e) {
  console.error('[migrate] falhou:', (e as Error).message);
  Deno.exit(1);
}
await sql.end();
