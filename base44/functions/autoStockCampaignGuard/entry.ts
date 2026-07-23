// autoStockCampaignGuard
// 1. Sincroniza o estado REAL de cada campanha direto na Amazon API
// 2. Pausa campanhas ativas de produtos sem estoque
// 3. Reativa campanhas pausadas por estoque de produtos que foram reabastecidos
// 4. Desbloqueia registros presos (pause_reason setado mas campanha já ativa na Amazon)
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

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
      if (!res.ok) { console.warn(`[guard] Amazon list ${stateFilter} HTTP ${res.status}`); break; }
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
  const success = res.ok || (data.campaigns?.[0]?.code === 'SUCCESS');
  return { ok: success, status: res.status, body: data };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    // Suporta tanto chamada autenticada (automação) quanto service role
    let user = null;
    try { user = await base44.auth.me(); } catch {}
    const db = base44.asServiceRole;

    const accounts = await db.entities.AmazonAccount.filter({ status: 'connected' });
    if (!accounts.length) return Response.json({ ok: true, message: 'Nenhuma conta conectada' });

    const results = [];

    for (const account of accounts) {
      const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
      const region = account.region || 'NA';
      const accountLog = { account_id: account.id, paused: 0, activated: 0, synced: 0, unlocked: 0, errors: [] };

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
      const localCampaigns = await db.entities.Campaign.filter({ amazon_account_id: account.id }, null, 2000).catch(() => []);
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
      const products = await db.entities.Product.filter({ amazon_account_id: account.id, status: 'active' }, null, 500).catch(() => []);

      for (const product of products) {
        const fba = Number(product.fba_inventory ?? 0);
        const invStatus = String(product.inventory_status || '').toLowerCase();
        const campStatus = String(product.campaign_status || '').toLowerCase();
        const pauseReason = String(product.pause_reason || '');
        const amazonId = product.linked_campaign_id || product.campaign_id || null;

        const hasCampaign = Boolean(amazonId || product.has_campaign || ['active', 'enabled', 'paused'].includes(campStatus));
        if (!hasCampaign) continue;

        const isOutOfStock = invStatus === 'out_of_stock' || fba === 0;
        const isPausedByStock = pauseReason === 'out_of_stock_confirmed' || pauseReason.includes('stock');

        // Buscar estado real da campanha vinculada
        let realState = campStatus; // fallback
        if (amazonId) {
          // Tentar pegar o amazon_campaign_id real da entidade Campaign
          const campaigns = await db.entities.Campaign.filter({ amazon_account_id: account.id, campaign_id: amazonId }, null, 1).catch(() => []);
          const altCampaigns = campaigns.length ? campaigns : await db.entities.Campaign.filter({ amazon_account_id: account.id, amazon_campaign_id: amazonId }, null, 1).catch(() => []);
          const linkedCampaign = altCampaigns[0];
          if (linkedCampaign) {
            const realAmazonId = linkedCampaign.amazon_campaign_id || linkedCampaign.campaign_id;
            realState = amazonStates.get(String(realAmazonId)) || linkedCampaign.state || campStatus;
          }
        }

        const isReallyActive = realState === 'enabled';
        const isReallyPaused = realState === 'paused';

        // CASO A: sem estoque mas campanha ativa na Amazon → pausar
        // Respeitar ads_protected: só pausar se realmente sem estoque (fba=0)
        const linkedProtected = await db.entities.Campaign.filter({ amazon_account_id: account.id, campaign_id: amazonId }, null, 1)
          .then((r: any[]) => r[0]?.ads_protected === true).catch(() => false);
        if (linkedProtected && fba > 0) continue; // protegida e tem estoque → pular
        if (isOutOfStock && isReallyActive) {
          try {
            const linkedCampaigns = await db.entities.Campaign.filter({ amazon_account_id: account.id, campaign_id: amazonId }, null, 5).catch(() => []);
            for (const lc of linkedCampaigns) {
              const aid = lc.amazon_campaign_id || lc.campaign_id;
              if (!aid) continue;
              await sendCampaignStateChange(token, profileId, region, aid, 'PAUSED');
              await db.entities.Campaign.update(lc.id, { state: 'paused', status: 'paused', amazon_status: 'paused', is_operational: false });
            }
            await db.entities.Product.update(product.id, { campaign_status: 'paused', pause_reason: 'out_of_stock_confirmed' });
            accountLog.paused++;
            console.log(`[guard] PAUSED asin=${product.asin} fba=${fba}`);
          } catch (e) {
            accountLog.errors.push({ asin: product.asin, step: 'pause', error: e.message });
          }
        }

        // CASO B: tem estoque, pause_reason=stock, mas campanha pausada → reativar
        if (!isOutOfStock && fba > 0 && isPausedByStock && isReallyPaused) {
          try {
            const linkedCampaigns = await db.entities.Campaign.filter({ amazon_account_id: account.id, campaign_id: amazonId }, null, 5).catch(() => []);
            for (const lc of linkedCampaigns) {
              const aid = lc.amazon_campaign_id || lc.campaign_id;
              if (!aid) continue;
              await sendCampaignStateChange(token, profileId, region, aid, 'ENABLED');
              await db.entities.Campaign.update(lc.id, { state: 'enabled', status: 'enabled', amazon_status: 'enabled', is_operational: true });
            }
            await db.entities.Product.update(product.id, { campaign_status: 'active', pause_reason: null });
            accountLog.activated++;
            console.log(`[guard] ACTIVATED asin=${product.asin} fba=${fba}`);
          } catch (e) {
            accountLog.errors.push({ asin: product.asin, step: 'activate', error: e.message });
          }
        }

        // CASO C: tem estoque, pause_reason=stock, mas campanha já está ativa na Amazon → desbloquear registro local
        if (!isOutOfStock && fba > 0 && isPausedByStock && isReallyActive) {
          try {
            await db.entities.Product.update(product.id, { campaign_status: 'active', pause_reason: null });
            accountLog.unlocked++;
            console.log(`[guard] UNLOCKED (already active) asin=${product.asin} fba=${fba}`);
          } catch (e) {
            accountLog.errors.push({ asin: product.asin, step: 'unlock', error: e.message });
          }
        }
      }

      results.push(accountLog);
    }

    const totals = results.reduce((acc, r) => ({
      paused: acc.paused + r.paused,
      activated: acc.activated + r.activated,
      synced: acc.synced + r.synced,
      unlocked: acc.unlocked + r.unlocked,
    }), { paused: 0, activated: 0, synced: 0, unlocked: 0 });

    return Response.json({ ok: true, ...totals, accounts: results });
  } catch (error) {
    console.error('[guard] erro crítico:', error?.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});