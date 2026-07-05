// v8 — sem invoke aninhado + bulk DB ops para evitar rate limit
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const STATES = ['ENABLED', 'PAUSED', 'ARCHIVED'];
const PRIORITY: any = { ENABLED: 3, PAUSED: 2, ARCHIVED: 1 };

function normalizedState(value: any) {
  const s = String(value || '').toUpperCase();
  if (s === 'ENABLED') return 'enabled';
  if (s === 'PAUSED') return 'paused';
  if (s === 'ARCHIVED') return 'archived';
  return 'incomplete';
}

function adsBase(region: string) {
  const r = String(region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function getAdsToken(account: any): Promise<string> {
  const refreshToken = account.ads_refresh_token;
  if (!refreshToken || !refreshToken.startsWith('Atzr|')) {
    throw new Error('Token Amazon Ads não configurado. Reconecte em Integrações → Amazon.');
  }
  const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
  const secret = Deno.env.get('ADS_CLIENT_SECRET') || '';
  if (!clientId || !secret) throw new Error('Credenciais ADS_CLIENT_ID/ADS_CLIENT_SECRET ausentes');

  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: secret,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `Token falhou HTTP ${res.status}`);
  }
  return data.access_token;
}

async function listCampaignsForState(token: string, profileId: string, region: string, state: string): Promise<any[]> {
  const base = adsBase(region);
  const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
  const results: any[] = [];
  let nextToken: string | null = null;
  const seen = new Set<string>();

  do {
    const bodyPayload: any = { stateFilter: { include: [state] }, maxResults: 500 };
    if (nextToken) bodyPayload.nextToken = nextToken;

    const res = await fetch(`${base}/sp/campaigns/list`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': clientId,
        'Amazon-Advertising-API-Scope': String(profileId),
        'Content-Type': 'application/vnd.spCampaign.v3+json',
        'Accept': 'application/vnd.spCampaign.v3+json',
      },
      body: JSON.stringify(bodyPayload),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[syncV8] state=${state} httpStatus=${res.status} body=${text.slice(0, 200)}`);
      break;
    }

    const payload = await res.json().catch(() => ({}));
    const campaigns: any[] = Array.isArray(payload?.campaigns) ? payload.campaigns : [];
    console.log(`[syncV8] state=${state} page campaigns=${campaigns.length}`);
    results.push(...campaigns);

    nextToken = payload?.nextToken || null;
    if (nextToken && seen.has(nextToken)) break;
    if (nextToken) seen.add(nextToken);
    if (nextToken) await new Promise(r => setTimeout(r, 150));
  } while (nextToken);

  return results;
}

Deno.serve(async (request) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' });

    const accountId = body.amazon_account_id;
    if (!accountId) return Response.json({ ok: false, error: 'amazon_account_id obrigatório' });

    console.log('[syncV8] iniciando accountId=', accountId);

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: accountId }, null, 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' });

    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    if (!profileId) return Response.json({ ok: false, error: 'ADS_PROFILE_ID ausente' });

    const token = await getAdsToken(account);
    console.log('[syncV8] token obtido');

    // Coletar campanhas de todos os estados, deduplicar por prioridade
    const found = new Map<string, any>();
    for (const state of STATES) {
      const campaigns = await listCampaignsForState(token, profileId, account.region || 'NA', state);
      for (const campaign of campaigns) {
        const id = String(campaign.campaignId);
        const existing = found.get(id);
        const candidateState = String(campaign.state || state).toUpperCase();
        if (!existing || PRIORITY[candidateState] > PRIORITY[String(existing.state || 'ARCHIVED').toUpperCase()]) {
          found.set(id, { ...campaign, state: candidateState });
        }
      }
    }

    console.log(`[syncV8] total Amazon: ${found.size}`);
    if (found.size === 0) {
      return Response.json({ ok: false, error: 'Nenhuma campanha retornada pela Amazon' });
    }

    // Carregar campanhas locais
    const existing = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: accountId }, '-updated_at', 5000
    ).catch(() => []);

    const existingById = new Map<string, any>();
    for (const row of existing) existingById.set(String(row.campaign_id), row);

    const remoteIds = new Set(found.keys());
    const toCreate: any[] = [];
    const toUpdate: any[] = [];

    for (const campaign of found.values()) {
      const id = String(campaign.campaignId);
      const remoteState = normalizedState(campaign.state);
      const record = {
        amazon_account_id: accountId,
        campaign_id: id,
        amazon_campaign_id: id,
        name: campaign.name,
        campaign_name: campaign.name,
        campaign_type: 'SP',
        targeting_type: String(campaign.targetingType || 'AUTO').toUpperCase(),
        amazon_status: remoteState,
        state: remoteState,
        status: remoteState,
        archived: remoteState === 'archived',
        is_operational: remoteState === 'enabled',
        daily_budget: Number(campaign.budget?.budget || campaign.dailyBudget || 0),
        start_date: campaign.startDate || null,
        end_date: campaign.endDate || null,
        bidding_strategy: campaign.dynamicBidding?.strategy || campaign.bidding?.strategy || null,
        synced_at: new Date().toISOString(),
        last_api_sync_at: new Date().toISOString(),
      };

      const local = existingById.get(id);
      if (local) toUpdate.push({ id: local.id, ...record });
      else toCreate.push(record);
    }

    // Bulk ops em lotes de 100
    const BATCH = 100;
    let created = 0;
    let updated = 0;

    for (let i = 0; i < toCreate.length; i += BATCH) {
      await base44.asServiceRole.entities.Campaign.bulkCreate(toCreate.slice(i, i + BATCH));
      created += Math.min(BATCH, toCreate.length - i);
    }

    for (let i = 0; i < toUpdate.length; i += BATCH) {
      await base44.asServiceRole.entities.Campaign.bulkUpdate(toUpdate.slice(i, i + BATCH));
      updated += Math.min(BATCH, toUpdate.length - i);
    }

    // Marcar ausentes
    const missingRows = existing.filter((row: any) => !remoteIds.has(String(row.campaign_id)));
    const missingUpdates = missingRows.map((row: any) => ({
      id: row.id,
      api_missing: true,
      requires_attention: true,
      reconciliation_status: 'missing_in_api',
      reconciliation_notes: 'Não retornou nesta leitura.',
      synced_at: new Date().toISOString(),
    }));
    for (let i = 0; i < missingUpdates.length; i += BATCH) {
      await base44.asServiceRole.entities.Campaign.bulkUpdate(missingUpdates.slice(i, i + BATCH)).catch(() => {});
    }

    const summary = {
      ok: true,
      remote_total: found.size,
      enabled: [...found.values()].filter((c: any) => normalizedState(c.state) === 'enabled').length,
      paused: [...found.values()].filter((c: any) => normalizedState(c.state) === 'paused').length,
      archived: [...found.values()].filter((c: any) => normalizedState(c.state) === 'archived').length,
      created,
      updated,
      missing_preserved: missingRows.length,
    };

    console.log('[syncV8] concluído:', JSON.stringify(summary));

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'sync_ads_campaign_states_v2',
      status: 'success',
      trigger_type: body.trigger_type || 'scheduled',
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      records_processed: found.size,
      result_summary: JSON.stringify(summary).slice(0, 4000),
      error_message: null,
      execution_date: new Date().toISOString().slice(0, 10),
    }).catch(() => {});

    return Response.json(summary);
  } catch (error: any) {
    console.error('[syncV8] erro crítico:', error?.message);
    return Response.json({ ok: false, error: error?.message || 'Erro ao sincronizar campanhas' });
  }
});