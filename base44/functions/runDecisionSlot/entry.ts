/**
 * runDecisionSlot — Executa decisões do slot horário atual (sem timeout)
 *
 * Roda a cada hora (00h–07h + 13h BRT). Processa até MAX_PER_RUN decisões
 * com intervalo de 14s entre chamadas Amazon (rate limit). Retorna em < 90s.
 *
 * Decisões com queue_hour == hora atual BRT são processadas.
 * Pausa de 14s entre cada execução real na Amazon (respeita rate limit).
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MAX_PER_RUN = 8;         // máx por execução (14s * 8 = ~112s < 2min)
const INTER_DELAY_MS = 14000;  // 14s entre chamadas Amazon
const MAX_DURATION_MS = 100000; // sair se ultrapassar 100s

function currentHourBRT(): number {
  const utcH = new Date().getUTCHours();
  return (utcH - 3 + 24) % 24;
}

function isOperationalWindow(h: number): boolean {
  return h >= 0 && h <= 6 || h === 13;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

Deno.serve(async (request) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));

    const hourBRT = currentHourBRT();

    // Só roda nas janelas operacionais (00-07h e 13h BRT)
    if (!isOperationalWindow(hourBRT) && !body.force) {
      return Response.json({
        ok: true,
        skipped: true,
        reason: `Fora da janela operacional. Hora BRT: ${hourBRT}h. Janela: 00h-07h e 13h.`,
      });
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

    // Buscar decisões do slot atual que ainda estão approved/queued
    const slotDecisions = await base44.asServiceRole.entities.OptimizationDecision.filter(
      { amazon_account_id: aid, status: 'approved', queue_hour: hourBRT },
      'created_at',
      MAX_PER_RUN + 10
    );

    // Fallback: decisões approved sem queue_hour (distribuídas antes do novo sistema)
    const unslotted = slotDecisions.length < MAX_PER_RUN
      ? await base44.asServiceRole.entities.OptimizationDecision.filter(
          { amazon_account_id: aid, status: 'approved', queue_hour: null },
          'created_at',
          MAX_PER_RUN - slotDecisions.length
        ).catch(() => [])
      : [];

    const toProcess = [...slotDecisions, ...unslotted].slice(0, MAX_PER_RUN);

    if (toProcess.length === 0) {
      return Response.json({
        ok: true,
        hour_brt: hourBRT,
        processed: 0,
        reason: 'Sem decisões para este slot',
      });
    }

    console.log(`[runDecisionSlot] hora=${hourBRT}h BRT, processando ${toProcess.length} decisões`);

    const results: any[] = [];
    let executed = 0, failed = 0;

    for (const decision of toProcess) {
      // Guardrail de tempo: sair se perto do limite
      if (Date.now() - t0 > MAX_DURATION_MS) {
        console.warn(`[runDecisionSlot] Tempo limite atingido após ${results.length} decisões`);
        break;
      }

      try {
        // Delegar para executeAutopilotDecisionV2 (processa 1 decisão por vez)
        const res = await base44.asServiceRole.functions.invoke('executeAutopilotDecisionV2', {
          decision_ids: [decision.id],
          _service_role: true,
          _window_execution: true, // indica que estamos dentro da janela → executar agora
        });
        const data = res?.data || res || {};
        const ok = data?.executed > 0 || data?.ok;
        results.push({ id: decision.id, ok, action: decision.action });
        if (ok) executed++; else failed++;
      } catch (e: any) {
        console.error(`[runDecisionSlot] erro em ${decision.id}:`, e.message);
        results.push({ id: decision.id, ok: false, error: e.message });
        failed++;
      }

      // Pausa entre chamadas (rate limit Amazon)
      if (toProcess.indexOf(decision) < toProcess.length - 1) {
        await sleep(INTER_DELAY_MS);
      }
    }

    // Log de execução
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'ads_sync',
      trigger_type: 'automatic',
      status: failed === 0 ? 'success' : executed > 0 ? 'success' : 'error',
      execution_date: new Date().toISOString().slice(0, 10),
      started_at: new Date(t0).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - t0,
      records_processed: executed,
      error_message: failed > 0 ? `${failed} decisões falharam` : null,
    }).catch(() => {});

    return Response.json({
      ok: true,
      hour_brt: hourBRT,
      slot_total: toProcess.length,
      executed,
      failed,
      duration_ms: Date.now() - t0,
      results: results.slice(0, 20),
    });

  } catch (error: any) {
    console.error('[runDecisionSlot]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});