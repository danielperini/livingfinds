// Importa campanhas ENABLED da Amazon que não existem no banco local
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

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
    const CT = 'application/vnd.spCampaign.v3+json';

    // Buscar todas campanhas ENABLED e PAUSED da Amazon
    const allCampaigns: any[] = [];
    for (const state of ['ENABLED', 'PAUSED']) {
      let nextToken: string | null = null;
      do {
        const body2: any = { stateFilter: { include: [state] }, maxResults: 500 };
        if (nextToken) body2.nextToken = nextToken;
        const r = await fetch(`${base}/sp/campaigns/list`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Amazon-Advertising-API-ClientId': clientId,
            'Amazon-Advertising-API-Scope': profileId,
            'Content-Type': CT,
            Accept: CT,
          },
          body: JSON.stringify(body2),
        });
        const data = await r.json().catch(() => ({}));
        const page = data?.campaigns || [];
        allCampaigns.push(...page);
        nextToken = data?.nextToken || null;
      } while (nextToken);
    }

    // Buscar campanhas existentes no banco
    const existingRows = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, null, 2000);
    const existingByCampaignId = new Map(existingRows.map((c: any) => [String(c.campaign_id), c]));

    const toCreate: any[] = [];
    const toUpdate: any[] = [];
    const now = new Date().toISOString();

    for (const c of allCampaigns) {
      const campaignId = String(c.campaignId || '');
      if (!campaignId) continue;

      const state = String(c.state || '').toLowerCase();
      const budget = c.budget?.budget || c.dailyBudget || 5;
      const targetingType = c.targetingType === 'AUTO' ? 'AUTO' : 'MANUAL';

      // Extrair ASIN do nome (padrão AUTO | B0XXXXX | ...)
      const asinMatch = (c.name || '').match(/B0[A-Z0-9]{8}/);
      const asin = asinMatch?.[0] || null;

      const existing = existingByCampaignId.get(campaignId);
      if (existing) {
        // Atualizar estado, budget e marcar como gerenciado
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
          created_by_app: existing.created_by_app || (c.name || '').includes('2026-06-30'),
          last_api_sync_at: now,
        });
      } else {
        // Criar novo registro
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
          created_by_app: (c.name || '').includes('2026-06-30'),
          source: 'api',
          last_api_sync_at: now,
          synced_at: now,
        });
      }
    }

    // Executar em lotes
    let created = 0;
    let updated = 0;

    if (toCreate.length > 0) {
      const batchSize = 100;
      for (let i = 0; i < toCreate.length; i += batchSize) {
        const batch = toCreate.slice(i, i + batchSize);
        await base44.asServiceRole.entities.Campaign.bulkCreate(batch);
        created += batch.length;
      }
    }

    if (toUpdate.length > 0) {
      const batchSize = 100;
      for (let i = 0; i < toUpdate.length; i += batchSize) {
        const batch = toUpdate.slice(i, i + batchSize);
        await base44.asServiceRole.entities.Campaign.bulkUpdate(batch);
        updated += batch.length;
      }
    }

    return Response.json({
      ok: true,
      amazon_total: allCampaigns.length,
      created,
      updated,
      enabled: allCampaigns.filter(c => c.state === 'ENABLED').length,
      paused: allCampaigns.filter(c => c.state === 'PAUSED').length,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Erro' }, { status: 500 });
  }
});