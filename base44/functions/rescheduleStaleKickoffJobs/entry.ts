import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

/**
 * rescheduleStaleKickoffJobs
 *
 * 1. Deduplicação: agrupa por (amazon_account_id, asin, keyword) → cancela duplicatas, mantém o mais recente.
 * 2. Reescalonamento: jobs scheduled com scheduled_at < now() - 30min → atualiza para próxima hora cheia.
 * 3. Alerta: se um job foi reescalonado mais de uma vez (segunda falha), cria Alert severity=high.
 */

function nowIso() { return new Date().toISOString(); }
function todayBRT() { return new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10); }

function nextFullHour(): string {
  const ms = Math.ceil((Date.now() + 60000) / 3600000) * 3600000;
  return new Date(ms).toISOString();
}

function nextQueueWindow(): string {
  const d = new Date(nextFullHour());
  return `${String(d.getUTCHours()).padStart(2, '0')}:00`;
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    // Aceitar chamada do orquestrador (service role) ou do usuário autenticado
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const aid: string | undefined = body.amazon_account_id;
    const query: any = { status: 'scheduled' };
    if (aid) query.amazon_account_id = aid;

    // Buscar todos os jobs scheduled
    const allScheduled = await base44.asServiceRole.entities.ProductKickoffQueue.filter(
      query, '-created_date', 500
    ).catch(() => []);

    // ── 1. DEDUPLICAÇÃO ──────────────────────────────────────────────────────
    // Agrupar por (amazon_account_id, asin, keyword) — keyword vazia = 'auto_plus_four'
    const groups = new Map<string, any[]>();
    for (const item of allScheduled) {
      const keyword = String(item.keyword || '').trim().toLowerCase();
      const key = `${item.amazon_account_id}|${String(item.asin || '').trim().toUpperCase()}|${keyword}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(item);
    }

    let duplicatesCancelled = 0;
    const survivorIds = new Set<string>();

    for (const [, group] of groups.entries()) {
      if (group.length <= 1) { if (group[0]) survivorIds.add(group[0].id); continue; }
      // Manter o mais recente (maior created_date ou scheduled_at)
      group.sort((a, b) => {
        const ta = new Date(a.created_date || a.scheduled_at || 0).getTime();
        const tb = new Date(b.created_date || b.scheduled_at || 0).getTime();
        return tb - ta;
      });
      survivorIds.add(group[0].id);
      // Cancelar os demais
      for (let i = 1; i < group.length; i++) {
        await base44.asServiceRole.entities.ProductKickoffQueue.update(group[i].id, {
          status: 'cancelled',
          last_error: 'duplicate_removed',
          completed_at: nowIso(),
        }).catch(() => {});
        duplicatesCancelled++;
      }
    }

    // ── 2. REESCALONAMENTO ──────────────────────────────────────────────────
    const staleThreshold = Date.now() - 30 * 60 * 1000; // 30 min atrás
    const staleJobs = allScheduled.filter(item =>
      survivorIds.has(item.id) &&
      item.scheduled_at &&
      new Date(item.scheduled_at).getTime() < staleThreshold
    );

    let rescheduled = 0;
    const secondFailureAsins: string[] = [];

    for (const item of staleJobs) {
      const rescheduleCount = Number(item.reschedule_count || 0);
      const nextSlot = nextFullHour();
      const nextWindow = nextQueueWindow();

      await base44.asServiceRole.entities.ProductKickoffQueue.update(item.id, {
        scheduled_at: nextSlot,
        queue_window: nextWindow,
        reschedule_count: rescheduleCount + 1,
        last_error: item.last_error || null,
        // Reduz max_attempts para garantir prioridade (processa com tentativa única)
        max_attempts: Math.max(1, Number(item.max_attempts || 5) - rescheduleCount),
      }).catch(() => {});

      rescheduled++;

      // Verificar segunda falha
      if (rescheduleCount >= 1) {
        secondFailureAsins.push(item.asin);
      }
    }

    // ── 3. LOG ──────────────────────────────────────────────────────────────
    if (rescheduled > 0 || duplicatesCancelled > 0) {
      const accountIds = aid
        ? [aid]
        : [...new Set(allScheduled.map((i: any) => i.amazon_account_id).filter(Boolean))];

      for (const accountId of accountIds) {
        await base44.asServiceRole.entities.SyncExecutionLog.create({
          amazon_account_id: accountId,
          operation: 'kickoff_queue_rescheduled',
          trigger_type: 'automatic',
          status: 'success',
          execution_date: todayBRT(),
          started_at: new Date(t0).toISOString(),
          completed_at: nowIso(),
          duration_ms: Date.now() - t0,
          records_processed: rescheduled,
          result_summary: JSON.stringify({
            rescheduled,
            duplicates_cancelled: duplicatesCancelled,
            second_failure_asins: secondFailureAsins,
          }),
        }).catch(() => {});

        // ── 4. ALERTA PARA SEGUNDA FALHA ────────────────────────────────────
        if (secondFailureAsins.length > 0) {
          await base44.asServiceRole.functions.invoke('upsertOperationalAlert', {
            amazon_account_id: accountId,
            alert_type: 'sync_error',
            alert_family: 'campaign',
            severity: 'high',
            title: 'Kick-off travado repetidamente',
            message: `${secondFailureAsins.length} ASIN(s) não foram processados após múltiplos reescalonamentos: ${secondFailureAsins.slice(0, 5).join(', ')}${secondFailureAsins.length > 5 ? ' ...' : ''}`,
            deduplication_key: `kickoff_stuck_${accountId}_${todayBRT()}`,
            _service_role: true,
          }).catch(() => {});
        }
      }
    }

    return Response.json({
      ok: true,
      duplicates_cancelled: duplicatesCancelled,
      rescheduled,
      second_failure_asins: secondFailureAsins,
      next_slot: nextFullHour(),
      duration_ms: Date.now() - t0,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message }, { status: 500 });
  }
});