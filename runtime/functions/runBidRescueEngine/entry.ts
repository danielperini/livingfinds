import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

/**
 * runBidRescueEngine
 *
 * Critérios de elegibilidade (qualquer um basta):
 *   1. impressions === 0
 *   2. CTR < 0.1% com >= 100 impressões
 *   3. Sem spend E sem impressões nos últimos 7 dias (verifica CampaignMetricsDaily)
 *
 * Protections:
 *   - Ignora campanhas archived no banco
 *   - Ignora campanhas criadas há < 24h
 *   - Teto absoluto de bid: R$2,50
 *   - Registra em AdsBidChangeLog com action='bid_rescue'
 *   - Registra resumo em SyncExecutionLog
 */

const MIN_COMPETITIVE_BID = 0.75;
const MAX_BID = 1.00;
const MIN_IMPRESSIONS_FOR_CTR = 100;
const CTR_THRESHOLD = 0.001; // 0.1%
const INACTIVITY_DAYS = 7;

function detectCategory(text) {
  const t = (text || '').toLowerCase();
  if (/lixeira|lixo/.test(t)) return { name: 'lixeira', bid: 1.20 };
  if (/fechadura/.test(t)) return { name: 'fechadura', bid: 1.50 };
  if (/headset|fone|gamer/.test(t)) return { name: 'headset', bid: 1.00 };
  if (/microfone/.test(t)) return { name: 'microfone', bid: 0.90 };
  return { name: 'outros', bid: 0.85 };
}

function calcNewBid(keyword) {
  const suggestedBid = keyword.suggested_bid || 0;
  if (suggestedBid >= MIN_COMPETITIVE_BID) return Math.min(suggestedBid, MAX_BID);
  const currentBid = keyword.bid || keyword.current_bid || 0;
  if (currentBid >= MIN_COMPETITIVE_BID) return Math.min(currentBid * 1.2, MAX_BID);
  const { bid: catBid } = detectCategory(keyword.keyword_text);
  return Math.min(catBid, MAX_BID);
}

export default async function(req: Request): Promise<Response> {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, dry_run = false } = body as any;
    if (!amazon_account_id) return Response.json({ error: 'amazon_account_id obrigatório' }, { status: 400 });

    // ── 1. Buscar keywords MANUAL EXACT enabled ────────────────────────────
    const allKeywords = await base44.asServiceRole.entities.Keyword.filter(
      { amazon_account_id, state: 'enabled' }, null, 3000
    );

    // ── 2. Buscar campanhas MANUAL ────────────────────────────────────────
    const campaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id, targeting_type: 'MANUAL' }, null, 500
    );

    // ── 3. Buscar métricas dos últimos 7 dias por campanha ─────────────────
    const cutoffDate = new Date(Date.now() - INACTIVITY_DAYS * 86400000).toISOString().slice(0, 10);
    const recentMetrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id }, '-date', 1000
    ).catch(() => []);

    // Mapas
    const campaignMap = new Map(campaigns.map((c: any) => [c.id, c]));
    const campaignByAmazonId = new Map(campaigns.map((c: any) => [c.campaign_id || c.amazon_campaign_id, c]));
    const now = Date.now();
    const twentyFourHoursMs = 24 * 3600 * 1000;

    // Somar impressions/spend dos últimos 7 dias por campaign_id
    const recentActivity = new Map<string, { impressions: number; spend: number }>();
    for (const m of recentMetrics) {
      if (!m.date || m.date < cutoffDate) continue;
      const key = m.campaign_id;
      const prev = recentActivity.get(key) || { impressions: 0, spend: 0 };
      prev.impressions += m.impressions || 0;
      prev.spend += m.spend || 0;
      recentActivity.set(key, prev);
    }

    // ── 4. Filtrar elegíveis ───────────────────────────────────────────────
    const eligible: any[] = [];
    const skipped: any[] = [];

    for (const kw of allKeywords) {
      const campaign = campaignMap.get(kw.campaign_id) || campaignByAmazonId.get(kw.campaign_id);
      if (!campaign) { skipped.push({ kw: kw.keyword_text, reason: 'campanha_nao_encontrada' }); continue; }
      if ((campaign.status || '').toLowerCase() === 'archived') { skipped.push({ kw: kw.keyword_text, reason: 'campanha_archived' }); continue; }

      // Cooldown 24h
      const campaignCreatedAt = campaign.created_at || campaign.start_date;
      if (campaignCreatedAt && (now - new Date(campaignCreatedAt).getTime()) < twentyFourHoursMs) {
        skipped.push({ kw: kw.keyword_text, reason: 'campanha_nova_24h' }); continue;
      }

      const impressions = kw.impressions || 0;
      const clicks = kw.clicks || 0;
      const spend = kw.spend || 0;
      const ctr = impressions > 0 ? clicks / impressions : 0;

      // Verificar inatividade 7d
      const activity = recentActivity.get(kw.campaign_id) || { impressions: 0, spend: 0 };
      const inactiveLast7d = activity.impressions === 0 && activity.spend === 0;

      const isZeroImpressions = impressions === 0;
      const isLowCTR = impressions >= MIN_IMPRESSIONS_FOR_CTR && ctr < CTR_THRESHOLD;
      const isInactive7d = inactiveLast7d && spend === 0;

      if (!isZeroImpressions && !isLowCTR && !isInactive7d) {
        skipped.push({ kw: kw.keyword_text, reason: 'nao_elegivel' }); continue;
      }

      const currentBid = kw.current_bid || kw.bid || 0;
      const newBid = calcNewBid(kw);

      // Só mexer se o novo bid for maior que o atual
      if (newBid <= currentBid) { skipped.push({ kw: kw.keyword_text, reason: 'bid_ja_adequado' }); continue; }

      const reason = isZeroImpressions ? 'zero_impressions'
        : isLowCTR ? `low_ctr_${(ctr * 100).toFixed(3)}pct`
        : 'inactive_7d';

      eligible.push({
        keyword_id: kw.id,
        keyword_text: kw.keyword_text || '(sem texto)',
        match_type: kw.match_type || 'EXACT',
        current_bid: currentBid,
        new_bid: newBid,
        category: detectCategory(kw.keyword_text).name,
        rescue_reason: reason,
        campaign_id: kw.campaign_id,
        campaign_name: campaign.campaign_name || campaign.name || kw.campaign_id,
        ad_group_id: kw.ad_group_id,
        asin: campaign.asin || '',
        amazon_keyword_id: kw.keyword_id || kw.amazon_keyword_id,
        amazon_campaign_id: campaign.campaign_id || campaign.amazon_campaign_id,
      });
    }

    // ── 5. dry_run ────────────────────────────────────────────────────────
    if (dry_run) {
      return Response.json({
        ok: true, dry_run: true,
        total_analyzed: allKeywords.length,
        total_eligible: eligible.length,
        total_skipped: skipped.length,
        eligible: eligible.slice(0, 100),
      });
    }

    if (eligible.length === 0) {
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id, operation: 'bid_rescue_engine',
        trigger_type: 'automatic', status: 'completed',
        started_at: startedAt, completed_at: new Date().toISOString(),
        records_processed: 0,
        result_summary: `0 keywords corrigidas de ${allKeywords.length} analisadas`,
      }).catch(() => {});
      return Response.json({ ok: true, total_analyzed: allKeywords.length, total_fixed: 0, errors: [] });
    }

    // ── 6. Agrupar por campanha e enviar para Amazon ──────────────────────
    const byCampaign = new Map<string, any[]>();
    for (const item of eligible) {
      if (!byCampaign.has(item.campaign_id)) byCampaign.set(item.campaign_id, []);
      byCampaign.get(item.campaign_id)!.push(item);
    }

    let totalFixed = 0;
    const errors: any[] = [];

    for (const [, items] of byCampaign.entries()) {
      const keywordUpdates = items
        .filter((i: any) => i.amazon_keyword_id)
        .map((i: any) => ({
          keyword_id: i.amazon_keyword_id,
          ad_group_id: i.ad_group_id,
          campaign_id: i.amazon_campaign_id,
          bid: i.new_bid,
          keyword_text: i.keyword_text,
        }));

      if (keywordUpdates.length === 0) {
        for (const item of items) errors.push({ keyword: item.keyword_text, reason: 'sem_amazon_keyword_id' });
        continue;
      }

      try {
        const result = await base44.functions.invoke('bulkAdjustKeywordBids', {
          amazon_account_id, keywords: keywordUpdates,
        });
        const resultData = result?.data || result;
        const isOk = resultData?.ok || resultData?.success || (resultData?.updated > 0);

        if (isOk) {
          for (const item of items.filter((i: any) => i.amazon_keyword_id)) {
            await base44.asServiceRole.entities.Keyword.update(item.keyword_id, {
              bid: item.new_bid, current_bid: item.new_bid,
            }).catch(() => {});

            await base44.asServiceRole.entities.AdsBidChangeLog.create({
              amazon_account_id,
              campaign_id: item.campaign_id,
              campaign_name: item.campaign_name,
              ad_group_id: item.ad_group_id,
              keyword_id: item.amazon_keyword_id,
              keyword: item.keyword_text,
              keyword_text: item.keyword_text,
              asin: item.asin,
              old_bid: item.current_bid,
              new_bid: item.new_bid,
              bid_before: item.current_bid,
              bid_after: item.new_bid,
              change_amount: item.new_bid - item.current_bid,
              change_percent: item.current_bid > 0 ? ((item.new_bid - item.current_bid) / item.current_bid) * 100 : 100,
              direction: 'increase',
              action: 'bid_rescue',
              reason: `bid_rescue · ${item.rescue_reason} · categoria: ${item.category}`,
              classification: item.category,
              risk_level: 'low',
              status: 'executed',
              date: new Date().toISOString().slice(0, 10),
              created_at: new Date().toISOString(),
            }).catch(() => {});
            totalFixed++;
          }
        } else {
          for (const item of items) errors.push({ keyword: item.keyword_text, reason: resultData?.error || 'amazon_api_error' });
        }
      } catch (e: any) {
        for (const item of items) errors.push({ keyword: item.keyword_text, reason: e.message });
      }
    }

    const completedAt = new Date().toISOString();
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id, operation: 'bid_rescue_engine',
      trigger_type: body.trigger_type || 'automatic',
      status: errors.length > 0 && totalFixed === 0 ? 'error' : errors.length > 0 ? 'partial' : 'success',
      started_at: startedAt, completed_at: completedAt,
      records_processed: totalFixed,
      result_summary: `${totalFixed} keywords corrigidas de ${eligible.length} elegíveis (${allKeywords.length} analisadas). Erros: ${errors.length}`,
      error_message: errors.length > 0 ? errors.slice(0, 3).map((e: any) => e.reason).join('; ') : undefined,
    }).catch(() => {});

    return Response.json({
      ok: true, dry_run: false,
      total_analyzed: allKeywords.length,
      total_eligible: eligible.length,
      total_fixed: totalFixed,
      total_skipped: skipped.length,
      errors,
    });

  } catch (error: any) {
    await (createClientFromRequest(req)).asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: (await req.clone().json().catch(() => ({}))).amazon_account_id || '',
      operation: 'bid_rescue_engine', trigger_type: 'automatic', status: 'error',
      started_at: startedAt, completed_at: new Date().toISOString(),
      records_processed: 0, error_message: error.message,
    }).catch(() => {});
    return Response.json({ error: error.message }, { status: 500 });
  }
}
