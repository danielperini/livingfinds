// reactivatePausedWithStock
// Identifica campanhas pausadas (AUTO + MANUAL, ou somente AUTO) cujos produtos têm estoque
// e as reativa via Amazon Ads API — sem avaliar ACoS nem CVR.
// dry_run=true simula sem executar.
// targeting_type_filter='AUTO' filtra somente campanhas automáticas.
// include_incomplete=true inclui campanhas com state='incomplete'.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const BLOCKED_REASONS = ['OUT_OF_STOCK', 'USER_MANUAL', 'POLICY', 'ABOVE_BREAK_EVEN', 'LISTING_BLOCKED'];

function adsBase(region) {
  const r = String(region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function getAdsToken(base44, accountId) {
  const res = await base44.asServiceRole.functions.invoke('amazonAdsTokenManager', {
    amazon_account_id: accountId,
    _service_role: true,
  });
  const data = res?.data || res;
  if (!data?.ok || !data?.access_token) {
    throw new Error(data?.message || data?.error || 'Falha ao obter access token');
  }
  return String(data.access_token);
}

async function fetchPausedAndIncompleteCampaignIds(token, profileId, region, includeIncomplete) {
  const base     = adsBase(region);
  const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
  const stateSet = new Set();

  const statesToFetch = includeIncomplete
    ? [['PAUSED'], ['ENABLED']] // INCOMPLETE na Amazon se manifesta como ENABLED mas incompleto
    : [['PAUSED']];

  for (const states of statesToFetch) {
    let nextToken = null;
    do {
      const body: any = { stateFilter: { include: states }, maxResults: 500 };
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
      if (!res.ok) { console.warn(`[reactivate] list ${states} HTTP ${res.status}`); break; }
      const payload = await res.json().catch(() => ({}));
      for (const c of (payload.campaigns || [])) stateSet.add(String(c.campaignId));
      nextToken = payload.nextToken || null;
      if (nextToken) await new Promise(r => setTimeout(r, 100));
    } while (nextToken);
  }

  return stateSet;
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

    const body             = await req.json().catch(() => ({}));
    const dryRun           = body.dry_run === true;
    const forceAccountId   = body.amazon_account_id || null;
    const targetingFilter  = body.targeting_type_filter ? String(body.targeting_type_filter).toUpperCase() : null; // 'AUTO' | 'MANUAL' | null
    const includeIncomplete = body.include_incomplete === true;

    const accounts = await db.entities.AmazonAccount.filter({ status: 'connected' });
    if (!accounts.length) return Response.json({ ok: true, message: 'Nenhuma conta conectada' });

    const globalResults = [];

    for (const account of accounts) {
      if (forceAccountId && account.id !== forceAccountId) continue;

      const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
      const region    = account.region || 'NA';
      const log: any  = {
        account_id: account.id,
        candidates: 0,
        reactivated: 0,
        skipped_no_stock: 0,
        skipped_already_active: 0,
        skipped_other: 0,
        errors: [],
        dry_run: dryRun,
      };

      // 1. Token via amazonAdsTokenManager
      let token;
      try { token = await getAdsToken(base44, account.id); }
      catch (e) { log.errors.push({ step: 'token', error: e.message }); globalResults.push(log); continue; }

      // 2. Amazon: campanhas pausadas (e incompletas se solicitado)
      const amazonReachable = await fetchPausedAndIncompleteCampaignIds(token, profileId, region, includeIncomplete);
      console.log(`[reactivate] account=${account.id} amazon reachable=${amazonReachable.size}`);

      // 3. Produtos com estoque (fba_inventory > 0)
      const products = await db.entities.Product.filter({ amazon_account_id: account.id }, null, 1000).catch(() => []);
      const asinWithStock = new Set(
        products
          .filter(p => Number(p.fba_inventory || 0) > 0 && p.status !== 'inactive')
          .map(p => p.asin)
      );

      // 4. Campanhas locais pausadas + incompletas conforme filtro
      const statusFilter: string[] = ['paused'];
      if (includeIncomplete) statusFilter.push('incomplete');

      let localCandidates: any[] = [];
      for (const st of statusFilter) {
        const rows = await db.entities.Campaign.filter(
          { amazon_account_id: account.id, status: st }, null, 2000
        ).catch(() => []);
        localCandidates.push(...rows);
      }

      // Também buscar por state (campo alternativo)
      for (const st of statusFilter) {
        const rows = await db.entities.Campaign.filter(
          { amazon_account_id: account.id, state: st }, null, 2000
        ).catch(() => []);
        localCandidates.push(...rows);
      }

      // Deduplicar por id
      const seenIds = new Set<string>();
      localCandidates = localCandidates.filter(c => {
        if (seenIds.has(c.id)) return false;
        seenIds.add(c.id);
        return true;
      });

      // 5. Se targeting_type_filter definido, carregar ASINs que já têm campanha do mesmo tipo ATIVA
      let asinWithActiveAuto = new Set<string>();
      if (targetingFilter === 'AUTO') {
        const activeCampaigns = await db.entities.Campaign.filter(
          { amazon_account_id: account.id, targeting_type: 'AUTO', status: 'enabled' }, null, 2000
        ).catch(() => []);
        const activeByState = await db.entities.Campaign.filter(
          { amazon_account_id: account.id, targeting_type: 'AUTO', state: 'enabled' }, null, 2000
        ).catch(() => []);
        [...activeCampaigns, ...activeByState].forEach(c => {
          if (c.asin) asinWithActiveAuto.add(c.asin);
        });
      }

      const candidates: any[] = [];

      for (const c of localCandidates) {
        // Excluir arquivadas
        if (c.archived || String(c.state || '').toLowerCase() === 'archived') { log.skipped_other++; continue; }

        // Filtrar por targeting_type se solicitado
        if (targetingFilter) {
          const ct = String(c.targeting_type || '').toUpperCase();
          if (ct !== targetingFilter) { log.skipped_other++; continue; }
        }

        // Verificar motivo de pausa — bloquear apenas razões explicitamente defensivas
        const archReason     = String(c.archive_reason || '').toUpperCase();
        const pauseReason    = String(c.last_pause_reason || '').toUpperCase();
        const combinedReason = archReason + ' ' + pauseReason;
        if (BLOCKED_REASONS.some(r => combinedReason.includes(r))) { log.skipped_other++; continue; }

        // Verificar se o ASIN tem estoque
        const asin = c.asin;
        if (!asin || !asinWithStock.has(asin)) { log.skipped_no_stock++; continue; }

        // Verificar se já tem campanha AUTO ativa para este ASIN (apenas no modo AUTO)
        if (targetingFilter === 'AUTO' && asinWithActiveAuto.has(asin)) {
          log.skipped_already_active++;
          continue;
        }

        // Para campanhas PAUSED: verificar se Amazon confirma como paused
        // Para campanhas INCOMPLETE: aceitar mesmo sem confirmação Amazon (podem aparecer como ENABLED incompleto)
        const amazonId = c.amazon_campaign_id || c.campaign_id;
        if (!amazonId) { log.skipped_other++; continue; }

        const localState = String(c.state || c.status || '').toLowerCase();
        const isIncomplete = localState === 'incomplete';

        if (!isIncomplete && !amazonReachable.has(String(amazonId))) {
          log.skipped_other++;
          continue;
        }

        candidates.push({ localId: c.id, amazonId: String(amazonId), asin });
      }

      log.candidates = candidates.length;
      // Compatibilidade: manter campo skipped agregado
      (log as any).skipped = log.skipped_no_stock + log.skipped_already_active + log.skipped_other;
      console.log(`[reactivate] candidates=${candidates.length} dry_run=${dryRun}`);

      if (dryRun) {
        log.candidate_list = candidates.map(c => ({ amazon_id: c.amazonId, asin: c.asin }));
        globalResults.push(log);
        continue;
      }

      if (candidates.length === 0) { globalResults.push(log); continue; }

      // 6. Enviar ENABLE em batch
      const amazonIds = candidates.map(c => c.amazonId);
      const batchResult = await enableBatch(token, profileId, region, amazonIds);

      const successSet = new Set(batchResult.success);
      log.errors.push(...batchResult.failed.map(f => ({ step: 'enable', campaignId: f.id, reason: f.reason })));

      // 7. Atualizar banco local para as que a Amazon aceitou
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

      // 8. Registrar em SyncExecutionLog
      await db.entities.SyncExecutionLog.create({
        amazon_account_id: account.id,
        operation: 'reactivatePausedWithStock',
        status: 'success',
        records_upserted: log.reactivated,
        started_at: now,
        completed_at: now,
        result_summary: `Reativadas=${log.reactivated} SemEstoque=${log.skipped_no_stock} JaAtiva=${log.skipped_already_active} Outros=${log.skipped_other} Candidatos=${log.candidates}`,
      }).catch(() => {});

      globalResults.push(log);
    }

    const total = globalResults.reduce((a, r) => ({
      candidates: a.candidates + (r.candidates || 0),
      reactivated: a.reactivated + (r.reactivated || 0),
      skipped_no_stock: a.skipped_no_stock + (r.skipped_no_stock || 0),
      skipped_already_active: a.skipped_already_active + (r.skipped_already_active || 0),
      skipped: a.skipped + (r.skipped_no_stock || 0) + (r.skipped_already_active || 0) + (r.skipped_other || 0),
    }), { candidates: 0, reactivated: 0, skipped_no_stock: 0, skipped_already_active: 0, skipped: 0 });

    return Response.json({ ok: true, dry_run: dryRun, ...total, accounts: globalResults });
  } catch (error) {
    console.error('[reactivate] erro crítico:', error?.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});