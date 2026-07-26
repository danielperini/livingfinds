import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

/**
 * Motor canônico de dayparting híbrido.
 *
 * - Amazon Schedule Bid Rules: aumentos nativos em STRONG/ELITE.
 * - LivingFinds: reduções e restaurações, porque a API nativa de schedule rules
 *   não oferece decremento.
 * - Faixa absoluta: 0,50x a 1,50x do bid-base.
 * - Nunca calcula o próximo bid sobre um bid temporariamente alterado.
 */
const ENGINE_VERSION = 'canonical-dayparting-v1';
const MIN_REDUCTION_IMPRESSIONS = 200;
const MIN_REDUCTION_CLICKS = 10;
const MIN_REDUCTION_SPEND = 12;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const r2 = (value: number) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const norm = (value: any) => String(value || '').trim().toLowerCase();
const isActive = (value: any) => ['enabled', 'active'].includes(norm(value));

function brtNow() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', hour12: false,
  }).formatToParts(now);
  const value = (type: string) => parts.find((p) => p.type === type)?.value || '';
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    iso: now.toISOString(),
    date: `${value('year')}-${value('month')}-${value('day')}`,
    hour: Number(value('hour') || 0) % 24,
    dow: weekdayMap[value('weekday')] ?? new Date(Date.now() - 3 * 3600000).getUTCDay(),
  };
}

function quantity(product: any): number {
  return Number(product?.fba_inventory ?? product?.available_quantity ?? product?.fulfillable_quantity ?? product?.stock ?? 0);
}

function targetingType(campaign: any): 'AUTO' | 'MANUAL' {
  const explicit = String(campaign?.targeting_type || campaign?.targetingType || '').toUpperCase();
  if (explicit === 'AUTO' || explicit === 'MANUAL') return explicit;
  return /manual/i.test(String(campaign?.name || campaign?.campaign_name || '')) ? 'MANUAL' : 'AUTO';
}

function campaignId(campaign: any): string {
  return String(campaign?.amazon_campaign_id || campaign?.campaign_id || '');
}

function classifyPattern(value: any): 'ELITE_TIME' | 'STRONG_TIME' | 'NORMAL_TIME' | 'WEAK_TIME' | 'LOSS_TIME' | 'COLLECTING_DATA' {
  const cls = String(value || '').toUpperCase();
  if (cls === 'PEAK_ELITE' || cls === 'ELITE_TIME') return 'ELITE_TIME';
  if (cls === 'PEAK_STRONG' || cls === 'STRONG_TIME') return 'STRONG_TIME';
  if (cls === 'NORMAL' || cls === 'NORMAL_TIME') return 'NORMAL_TIME';
  if (cls === 'WEAK' || cls === 'WEAK_TIME') return 'WEAK_TIME';
  if (cls === 'LOSS' || cls === 'LOSS_TIME') return 'LOSS_TIME';
  return 'COLLECTING_DATA';
}

function parseJson(value: any): any {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch { return {}; }
}

function safeAcos(spend: number, sales: number, stored: any): number | null {
  if (sales > 0) return (spend / sales) * 100;
  const value = Number(stored || 0);
  return value > 0 ? value : null;
}

function getSlot(params: { decisions: any[]; patterns: any[]; controller: any; dow: number; hour: number }) {
  const currentDecision = params.decisions
    .filter((row) => Number(row.day_of_week) === params.dow && Number(row.hour) === params.hour)
    .sort((a, b) => new Date(b.created_at || b.updated_at || 0).getTime() - new Date(a.created_at || a.updated_at || 0).getTime())[0];
  if (currentDecision) {
    return {
      classification: classifyPattern(currentDecision.slot_classification),
      score: Number(currentDecision.time_slot_score || 0),
      mature: currentDecision.data_mature === true || ['HIGH', 'VERY_HIGH'].includes(String(currentDecision.data_confidence || '')),
      source: 'DaypartingDecision',
    };
  }

  const pattern = params.patterns.find((row) => Number(row.day_of_week) === params.dow && Number(row.hour) === params.hour);
  if (pattern) {
    return {
      classification: classifyPattern(pattern.classification),
      score: Number(pattern.peak_score || 0),
      mature: Number(pattern.occurrences || 0) >= 3 && String(pattern.classification || '') !== 'INSUFFICIENT_DATA',
      source: 'HourlySalesPattern',
    };
  }

  const scores = parseJson(params.controller?.hour_value_scores);
  const score = Number(scores?.[params.hour] || 0);
  return {
    classification: score >= 90 ? 'ELITE_TIME' : score >= 75 ? 'STRONG_TIME' : score >= 55 ? 'NORMAL_TIME' : score >= 35 ? 'WEAK_TIME' : score > 0 ? 'LOSS_TIME' : 'COLLECTING_DATA',
    score,
    mature: score > 0,
    source: score > 0 ? 'AccountDailySpendController' : 'no_hourly_data',
  };
}

function amazonMultiSuccess(response: any, key: string): boolean {
  const data = response?.data || response || {};
  if (data?.ok === false) return false;
  const status = Number(data?.status || 0);
  const payload = data?.payload || {};
  if (status === 207) {
    const success = payload?.[key]?.success || payload?.success || [];
    const errors = payload?.[key]?.error || payload?.errors || [];
    if (Array.isArray(success)) return success.length > 0;
    return !Array.isArray(errors) || errors.length === 0;
  }
  return data?.ok === true;
}

function chooseMultiplier(params: {
  slot: ReturnType<typeof getSlot>;
  nativePositive: boolean;
  pacing: string;
  winner: boolean;
  sampleMature: boolean;
  orders: number;
  acos: number | null;
  targetAcos: number;
  breakEvenAcos: number | null;
  profitProtection: boolean;
}) {
  const { slot, nativePositive, pacing, winner, sampleMature, orders, acos, targetAcos, breakEvenAcos, profitProtection } = params;
  if (!slot.mature || slot.classification === 'COLLECTING_DATA') return { multiplier: 1, reason: 'Dados horários ainda insuficientes.' };

  const profitable = orders > 0 && acos !== null && acos <= targetAcos;
  const exceptional = orders >= 2 && acos !== null && acos <= targetAcos * 0.80;
  const unsafeProfit = profitProtection || (breakEvenAcos !== null && acos !== null && acos >= breakEvenAcos * 0.95);

  if (slot.classification === 'ELITE_TIME') {
    if (nativePositive) return { multiplier: 1, reason: 'Amazon Schedule Bid Rule nativa aplica +50%; bid local restaurado ao base.' };
    if (pacing === 'overpacing' || unsafeProfit) return { multiplier: 1, reason: 'Aumento bloqueado por pacing/lucro.' };
    if (exceptional) return { multiplier: 1.50, reason: 'ELITE com alta conversão e ACoS abaixo de 80% da meta.' };
    if (profitable) return { multiplier: 1.25, reason: 'ELITE rentável; aumento intermediário de 25%.' };
    return { multiplier: 1, reason: 'ELITE sem evidência econômica suficiente para aumento.' };
  }

  if (slot.classification === 'STRONG_TIME') {
    if (nativePositive) return { multiplier: 1, reason: 'Amazon Schedule Bid Rule nativa aplica +25%; bid local restaurado ao base.' };
    if (pacing === 'overpacing' || unsafeProfit) return { multiplier: 1, reason: 'Aumento bloqueado por pacing/lucro.' };
    if (profitable) return { multiplier: exceptional ? 1.25 : 1.15, reason: exceptional ? 'STRONG excepcional: +25%.' : 'STRONG rentável: +15%.' };
    return { multiplier: 1, reason: 'STRONG sem vendas rentáveis suficientes.' };
  }

  if (slot.classification === 'NORMAL_TIME') return { multiplier: 1, reason: 'Slot normal: restaurar/manter bid-base.' };

  if (winner) return { multiplier: 1, reason: 'Campanha/target vencedor protegido contra redução horária.' };
  if (!sampleMature) return { multiplier: 1, reason: 'Redução bloqueada por amostra insuficiente.' };

  if (slot.classification === 'WEAK_TIME') {
    if (orders === 0 || (acos !== null && acos > targetAcos * 1.20) || pacing === 'overpacing') {
      return { multiplier: 0.75, reason: 'WEAK com desperdício/overpacing: redução intermediária de 25%.' };
    }
    return { multiplier: 1, reason: 'WEAK com conversão protegida; manter base.' };
  }

  if (slot.classification === 'LOSS_TIME') {
    if (orders === 0 && (acos === null || acos > targetAcos * 1.20)) {
      return { multiplier: 0.50, reason: 'LOSS sem conversão rentável: piso de 50% do bid-base.' };
    }
    if (acos !== null && acos > targetAcos) return { multiplier: 0.75, reason: 'LOSS acima da meta: redução intermediária de 25%.' };
    return { multiplier: 1, reason: 'LOSS, mas entidade com conversão/ACoS protegido.' };
  }

  return { multiplier: 1, reason: 'Sem ajuste horário aplicável.' };
}

async function logBid(base44: any, data: any) {
  await base44.asServiceRole.entities.AdsBidChangeLog.create({
    amazon_account_id: data.amazon_account_id,
    campaign_id: data.campaign_id,
    keyword_id: data.keyword_id || null,
    keyword_text: data.keyword_text || null,
    bid_before: data.bid_before,
    bid_after: data.bid_after,
    old_bid: data.bid_before,
    new_bid: data.bid_after,
    change_pct: data.base_bid > 0 ? r2(((data.bid_after - data.base_bid) / data.base_bid) * 100) : 0,
    action: data.bid_after > data.bid_before ? 'bid_increase' : data.bid_after < data.bid_before ? 'bid_decrease' : 'bid_restore',
    reason: data.reason,
    classification: data.classification,
    source: 'runCanonicalDaypartingEngine',
    created_at: new Date().toISOString(),
  }).catch(() => {});
}

Deno.serve(async (request) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accountRows = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 1);
    const account = accountRows[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon Ads conectada' }, { status: 404 });

    const aid = account.id;
    const clock = brtNow();
    const dryRun = body.dry_run === true;

    const [configs, performance, controllers, campaigns, products, economics, adGroups, keywords, productTargets, patterns, decisions, nativeRules] = await Promise.all([
      base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }, null, 1).catch(() => []),
      base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, null, 1).catch(() => []),
      base44.asServiceRole.entities.AccountDailySpendController.filter({ amazon_account_id: aid, spend_date: clock.date }, null, 1).catch(() => []),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 500).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 500).catch(() => []),
      base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: aid }, null, 500).catch(() => []),
      base44.asServiceRole.entities.AdGroup.filter({ amazon_account_id: aid }, null, 1000).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, '-spend', 3000).catch(() => []),
      base44.asServiceRole.entities.ProductTarget.filter({ amazon_account_id: aid }, '-spend', 3000).catch(() => []),
      base44.asServiceRole.entities.HourlySalesPattern.filter({ amazon_account_id: aid }, null, 500).catch(() => []),
      base44.asServiceRole.entities.DaypartingDecision.filter({ amazon_account_id: aid }, '-created_at', 1500).catch(() => []),
      base44.asServiceRole.entities.AmazonScheduledRule.filter({ amazon_account_id: aid, status: 'enabled' }, '-updated_at', 500).catch(() => []),
    ]);

    const cfg = configs[0] || {};
    const perf = performance[0] || {};
    const controller = controllers[0] || {};
    if (cfg.enabled === false || cfg.dayparting_enabled === false) {
      return Response.json({ ok: true, skipped: true, reason: 'Autopilot/dayparting desabilitado' });
    }
    if (controller.global_kill_switch === true) {
      return Response.json({ ok: true, skipped: true, reason: 'Kill Switch global ativo' });
    }

    // Atualiza regras nativas no máximo uma vez por dia, sem bloquear o ciclo se falhar.
    const nativeSyncLogs = await base44.asServiceRole.entities.SyncExecutionLog.filter({
      amazon_account_id: aid,
      operation: 'sync_amazon_schedule_bid_rules',
      execution_date: clock.date,
      status: 'success',
    }, '-started_at', 1).catch(() => []);
    let nativeSync: any = null;
    if (nativeSyncLogs.length === 0 || body.force_native_sync === true) {
      const response = await base44.asServiceRole.functions.invoke('syncAmazonScheduleBidRules', {
        amazon_account_id: aid,
        dry_run: dryRun,
        _service_role: true,
      }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
      nativeSync = response?.data || response || {};
    }

    const minBid = Number(perf.min_bid || cfg.min_bid || 0.25);
    const maxBid = Number(perf.max_bid || cfg.max_bid || 5);
    const targetAcos = Number(perf.target_acos || cfg.target_acos || 15);
    const dailyCap = Number(controller.effective_daily_spend_cap || controller.user_daily_spend_cap || cfg.total_daily_budget || cfg.daily_budget_limit || account.max_daily_budget_limit || 0);
    const confirmedSpend = campaigns.reduce((sum, campaign) => sum + Number(campaign.current_spend ?? 0), 0);
    const pacing = String(controller.spend_pacing || (dailyCap > 0 && confirmedSpend > dailyCap * ((clock.hour + 1) / 24) * 1.20 ? 'overpacing' : 'on_track'));

    const productByAsin = new Map(products.map((row: any) => [String(row.asin || ''), row]));
    const econByAsin = new Map(economics.map((row: any) => [String(row.asin || ''), row]));
    const campaignById = new Map<string, any>();
    for (const campaign of campaigns) {
      if (campaign.campaign_id) campaignById.set(String(campaign.campaign_id), campaign);
      if (campaign.amazon_campaign_id) campaignById.set(String(campaign.amazon_campaign_id), campaign);
    }

    const nativeManagedCampaigns = new Set<string>();
    for (const rule of nativeRules) {
      if (rule.native_api_supported !== true || rule.fallback_mode !== 'amazon_native_positive_app_negative') continue;
      for (const cid of (rule.associated_campaign_ids || rule.campaign_ids || [])) nativeManagedCampaigns.add(String(cid));
    }

    const slot = getSlot({ decisions, patterns, controller, dow: clock.dow, hour: clock.hour });
    const results: any[] = [];
    let executed = 0;
    let restored = 0;
    let skipped = 0;
    let failed = 0;

    const campaignRows = campaigns.filter((campaign: any) => {
      const product = productByAsin.get(String(campaign.asin || ''));
      return isActive(campaign.state || campaign.status) && campaign.archived !== true && quantity(product) > 0 && String(campaign.campaign_type || 'SP').toUpperCase() === 'SP';
    });

    for (const campaign of campaignRows) {
      const cid = campaignId(campaign);
      if (!cid) continue;
      const type = targetingType(campaign);
      const asin = String(campaign.asin || '');
      const econ = econByAsin.get(asin) || {};
      const safeMaxCpc = Number(econ.safe_max_cpc || econ.maximum_safe_cpc || perf.max_cpc || 0);
      const breakEvenAcos = Number(econ.break_even_acos || campaign.break_even_acos || 0) || null;
      const spend = Number(campaign.current_spend ?? campaign.spend ?? 0);
      const sales = Number(campaign.sales || 0);
      const orders = Number(campaign.orders || 0);
      const impressions = Number(campaign.impressions || 0);
      const clicks = Number(campaign.clicks || 0);
      const acos = safeAcos(spend, sales, campaign.acos);
      const winner = orders > 0 && acos !== null && acos <= targetAcos;
      const profitProtection = String(econ.profit_protection_mode || '').toLowerCase() === 'paused' || Number(econ.profit_after_ads_3d || 0) < 0;
      const sampleMature = impressions >= MIN_REDUCTION_IMPRESSIONS && clicks >= MIN_REDUCTION_CLICKS && spend >= MIN_REDUCTION_SPEND;
      const nativePositive = nativeManagedCampaigns.has(cid);

      const groups = adGroups.filter((group: any) => String(group.campaign_id || '') === cid && isActive(group.state || group.status));
      if (groups.length === 0) { skipped++; continue; }

      for (const group of groups) {
        const gid = String(group.ad_group_id || '');
        if (!gid) continue;
        const groupKeywords = keywords.filter((kw: any) => String(kw.ad_group_id || '') === gid && isActive(kw.state || kw.status));
        const groupTargets = productTargets.filter((target: any) => String(target.ad_group_id || '') === gid && isActive(target.state || target.status) && target.is_negative !== true);

        const entities: any[] = [];
        if (type === 'AUTO') {
          entities.push({ entity_type: 'ad_group', entity_id: gid, row: group, current_bid: Number(group.default_bid || 0), keyword: null, target: null });
        } else {
          const exactKeywords = groupKeywords.filter((kw: any) => norm(kw.match_type || kw.matchType) === 'exact');
          if (exactKeywords.length === 1 && groupKeywords.length === 1) {
            const kw = exactKeywords[0];
            entities.push({ entity_type: 'keyword', entity_id: String(kw.keyword_id || kw.id || ''), row: kw, current_bid: Number(kw.current_bid || kw.bid || group.default_bid || 0), keyword: kw, target: null });
          } else if (groupTargets.length > 0 && groupKeywords.length === 0) {
            for (const target of groupTargets.slice(0, 25)) {
              entities.push({ entity_type: 'product_target', entity_id: String(target.target_id || target.id || ''), row: target, current_bid: Number(target.bid || group.default_bid || 0), keyword: null, target });
            }
          } else {
            skipped++;
            results.push({ campaign_id: cid, ad_group_id: gid, skipped: true, reason: `manual_group_noncanonical: keywords=${groupKeywords.length}, exact=${exactKeywords.length}, targets=${groupTargets.length}` });
            continue;
          }
        }

        for (const entity of entities) {
          const currentBid = Number(entity.current_bid || minBid);
          const storedBase = Number(entity.row.daypart_base_bid || group.daypart_base_bid || 0);
          const wasActive = entity.row.daypart_active === true || group.daypart_active === true;
          const baseBid = r2(storedBase > 0 ? storedBase : currentBid);
          const floor = r2(Math.max(minBid, baseBid * 0.50));
          const capCandidates = [maxBid, baseBid * 1.50];
          if (safeMaxCpc > 0) capCandidates.push(safeMaxCpc);
          const cap = r2(Math.max(floor, Math.min(...capCandidates)));

          const choice = chooseMultiplier({
            slot,
            nativePositive,
            pacing,
            winner,
            sampleMature,
            orders,
            acos,
            targetAcos,
            breakEvenAcos,
            profitProtection,
          });
          const targetBid = r2(Math.max(floor, Math.min(cap, baseBid * choice.multiplier)));
          const changed = Math.abs(targetBid - currentBid) >= 0.01;
          const isRestore = wasActive && choice.multiplier === 1;
          const idem = `${aid}|canonical_daypart|${entity.entity_type}|${entity.entity_id}|${clock.date}|${clock.hour}|${targetBid}`;

          const existingAudit = await base44.asServiceRole.entities.DaypartingDecision.filter({ amazon_account_id: aid, idempotency_key: idem }, null, 1).catch(() => []);
          if (existingAudit.length > 0) { skipped++; continue; }

          const auditBase = {
            amazon_account_id: aid,
            entity_type: entity.entity_type,
            entity_id: entity.entity_id,
            campaign_id: cid,
            ad_group_id: gid,
            keyword_id: entity.keyword?.keyword_id || null,
            target_id: entity.target?.target_id || null,
            targeting_type: type,
            asin,
            keyword_text: entity.keyword?.keyword_text || entity.target?.target_value || null,
            match_type: entity.keyword?.match_type || null,
            day_of_week: clock.dow,
            hour: clock.hour,
            slot_label: `${clock.dow}_${clock.hour}h`,
            time_slot_score: slot.score,
            slot_classification: slot.classification,
            decision_type: targetBid > currentBid ? 'BID_UP' : targetBid < currentBid ? 'BID_DOWN_ACOS' : isRestore ? 'RESTORE_BASE' : 'MAINTAIN',
            rule_id: 'canonical_bid_envelope_050_150',
            rule_version: ENGINE_VERSION,
            current_bid: currentBid,
            base_bid: baseBid,
            bid_floor: floor,
            bid_cap: cap,
            proposed_bid: targetBid,
            bid_change_pct: baseBid > 0 ? r2(((targetBid - baseBid) / baseBid) * 100) : 0,
            bid_multiplier: choice.multiplier,
            envelope_min_multiplier: 0.50,
            envelope_max_multiplier: 1.50,
            bid_floor_applied: targetBid === floor,
            bid_cap_applied: targetBid === cap,
            metric_window: 'persisted_campaign_metrics',
            decision_window: 'current_hour_brt',
            baseline_window: 'daypart_base_bid',
            requires_approval: false,
            status: changed && !dryRun ? 'executing' : dryRun ? 'approved' : 'executed',
            slot_orders: orders,
            slot_clicks: clicks,
            slot_spend: spend,
            slot_sales: sales,
            slot_impressions: impressions,
            slot_acos: acos,
            target_acos: targetAcos,
            sustainable_cpc: safeMaxCpc || null,
            data_confidence: sampleMature ? 'HIGH' : slot.mature ? 'MEDIUM' : 'LOW',
            data_mature: slot.mature && (choice.multiplier >= 1 || sampleMature),
            reason: `${choice.reason} Base R$${baseBid.toFixed(2)}, faixa R$${floor.toFixed(2)}–R$${cap.toFixed(2)}, multiplicador ${choice.multiplier.toFixed(2)}x. Fonte: ${slot.source}.`,
            idempotency_key: idem,
            cycle_date: clock.date,
            created_at: clock.iso,
            updated_at: clock.iso,
          };
          const audit = await base44.asServiceRole.entities.DaypartingDecision.create(auditBase).catch(() => null);

          if (!changed) {
            if (audit?.id) await base44.asServiceRole.entities.DaypartingDecision.update(audit.id, { status: 'executed', executed_at: clock.iso }).catch(() => {});
            skipped++;
            results.push({ campaign_id: cid, entity_type: entity.entity_type, entity_id: entity.entity_id, base_bid: baseBid, bid: currentBid, multiplier: choice.multiplier, changed: false, reason: choice.reason });
            continue;
          }

          if (dryRun) {
            results.push({ campaign_id: cid, entity_type: entity.entity_type, entity_id: entity.entity_id, bid_before: currentBid, bid_after: targetBid, base_bid: baseBid, multiplier: choice.multiplier, dry_run: true });
            continue;
          }

          let ok = false;
          let requestId = '';
          let responsePayload: any = null;
          try {
            if (entity.entity_type === 'keyword') {
              const decision = await base44.asServiceRole.entities.OptimizationDecision.create({
                amazon_account_id: aid,
                decision_type: 'bid_adjustment',
                entity_type: 'keyword',
                entity_id: entity.entity_id,
                campaign_id: cid,
                ad_group_id: gid,
                keyword_id: entity.entity_id,
                asin,
                action: 'set_bid',
                current_value: currentBid,
                proposed_value: targetBid,
                value_before: currentBid,
                value_after: targetBid,
                rationale: auditBase.reason,
                risk: targetBid > currentBid ? 'medium' : 'low',
                requires_approval: false,
                status: 'approved',
                idempotency_key: idem,
                source_function: 'runCanonicalDaypartingEngine',
                created_at: clock.iso,
                updated_at: clock.iso,
              });
              const response = await base44.asServiceRole.functions.invoke('executePairedManualBidDecision', {
                decision_id: decision.id,
                decision_ids: [decision.id],
                _service_role: true,
              });
              const data = response?.data || response || {};
              const item = data?.results?.[0] || data;
              ok = item?.ok === true || item?.status === 'executed';
              responsePayload = data;
              requestId = String(item?.request_id || '');
            } else if (entity.entity_type === 'product_target') {
              const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
                amazon_account_id: aid,
                operation: 'canonical_daypart_product_target_bid',
                method: 'PUT',
                path: '/sp/targets',
                content_type: 'application/vnd.spTargetingClause.v3+json',
                accept: 'application/vnd.spTargetingClause.v3+json',
                payload: { targetingClauses: [{ targetId: entity.entity_id, bid: targetBid }] },
                max_attempts: 3,
                _service_role: true,
              });
              ok = amazonMultiSuccess(response, 'targetingClauses') || amazonMultiSuccess(response, 'targets');
              responsePayload = response?.data || response || {};
              requestId = String(responsePayload?.request_id || '');
              if (ok) await base44.asServiceRole.entities.ProductTarget.update(entity.row.id, { bid: targetBid, synced_at: clock.iso }).catch(() => {});
            } else {
              const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
                amazon_account_id: aid,
                operation: 'canonical_daypart_auto_adgroup_bid',
                method: 'PUT',
                path: '/sp/adGroups',
                content_type: 'application/vnd.spAdGroup.v3+json',
                accept: 'application/vnd.spAdGroup.v3+json',
                payload: { adGroups: [{ adGroupId: gid, defaultBid: targetBid }] },
                max_attempts: 3,
                _service_role: true,
              });
              ok = amazonMultiSuccess(response, 'adGroups');
              responsePayload = response?.data || response || {};
              requestId = String(responsePayload?.request_id || '');
            }

            if (ok) {
              const common = {
                daypart_base_bid: baseBid,
                daypart_bid_floor: floor,
                daypart_bid_cap: cap,
                daypart_active: choice.multiplier !== 1,
                daypart_multiplier: choice.multiplier,
                daypart_last_slot: slot.classification,
                daypart_last_adjusted_at: clock.iso,
                daypart_last_restored_at: isRestore ? clock.iso : null,
              };
              if (entity.entity_type === 'keyword') {
                await base44.asServiceRole.entities.Keyword.update(entity.row.id, { ...common, current_bid: targetBid, bid: targetBid }).catch(() => {});
                await base44.asServiceRole.entities.AdGroup.update(group.id, { ...common, default_bid: targetBid }).catch(() => {});
              } else if (entity.entity_type === 'product_target') {
                await base44.asServiceRole.entities.AdGroup.update(group.id, { ...common }).catch(() => {});
              } else {
                await base44.asServiceRole.entities.AdGroup.update(group.id, { ...common, default_bid: targetBid }).catch(() => {});
              }

              await logBid(base44, {
                amazon_account_id: aid,
                campaign_id: cid,
                keyword_id: entity.keyword?.keyword_id || null,
                keyword_text: entity.keyword?.keyword_text || entity.target?.target_value || null,
                bid_before: currentBid,
                bid_after: targetBid,
                base_bid: baseBid,
                classification: slot.classification,
                reason: auditBase.reason,
              });
              if (audit?.id) await base44.asServiceRole.entities.DaypartingDecision.update(audit.id, {
                status: 'executed',
                executed_at: clock.iso,
                amazon_request_id: requestId || null,
                amazon_response_status: Number(responsePayload?.status || 200),
                amazon_response: JSON.stringify(responsePayload || {}).slice(0, 4000),
                updated_at: clock.iso,
              }).catch(() => {});
              executed++;
              if (isRestore) restored++;
            } else {
              if (audit?.id) await base44.asServiceRole.entities.DaypartingDecision.update(audit.id, {
                status: 'failed',
                amazon_request_id: requestId || null,
                amazon_response_status: Number(responsePayload?.status || 0),
                amazon_response: JSON.stringify(responsePayload || {}).slice(0, 4000),
                updated_at: clock.iso,
              }).catch(() => {});
              failed++;
            }
          } catch (error: any) {
            if (audit?.id) await base44.asServiceRole.entities.DaypartingDecision.update(audit.id, {
              status: 'failed',
              reason: `${auditBase.reason} ERRO: ${error?.message || String(error)}`.slice(0, 1000),
              updated_at: clock.iso,
            }).catch(() => {});
            failed++;
          }

          results.push({
            campaign_id: cid,
            ad_group_id: gid,
            entity_type: entity.entity_type,
            entity_id: entity.entity_id,
            targeting_type: type,
            native_positive_rule: nativePositive,
            slot: slot.classification,
            base_bid: baseBid,
            floor,
            cap,
            bid_before: currentBid,
            bid_after: targetBid,
            multiplier: choice.multiplier,
            ok,
            reason: choice.reason,
          });
          await wait(500);
        }
      }
    }

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'canonical_dayparting_cycle',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      status: failed > 0 && executed === 0 ? 'error' : failed > 0 ? 'partial' : 'success',
      execution_date: clock.date,
      started_at: new Date(startedAt).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      records_processed: executed,
      result_summary: JSON.stringify({ hour_brt: clock.hour, slot: slot.classification, native_rules: nativeManagedCampaigns.size, executed, restored, skipped, failed }).slice(0, 1500),
      error_message: failed > 0 ? `${failed} ajuste(s) sem confirmação da Amazon.` : null,
    }).catch(() => {});

    return Response.json({
      ok: failed === 0 || executed > 0,
      engine_version: ENGINE_VERSION,
      hour_brt: clock.hour,
      day_of_week: clock.dow,
      slot,
      bid_envelope: { minimum_multiplier: 0.50, maximum_multiplier: 1.50, example_base_0_30: { floor: 0.15, cap: 0.45 } },
      native_positive_rules: nativeManagedCampaigns.size,
      native_rule_sync: nativeSync,
      pacing,
      confirmed_spend_today: r2(confirmedSpend),
      daily_cap: dailyCap,
      executed,
      restored,
      skipped,
      failed,
      results: results.slice(0, 200),
      duration_ms: Date.now() - startedAt,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha no motor canônico de dayparting' }, { status: 500 });
  }
});
