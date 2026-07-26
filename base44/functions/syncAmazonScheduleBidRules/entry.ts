import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

/**
 * Sincroniza Schedule Bid Rules diretamente na Amazon Ads.
 *
 * Arquitetura:
 * - Amazon: estratégia base FIXED (MANUAL) + regras nativas apenas de INCREMENT.
 * - LivingFinds: aumento/redução dinâmicos limitados a 0,50x–1,50x do bid-base.
 *
 * A estratégia AUTO_FOR_SALES não é usada por padrão porque a Amazon pode
 * variar o bid em até 100%, ultrapassando o envelope solicitado de ±50%.
 */
const DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const ENGINE_VERSION = 'amazon-native-schedule-v2-capped';
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const norm = (value: any) => String(value || '').trim().toLowerCase();
const active = (value: any) => ['enabled', 'active'].includes(norm(value));
const r2 = (value: number) => Math.round(Number(value || 0) * 100) / 100;

function todayBRT() {
  return new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
}

function nextReview() {
  return new Date(Date.now() + 72 * 3600000).toISOString();
}

function qty(product: any) {
  return Number(product?.fba_inventory ?? product?.available_quantity ?? product?.fulfillable_quantity ?? product?.stock ?? 0);
}

function typeOf(campaign: any): 'AUTO' | 'MANUAL' {
  const explicit = String(campaign?.targeting_type || campaign?.targetingType || '').toUpperCase();
  if (explicit === 'AUTO' || explicit === 'MANUAL') return explicit;
  return /manual/i.test(String(campaign?.name || campaign?.campaign_name || '')) ? 'MANUAL' : 'AUTO';
}

function cls(value: any): 'ELITE_TIME' | 'STRONG_TIME' | 'OTHER' {
  const text = String(value || '').toUpperCase();
  if (text === 'PEAK_ELITE' || text === 'ELITE_TIME') return 'ELITE_TIME';
  if (text === 'PEAK_STRONG' || text === 'STRONG_TIME') return 'STRONG_TIME';
  return 'OTHER';
}

function buildWindows(patterns: any[], decisions: any[]) {
  const slots = new Map<string, { classification: string; mature: boolean; score: number }>();
  for (const row of patterns) {
    const dow = Number(row.day_of_week), hour = Number(row.hour);
    if (dow < 0 || dow > 6 || hour < 0 || hour > 23) continue;
    slots.set(`${dow}|${hour}`, {
      classification: cls(row.classification),
      mature: Number(row.occurrences || 0) >= 3 && String(row.classification || '') !== 'INSUFFICIENT_DATA',
      score: Number(row.peak_score || 0),
    });
  }
  for (const row of decisions) {
    const dow = Number(row.day_of_week), hour = Number(row.hour);
    if (dow < 0 || dow > 6 || hour < 0 || hour > 23) continue;
    const classification = cls(row.slot_classification);
    if (classification === 'OTHER') continue;
    slots.set(`${dow}|${hour}`, {
      classification,
      mature: row.data_mature === true || ['HIGH', 'VERY_HIGH'].includes(String(row.data_confidence || '')),
      score: Number(row.time_slot_score || 0),
    });
  }

  const raw: any[] = [];
  for (let dow = 0; dow < 7; dow++) {
    let start: number | null = null;
    let current = 'OTHER';
    let scores: number[] = [];
    const close = (end: number) => {
      if (start === null || current === 'OTHER' || end <= start) return;
      raw.push({
        classification: current,
        day: DAYS[dow],
        start_time: `${String(start).padStart(2, '0')}:00`,
        end_time: `${String(end % 24).padStart(2, '0')}:00`,
        adjustment: current === 'ELITE_TIME' ? 50 : 25,
        average_score: scores.length ? r2(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
      });
    };
    for (let hour = 0; hour <= 24; hour++) {
      const slot = hour < 24 ? slots.get(`${dow}|${hour}`) : null;
      const next = slot?.mature ? slot.classification : 'OTHER';
      if (next !== current) {
        close(hour);
        start = next === 'OTHER' ? null : hour;
        current = next;
        scores = slot ? [slot.score] : [];
      } else if (slot && next !== 'OTHER') scores.push(slot.score);
    }
  }

  const grouped = new Map<string, any>();
  for (const row of raw) {
    const key = `${row.classification}|${row.start_time}|${row.end_time}|${row.adjustment}`;
    if (!grouped.has(key)) grouped.set(key, { ...row, days: [] });
    grouped.get(key).days.push(row.day);
  }
  return [...grouped.values()];
}

function rulesData(response: any) {
  const data = response?.data || response || {};
  return { data, payload: data?.payload || {} };
}

function ruleId(response: any): string {
  const { payload } = rulesData(response);
  return String(
    payload?.optimizationRules?.success?.[0]?.optimizationRuleId ||
    payload?.optimizationRules?.[0]?.optimizationRuleId ||
    payload?.responses?.[0]?.optimizationRuleId ||
    payload?.success?.[0]?.optimizationRuleId ||
    payload?.optimizationRuleId || '',
  );
}

function foundRules(response: any): any[] {
  const { payload } = rulesData(response);
  return Array.isArray(payload?.optimizationRules) ? payload.optimizationRules : [];
}

function campaignUpdateOk(response: any): boolean {
  const data = response?.data || response || {};
  if (data?.ok === false) return false;
  if (Number(data?.status || 0) !== 207) return data?.ok === true;
  const payload = data?.payload || {};
  const success = payload?.campaigns?.success || payload?.success || [];
  return Array.isArray(success) ? success.length > 0 : true;
}

async function rulesCommand(base44: any, aid: string, operation: string, payload: any, campaignId?: string) {
  const response = await base44.asServiceRole.functions.invoke('amazonAdsOptimizationRulesCommand', {
    amazon_account_id: aid,
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
  const started = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon Ads conectada' }, { status: 404 });

    const aid = account.id;
    const now = new Date().toISOString();
    const today = todayBRT();
    const dryRun = body.dry_run === true;

    const [configs, performance, campaigns, products, patterns, decisions, stored] = await Promise.all([
      base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }, null, 1).catch(() => []),
      base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, null, 1).catch(() => []),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 500).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 500).catch(() => []),
      base44.asServiceRole.entities.HourlySalesPattern.filter({ amazon_account_id: aid }, null, 500).catch(() => []),
      base44.asServiceRole.entities.DaypartingDecision.filter({ amazon_account_id: aid }, '-created_at', 1500).catch(() => []),
      base44.asServiceRole.entities.AmazonScheduledRule.filter({ amazon_account_id: aid }, '-created_at', 500).catch(() => []),
    ]);

    const cfg = configs[0] || {};
    const perf = performance[0] || {};
    if (cfg.enabled === false || cfg.dayparting_enabled === false) {
      return Response.json({ ok: true, skipped: true, reason: 'Autopilot/dayparting desabilitado' });
    }

    const strictEnvelope = cfg.strict_bid_envelope !== false;
    const desiredAmazonStrategy = strictEnvelope ? 'MANUAL' : 'AUTO_FOR_SALES';
    const localControlMode = strictEnvelope ? 'livingfinds_dynamic_up_down_capped_50' : 'amazon_dynamic_up_down_uncapped';
    const targetAcos = Number(perf.target_acos || cfg.target_acos || 15);
    const productByAsin = new Map(products.map((p: any) => [String(p.asin || ''), p]));
    const windows = buildWindows(patterns, decisions);

    const eligible: any[] = [];
    const strategyChanges: any[] = [];
    for (const campaign of campaigns) {
      const cid = String(campaign.amazon_campaign_id || campaign.campaign_id || '');
      const product = productByAsin.get(String(campaign.asin || ''));
      if (!cid || !active(campaign.state || campaign.status) || campaign.archived === true || qty(product) <= 0 || String(campaign.campaign_type || 'SP').toUpperCase() !== 'SP') continue;

      const type = typeOf(campaign);
      const spend = Number(campaign.current_spend ?? campaign.spend ?? 0);
      const sales = Number(campaign.sales || 0);
      const orders = Number(campaign.orders || 0);
      const acos = sales > 0 ? (spend / sales) * 100 : Number(campaign.acos || 0);
      const manualStrategic = type === 'MANUAL' && orders >= Number(cfg.min_orders_for_scale || 2) && sales > 0 && acos > 0 && acos <= targetAcos;
      const managed = type === 'AUTO' || manualStrategic;
      if (!managed) continue;

      const currentAmazon = String(campaign.amazon_bidding_strategy || '').toUpperCase();
      const currentLocal = norm(campaign.bidding_strategy);
      const needsStrategy = currentAmazon !== desiredAmazonStrategy || currentLocal !== norm(localControlMode);

      if (needsStrategy) {
        if (dryRun) {
          strategyChanges.push({ campaign_id: cid, from: currentAmazon || currentLocal, to: desiredAmazonStrategy, local_mode: localControlMode, dry_run: true });
        } else {
          const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
            amazon_account_id: aid,
            operation: 'configure_capped_dynamic_bid_control',
            method: 'PUT',
            path: '/sp/campaigns',
            content_type: 'application/vnd.spCampaign.v3+json',
            accept: 'application/vnd.spCampaign.v3+json',
            payload: { campaigns: [{ campaignId: cid, dynamicBidding: { strategy: desiredAmazonStrategy } }] },
            max_attempts: 3,
            _service_role: true,
          }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
          const ok = campaignUpdateOk(response);
          if (ok) {
            await base44.asServiceRole.entities.Campaign.update(campaign.id, {
              bidding_strategy: localControlMode,
              amazon_bidding_strategy: desiredAmazonStrategy,
              bidding_strategy_reason: strictEnvelope
                ? 'Envelope estrito ±50%: Amazon mantém bid-base fixo; LivingFinds e Schedule Bid Rules aplicam variação controlada.'
                : 'Modo Amazon dynamic up/down explicitamente liberado; pode exceder ±50%.',
              bidding_strategy_last_changed_at: now,
              bidding_strategy_next_review_at: nextReview(),
              bidding_strategy_request_id: response?.data?.request_id || response?.request_id || null,
            }).catch(() => {});
          }
          strategyChanges.push({ campaign_id: cid, from: currentAmazon || currentLocal, to: desiredAmazonStrategy, local_mode: localControlMode, ok });
        }
      }

      eligible.push({ ...campaign, resolved_campaign_id: cid, resolved_targeting_type: type });
    }

    if (windows.length === 0 || eligible.length === 0) {
      return Response.json({
        ok: true,
        skipped: true,
        reason: windows.length === 0 ? 'Sem janelas fortes maduras' : 'Sem campanhas elegíveis com estoque',
        strict_bid_envelope: strictEnvelope,
        strategy_changes: strategyChanges,
      });
    }

    let nativeSupported = true;
    let rulesCreated = 0, associations = 0, failedAssociations = 0;
    const results: any[] = [];

    for (const window of windows) {
      const dayToken = [...window.days].sort().join('-');
      const ruleName = `LF_${window.classification === 'ELITE_TIME' ? 'ELITE' : 'STRONG'}_${window.start_time.replace(':', '')}_${window.end_time.replace(':', '')}_${dayToken}`.slice(0, 120);
      const idem = `${aid}|BID|SCHEDULE|${window.adjustment}|${window.start_time}|${window.end_time}|${dayToken}`;
      let local = stored.find((row: any) => row.idempotency_key === idem && !['archived', 'failed'].includes(String(row.status || ''))) || null;
      let id = String(local?.optimization_rule_id || '');

      if (!id && nativeSupported && !dryRun) {
        const search = await rulesCommand(base44, aid, 'search_rules', {
          maxResults: 20,
          optimizationRuleFilter: {
            ruleName: { filterType: 'EXACT_MATCH', values: [ruleName] },
            ruleCategory: { filterType: 'EXACT_MATCH', values: ['BID'] },
            ruleSubCategory: { filterType: 'EXACT_MATCH', values: ['SCHEDULE'] },
          },
        });
        id = String(foundRules(search).find((rule: any) => String(rule.ruleName || '') === ruleName)?.optimizationRuleId || '');
        if (search?.unsupported === true) nativeSupported = false;
      }

      if (!local) {
        local = await base44.asServiceRole.entities.AmazonScheduledRule.create({
          amazon_account_id: aid,
          marketplace_id: account.marketplace_id || account.marketplace || null,
          profile_id: String(account.ads_profile_id || ''),
          optimization_rule_id: id || null,
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
          campaign_ids: eligible.map((c) => c.resolved_campaign_id),
          asins: [...new Set(eligible.map((c) => c.asin).filter(Boolean))],
          targeting_types: [...new Set(eligible.map((c) => c.resolved_targeting_type))],
          status: dryRun ? 'planned' : nativeSupported ? 'creating' : 'unsupported',
          association_status: 'pending',
          native_api_supported: nativeSupported,
          fallback_mode: nativeSupported ? 'amazon_native_positive_app_negative' : 'app_managed_only',
          idempotency_key: idem,
          engine_version: ENGINE_VERSION,
          reason: `${window.classification}, score ${window.average_score}. Amazon incrementa ${window.adjustment}%; reduções ficam no LivingFinds.`,
          created_at: now,
          updated_at: now,
          next_review_at: nextReview(),
        });
      }

      if (!id && nativeSupported && !dryRun) {
        const created = await rulesCommand(base44, aid, 'create_rules', {
          optimizationRules: [{
            action: { actionDetails: { actionOperator: 'INCREMENT', actionUnit: 'PERCENT', value: String(window.adjustment) }, actionType: 'ADOPT' },
            recurrence: {
              daysOfWeek: window.days,
              duration: { startTime: `${today}T00:00:00Z` },
              timesOfDay: [{ startTime: window.start_time, endTime: window.end_time }],
              type: 'WEEKLY',
            },
            ruleCategory: 'BID', ruleName, ruleSubCategory: 'SCHEDULE', status: 'ENABLED',
          }],
        });
        id = ruleId(created);
        if (!created?.ok && created?.unsupported) nativeSupported = false;
        await base44.asServiceRole.entities.AmazonScheduledRule.update(local.id, {
          optimization_rule_id: id || null,
          status: id ? 'enabled' : nativeSupported ? 'failed' : 'unsupported',
          native_api_supported: nativeSupported,
          fallback_mode: nativeSupported ? 'amazon_native_positive_app_negative' : 'app_managed_only',
          amazon_request_id: created?.request_id || null,
          amazon_response_status: Number(created?.status || 0) || null,
          amazon_response: JSON.stringify(created?.payload || created || {}).slice(0, 4000),
          last_error: id ? null : String(created?.error || 'optimization_rule_id ausente').slice(0, 500),
          last_synced_at: now,
          updated_at: now,
        }).catch(() => {});
        if (id) rulesCreated++;
      }

      if (dryRun) {
        results.push({ rule_name: ruleName, adjustment: window.adjustment, campaigns: eligible.length, dry_run: true });
        continue;
      }
      if (!nativeSupported || !id) {
        results.push({ rule_name: ruleName, ok: false, fallback: 'app_managed_only' });
        continue;
      }

      const associated: string[] = [], failed: string[] = [];
      for (const campaign of eligible) {
        const cid = campaign.resolved_campaign_id;
        const response = await rulesCommand(base44, aid, 'associate_rules', { optimizationRuleIds: [id] }, cid);
        if (response?.ok || response?.conflict_existing) { associated.push(cid); associations++; }
        else { failed.push(cid); failedAssociations++; }
        await wait(350);
      }

      await base44.asServiceRole.entities.AmazonScheduledRule.update(local.id, {
        optimization_rule_id: id,
        status: 'enabled',
        association_status: failed.length === 0 ? 'associated' : associated.length > 0 ? 'partial' : 'failed',
        associated_campaign_ids: associated,
        failed_campaign_ids: failed,
        campaign_ids: eligible.map((c) => c.resolved_campaign_id),
        native_api_supported: true,
        fallback_mode: 'amazon_native_positive_app_negative',
        last_associated_at: now,
        last_synced_at: now,
        updated_at: now,
        next_review_at: nextReview(),
      }).catch(() => {});
      results.push({ rule_name: ruleName, rule_id: id, adjustment: window.adjustment, associated: associated.length, failed: failed.length });
    }

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'sync_amazon_schedule_bid_rules',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      status: failedAssociations > 0 && associations === 0 ? 'error' : nativeSupported ? 'success' : 'partial',
      execution_date: today,
      started_at: new Date(started).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      records_processed: associations,
      result_summary: JSON.stringify({ windows: windows.length, campaigns: eligible.length, rules_created: rulesCreated, associations, native_supported: nativeSupported, strict_envelope: strictEnvelope }).slice(0, 1500),
      error_message: nativeSupported ? null : 'Optimization Rules indisponível neste perfil/marketplace; fallback app_managed_only ativado.',
    }).catch(() => {});

    return Response.json({
      ok: failedAssociations === 0 || associations > 0 || !nativeSupported,
      engine_version: ENGINE_VERSION,
      strict_bid_envelope: strictEnvelope,
      amazon_base_strategy: desiredAmazonStrategy,
      livingfinds_control_mode: localControlMode,
      native_api_supported: nativeSupported,
      fallback_mode: nativeSupported ? 'amazon_native_positive_app_negative' : 'app_managed_only',
      rule_limit: 'Schedule Bid Rules nativas somente incrementam bids.',
      windows_found: windows.length,
      campaigns_eligible: eligible.length,
      rules_created: rulesCreated,
      associations,
      association_failures: failedAssociations,
      strategy_changes: strategyChanges,
      results,
      duration_ms: Date.now() - started,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha ao sincronizar Schedule Bid Rules' }, { status: 500 });
  }
});
