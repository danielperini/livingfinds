/**
 * applyMinSuggestedBidsAllCampaigns v2
 *
 * Estratégia de rate-limit segura:
 * - Busca bid recommendations por ad_group (1 req/ad_group)
 * - Pausa de 1.5s entre cada chamada de recommendation
 * - Aplica lances em lotes de 10 (1 req por lote)
 * - Pausa de 500ms entre lotes de atualização
 * - Registra OptimizationDecision para cada alteração aplicada
 * - Roda de madrugada (02:30 BRT / 05:30 UTC) quando a Amazon reseta rate limits
 *
 * Só atualiza se novo bid for >= MIN_BID e diferente do atual por > R$0.01
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const WAIT = (ms: number) => new Promise(r => setTimeout(r, ms));
const MIN_BID = 0.40;
const RECOMMENDATION_PAUSE_MS = 1500; // 1 req/1.5s no endpoint de recomendações
const UPDATE_BATCH_SIZE = 10;
const UPDATE_PAUSE_MS = 500;

Deno.serve(async (req) => {
  const now = new Date().toISOString();
  const base44 = createClientFromRequest(req);

  try {
    const body = await req.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    // Resolver conta
    let account: any = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1);
      account = accs[0];
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, null, 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' }, { status: 404 });
    const aid = account.id;

    // ── 1. Buscar campanhas ativas ─────────────────────────────────────────
    const campaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 200);
    const activeCampaigns = campaigns.filter((c: any) =>
      ['enabled', 'active'].includes(String(c.state || c.status || '').toLowerCase())
    );

    if (activeCampaigns.length === 0) {
      return Response.json({ ok: true, message: 'Nenhuma campanha ativa.', applied: 0 });
    }

    const campAsinMap: Record<string, string> = {};
    for (const c of activeCampaigns) {
      const cid = c.campaign_id || c.amazon_campaign_id;
      if (cid && c.asin) campAsinMap[cid] = c.asin;
    }
    const activeCampaignIds = activeCampaigns
      .map((c: any) => c.campaign_id || c.amazon_campaign_id)
      .filter(Boolean);

    // ── 2. Buscar ad groups ativos (lotes de 10 campIds) ───────────────────
    const allAdGroups: any[] = [];
    for (let i = 0; i < activeCampaignIds.length; i += 10) {
      const batch = activeCampaignIds.slice(i, i + 10);
      const res = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
        amazon_account_id: aid,
        operation: 'listAdGroups',
        method: 'POST',
        path: '/sp/adGroups/list',
        payload: {
          campaignIdFilter: { include: batch },
          stateFilter: { include: ['ENABLED'] },
          maxResults: 100,
        },
        content_type: 'application/vnd.spAdGroup.v3+json',
        accept: 'application/vnd.spAdGroup.v3+json',
        max_attempts: 2,
        _service_role: true,
      }).catch(() => null);
      const data = res?.data || res || {};
      const ags = data?.payload?.adGroups || [];
      allAdGroups.push(...ags);
      await WAIT(300);
    }

    if (allAdGroups.length === 0) {
      return Response.json({ ok: true, message: 'Nenhum ad group encontrado.', applied: 0 });
    }

    // ── 3. Buscar keywords ativas (lotes de 10 campIds) ────────────────────
    const allKeywords: any[] = [];
    for (let i = 0; i < activeCampaignIds.length; i += 10) {
      const batch = activeCampaignIds.slice(i, i + 10);
      const res = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
        amazon_account_id: aid,
        operation: 'listKeywords',
        method: 'POST',
        path: '/sp/keywords/list',
        payload: {
          stateFilter: { include: ['ENABLED'] },
          campaignIdFilter: { include: batch },
          maxResults: 100,
        },
        content_type: 'application/vnd.spKeyword.v3+json',
        accept: 'application/vnd.spKeyword.v3+json',
        max_attempts: 2,
        _service_role: true,
      }).catch(() => null);
      const data = res?.data || res || {};
      allKeywords.push(...(data?.payload?.keywords || []));
      await WAIT(300);
    }

    // ── 4. Buscar bid recommendations por ad group (cadenciado) ───────────
    const bidRecByKeywordId: Record<string, { rangeStart: number; suggested: number; rangeEnd: number }> = {};
    let agRateLimited = 0;
    let agSuccess = 0;
    let agNoData = 0;

    for (const ag of allAdGroups) {
      const res = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
        amazon_account_id: aid,
        operation: 'getBidRecommendations',
        method: 'POST',
        path: '/sp/targets/bid/recommendations',
        payload: {
          adGroupId: String(ag.adGroupId),
          campaignId: String(ag.campaignId),
          recommendationType: 'KEYWORD_BIDS',
        },
        content_type: 'application/json',
        accept: 'application/json',
        max_attempts: 1,
        _service_role: true,
      }).catch(() => null);

      const data = res?.data || res || {};

      if (data?.status === 429 || data?.rate_limited) {
        agRateLimited++;
        // Em rate limit: aguardar mais antes de continuar
        await WAIT(5000);
        continue;
      }

      if (!data?.ok) {
        agNoData++;
        await WAIT(RECOMMENDATION_PAUSE_MS);
        continue;
      }

      const recs: any[] = data?.payload?.recommendations || data?.payload?.keywordBidRecommendations || [];
      for (const r of recs) {
        const kwId = String(r.keywordId || r.entity?.keywordId || '');
        if (!kwId) continue;
        bidRecByKeywordId[kwId] = {
          rangeStart: Number(r.suggestedBid?.rangeStart || r.rangeStart || 0),
          suggested: Number(r.suggestedBid?.suggested || r.suggested || 0),
          rangeEnd: Number(r.suggestedBid?.rangeEnd || r.rangeEnd || 0),
        };
      }

      agSuccess++;
      await WAIT(RECOMMENDATION_PAUSE_MS);
    }

    // ── 5. Calcular quais keywords precisam atualização ────────────────────
    const toChange = allKeywords
      .filter((kw: any) => {
        const rec = bidRecByKeywordId[String(kw.keywordId)];
        if (!rec || rec.rangeStart <= 0) return false;
        const newBid = Math.max(MIN_BID, Math.round(rec.rangeStart * 100) / 100);
        return Math.abs((kw.bid || 0) - newBid) > 0.01;
      })
      .map((kw: any) => {
        const rec = bidRecByKeywordId[String(kw.keywordId)];
        const newBid = Math.max(MIN_BID, Math.round(rec.rangeStart * 100) / 100);
        return {
          keywordId: String(kw.keywordId),
          keywordText: kw.keywordText,
          campaignId: kw.campaignId,
          currentBid: kw.bid || 0,
          newBid,
          rangeStart: rec.rangeStart,
          suggested: rec.suggested,
          rangeEnd: rec.rangeEnd,
          asin: campAsinMap[kw.campaignId] || null,
        };
      });

    if (toChange.length === 0) {
      return Response.json({
        ok: true,
        message: 'Nenhum lance precisa ser atualizado.',
        ad_groups_checked: allAdGroups.length,
        ad_groups_with_recommendations: agSuccess,
        ad_groups_rate_limited: agRateLimited,
        ad_groups_no_data: agNoData,
        keywords_total: allKeywords.length,
        applied: 0,
      });
    }

    // ── 6. Aplicar lances em lotes de 10 ──────────────────────────────────
    let applied = 0;
    let failed = 0;
    const decisions: any[] = [];

    for (let i = 0; i < toChange.length; i += UPDATE_BATCH_SIZE) {
      const batch = toChange.slice(i, i + UPDATE_BATCH_SIZE);
      const res = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
        amazon_account_id: aid,
        operation: 'updateBid',
        method: 'PUT',
        path: '/sp/keywords',
        payload: {
          keywords: batch.map(k => ({ keywordId: k.keywordId, bid: k.newBid })),
        },
        content_type: 'application/vnd.spKeyword.v3+json',
        accept: 'application/vnd.spKeyword.v3+json',
        max_attempts: 2,
        _service_role: true,
      }).catch(() => null);

      const data = res?.data || res || {};
      const successIds = new Set(
        (data?.payload?.keywords?.success || []).map((s: any) => String(s.keywordId))
      );

      for (const k of batch) {
        const ok = successIds.has(k.keywordId);
        if (ok) applied++; else failed++;

        decisions.push({
          amazon_account_id: aid,
          decision_type: 'bid_change',
          entity_type: 'keyword',
          entity_id: k.keywordId,
          campaign_id: k.campaignId,
          keyword_text: k.keywordText,
          asin: k.asin,
          action: 'set_bid',
          value_before: k.currentBid,
          value_after: k.newBid,
          rationale: `Lance mínimo sugerido Amazon: rangeStart=R$${k.rangeStart.toFixed(2)}, mid=R$${k.suggested.toFixed(2)}, max=R$${k.rangeEnd.toFixed(2)}. Aplicado R$${k.newBid.toFixed(2)} (max(R$${MIN_BID}, rangeStart)).`,
          status: ok ? 'executed' : 'failed',
          executed_at: ok ? now : null,
          evaluation_due_at: ok
            ? new Date(Date.now() + 72 * 3600000).toISOString()
            : null,
          source_function: 'applyMinSuggestedBidsAllCampaigns',
          created_at: now,
        });
      }

      await WAIT(UPDATE_PAUSE_MS);
    }

    // ── 7. Salvar decisions e log ──────────────────────────────────────────
    for (let i = 0; i < decisions.length; i += 50) {
      await base44.asServiceRole.entities.OptimizationDecision.bulkCreate(decisions.slice(i, i + 50)).catch(() => {});
    }

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'applyMinSuggestedBidsAllCampaigns',
      trigger_type: body._service_role && !body.amazon_account_id ? 'automatic' : 'manual',
      status: failed === 0 ? 'success' : 'warning',
      started_at: now,
      completed_at: new Date().toISOString(),
      records_processed: applied,
      result_summary: JSON.stringify({
        campaigns_active: activeCampaigns.length,
        ad_groups: allAdGroups.length,
        ag_with_recs: agSuccess,
        ag_rate_limited: agRateLimited,
        ag_no_data: agNoData,
        keywords_total: allKeywords.length,
        keywords_to_change: toChange.length,
        applied,
        failed,
      }),
      error_message: agRateLimited > 0
        ? `${agRateLimited} ad groups com rate limit — execute novamente para completar`
        : null,
    }).catch(() => {});

    return Response.json({
      ok: true,
      campaigns_active: activeCampaigns.length,
      ad_groups_checked: allAdGroups.length,
      ad_groups_with_recommendations: agSuccess,
      ad_groups_rate_limited: agRateLimited,
      ad_groups_no_data: agNoData,
      keywords_total: allKeywords.length,
      keywords_changed: applied,
      keywords_failed: failed,
      sample: toChange.slice(0, 10).map(k => ({
        keyword: k.keywordText,
        asin: k.asin,
        before: k.currentBid,
        after: k.newBid,
        amazon_min: k.rangeStart,
        amazon_suggested: k.suggested,
      })),
      note: agRateLimited > 0
        ? `${agRateLimited} ad groups com rate limit. Execute novamente em 5 min para completar os restantes.`
        : 'Todos os lances aplicados.',
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
});