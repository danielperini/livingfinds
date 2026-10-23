import { dailyMotorReadModel } from './motorDashboardPolicy.ts';
import { safeMotorError } from './motorRunPolicy.ts';
import { dashboardDecisionCounts } from '../../base44/shared/dashboardReads.js';

export type ReadSql = { unsafe: (query: string, values?: any[]) => Promise<any[]> };
export const motorDashboardTables = { scheduler: 'scheduler_job_runs', runs: 'motor_execution_runs',
  decisions: 'optimization_decision', claims: 'motor_decision_execution_claims', logs: 'sync_execution_log', campaigns: 'campaign', products: 'product' };
type Tables = typeof motorDashboardTables;
const quoted = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('invalid_read_table');
  return `"${name}"`;
};
const mapped = (row: any) => ({ ...(typeof row.data === 'string' ? JSON.parse(row.data) : row.data), id: row.id,
  created_date: row.created_date, updated_date: row.updated_date });

export async function readDailyMotorWithSql(sql: ReadSql, input: { today: string; due: boolean; accountId?: string; now?: number; scheduler?: any }, tables: Tables = motorDashboardTables) {
  const errors: any[] = [];
  const read = async (source: string, query: string, values: any[]) => {
    try { return await sql.unsafe(query, values); }
    catch (error) { errors.push({ source, error: safeMotorError(error) }); return null; }
  };
  const [history, active, unknown] = await Promise.all([
    read('scheduler', `select slot_key,status,attempt_count,recovery_count,started_at,finished_at,updated_at,last_error
      from ${quoted(tables.scheduler)} where function_name='runCanonicalDecisionCycle' order by slot_key desc,started_at desc nulls last limit 1`, []),
    read('current_run', `select id,status,started_at,lease_expires_at,last_activity_at,result_summary->>'correlation_id' as correlation_id
      from ${quoted(tables.runs)} where status='running' and ($1::text is null or account_scope=$1 or account_scope='default-account')
      order by started_at desc limit 1`, [input.accountId || null]),
    read('unresolved_run', `select id,status,remote_outcome,started_at,finished_at,result_summary->>'correlation_id' as correlation_id
      from ${quoted(tables.runs)} where (remote_outcome='unknown' or status='remote_unknown')
      and ($1::text is null or account_scope=$1 or account_scope='default-account') order by started_at desc nulls last limit 1`, [input.accountId || null]),
  ]);
  const model = dailyMotorReadModel({ ...input, latest: history?.[0], current: active?.[0], unknown: unknown?.[0], sourceErrors: errors });
  const cycleDate = (row: any) => row?.started_at ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(row.started_at)) : null;
  // Do not attach an older unresolved run's correlation to a newer daily cycle.
  const related = [active?.[0], unknown?.[0]].find((row) => row && cycleDate(row) === model.last_cycle_date);
  return { ...model, correlation_id: related?.correlation_id || model.correlation_id,
    unresolved_run: unknown?.[0] ? { id: unknown[0].id, date: cycleDate(unknown[0]),
      correlation_id: unknown[0].correlation_id, remote_outcome: 'unknown', replay: 'blocked', reconciliation: 'pending' } : null };
}

/** Keyset reads cover all rows; missing tables or page caps are explicit failures. */
export async function readDashboardDocuments(sql: ReadSql, table: string, accountId: string) {
  const rows: any[] = [];
  let cursor = '';
  for (let page = 0; page < 1000; page++) {
    const batch = await sql.unsafe(`select id,created_date,updated_date,data from ${quoted(table)}
      where data->>'amazon_account_id'=$1 and id>$2 order by id limit 250`, [accountId, cursor]);
    rows.push(...batch.map(mapped));
    if (batch.length < 250) return rows;
    const next = batch.at(-1).id;
    if (next <= cursor) throw new Error('dashboard_read_pagination_stalled');
    cursor = next;
  }
  throw new Error('dashboard_read_page_limit');
}

function freshness(rows: any[], fields: string[], now: number) {
  const times = rows.flatMap((row) => fields.map((field) => Date.parse(row[field] || ''))).filter((at) => Number.isFinite(at) && at <= now);
  const last = times.length ? Math.max(...times) : null;
  const staleRecords = rows.filter((row) => !fields.some((field) => {
    const at = Date.parse(row[field] || '');
    return Number.isFinite(at) && at <= now && now - at <= 45 * 60_000;
  })).length;
  return { latest_at: last === null ? null : new Date(last).toISOString(), stale_records: staleRecords,
    age_seconds: last === null ? null : Math.floor((now - last) / 1000),
    status: last === null || staleRecords > 0 ? 'data_stale' : 'fresh', threshold_minutes: 45 };
}

export async function getMotorDashboardWithSql(sql: ReadSql, input: { accountId: string; today: string; due: boolean; scheduler: any; now?: number }, tables: Tables = motorDashboardTables) {
  const now = input.now ?? Date.now();
  const daily = await readDailyMotorWithSql(sql, { ...input, now }, tables);
  const names = ['decisions', 'campaigns', 'products'] as const;
  const sources = await Promise.allSettled(names.map((name) => readDashboardDocuments(sql, tables[name], input.accountId)));
  const errors = sources.flatMap((source, index) => source.status === 'rejected' ? [{ source: names[index], error: safeMotorError(source.reason) }] : []);
  const get = (index: number): any[] | null => sources[index].status === 'fulfilled' ? (sources[index] as PromiseFulfilledResult<any[]>).value : null;
  const [decisions, campaigns, products] = [get(0), get(1), get(2)];
  const counts = decisions ? dashboardDecisionCounts(decisions, now) : null;
  const dataFreshness = {
    campaigns: campaigns ? freshness(campaigns, ['last_api_sync_at', 'last_sync_at', 'synced_at'], now) : null,
    products: products ? freshness(products, ['last_catalog_sync_at', 'last_sync_at', 'synced_at'], now) : null,
    decisions: decisions ? freshness(decisions, ['evaluated_at', 'created_at', 'created_date'], now) : null,
    inventory: products ? freshness(products, ['inventory_snapshot_at', 'last_catalog_sync_at'], now) : null,
  };
  const states = [...daily.states];
  if (counts?.recent_24h === 0) states.push('no_recent_decisions');
  if (Object.values(dataFreshness).some((source) => !source || source.status === 'data_stale')) states.push('data_stale');
  return { ok: errors.length === 0 && daily.source_errors.length === 0, checked_at: new Date(now).toISOString(),
    account_id: input.accountId, daily_motor: daily, scheduler: input.scheduler, states: [...new Set(states)],
    decision_counts: counts, data_freshness: dataFreshness,
    source_counts: { raw_campaign_rows: campaigns?.length ?? null,
      enabled_rows: campaigns?.filter((row) => ['enabled', 'active'].includes(String(row.state || row.status || '').toLowerCase())).length ?? null,
      incomplete_rows: campaigns?.filter((row) => String(row.state || row.status || '').toLowerCase() === 'incomplete').length ?? null,
      stocked_products: products?.filter((row) => row.status === 'active' && Number(row.fba_inventory) > 0).length ?? null,
      explanation: 'Dashboard campaigns exclude api_missing/excluded rows and deduplicate remote campaign IDs. Active count includes enabled and incomplete; stocked products require local active status and FBA > 0. These are synchronized local records, not a live Amazon read.' },
    source_errors: [...daily.source_errors, ...errors], read_only: true };
}

/** Evidence is paged and allowlisted. No token, payload, lease-owner or write path. */
export async function listMotorCycleEvidenceWithSql(sql: ReadSql, input: {
  accountId: string; date: string; correlationId?: string; source: string; offset?: number;
}, tables: Tables = motorDashboardTables) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error('invalid_cycle_date');
  const offset = Math.max(0, Math.floor(input.offset || 0));
  if (!Number.isFinite(offset)) throw new Error('invalid_evidence_offset');
  const match = `(data->>'amazon_account_id'=$1 and
    (($3::text is not null and (data->>'correlation_id'=$3 or data->>'decision_engine_correlation_id'=$3))
    or ($3::text is null and (coalesce(data->>'created_at',data->>'started_at',created_date::text))::timestamptz >= ($2::date::timestamp at time zone 'America/Sao_Paulo')
      and (coalesce(data->>'created_at',data->>'started_at',created_date::text))::timestamptz < (($2::date+1)::timestamp at time zone 'America/Sao_Paulo'))))`;
  const values = [input.accountId, input.date, input.correlationId || null, offset];
  let rows: any[];
  if (input.source === 'decisions') {
    rows = await sql.unsafe(`select id,data->>'correlation_id' as correlation_id,data->>'status' as status,
      data->>'confirmation_status' as confirmation_status,coalesce(data->>'amazon_request_id',data->>'request_id') as request_id,
      data->>'remote_outcome' as remote_outcome,data->>'created_at' as created_at
      from ${quoted(tables.decisions)} where ${match} order by id limit 251 offset $4`, values);
  } else if (input.source === 'claims') {
    rows = await sql.unsafe(`select decision_id,status,attempt,created_at,updated_at,finished_at
      from ${quoted(tables.claims)} where account_id=$1 and decision_id in
      (select id from ${quoted(tables.decisions)} where ${match}) order by decision_id limit 251 offset $4`, values);
  } else if (input.source === 'history') {
    rows = await sql.unsafe(`select id,data->>'operation' as operation,data->>'status' as status,
      coalesce(data->>'amazon_request_id',data->>'request_id') as request_id,data->>'started_at' as started_at,
      data->>'completed_at' as completed_at from ${quoted(tables.logs)} where ${match} order by id limit 251 offset $4`, values);
  } else throw new Error('invalid_evidence_source');
  return { ok: true, read_only: true, match_mode: input.correlationId ? 'correlation_id' : 'local_date_candidates',
    date: input.date, items: rows.slice(0, 250), next_offset: rows.length > 250 ? offset + 250 : null };
}
