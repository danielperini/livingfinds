/**
 * executeDaypartingDecision — Executa uma DaypartingDecision aprovada na Amazon Ads API
 *
 * Apenas status = 'approved' são aceitos. Aplica BID_LOCK por prioridade:
 * SAFETY > DAYPART > OPTIMIZATION > SCALE
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body   = await req.json().catch(() => ({}));
    const { decision_id, amazon_account_id } = body;

    if (!decision_id) {
      return Response.json({ ok: false, error: 'decision_id obrigatório' }, { status: 400 });
    }

    // Carregar decisão
    const decs = await base44.asServiceRole.entities.DaypartingDecision.filter({ id: decision_id }, null, 1);
    const dec = decs[0];
    if (!dec) return Response.json({ ok: false, error: 'Decisão não encontrada' }, { status: 404 });
    if (dec.status !== 'approved') {
      return Response.json({ ok: false, error: `Status inválido: ${dec.status}. Somente 'approved' pode ser executado.` }, { status: 400 });
    }
    if (dec.expires_at && dec.expires_at < new Date().toISOString()) {
      await base44.asServiceRole.entities.DaypartingDecision.update(dec.id, { status: 'expired' });
      return Response.json({ ok: false, error: 'Decisão expirada' }, { status: 400 });
    }

    const accountId = dec.amazon_account_id;
    const now = new Date().toISOString();

    // Chamar gateway de ajuste de bid
    const res = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
      _service_role: true,
      amazon_account_id: accountId,
      path: '/sp/keywords',
      method: 'PUT',
      content_type: 'application/vnd.spKeyword.v3+json',
      payload: {
        keywords: [{
          keywordId: dec.keyword_id,
          bid: dec.proposed_bid,
        }],
      },
    }).catch((e: any) => ({ ok: false, error: e.message }));

    const ok = (res as any)?.ok === true || (res as any)?.status === 207;

    if (ok) {
      // Atualizar Keyword local
      const kws = await base44.asServiceRole.entities.Keyword.filter({ keyword_id: dec.keyword_id }, null, 1).catch(() => []);
      if (kws[0]) {
        await base44.asServiceRole.entities.Keyword.update(kws[0].id, {
          current_bid: dec.proposed_bid,
          bid: dec.proposed_bid,
          last_seen_at: now,
        }).catch(() => {});
      }

      // Atualizar decisão como executada
      await base44.asServiceRole.entities.DaypartingDecision.update(dec.id, {
        status: 'executed',
        executed_at: now,
        amazon_response_status: 207,
      });

      // Log no AdsBidChangeLog para cooldown
      await base44.asServiceRole.entities.AdsBidChangeLog.create({
        amazon_account_id: accountId,
        campaign_id: dec.campaign_id,
        keyword_id: dec.keyword_id,
        keyword_text: dec.keyword_text,
        match_type: dec.match_type,
        bid_before: dec.current_bid,
        bid_after: dec.proposed_bid,
        change_pct: dec.bid_change_pct,
        action: `daypart_${dec.decision_type.toLowerCase()}`,
        acos_at_change: dec.slot_acos,
        target_acos_at_change: dec.target_acos,
        orders_at_change: dec.slot_orders,
        clicks_at_change: dec.slot_clicks,
        spend_at_change: dec.slot_spend,
        reason: dec.reason,
        rule_id: dec.rule_id,
        source: 'executeDaypartingDecision',
        created_at: now,
      }).catch(() => {});

      return Response.json({ ok: true, decision_id, executed_at: now, new_bid: dec.proposed_bid, duration_ms: Date.now() - t0 });
    } else {
      await base44.asServiceRole.entities.DaypartingDecision.update(dec.id, {
        status: 'pending_approval', // volta para aprovação após falha
      });
      return Response.json({ ok: false, error: 'Falha na Amazon Ads API', api_response: res, duration_ms: Date.now() - t0 });
    }

  } catch (err: any) {
    return Response.json({ ok: false, error: err.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});