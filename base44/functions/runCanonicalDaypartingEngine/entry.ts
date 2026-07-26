import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

/**
 * Motor canônico de dayparting híbrido.
 *
 * Amazon Schedule Bid Rules:
 * - incrementos recorrentes de +25% (STRONG) e +50% (ELITE);
 * - permanecem na infraestrutura da Amazon.
 *
 * LivingFinds:
 * - restaura o bid-base;
 * - reduz para 0,75x ou 0,50x em WEAK/LOSS;
 * - executa aumentos somente quando a regra nativa não estiver disponível;
 * - nunca calcula sobre um bid temporariamente alterado.
 */
const ENGINE_VERSION = 'canonical-dayparting-v2';
const MIN_REDUCTION_IMPRESSIONS = 200;
const MIN_REDUCTION_CLICKS = 10;
const MIN_REDUCTION_SPEND = 12;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const r2 = (value: number) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const norm = (value: any) => String(value || '').trim().toLowerCase();
const active = (value: any) => ['enabled', 'active'].includes(norm(value));

function brtClock() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  const dow: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    iso: now.toISOString(),
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour') || 0) % 24,
    dayOfWeek: dow[get('weekday')] ?? new Date(Date.now() - 3 * 3600000).getUTCDay(),
  };
}

function stock(product: any) {
  return Number(product?.fba_inventory ?? product?.available_quantity ?? product?.fulfillable_quantity ?? product?.stock ?? 0);
}

function campaignType(campaign: any): 'AUTO' | 'MANUAL' {
  const explicit = String(campaign?.targeting_type || campaign?.targetingType || '').toUpperCase();
  if (explicit === 'AUTO' || explicit === 'MANUAL') return explicit;
  return /manual/i.test(String(campaign?.name || campaign?.campaign_name || '')) ? 'MANUAL' : 'AUTO';
}

function amazonCampaignId(campaign: any) {
  return String(campaign?.amazon_campaign_id || campaign?.campaign_id || '');
}

function parseObject(value: any) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch { return {}; }
}

function classify(value: any): 'ELITE_TIME' | 'STRONG_TIME' | 'NORMAL_TIME' | 'WEAK_TIME' | 'LOSS_TIME' | 'COLLECTING_DATA' {
  const text = String(value || '').toUpperCase();
  if (text === 'PEAK_ELITE' || text === 'ELITE_TIME') return 'ELITE_TIME';
  if (text === 'PEAK_STRONG' || text === 'STRONG_TIME') return 'STRONG_TIME';
  if (text === 'NORMAL' || text === 'NORMAL_TIME') return 'NORMAL_TIME';
  if (text === 'WEAK' || text === 'WEAK_TIME') return 'WEAK_TIME';
  if (text === 'LOSS' || text === 'LOSS_TIME') return 'LOSS_TIME';
  return 'COLLECTING_DATA';
}

function resolveSlot(decisions: any[], patterns: any[], controller: any, dayOfWeek: number, hour: number) {
  const decision = decisions
    .filter((row) => Number(row.day_of_week) === dayOfWeek && Number(row.hour) === hour)
    .sort((a, b) => new Date(b.updated_at || b.created_at || 0).getTime() - new Date(a.updated_at || a.created_at || 0).getTime())[0];
  if (decision) {
    return {
      classification: classify(decision.slot_classification),
      score: Number(decision.time_slot_score || 0),
      mature: decision.data_mature === true || ['HIGH', 'VERY_HIGH'].includes(String(decision.data_confidence || '')),
      source: 'DaypartingDecision',
    };
  }

  const pattern = patterns.find((row) => Number(row.day_of_week) === dayOfWeek && Number(row.hour) === hour);
  if (pattern) {
    return {
      classification: classify(pattern.classification),
      score: Number(pattern.peak_score || 0),
      mature: Number(pattern.occurrences || 0) >= 3 && String(pattern.classification || '') !== 'INSUFFICIENT_DATA',
      source: 'HourlySalesPattern',
    };
  }

  const scores = parseObject(controller?.hour_value_scores);
  const score = Number(scores?.[hour] || 0);
  return {
    classification: score >= 90 ? 'ELITE_TIME'
      : score >= 75 ? 'STRONG_TIME'
      : score >= 55 ? 'NORMAL_TIME'
      : score >= 35 ? 'WEAK_TIME'
      : score > 0 ? 'LOSS_TIME'
      : 'COLLECTING_DATA',
    score,
    mature: score > 0,
    source: score > 0 ? 'AccountDailySpendController' : 'no_hourly_data',
  };
}

function metrics(campaign: any) {
  const spend = Number(campaign.current_spend ?? campaign.spend ?? 0);
  const sales = Number(campaign.sales || 0);
  const orders = Number(campaign.orders || 0);
  const impressions = Number(campaign.impressions || 0);
  const clicks = Number(campaign.clicks || 0);
  const storedAcos = Number(campaign.acos || 0);
  const acos = sales > 0 ? (spend / sales) * 100 : storedAcos > 0 ? storedAcos : null;
  return { spend, sales, orders, impressions, clicks, acos };
}

function chooseMultiplier(params: {
  slot: ReturnType<typeof resolveSlot>;
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
  if (!slot.mature || slot.classification === 'COLLECTING_DATA') return { multiplier: 1, reason: 'Dados horários insuficientes; manter bid-base.' };

  const profitable = orders > 0 && acos !== null && acos <= targetAcos;
  const exceptional = orders >= 2 && acos !== null && acos <= targetAcos * 0.80;
  const economicRisk = profitProtection || (breakEvenAcos !== null && acos !== null && acos >= breakEvenAcos * 0.95);

  if (slot.classification === 'ELITE_TIME') {
    if (nativePositive) return { multiplier: 1, reason: 'Regra Amazon aplica +50%; manter/restaurar bid-base local.' };
    if (pacing === 'overpacing' || economicRisk) return { multiplier: 1, reason: 'Aumento ELITE bloqueado por pacing ou proteção de lucro.' };
    if (exceptional) return { multiplier: 1.50, reason: 'ELITE excepcional: teto de +50%.' };
    if (profitable) return { multiplier: 1.25, reason: 'ELITE rentável: estágio intermediário de +25%.' };
    return { multiplier: 1, reason: 'ELITE sem evidência econômica suficiente.' };
  }

  if (slot.classification === 'STRONG_TIME') {
    if (nativePositive) return { multiplier: 1, reason: 'Regra Amazon aplica +25%; manter/restaurar bid-base local.' };
    if (pacing === 'overpacing' || economicRisk) return { multiplier: 1, reason: 'Aumento STRONG bloqueado por pacing ou proteção de lucro.' };
    if (exceptional) return { multiplier: 1.25, reason: 'STRONG excepcional: +25%.' };
    if (profitable) return { multiplier: 1.15, reason: 'STRONG rentável: +15% conservador.' };
    return { multiplier: 1, reason: 'STRONG sem evidência econômica suficiente.' };
  }

  if (slot.classification === 'NORMAL_TIME') return { multiplier: 1, reason: 'NORMAL: manter/restaurar bid-base.' };
  if (winner) return { multiplier: 1, reason: 'Entidade vencedora protegida contra redução horária.' };
  if (!sampleMature) return { multiplier: 1, reason: 'Redução bloqueada por amostra insuficiente.' };

  if (slot.classification === 'WEAK_TIME') {
    if (orders === 0 || (acos !== null && acos > targetAcos * 1.20) || pacing === 'overpacing') {
      return { multiplier: 0.75, reason: 'WEAK com desperdício/overpacing: -25%.' };
    }
    return { multiplier: 1, reason: 'WEAK com conversão protegida.' };
  }

  if (slot.classification === 'LOSS_TIME') {
    if (orders === 0 && (acos === null || acos > targetAcos * 1.20)) {
      return { multiplier: 0.50, reason: 'LOSS sem conversão rentável: piso de -50%.' };
    }
    if (acos !== null && acos > targetAcos) return { multiplier: 0.75, reason: 'LOSS acima da meta: -25%.' };
    return { multiplier: 1, reason: 'LOSS, mas com conversão/ACoS protegido.' };
  }

  return { multiplier: 1, reason: 'Sem ajuste aplicável.' };
}

function commandOk(response: any, key: string) {
  const data = response?.data || response || {};
  if (data?.ok === false) return false;
  if (Number(data?.status || 0) !== 207) return data?.ok === true;
  const payload = data?.payload || {};
  const success = payload?.[key]?.success || payload?.success || [];
  return Array.isArray(success) ? success.length > 0 : true;
}

async function auditBid(base44: any, data: any) {
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
    status: 'executed',
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

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon Ads conectada' }, { status: 404 });

    const aid = account.id;
    const clock = brtClock();
    const dryRun = body.dry_run === true;

    // Chamadas diretas também recebem preflight. Wrappers podem informar que já executaram.
    let nativePreflight: any = null;
    let queuePreflight: any = null;
    if (body.skip_native_preflight !== true) {
      const response = await base44.asServiceRole.functions.invoke('syncAmazonScheduleBidRules', {
        amazon_account_id: aid,
        dry_run: dryRun,
        _service_role: true,
      }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
      nativePreflight = response?.data || response || {};
    }
    if (body.skip_queue_preflight !== true) {
      const response = await base44.asServiceRole.functions.invoke('reconcileLegacyDaypartingQueue', {
        amazon_account_id: aid,
        _service_role: true,
      }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
      queuePreflight = response?.data || response || {};
    }

    const [configs, performance, controllers, campaigns, products, economics, adGroups, keywords, productTargets, patterns, decisions, nativeRules] = await Promise.all([
      base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }, null, 1).catch(() => []),
      base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, null, 1).catch(() => []),
      base44.asServiceRole.entities.AccountDailySpendController.filter({ amazon_account_id: aid, spend_date: clock.date }, null, 1).catch(() => []),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 500).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 500).catch(() => []),
      base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: aid }, null, 500).catch(() => []),
      base44.asServiceRole.entities.AdGroup.filter({ amazon_account_id: aid }, null, 1500).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, '-spend', 5000).catch(() => []),
      base44.asServiceRole.entities.ProductTarget.filter({ amazon_account_id: aid }, '-spend', 5000).catch(() => []),
      base44.asServiceRole.entities.HourlySalesPattern.filter({ amazon_account_id: aid }, null, 500).catch(() => []),
      base44.asServiceRole.entities.DaypartingDecision.filter({ amazon_account_id: aid }, '-created_at', 2000).catch(() => []),
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

    // O piso do dayparting é específico e não reutiliza min_bid de lançamento.
    // Assim, bid-base R$0,30 pode chegar exatamente a R$0,15.
    const absoluteMinBid = Math.max(0.02, Number(body.daypart_absolute_min_bid ?? cfg.daypart_absolute_min_bid ?? 0.02));
    const absoluteMaxBid = Number(perf.max_bid || cfg.max_bid || 5);
    const targetAcos = Number(perf.target_acos || cfg.target_acos || 15);
    const minManualOrders = Number(cfg.min_orders_for_scale || 2);
    const dailyCap = Number(controller.effective_daily_spend_cap || controller.user_daily_spend_cap || cfg.total_daily_budget || cfg.daily_budget_limit || account.max_daily_budget_limit || 0);
    const confirmedSpend = campaigns.reduce((sum, campaign) => sum + Number(campaign.current_spend ?? 0), 0);
    const pacing = String(controller.spend_pacing || (dailyCap > 0 && confirmedSpend > dailyCap * ((clock.hour + 1) / 24) * 1.20 ? 'overpacing' : 'on_track'));

    const productByAsin = new Map(products.map((product: any) => [String(product.asin || ''), product]));
    const economicsByAsin = new Map(economics.map((economic: any) => [String(economic.asin || ''), economic]));
    const nativeCampaigns = new Set<string>();
    for (const rule of nativeRules) {
      if (rule.native_api_supported !== true || rule.fallback_mode !== 'amazon_native_positive_app_negative') continue;
      for (const cid of (rule.associated_campaign_ids || rule.campaign_ids || [])) nativeCampaigns.add(String(cid));
    }

    const slot = resolveSlot(decisions, patterns, controller, clock.dayOfWeek, clock.hour);
    const results: any[] = [];
    let executed = 0, restored = 0, skipped = 0, failed = 0;

    for (const campaign of campaigns) {
      const cid = amazonCampaignId(campaign);
      const type = campaignType(campaign);
      const asin = String(campaign.asin || '');
      const product = productByAsin.get(asin);
      if (!cid || !active(campaign.state || campaign.status) || campaign.archived === true || stock(product) <= 0 || String(campaign.campaign_type || 'SP').toUpperCase() !== 'SP') continue;

      const cm = metrics(campaign);
      const strategicManual = type === 'MANUAL' && cm.orders >= minManualOrders && cm.sales > 0 && cm.acos !== null && cm.acos <= targetAcos;
      if (type === 'MANUAL' && !strategicManual) {
        skipped++;
        results.push({ campaign_id: cid, targeting_type: type, skipped: true, reason: 'manual_not_strategic' });
        continue;
      }

      const economic = economicsByAsin.get(asin) || {};
      const safeMaxCpc = Number(economic.safe_max_cpc || economic.maximum_safe_cpc || perf.max_cpc || 0);
      const breakEvenAcos = Number(economic.break_even_acos || campaign.break_even_acos || 0) || null;
      const winner = cm.orders > 0 && cm.acos !== null && cm.acos <= targetAcos;
      const profitProtection = String(economic.profit_protection_mode || '').toLowerCase() === 'paused' || Number(economic.profit_after_ads_3d || 0) < 0;
      const sampleMature = cm.impressions >= MIN_REDUCTION_IMPRESSIONS && cm.clicks >= MIN_REDUCTION_CLICKS && cm.spend >= MIN_REDUCTION_SPEND;
      const nativePositive = nativeCampaigns.has(cid);

      const groups = adGroups.filter((group: any) => String(group.campaign_id || '') === cid && active(group.state || group.status));
      for (const group of groups) {
        const gid = String(group.ad_group_id || '');
        if (!gid) continue;
        const groupKeywords = keywords.filter((keyword: any) => String(keyword.ad_group_id || '') === gid && active(keyword.state || keyword.status));
        const groupTargets = productTargets.filter((target: any) => String(target.ad_group_id || '') === gid && active(target.state || target.status) && target.is_negative !== true);
        const entities: any[] = [];

        if (type === 'AUTO') {
          entities.push({ entityType: 'ad_group', entityId: gid, row: group, currentBid: Number(group.default_bid || 0), keyword: null, target: null });
        } else {
          const exact = groupKeywords.filter((keyword: any) => norm(keyword.match_type || keyword.matchType) === 'exact');
          if (exact.length === 1 && groupKeywords.length === 1) {
            const keyword = exact[0];
            entities.push({ entityType: 'keyword', entityId: String(keyword.keyword_id || keyword.id || ''), row: keyword, currentBid: Number(keyword.current_bid || keyword.bid || group.default_bid || 0), keyword, target: null });
          } else if (groupTargets.length > 0 && groupKeywords.length === 0) {
            for (const target of groupTargets.slice(0, 25)) {
              entities.push({ entityType: 'product_target', entityId: String(target.target_id || target.id || ''), row: target, currentBid: Number(target.bid || group.default_bid || 0), keyword: null, target });
            }
          } else {
            skipped++;
            results.push({ campaign_id: cid, ad_group_id: gid, skipped: true, reason: `manual_group_noncanonical:${groupKeywords.length}_keywords:${exact.length}_exact:${groupTargets.length}_targets` });
            continue;
          }
        }

        for (const entity of entities) {
          if (!entity.entityId) { skipped++; continue; }
          const currentBid = Number(entity.currentBid || absoluteMinBid);
          const storedBase = Number(entity.row.daypart_base_bid || group.daypart_base_bid || 0);
          const baseBid = r2(storedBase > 0 ? storedBase : currentBid);
          const floor = r2(Math.max(absoluteMinBid, baseBid * 0.50));
          const caps = [absoluteMaxBid, baseBid * 1.50];
          if (safeMaxCpc > 0) caps.push(safeMaxCpc);
          const cap = r2(Math.max(floor, Math.min(...caps)));
          const wasAdjusted = entity.row.daypart_active === true || group.daypart_active === true;

          const choice = chooseMultiplier({
            slot,
            nativePositive,
            pacing,
            winner,
            sampleMature,
            orders: cm.orders,
            acos: cm.acos,
            targetAcos,
            breakEvenAcos,
            profitProtection,
          });
          const targetBid = r2(Math.max(floor, Math.min(cap, baseBid * choice.multiplier)));
          const changed = Math.abs(targetBid - currentBid) >= 0.01;
          const restoring = changed && wasAdjusted && choice.multiplier === 1;
          const idem = `${aid}|canonical_daypart|${entity.entityType}|${entity.entityId}|${clock.date}|${clock.hour}|${targetBid}`;

          const existing = await base44.asServiceRole.entities.DaypartingDecision.filter({ amazon_account_id: aid, idempotency_key: idem }, '-updated_at', 1).catch(() => []);
          let audit = existing[0] || null;
          if (audit && ['executed', 'executing', 'approved'].includes(String(audit.status || ''))) {
            skipped++;
            continue;
          }

          const reason = `${choice.reason} Base R$${baseBid.toFixed(2)}; faixa R$${floor.toFixed(2)}–R$${cap.toFixed(2)}; multiplicador ${choice.multiplier.toFixed(2)}x; fonte ${slot.source}.`;
          const auditData: any = {
            amazon_account_id: aid,
            entity_type: entity.entityType,
            entity_id: entity.entityId,
            campaign_id: cid,
            ad_group_id: gid,
            keyword_id: entity.keyword?.keyword_id || null,
            target_id: entity.target?.target_id || null,
            targeting_type: type,
            asin,
            keyword_text: entity.keyword?.keyword_text || entity.target?.target_value || null,
            match_type: entity.keyword?.match_type || null,
            day_of_week: clock.dayOfWeek,
            hour: clock.hour,
            slot_label: `${clock.dayOfWeek}_${clock.hour}h`,
            time_slot_score: slot.score,
            slot_classification: slot.classification,
            decision_type: targetBid > currentBid ? 'BID_UP' : targetBid < currentBid ? 'BID_DOWN_ACOS' : restoring ? 'RESTORE_BASE' : 'MAINTAIN',
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
            slot_orders: cm.orders,
            slot_clicks: cm.clicks,
            slot_spend: cm.spend,
            slot_sales: cm.sales,
            slot_impressions: cm.impressions,
            slot_acos: cm.acos,
            target_acos: targetAcos,
            sustainable_cpc: safeMaxCpc || null,
            data_confidence: sampleMature ? 'HIGH' : slot.mature ? 'MEDIUM' : 'LOW',
            data_mature: slot.mature && (choice.multiplier >= 1 || sampleMature),
            reason,
            idempotency_key: idem,
            cycle_date: clock.date,
            updated_at: clock.iso,
          };

          if (audit?.id) await base44.asServiceRole.entities.DaypartingDecision.update(audit.id, auditData).catch(() => {});
          else audit = await base44.asServiceRole.entities.DaypartingDecision.create({ ...auditData, created_at: clock.iso }).catch(() => null);

          if (!changed) {
            if (audit?.id) await base44.asServiceRole.entities.DaypartingDecision.update(audit.id, { status: 'executed', executed_at: clock.iso }).catch(() => {});
            skipped++;
            results.push({ campaign_id: cid, entity_type: entity.entityType, entity_id: entity.entityId, changed: false, base_bid: baseBid, current_bid: currentBid, reason: choice.reason });
            continue;
          }
          if (dryRun) {
            results.push({ campaign_id: cid, entity_type: entity.entityType, entity_id: entity.entityId, dry_run: true, bid_before: currentBid, bid_after: targetBid, base_bid: baseBid, floor, cap });
            continue;
          }

          let ok = false;
          let responseData: any = null;
          let requestId = '';
          try {
            if (entity.entityType === 'keyword') {
              const decision = await base44.asServiceRole.entities.OptimizationDecision.create({
                amazon_account_id: aid,
                decision_type: 'bid_adjustment',
                entity_type: 'keyword',
                entity_id: entity.entityId,
                campaign_id: cid,
                ad_group_id: gid,
                keyword_id: entity.entityId,
                asin,
                action: 'set_bid',
                current_value: currentBid,
                proposed_value: targetBid,
                value_before: currentBid,
                value_after: targetBid,
                rationale: reason,
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
              responseData = response?.data || response || {};
              const item = responseData?.results?.[0] || responseData;
              ok = item?.ok === true || item?.status === 'executed';
              requestId = String(item?.request_id || '');
            } else if (entity.entityType === 'product_target') {
              const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
                amazon_account_id: aid,
                operation: 'canonical_daypart_product_target_bid',
                method: 'PUT',
                path: '/sp/targets',
                content_type: 'application/vnd.spTargetingClause.v3+json',
                accept: 'application/vnd.spTargetingClause.v3+json',
                payload: { targetingClauses: [{ targetId: entity.entityId, bid: targetBid }] },
                max_attempts: 3,
                _service_role: true,
              });
              responseData = response?.data || response || {};
              ok = commandOk(response, 'targetingClauses') || commandOk(response, 'targets');
              requestId = String(responseData?.request_id || '');
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
              responseData = response?.data || response || {};
              ok = commandOk(response, 'adGroups');
              requestId = String(responseData?.request_id || '');
            }

            if (ok) {
              const state = {
                daypart_base_bid: baseBid,
                daypart_bid_floor: floor,
                daypart_bid_cap: cap,
                daypart_active: choice.multiplier !== 1,
                daypart_multiplier: choice.multiplier,
                daypart_last_slot: slot.classification,
                daypart_last_adjusted_at: clock.iso,
                daypart_last_restored_at: restoring ? clock.iso : null,
              };
              if (entity.entityType === 'keyword') {
                await base44.asServiceRole.entities.Keyword.update(entity.row.id, { ...state, current_bid: targetBid, bid: targetBid }).catch(() => {});
                await base44.asServiceRole.entities.AdGroup.update(group.id, { ...state, default_bid: targetBid }).catch(() => {});
              } else if (entity.entityType === 'product_target') {
                await base44.asServiceRole.entities.AdGroup.update(group.id, state).catch(() => {});
              } else {
                await base44.asServiceRole.entities.AdGroup.update(group.id, { ...state, default_bid: targetBid }).catch(() => {});
              }

              await auditBid(base44, {
                amazon_account_id: aid,
                campaign_id: cid,
                keyword_id: entity.keyword?.keyword_id || null,
                keyword_text: entity.keyword?.keyword_text || entity.target?.target_value || null,
                bid_before: currentBid,
                bid_after: targetBid,
                base_bid: baseBid,
                reason,
                classification: slot.classification,
              });
              executed++;
              if (restoring) restored++;
            } else failed++;

            if (audit?.id) await base44.asServiceRole.entities.DaypartingDecision.update(audit.id, {
              status: ok ? 'executed' : 'failed',
              executed_at: ok ? clock.iso : null,
              amazon_request_id: requestId || null,
              amazon_response_status: Number(responseData?.status || (ok ? 200 : 0)),
              amazon_response: JSON.stringify(responseData || {}).slice(0, 4000),
              updated_at: clock.iso,
            }).catch(() => {});
          } catch (error: any) {
            failed++;
            if (audit?.id) await base44.asServiceRole.entities.DaypartingDecision.update(audit.id, {
              status: 'failed',
              reason: `${reason} ERRO: ${error?.message || String(error)}`.slice(0, 1000),
              updated_at: clock.iso,
            }).catch(() => {});
          }

          results.push({
            campaign_id: cid,
            ad_group_id: gid,
            entity_type: entity.entityType,
            entity_id: entity.entityId,
            targeting_type: type,
            strategic_manual: strategicManual,
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
      result_summary: JSON.stringify({ hour_brt: clock.hour, slot: slot.classification, native_rules: nativeCampaigns.size, executed, restored, skipped, failed }).slice(0, 1500),
      error_message: failed > 0 ? `${failed} ajuste(s) sem confirmação da Amazon.` : null,
    }).catch(() => {});

    return Response.json({
      ok: failed === 0 || executed > 0,
      engine_version: ENGINE_VERSION,
      hour_brt: clock.hour,
      day_of_week: clock.dayOfWeek,
      slot,
      bid_envelope: {
        minimum_multiplier: 0.50,
        maximum_multiplier: 1.50,
        absolute_min_bid: absoluteMinBid,
        example_base_0_30: { floor: 0.15, intermediate_down: 0.225, base: 0.30, intermediate_up: 0.375, cap: 0.45 },
      },
      native_positive_rules: nativeCampaigns.size,
      native_preflight: nativePreflight,
      queue_preflight: queuePreflight,
      pacing,
      confirmed_spend_today: r2(confirmedSpend),
      daily_cap: dailyCap,
      executed,
      restored,
      skipped,
      failed,
      results: results.slice(0, 250),
      duration_ms: Date.now() - startedAt,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha no motor canônico de dayparting' }, { status: 500 });
  }
});
