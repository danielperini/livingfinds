import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { clamp, numberValue, roundMoney } from '../../shared/profitGuardPolicy.ts';

const MAX_INCREASE_PCT = 20;
const MAX_DECREASE_PCT = 15;
const remoteId = (value: unknown) => /^\d+$/.test(String(value || '')) ? String(value) : '';

function nextBrtHourUtc(hour: number): Date {
  const now = new Date();
  const brtNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const targetBrt = new Date(brtNow);
  targetBrt.setHours(hour, 0, 0, 0);
  if (targetBrt.getTime() <= brtNow.getTime() + 5 * 60000) targetBrt.setDate(targetBrt.getDate() + 1);
  const offset = brtNow.getTime() - now.getTime();
  return new Date(targetBrt.getTime() - offset);
}

function parseData(value: any): any {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

Deno.serve(async (req) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const opportunityId = body.opportunity_id;
    if (!opportunityId) return Response.json({ ok: false, error: 'opportunity_id obrigatório' }, { status: 400 });
    const decisions = await base44.asServiceRole.entities.OptimizationDecision.filter({ id: opportunityId }, null, 1);
    const decision = decisions[0];
    if (!decision) return Response.json({ ok: false, error: 'Decisão não encontrada' }, { status: 404 });
    if (!body.approve && !(body.auto_apply === true && numberValue(decision.confidence, 0) >= 90)) {
      return Response.json({ ok: false, error: 'Aprovação necessária ou confiança inferior a 90%' }, { status: 403 });
    }

    const aid = decision.amazon_account_id;
    const campaignId = String(decision.campaign_id || decision.entity_id || '');
    const data = parseData(decision.data_used);
    const schedule = Array.isArray(data.dayparting_schedule) ? data.dayparting_schedule : [];
    if (!campaignId || !schedule.length) return Response.json({ ok: false, error: 'Campanha ou schedule ausente na decisão' }, { status: 400 });

    const [configRows, keywords, existingRules] = await Promise.all([
      base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }, '-updated_at', 1).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid, campaign_id: campaignId }, null, 1000).catch(() => []),
      base44.asServiceRole.entities.DaypartingRule.filter({ amazon_account_id: aid, campaign_id: campaignId }, '-updated_at', 500).catch(() => []),
    ]);
    const config = configRows[0] || {};
    const minBid = numberValue(config.min_bid, numberValue(data.bid_floor, 0.20));
    const maxBid = numberValue(config.max_bid, 5.00);
    const activeKeywords = keywords.filter((keyword: any) =>
      ['enabled', 'active'].includes(String(keyword.state || keyword.status || '').toLowerCase()) &&
      remoteId(keyword.amazon_keyword_id || keyword.keyword_id)
    );
    if (!activeKeywords.length) return Response.json({ ok: false, error: 'Nenhuma keyword ativa com ID Amazon na campanha' }, { status: 409 });

    const results = { rules_created: 0, rules_updated: 0, actions_created: 0, actions_existing: 0, skipped: 0, errors: [] as any[] };
    const now = new Date().toISOString();

    for (const slot of schedule) {
      const hour = Number(slot.hour);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
      const classification = String(slot.classification || 'efficient');
      const isIncrease = ['peak_high_profit', 'peak_conversion'].includes(classification);
      const isDecrease = ['deficit', 'low_efficiency'].includes(classification);
      if (!isIncrease && !isDecrease) continue;
      const scheduledAt = nextBrtHourUtc(hour);
      const restoreAt = new Date(scheduledAt.getTime() + 3600000);

      const existingRule = existingRules.find((rule: any) =>
        numberValue(rule.start_hour, -1) === hour &&
        String(rule.rule_type || '') === 'bid_schedule' &&
        String(rule.status || '') === 'active'
      );
      const rulePayload = {
        amazon_account_id: aid,
        campaign_id: campaignId,
        campaign_name: decision.entity_name || '',
        asin: decision.asin,
        rule_type: 'bid_schedule',
        days_of_week: [0, 1, 2, 3, 4, 5, 6],
        start_hour: hour,
        end_hour: hour,
        adjustment_type: 'percentage',
        adjustment_value: isIncrease ? Math.min(MAX_INCREASE_PCT, Math.max(0, numberValue(slot.bidChangePct, 0))) : -Math.min(MAX_DECREASE_PCT, Math.abs(numberValue(slot.bidChangePct, MAX_DECREASE_PCT))),
        bid_base_before: numberValue(slot.baseBid, data.base_bid),
        bid_floor: minBid,
        recommended_bid: numberValue(slot.recommendedBid, data.base_bid),
        classification,
        roas_at_creation: numberValue(slot.roas, 0),
        roas_index: numberValue(slot.roasIndex, 0),
        sales_freq_index: numberValue(slot.salesFreqIndex, 0),
        status: 'active',
        confidence: numberValue(decision.confidence, 0),
        sample_days: numberValue(data.days_with_data, 0),
        sample_clicks: numberValue(slot.clicks, 0),
        sample_orders: numberValue(slot.orders, 0),
        avg_roas: numberValue(data.avg_roas, 0),
        avg_acos: numberValue(data.avg_acos, 0),
        rationale: `${classification} ${hour}h: ajuste limitado a +${MAX_INCREASE_PCT}%/-${MAX_DECREASE_PCT}% com restauração em 1h.`,
        created_by: 'autopilot',
        approved_by: authenticated ? 'user' : 'autopilot',
        approved_at: now,
        updated_at: now,
      };
      if (existingRule) {
        await base44.asServiceRole.entities.DaypartingRule.update(existingRule.id, rulePayload).catch((error: any) => results.errors.push({ hour, stage: 'update_rule', error: error.message }));
        results.rules_updated++;
      } else {
        await base44.asServiceRole.entities.DaypartingRule.create({ ...rulePayload, created_at: now }).catch((error: any) => results.errors.push({ hour, stage: 'create_rule', error: error.message }));
        results.rules_created++;
      }

      for (const keyword of activeKeywords) {
        const keywordId = remoteId(keyword.amazon_keyword_id || keyword.keyword_id);
        const currentBid = numberValue(keyword.current_bid || keyword.bid, numberValue(data.base_bid, 0.50));
        const rawRecommended = numberValue(slot.recommendedBid, currentBid);
        const lowerBound = Math.max(minBid, currentBid * (1 - MAX_DECREASE_PCT / 100));
        const upperBound = Math.min(maxBid, currentBid * (1 + MAX_INCREASE_PCT / 100));
        const targetBid = roundMoney(clamp(rawRecommended, lowerBound, upperBound));
        if (Math.abs(targetBid - currentBid) < 0.005) {
          results.skipped++;
          continue;
        }
        const operation = targetBid > currentBid ? 'daypart_bid_increase' : 'daypart_bid_decrease';
        const key = `daypart_v3|${aid}|${campaignId}|${keywordId}|${scheduledAt.toISOString().slice(0, 13)}|${targetBid}`;
        const existing = await base44.asServiceRole.entities.AmazonActionQueue.filter({
          amazon_account_id: aid,
          idempotency_key: key,
        }, null, 1).catch(() => []);
        if (existing.length) {
          results.actions_existing++;
          continue;
        }
        await base44.asServiceRole.entities.AmazonActionQueue.create({
          amazon_account_id: aid,
          operation,
          entity_type: 'keyword',
          entity_id: keywordId,
          keyword_id: keywordId,
          campaign_id: campaignId,
          payload: {
            bid: targetBid,
            bid_before: currentBid,
            base_bid: currentBid,
            restore_bid: currentBid,
            restore_at: restoreAt.toISOString(),
            hour,
            end_hour: (hour + 1) % 24,
            classification,
            decision_id: decision.id,
          },
          idempotency_key: key,
          priority: isDecrease ? 'high' : 'normal',
          confidence: numberValue(decision.confidence, 0),
          status: 'pending',
          scheduled_at: scheduledAt.toISOString(),
          attempt_count: 0,
          max_attempts: 3,
          source: 'applyDaypartingSchedule',
          created_at: now,
          updated_at: now,
        }).catch((error: any) => results.errors.push({ hour, keyword_id: keywordId, stage: 'queue', error: error.message }));
        results.actions_created++;
      }
    }

    await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
      status: results.errors.length ? 'executing' : 'executed',
      executed_at: now,
      amazon_response: JSON.stringify({
        mode: 'local_idempotent_queue',
        native_schedule_rule_called: false,
        max_increase_pct: MAX_INCREASE_PCT,
        max_decrease_pct: MAX_DECREASE_PCT,
        ...results,
      }).slice(0, 4000),
    });

    return Response.json({
      ok: results.errors.length === 0,
      policy: {
        max_increase_pct: MAX_INCREASE_PCT,
        max_decrease_pct: MAX_DECREASE_PCT,
        restore_after_hours: 1,
        queue_idempotent: true,
        execute_only_at_scheduled_time: true,
        native_rule_endpoint_used: false,
      },
      campaign_id: campaignId,
      active_keywords: activeKeywords.length,
      results,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha ao aplicar dayparting' }, { status: 500 });
  }
});
