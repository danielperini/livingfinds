import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

/**
 * Sincroniza regras de aumento de bid diretamente na Amazon Ads.
 *
 * Limite da API: Schedule Bid Rules nativas apenas INCREMENTAM o bid.
 * Reduções e restaurações permanecem no runCanonicalDaypartingEngine.
 */
const DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const ENGINE_VERSION = 'amazon-native-schedule-v1';
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const r2 = (value: number) => Math.round(value * 100) / 100;
const norm = (value: any) => String(value || '').trim().toLowerCase();
const active = (value: any) => ['enabled', 'active'].includes(norm(value));

function todayBRT(): string {
  return new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
}

function nextReviewIso(): string {
  return new Date(Date.now() + 72 * 3600000).toISOString();
}

function stockQty(product: any): number {
  return Number(product?.fba_inventory ?? product?.available_quantity ?? product?.fulfillable_quantity ?? product?.stock ?? 0);
}

function targetingType(campaign: any): 'AUTO' | 'MANUAL' {
  const value = String(campaign?.targeting_type || campaign?.targetingType || '').toUpperCase();
  if (value === 'MANUAL') return 'MANUAL';
  if (value === 'AUTO') return 'AUTO';
  return /manual/i.test(String(campaign?.name || campaign?.campaign_name || '')) ? 'MANUAL' : 'AUTO';
}

function amazonSuccess(response: any, collection = 'campaigns'): boolean {
  const data = response?.data || response || {};
  if (data?.ok === false) return false;
  const payload = data?.payload || {};
  if (Number(data?.status || 0) === 207) {
    const rows = payload?.[collection]?.success || payload?.[collection] || payload?.success || [];
    const errors = payload?.[collection]?.error || payload?.errors || [];
    return Array.isArray(rows) ? rows.length > 0 : !Array.isArray(errors) || errors.length === 0;
  }
  return data?.ok === true;
}

function extractRuleId(response: any): string {
  const data = response?.data || response || {};
  const payload = data?.payload || {};
  const candidates = [
    payload?.optimizationRules?.success?.[0]?.optimizationRuleId,
    payload?.optimizationRules?.[0]?.optimizationRuleId,
    payload?.responses?.[0]?.optimizationRuleId,
    payload?.success?.[0]?.optimizationRuleId,
    payload?.optimizationRuleId,
  ];
  return String(candidates.find(Boolean) || '');
}

function extractRules(response: any): any[] {
  const data = response?.data || response || {};
  const payload = data?.payload || {};
  return Array.isArray(payload?.optimizationRules) ? payload.optimizationRules : [];
}

function slotClass(value: any): 'ELITE_TIME' | 'STRONG_TIME' | 'OTHER' {
  const cls = String(value || '').toUpperCase();
  if (cls === 'PEAK_ELITE' || cls === 'ELITE_TIME') return 'ELITE_TIME';
  if (cls === 'PEAK_STRONG' || cls === 'STRONG_TIME') return 'STRONG_TIME';
  return 'OTHER';
}

function buildWindows(patterns: any[], decisions: any[]) {
  const matrix = new Map<string, { cls: 'ELITE_TIME' | 'STRONG_TIME' | 'OTHER'; mature: boolean; score: number }>();
  for (const row of patterns) {
    const dow = Number(row.day_of_week);
    const hour = Number(row.hour);
    if (dow < 0 || dow > 6 || hour < 0 || hour > 23) continue;
    matrix.set(`${dow}|${hour}`, {
      cls: slotClass(row.classification),
      mature: Number(row.occurrences || 0) >= 3 && String(row.classification || '') !== 'INSUFFICIENT_DATA',
      score: Number(row.peak_score || 0),
    });
  }
  for (const row of decisions) {
    const dow = Number(row.day_of_week);
    const hour = Number(row.hour);
    if (dow < 0 || dow > 6 || hour < 0 || hour > 23) continue;
    const cls = slotClass(row.slot_classification);
    if (cls === 'OTHER') continue;
    matrix.set(`${dow}|${hour}`, {
      cls,
      mature: row.data_mature === true || ['HIGH', 'VERY_HIGH'].includes(String(row.data_confidence || '')),
      score: Number(row.time_slot_score || 0),
    });
  }

  const raw: any[] = [];
  for (let dow = 0; dow <= 6; dow++) {
    let start: number | null = null;
    let current: 'ELITE_TIME' | 'STRONG_TIME' | 'OTHER' = 'OTHER';
    let scores: number[] = [];
    const close = (end: number) => {
      if (start === null || current === 'OTHER' || end <= start) return;
      raw.push({
        day: DAYS[dow],
        dow,
        start_hour: start,
        end_hour: end,
        start_time: `${String(start).padStart(2, '0')}:00`,
        end_time: `${String(end % 24).padStart(2, '0')}:00`,
        classification: current,
        adjustment: current === 'ELITE_TIME' ? 50 : 25,
        average_score: scores.length ? r2(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
      });
    };

    for (let hour = 0; hour <= 24; hour++) {
      const slot = hour < 24 ? matrix.get(`${dow}|${hour}`) : null;
      const cls = slot?.mature ? slot.cls : 'OTHER';
      if (cls !== current) {
        close(hour);
        start = cls === 'OTHER' ? null : hour;
        current = cls;
        scores = slot ? [slot.score] : [];
      } else if (cls !== 'OTHER' && slot) {
        scores.push(slot.score);
      }
    }
  }

  // Agrupa dias com o mesmo intervalo e mesmo percentual em uma regra WEEKLY.
  const grouped = new Map<string, any>();
  for (const row of raw) {
    const key = `${row.classification}|${row.start_time}|${row.end_time}|${row.adjustment}`;
    if (!grouped.has(key)) grouped.set(key, { ...row, days: [] });
    grouped.get(key).days.push(row.day);
  }
  return [...grouped.values()];
}

async function invokeRules(base44: any, accountId: string, operation: string, payload: any, campaignId?: string) {
  const response = await base44.asServiceRole.functions.invoke('amazonAdsOptimizationRulesCommand', {
    amazon_account_id: accountId,
    operation,
    campaign_id: campaignId || null,
    payload,
    max_attempts: 3,
    trigger_type: 'automatic',
    _service_role: true,
  });
  return response?.data || response || {};
}

Deno.serve(async (request) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const accountRows = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 1);
    const account = accountRows[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon Ads conectada' }, { status: 404 });

    const aid = account.id;
    const now = new Date().toISOString();
    const today = todayBRT();
    const dryRun = body.dry_run === true;

    const [configs, performance, campaigns, products, patterns, daypartDecisions, storedRules] = await Promise.all([
      base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }, null, 1).catch(() => []),
      base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, null, 1).catch(() => []),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 500).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 500).catch(() => []),
      base44.asServiceRole.entities.HourlySalesPattern.filter({ amazon_account_id: aid }, null, 500).catch(() => []),
      base44.asServiceRole.entities.DaypartingDecision.filter({ amazon_account_id: aid }, '-created_at', 1000).catch(() => []),
      base44.asServiceRole.entities.AmazonScheduledRule.filter({ amazon_account_id: aid }, '-created_at', 500).catch(() => []),
    ]);

    const cfg = configs[0] || {};
    const perf = performance[0] || {};
    if (cfg.enabled === false || cfg.dayparting_enabled === false) {
      return Response.json({ ok: true, skipped: true, reason: 'Autopilot/dayparting desabilitado' });
    }

    const targetAcos = Number(perf.target_acos || cfg.target_acos || 15);
    const productByAsin = new Map(products.map((p: any) => [String(p.asin || ''), p]));
    const windows = buildWindows(patterns, daypartDecisions);

    const activeCampaigns = campaigns.filter((campaign: any) => {
      const state = campaign.state || campaign.status;
      const product = productByAsin.get(String(campaign.asin || ''));
      return active(state) && campaign.archived !== true && stockQty(product) > 0 && String(campaign.campaign_type || 'SP').toUpperCase() === 'SP';
    });

    const eligibleCampaigns: any[] = [];
    const strategyChanges: any[] = [];
    for (const campaign of activeCampaigns) {
      const cid = String(campaign.amazon_campaign_id || campaign.campaign_id || '');
      if (!cid) continue;
      const type = targetingType(campaign);
      const currentAmazonStrategy = String(campaign.amazon_bidding_strategy || campaign.bidding_strategy || '').toUpperCase();
      if (currentAmazonStrategy === 'RULE_BASED' || norm(campaign.bidding_strategy) === 'rule_based') continue;

      const orders = Number(campaign.orders || 0);
      const sales = Number(campaign.sales || 0);
      const spend = Number(campaign.current_spend ?? campaign.spend ?? 0);
      const acos = sales > 0 ? (spend / sales) * 100 : Number(campaign.acos || 0);
      const manualStrategic = type === 'MANUAL' && orders >= 2 && sales > 0 && acos > 0 && acos <= targetAcos;
      const shouldUseUpDown = type === 'AUTO' || manualStrategic;

      if (shouldUseUpDown && currentAmazonStrategy !== 'AUTO_FOR_SALES' && norm(campaign.bidding_strategy) !== 'dynamic_up_down') {
        if (!dryRun) {
          const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
            amazon_account_id: aid,
            operation: 'set_dynamic_bidding_up_down',
            method: 'PUT',
            path: '/sp/campaigns',
            content_type: 'application/vnd.spCampaign.v3+json',
            accept: 'application/vnd.spCampaign.v3+json',
            payload: { campaigns: [{ campaignId: cid, dynamicBidding: { strategy: 'AUTO_FOR_SALES' } }] },
            max_attempts: 3,
            _service_role: true,
          }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
          const ok = amazonSuccess(response, 'campaigns');
          if (ok) {
            await base44.asServiceRole.entities.Campaign.update(campaign.id, {
              bidding_strategy: 'dynamic_up_down',
              amazon_bidding_strategy: 'AUTO_FOR_SALES',
              bidding_strategy_reason: type === 'AUTO'
                ? 'Regra canônica: campanhas automáticas usam aumento e redução dinâmicos.'
                : `Campanha manual estratégica: ${orders} pedidos e ACoS ${r2(acos)}% <= meta ${targetAcos}%.`,
              bidding_strategy_last_changed_at: now,
              bidding_strategy_next_review_at: nextReviewIso(),
              bidding_strategy_request_id: response?.data?.request_id || response?.request_id || null,
            }).catch(() => {});
          }
          strategyChanges.push({ campaign_id: cid, targeting_type: type, desired: 'AUTO_FOR_SALES', ok });
        } else {
          strategyChanges.push({ campaign_id: cid, targeting_type: type, desired: 'AUTO_FOR_SALES', ok: true, dry_run: true });
        }
      }

      eligibleCampaigns.push({ ...campaign, resolved_campaign_id: cid, resolved_targeting_type: type });
    }

    if (windows.length === 0 || eligibleCampaigns.length === 0) {
      return Response.json({
        ok: true,
        skipped: true,
        reason: windows.length === 0 ? 'Sem janelas fortes maduras' : 'Sem campanhas elegíveis com estoque',
        strategy_changes: strategyChanges,
      });
    }

    let nativeSupported = true;
    const results: any[] = [];
    let rulesCreated = 0;
    let associations = 0;
    let associationFailures = 0;

    for (const window of windows) {
      const dayToken = [...window.days].sort().join('-');
      const ruleName = `LF_${window.classification === 'ELITE_TIME' ? 'ELITE' : 'STRONG'}_${window.start_time.replace(':', '')}_${window.end_time.replace(':', '')}_${dayToken}`.slice(0, 120);
      const idem = `${aid}|BID|SCHEDULE|${window.adjustment}|${window.start_time}|${window.end_time}|${dayToken}`;
      const existingLocal = storedRules.find((row: any) => row.idempotency_key === idem && ['enabled', 'creating', 'planned'].includes(String(row.status || '')));
      let localRule = existingLocal || null;
      let ruleId = String(existingLocal?.optimization_rule_id || '');

      if (!ruleId && nativeSupported && !dryRun) {
        const search = await invokeRules(base44, aid, 'search_rules', {
          maxResults: 20,
          optimizationRuleFilter: {
            ruleName: { filterType: 'EXACT_MATCH', values: [ruleName] },
            ruleCategory: { filterType: 'EXACT_MATCH', values: ['BID'] },
            ruleSubCategory: { filterType: 'EXACT_MATCH', values: ['SCHEDULE'] },
          },
        });
        const found = extractRules(search).find((rule: any) => String(rule.ruleName || '') === ruleName);
        ruleId = String(found?.optimizationRuleId || '');

        if (!ruleId && search?.unsupported === true) {
          nativeSupported = false;
        }
      }

      if (!localRule) {
        localRule = await base44.asServiceRole.entities.AmazonScheduledRule.create({
          amazon_account_id: aid,
          marketplace_id: account.marketplace_id || account.marketplace || null,
          profile_id: String(account.ads_profile_id || ''),
          optimization_rule_id: ruleId || null,
          rule_name: ruleName,
          rule_category: 'BID',
          rule_subcategory: 'SCHEDULE',
          recurrence_type: 'WEEKLY',
          days_of_week: window.days,
          start_time: window.start_time,
          end_time: window.end_time,
          duration_start: `${today}T00:00:00Z`,
          adjustment_operator: 'INCREMENT',
          adjustment_unit: 'PERCENT',
          adjustment_value: window.adjustment,
          slot_classification: window.classification,
          campaign_ids: eligibleCampaigns.map((c) => c.resolved_campaign_id),
          asins: [...new Set(eligibleCampaigns.map((c) => c.asin).filter(Boolean))],
          targeting_types: [...new Set(eligibleCampaigns.map((c) => c.resolved_targeting_type))],
          status: dryRun ? 'planned' : 'creating',
          association_status: 'pending',
          native_api_supported: nativeSupported,
          fallback_mode: nativeSupported ? 'amazon_native_positive_app_negative' : 'app_managed_only',
          idempotency_key: idem,
          engine_version: ENGINE_VERSION,
          reason: `Janela ${window.classification}, score médio ${window.average_score}. Amazon nativa aplica somente aumento; reduções ficam no motor do app.`,
          created_at: now,
          updated_at: now,
          next_review_at: nextReviewIso(),
        });
      }

      if (!ruleId && nativeSupported && !dryRun) {
        const created = await invokeRules(base44, aid, 'create_rules', {
          optimizationRules: [{
            action: {
              actionDetails: {
                actionOperator: 'INCREMENT',
                actionUnit: 'PERCENT',
                value: String(window.adjustment),
              },
              actionType: 'ADOPT',
            },
            recurrence: {
              daysOfWeek: window.days,
              duration: { startTime: `${today}T00:00:00Z` },
              timesOfDay: [{ startTime: window.start_time, endTime: window.end_time }],
              type: 'WEEKLY',
            },
            ruleCategory: 'BID',
            ruleName,
            ruleSubCategory: 'SCHEDULE',
            status: 'ENABLED',
          }],
        });
        ruleId = extractRuleId(created);
        if (!created?.ok && created?.unsupported) nativeSupported = false;

        await base44.asServiceRole.entities.AmazonScheduledRule.update(localRule.id, {
          optimization_rule_id: ruleId || null,
          status: ruleId ? 'enabled' : nativeSupported ? 'failed' : 'unsupported',
          native_api_supported: nativeSupported,
          fallback_mode: nativeSupported ? 'amazon_native_positive_app_negative' : 'app_managed_only',
          amazon_request_id: created?.request_id || null,
          amazon_response_status: Number(created?.status || 0) || null,
          amazon_response: JSON.stringify(created?.payload || created || {}).slice(0, 4000),
          last_error: ruleId ? null : String(created?.error || 'optimization_rule_id não retornado').slice(0, 500),
          last_synced_at: now,
          updated_at: now,
        }).catch(() => {});
        if (ruleId) rulesCreated++;
      }

      if (dryRun) {
        results.push({ rule_name: ruleName, adjustment: window.adjustment, campaigns: eligibleCampaigns.length, dry_run: true });
        continue;
      }

      if (!nativeSupported || !ruleId) {
        results.push({ rule_name: ruleName, ok: false, fallback: 'app_managed_only', rule_id: ruleId || null });
        continue;
      }

      const associated: string[] = [];
      const failed: string[] = [];
      for (const campaign of eligibleCampaigns) {
        const cid = campaign.resolved_campaign_id;
        const response = await invokeRules(base44, aid, 'associate_rules', { optimizationRuleIds: [ruleId] }, cid);
        if (response?.ok || response?.conflict_existing) {
          associated.push(cid);
          associations++;
        } else {
          failed.push(cid);
          associationFailures++;
        }
        await wait(350);
      }

      await base44.asServiceRole.entities.AmazonScheduledRule.update(localRule.id, {
        optimization_rule_id: ruleId,
        status: 'enabled',
        association_status: failed.length === 0 ? 'associated' : associated.length > 0 ? 'partial' : 'failed',
        associated_campaign_ids: associated,
        failed_campaign_ids: failed,
        campaign_ids: eligibleCampaigns.map((c) => c.resolved_campaign_id),
        native_api_supported: true,
        fallback_mode: 'amazon_native_positive_app_negative',
        last_associated_at: now,
        last_synced_at: now,
        updated_at: now,
        next_review_at: nextReviewIso(),
      }).catch(() => {});

      results.push({ rule_name: ruleName, rule_id: ruleId, adjustment: window.adjustment, associated: associated.length, failed: failed.length });
    }

    // Evita briga com o dayparting legado: cancela apenas aumentos diretos futuros das campanhas nativas.
    if (!dryRun && nativeSupported) {
      const queues = await base44.asServiceRole.entities.AmazonActionQueue.filter({ amazon_account_id: aid }, 'scheduled_at', 500).catch(() => []);
      const eligibleIds = new Set(eligibleCampaigns.map((c) => c.resolved_campaign_id));
      for (const action of queues) {
        if (!['pending', 'approved'].includes(String(action.status || ''))) continue;
        if (!['daypart_bid_increase', 'keyword_bid_update'].includes(String(action.operation || ''))) continue;
        let payload: any = action.payload || {};
        if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { payload = {}; } }
        const cid = String(payload.campaign_id || (action as any).campaign_id || '');
        if (!cid || !eligibleIds.has(cid)) continue;
        await base44.asServiceRole.entities.AmazonActionQueue.update(action.id, {
          status: 'cancelled',
          last_error: 'Cancelado: aumento passou a ser gerenciado por Amazon Schedule Bid Rule nativa.',
          completed_at: now,
        }).catch(() => {});
      }
    }

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'sync_amazon_schedule_bid_rules',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      status: associationFailures > 0 && associations === 0 ? 'error' : nativeSupported ? 'success' : 'partial',
      execution_date: today,
      started_at: new Date(startedAt).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      records_processed: associations,
      result_summary: JSON.stringify({ windows: windows.length, campaigns: eligibleCampaigns.length, rules_created: rulesCreated, associations, native_supported: nativeSupported }).slice(0, 1500),
      error_message: nativeSupported ? null : 'Optimization Rules não disponível para este perfil/marketplace. Fallback app_managed_only ativado.',
    }).catch(() => {});

    return Response.json({
      ok: associationFailures === 0 || associations > 0 || !nativeSupported,
      engine_version: ENGINE_VERSION,
      native_api_supported: nativeSupported,
      fallback_mode: nativeSupported ? 'amazon_native_positive_app_negative' : 'app_managed_only',
      schedule_rule_limit: 'Amazon Schedule Bid Rules somente incrementam bids; reduções ficam no motor LivingFinds.',
      windows_found: windows.length,
      campaigns_eligible: eligibleCampaigns.length,
      rules_created: rulesCreated,
      associations,
      association_failures: associationFailures,
      strategy_changes: strategyChanges,
      results,
      duration_ms: Date.now() - startedAt,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha ao sincronizar Schedule Bid Rules' }, { status: 500 });
  }
});
