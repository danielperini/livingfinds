// reconcileStaleCampaignStatus
// Compara o status local das campanhas com o estado real na Amazon Ads API
// e corrige discrepâncias: status travados como 'pending', 'request_sent',
// 'enabling', 'pausing', ou qualquer divergência local vs Amazon.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function adsBase(region) {
  const r = String(region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function getAdsToken(account) {
  const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
  if (!refreshToken) throw new Error('ADS_REFRESH_TOKEN ausente');
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: Deno.env.get('ADS_CLIENT_ID') || '',
      client_secret: Deno.env.get('ADS_CLIENT_SECRET') || '',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.access_token) throw new Error(data.error_description || `Token falhou HTTP ${res.status}`);
  return data.access_token;
}

// Busca estado real de campanhas na Amazon: retorna Map<amazonCampaignId, 'enabled'|'paused'|'archived'>
async function fetchAmazonCampaignStates(token, profileId, region) {
  const base = adsBase(region);
  const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
  const stateMap = new Map();

  for (const stateFilter of ['ENABLED', 'PAUSED', 'ARCHIVED']) {
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
      if (!res.ok) {
        console.warn(`[reconcile] list ${stateFilter} HTTP ${res.status}`);
        break;
      }
      const payload = await res.json().catch(() => ({}));
      for (const c of (payload.campaigns || [])) {
        stateMap.set(String(c.campaignId), stateFilter.toLowerCase());
      }
      nextToken = payload.nextToken || null;
      if (nextToken) await new Promise(r => setTimeout(r, 150));
    } while (nextToken);
  }
  return stateMap;
}

// Status locais considerados "travados" ou ambíguos — precisam ser reconciliados
const STALE_STATUSES = new Set([
  'pending', 'request_sent', 'enabling', 'pausing', 'updating',
  'syncing', 'unknown', 'error', 'processing',
]);

function normalizeLocal(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'active') return 'enabled';
  if (s === 'enabled') return 'enabled';
  if (s === 'paused') return 'paused';
  if (s === 'archived') return 'archived';
  return s; // manter stale para detectar
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const db = base44.asServiceRole;
    const now = new Date().toISOString();

    const accounts = await db.entities.AmazonAccount.filter({ status: 'connected' });
    if (!accounts.length) return Response.json({ ok: true, message: 'Nenhuma conta conectada', fixed: 0 });

    let totalFixed = 0;
    let totalStale = 0;
    const accountResults = [];

    for (const account of accounts) {
      const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
      const region = account.region || 'NA';
      const log = { account_id: account.id, stale_found: 0, fixed: 0, product_synced: 0, errors: [] };

      let token = null;
      try {
        token = await getAdsToken(account);
      } catch (e) {
        log.errors.push({ step: 'token', error: e.message });
        accountResults.push(log);
        continue;
      }

      // 1. Buscar estado real na Amazon
      const amazonStates = await fetchAmazonCampaignStates(token, profileId, region);
      console.log(`[reconcile] account=${account.id} amazon_campaigns=${amazonStates.size}`);

      if (!amazonStates.size) {
        accountResults.push(log);
        continue;
      }

      // 2. Buscar campanhas locais com status travado OU divergente
      const allCampaigns = await db.entities.Campaign.filter(
        { amazon_account_id: account.id }, null, 2000
      ).catch(() => []);

      const toFix = [];

      for (const c of allCampaigns) {
        const amazonId = String(c.amazon_campaign_id || c.campaign_id || '');
        if (!amazonId) continue;

        const realState = amazonStates.get(amazonId);
        if (!realState) continue; // não encontrada na Amazon (pode ser arquivada não listada)

        const localState = normalizeLocal(c.status || c.state);
        const isStale = STALE_STATUSES.has(localState);
        const isDivergent = !isStale && localState !== realState;

        if (isStale || isDivergent) {
          log.stale_found++;
          toFix.push({
            id: c.id,
            asin: c.asin,
            amazon_campaign_id: amazonId,
            state: realState,
            status: realState,
            amazon_status: realState,
            is_operational: realState === 'enabled',
            last_sync_at: now,
            synced_at: now,
          });
          console.log(`[reconcile] fix campaign=${c.id} asin=${c.asin} local=${localState} → amazon=${realState} stale=${isStale}`);
        }
      }

      // 3. Bulk update campanhas corrigidas
      for (let i = 0; i < toFix.length; i += 100) {
        await db.entities.Campaign.bulkUpdate(toFix.slice(i, i + 100)).catch((e) => {
          log.errors.push({ step: 'bulk_update', error: e.message });
        });
      }
      log.fixed = toFix.length;

      // 4. Sincronizar campaign_status nos Produtos afetados pelos ASINs corrigidos
      const fixedAsins = [...new Set(toFix.map(c => c.asin).filter(Boolean))];
      for (const asin of fixedAsins) {
        const products = await db.entities.Product.filter(
          { amazon_account_id: account.id, asin }, null, 1
        ).catch(() => []);
        const product = products[0];
        if (!product) continue;

        // Determinar o status consolidado do produto baseado em suas campanhas corrigidas
        const campaignsForAsin = await db.entities.Campaign.filter(
          { amazon_account_id: account.id, asin }, null, 10
        ).catch(() => []);

        const hasEnabled = campaignsForAsin.some(c => c.status === 'enabled' || c.state === 'enabled');
        const hasPaused = campaignsForAsin.some(c => c.status === 'paused' || c.state === 'paused');
        const newCampStatus = hasEnabled ? 'active' : hasPaused ? 'paused' : product.campaign_status;

        if (newCampStatus !== product.campaign_status) {
          await db.entities.Product.update(product.id, {
            campaign_status: newCampStatus,
            last_sync_at: now,
          }).catch(() => {});
          log.product_synced++;
        }
      }

      totalFixed += log.fixed;
      totalStale += log.stale_found;
      accountResults.push(log);
    }

    await db.entities.SyncExecutionLog.create({
      operation: 'reconcile_stale_campaign_status',
      status: 'success',
      trigger_type: 'scheduled',
      started_at: now,
      completed_at: new Date().toISOString(),
      records_processed: totalFixed,
      result_summary: JSON.stringify({ stale_found: totalStale, fixed: totalFixed, accounts: accountResults.length }).slice(0, 2000),
    }).catch(() => {});

    return Response.json({ ok: true, stale_found: totalStale, fixed: totalFixed, accounts: accountResults });
  } catch (error) {
    console.error('[reconcileStaleCampaignStatus] erro:', error?.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});