import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function nextSlot() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const p:any = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(p.hour || 0);
  const day = `${p.year}-${p.month}-${p.day}`;
  if (hour < 3) {
    const h = hour + 1;
    return { hour: h, window: `${String(h).padStart(2, '0')}:00-${String(h + 1).padStart(2, '0')}:00`, at: new Date(`${day}T${String(h).padStart(2, '0')}:00:00-03:00`) };
  }
  if (hour < 13) return { hour: 13, window: '13:00-14:00', at: new Date(`${day}T13:00:00-03:00`) };
  const tomorrow = new Date(`${day}T12:00:00-03:00`);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const nextDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(tomorrow);
  return { hour: 0, window: '00:00-01:00', at: new Date(`${nextDay}T00:00:00-03:00`) };
}

function eventProduct(body:any) {
  return body?.data || body?.new_data || body?.newData || body?.record || body?.entity || body?.event?.data || body?.payload?.data || body?.product || null;
}

Deno.serve(async (req) => {
  const startedAt = new Date().toISOString();
  let base44:any = null;
  let product:any = null;
  try {
    base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    product = eventProduct(body);
    const oldData = body?.old_data || body?.oldData || body?.event?.old_data || {};

    if (!product?.id) return Response.json({ ok: true, skipped: true, reason: 'no product data' });

    const freshRows = await base44.asServiceRole.entities.Product.filter({ id: product.id });
    const fresh = freshRows[0] || product;
    const amazonAccountId = fresh.amazon_account_id;
    const asin = String(fresh.asin || '').trim().toUpperCase();
    const status = String(fresh.status || '').toLowerCase();
    const inventoryStatus = String(fresh.inventory_status || '').toLowerCase();
    const fbaInventory = Number(fresh.fba_inventory || 0);

    if (!amazonAccountId || !asin) {
      return Response.json({ ok: true, skipped: true, reason: 'missing amazon_account_id or asin' });
    }

    const isNowActive = status === 'active';
    const hasStock = inventoryStatus !== 'out_of_stock' && fbaInventory > 0;
    if (!isNowActive || !hasStock) {
      return Response.json({ ok: true, skipped: true, reason: 'product not active or no stock', asin });
    }

    const wasAlreadyActive = String(oldData?.status || '').toLowerCase() === 'active';
    const hadStock = String(oldData?.inventory_status || '').toLowerCase() !== 'out_of_stock' && Number(oldData?.fba_inventory || 0) > 0;
    const costJustConfirmed = oldData?.cost_confirmed !== true && fresh.cost_confirmed === true;
    if (wasAlreadyActive && hadStock && !costJustConfirmed && body.force !== true) {
      return Response.json({ ok: true, skipped: true, reason: 'product already active with stock', asin });
    }

    const costConfirmed = fresh.cost_confirmed === true && fresh.cost_confirmation_required !== true;
    await base44.asServiceRole.entities.Product.update(fresh.id, {
      should_activate_campaign: true,
      cost_confirmation_required: !costConfirmed,
      auto_campaign_eligible: costConfirmed,
      keyword_confidence_threshold: 0.95,
      last_sync_at: new Date().toISOString(),
    });

    const suggestionResponse = await base44.asServiceRole.functions.invoke('suggestProductKeywordsWithAI', {
      amazon_account_id: amazonAccountId,
      asin,
      product_id: fresh.id,
      _service_role: true,
    }).catch((error:any) => ({ data: { ok: false, error: error?.message || String(error) } }));
    const suggestionResult = suggestionResponse?.data || suggestionResponse || {};

    let queueCreated = false;
    let highConfidenceCount = 0;
    let queueWindow = null;

    if (costConfirmed) {
      const suggestions = await base44.asServiceRole.entities.KeywordSuggestion.filter({ amazon_account_id: amazonAccountId, asin }, '-confidence', 200).catch(() => []);
      const selected:any[] = [];
      for (const suggestion of suggestions) {
        const confidence = Number(suggestion.confidence || 0);
        const matchType = String(suggestion.match_type || 'exact').toLowerCase();
        const suggestionStatus = String(suggestion.status || 'suggested').toLowerCase();
        if (!suggestion.keyword || confidence < 0.95 || matchType !== 'exact') continue;
        if (['rejected', 'archived', 'blocked'].includes(suggestionStatus)) continue;
        if (selected.some((item) => String(item.keyword).toLowerCase().trim() === String(suggestion.keyword).toLowerCase().trim())) continue;
        selected.push(suggestion);
        if (selected.length >= 4) break;
      }
      highConfidenceCount = selected.length;

      if (selected.length >= 4) {
        const campaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: amazonAccountId, asin }, '-created_date', 50).catch(() => []);
        const hasUsableCampaign = campaigns.some((campaign:any) => !campaign.archived && !['archived', 'ended'].includes(String(campaign.state || campaign.status || '').toLowerCase()));
        if (!hasUsableCampaign) {
          const existingQueue = await base44.asServiceRole.entities.ProductKickoffQueue.filter({
            amazon_account_id: amazonAccountId, asin, mode: 'auto_plus_four', status: 'scheduled',
          }, '-created_date', 1).catch(() => []);
          if (!existingQueue.length) {
            const slot = nextSlot();
            queueWindow = slot.window;
            await base44.asServiceRole.entities.ProductKickoffQueue.create({
              amazon_account_id: amazonAccountId,
              asin,
              sku: fresh.sku || null,
              product_name: fresh.product_name || fresh.display_name || asin,
              mode: 'auto_plus_four',
              status: 'scheduled',
              queue_hour: slot.hour,
              queue_window: slot.window,
              scheduled_at: slot.at.toISOString(),
              attempt_count: 0,
              max_attempts: 5,
            });
            queueCreated = true;
          } else {
            queueWindow = existingQueue[0].queue_window || null;
          }
        }
      }
    }

    await base44.asServiceRole.entities.LearningEvent.create({
      amazon_account_id: amazonAccountId,
      event_type: costConfirmed ? 'product_ready_for_kickoff' : 'product_cost_confirmation_required',
      entity_type: 'product',
      entity_id: fresh.id,
      observation: costConfirmed
        ? `Produto ${asin} ativo com estoque. ${highConfidenceCount} keywords EXACT com confiança mínima de 95%. Fila criada: ${queueCreated}.`
        : `Produto ${asin} ativo com estoque. Confirmação de custo pendente antes de criar campanhas.`,
      recorded_at: new Date().toISOString(),
    }).catch(() => {});

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: amazonAccountId,
      operation: 'on_product_activated',
      status: suggestionResult?.ok === false ? 'error' : 'success',
      trigger_type: 'product_created_or_updated',
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      records_processed: highConfidenceCount,
      result_summary: JSON.stringify({ asin, cost_confirmed: costConfirmed, high_confidence_keywords: highConfidenceCount, queue_created: queueCreated, queue_window: queueWindow, suggestion_result: suggestionResult }).slice(0, 4000),
      error_message: suggestionResult?.ok === false ? String(suggestionResult?.error || 'Falha ao gerar keywords').slice(0, 1000) : null,
    }).catch(() => {});

    return Response.json({
      ok: suggestionResult?.ok !== false,
      asin,
      cost_confirmation_required: !costConfirmed,
      keyword_generation: suggestionResult,
      high_confidence_keywords: highConfidenceCount,
      required_confidence: 0.95,
      kickoff_scheduled: queueCreated,
      queue_window: queueWindow,
      action: !costConfirmed ? 'confirm_costs' : queueCreated ? 'kickoff_scheduled' : 'waiting_for_four_keywords_95',
    });
  } catch (error) {
    if (base44) {
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: product?.amazon_account_id || null,
        operation: 'on_product_activated', status: 'error', trigger_type: 'product_created_or_updated',
        started_at: startedAt, completed_at: new Date().toISOString(), records_processed: 0,
        result_summary: JSON.stringify({ product_id: product?.id || null, asin: product?.asin || null }).slice(0, 4000),
        error_message: String(error?.message || error).slice(0, 1000),
      }).catch(() => {});
    }
    return Response.json({ ok: false, error: error?.message || 'Erro ao processar produto ativado' }, { status: 500 });
  }
});
