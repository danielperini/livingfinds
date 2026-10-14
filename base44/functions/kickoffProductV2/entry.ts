import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const accountId = String(body.amazon_account_id || '');
    const asin = String(body.asin || '').trim().toUpperCase();
    const sku = String(body.sku || '').trim();
    if (!accountId || !/^B0[A-Z0-9]{8}$/.test(asin)) {
      return Response.json({ ok: false, error: 'Conta e ASIN válido são obrigatórios' }, { status: 400 });
    }

    const products = await base44.asServiceRole.entities.Product.filter({
      amazon_account_id: accountId, asin, ...(sku ? { sku } : {}),
    }, '-updated_date', 100);
    const eligible = products.filter((product: any) => product.status !== 'archived' && product.catalog_sync_status !== 'duplicate');
    if (eligible.length !== 1) {
      return Response.json({ ok: false, blocked: true, error: 'O produto não foi resolvido para um único SKU/ASIN.' }, { status: 409 });
    }

    const product = eligible[0];
    const now = new Date().toISOString();
    // This explicit user action is the only override for a manual campaign
    // pause lock. The request is one-shot and remains pending until Amazon
    // confirms every non-archived campaign for this SKU/ASIN.
    await base44.asServiceRole.entities.Product.update(product.id, {
      manual_kickoff_status: 'pending',
      manual_kickoff_requested_at: now,
      manual_kickoff_completed_at: null,
      manual_kickoff_last_error: null,
      campaign_pause_lock: false,
      campaign_pause_lock_reason: null,
      campaign_pause_locked_at: null,
      campaign_pause_locked_by: user.id || 'authenticated_user',
    });

    const checkResponse = await base44.asServiceRole.functions.invoke('checkInventoryChangesAndKickoff', {
      amazon_account_id: accountId,
      _service_role: true,
      trigger_type: 'explicit_manual_product_kickoff',
    }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
    const check = checkResponse?.data || checkResponse || {};
    const refreshed = await base44.asServiceRole.entities.Product.filter({ id: product.id }, undefined, 1).catch(() => []);
    const latest = refreshed[0] || product;
    const complete = latest.manual_kickoff_status === 'completed';
    const stock = Number(latest.available_quantity ?? latest.fba_inventory ?? 0);

    if (!complete) {
      const error = check?.error || check?.guard?.accounts?.[0]?.errors?.[0]?.error ||
        (stock <= 0 ? 'Sem unidades FBA vendáveis confirmadas; kickoff ficará pendente até haver estoque.' :
          'A Amazon ainda não confirmou a retomada de todas as campanhas; o motor tentará novamente.');
      await base44.asServiceRole.entities.Product.update(product.id, { manual_kickoff_last_error: error }).catch(() => {});
      return Response.json({
        ok: false,
        pending: true,
        asin,
        sku: latest.sku,
        available_fba: stock,
        manual_kickoff_status: latest.manual_kickoff_status || 'pending',
        error,
        inventory_check: check,
        manual_exact_policy: 'use_literal_search_term_after_3_verified_same_sku_orders_and_positive_economics',
      }, { status: 202 });
    }

    return Response.json({
      ok: true,
      asin,
      sku: latest.sku,
      available_fba: stock,
      manual_kickoff_status: 'completed',
      message: 'Kickoff manual confirmado pela Amazon. A campanha AUTO de descoberta é mantida e termos reais elegíveis seguem a regra econômica do motor.',
      campaigns_reactivated: Number(check?.guard?.activated || 0),
      manual_exact_policy: 'literal_search_term_after_3_verified_same_sku_orders_and_positive_economics',
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Erro no Kick-off' }, { status: 500 });
  }
});
