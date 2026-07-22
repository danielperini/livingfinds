// reactivatePausedWithStock
// Identifica campanhas pausadas (AUTO + MANUAL) cujos produtos têm estoque
// e as reativa via Amazon Ads API — sem avaliar ACoS nem CVR.
// dry_run=true simula sem executar.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const BLOCKED_REASONS = ['OUT_OF_STOCK', 'USER_MANUAL', 'POLICY', 'ABOVE_BREAK_EVEN', 'LISTING_BLOCKED'];

function adsBase(region) {
  const r = String(region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function getAdsToken(account) {
  const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
  if (!refreshToken) throw new Error('ADS_REFRESH_TOKEN ausente');
  const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
  const secret   = Deno.env.get('ADS_CLIENT_SECRET') || '';
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: secret }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.access_token) throw new Error(data.error_description || `Token falhou HTTP ${res.status}`);
  return data.access_token;
}

async function fetchPausedCampaignIds(token, profileId, region) {
  const base     = adsBase(region);
  const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
  const paused   = new Set();

  let nextToken = null;
  do {
    const body = { stateFilter: { include: ['PAUSED'] }, maxResults: 500 };
    if (nextToken) body.nextToken = nextToken;
    const res = await fetch(`${base}/sp/campaigns/list`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': clientId,
        'Amazon-Advertising-API-Scope': String(profileId),
        'Content-Type': 'application/vnd.spCampaign.v3+json',
        'Accept':       'application/vnd.spCampaign.v3+json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) { console.warn(`[reactivate] list PAUSED HTTP ${res.status}`); break; }
    const payload = await res.json().catch(() => ({}));
    for (const c of (payload.campaigns || [])) paused.add(String(c.campaignId));
    nextToken = payload.nextToken || null;
    if (nextToken) await new Promise(r => setTimeout(r, 100));
  } while (nextToken);

  return paused;
}

async function enableBatch(token, profileId, region, campaignIds) {
  const base     = adsBase(region);
  const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
  const results  = { success: [], failed: [] };

  // Lotes de 10 com 500ms de intervalo
  for (let i = 0; i < campaignIds.length; i += 10) {
    const batch = campaignIds.slice(i, i + 10);
    const body  = { campaigns: batch.map(id => ({ campaignId: String(id), state: 'ENABLED' })) };
    const res   = await fetch(`${base}/sp/campaigns`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': clientId,
        'Amazon-Advertising-API-Scope': String(profileId),
        'Content-Type': 'application/vnd.spCampaign.v3+json',
        'Accept':       'application/vnd.spCampaign.v3+json',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    for (const c of (data.campaigns || [])) {
      if (c.code === 'SUCCESS' || res.ok) results.success.push(String(c.campaignId || batch[0]));
      else results.failed.push({ id: c.campaignId, reason: c.description });
    }
    if (i + 10 < campaignIds.length) await new Promise(r => setTimeout(r, 500));
  }
  return results;
}

Deno.serve(async (req) => {
  try {
    const base44  = createClientFromRequest(req);
    const db      = base44.asServiceRole;

    // Auth: aceita usuário autenticado ou service_role
    let user = null;
    try { user = await base44.auth.me(); } catch {}

    const body    = await req.json().catch(() => ({}));
    const dryRun  = body.dry_run === true;
    const forceAccountId = body.amazon_account_id || null;

    const accounts = await db.entities.AmazonAccount.filter({ status: 'connected' });
    if (!accounts.length) return Response.json({ ok: true, message: 'Nenhuma conta conectada' });

    const globalResults = [];

    for (const account of accounts) {
      if (forceAccountId && account.id !== forceAccountId) continue;

      const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
      const region    = account.region || 'NA';
      const log       = { account_id: account.id, candidates: 0, reactivated: 0, skipped: 0, errors: [], dry_run: dryRun };

      // 1. Token
      let token;
      try { token = await getAdsToken(account); }
      catch (e) { log.errors.push({ step: 'token', error: e.message }); globalResults.push(log); continue; }

      // 2. Amazon: campanhas realmente pausadas
      const amazonPaused = await fetchPausedCampaignIds(token, profileId, region);
      console.log(`[reactivate] account=${account.id} amazon paused=${amazonPaused.size}`);

      // 3. Produtos com estoque (fba_inventory > 0)
      const products = await db.entities.Product.filter({ amazon_account_id: account.id }, null, 1000).catch(() => []);
      const asinWithStock = new Set(
        products
          .filter(p => Number(p.fba_inventory || 0) > 0 && p.status !== 'inactive')
          .map(p => p.asin)
      );

      // 4. Campanhas locais pausadas, não arquivadas
      const localPaused = await db.entities.Campaign.filter(
        { amazon_account_id: account.id, status: 'paused' }, null, 2000
      ).catch(() => []);

      const candidates = [];

      for (const c of localPaused) {
        // Excluir arquivadas
        if (c.archived || String(c.state || '').toLowerCase() === 'archived') continue;

        // Verificar motivo de pausa — bloquear apenas razões explicitamente defensivas
        const archReason   = String(c.archive_reason || '').toUpperCase();
        const pauseReason  = String(c.last_pause_reason || '').toUpperCase();
        const combinedReason = archReason + ' ' + pauseReason;
        if (BLOCKED_REASONS.some(r => combinedReason.includes(r))) { log.skipped++; continue; }

        // Verificar se o ASIN tem estoque
        const asin = c.asin;
        if (!asin || !asinWithStock.has(asin)) { log.skipped++; continue; }

        // Verificar se a Amazon confirma como paused (nunca tentar reativar archived)
        const amazonId = c.amazon_campaign_id || c.campaign_id;
        if (!amazonId || !amazonPaused.has(String(amazonId))) { log.skipped++; continue; }

        candidates.push({ localId: c.id, amazonId: String(amazonId), asin });
      }

      log.candidates = candidates.length;
      console.log(`[reactivate] candidates=${candidates.length} dry_run=${dryRun}`);

      if (dryRun) {
        log.candidate_list = candidates.map(c => ({ amazon_id: c.amazonId, asin: c.asin }));
        globalResults.push(log);
        continue;
      }

      if (candidates.length === 0) { globalResults.push(log); continue; }

      // 5. Enviar ENABLE em batch
      const amazonIds = candidates.map(c => c.amazonId);
      const batchResult = await enableBatch(token, profileId, region, amazonIds);

      const successSet = new Set(batchResult.success);
      log.errors.push(...batchResult.failed.map(f => ({ step: 'enable', campaignId: f.id, reason: f.reason })));

      // 6. Atualizar banco local para as que a Amazon aceitou
      const now = new Date().toISOString();
      const localUpdates = candidates
        .filter(c => successSet.has(c.amazonId) || batchResult.success.length === candidates.length)
        .map(c => ({
          id: c.localId,
          status: 'enabled',
          state: 'enabled',
          amazon_status: 'enabled',
          is_operational: true,
          archive_reason: null,
          last_pause_reason: null,
          synced_at: now,
        }));

      for (let i = 0; i < localUpdates.length; i += 100) {
        await db.entities.Campaign.bulkUpdate(localUpdates.slice(i, i + 100)).catch(() => {});
      }
      log.reactivated = localUpdates.length;

      // 7. Registrar em SyncExecutionLog
      await db.entities.SyncExecutionLog.create({
        amazon_account_id: account.id,
        operation: 'reactivatePausedWithStock',
        status: 'success',
        records_upserted: log.reactivated,
        started_at: now,
        completed_at: now,
        summary: `Reativadas=${log.reactivated} Ignoradas=${log.skipped} Erros=${log.errors.length} Candidatos=${log.candidates}`,
      }).catch(() => {});

      globalResults.push(log);
    }

    const total = globalResults.reduce((a, r) => ({
      candidates: a.candidates + r.candidates,
      reactivated: a.reactivated + r.reactivated,
      skipped: a.skipped + r.skipped,
    }), { candidates: 0, reactivated: 0, skipped: 0 });

    return Response.json({ ok: true, dry_run: dryRun, ...total, accounts: globalResults });
  } catch (error) {
    console.error('[reactivate] erro crítico:', error?.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});