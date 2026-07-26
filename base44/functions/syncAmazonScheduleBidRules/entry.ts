import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

/**
 * Sincroniza Schedule Bid Rules da Amazon Ads por campanha/produto.
 *
 * Modo estrito padrão:
 * - Amazon mantém o bid-base fixo (`MANUAL`);
 * - regras nativas incrementam +25%/+50% nas janelas STRONG/ELITE;
 * - LivingFinds reduz/restaura dentro do envelope 0,50x–1,50x;
 * - campanhas manuais só entram quando estratégicas.
 */
const DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const ENGINE_VERSION = 'amazon-native-schedule-v5-configurable';
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

function stock(product: any) {
  return Number(product?.fba_inventory ?? product?.available_quantity ?? product?.fulfillable_quantity ?? product?.stock ?? 0);
}

function targetingType(campaign: any): 'AUTO' | 'MANUAL' {
  const explicit = String(campaign?.targeting_type || campaign?.targetingType || '').toUpperCase();
  if (explicit === 'AUTO' || explicit === 'MANUAL') return explicit;
  return /manual/i.test(String(campaign?.name || campaign?.campaign_name || '')) ? 'MANUAL' : 'AUTO';
}

function slotClass(value: any): 'ELITE_TIME' | 'STRONG_TIME' | 'OTHER' {
  const text = String(value || '').toUpperCase();
  if (text === 'PEAK_ELITE' || text === 'ELITE_TIME') return 'ELITE_TIME';
  if (text === 'PEAK_STRONG' || text === 'STRONG_TIME') return 'STRONG_TIME';
  return 'OTHER';
}

function hashText(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).toUpperCase();
}

function buildWindows(patterns: any[], decisions: any[]) {
  const slots = new Map<string, { classification: string; mature: boolean; score: number }>();
  const orderedPatterns = [...patterns].sort((a, b) => new Date(a.updated_at || a.created_at || 0).getTime() - new Date(b.updated_at || b.created_at || 0).getTime());
  const orderedDecisions = [...decisions].sort((a, b) => new Date(a.updated_at || a.created_at || 0).getTime() - new Date(b.updated_at || b.created_at || 0).getTime());

  // Ordem antiga → nova: o registro mais recente sobrescreve o anterior.
  for (const row of orderedPatterns) {
    const dow = Number(row.day_of_week), hour = Number(row.hour);
    if (dow < 0 || dow > 6 || hour < 0 || hour > 23) continue;
    slots.set(`${dow}|${hour}`, {
      classification: slotClass(row.classification),
      mature: Number(row.occurrences || 0) >= 3 && String(row.classification || '') !== 'INSUFFICIENT_DATA',
      score: Number(row.peak_score || 0),
    });
  }
  for (const row of orderedDecisions) {
    const dow = Number(row.day_of_week), hour = Number(row.hour);
    if (dow < 0 || dow > 6 || hour < 0 || hour > 23) continue;
    const classification = slotClass(row.slot_classification);
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
        average_score: scores.length ? r2(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0,
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

function ruleId(response: any) {
  const data = response?.data || response || {};
  const payload = data?.payload || {};
  return String(
    payload?.optimizationRules?.success?.[0]?.optimizationRuleId ||
    payload?.optimizationRules?.[0]?.optimizationRuleId ||
    payload?.responses?.[0]?.optimizationRuleId ||
    payload?.success?.[0]?.optimizationRuleId ||
    payload?.optimizationRuleId || '',
  );
}

function remoteRules(response: any): any[] {
  const data = response?.data || response || {};
  const payload = data?.payload || {};
  return Array.isArray(payload?.optimizationRules) ? payload.optimizationRules : [];
}

function campaignUpdateOk(response: any) {
  const data = response?.data || response || {};
  if (data?.ok === false) return false;
  if (Number(data?.status || 0) !== 207) return data?.ok === true;
  const payload = data?.payload || {};
  const success = payload?.campaigns?.success || payload?.success || [];
  return Array.isArray(success) ? success.length > 0 : true;
}

async function rulesCommand(base44: any, accountId: string, operation: string, payload: any, campaignId?: string) {
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

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon Ads conectada' }, { status: 404 });

    const aid = account.id;
    const now = new Date().toISOString();
    const today = todayBRT();
    const dryRun = body.dry_run === true;
    const force = body.force === true || body.force_native_sync === true;

    const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }, null, 1).catch(() => []);
    const cfg = configs[0] || {};
    if (cfg.enabled === false || cfg.dayparting_enabled === false) {
      return Response.json({ ok: true, skipped: true, reason: 'Autopilot/dayparting desabilitado' });
    }

    const nativeRulesEnabled = cfg.amazon_native_schedule_rules_enabled !== false;
    const syncFrequencyHours = Math.max(1, Number(cfg.native_rules_sync_frequency_hours || 24));
    if (!force && !dryRun) {
      const recentLogs = await base44.asServiceRole.entities.SyncExecutionLog.filter({
        amazon_account_id: aid,
        operation: 'sync_amazon_schedule_bid_rules',
      }, '-completed_at', 10).catch(() => []);
      const cutoff = Date.now() - syncFrequencyHours * 3600000;
      const alreadyDone = recentLogs.some((log: any) =>
        ['success', 'partial'].includes(String(log.status || '')) &&
        new Date(log.completed_at || log.started_at || 0).getTime() >= cutoff,
      );
      if (alreadyDone) return Response.json({ ok: true, skipped: true, reason: 'sync_frequency_not_elapsed', sync_frequency_hours: syncFrequencyHours });
    }

    const [performance, campaigns, products, patterns, decisions, storedRules] = await Promise.all([
      base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, null, 1).catch(() => []),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 500).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 500).catch(() => []),
      base44.asServiceRole.entities.HourlySalesPattern.filter({ amazon_account_id: aid }, null, 1000).catch(() => []),
      base44.asServiceRole.entities.DaypartingDecision.filter({ amazon_account_id: aid }, 'created_at', 5000).catch(() => []),
      base44.asServiceRole.entities.AmazonScheduledRule.filter({ amazon_account_id: aid }, '-updated_at', 2000).catch(() => []),
    ]);

    const perf = performance[0] || {};
    const strictEnvelope = cfg.strict_bid_envelope !== false;
    const desiredAmazonStrategy = strictEnvelope ? 'MANUAL' : 'AUTO_FOR_SALES';
    const desiredLocalStrategy = strictEnvelope ? 'fixed' : 'dynamic_up_down';
    const controlMode = strictEnvelope ? 'livingfinds_dynamic_up_down_capped_50' : 'amazon_dynamic_up_down_uncapped';
    const targetAcos = Number(perf.target_acos || cfg.target_acos || 15);
    const minManualOrders = Number(cfg.min_orders_for_scale || 2);
    const productByAsin = new Map(products.map((product: any) => [String(product.asin || ''), product]));

    const eligible: any[] = [];
    const strategyChanges: any[] = [];
    for (const campaign of campaigns) {
      const cid = String(campaign.amazon_campaign_id || campaign.campaign_id || '');
      const product = productByAsin.get(String(campaign.asin || ''));
      if (!cid || !active(campaign.state || campaign.status) || campaign.archived === true || stock(product) <= 0 || String(campaign.campaign_type || 'SP').toUpperCase() !== 'SP') continue;

      const type = targetingType(campaign);
      const spend = Number(campaign.current_spend ?? campaign.spend ?? 0);
      const sales = Number(campaign.sales || 0);
      const orders = Number(campaign.orders || 0);
      const acos = sales > 0 ? (spend / sales) * 100 : Number(campaign.acos || 0);
      const strategicManual = type === 'MANUAL' && orders >= minManualOrders && sales > 0 && acos > 0 && acos <= targetAcos;
      if (type === 'MANUAL' && !strategicManual) continue;

      const currentAmazon = String(campaign.amazon_bidding_strategy || '').toUpperCase();
      const currentLocal = norm(campaign.bidding_strategy);
      const currentControl = norm(campaign.bid_control_mode);
      const needsStrategy = currentAmazon !== desiredAmazonStrategy || currentLocal !== desiredLocalStrategy || currentControl !== controlMode;

      if (needsStrategy) {
        if (dryRun) {
          strategyChanges.push({ campaign_id: cid, amazon_from: currentAmazon, amazon_to: desiredAmazonStrategy, local_to: desiredLocalStrategy, control_mode: controlMode, dry_run: true });
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
              bidding_strategy: desiredLocalStrategy,
              amazon_bidding_strategy: desiredAmazonStrategy,
              bid_control_mode: controlMode,
              bidding_strategy_reason: strictEnvelope
                ? 'Envelope estrito ±50%: Amazon mantém bid-base fixo; LivingFinds e Schedule Bid Rules aplicam variação controlada.'
                : 'AUTO_FOR_SALES liberado explicitamente; a Amazon pode exceder ±50%.',
              bidding_strategy_last_changed_at: now,
              bidding_strategy_next_review_at: nextReview(),
              bidding_strategy_request_id: response?.data?.request_id || response?.request_id || null,
            }).catch(() => {});
          }
          strategyChanges.push({ campaign_id: cid, amazon_from: currentAmazon, amazon_to: desiredAmazonStrategy, local_to: desiredLocalStrategy, control_mode: controlMode, ok });
        }
      }

      eligible.push({ ...campaign, resolved_campaign_id: cid, resolved_targeting_type: type });
    }

    const plans = new Map<string, any>();
    for (const campaign of eligible) {
      const cid = campaign.resolved_campaign_id;
      const asin = String(campaign.asin || '');
      const specificDecisions = decisions.filter((decision: any) =>
        String(decision.campaign_id || '') === cid ||
        (asin && String(decision.asin || '') === asin),
      );
      const campaignWindows = buildWindows(patterns, specificDecisions);
      for (const window of campaignWindows) {
        const dayToken = [...window.days].sort().join('-');
        const windowKey = `${window.classification}|${window.start_time}|${window.end_time}|${window.adjustment}|${dayToken}`;
        if (!plans.has(windowKey)) plans.set(windowKey, { ...window, dayToken, campaigns: [] });
        plans.get(windowKey).campaigns.push(campaign);
      }
    }

    const desiredKeys = new Set<string>();
    let apiSupported = true;
    let rulesCreated = 0, rulesReactivated = 0, rulesPaused = 0, associations = 0, associationFailures = 0;
    const results: any[] = [];

    for (const plan of plans.values()) {
      const campaignIds = [...new Set(plan.campaigns.map((campaign: any) => String(campaign.resolved_campaign_id)))].sort();
      const membershipHash = hashText(campaignIds.join('|'));
      const ruleName = `LF_${plan.classification === 'ELITE_TIME' ? 'ELITE' : 'STRONG'}_${plan.start_time.replace(':', '')}_${plan.end_time.replace(':', '')}_${plan.dayToken}_${membershipHash}`.slice(0, 120);
      const idem = `${aid}|BID|SCHEDULE|${plan.adjustment}|${plan.start_time}|${plan.end_time}|${plan.dayToken}|${membershipHash}`;
      desiredKeys.add(idem);

      let local = storedRules.find((rule: any) => rule.idempotency_key === idem) || null;
      let id = String(local?.optimization_rule_id || '');

      if (!id && nativeRulesEnabled && apiSupported && !dryRun) {
        const search = await rulesCommand(base44, aid, 'search_rules', {
          maxResults: 20,
          optimizationRuleFilter: {
            ruleName: { filterType: 'EXACT_MATCH', values: [ruleName] },
            ruleCategory: { filterType: 'EXACT_MATCH', values: ['BID'] },
            ruleSubCategory: { filterType: 'EXACT_MATCH', values: ['SCHEDULE'] },
          },
        });
        id = String(remoteRules(search).find((rule: any) => String(rule.ruleName || '') === ruleName)?.optimizationRuleId || '');
        if (search?.unsupported === true) apiSupported = false;
      }

      const nativeAvailable = nativeRulesEnabled && apiSupported;
      const localData: any = {
        amazon_account_id: aid,
        marketplace_id: account.marketplace_id || account.marketplace || null,
        profile_id: String(account.ads_profile_id || ''),
        optimization_rule_id: id || local?.optimization_rule_id || null,
        rule_name: ruleName,
        rule_category: 'BID',
        rule_subcategory: 'SCHEDULE',
        recurrence_type: 'WEEKLY',
        days_of_week: plan.days,
        start_time: plan.start_time,
        end_time: plan.end_time,
        duration_start: `${today}T00:00:00Z`,
        adjustment_operator: 'INCREMENT',
        adjustment_unit: 'PERCENT',
        adjustment_value: plan.adjustment,
        slot_classification: plan.classification,
        campaign_ids: campaignIds,
        asins: [...new Set(plan.campaigns.map((campaign: any) => campaign.asin).filter(Boolean))],
        targeting_types: [...new Set(plan.campaigns.map((campaign: any) => campaign.resolved_targeting_type))],
        native_api_supported: nativeAvailable,
        fallback_mode: nativeAvailable ? 'amazon_native_positive_app_negative' : 'app_managed_only',
        idempotency_key: idem,
        engine_version: ENGINE_VERSION,
        reason: `${plan.classification}, score ${plan.average_score}. ${nativeAvailable ? `Amazon incrementa ${plan.adjustment}%` : 'LivingFinds gerencia o ajuste'} para ${campaignIds.length} campanha(s).`,
        updated_at: now,
        next_review_at: nextReview(),
      };

      if (local?.id) await base44.asServiceRole.entities.AmazonScheduledRule.update(local.id, localData).catch(() => {});
      else local = await base44.asServiceRole.entities.AmazonScheduledRule.create({
        ...localData,
        status: dryRun ? 'planned' : nativeAvailable ? 'creating' : 'unsupported',
        association_status: 'pending',
        created_at: now,
      });

      if (!id && nativeAvailable && !dryRun) {
        const created = await rulesCommand(base44, aid, 'create_rules', {
          optimizationRules: [{
            action: {
              actionDetails: { actionOperator: 'INCREMENT', actionUnit: 'PERCENT', value: String(plan.adjustment) },
              actionType: 'ADOPT',
            },
            recurrence: {
              daysOfWeek: plan.days,
              duration: { startTime: `${today}T00:00:00Z` },
              timesOfDay: [{ startTime: plan.start_time, endTime: plan.end_time }],
              type: 'WEEKLY',
            },
            ruleCategory: 'BID',
            ruleName,
            ruleSubCategory: 'SCHEDULE',
            status: 'ENABLED',
          }],
        });
        id = ruleId(created);
        if (!created?.ok && created?.unsupported) apiSupported = false;
        await base44.asServiceRole.entities.AmazonScheduledRule.update(local.id, {
          optimization_rule_id: id || null,
          status: id ? 'enabled' : apiSupported ? 'failed' : 'unsupported',
          native_api_supported: nativeRulesEnabled && apiSupported,
          fallback_mode: nativeRulesEnabled && apiSupported ? 'amazon_native_positive_app_negative' : 'app_managed_only',
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
        results.push({ rule_name: ruleName, adjustment: plan.adjustment, campaigns: campaignIds, asins: localData.asins, native_enabled: nativeRulesEnabled, dry_run: true });
        continue;
      }
      if (!nativeRulesEnabled || !apiSupported || !id) {
        results.push({ rule_name: ruleName, campaigns: campaignIds, ok: true, fallback: 'app_managed_only' });
        continue;
      }

      if (String(local.status || '') === 'paused') {
        const reactivated = await rulesCommand(base44, aid, 'update_rules', {
          optimizationRules: [{ optimizationRuleId: id, status: 'ENABLED' }],
        });
        if (reactivated?.ok || reactivated?.conflict_existing) {
          rulesReactivated++;
          await base44.asServiceRole.entities.AmazonScheduledRule.update(local.id, {
            status: 'enabled',
            amazon_request_id: reactivated?.request_id || local.amazon_request_id || null,
            amazon_response_status: Number(reactivated?.status || 0) || null,
            amazon_response: JSON.stringify(reactivated?.payload || reactivated || {}).slice(0, 4000),
            updated_at: now,
          }).catch(() => {});
        } else {
          results.push({ rule_name: ruleName, rule_id: id, ok: false, error: 'Falha ao reativar regra Amazon' });
          continue;
        }
      }

      const alreadyAssociated = new Set<string>((local.associated_campaign_ids || []).map(String));
      const toAssociate = campaignIds.filter((cid) => !alreadyAssociated.has(cid));
      const newlyAssociated: string[] = [];
      const failed: string[] = [];
      for (const cid of toAssociate) {
        const response = await rulesCommand(base44, aid, 'associate_rules', { optimizationRuleIds: [id] }, cid);
        if (response?.ok || response?.conflict_existing) {
          newlyAssociated.push(cid);
          associations++;
        } else {
          failed.push(cid);
          associationFailures++;
        }
        await wait(350);
      }

      const associated = [...new Set([...alreadyAssociated, ...newlyAssociated])].filter((cid) => campaignIds.includes(cid));
      await base44.asServiceRole.entities.AmazonScheduledRule.update(local.id, {
        optimization_rule_id: id,
        status: 'enabled',
        association_status: failed.length === 0 ? 'associated' : associated.length > 0 ? 'partial' : 'failed',
        associated_campaign_ids: associated,
        failed_campaign_ids: failed,
        campaign_ids: campaignIds,
        native_api_supported: true,
        fallback_mode: 'amazon_native_positive_app_negative',
        last_associated_at: toAssociate.length > 0 ? now : local.last_associated_at || null,
        last_synced_at: now,
        updated_at: now,
        next_review_at: nextReview(),
      }).catch(() => {});

      results.push({
        rule_name: ruleName,
        rule_id: id,
        adjustment: plan.adjustment,
        campaigns: campaignIds,
        asins: localData.asins,
        already_associated: alreadyAssociated.size,
        newly_associated: newlyAssociated.length,
        failed: failed.length,
      });
    }

    // Mudança de janela, ASIN ou conjunto de campanhas gera nova chave. A regra
    // anterior é pausada na Amazon e mantida localmente para auditoria.
    if (!dryRun) {
      for (const stale of storedRules) {
        if (!stale.idempotency_key || desiredKeys.has(stale.idempotency_key)) continue;
        if (!['enabled', 'creating', 'planned'].includes(String(stale.status || ''))) continue;

        let paused = !stale.optimization_rule_id;
        let response: any = null;
        if (stale.optimization_rule_id && apiSupported) {
          response = await rulesCommand(base44, aid, 'update_rules', {
            optimizationRules: [{ optimizationRuleId: String(stale.optimization_rule_id), status: 'PAUSED' }],
          });
          paused = response?.ok === true || response?.conflict_existing === true;
        }

        if (paused) {
          await base44.asServiceRole.entities.AmazonScheduledRule.update(stale.id, {
            status: 'paused',
            association_status: 'pending',
            reason: `Regra pausada: janela, produto, campanhas ou configuração alterados no ciclo ${today}. Histórico preservado.`,
            amazon_request_id: response?.request_id || stale.amazon_request_id || null,
            amazon_response_status: Number(response?.status || 0) || stale.amazon_response_status || null,
            amazon_response: response ? JSON.stringify(response?.payload || response).slice(0, 4000) : stale.amazon_response || null,
            last_synced_at: now,
            updated_at: now,
          }).catch(() => {});
          rulesPaused++;
        }
      }
    }

    const nativeAvailable = nativeRulesEnabled && apiSupported;
    const logStatus = associationFailures > 0 && associations === 0 ? 'error' : nativeAvailable ? 'success' : 'partial';
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'sync_amazon_schedule_bid_rules',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      status: logStatus,
      execution_date: today,
      started_at: new Date(startedAt).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      records_processed: rulesCreated + rulesReactivated + rulesPaused + associations,
      result_summary: JSON.stringify({
        rule_plans: plans.size,
        campaigns: eligible.length,
        rules_created: rulesCreated,
        rules_reactivated: rulesReactivated,
        rules_paused: rulesPaused,
        associations,
        native_enabled: nativeRulesEnabled,
        api_supported: apiSupported,
        strict_envelope: strictEnvelope,
      }).slice(0, 1500),
      error_message: nativeAvailable ? null : nativeRulesEnabled ? 'Optimization Rules indisponível neste perfil/marketplace; fallback app_managed_only ativado.' : 'Regras nativas desabilitadas na configuração; fallback app_managed_only ativado.',
    }).catch(() => {});

    return Response.json({
      ok: associationFailures === 0 || associations > 0 || !nativeAvailable,
      engine_version: ENGINE_VERSION,
      strict_bid_envelope: strictEnvelope,
      amazon_base_strategy: desiredAmazonStrategy,
      local_bidding_strategy: desiredLocalStrategy,
      bid_control_mode: controlMode,
      native_rules_enabled: nativeRulesEnabled,
      native_api_supported: apiSupported,
      fallback_mode: nativeAvailable ? 'amazon_native_positive_app_negative' : 'app_managed_only',
      rule_limit: 'Schedule Bid Rules nativas somente incrementam bids.',
      sync_frequency_hours: syncFrequencyHours,
      rule_plans: plans.size,
      campaigns_eligible: eligible.length,
      rules_created: rulesCreated,
      rules_reactivated: rulesReactivated,
      rules_paused: rulesPaused,
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
