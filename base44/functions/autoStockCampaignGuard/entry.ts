import { campaignStateConfirmed, isStockCampaignPause } from '../../shared/inventorySyncPolicy.ts';
// autoStockCampaignGuard
// 1. Sincroniza o estado REAL de cada campanha direto na Amazon API
// 2. Pausa campanhas ativas de produtos sem estoque
// 3. Reativa campanhas pausadas por estoque de produtos que foram reabastecidos
// 4. Desbloqueia registros presos (pause_reason setado mas campanha já ativa na Amazon)
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import {
  campaignMatchesProduct,
  isProductCampaignPauseLocked,
  manualPauseLockPatch,
  productOfferEligibility,
} from '../../shared/productCampaignPauseGuard.ts';
import { availableAdsStock, stockAdsDecision, hasFreshAdsInventory } from '../../shared/stockAdsPolicy.ts';
import { manualKickoffCanComplete, shouldReactivateForManualKickoff } from '../../shared/manualKickoffReactivationPolicy.ts';
import { deduplicateActiveAlerts, getAlertAsin, getAlertSku, planOperationalAlertCleanup } from '../../shared/operationalAlertCleanup.js';

function adsBase(region) {
  const r = String(region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function getAdsToken(base44: any, account: any): Promise<string> {
  const res = await base44.asServiceRole.functions.invoke('amazonAdsTokenManager', {
    amazon_account_id: account.id,
    _service_role: true,
  });
  const data = res?.data || res;
  if (!data?.ok || !data?.access_token) {
    throw new Error(data?.message || data?.error || 'Falha ao obter access token via tokenManager');
  }
  return String(data.access_token);
}

// Busca todas as campanhas da Amazon em um determinado estado e retorna Map<campaignId, state>
async function fetchCampaignStates(token, profileId, region) {
  const base = adsBase(region);
  const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
  const stateMap = new Map(); // campaignId → 'enabled' | 'paused' | 'archived'

  for (const stateFilter of ['ENABLED', 'PAUSED']) {
    let nextToken = null;
    do {
      const body = { stateFilter: { include: [stateFilter] }, maxResults: 500 };
      if (nextToken) body.nextToken = nextToken;
      const res = await fetch(`${base}/sp/campaigns/list`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Amazon-Advertising-API-ClientId': clientId,
          'Amazon-Advertising-API-Scope': String(profileId),
          'Content-Type': 'application/vnd.spCampaign.v3+json',
          'Accept': 'application/vnd.spCampaign.v3+json',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Amazon list ${stateFilter} HTTP ${res.status}`);
      const payload = await res.json().catch(() => ({}));
      for (const c of (payload.campaigns || [])) {
        stateMap.set(String(c.campaignId), stateFilter.toLowerCase());
      }
      nextToken = payload.nextToken || null;
      if (nextToken) await new Promise(r => setTimeout(r, 100));
    } while (nextToken);
  }
  return stateMap;
}

// Envia comando de PAUSE ou ENABLE para a Amazon
async function sendCampaignStateChange(token, profileId, region, campaignId, targetState) {
  const base = adsBase(region);
  const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
  const body = { campaigns: [{ campaignId: String(campaignId), state: targetState.toUpperCase() }] };
  const res = await fetch(`${base}/sp/campaigns`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': clientId,
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': 'application/vnd.spCampaign.v3+json',
      'Accept': 'application/vnd.spCampaign.v3+json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  const success = campaignStateConfirmed(res.status, data, String(campaignId));
  return { ok: success, status: res.status, body: data };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    // Suporta tanto chamada autenticada (automação) quanto service role
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    const db = base44.asServiceRole;

    const accounts = body.amazon_account_id
      ? await db.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await db.entities.AmazonAccount.filter({ status: 'connected' });
    if (!accounts.length) return Response.json({ ok: true, message: 'Nenhuma conta conectada' });

    const results = [];

    for (const account of accounts) {
      const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
      const region = account.region || 'NA';
      const accountLog = { account_id: account.id, paused: 0, paused_one_unit: 0, paused_not_buyable: 0, activated: 0, synced: 0, unlocked: 0, alerts_resolved: 0, duplicate_alerts_resolved: 0, errors: [] };

      let token = null;
      try {
        token = await getAdsToken(base44, account);
      } catch (e) {
        accountLog.errors.push({ step: 'token', error: e.message });
        results.push(accountLog);
        continue;
      }

      // 1. Buscar estado real de cada campanha na Amazon
      const amazonStates = await fetchCampaignStates(token, profileId, region);
      console.log(`[guard] account=${account.id} amazon campaigns found=${amazonStates.size}`);

      // 2. Atualizar state local de todas as campanhas conforme Amazon
      const [localCampaignRows, productAds] = await Promise.all([
        db.entities.Campaign.filter({ amazon_account_id: account.id }, null, 2000).catch(() => []),
        db.entities.ProductAd.filter({ amazon_account_id: account.id }, '-synced_at', 5000).catch(() => []),
      ]);
      const productAdSkusByCampaign = new Map<string, Set<string>>();
      for (const ad of productAds) {
        const campaignId = String(ad.campaign_id || '').trim();
        const sku = String(ad.sku || '').trim().toUpperCase();
        if (!campaignId || !sku) continue;
        const skus = productAdSkusByCampaign.get(campaignId) || new Set<string>();
        skus.add(sku);
        productAdSkusByCampaign.set(campaignId, skus);
      }
      const localCampaigns = localCampaignRows.map((campaign: any) => {
        const id = String(campaign.amazon_campaign_id || campaign.campaign_id || '');
        const adSkus = productAdSkusByCampaign.get(id) || new Set<string>();
        if (adSkus.size > 1) return { ...campaign, sku: null, sku_identity_status: 'ambiguous' };
        if (adSkus.size === 1) return { ...campaign, sku: [...adSkus][0], sku_identity_status: 'verified_product_ad' };
        return campaign;
      });
      const syncUpdates = [];
      for (const c of localCampaigns) {
        const amazonId = c.amazon_campaign_id || c.campaign_id;
        if (!amazonId) continue;
        const realState = amazonStates.get(String(amazonId));
        if (!realState) continue;
        if (c.state !== realState || c.status !== realState) {
          syncUpdates.push({ id: c.id, state: realState, status: realState, amazon_status: realState, is_operational: realState === 'enabled', synced_at: new Date().toISOString() });
        }
      }
      // Bulk update em lotes
      for (let i = 0; i < syncUpdates.length; i += 100) {
        await db.entities.Campaign.bulkUpdate(syncUpdates.slice(i, i + 100)).catch(() => {});
      }
      accountLog.synced = syncUpdates.length;

      // 3. Buscar produtos ativos com campanha
      const products = await db.entities.Product.filter({ amazon_account_id: account.id }, null, 2000).catch(() => []);

      for (const product of products) {
        if (product.status === 'archived') continue;
        if (product.ads_scope_status !== 'authorized' && products.some(p =>
          p.asin === product.asin && p.status !== 'archived' && p.ads_scope_status === 'authorized')) continue;
        const fba = availableAdsStock(product);
        const invStatus = String(product.inventory_status || '').toLowerCase();
        const campStatus = String(product.campaign_status || '').toLowerCase();
        const pauseReason = String(product.pause_reason || '');
        const amazonId = product.linked_campaign_id || product.campaign_id || null;

        const hasCampaign = Boolean(localCampaigns.some(c => campaignMatchesProduct(c, product)) || amazonId || product.has_campaign || ['active', 'enabled', 'paused'].includes(campStatus));
        if (!hasCampaign) continue;

        // REGRA SOBERANA: produto pausado manualmente permanece pausado.
        // Também migra pausas legadas (sem pause_reason de estoque) para a trava explícita.
        if (isProductCampaignPauseLocked(product)) {
          const lockedCampaigns = localCampaigns.filter(c => campaignMatchesProduct(c, product));
          const now = new Date().toISOString();
          for (const lc of lockedCampaigns) {
            const aid = lc.amazon_campaign_id || lc.campaign_id;
            if (!aid || String(lc.state || '').toLowerCase() === 'archived') continue;
            const realState = amazonStates.get(String(aid));
            if (!realState) continue;
            try {
              if (realState === 'enabled') {
                const pauseResult = await sendCampaignStateChange(token, profileId, region, aid, 'PAUSED');
                if (!pauseResult.ok) throw new Error(`Amazon HTTP ${pauseResult.status}`);
                accountLog.paused++;
              }
              await db.entities.Campaign.update(lc.id, {
                state: 'paused',
                status: 'paused',
                amazon_status: 'paused',
                is_operational: false,
                last_pause_reason: 'USER_MANUAL_PRODUCT_LOCK',
                synced_at: now,
              });
            } catch (e) {
              accountLog.errors.push({ asin: product.asin, sku: product.sku, campaign_id: aid, step: 'enforce_manual_pause', error: e.message });
            }
          }
          await db.entities.Product.update(product.id, {
            ...manualPauseLockPatch(now, product.campaign_pause_locked_by || 'pause_guard_migration'),
            has_campaign: true,
          }).catch(() => {});
          continue;
        }

        // Estoque FBA não é confirmação de que a oferta está comprável. A
        // sincronização SP-API grava esses sinais antes deste guard; qualquer
        // indisponibilidade explícita interrompe toda a publicidade do SKU.
        const offer = productOfferEligibility(product);
        if (!offer.eligible) {
          const linkedCampaigns = localCampaigns.filter(c => campaignMatchesProduct(c, product));
          const now = new Date().toISOString();
          for (const lc of linkedCampaigns) {
            const aid = lc.amazon_campaign_id || lc.campaign_id;
            if (!aid || String(lc.state || lc.status || '').toLowerCase() === 'archived') continue;
            const realState = amazonStates.get(String(aid));
            if (!realState) continue;
            try {
              if (realState === 'enabled') {
                const pauseResult = await sendCampaignStateChange(token, profileId, region, aid, 'PAUSED');
                if (!pauseResult.ok) throw new Error(`Amazon HTTP ${pauseResult.status}`);
                accountLog.paused++;
                accountLog.paused_not_buyable++;
              }
              await db.entities.Campaign.update(lc.id, {
                state: 'paused', status: 'paused', amazon_status: 'paused', is_operational: false,
                last_pause_reason: offer.reason, synced_at: now,
              });
            } catch (e) {
              accountLog.errors.push({ asin: product.asin, sku: product.sku, campaign_id: aid, step: 'enforce_offer_availability', error: e.message });
            }
          }
          await db.entities.Product.update(product.id, {
            campaign_status: 'paused',
            pause_reason: String(offer.reason || 'LISTING_NOT_BUYABLE').toLowerCase(),
            ads_pause_reason: offer.reason,
            ads_paused_at: now,
            ads_resume_pending: false,
            should_activate_campaign: false,
          }).catch(() => {});
          continue;
        }

        const isOneUnit = fba === 1;
        const stockDecision = stockAdsDecision(product);
        if (stockDecision === 'unknown') continue;
        const isOutOfStock = stockDecision === 'pause';
        const isPausedByStock = pauseReason === 'out_of_stock_confirmed' || pauseReason.includes('stock');

        // Um SKU pode ter AUTO e MANUAL. A decisao de estoque deve considerar
        // todas as campanhas vinculadas, nao apenas o campaign_id salvo no produto.
        const linkedCampaigns = localCampaigns.filter(c => campaignMatchesProduct(c, product));
        const linkedStates = linkedCampaigns.map(c => {
          const id = c.amazon_campaign_id || c.campaign_id;
          return String(amazonStates.get(String(id)) || '').toLowerCase();
        });
        const isReallyActive = linkedStates.includes('enabled');
        const isReallyPaused = linkedStates.length > 0
          ? linkedStates.every(state => state === 'paused' || state === 'archived')
          : campStatus === 'paused';

        // CASO A: sem estoque mas campanha ativa na Amazon → pausar
        // Respeitar ads_protected: só pausar se realmente sem estoque (fba=0)
        const linkedProtected = await db.entities.Campaign.filter({ amazon_account_id: account.id, campaign_id: amazonId }, null, 1)
          .then((r: any[]) => r[0]?.ads_protected === true).catch(() => false);
        if (linkedProtected && fba > 0) continue;
        if (isOutOfStock && isReallyActive) {
          try {
            for (const lc of linkedCampaigns) {
              const aid = lc.amazon_campaign_id || lc.campaign_id;
              if (!aid) continue;
              if (!aid || amazonStates.get(String(aid)) !== 'enabled') continue;
              const change = await sendCampaignStateChange(token, profileId, region, aid, 'PAUSED');
              if (!change.ok) throw new Error(`Amazon did not confirm campaign ${aid}`);
              await db.entities.Campaign.update(lc.id, { state: 'paused', status: 'paused', amazon_status: 'paused', is_operational: false, last_pause_reason: 'out_of_stock_confirmed' });
            }
            const stockReason = isOneUnit ? 'low_stock_one_unit' : 'out_of_stock_confirmed';
            await db.entities.Product.update(product.id, {
              campaign_status: 'paused', pause_reason: stockReason,
              ads_pause_reason: stockReason.toUpperCase(), ads_paused_at: new Date().toISOString(),
              ads_resume_pending: true, should_activate_campaign: false,
            });
            accountLog.paused++;
            if (isOneUnit) accountLog.paused_one_unit++;
            console.log(`[guard] PAUSED asin=${product.asin} fba=${fba}`);
          } catch (e) {
            accountLog.errors.push({ asin: product.asin, sku: product.sku, step: 'pause', error: e.message });
          }
        }

        // CASO B: tem estoque, pause_reason=stock, mas campanha pausada → reativar
        const manualKickoffRequested = product.manual_kickoff_status === 'pending';
        if (offer.eligible && !isOutOfStock && fba > 0 && hasFreshAdsInventory(product) && (
          manualKickoffRequested || linkedCampaigns.some(c => isStockCampaignPause(c) || (product.pause_reason === 'offer_recovered' && ['USER_MANUAL_PRODUCT_LOCK', 'OFFER_INACTIVE', 'LISTING_NOT_BUYABLE'].includes(c.last_pause_reason)))
        )) {
          try {
            let resumed = 0;
            for (const lc of linkedCampaigns) {
              const aid = lc.amazon_campaign_id || lc.campaign_id;
              const remoteState = aid ? amazonStates.get(String(aid)) : undefined;
              const manualKickoffResume = manualKickoffRequested && shouldReactivateForManualKickoff(product, lc, remoteState);
              const stockResume = isStockCampaignPause(lc) || (product.pause_reason === 'offer_recovered' && ['USER_MANUAL_PRODUCT_LOCK', 'OFFER_INACTIVE', 'LISTING_NOT_BUYABLE'].includes(lc.last_pause_reason));
              if (!(manualKickoffResume || (!manualKickoffRequested && stockResume && aid && remoteState === 'paused')) || !aid) continue;
              const change = await sendCampaignStateChange(token, profileId, region, aid, 'ENABLED');
              if (!change.ok) throw new Error(`Amazon did not confirm campaign ${aid}`);
              amazonStates.set(String(aid), 'enabled');
              await db.entities.Campaign.update(lc.id, { state: 'enabled', status: 'enabled', amazon_status: 'enabled', is_operational: true, last_pause_reason: null });
              resumed++;
            }
            const kickoffComplete = manualKickoffRequested && manualKickoffCanComplete(product, linkedCampaigns, amazonStates);
            if (manualKickoffRequested && kickoffComplete) {
              await db.entities.Product.update(product.id, {
                manual_kickoff_status: 'completed',
                manual_kickoff_completed_at: new Date().toISOString(),
                manual_kickoff_last_error: null,
                campaign_status: 'active', pause_reason: null,
              });
            } else if (resumed > 0) {
              await db.entities.Product.update(product.id, { campaign_status: 'active', pause_reason: null });
            } else if (!manualKickoffRequested) {
              continue;
            }
            accountLog.activated += resumed;
            if (resumed || kickoffComplete) console.log(`[guard] ACTIVATED asin=${product.asin} fba=${fba} campaigns=${resumed} manual_kickoff=${manualKickoffRequested}`);
            if (manualKickoffRequested && !kickoffComplete) {
              // Pending work is not a failed stock guard. Keep the request on
              // the product for the next run; only an actual API exception
              // above should block account-level decisions.
              await db.entities.Product.update(product.id, {
                manual_kickoff_status: 'pending',
                manual_kickoff_last_error: null,
                manual_kickoff_last_checked_at: new Date().toISOString(),
              }).catch(() => {});
            }
          } catch (e) {
            accountLog.errors.push({ asin: product.asin, sku: product.sku, step: 'activate', error: e.message });
          }
        }

        // CASO C: tem estoque, pause_reason=stock, mas campanha já está ativa na Amazon → desbloquear registro local
        if (offer.eligible && !isOutOfStock && fba > 0 && isPausedByStock && isReallyActive) {
          try {
            await db.entities.Product.update(product.id, { campaign_status: 'active', pause_reason: null });
            accountLog.unlocked++;
            console.log(`[guard] UNLOCKED (already active) asin=${product.asin} fba=${fba}`);
          } catch (e) {
            accountLog.errors.push({ asin: product.asin, sku: product.sku, step: 'unlock', error: e.message });
          }
        }
      }

      // Keep the active-alert list actionable. Event notices are history, not
      // incidents; stock alerts are resolved only with fresh FBA data and a
      // confirmed Amazon pause (or confirmed replenishment). Failed/unknown
      // remote states remain visible for retry and diagnosis.
      const latestProductBySku = new Map<string, any>();
      const productsByAsinForAlerts = new Map<string, any[]>();
      for (const product of products) {
        const asin = String(product.asin || '').trim().toUpperCase();
        const sku = String(product.sku || '').trim().toUpperCase();
        if (!asin) continue;
        productsByAsinForAlerts.set(asin, [...(productsByAsinForAlerts.get(asin) || []), product]);
        if (!sku) continue;
        const current = latestProductBySku.get(sku);
        const updated = Date.parse(product.last_catalog_sync_at || product.updated_at || product.updated_date || 0) || 0;
        const currentUpdated = Date.parse(current?.last_catalog_sync_at || current?.updated_at || current?.updated_date || 0) || 0;
        if (!current || updated > currentUpdated) latestProductBySku.set(sku, product);
      }
      const activeAlerts: any[] = [];
      for (const status of ['active', 'acknowledged']) {
        const rows = await db.entities.Alert.filter({ amazon_account_id: account.id, status }, '-created_at', 1000).catch(() => []);
        activeAlerts.push(...rows);
      }
      const canonicalAlertIds = new Set(deduplicateActiveAlerts(activeAlerts).map(alert => alert.id));
      for (const alert of activeAlerts) {
        if (!canonicalAlertIds.has(alert.id)) {
          await db.entities.Alert.update(alert.id, {
            status: 'resolved', resolved_at: new Date().toISOString(),
            resolution_reason: 'duplicate_consolidated', updated_at: new Date().toISOString(),
          }).catch(() => {});
          accountLog.duplicate_alerts_resolved++;
          continue;
        }

        const asin = getAlertAsin(alert);
        const sku = getAlertSku(alert);
        const asinProducts = productsByAsinForAlerts.get(asin) || [];
        const product = sku
          ? latestProductBySku.get(sku)
          : asinProducts.length === 1 ? asinProducts[0] : null;
        const alertCampaignId = String(alert.campaign_id || alert.entity_id || '');
        const isCampaignPauseNotice = String(alert.alert_type || alert.type || '').toLowerCase() === 'campaign_paused';
        const linkedCampaigns = isCampaignPauseNotice
          ? localCampaigns.filter(c => [c.id, c.amazon_campaign_id, c.campaign_id].some(id => String(id || '') === alertCampaignId))
          : product ? localCampaigns.filter(c => campaignMatchesProduct(c, product)) : [];
        const linkedCampaignStates = linkedCampaigns.map(c => {
          const id = c.amazon_campaign_id || c.campaign_id;
          return id ? amazonStates.get(String(id)) : undefined;
        });
        const freshInventory = !!product && hasFreshAdsInventory(product);
        const cleanup = planOperationalAlertCleanup(alert, {
          product,
          availableFbaQuantity: freshInventory ? availableAdsStock(product) : undefined,
          linkedCampaignStates,
        });
        if (!cleanup.resolve) continue;
        const now = new Date().toISOString();
        await db.entities.Alert.update(alert.id, {
          status: 'resolved', resolved_at: now, resolution_reason: cleanup.reason, updated_at: now,
        }).catch(() => {});
        accountLog.alerts_resolved++;
      }

      results.push(accountLog);
    }

    const totals = results.reduce((acc, r) => ({
      paused: acc.paused + r.paused,
      paused_one_unit: acc.paused_one_unit + r.paused_one_unit,
      activated: acc.activated + r.activated,
      synced: acc.synced + r.synced,
      unlocked: acc.unlocked + r.unlocked,
      alerts_resolved: acc.alerts_resolved + r.alerts_resolved,
      duplicate_alerts_resolved: acc.duplicate_alerts_resolved + r.duplicate_alerts_resolved,
    }), { paused: 0, paused_one_unit: 0, activated: 0, synced: 0, unlocked: 0, alerts_resolved: 0, duplicate_alerts_resolved: 0 });

    return Response.json({ ok: results.every(r => r.errors.length === 0), ...totals, accounts: results });
  } catch (error) {
    console.error('[guard] erro crítico:', error?.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});
