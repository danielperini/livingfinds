/**
 * executeApprovedDecisionQueue — Distribuidor rápido de decisões (< 5s, sem timeout)
 *
 * ANTES: Executava todas as decisões em série → 524 timeout (~2min+).
 * AGORA: Apenas distribui slots via updateMany (< 5s). Execução real fica
 *        no runDecisionSlot que roda a cada hora nas janelas 00h-07h + 13h BRT.
 *
 * Slots disponíveis: 0,1,2,3,4,5,6 (madrugada) + 13 (tarde dayparting)
 * Distribuição: hash determinístico do ID → slot uniforme
 * Pausas urgentes (pause_campaign): executadas imediatamente (lote máx 20)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const NIGHT_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const DAY_SLOT = 13;

function currentHourBRT(): number {
  return ((new Date().getUTCHours() - 3) + 24) % 24;
}

function assignSlot(id: string, action: string): number {
  if (action === 'apply_dayparting') return DAY_SLOT;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  return NIGHT_SLOTS[Math.abs(h) % NIGHT_SLOTS.length];
}

function nextOccurrenceUTC(slotBRT: number): string {
  const now = new Date();
  const curBRT = currentHourBRT();
  let ahead = slotBRT - curBRT;
  if (ahead <= 0) ahead += 24;
  const t = new Date(now.getTime() + ahead * 3600000);
  t.setUTCMinutes(5, 0, 0);
  return t.toISOString();
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

    const accountFilter = body.amazon_account_id
      ? { amazon_account_id: body.amazon_account_id, status: 'approved' }
      : { status: 'approved' };

    const approved = await base44.asServiceRole.entities.OptimizationDecision.filter(
      accountFilter, 'created_at', 500
    );

    if (approved.length === 0) {
      return Response.json({ ok: true, distributed: 0, immediate_pauses: 0, duration_ms: Date.now() - t0 });
    }

    const pauses = approved.filter((d: any) =>
      d.action === 'pause_campaign' || d.action === 'pause_keyword'
    );
    const others = approved.filter((d: any) =>
      d.action !== 'pause_campaign' && d.action !== 'pause_keyword'
    );

    // ── Distribuir por slot via updateMany (uma chamada por slot = máx 8 calls) ──
    const slotMap = new Map<number, string[]>();
    for (const d of others) {
      const slot = assignSlot(d.id, d.action);
      if (!slotMap.has(slot)) slotMap.set(slot, []);
      slotMap.get(slot)!.push(d.id);
    }

    const slotCounts: Record<number, number> = {};
    const now = new Date().toISOString();

    // Uma chamada updateMany por slot (muito mais rápido que updates individuais)
    await Promise.all([...slotMap.entries()].map(async ([slot, ids]) => {
      slotCounts[slot] = ids.length;
      const window = slot === DAY_SLOT
        ? '13:00-14:00'
        : `${String(slot).padStart(2,'0')}:00-${String(slot+1).padStart(2,'0')}:00`;
      await base44.asServiceRole.entities.OptimizationDecision.updateMany(
        { id: { $in: ids }, status: 'approved' },
        {
          $set: {
            queue_status: 'scheduled',
            queue_hour: slot,
            queue_window: window,
            queued_at: now,
            scheduled_for: nextOccurrenceUTC(slot),
            execution_channel: slot === DAY_SLOT ? 'amazon_api_dayparting' : 'amazon_api_queue',
          }
        }
      );
    }));

    // ── Pausas urgentes: lote pequeno executado imediatamente ──────────────
    let pauseResult: any = { skipped: pauses.length, reason: 'too_many' };
    if (pauses.length > 0 && pauses.length <= 20) {
      try {
        const res = await base44.asServiceRole.functions.invoke('executePauseDecisionSafe', {
          decision_ids: pauses.map((p: any) => p.id),
          _service_role: true,
        });
        pauseResult = res?.data || res || pauseResult;
      } catch (e: any) {
        pauseResult = { error: e.message };
      }
    } else if (pauses.length > 20) {
      // Distribuir pausas no slot 0
      await base44.asServiceRole.entities.OptimizationDecision.updateMany(
        { id: { $in: pauses.map((p: any) => p.id) }, status: 'approved' },
        { $set: { queue_status: 'scheduled', queue_hour: 0, queue_window: '00:00-01:00', queued_at: now, scheduled_for: nextOccurrenceUTC(0) } }
      );
      pauseResult = { distributed_slot_0: pauses.length };
    }

    // Reconciliação assíncrona (fire-and-forget)
    if (body.amazon_account_id) {
      base44.asServiceRole.functions.invoke('reconcilePendingBidDecisions', {
        amazon_account_id: body.amazon_account_id, _service_role: true,
      }).catch(() => {});
    }

    return Response.json({
      ok: true,
      total_approved: approved.length,
      distributed: others.length,
      immediate_pauses: pauses.length <= 20 ? pauses.length : 0,
      pause_result: pauseResult,
      slot_distribution: slotCounts,
      policy: 'slots 00h-12h BRT + 13h BRT; pausas urgentes imediatas ≤ 20',
      duration_ms: Date.now() - t0,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message }, { status: 500 });
  }
});