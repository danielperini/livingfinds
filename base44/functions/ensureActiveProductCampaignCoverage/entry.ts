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

// Snapshot confirmado pelo usuário em 2026-08-01. Serve apenas como fallback
// temporário quando a SP-API de inventário não devolve nenhum item.
const CONFIRMED_ACTIVE_UNTIL = Date.parse('2026-08-09T02:59:59Z');
const CONFIRMED_ACTIVE_SKUS = new Set([
  'W9-OL7U-LRW5', 'FBA-0087c', 'FBA-0076C', 'FBA-0010', 'FBA-0100',
  'SKU-002314A', 'SKU-002314V', 'FBA-0076A', 'FBA-0008V', 'FBA-0008P',
  'FBA-0087b', 'FBA-0088a', 'FBA-0010b', 'FBA-0071', 'FBA-0065PR',
  'FBA-0024b', '70-FCMB-TFYO',
]);

function activeProduct(product: any): boolean {
  const sku = String(product?.sku || '').trim();
  const asin = String(product?.asin || '').trim().toUpperCase();
  const status = String(product?.status || product?.offer_status || '').trim().toLowerCase();
  const available = Number(product?.available_quantity ?? product?.fba_inventory ?? 0);
  const confirmedFallback = Date.now() <= CONFIRMED_ACTIVE_UNTIL && CONFIRMED_ACTIVE_SKUS.has(sku);
  return !!sku && /^B0[A-Z0-9]{8}$/.test(asin) && (available > 0 || confirmedFallback)
    && (confirmedFallback || !['inactive', 'archived', 'deleted', 'closed'].includes(status))
    && product?.listing_suppressed !== true
    && product?.offer_active !== false
    && product?.listing_buyable !== false;
}

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
    const maxProducts = Math.min(Math.max(Number(body.max_products || 200), 1), 500);
    const lookbackDays = Math.min(Math.max(Number(body.lookback_days || 65), 1), 65);
    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.list('-created_date', 50);
    const connectedAccounts = accounts.filter((a: any) => a.ads_profile_id && (a.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN')));
    if (connectedAccounts.length === 0) {
      return Response.json({ ok: false, error: 'Nenhuma conta Amazon Ads conectada', connected_accounts: 0 }, { status: 409 });
    }
    const accountResults: any[] = [];

    for (const account of connectedAccounts) {
      const accountId = account.id;
      let catalogSync: any = null;
      if (!dryRun) {
        catalogSync = dataOf(await base44.asServiceRole.functions.invoke('syncProductCatalogV2', {
          _service_role: true, amazon_account_id: accountId,
        }).catch((error: any) => ({ data: { ok: false, error: error?.message } })));
        if (catalogSync?.ok !== false && Number(catalogSync?.inventory_asins || 0) > 0) {
          await base44.asServiceRole.functions.invoke('applyAdsScopeAuthorization', {
            _service_role: true, amazon_account_id: accountId, dry_run: false,
          });
        } else {
          console.warn('[campaignCoverage] SP-API sem inventário confiável; usando snapshot ativo temporário sem pausar campanhas.');
        }
        await base44.asServiceRole.functions.invoke('deduplicateAutoCampaignsByAsin', {
          _service_role: true, amazon_account_id: accountId, dry_run: false,
        });
      }

      const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, '-updated_date', 2000);
      const eligible = products.filter(activeProduct).slice(0, maxProducts);
      const seen = new Set<string>();
      const rows: any[] = [];

      for (const product of eligible) {
        const sku = String(product.sku).trim();
        const asin = String(product.asin).trim().toUpperCase();
        const key = `${sku}|${asin}`;
        if (seen.has(key)) continue;
        seen.add(key);

        if (dryRun) {
          const campaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId, asin }, null, 100);
          const autos = campaigns.filter((c: any) => {
            const targeting = String(c.targeting_type || '').toUpperCase();
            const name = String(c.name || c.campaign_name || '').toUpperCase();
            const state = String(c.state || c.status || '').toUpperCase();
            return c.archived !== true && state !== 'ARCHIVED' && (targeting === 'AUTO' || name.includes('AUTO'));
          });
          rows.push({ sku, asin, action: autos.length ? (String(autos[0].state || autos[0].status).toUpperCase() === 'ENABLED' ? 'existing_enabled' : 'would_reactivate') : 'would_create', auto_campaigns: autos.length });
          continue;
        }

        try {
          const created = dataOf(await base44.asServiceRole.functions.invoke('createAutoCampaignForAsin', {
            _service_role: true,
            amazon_account_id: accountId,
            asin,
            sku,
            product_name: product.product_name || product.title || product.name || '',
          }));
          rows.push({ sku, asin, ok: created.ok !== false, action: created.action_label || (created.already_exists ? 'existing_enabled' : 'created'), campaign_id: created.campaign_id || null, error: created.error || null });
        } catch (error: any) {
          rows.push({ sku, asin, ok: false, action: 'failed', error: String(error?.message || error).slice(0, 500) });
        }
      }

      let repair: any = null;
      let harvest: any = null;
      if (!dryRun) {
        repair = dataOf(await base44.asServiceRole.functions.invoke('repairIncompleteAutoCampaigns', {
          _service_role: true, amazon_account_id: accountId, asins: eligible.map((p: any) => p.asin),
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
      }

      accountResults.push({
        amazon_account_id: accountId,
        active_products: eligible.length,
        processed: rows.length,
        created: rows.filter((r: any) => r.action === 'created').length,
        reactivated: rows.filter((r: any) => r.action === 'reactivated').length,
        already_enabled: rows.filter((r: any) => r.action === 'existing_enabled').length,
        failed: rows.filter((r: any) => r.ok === false).length,
        rows, repair, harvest, catalog_sync: catalogSync,
      });
    }

    const failed = accountResults.reduce((sum, row) => sum + row.failed, 0);
    return Response.json({
      ok: failed === 0,
      dry_run: dryRun,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      connected_accounts: connectedAccounts.length,
      failed,
      accounts: accountResults,
    }, { status: failed === 0 ? 200 : 207 });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error), started_at: startedAt }, { status: 500 });
  }
});
