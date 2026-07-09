/**
 * scheduleManualCampaignFromTerm
 * Agenda a criação de uma campanha MANUAL EXACT para um termo do TermBank.
 * A campanha é criada na próxima janela operacional (00h-04h ou 13h-14h BRT)
 * via ProductKickoffQueue + processProductKickoffQueueV2.
 * Bid inicial: R$ 0,50. Após criação, é gerenciada pelo motor do app.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function saoPauloNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { hour: Number(p.hour || 0), day: `${p.year}-${p.month}-${p.day}` };
}

function nextSlot() {
  const { hour, day } = saoPauloNow();
  const windowHours = [0, 1, 2, 3, 13];
  if (windowHours.includes(hour)) {
    return { hour, window: hour === 13 ? '13:00-14:00' : `${String(hour).padStart(2,'0')}:00-${String(hour+1).padStart(2,'0')}:00`, at: new Date(), execute_now: true };
  }
  if (hour < 13) {
    return { hour: 13, window: '13:00-14:00', at: new Date(`${day}T13:00:00-03:00`), execute_now: false };
  }
  const tom = new Date(`${day}T12:00:00-03:00`);
  tom.setDate(tom.getDate() + 1);
  const nextDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(tom);
  return { hour: 0, window: '00:00-01:00', at: new Date(`${nextDay}T00:00:00-03:00`), execute_now: false };
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const user = await base44.auth.me();
    if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const { amazon_account_id, asin, keyword, product_name, sku } = body;

    if (!amazon_account_id || !asin || !String(keyword || '').trim()) {
      return Response.json({ ok: false, error: 'amazon_account_id, asin e keyword são obrigatórios' }, { status: 400 });
    }

    const db = base44.asServiceRole;
    const kw = String(keyword).trim();

    // Verificar se já existe campanha para este ASIN + keyword
    const campaignName = `SP | MANUAL | EXACT | ${asin} | ${kw.replace(/[^a-z0-9\sáéíóúâêôãõç-]/gi, '').trim().slice(0, 40)}`.slice(0, 128);
    const existing = await db.entities.Campaign.filter(
      { amazon_account_id, asin, name: campaignName }, '-created_date', 1
    ).catch(() => []);
    if (existing[0]) {
      return Response.json({ ok: false, already_exists: true, error: `Campanha para "${kw}" já existe: ${existing[0].campaign_id}`, campaign_id: existing[0].campaign_id });
    }

    // Verificar se já está na fila
    const inQueue = await db.entities.ProductKickoffQueue.filter(
      { amazon_account_id, asin, mode: 'manual_only', status: 'scheduled' }, '-created_date', 20
    ).catch(() => []);
    const duplicate = inQueue.find((q: any) => String(q.keyword || '').toLowerCase().trim() === kw.toLowerCase());
    if (duplicate) {
      return Response.json({ ok: false, already_queued: true, error: `Já existe item na fila para "${kw}"`, queue_id: duplicate.id, scheduled_at: duplicate.scheduled_at });
    }

    const slot = nextSlot();

    // Criar item na fila
    const queueItem = await db.entities.ProductKickoffQueue.create({
      amazon_account_id,
      asin,
      sku: sku || null,
      product_name: product_name || asin,
      mode: 'manual_only',
      keyword: kw,
      status: 'scheduled',
      queue_hour: slot.hour,
      queue_window: slot.window,
      scheduled_at: slot.at.toISOString(),
      attempt_count: 0,
      max_attempts: 5,
    });

    // Se estiver dentro da janela, tenta executar imediatamente
    let executed = false;
    let executionError = null;
    if (slot.execute_now) {
      try {
        const res = await db.functions.invoke('createManualCampaignV2', {
          amazon_account_id,
          asin,
          sku: sku || null,
          keyword: kw,
          bid: 0.50,
          budget: 5,
          _service_role: true,
        });
        const d = res?.data || res || {};
        if (d?.ok) {
          executed = true;
          await db.entities.ProductKickoffQueue.update(queueItem.id, {
            status: 'completed',
            completed_at: new Date().toISOString(),
          }).catch(() => {});
        } else {
          executionError = d?.error || 'Falha ao criar campanha';
        }
      } catch (e: any) {
        executionError = e.message;
      }
    }

    return Response.json({
      ok: true,
      queued: !executed,
      executed,
      execution_error: executionError,
      queue_id: queueItem?.id || null,
      queue_window: slot.window,
      scheduled_at: slot.at.toISOString(),
      message: executed
        ? `✓ Campanha criada agora para "${kw}" com bid R$ 0,50.`
        : `Campanha agendada para "${kw}" — próxima janela: ${slot.window}.`,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Erro interno' }, { status: 500 });
  }
});