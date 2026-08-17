import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const SOURCE = 'syncDaypartingConfiguration';
const WEEKDAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
const WEEKEND = ['SATURDAY', 'SUNDAY'];

const CANONICAL_RULES: any[] = [];

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
      'canonical-v2-bid-only',
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
      engine_version: 'canonical-daypart-bootstrap-v2-bid-only',
      created_at: now,
      updated_at: now,
    });
    existingKeys.add(idempotencyKey);
    created.push(String(createdRule?.id || idempotencyKey));
  }

  return created;
}

async function archiveLegacyCanonicalRules(base44: any, rules: any[]) {
  const legacy = rules.filter((rule: any) => {
    const key = String(rule.idempotency_key || '');
    const engine = String(rule.engine_version || '');
    return key.includes('|canonical-v1|') || engine === 'canonical-daypart-bootstrap-v1';
  });
  for (const rule of legacy) {
    await base44.asServiceRole.entities.AmazonScheduledRule.update(rule.id, {
      status: 'archived',
      association_status: 'retired_by_unified_engine',
      last_error: 'Regra canônica legada aposentada: a versão bid-only substituiu janelas de pausa e ajustes contraditórios.',
      updated_at: new Date().toISOString(),
    }).catch(() => {});
  }
  return legacy.length;
}

async function archiveFixedScheduledDaypartRules(base44: any, rules: any[]) {
  const candidates = rules.filter((rule: any) => {
    if (['archived', 'failed'].includes(String(rule.status || ''))) return false;
    const engine = String(rule.engine_version || '');
    const name = String(rule.rule_name || '');
    return engine === 'canonical-daypart-bootstrap-v2-bid-only' ||
      engine === 'canonical-daypart-bootstrap-v1' ||
      name.startsWith('Dias úteis ·') || rule.weekend_holiday_group === true;
  });
  for (const rule of candidates) {
    await base44.asServiceRole.entities.AmazonScheduledRule.update(rule.id, {
      status: 'archived',
      association_status: 'retired_by_canonical_economy_first',
      last_error: 'Regra horária fixa aposentada: dayparting passa a ser decidido por economia + evidência + pacing no motor canônico.',
      updated_at: new Date().toISOString(),
    }).catch(() => {});
    rule.status = 'archived';
  }
  return candidates.length;
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, undefined, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 50);
    const year = Number(body.year || new Date().getFullYear());
    const results: any[] = [];

    for (const account of accounts) {
      let rules = await base44.asServiceRole.entities.AmazonScheduledRule.filter({ amazon_account_id: account.id }, '-updated_at', 500).catch(() => []);
      const fixedScheduledRulesArchived = await archiveFixedScheduledDaypartRules(base44, rules);
      const legacyPauseRulesArchived = body.migrate_canonical_rules === true || body.bootstrap_default_rules === true
        ? await archiveLegacyCanonicalRules(base44, rules)
        : 0;
      let bootstrapped: string[] = [];
      if (body.bootstrap_default_rules === true) {
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
        legacy_canonical_rules_archived: legacyPauseRulesArchived,
        fixed_scheduled_rules_archived: fixedScheduledRulesArchived,
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
        message: holidayError || `${active.length} regras sincronizadas; ${fixedScheduledRulesArchived} regras horárias fixas aposentadas; motor economy-first é a autoridade de bid`,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      }).catch(() => {});
    }

    return Response.json({ ok: true, results });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha ao sincronizar dayparting' }, { status: 500 });
  }
});
