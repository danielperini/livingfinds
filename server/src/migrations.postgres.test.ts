import postgres from 'npm:postgres';

const databaseUrl = Deno.env.get('LIVINGFINDS_TEST_DATABASE_URL');

Deno.test({
  name: 'PostgreSQL migration preserves duplicate decision snapshots and refuses unsafe unique index',
  ignore: !databaseUrl,
  fn: async () => {
    if (!databaseUrl) throw new Error('LIVINGFINDS_TEST_DATABASE_URL não configurada.');
    const client = postgres(databaseUrl, { max: 1, connect_timeout: 8, idle_timeout: 5 });
    const schema = `lf_migration_${crypto.randomUUID().replaceAll('-', '').toLowerCase()}`;
    const quote = `"${schema}"`;
    try {
      await client.unsafe(`create schema ${quote}`);
      await client.unsafe(`set search_path to ${quote}`);
      await client.unsafe(`create table optimization_decision (
        id text primary key, created_date timestamptz not null default now(), updated_date timestamptz not null default now(),
        created_by text, data jsonb not null default '{}'::jsonb
      )`);
      await client.unsafe(`insert into optimization_decision(id,data) values
        ('decision-a', $1::jsonb), ('decision-b', $2::jsonb)`, [
        { amazon_account_id: 'account-1', idempotency_key: 'same-key', logical_key: 'same-logical', status: 'confirmed' },
        { amazon_account_id: 'account-1', idempotency_key: 'same-key', logical_key: 'same-logical', status: 'approved' },
      ]);

      const preflight = await Deno.readTextFile('server/migrations/20261015_optimization_decision_idempotency_preflight.sql');
      await client.unsafe(preflight);
      const archived = await client.unsafe(
        `select original_id,original_data from optimization_decision_idempotency_archive order by original_id`,
      ) as unknown as Array<{ original_id: string; original_data: Record<string, unknown> }>;
      if (archived.length !== 2 || archived[0].original_data.status === archived[1].original_data.status) {
        throw new Error('O preflight não preservou os snapshots e estados das duplicatas.');
      }

      const uniqueMigration = await Deno.readTextFile('server/migrations/20261015_optimization_decision_idempotency_unique.sql');
      let refused = false;
      try { await client.unsafe(uniqueMigration); } catch (error) {
        refused = String((error as Error).message || error).includes('Cannot install optimization_decision_idempotency_unique');
        if (!refused) throw error;
        await client.unsafe('rollback').catch(() => {});
      }
      const originals = await client.unsafe(`select count(*)::int as count from optimization_decision`) as unknown as Array<{ count: number }>;
      if (!refused || originals[0].count !== 2) throw new Error('A migração não bloqueou duplicatas preservando as linhas originais.');

      await client.unsafe(`delete from optimization_decision where id='decision-b'`);
      await client.unsafe(uniqueMigration);
      const indexes = await client.unsafe(
        `select indexname from pg_indexes where schemaname=$1 and tablename='optimization_decision'`,
        [schema],
      ) as unknown as Array<{ indexname: string }>;
      if (!indexes.some((row) => row.indexname === 'optimization_decision_idempotency_unique') ||
          !indexes.some((row) => row.indexname === 'optimization_decision_logical_key_unique')) {
        throw new Error('A migração não instalou os índices depois que o conflito foi revisado.');
      }
    } finally {
      await client.unsafe(`drop schema if exists ${quote} cascade`);
      await client.end({ timeout: 3 });
    }
  },
});
