/**
 * Dayparting nativo canônico (v8):
 * classifica faixas horárias (PISO / EFICIENTE / PICO) a partir de
 * UnifiedAdsMetricsHourly (30 dias) e cria Scheduled Bid Rules nativas na
 * Amazon Ads API por campanha elegível. Idempotente; nunca pausa campanhas.
 */
export const NATIVE_ENGINE_VERSION = 'canonical-native-daypart-v1';

const DAY_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const r2 = (value: number) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const norm = (value: any) => String(value || '').trim().toLowerCase();
const active = (value: any) => ['enabled', 'active'].includes(norm(value));

// Regra Canônica: 0/null = meta ignorada
function goal(...values: any[]): number {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function brtDate(offsetDays = 0): string {
  return new Date(Date.now() - 3 * 3600000 - offsetDays * 86400000).toISOString().slice(0, 10);
}

function hourLabel(hour: number, minute: string): string {
  return `${String(hour).padStart(2, '0')}:${minute}`;
}

function parseRuleId(data: any): string {
  const payload = data?.payload || {};
  return String(
    payload?.optimizationRules?.success?.[0]?.optimizationRuleId ||
    payload?.optimizationRules?.[0]?.optimizationRuleId ||
    payload?.responses?.[0]?.optimizationRuleId ||
    payload?.success?.[0]?.optimizationRuleId ||
    payload?.optimizationRuleId || '',
  );
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
  }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
  return response?.data || response || {};
}

function rulePayload(ruleName: string, band: any, adjValue: number, today: string) {
  return {
    action: {
      actionDetails: { actionOperator: 'INCREMENT', actionUnit: 'PERCENT', value: String(adjValue) },
      actionType: 'ADOPT',
    },
    recurrence: {
      type: 'DAILY',
      duration: { startTime: `${today}T00:00:00Z` },
      timesOfDay: [{ startTime: band.start_time, endTime: band.end_time }],
    },
    ruleCategory: 'BID',
    ruleName,
    ruleSubCategory: 'SCHEDULE',
    status: 'ENABLED',
  };
}

/** Agrupa horas contíguas de mesma classificação em faixas. */
function buildBands(hourClass: string[], hourAgg: any[]) {
  const bands: any[] = [];
  let start: number | null = null;
  let current = '';
  const close = (end: number) => {
    if (start === null) return;
    const hours: number[] = [];
    for (let h = start; h < end; h++) hours.push(h);
    const cost = hours.reduce((sum, h) => sum + hourAgg[h].cost, 0);
    const sales = hours.reduce((sum, h) => sum + hourAgg[h].sales, 0);
    bands.push({
      classification: current,
      start_hour: start,
      end_hour: end - 1,
      start_time: hourLabel(start, '00'),
      end_time: hourLabel(end - 1, '59'),
      hours,
      cost: r2(cost),
      sales: r2(sales),
      roas: cost > 0 ? r2(sales / cost) : 0,
      acos: sales > 0 ? r2((cost / sales) * 100) : null,
    });
  };
  for (let hour = 0; hour <= 24; hour++) {
    const next = hour < 24 ? hourClass[hour] : '';
    if (next !== current) {
      close(hour);
      start = next ? hour : null;
      current = next;
    }
  }
  return bands;
}

export async function runCanonicalNativeDaypartSync(base44: any, account: any, options: any = {}) {
  const startedAt = Date.now();
  const aid = String(account.id);
  const now = new Date().toISOString();
  const today = brtDate(0);
  const maxCampaigns = Math.max(1, Math.min(10, Number(options.max_campaigns || 10)));

  const summary: any = {
    ok: true,
    engine_version: NATIVE_ENGINE_VERSION,
    campaigns_evaluated: 0,
    campaigns_eligible: 0,
    campaigns_processed: 0,
    rules_created: 0,
    rules_updated: 0,
    rules_archived: 0,
    rules_idempotent: 0,
    failures: 0,
    legacy_mode: [] as any[],
    details: [] as any[],
  };

  const [configs, performance, campaigns, adGroups, storedRules] = await Promise.all([
    base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }, null, 1).catch(() => []),
    base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, null, 1).catch(() => []),
    base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, '-spend', 1000).catch(() => []),
    base44.asServiceRole.entities.AdGroup.filter({ amazon_account_id: aid }, null, 3000).catch(() => []),
    base44.asServiceRole.entities.AmazonScheduledRule.filter({ amazon_account_id: aid }, '-updated_at', 3000).catch(() => []),
  ]);
  const cfg = configs[0] || {};
  const perf = performance[0] || {};

  if (cfg.dayparting_enabled === false) {
    summary.skipped = 'dayparting_disabled';
    return summary;
  }
  if (cfg.amazon_native_schedule_rules_enabled === false) {
    summary.skipped = 'native_rules_disabled_app_managed_only';
    return summary;
  }

  const targetAcos = goal(perf.target_acos, cfg.target_acos) || 15;
  const maxAcos = goal(perf.max_acos, cfg.maximum_acos) || targetAcos * 1.5;
  const targetRoas = goal(perf.target_roas, cfg.target_roas) || 4;
  const maxBid = goal(perf.max_bid, cfg.max_bid) || 5;
  const absMinBid = Math.max(0.02, goal(cfg.daypart_absolute_min_bid) || 0.02);
  const strictEnvelope = cfg.strict_bid_envelope !== false;
  const minClicksPerBand = goal(cfg.min_clicks_per_time_block) || 20;

  // 60 dias para medir a extensão do histórico; 30 dias para classificar
  const hourly = await base44.asServiceRole.entities.UnifiedAdsMetricsHourly.filter(
    { amazon_account_id: aid, date: { $gte: brtDate(60) } }, '-date', 10000,
  ).catch(() => []);
  const rowsByCampaign = new Map<string, any[]>();
  for (const row of hourly) {
    const cid = String(row.campaign_id || '');
    if (!cid) continue;
    if (!rowsByCampaign.has(cid)) rowsByCampaign.set(cid, []);
    rowsByCampaign.get(cid)!.push(row);
  }

  const canonicalRules = storedRules.filter((rule: any) => String(rule.engine_version || '').startsWith('canonical-native'));
  const classifyCutoff = brtDate(30);

  const enabledSp = campaigns.filter((campaign: any) => {
    const cid = String(campaign.amazon_campaign_id || campaign.campaign_id || '');
    return cid && active(campaign.state || campaign.status) && campaign.archived !== true &&
      String(campaign.campaign_type || 'SP').toUpperCase() === 'SP';
  });

  for (const campaign of enabledSp) {
    if (summary.campaigns_processed >= maxCampaigns) break;
    const cid = String(campaign.amazon_campaign_id || campaign.campaign_id || '');
    summary.campaigns_evaluated++;

    // Rotação: campanhas sincronizadas há menos de 20h não repetem no ciclo
    const campaignRules = canonicalRules.filter((rule: any) => (rule.campaign_ids || []).map(String).includes(cid));
    const lastSynced = campaignRules.reduce((max: number, rule: any) => Math.max(max, new Date(rule.last_synced_at || 0).getTime()), 0);
    if (lastSynced > Date.now() - 20 * 3600000) continue;

    // Elegibilidade (a): ≥ 30 dias de dados em UnifiedAdsMetricsHourly
    const rows = rowsByCampaign.get(cid) || [];
    const distinctDates = new Set(rows.map((row: any) => String(row.date || '')));
    if (distinctDates.size < 30) {
      summary.legacy_mode.push({ campaign_id: cid, reason: 'insufficient_history', days: distinctDates.size });
      continue;
    }
    summary.campaigns_eligible++;

    // Agregação por hora — últimos 30 dias
    const hourAgg = Array.from({ length: 24 }, () => ({ clicks: 0, cost: 0, sales: 0 }));
    for (const row of rows) {
      if (String(row.date || '') < classifyCutoff) continue;
      const hour = Number(row.hour);
      if (hour < 0 || hour > 23) continue;
      hourAgg[hour].clicks += Number(row.clicks || 0);
      hourAgg[hour].cost += Number(row.cost || 0);
      hourAgg[hour].sales += Number(row.sales || 0);
    }

    // Classificação por hora — elegibilidade (b): ≥ 20 cliques por faixa avaliada
    const hourClass: string[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const agg = hourAgg[hour];
      if (agg.clicks < minClicksPerBand) { hourClass.push('EFICIENTE'); continue; }
      const acos = agg.sales > 0 ? (agg.cost / agg.sales) * 100 : (agg.cost > 0 ? Infinity : null);
      const roas = agg.cost > 0 ? agg.sales / agg.cost : null;
      if ((acos !== null && acos > maxAcos * 1.5) || (roas !== null && roas < targetRoas * 0.4)) hourClass.push('PISO');
      else if ((roas !== null && roas > targetRoas * 1.5) || (acos !== null && acos < targetAcos * 0.6)) hourClass.push('PICO');
      else hourClass.push('EFICIENTE');
    }

    // Bid-base: bid atual do ad group principal
    const principal = adGroups.find((group: any) => String(group.campaign_id || '') === cid && active(group.state || group.status));
    const baseBid = r2(Number(principal?.daypart_base_bid || principal?.default_bid || 0));
    if (baseBid <= 0) {
      summary.legacy_mode.push({ campaign_id: cid, reason: 'no_base_bid' });
      continue;
    }

    const bands = buildBands(hourClass, hourAgg);
    const actionable = bands.filter((band: any) => band.classification !== 'EFICIENTE');
    const desiredKeys = new Set<string>();
    const campaignFailures: string[] = [];
    let campaignRuleOk = false;

    for (const band of actionable) {
      // Multiplicadores canônicos
      let adjValue = 0;
      if (band.classification === 'PISO') {
        const bid = Math.max(absMinBid, r2(baseBid * 0.25));
        adjValue = Math.round(((bid / baseBid) - 1) * 100);
        if (adjValue >= 0) continue; // bid-base já está no piso técnico
      } else {
        const roasIndex = targetRoas > 0 ? band.roas / targetRoas : 0;
        let multiplier = roasIndex > 2 ? 2 : 1.5;
        if (strictEnvelope) multiplier = Math.min(multiplier, 1.5);
        multiplier = Math.max(1, Math.min(multiplier, maxBid / baseBid));
        adjValue = Math.round((multiplier - 1) * 100);
        if (adjValue <= 0) continue; // max_bid já limita o bid-base
      }

      const idem = `CANONV8|${aid}|${cid}|${band.start_time}|${band.end_time}`;
      desiredKeys.add(idem);
      const ruleName = `LFC_${band.classification}_${band.start_time.replace(':', '')}_${band.end_time.replace(':', '')}_${cid}`.slice(0, 120);

      // Gate da IA: regra determinística persistida apenas se a IA não possui uma ativa
      const existingDayparting = await base44.asServiceRole.entities.DaypartingRule.filter(
        { amazon_account_id: aid, campaign_id: cid, status: 'active', start_hour: band.start_hour }, null, 5,
      ).catch(() => []);
      if (existingDayparting.length === 0) {
        await base44.asServiceRole.entities.DaypartingRule.create({
          amazon_account_id: aid,
          campaign_id: cid,
          campaign_name: campaign.name || campaign.campaign_name || null,
          asin: campaign.asin || null,
          rule_type: 'bid_schedule',
          days_of_week: [0, 1, 2, 3, 4, 5, 6],
          start_hour: band.start_hour,
          end_hour: band.end_hour,
          adjustment_type: 'percentage',
          adjustment_value: adjValue,
          bid_base_before: baseBid,
          bid_floor: absMinBid,
          classification: band.classification === 'PISO' ? 'deficit' : 'peak_high_profit',
          avg_roas: band.roas,
          avg_acos: band.acos || 0,
          sample_clicks: band.hours.reduce((sum: number, h: number) => sum + hourAgg[h].clicks, 0),
          rationale: `Faixa ${band.start_time}-${band.end_time} classificada como ${band.classification} (ROAS ${band.roas}, ACoS ${band.acos ?? 'sem vendas'}) nos últimos 30 dias.`,
          created_by: 'autopilot',
          status: 'active',
          created_at: now,
          updated_at: now,
        }).catch(() => {});
      }

      // Idempotência vs regra existente
      let local = canonicalRules.find((rule: any) => rule.idempotency_key === idem) || null;
      const localEnabled = local && String(local.status || '') === 'enabled' && local.optimization_rule_id;

      if (localEnabled && Math.abs(Number(local.adjustment_value || 0) - adjValue) <= 5) {
        summary.rules_idempotent++;
        campaignRuleOk = true;
        await base44.asServiceRole.entities.AmazonScheduledRule.update(local.id, { last_synced_at: now, updated_at: now }).catch(() => {});
        continue;
      }

      const localData: any = {
        amazon_account_id: aid,
        marketplace_id: account.marketplace_id || null,
        profile_id: String(account.ads_profile_id || ''),
        rule_name: ruleName,
        rule_category: 'BID',
        rule_subcategory: 'SCHEDULE',
        recurrence_type: 'DAILY',
        days_of_week: DAY_NAMES,
        start_time: band.start_time,
        end_time: band.end_time,
        duration_start: `${today}T00:00:00Z`,
        adjustment_operator: 'INCREMENT',
        adjustment_unit: 'PERCENT',
        adjustment_value: adjValue,
        slot_classification: band.classification,
        campaign_ids: [cid],
        asins: campaign.asin ? [String(campaign.asin)] : [],
        targeting_types: [String(campaign.targeting_type || 'AUTO')],
        idempotency_key: idem,
        engine_version: NATIVE_ENGINE_VERSION,
        reason: `${band.classification} ${band.start_time}-${band.end_time}: ROAS ${band.roas}, ACoS ${band.acos ?? 'sem vendas'}; ajuste ${adjValue}% sobre bid-base R$${baseBid.toFixed(2)}.`,
        updated_at: now,
      };

      if (localEnabled) {
        // Diverge > 5%: atualizar via API (PUT)
        const updated = await rulesCommand(base44, aid, 'update_rules', {
          optimizationRules: [{ optimizationRuleId: String(local.optimization_rule_id), ...rulePayload(ruleName, band, adjValue, today) }],
        });
        const ok = updated?.ok === true || updated?.conflict_existing === true;
        await base44.asServiceRole.entities.AmazonScheduledRule.update(local.id, {
          ...localData,
          status: ok ? 'enabled' : 'failed',
          fallback_mode: ok ? 'amazon_native_positive_app_negative' : 'app_managed_only',
          native_api_supported: ok,
          amazon_request_id: updated?.request_id || local.amazon_request_id || null,
          amazon_response_status: Number(updated?.status || 0) || null,
          amazon_response: JSON.stringify(updated?.payload || updated || {}).slice(0, 4000),
          last_error: ok ? null : String(updated?.error || 'Falha ao atualizar regra').slice(0, 500),
          last_synced_at: now,
        }).catch(() => {});
        if (ok) { summary.rules_updated++; campaignRuleOk = true; }
        else { summary.failures++; campaignFailures.push(`update ${ruleName}`); }
        await wait(350);
        continue;
      }

      // Criar nova regra + associar à campanha
      if (local?.id) await base44.asServiceRole.entities.AmazonScheduledRule.update(local.id, { ...localData, status: 'creating' }).catch(() => {});
      else local = await base44.asServiceRole.entities.AmazonScheduledRule.create({ ...localData, status: 'creating', association_status: 'pending', created_at: now }).catch(() => null);

      const created = await rulesCommand(base44, aid, 'create_rules', { optimizationRules: [rulePayload(ruleName, band, adjValue, today)] });
      const ruleIdValue = parseRuleId(created);
      let ok = Boolean(ruleIdValue);
      let associated = false;
      if (ok) {
        const association = await rulesCommand(base44, aid, 'associate_rules', { optimizationRuleIds: [ruleIdValue] }, cid);
        associated = association?.ok === true || association?.conflict_existing === true;
        ok = associated;
        await wait(350);
      }

      if (local?.id) await base44.asServiceRole.entities.AmazonScheduledRule.update(local.id, {
        optimization_rule_id: ruleIdValue || null,
        status: ok ? 'enabled' : 'failed',
        association_status: associated ? 'associated' : 'failed',
        associated_campaign_ids: associated ? [cid] : [],
        native_api_supported: ok,
        fallback_mode: ok ? 'amazon_native_positive_app_negative' : 'app_managed_only',
        amazon_request_id: created?.request_id || null,
        amazon_response_status: Number(created?.status || 0) || null,
        amazon_response: JSON.stringify(created?.payload || created || {}).slice(0, 4000),
        last_error: ok ? null : String(created?.error || 'Regra não confirmada pela Amazon').slice(0, 500),
        last_associated_at: associated ? now : null,
        last_synced_at: now,
        updated_at: now,
      }).catch(() => {});

      if (ok) { summary.rules_created++; campaignRuleOk = true; }
      else { summary.failures++; campaignFailures.push(`create ${ruleName}`); }
      await wait(350);
    }

    // Faixas que mudaram: arquivar regras que não estão mais no plano
    for (const stale of campaignRules) {
      if (!stale.idempotency_key || desiredKeys.has(stale.idempotency_key)) continue;
      if (String(stale.status || '') !== 'enabled') continue;
      let paused = !stale.optimization_rule_id;
      if (stale.optimization_rule_id) {
        const response = await rulesCommand(base44, aid, 'update_rules', {
          optimizationRules: [{ optimizationRuleId: String(stale.optimization_rule_id), status: 'PAUSED' }],
        });
        paused = response?.ok === true || response?.conflict_existing === true;
      }
      if (!paused) continue;
      await base44.asServiceRole.entities.AmazonScheduledRule.update(stale.id, {
        status: 'archived',
        reason: `Classificação da faixa mudou no ciclo ${today}; regra arquivada antes da nova.`,
        last_synced_at: now,
        updated_at: now,
      }).catch(() => {});
      summary.rules_archived++;
      await wait(250);
    }

    // Sucesso: marcar keywords da campanha como daypart_active
    if (campaignRuleOk) {
      const campaignKeywords = await base44.asServiceRole.entities.Keyword.filter(
        { amazon_account_id: aid, campaign_id: cid }, null, 200,
      ).catch(() => []);
      for (const keyword of campaignKeywords) {
        if (keyword.daypart_active === true) continue;
        await base44.asServiceRole.entities.Keyword.update(keyword.id, { daypart_active: true, daypart_last_adjusted_at: now }).catch(() => {});
      }
    }

    // Falha: fallback app_managed_only já gravado por regra; alertar
    if (campaignFailures.length > 0) {
      await base44.asServiceRole.entities.Alert.create({
        amazon_account_id: aid,
        alert_type: 'sync_error',
        alert_family: 'sync',
        severity: 'medium',
        entity_type: 'campaign',
        campaign_id: cid,
        title: 'Falha ao criar Scheduled Bid Rule nativa',
        message: `Campanha ${cid}: ${campaignFailures.join('; ')}. Motor seguirá com ajuste local de bid (app_managed_only).`,
        deduplication_key: `canonical_native_daypart_fail|${cid}|${today}`,
        source_function: 'runCanonicalDaypartingEngine',
        created_at: now,
      }).catch(() => {});
    }

    summary.campaigns_processed++;
    summary.details.push({
      campaign_id: cid,
      base_bid: baseBid,
      bands: bands.map((band: any) => ({ start: band.start_time, end: band.end_time, classification: band.classification, roas: band.roas, acos: band.acos })),
      failures: campaignFailures.length,
    });
  }

  await base44.asServiceRole.entities.SyncExecutionLog.create({
    amazon_account_id: aid,
    operation: 'canonical_dayparting_sync',
    trigger_type: options.trigger_type || 'automatic',
    status: summary.failures > 0 && summary.rules_created + summary.rules_updated === 0 ? 'error' : summary.failures > 0 ? 'partial' : 'success',
    execution_date: today,
    started_at: new Date(startedAt).toISOString(),
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    records_processed: summary.rules_created + summary.rules_updated + summary.rules_archived,
    result_summary: JSON.stringify({
      evaluated: summary.campaigns_evaluated,
      eligible: summary.campaigns_eligible,
      processed: summary.campaigns_processed,
      created: summary.rules_created,
      updated: summary.rules_updated,
      archived: summary.rules_archived,
      idempotent: summary.rules_idempotent,
      failures: summary.failures,
      legacy: summary.legacy_mode.length,
    }).slice(0, 1500),
    error_message: summary.failures > 0 ? `${summary.failures} regra(s) sem confirmação da Amazon; fallback app_managed_only.` : null,
  }).catch(() => {});

  summary.ok = summary.failures === 0 || summary.rules_created + summary.rules_updated > 0;
  summary.duration_ms = Date.now() - startedAt;
  return summary;
}