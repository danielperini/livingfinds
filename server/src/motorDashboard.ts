import { decisionRecoveryEligibility } from '../../base44/shared/operationalState.js';
import { dailyMotorReadModel } from './motorDashboardPolicy.ts';
import { safeMotorError } from './motorRunPolicy.ts';
import { classifyDecisionEvidence, dashboardDecisionCounts } from '../../base44/shared/dashboardReads.js';

export type ReadSql = { unsafe: (query: string, values?: any[]) => Promise<any[]> };
export const motorDashboardTables = { scheduler: 'scheduler_job_runs', runs: 'motor_execution_runs',
  decisions: 'optimization_decision', claims: 'motor_decision_execution_claims', logs: 'sync_execution_log', campaigns: 'campaign', products: 'product',
  actionQueue: 'amazon_action_queue', campaignHistory: 'campaign_change_history', bidLogs: 'ads_bid_change_log' };
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
  const [history, active, unknown, auditOutcomes] = await Promise.all([
    read('scheduler', `select slot_key,status,attempt_count,recovery_count,started_at,finished_at,updated_at,last_error,
      to_jsonb(s)->>'correlation_id' as correlation_id
      from ${quoted(tables.scheduler)} s where function_name='runCanonicalDecisionCycle' order by slot_key desc,started_at desc nulls last limit 1`, []),
    read('current_run', `select id,status,started_at,lease_expires_at,last_activity_at,coalesce(result_summary->>'correlation_id',to_jsonb(r)->'request_payload'->>'correlation_id') as correlation_id
      from ${quoted(tables.runs)} r where status='running' and ($1::text is null or account_scope=$1 or account_scope='default-account')
      order by started_at desc limit 1`, [input.accountId || null]),
    read('unresolved_run', `select id,status,remote_outcome,started_at,finished_at,coalesce(result_summary->>'correlation_id',to_jsonb(r)->'request_payload'->>'correlation_id') as correlation_id
      from ${quoted(tables.runs)} r where (remote_outcome='unknown' or status='remote_unknown')
      and ($1::text is null or account_scope=$1 or account_scope='default-account') order by started_at desc nulls last limit 1`, [input.accountId || null]),
    read('scheduler_outcomes', `select function_name,slot_key,status,updated_at,
      to_jsonb(s)->>'outcome_class' as outcome_class,to_jsonb(s)->'result_summary' as result_summary
      from ${quoted(tables.scheduler)} s where function_name in ('auditAdsAutomationE2E','runCanonicalWeeklyDecisionReview')
      and to_jsonb(s)->>'outcome_class' is not null order by updated_at desc limit 50`, []),
  ]);
  const jobFailures = await read('scheduler_jobs', `select s.function_name,s.slot_key,s.status,s.attempt_count,s.last_error,s.finished_at,s.updated_at,
    (select max(n.updated_at) from ${quoted(tables.scheduler)} n where n.status='succeeded' and n.updated_at>s.updated_at
      and coalesce(to_jsonb(n)->>'job_key',n.function_name)=coalesce(to_jsonb(s)->>'job_key',s.function_name)) as recovered_at,
    to_jsonb(s)->>'correlation_id' as correlation_id from ${quoted(tables.scheduler)} s
    where status in ('failed','exhausted') and last_error is not null order by updated_at desc limit 101`, []);
  const model = dailyMotorReadModel({ ...input, latest: history?.[0], current: active?.[0], unknown: unknown?.[0], sourceErrors: errors });
  const cycleDate = (row: any) => row?.started_at ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(row.started_at)) : null;
  // A shared calendar date is not causal linkage. Keep missing legacy correlation explicit.
  const failures = (jobFailures || []).slice(0,100).map(row => ({ ...row, last_error: safeMotorError(row.last_error),
    classification: /remote.*unknown|deployment_interrupted|automatic replay blocked/i.test(row.last_error) ? 'remote_unknown'
      : row.recovered_at ? 'resolved' : row.slot_key?.includes(input.today) ? 'technical_failure' : 'historical' }));
  return { ...model, states: [...new Set([...model.states, ...(failures.some(row => row.classification === 'technical_failure') ? ['scheduler_error'] : [])])],
    failed_jobs_limit: 100, failed_jobs_has_more: (jobFailures?.length || 0) > 100, failed_jobs: failures, correlation_id: model.correlation_id,
    audit_outcomes: (auditOutcomes || []).map(row => {
      const summary = typeof row.result_summary === 'string' ? JSON.parse(row.result_summary) : row.result_summary || {};
      return { function_name: row.function_name, slot_key: row.slot_key, status: row.status,
        outcome_class: row.outcome_class, audit_status: summary.audit_status || row.outcome_class,
        critical_alerts: Array.isArray(summary.critical_alerts) ? summary.critical_alerts : [],
        partial: summary.partial === true, partial_reasons: Array.isArray(summary.partial_reasons) ? summary.partial_reasons : [],
        correlation_id: summary.correlation_id || null,
        completed_at: summary.completed_at || row.updated_at };
    }),
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

export function sourceFreshness(rows: any[], fields: string[], now: number) {
  const times = rows.flatMap((row) => fields.map((field) => Date.parse(row[field] || ''))).filter((at) => Number.isFinite(at) && at <= now);
  const last = times.length ? Math.max(...times) : null;
  const recordTimes = rows.map(row => fields.map(field => Date.parse(row[field] || '')).filter(at => Number.isFinite(at) && at <= now));
  const missing = recordTimes.filter(times => times.length === 0).length;
  const recent = recordTimes.filter(times => times.some(at => now - at <= 45 * 60_000)).length;
  const old = rows.length - missing - recent;
  return { latest_at: last === null ? null : new Date(last).toISOString(),
    stale_records: old + missing, old_records: old, missing_timestamp_records: missing, recent_records: recent,
    total_records: rows.length, coverage_percent: rows.length ? Math.round(recent / rows.length * 10000) / 100 : 0,
    latest_status: last !== null && now - last <= 45 * 60_000 ? 'fresh' : 'data_stale',
    age_seconds: last === null ? null : Math.floor((now - last) / 1000),
    status: !rows.length ? 'no_data' : old + missing > 0 ? 'data_stale' : 'fresh', threshold_minutes: 45,
    interpretation: 'Timestamp antigo demonstra idade do registro; falha de sincronização exige evidência do job.' };

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
    campaigns: campaigns ? sourceFreshness(campaigns, ['last_api_sync_at', 'last_sync_at', 'synced_at'], now) : null,
    products: products ? sourceFreshness(products, ['last_catalog_sync_at', 'last_sync_at', 'synced_at'], now) : null,
    decisions: decisions ? sourceFreshness(decisions, ['evaluated_at', 'created_at', 'created_date'], now) : null,
    inventory: products ? sourceFreshness(products, ['inventory_snapshot_at', 'last_inventory_sync_at'], now) : null,
  };
  const states = [...daily.states];
  if (counts?.recent_24h === 0) states.push('no_recent_decisions');
  if (Object.values(dataFreshness).some((source) => !source || source.status === 'data_stale')) states.push('data_stale');
  return { ok: errors.length === 0 && daily.source_errors.length === 0, checked_at: new Date(now).toISOString(),
    account_id: input.accountId, daily_motor: daily, scheduler: { ...input.scheduler, healthy: input.scheduler?.healthy === true && !daily.states.includes('scheduler_error') }, states: [...new Set(states)],
    service: { status: 'responding', database_read: errors.length === 0 && daily.source_errors.length === 0 },
    decision_recovery: decisions ? {
      execution_allowed: daily.remote_outcome !== 'unknown' && daily.reconciliation !== 'pending',
      blocked_by_remote_unknown: daily.remote_outcome === 'unknown' || daily.reconciliation === 'pending',
      pending: decisions.filter(row => ['approved','waiting_retry','scheduled'].includes(row.status)).length,
      safe_unsent: decisions.filter(row => ['approved','waiting_retry','scheduled'].includes(row.status) && decisionRecoveryEligibility(row, now).safe).length,
      requires_new_collection: decisions.filter(row => ['approved','waiting_retry','scheduled'].includes(row.status) && decisionRecoveryEligibility(row, now).reason === 'new_collection_and_decision_required').length,
    } : null,
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
  } else if (input.source === 'queue') {
    rows = await sql.unsafe(`select id,data->>'decision_id' as decision_id,data->>'status' as status,
      coalesce(data->>'amazon_request_id',data->>'request_id') as request_id,data->>'remote_outcome' as remote_outcome,
      coalesce(data->>'created_at',created_date::text) as created_at,data->>'updated_at' as updated_at
      from ${quoted(tables.actionQueue)} where ${match} order by id limit 251 offset $4`, values);
  } else if (input.source === 'campaign_history') {
    rows = await sql.unsafe(`select id,data->>'campaign_id' as campaign_id,data->>'asin' as asin,data->>'operation' as operation,
      data->>'status' as status,coalesce(data->>'amazon_request_id',data->>'request_id') as request_id,
      data->>'created_at' as created_at,data->>'completed_at' as completed_at
      from ${quoted(tables.campaignHistory)} where ${match} order by id limit 251 offset $4`, values);
  } else if (input.source === 'bids') {
    rows = await sql.unsafe(`select id,data->>'decision_id' as decision_id,data->>'campaign_id' as campaign_id,
      data->>'keyword_id' as keyword_id,data->>'status' as status,
      coalesce(data->>'amazon_request_id',data->>'request_id') as request_id,
      data->>'old_bid' as old_bid,data->>'new_bid' as new_bid,data->>'created_at' as created_at
      from ${quoted(tables.bidLogs)} where ${match} order by id limit 251 offset $4`, values);
  } else if (input.source === 'campaigns') {
    rows = await sql.unsafe(`select id,data->>'campaign_id' as campaign_id,data->>'asin' as asin,
      coalesce(data->>'state',data->>'status') as local_state,data->>'updated_at' as updated_at,
      data->>'correlation_id' as correlation_id from ${quoted(tables.campaigns)}
      where data->>'amazon_account_id'=$1 and (data->>'campaign_id' in
        (select data->>'campaign_id' from ${quoted(tables.decisions)} where ${match}) or id in
        (select data->>'campaign_id' from ${quoted(tables.decisions)} where ${match}))
      order by id limit 251 offset $4`, [input.accountId, input.date, input.correlationId || null, offset]);
  } else throw new Error('invalid_evidence_source');
  const items = input.source === 'decisions'
    ? rows.map(row => ({ ...row, classification: classifyDecisionEvidence(row) }))
    : rows;
  return { ok: true, read_only: true, match_mode: input.correlationId ? 'correlation_id' : 'local_date_candidates',
    date: input.date, source: input.source, items: items.slice(0, 250), next_offset: rows.length > 250 ? offset + 250 : null };
}
