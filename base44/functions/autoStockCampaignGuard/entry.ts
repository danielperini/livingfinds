import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' });
    if (!accounts.length) return Response.json({ ok: true, message: 'Nenhuma conta conectada', paused: 0, activated: 0 });

    let totalPaused = 0;
    let totalActivated = 0;
    const log = [];

    for (const account of accounts) {
      // Buscar todos os produtos ativos da conta
      const products = await base44.asServiceRole.entities.Product.filter(
        { amazon_account_id: account.id, status: 'active' },
        null, 500
      );

      for (const product of products) {
        const fba = Number(product.fba_inventory ?? 0);
        const invStatus = String(product.inventory_status || '').toLowerCase();
        const campStatus = String(product.campaign_status || '').toLowerCase();
        const hasCampaign = Boolean(
          product.linked_campaign_id || product.campaign_id || product.has_campaign ||
          ['active', 'enabled', 'paused', 'incomplete'].includes(campStatus)
        );

        if (!hasCampaign) continue;

        const isActive = ['active', 'enabled'].includes(campStatus);
        const isOutOfStock = invStatus === 'out_of_stock' || fba === 0;
        const isPausedByStock = product.pause_reason === 'out_of_stock_confirmed' ||
          String(product.pause_reason || '').includes('stock');

        // Campanha ativa mas sem estoque → pausar
        if (isActive && isOutOfStock) {
          try {
            const payload = { amazon_account_id: account.id };
            if (product.linked_campaign_id) payload.campaign_id = product.linked_campaign_id;
            if (product.asin) payload.asin = product.asin;
            if (product.sku) payload.sku = product.sku;

            const r = await base44.functions.invoke('pauseCampaign', payload);
            if (r?.ok || r?.data?.ok) {
              await base44.asServiceRole.entities.Product.update(product.id, {
                pause_reason: 'out_of_stock_confirmed',
              });
              totalPaused++;
              log.push({ asin: product.asin, action: 'paused', fba });
            }
          } catch (e) {
            log.push({ asin: product.asin, action: 'pause_error', error: e.message });
          }
        }

        // Campanha pausada por estoque mas voltou ao estoque → reativar
        if (!isActive && isPausedByStock && !isOutOfStock && fba > 0) {
          try {
            const campaignId = product.linked_campaign_id || product.campaign_id || null;
            const agentAction = await base44.asServiceRole.entities.AgentAction.create({
              amazon_account_id: account.id,
              action: 'enable_campaign',
              asin: product.asin,
              campaign_id: campaignId,
              reason: 'Reativação automática — estoque reposto (guard)',
              evidence: `FBA: ${fba}`,
              risk_level: 'low',
              requires_approval: false,
            });

            const r = await base44.functions.invoke('executeAgentAction', {
              action_id: agentAction.id,
              approve: true,
            });

            if (r?.ok || r?.data?.ok) {
              await base44.asServiceRole.entities.Product.update(product.id, {
                pause_reason: null,
              });
              totalActivated++;
              log.push({ asin: product.asin, action: 'activated', fba });
            }
          } catch (e) {
            log.push({ asin: product.asin, action: 'activate_error', error: e.message });
          }
        }
      }
    }

    return Response.json({
      ok: true,
      paused: totalPaused,
      activated: totalActivated,
      accounts_checked: accounts.length,
      log,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});