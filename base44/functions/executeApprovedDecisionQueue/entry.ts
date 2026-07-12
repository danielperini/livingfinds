/**
 * executeApprovedDecisionQueue — Executa decisões aprovadas IMEDIATAMENTE
 *
 * MODO AGRESSIVO: não agenda slots noturnos, não espera janelas.
 * Processa até MAX_BATCH decisões por chamada, com pausa de 400ms entre
 * chamadas Amazon (rate limit seguro). Pausas urgentes têm prioridade absoluta.
 *
 * Prioridade de execução:
 *   1. pause_campaign / pause_keyword (imediato, crítico)
 *   2. set_bid com redução (proteção de margem)
 *   3. set_bid com aumento (escala)
 *   4. budget_change
 *   5. outros
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

const MAX_BATCH = 30;        // máx por chamada
const API_DELAY_MS = 400;    // pausa entre chamadas Amazon

// Detecta qualquer variante de "entidade não encontrada"
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
    // Redução de bid antes de aumento (proteção antes de escala)
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

    // Resolver conta
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

    // Buscar todas as decisões aprovadas pendentes
    const approved = await base44.asServiceRole.entities.OptimizationDecision.filter(
      { amazon_account_id: aid, status: 'approved' },
      'created_at',
      MAX_BATCH + 50
    );

    if (approved.length === 0) {
      return Response.json({ ok: true, executed: 0, duration_ms: Date.now() - t0 });
    }

    // Pré-validar keywords: cancelar decisões cujo keyword_id não existe mais no banco
    const keywords = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, null, 1000).catch(() => []);
    const validKwIds = new Set(keywords.map((k: any) => k.keyword_id || k.id).filter(Boolean));

    let preAutoCancel = 0;
    for (const d of approved) {
      if (d.keyword_id && !validKwIds.has(d.keyword_id)) {
        await base44.asServiceRole.entities.OptimizationDecision.update(d.id, {
          status: 'cancelled',
          error_message: 'CANCELADO: keyword_id não encontrado no banco — entidade removida da Amazon',
        }).catch(() => {});
        preAutoCancel++;
      }
    }

    // Recarregar após cancelamentos preventivos
    const stillApproved = preAutoCancel > 0
      ? await base44.asServiceRole.entities.OptimizationDecision.filter(
          { amazon_account_id: aid, status: 'approved' }, 'created_at', MAX_BATCH + 50
        ).catch(() => [])
      : approved;

    if (stillApproved.length === 0) {
      return Response.json({ ok: true, executed: 0, pre_cancelled: preAutoCancel, duration_ms: Date.now() - t0 });
    }

    // Priorizar e limitar
    const toProcess = prioritize(stillApproved).slice(0, MAX_BATCH);

    console.log(`[executeApprovedDecisionQueue] Executando ${toProcess.length} decisões para conta ${aid}`);

    const results: any[] = [];
    let executed = 0, failed = 0, skipped = 0;

    for (const decision of toProcess) {
      if (Date.now() - t0 > 90000) {
        console.warn('[executeApprovedDecisionQueue] Limite de tempo atingido, parando');
        break;
      }

      try {
        const res = await base44.asServiceRole.functions.invoke('executeAutopilotDecisionV2', {
          decision_ids: [decision.id],
          _service_role: true,
          _window_execution: true, // execução imediata — ignora verificação de janela
        });
        const data = res?.data || res || {};
        const ok = data?.executed > 0 || data?.ok === true;

        // Detectar ENTITY_NOT_FOUND e cancelar automaticamente (keyword/campanha removida da Amazon)
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

      // Pausa entre chamadas para respeitar rate limit Amazon
      if (toProcess.indexOf(decision) < toProcess.length - 1) {
        await sleep(API_DELAY_MS);
      }
    }

    // Log de auditoria
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'ads_decision_execution',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      status: failed === 0 ? 'success' : executed > 0 ? 'warning' : 'error',
      execution_date: new Date().toISOString().slice(0, 10),
      started_at: new Date(t0).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - t0,
      records_processed: executed,
      error_message: failed > 0 ? `${failed} decisões falharam` : null,
      result_summary: `${executed} executadas, ${failed} com erro, ${skipped} agendadas, ${preAutoCancel} pré-canceladas`,
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
      duration_ms: Date.now() - t0,
      results: results.slice(0, 30),
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message }, { status: 500 });
  }
});