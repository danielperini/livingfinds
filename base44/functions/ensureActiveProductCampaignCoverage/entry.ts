import { hasFreshAdsInventory } from '../../shared/stockAdsPolicy.ts';
/**
 * ensureActiveProductCampaignCoverage
 *
 * Reconcilia o catálogo ativo com Amazon Ads:
 * - uma campanha Sponsored Products AUTO por SKU/ASIN ativo e com estoque;
 * - reativa AUTO pausada ou cria a ausente;
 * - elimina AUTO duplicada por ASIN;
 * - promove para MANUAL EXACT somente termos empíricos, convertidos e atribuídos
 *   ao mesmo SKU pelo coletor canônico.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { campaignCoverageEligible } from '../../shared/campaignCoverageEligibility.ts';

function dataOf(response: any): any {
  return response?.data || response || {};
}

Deno.serve(async (req) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    if (body._service_role !== true) {
      const user = await base44.auth.me().catch(() => null);
      if (!user || user.role !== 'admin') return Response.json({ ok: false, error: 'Admin only' }, { status: 403 });
    }

    const dryRun = body.dry_run !== false;
    const fastMode = body.fast_mode === true;
    const maxProducts = Math.min(Math.max(Number(body.max_products || 200), 1), 500);
    const lookbackDays = Math.min(Math.max(Number(body.lookback_days || 65), 1), 65);
    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, undefined, 1)
      : await base44.asServiceRole.entities.AmazonAccount.list('-created_date', 50);
    const connectedAccounts = accounts.filter((a: any) => a.ads_profile_id && (a.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN')));
    if (connectedAccounts.length === 0) {
      return Response.json({ ok: false, error: 'Nenhuma conta Amazon Ads conectada', connected_accounts: 0 }, { status: 409 });
    }
    const accountResults: any[] = [];

    for (const account of connectedAccounts) {
      const accountId = account.id;
      let catalogSync: any = null;
      let offerSync: any = null;
      let stockGuard: any = null;
      let campaignStateSync: any = null;
      if (!dryRun && !fastMode) {
        catalogSync = dataOf(await base44.asServiceRole.functions.invoke('syncProductCatalogV2', {
          _service_role: true, amazon_account_id: accountId,
        }).catch((error: any) => ({ data: { ok: false, error: error?.message } })));
        if (catalogSync?.ok !== false && Number(catalogSync?.inventory_asins || 0) > 0) {
          await base44.asServiceRole.functions.invoke('applyAdsScopeAuthorization', {
            _service_role: true, amazon_account_id: accountId, dry_run: false,
          });
        } else {
          console.warn('[campaignCoverage] SP-API sem inventário novo; cobertura usa apenas o estoque registrado no catálogo.');
        }
        offerSync = dataOf(await base44.asServiceRole.functions.invoke('syncAmazonOfferAvailability', {
          _service_role: true, amazon_account_id: accountId, max_products: Math.min(maxProducts, 25),
        }).catch((error: any) => ({ data: { ok: false, error: error?.message } })));
        stockGuard = dataOf(await base44.asServiceRole.functions.invoke('autoStockCampaignGuard', {
          _service_role: true, amazon_account_id: accountId,
          low_stock_pause_threshold: 0,
        }).catch((error: any) => ({ data: { ok: false, error: error?.message } })));
        // A desduplicacao precisa partir da fotografia remota mais recente;
        // caso contrario uma AUTO criada/alterada fora do app pode escapar do
        // limite de uma campanha por ASIN.
        campaignStateSync = dataOf(await base44.asServiceRole.functions.invoke('syncAdsCampaignStatesV2', {
          _service_role: true, amazon_account_id: accountId,
        }).catch((error: any) => ({ data: { ok: false, error: error?.message } })));
        await base44.asServiceRole.functions.invoke('deduplicateAutoCampaignsByAsin', {
          _service_role: true, amazon_account_id: accountId, dry_run: false,
        });
      }

      const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, '-updated_date', 2000);
      const eligible = products.filter(p => hasFreshAdsInventory(p) && campaignCoverageEligible(p));
      const limitedEligible = eligible.slice(0, maxProducts);
      const seenAsins = new Set<string>();
      const rows: any[] = [];

      for (const product of limitedEligible) {
        const sku = String(product.sku).trim();
        const asin = String(product.asin).trim().toUpperCase();
        if (seenAsins.has(asin)) continue;
        seenAsins.add(asin);

        if (dryRun) {
          const campaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId, asin }, undefined, 100);
          const autos = campaigns.filter((c: any) => {
            const targeting = String(c.targeting_type || '').toUpperCase();
            const name = String(c.name || c.campaign_name || '').toUpperCase();
            const state = String(c.state || c.status || '').toUpperCase();
            return c.archived !== true && state !== 'ARCHIVED' && (targeting === 'AUTO' || name.includes('AUTO'));
          });
          rows.push({ sku, asin, action: autos.length ? (String(autos[0].state || autos[0].status).toUpperCase() === 'ENABLED' ? 'existing_enabled' : 'would_reactivate') : 'would_create', auto_campaigns: autos.length, exact_one_auto_after_reconciliation: autos.length === 1 });
          continue;
        }

        try {
          const created = dataOf(await base44.asServiceRole.functions.invoke('createAutoCampaignForAsin', {
            _service_role: true,
            amazon_account_id: accountId,
            asin,
            sku,
            product_name: product.product_name || product.title || product.name || '',
            launch_at_minimum: true,
          }));
          rows.push({ sku, asin, ok: created.ok !== false, action: created.action_label || (created.already_exists ? 'existing_enabled' : 'created'), campaign_id: created.campaign_id || null, error: created.error || null });
        } catch (error: any) {
          rows.push({ sku, asin, ok: false, action: 'failed', error: String(error?.message || error).slice(0, 500) });
        }
      }

      let repair: any = null;
      let harvest: any = null;
      let profitProtection: any = null;
      let finalAutoReconciliation: any = null;
      if (!dryRun && !fastMode) {
        // Cria/reativa pode ter revelado uma duplicidade remota durante a
        // conciliacao. Executar uma segunda vez, limitada aos ASINs tratados,
        // confirma o teto de exatamente uma AUTO antes dos reparos e harvest.
        finalAutoReconciliation = dataOf(await base44.asServiceRole.functions.invoke('deduplicateAutoCampaignsByAsin', {
          _service_role: true, amazon_account_id: accountId, dry_run: false,
          asins: [...seenAsins],
        }).catch((error: any) => ({ data: { ok: false, error: error?.message } })));
        repair = dataOf(await base44.asServiceRole.functions.invoke('repairIncompleteAutoCampaigns', {
          _service_role: true, amazon_account_id: accountId, asins: limitedEligible.map((p: any) => p.asin),
        }).catch((error: any) => ({ data: { ok: false, error: error?.message } })));
        await base44.asServiceRole.functions.invoke('refreshSameSkuSearchTermReports', {
          _service_role: true, amazon_account_id: accountId, force_new: true, trigger_type: 'active_campaign_coverage',
        }).catch((error: any) => console.warn('[campaignCoverage] report refresh:', error?.message));
        if (body.run_harvest !== false) {
          harvest = dataOf(await base44.asServiceRole.functions.invoke('runImmediateSameSkuSearchTermHarvest', {
            _service_role: true, amazon_account_id: accountId, lookback_days: lookbackDays,
            max_promotions: Number(body.max_promotions || 50), dry_run: false,
            trigger_type: 'active_campaign_coverage',
          }).catch((error: any) => ({ data: { ok: false, error: error?.message } })));
        }
        // Every coverage/recovery cycle must immediately reconnect campaign
        // presence to the configured economic goals. This keeps campaigns
        // enabled while controlling loss through keyword/term bids.
        profitProtection = dataOf(await base44.asServiceRole.functions.invoke('enforceSkuProfitProtection', {
          _service_role: true, amazon_account_id: accountId, dry_run: false,
          trigger_type: 'active_campaign_coverage_goal_alignment',
        }).catch((error: any) => ({ data: { ok: false, error: error?.message } })));
      }

      const stageFailures = Object.entries({
        catalog_sync: catalogSync, offer_sync: offerSync, stock_guard: stockGuard,
        campaign_state_sync: campaignStateSync, repair, harvest,
        profit_protection: profitProtection, final_auto_reconciliation: finalAutoReconciliation,
      }).filter(([, result]) => result?.ok === false)
        .map(([stage, result]) => ({ stage, error: result.error || 'Falha na etapa de cobertura' }));

      accountResults.push({
        amazon_account_id: accountId,
        active_products: limitedEligible.length,
        processed: rows.length,
        created: rows.filter((r: any) => r.action === 'created').length,
        reactivated: rows.filter((r: any) => r.action === 'reactivated').length,
        already_enabled: rows.filter((r: any) => r.action === 'existing_enabled').length,
        failed: rows.filter((r: any) => r.ok === false).length + stageFailures.length,
        stage_failures: stageFailures,
        rows, repair, harvest, profit_protection: profitProtection,
        catalog_sync: catalogSync, offer_sync: offerSync, stock_guard: stockGuard,
        campaign_state_sync: campaignStateSync, final_auto_reconciliation: finalAutoReconciliation,
      });
    }

    const failed = accountResults.reduce((sum, row) => sum + row.failed, 0);
    const processed = accountResults.reduce((sum, row) => sum + Number(row.processed || 0), 0);
    const noRequiredActions = body.require_actions === true && processed === 0;
    return Response.json({
      ok: failed === 0 && !noRequiredActions,
      dry_run: dryRun,
      fast_mode: fastMode,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      connected_accounts: connectedAccounts.length,
      processed,
      failed,
      ...(noRequiredActions ? { error: 'Nenhum SKU com estoque positivo foi elegível para ativação imediata.' } : {}),
      accounts: accountResults,
    }, { status: noRequiredActions ? 409 : failed === 0 ? 200 : 207 });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error), started_at: startedAt }, { status: 500 });
  }
});
