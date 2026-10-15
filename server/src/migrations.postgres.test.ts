import postgres from 'npm:postgres';

const databaseUrl = Deno.env.get('LIVINGFINDS_TEST_DATABASE_URL');

Deno.test({
  name: 'Manual snapshot retention removes only old unreferenced rows and is safe to repeat',
  ignore: !databaseUrl,
  fn: async () => {
    const client = postgres(databaseUrl!, { max: 1, connect_timeout: 8, idle_timeout: 5 });
    const schema = `lf_retention_${crypto.randomUUID().replaceAll('-', '')}`;
    try {
      await client.unsafe(`create schema "${schema}"`);
      await client.unsafe(`set search_path to "${schema}"`);
      await client.unsafe('create table repricing_snapshot(id text primary key, created_date timestamptz not null, data jsonb)');
      await client.unsafe('create table optimization_decision(data jsonb); create table v6_sia_evidence_link(data jsonb)');
      await client.unsafe(`insert into repricing_snapshot values ('expired',now()-interval '40 days','{}'),('decision-source',now()-interval '40 days','{}'),('ai-source',now()-interval '40 days','{}'),('fresh',now(),'{}')`);
      await client.unsafe(`insert into optimization_decision values ('{"snapshot_id":"decision-source"}'); insert into v6_sia_evidence_link values ('{"source_table":"RepricingSnapshot","source_record_id":"ai-source"}')`);
      const script = await Deno.readTextFile('server/migrations/retain_repricing_snapshots_manual.sql');
      await client.unsafe(script);
      await client.unsafe(script);
      const rows = await client.unsafe('select id from repricing_snapshot order by id');
      if (JSON.stringify(rows.map((r) => r.id)) !== JSON.stringify(['ai-source','decision-source','fresh'])) throw new Error('Retention removed current or referenced evidence');
      const audit = await client.unsafe('select removed_count from snapshot_retention_audit order by id');
      if (Number(audit[0].removed_count) !== 1 || Number(audit[1].removed_count) !== 0) throw new Error('Retention reprocessing is not idempotent');
    } finally {
      await client.unsafe(`drop schema if exists "${schema}" cascade`);
      await client.end({ timeout: 3 });
    }
  },
});

Deno.test({
  name: 'PostgreSQL snapshot lookup indexes preserve rows and cover the observed slow query shapes',
  ignore: !databaseUrl,
  fn: async () => {
    const client = postgres(databaseUrl!, { max: 1, connect_timeout: 8, idle_timeout: 5 });
    const schema = `lf_lookup_${crypto.randomUUID().replaceAll('-', '')}`;
    try {
      await client.unsafe(`create schema "${schema}"`);
      await client.unsafe(`set search_path to "${schema}"`);
      await client.unsafe('create table repricing_snapshot (id text primary key, data jsonb not null)');
      await client.unsafe(`insert into repricing_snapshot select n::text, jsonb_build_object(
        'amazon_account_id','test-account','decision_window',case when n%20=0 then 'day' else 'other' end,
        'run_id',case when n%10=0 then 'test-run' else 'other-run' end,
        'created_at',n,'captured_at',n) from generate_series(1,2000) n`);
      const migration = await Deno.readTextFile('server/migrations/20261015_repricing_snapshot_lookup_indexes.sql');
      const statements = migration.replace(/^--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean);
      for (let attempt = 0; attempt < 2; attempt++) {
        for (const statement of statements) await client.unsafe(statement);
      }
      await client.unsafe('analyze repricing_snapshot');
      const cases = [
        { filter: '', sort: 'captured_at', index: 'repricing_snapshot_account_captured' },
        { filter: "AND (data->>'decision_window')='day'", sort: 'created_at', index: 'repricing_snapshot_account_window_created' },
        { filter: '', sort: 'created_at', index: 'repricing_snapshot_account_created' },
        { filter: "AND (data->>'run_id')='test-run'", sort: 'created_at', index: 'repricing_snapshot_account_run_created' },
      ];
      for (const item of cases) {
        const query = `SELECT * FROM repricing_snapshot WHERE (data->>'amazon_account_id')='test-account' ${item.filter} ORDER BY (data->'${item.sort}') DESC NULLS LAST LIMIT 10 OFFSET 0`;
        const plan = JSON.stringify(await client.unsafe(`EXPLAIN (FORMAT JSON) ${query}`));
        // PostgreSQL may choose an equivalent ordered index according to selectivity.
        if (!plan.includes('repricing_snapshot_account_') || plan.includes('"Node Type":"Sort"') || plan.includes('"Node Type":"Seq Scan"')) throw new Error(`Missing ordered lookup: ${item.index}: ${plan}`);
        const rows = await client.unsafe(query);
        if (rows.length !== 10 || rows[0].id !== '2000') throw new Error('Indexed query changed ordering or results');
      }
      const count = await client.unsafe('select count(*)::int as total from repricing_snapshot');
      if (count[0].total !== 2000) throw new Error('Migration changed snapshot rows');
      const indexes = await client.unsafe(`select count(*)::int as total from pg_index i join pg_class c on c.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and i.indisvalid and c.relname like 'repricing_snapshot_account_%'`, [schema]);
      if (indexes[0].total !== 4) throw new Error('Migration did not validate all four indexes');
    } finally {
      await client.unsafe(`drop schema if exists "${schema}" cascade`);
      await client.end({ timeout: 3 });
    }
  },
});

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
