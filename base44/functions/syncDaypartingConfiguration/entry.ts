import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const SOURCE = 'syncDaypartingConfiguration';

async function fetchBrazilHolidays(year: number): Promise<string[]> {
  const response = await fetch(`https://brasilapi.com.br/api/feriados/v1/${year}`, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Falha ao consultar feriados: HTTP ${response.status}`);
  const rows = await response.json();
  return [...new Set((Array.isArray(rows) ? rows : []).map((row: any) => String(row.date || '')).filter(Boolean))].sort();
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
      const rules = await base44.asServiceRole.entities.AmazonScheduledRule.filter({ amazon_account_id: account.id }, '-updated_at', 500).catch(() => []);
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
          engine_version: 'settings-daypart-v1',
          last_error: holidayError,
          last_synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }

      results.push({ amazon_account_id: account.id, rules: active.length, holidays: holidays.length, holiday_error: holidayError });
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: account.id,
        sync_type: 'dayparting_configuration',
        status: holidayError ? 'partial' : 'completed',
        source_function: SOURCE,
        records_processed: active.length,
        records_imported: holidays.length,
        message: holidayError || `${active.length} regras sincronizadas`,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      }).catch(() => {});
    }

    return Response.json({ ok: true, results });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha ao sincronizar dayparting' }, { status: 500 });
  }
});
