// Importa/atualiza campanhas da Amazon (ENABLED, PAUSED, INCOMPLETE) e enfileira reparos para INCOMPLETE
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

async function getAccessToken(account: any): Promise<string> {
  const tok = account.ads_refresh_token;
  if (!tok || !tok.startsWith('Atzr|')) throw new Error('Token Amazon Ads não configurado.');
  const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
  const secret = Deno.env.get('ADS_CLIENT_SECRET') || '';
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok, client_id: clientId, client_secret: secret }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.error_description || 'Falha no token');
  return data.access_token;
}

async function listCampaignsByState(base: string, token: string, clientId: string, profileId: string, state: string): Promise<any[]> {
  const CT = 'application/vnd.spCampaign.v3+json';
  const all: any[] = [];
  let nextToken: string | null = null;
  do {
    const bodyObj: any = { stateFilter: { include: [state] }, maxResults: 500 };
    if (nextToken) bodyObj.nextToken = nextToken;
    const r = await fetch(`${base}/sp/campaigns/list`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': clientId,
        'Amazon-Advertising-API-Scope': profileId,
        'Content-Type': CT,
        Accept: CT,
      },
      body: JSON.stringify(bodyObj),
    });
    const data = await r.json().catch(() => ({}));
    all.push(...(data?.campaigns || []));
    nextToken = data?.nextToken || null;
    if (nextToken) await wait(300);
  } while (nextToken);
  return all;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });

    const accountId = body.amazon_account_id;
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: accountId }, null, 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' }, { status: 404 });

    const token = await getAccessToken(account);
    const profileId = String(account.ads_profile_id || '');
    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
    const base = 'https://advertising-api.amazon.com';

    // Buscar todos os estados
    const [enabled, paused, incomplete] = await Promise.all([
      listCampaignsByState(base, token, clientId, profileId, 'ENABLED'),
      listCampaignsByState(base, token, clientId, profileId, 'PAUSED'),
      listCampaignsByState(base, token, clientId, profileId, 'INCOMPLETE'),
    ]);

    const allCampaigns = [...enabled, ...paused, ...incomplete];

    // Buscar campanhas existentes no banco
    const existingRows = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, null, 2000);
    const existingByCampaignId = new Map(existingRows.map((c: any) => [String(c.campaign_id), c]));

    const toCreate: any[] = [];
    const toUpdate: any[] = [];
    const now = new Date().toISOString();

    for (const c of allCampaigns) {
      const campaignId = String(c.campaignId || '');
      if (!campaignId) continue;

      const amazonState = String(c.state || '').toUpperCase();
      const state = amazonState === 'INCOMPLETE' ? 'incomplete' : amazonState.toLowerCase();
      const budget = c.budget?.budget || c.dailyBudget || 5;
      const targetingType = c.targetingType === 'AUTO' ? 'AUTO' : 'MANUAL';
      const asinMatch = (c.name || '').match(/B0[A-Z0-9]{8}/);
      const asin = asinMatch?.[0] || null;

      const existing = existingByCampaignId.get(campaignId);
      if (existing) {
        toUpdate.push({
          id: existing.id,
          state,
          status: state,
          daily_budget: budget,
          name: c.name || existing.name,
          amazon_campaign_id: campaignId,
          campaign_id: campaignId,
          asin: asin || existing.asin || null,
          targeting_type: targetingType,
          is_operational: state === 'enabled',
          requires_attention: state === 'incomplete',
          last_api_sync_at: now,
        });
      } else {
        toCreate.push({
          amazon_account_id: accountId,
          campaign_id: campaignId,
          amazon_campaign_id: campaignId,
          name: c.name || `Campanha ${campaignId.slice(-6)}`,
          campaign_name: c.name || `Campanha ${campaignId.slice(-6)}`,
          state,
          status: state,
          daily_budget: budget,
          campaign_type: 'SP',
          targeting_type: targetingType,
          asin: asin || null,
          is_operational: state === 'enabled',
          requires_attention: state === 'incomplete',
          source: 'api',
          last_api_sync_at: now,
          synced_at: now,
        });
      }
    }

    // Executar em lotes
    let created = 0;
    let updated = 0;
    const batchSize = 100;

    for (let i = 0; i < toCreate.length; i += batchSize) {
      await base44.asServiceRole.entities.Campaign.bulkCreate(toCreate.slice(i, i + batchSize));
      created += Math.min(batchSize, toCreate.length - i);
    }
    for (let i = 0; i < toUpdate.length; i += batchSize) {
      await base44.asServiceRole.entities.Campaign.bulkUpdate(toUpdate.slice(i, i + batchSize));
      updated += Math.min(batchSize, toUpdate.length - i);
    }

    // Enfileirar reparos para campanhas INCOMPLETE
    const incompleteCampaigns = allCampaigns.filter(c => String(c.state || '').toUpperCase() === 'INCOMPLETE');
    let repairQueued = 0;

    if (incompleteCampaigns.length > 0) {
      // Buscar itens já na fila para evitar duplicatas
      const existingRepairs = await base44.asServiceRole.entities.AutoCampaignRepairQueue.filter({
        amazon_account_id: accountId,
        status: 'scheduled',
      }, null, 500).catch(() => []);
      const existingRepairIds = new Set(existingRepairs.map((r: any) => String(r.campaign_id)));

      const repairItems: any[] = [];
      for (const c of incompleteCampaigns) {
        const campaignId = String(c.campaignId || '');
        if (!campaignId || existingRepairIds.has(campaignId)) continue;
        const asinMatch = (c.name || '').match(/B0[A-Z0-9]{8}/);
        const asin = asinMatch?.[0] || null;
        repairItems.push({
          amazon_account_id: accountId,
          campaign_id: campaignId,
          asin: asin || null,
          sku: null,
          status: 'scheduled',
          attempt_count: 0,
          max_attempts: 5,
          scheduled_at: new Date().toISOString(),
          source: 'import_incomplete',
        });
      }

      if (repairItems.length > 0) {
        await base44.asServiceRole.entities.AutoCampaignRepairQueue.bulkCreate(repairItems);
        repairQueued = repairItems.length;
      }
    }

    return Response.json({
      ok: true,
      amazon_total: allCampaigns.length,
      enabled: enabled.length,
      paused: paused.length,
      incomplete: incomplete.length,
      created,
      updated,
      repair_queued: repairQueued,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Erro' }, { status: 500 });
  }
});