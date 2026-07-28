import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

const MAX_BATCH = 30;
const API_DELAY_MS = 400;

/**
 * HARD GUARD — assertSingleKeywordPerCampaign
 *
 * Verifica no banco local se a campanha já tem keyword ativa (EXACT).
 * Se sim, lança erro CANONICAL_MANUAL_CAMPAIGN_VIOLATION antes de qualquer chamada Amazon.
 * Garante a regra: 1 campanha manual = 1 keyword EXACT.
 */
async function assertSingleKeywordPerCampaign(
  base44: any,
  accountId: string,
  campaignId: string,
  newKeywordText: string,
): Promise<void> {
  if (!campaignId) return; // sem campaignId = nova campanha, sem conflito possível

  const existing = await base44.asServiceRole.entities.Keyword.filter(
    { amazon_account_id: accountId, campaign_id: campaignId },
    null, 10
  ).catch(() => []);

  const activeExact = existing.filter((k: any) => {
    const st = String(k.state || k.status || '').toLowerCase();
    if (st === 'archived') return false;
    return String(k.match_type || '').toLowerCase() === 'exact';
  });

  if (activeExact.length > 0) {
    const existingText = activeExact[0]?.keyword_text || activeExact[0]?.keyword || 'desconhecida';
    throw new Error(
      `CANONICAL_MANUAL_CAMPAIGN_VIOLATION: campanha ${campaignId} já tem keyword ativa "${existingText}". ` +
      `Tentativa de adicionar "${newKeywordText}" bloqueada. Use createManualCampaignV2 para criar uma nova campanha.`
    );
  }
}

function isEntityNotFound(payload: any): boolean {
  const s = JSON.stringify(payload || '').toLowerCase();
  return s.includes('entitynotfounderror') || s.includes('entity_not_found') ||
    s.includes('invalid keywordid') || s.includes('keywordid does not exist') ||
    s.includes('"code":"404"') || s.includes('"httpstatuscode":404') ||
    s.includes('not found') && s.includes('keyword');
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function prioritize(decisions: any[]): any[] {
  const order: Record<string, number> = {
    pause_campaign: 0, pause_keyword: 1,
    set_bid: 2, reduce_bid: 2, increase_bid: 3, update_bid: 3,
    budget_change: 4, update_budget: 4, reduce_budget: 4, increase_budget: 4,
  };
  return [...decisions].sort((a, b) => {
    const pa = order[a.action] ?? 9;
    const pb = order[b.action] ?? 9;
    if (pa !== pb) return pa - pb;
    if (a.action === b.action && a.action === 'set_bid') {
      const aReduce = (a.value_after || 0) < (a.value_before || 0) ? 0 : 1;
      const bReduce = (b.value_after || 0) < (b.value_before || 0) ? 0 : 1;
      return aReduce - bReduce;
    }
    return 0;
  });
}

Deno.serve(async (request) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    const body = await request.json().catch(() => ({}));
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    let account: any = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1);
      account = accs[0] || null;
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, null, 1);
      account = accs[0] || null;
    }
    if (!account) return Response.json({ ok: true, skipped: true, reason: 'Nenhuma conta conectada' });

    const aid = account.id;
    const approved = await base44.asServiceRole.entities.OptimizationDecision.filter(
      { amazon_account_id: aid, status: 'approved' },
      'created_at',
      MAX_BATCH + 50
    );

    if (approved.length === 0) {
      const parity = await base44.asServiceRole.functions.invoke('reconcileManualBidParity', {
        amazon_account_id: aid,
        _service_role: true,
      }).catch(() => null);
      return Response.json({ ok: true, executed: 0, bid_parity: parity?.data || parity || null, duration_ms: Date.now() - t0 });
    }

    const keywords = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, null, 1000).catch(() => []);
    const validKwIds = new Set(keywords.map((k: any) => k.keyword_id || k.id).filter(Boolean));

    // ── Revalidação de decisões obsoletas (STALE_DECISION_REVALIDATION) ──────
    // Antes de executar: verificar se decisões de pausa ainda são válidas.
    // Se campanha tem vendas recentes (orders_14d>0) E ACoS<=15% → cancelar decisão.
    let preAutoCancel = 0;
    const pauseDecisions = approved.filter(d =>
      d.action === 'pause_campaign' || d.action === 'pause_keyword' || d.action === 'archive_campaign'
    );
    if (pauseDecisions.length > 0) {
      // Buscar métricas recentes para revalidação
      const cutoff14d = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
      const staleMetrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
        { amazon_account_id: aid }, '-date', 500
      ).catch(() => []);
      const metrics14d = staleMetrics.filter((m: any) => m.date >= cutoff14d);

      // Agregar orders e acos por campaign_id
      const campaignMetrics14d = new Map<string, { orders: number; spend: number; sales: number }>();
      for (const m of metrics14d) {
        if (!m.campaign_id) continue;
        const ex = campaignMetrics14d.get(m.campaign_id) || { orders: 0, spend: 0, sales: 0 };
        ex.orders += m.orders || 0;
        ex.spend += m.spend || 0;
        ex.sales += m.sales || 0;
        campaignMetrics14d.set(m.campaign_id, ex);
      }

      for (const d of pauseDecisions) {
        const cid = d.campaign_id;
        if (!cid) continue;
        const cm = campaignMetrics14d.get(cid);
        if (!cm) continue;
        const acos14d = cm.sales > 0 ? (cm.spend / cm.sales) * 100 : null;
        // Cancelar se campanha tem vendas recentes e ACoS sustentável
        if (cm.orders > 0 && acos14d !== null && acos14d <= 15) {
          await base44.asServiceRole.entities.OptimizationDecision.update(d.id, {
            status: 'cancelled',
            error_message: `STALE_DECISION_REVALIDATION: campanha tem ${cm.orders}p em 14d e ACoS ${acos14d.toFixed(1)}% ≤ 15% — decisão de pausa obsoleta cancelada.`,
          }).catch(() => {});
          preAutoCancel++;
        }
      }
    }

    // ── Cancelar decisões com keyword_id ausente no banco ────────────────────
    for (const d of approved) {
      if (d.keyword_id && !validKwIds.has(d.keyword_id)) {
        await base44.asServiceRole.entities.OptimizationDecision.update(d.id, {
          status: 'cancelled',
          error_message: 'CANCELADO: keyword_id não encontrado no banco — entidade removida da Amazon',
        }).catch(() => {});
        preAutoCancel++;
      }
    }

    const stillApproved = preAutoCancel > 0
      ? await base44.asServiceRole.entities.OptimizationDecision.filter(
          { amazon_account_id: aid, status: 'approved' }, 'created_at', MAX_BATCH + 50
        ).catch(() => [])
      : approved;

    if (stillApproved.length === 0) {
      const parity = await base44.asServiceRole.functions.invoke('reconcileManualBidParity', {
        amazon_account_id: aid,
        _service_role: true,
      }).catch(() => null);
      return Response.json({ ok: true, executed: 0, pre_cancelled: preAutoCancel, bid_parity: parity?.data || parity || null, duration_ms: Date.now() - t0 });
    }

    const toProcess = prioritize(stillApproved).slice(0, MAX_BATCH);
    const results: any[] = [];
    let executed = 0, failed = 0, skipped = 0;

    for (const decision of toProcess) {
      if (Date.now() - t0 > 90000) break;

      try {
        // HARD GUARD: bloquear create_keyword se campanha já tem keyword ativa
        // Regra canônica: 1 campanha manual = 1 keyword EXACT
        if (
          (decision.action === 'create_keyword' || decision.decision_type === 'create_keyword' || decision.decision_type === 'harvest_search_term') &&
          decision.campaign_id
        ) {
          await assertSingleKeywordPerCampaign(
            base44,
            aid,
            decision.campaign_id,
            decision.keyword_text || decision.action || ''
          );
        }

        // Usa o roteador canônico: ajustes de bid são enviados para atualização pareada
        // de keyword e ad group; as demais ações seguem para o executor V2.
        const res = await base44.asServiceRole.functions.invoke('executeAutopilotDecision', {
          decision_ids: [decision.id],
          _service_role: true,
          _window_execution: true,
        });
        const data = res?.data || res || {};
        const ok = data?.executed > 0 || data?.ok === true;

        if (!ok && isEntityNotFound(data)) {
          await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
            status: 'cancelled',
            error_message: 'CANCELADO: entidade não encontrada na Amazon (ENTITY_NOT_FOUND) — decisão obsoleta',
          }).catch(() => {});
          results.push({ id: decision.id, action: decision.action, ok: false, cancelled: true });
          skipped++;
        } else {
          results.push({ id: decision.id, action: decision.action, ok });
          if (ok) executed++; else if (data?.scheduled) skipped++; else failed++;
        }
      } catch (e: any) {
        results.push({ id: decision.id, action: decision.action, ok: false, error: e.message });
        failed++;
      }

      if (toProcess.indexOf(decision) < toProcess.length - 1) await sleep(API_DELAY_MS);
    }

    // Corrige também divergências históricas existentes em todas as campanhas manuais.
    const parityResponse = await base44.asServiceRole.functions.invoke('reconcileManualBidParity', {
      amazon_account_id: aid,
      _service_role: true,
    }).catch((e: any) => ({ data: { ok: false, error: e?.message } }));
    const parity = parityResponse?.data || parityResponse || {};

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'ads_decision_execution',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      status: failed === 0 && parity?.ok !== false ? 'success' : executed > 0 ? 'warning' : 'error',
      execution_date: new Date().toISOString().slice(0, 10),
      started_at: new Date(t0).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - t0,
      records_processed: executed,
      error_message: failed > 0 ? `${failed} decisões falharam` : parity?.ok === false ? `Falha na reconciliação de bids: ${parity?.error || 'erro desconhecido'}` : null,
      result_summary: `${executed} executadas, ${failed} com erro, ${skipped} agendadas, ${preAutoCancel} pré-canceladas; ${Number(parity?.corrected || 0)} divergências de bid corrigidas`,
    }).catch(() => {});

    return Response.json({
      ok: true,
      pre_cancelled: preAutoCancel,
      total_approved: approved.length,
      processed: toProcess.length,
      executed,
      failed,
      skipped,
      remaining: Math.max(0, approved.length - MAX_BATCH),
      bid_parity: parity,
      duration_ms: Date.now() - t0,
      results: results.slice(0, 30),
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message }, { status: 500 });
  }
});