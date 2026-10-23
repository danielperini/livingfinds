import postgres from 'npm:postgres';
import { deepStrictEqual as eq, ok } from 'node:assert/strict';
import { getMotorDashboardWithSql, listMotorCycleEvidenceWithSql, motorDashboardTables } from './motorDashboard.ts';

const url = Deno.env.get('LIVINGFINDS_TEST_DATABASE_URL');
Deno.test({ name: 'PostgreSQL dashboard read-only: historical incident, full paging, counters and unchanged evidence', ignore: !url,
  fn: async () => {
    const parsed = new URL(url!);
    if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || !parsed.pathname.includes('test')) throw new Error('local_test_database_required');
    const client = postgres(url!, { max: 3, connect_timeout: 5 });
    const suffix = crypto.randomUUID().replaceAll('-', '');
    const tables = Object.fromEntries(Object.keys(motorDashboardTables).map((key) => [key, `lf_dashboard_${key}_${suffix}`])) as typeof motorDashboardTables;
    try {
      for (const key of ['decisions', 'logs', 'campaigns', 'products'] as const) {
        await client.unsafe(`create table "${tables[key]}"(id text primary key,created_date timestamptz default now(),updated_date timestamptz default now(),data jsonb not null)`);
      }
      await client.unsafe(`create table "${tables.scheduler}"(slot_key text,status text,attempt_count int,recovery_count int,
        started_at timestamptz,finished_at timestamptz,updated_at timestamptz,last_error text,function_name text)`);
      await client.unsafe(`insert into "${tables.scheduler}" values ('2026-10-23','exhausted',6,0,'2026-10-23T04:25:00Z','2026-10-23T04:30:00Z','2026-10-23T04:30:00Z',
        'deployment_interrupted; remote state not confirmed; automatic replay blocked','runCanonicalDecisionCycle')`);
      await client.unsafe(`create table "${tables.runs}"(id text,status text,remote_outcome text,started_at timestamptz,finished_at timestamptz,
        last_activity_at timestamptz,lease_expires_at timestamptz,result_summary jsonb,account_scope text)`);
      await client.unsafe(`insert into "${tables.runs}" values ('run-23','remote_unknown','unknown','2026-10-23T04:25:00Z','2026-10-23T04:30:00Z',
        '2026-10-23T04:30:00Z',null,'{"correlation_id":"cycle-23"}','a')`);
      await client.unsafe(`create table "${tables.claims}"(decision_id text,account_id text,status text,attempt int,created_at timestamptz,updated_at timestamptz,finished_at timestamptz)`);
      await client.unsafe(`insert into "${tables.claims}" values('d-00001','a','remote_unknown',1,'2026-10-23T04:25:00Z','2026-10-23T04:30:00Z',null)`);
      await client.unsafe(`insert into "${tables.decisions}"(id,data)
        select 'd-'||lpad(i::text,5,'0'),jsonb_build_object('amazon_account_id','a','correlation_id','cycle-23','status','blocked','created_at','2026-10-23T04:25:00Z') from generate_series(1,6280) i`);
      for (const [id, extra] of [['new-confirmed', { confirmation_status: 'confirmed' }], ['new-sent', { amazon_request_id: 'synthetic-request', status: 'executed' }], ['new-approved', { status: 'approved' }]] as const) {
        await client.unsafe(`insert into "${tables.decisions}"(id,data) values($1,$2::jsonb)`, [id, {
          amazon_account_id: 'a', created_at: '2026-10-24T11:00:00Z', ...extra,
        }]);
      }
      await client.unsafe(`insert into "${tables.campaigns}"(id,data) values('c',$1::jsonb)`, [{ amazon_account_id: 'a', state: 'enabled', last_api_sync_at: '2026-10-22T00:00:00Z' }]);
      await client.unsafe(`insert into "${tables.products}"(id,data) values('p',$1::jsonb)`, [{ amazon_account_id: 'a', status: 'active', fba_inventory: 10, last_catalog_sync_at: '2026-10-22T00:00:00Z' }]);
      await client.unsafe(`insert into "${tables.logs}"(id,data) values('log-23',$1::jsonb)`, [{ amazon_account_id: 'a', correlation_id: 'cycle-23', operation: 'canonical', status: 'warning', amazon_request_id: 'historic-request', started_at: '2026-10-23T04:25:00Z' }]);
      const before = await client.unsafe(`select * from "${tables.scheduler}"`);
      await client.begin('read only', async (tx) => {
        const result = await getMotorDashboardWithSql(tx as any, { accountId: 'a', today: '2026-10-24', due: true,
          now: Date.parse('2026-10-24T12:00:00Z'), scheduler: { enabled: true, started: true } }, tables);
        eq(result.ok, true); eq(result.read_only, true);
        eq(result.daily_motor.status, 'exhausted'); eq(result.daily_motor.remote_outcome, 'unknown');
        eq(result.daily_motor.replay, 'blocked'); eq(result.daily_motor.reconciliation, 'pending');
        eq(result.daily_motor.is_running, false); eq(result.daily_motor.correlation_id, 'cycle-23');
        eq(result.decision_counts?.historical_total, 6283); eq(result.decision_counts?.recent_24h, 3);
        eq(result.decision_counts?.confirmed, 1); eq(result.decision_counts?.sent, 2); eq(result.decision_counts?.unconfirmed, 1);
        eq(result.decision_counts?.blocked, 6280); ok(result.states.includes('data_stale'));
        eq(result.data_freshness.inventory?.latest_at, '2026-10-22T00:00:00.000Z');
        let offset: number | null = 0, count = 0;
        while (offset !== null) {
          const page = await listMotorCycleEvidenceWithSql(tx as any, { accountId: 'a', date: '2026-10-23', correlationId: 'cycle-23', source: 'decisions', offset }, tables);
          count += page.items.length; offset = page.next_offset;
        }
        eq(count, 6280);
        const claims = await listMotorCycleEvidenceWithSql(tx as any, { accountId: 'a', date: '2026-10-23', source: 'claims' }, tables);
        eq(claims.items[0].status, 'remote_unknown');
        const logs = await listMotorCycleEvidenceWithSql(tx as any, { accountId: 'a', date: '2026-10-23', source: 'history' }, tables);
        eq(logs.items[0].request_id, 'historic-request');
      });
        const failed = await getMotorDashboardWithSql(client as any, { accountId: 'a', today: '2026-10-24', due: true,
          scheduler: {} }, { ...tables, products: 'lf_dashboard_deliberately_absent' });
        eq(failed.ok, false); eq(failed.data_freshness.products, null);
        ok(failed.source_errors.some((item) => item.source === 'products'));
      const after = await client.unsafe(`select * from "${tables.scheduler}"`);
      eq(JSON.stringify(after), JSON.stringify(before));
    } finally {
      for (const table of Object.values(tables)) await client.unsafe(`drop table if exists "${table}"`);
      await client.end();
    }
  },
});
