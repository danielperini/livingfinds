import { query } from './db.ts';

const EDITABLE_RUNTIME_CONFIG = new Set(['ADS_ACCOUNT_ID', 'ADS_PROFILE_ID']);

function normalizeValue(value: unknown): string {
  return String(value ?? '').trim();
}

export function isEditableRuntimeConfig(name: unknown): boolean {
  return EDITABLE_RUNTIME_CONFIG.has(String(name ?? '').trim());
}

export async function loadRuntimeConfig(): Promise<void> {
  await query(`
    create table if not exists app_runtime_config (
      name text primary key,
      value text not null,
      updated_at timestamptz not null default now(),
      updated_by text
    )
  `);
  const rows = await query<{ name: string; value: string }>(
    'select name, value from app_runtime_config where name = any($1)',
    [[...EDITABLE_RUNTIME_CONFIG]],
  );
  for (const row of rows) {
    if (isEditableRuntimeConfig(row.name) && normalizeValue(row.value)) {
      Deno.env.set(row.name, normalizeValue(row.value));
    }
  }
}

export async function saveRuntimeConfig(name: unknown, value: unknown, updatedBy = 'admin') {
  const normalizedName = String(name ?? '').trim();
  const normalizedValue = normalizeValue(value);
  if (!isEditableRuntimeConfig(normalizedName)) {
    throw new Error('Esta variável não pode ser alterada pela interface.');
  }
  if (!normalizedValue || normalizedValue.length > 200) {
    throw new Error('Informe um valor válido para a configuração.');
  }
  await query(
    `insert into app_runtime_config (name, value, updated_by)
     values ($1, $2, $3)
     on conflict (name) do update set
       value = excluded.value,
       updated_by = excluded.updated_by,
       updated_at = now()`,
    [normalizedName, normalizedValue, updatedBy],
  );
  Deno.env.set(normalizedName, normalizedValue);
  return { name: normalizedName, configured: true, updatedAt: new Date().toISOString() };
}
