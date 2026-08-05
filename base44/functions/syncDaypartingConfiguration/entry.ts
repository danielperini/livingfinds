import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const SOURCE = 'syncDaypartingConfiguration';
const WEEKDAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
const WEEKEND = ['SATURDAY', 'SUNDAY'];

const CANONICAL_RULES = [
  {
    rule_name: 'Dias úteis · reduzir bids para 50% à noite',
    action_type: 'BID_PERCENT',
    start_time: '23:59',
    end_time: '03:00',
    adjustment_value: -50,
    days_of_week: WEEKDAYS,
    holiday_mode: 'IGNORE',
    weekend_holiday_group: false,
    targeting_types: [],
    reason: 'Regra canônica já executada pelo motor: bids em 50% entre 23:59 e 03:00 nos dias úteis.',
  },
  {
    rule_name: 'Dias úteis · pausar campanhas entre 03:00 e 05:00',
    action_type: 'PAUSE_CAMPAIGN',
    start_time: '03:00',
    end_time: '05:00',
    adjustment_value: 0,
    days_of_week: WEEKDAYS,
    holiday_mode: 'IGNORE',
    weekend_holiday_group: false,
    targeting_types: [],
    reason: 'Regra canônica já executada pelo motor: pausa temporária de campanhas nos dias úteis.',
  },
  {
    rule_name: 'Dias úteis · reativar campanhas e restaurar bids às 05:00',
    action_type: 'ENABLE_CAMPAIGN',
    start_time: '05:00',
    end_time: '05:05',
    adjustment_value: 0,
    days_of_week: WEEKDAYS,
    holiday_mode: 'IGNORE',
    weekend_holiday_group: false,
    targeting_types: [],
    reason: 'Regra canônica já executada pelo motor: reativa apenas campanhas pausadas pelo ciclo e restaura o baseline.',
  },
  {
    rule_name: 'Dias úteis · reduzir bids em 60% entre 15:00 e 17:00',
    action_type: 'BID_PERCENT',
    start_time: '15:00',
    end_time: '17:00',
    adjustment_value: -60,
    days_of_week: WEEKDAYS,
    holiday_mode: 'IGNORE',
    weekend_holiday_group: false,
    targeting_types: [],
    reason: 'Regra canônica já executada pelo motor: bids em 40% do baseline entre 15:00 e 17:00.',
  },
  {
    rule_name: 'Dias úteis · pausar automáticas entre 15:00 e 17:00',
    action_type: 'PAUSE_CAMPAIGN',
    start_time: '15:00',
    end_time: '17:00',
    adjustment_value: 0,
    days_of_week: WEEKDAYS,
    holiday_mode: 'IGNORE',
    weekend_holiday_group: false,
    targeting_types: ['AUTO'],
    reason: 'Regra canônica já executada pelo motor: pausa somente campanhas automáticas nessa janela.',
  },
  {
    rule_name: 'Dias úteis · restaurar bids e automáticas às 17:00',
    action_type: 'ENABLE_CAMPAIGN',
    start_time: '17:00',
    end_time: '17:05',
    adjustment_value: 0,
    days_of_week: WEEKDAYS,
    holiday_mode: 'IGNORE',
    weekend_holiday_group: false,
    targeting_types: ['AUTO'],
    reason: 'Regra canônica já executada pelo motor: restaura bids ao baseline e reativa automáticas pausadas pelo ciclo.',
  },
  {
    rule_name: 'Sábado, domingo e feriados · bids em 50% de 23:59 a 05:00',
    action_type: 'BID_PERCENT',
    start_time: '23:59',
    end_time: '05:00',
    adjustment_value: -50,
    days_of_week: WEEKEND,
    holiday_mode: 'WEEKEND_POLICY',
    weekend_holiday_group: true,
    targeting_types: [],
    reason: 'Regra canônica já executada pelo motor para sábado, domingo e feriados, sem pausa de campanha.',
  },
  {
    rule_name: 'Sábado, domingo e feriados · restaurar bids às 05:00',
    action_type: 'BID_PERCENT',
    start_time: '05:00',
    end_time: '05:05',
    adjustment_value: 0,
    days_of_week: WEEKEND,
    holiday_mode: 'WEEKEND_POLICY',
    weekend_holiday_group: true,
    targeting_types: [],
    reason: 'Regra canônica já executada pelo motor: restaura o baseline sem pausar campanhas.',
  },
];

async function fetchBrazilHolidays(year: number): Promise<string[]> {
  const response = await fetch(`https://brasilapi.com.br/api/feriados/v1/${year}`, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Falha ao consultar feriados: HTTP ${response.status}`);
  const rows = await response.json();
  return [...new Set((Array.isArray(rows) ? rows : []).map((row: any) => String(row.date || '')).filter(Boolean))].sort();
}

async function bootstrapCanonicalRules(base44: any, account: any, existingRules: any[]) {
  const existingKeys = new Set(existingRules.map((rule: any) => String(rule.idempotency_key || '')));
  const created: string[] = [];
  const now = new Date().toISOString();

  for (const rule of CANONICAL_RULES) {
    const daysKey = rule.weekend_holiday_group
      ? 'SATURDAY,SUNDAY,HOLIDAYS'
      : [...rule.days_of_week].sort().join(',');
    const idempotencyKey = [
      account.id,
      'canonical-v1',
      rule.action_type,
      rule.start_time,
      rule.end_time,
      daysKey,
      rule.targeting_types.join(','),
      rule.adjustment_value,
    ].join('|');
    if (existingKeys.has(idempotencyKey)) continue;

    const createdRule = await base44.asServiceRole.entities.AmazonScheduledRule.create({
      amazon_account_id: account.id,
      marketplace_id: account.marketplace_id || null,
      profile_id: account.ads_profile_id || account.profile_id || null,
      ...rule,
      rule_category: ['PAUSE_CAMPAIGN', 'ENABLE_CAMPAIGN'].includes(rule.action_type) ? 'CAMPAIGN_STATE' : 'BID',
      rule_subcategory: 'SCHEDULE',
      scope_type: 'ALL',
      campaign_ids: [],
      recurrence_type: 'WEEKLY',
      timezone: 'America/Sao_Paulo',
      adjustment_unit: 'PERCENT',
      adjustment_operator: Number(rule.adjustment_value) >= 0 ? 'INCREMENT' : 'DECREMENT',
      status: 'enabled',
      association_status: 'associated',
      associated_campaign_ids: [],
      failed_campaign_ids: [],
      fallback_mode: 'app_managed_only',
      native_api_supported: false,
      idempotency_key: idempotencyKey,
      engine_version: 'canonical-daypart-bootstrap-v1',
      created_at: now,
      updated_at: now,
    });
    existingKeys.add(idempotencyKey);
    created.push(String(createdRule?.id || idempotencyKey));
  }

  return created;
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 50);
    const year = Number(body.year || new Date().getFullYear());
    const results: any[] = [];

    for (const account of accounts) {
      let rules = await base44.asServiceRole.entities.AmazonScheduledRule.filter({ amazon_account_id: account.id }, '-updated_at', 500).catch(() => []);
      let bootstrapped: string[] = [];
      if (body.bootstrap_default_rules === true && !rules.some((rule: any) => rule.status !== 'archived')) {
        bootstrapped = await bootstrapCanonicalRules(base44, account, rules);
        rules = await base44.asServiceRole.entities.AmazonScheduledRule.filter({ amazon_account_id: account.id }, '-updated_at', 500).catch(() => []);
      }

      const active = rules.filter((rule: any) => !['archived', 'failed'].includes(String(rule.status || '')));
      const needHolidaySync = active.some((rule: any) => rule.holiday_mode === 'AUTO_BR' || rule.holiday_mode === 'WEEKEND_POLICY');
      let holidays: string[] = [];
      let holidayError: string | null = null;
      if (needHolidaySync) {
        try { holidays = await fetchBrazilHolidays(year); } catch (error: any) { holidayError = error?.message || String(error); }
      }

      for (const rule of active) {
        const selected = rule.scope_type === 'ALL' ? [] : [...new Set((rule.campaign_ids || []).map(String).filter(Boolean))];
        await base44.asServiceRole.entities.AmazonScheduledRule.update(rule.id, {
          campaign_ids: selected,
          holiday_dates: rule.holiday_mode === 'IGNORE' ? [] : holidays,
          holiday_sync_year: year,
          holiday_synced_at: holidays.length ? new Date().toISOString() : rule.holiday_synced_at || null,
          association_status: rule.scope_type === 'ALL' || selected.length ? 'associated' : 'failed',
          associated_campaign_ids: selected,
          failed_campaign_ids: [],
          fallback_mode: 'app_managed_only',
          native_api_supported: false,
          engine_version: rule.engine_version || 'settings-daypart-v1',
          last_error: holidayError,
          last_synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }

      results.push({
        amazon_account_id: account.id,
        rules: active.length,
        bootstrapped: bootstrapped.length,
        holidays: holidays.length,
        holiday_error: holidayError,
      });
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: account.id,
        sync_type: 'dayparting_configuration',
        status: holidayError ? 'partial' : 'completed',
        source_function: SOURCE,
        records_processed: active.length,
        records_imported: holidays.length + bootstrapped.length,
        message: holidayError || `${active.length} regras sincronizadas; ${bootstrapped.length} regras canônicas materializadas`,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      }).catch(() => {});
    }

    return Response.json({ ok: true, results });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha ao sincronizar dayparting' }, { status: 500 });
  }
});