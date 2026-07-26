import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

/**
 * Cancela somente ações antigas de dayparting ainda pendentes na fila.
 *
 * O motor canônico passou a executar todos os ajustes por bid-base persistido.
 * Manter ações antigas em paralelo faria o app recalcular sobre valores já
 * alterados e poderia disputar com Schedule Bid Rules nativas da Amazon.
 *
 * Nenhum registro é apagado. Ações concluídas, falhas ou já em processamento
 * não são modificadas.
 */
const LEGACY_OPERATIONS = new Set([
  'daypart_bid_increase',
  'daypart_bid_decrease',
  'daypart_bid_restore',
  'keyword_bid_update',
  'keyword_bid_restore',
]);

const CANCELLABLE_STATUSES = new Set(['pending', 'approved', 'scheduled']);

function todayBRT() {
  return new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
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

    const now = new Date().toISOString();
    const rows = await base44.asServiceRole.entities.AmazonActionQueue.filter(
      { amazon_account_id: account.id },
      'scheduled_at',
      2000,
    ).catch(() => []);

    const candidates = rows.filter((row: any) =>
      LEGACY_OPERATIONS.has(String(row.operation || '')) &&
      CANCELLABLE_STATUSES.has(String(row.status || '').toLowerCase()),
    );

    let cancelled = 0;
    const preserved: any[] = [];
    for (const row of candidates) {
      try {
        await base44.asServiceRole.entities.AmazonActionQueue.update(row.id, {
          status: 'cancelled',
          completed_at: now,
          last_error: 'Cancelada pela migração canônica: runCanonicalDaypartingEngine assumiu o controle exclusivo do bid-base e das variações horárias.',
          result: JSON.stringify({
            migrated_to: 'runCanonicalDaypartingEngine',
            previous_operation: row.operation,
            cancelled_at: now,
            historical_record_preserved: true,
          }).slice(0, 1000),
        });
        cancelled++;
      } catch (error: any) {
        preserved.push({ id: row.id, operation: row.operation, error: error?.message || String(error) });
      }
    }

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: account.id,
      operation: 'reconcile_legacy_dayparting_queue',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      status: preserved.length > 0 && cancelled === 0 ? 'error' : preserved.length > 0 ? 'partial' : 'success',
      execution_date: todayBRT(),
      started_at: new Date(startedAt).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      records_processed: cancelled,
      result_summary: JSON.stringify({ found: candidates.length, cancelled, preserved_failures: preserved.length }).slice(0, 1000),
      error_message: preserved.length > 0 ? `${preserved.length} ação(ões) não puderam ser canceladas.` : null,
    }).catch(() => {});

    return Response.json({
      ok: preserved.length === 0 || cancelled > 0,
      found: candidates.length,
      cancelled,
      preserved_failures: preserved,
      policy: 'cancel_pending_legacy_dayparting_without_deleting_history',
      duration_ms: Date.now() - startedAt,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha ao reconciliar fila antiga de dayparting' }, { status: 500 });
  }
});
