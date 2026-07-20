/**
 * Conexão Postgres compartilhada (postgres.js roda nativo no Deno via npm:).
 * Uma única pool para todo o processo.
 */
import postgres from 'postgres';

const url = Deno.env.get('DATABASE_URL');
if (!url) {
  console.error('[db] DATABASE_URL não configurada — defina no .env');
}

export const sql = postgres(url ?? '', {
  max: Number(Deno.env.get('DB_POOL_MAX') ?? 10),
  idle_timeout: 30,
  connect_timeout: 15,
  // jsonb já vem parseado como objeto JS
  transform: { undefined: null },
  onnotice: () => {},
});

/** Executa SQL cru com parâmetros posicionais ($1, $2, ...). Retorna array de linhas. */
export async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  // deno-lint-ignore no-explicit-any
  return (await sql.unsafe(text, params as any[])) as unknown as T[];
}

export async function healthcheck(): Promise<boolean> {
  try {
    await sql`select 1`;
    return true;
  } catch (_e) {
    return false;
  }
}
