/**
 * pauseAutoCampaignsNoStock
 * Pausa campanhas AUTO cujo ASIN não tem estoque ativo nem kickoff agendado.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const ADS_CLIENT_ID = Deno.env.get('ADS_CLIENT_ID') || '';
const ADS_CLIENT_SECRET = Deno.env.get('ADS_CLIENT_SECRET') || '';
const ADS_REGION = Deno.env.get('ADS_REGION') || 'na';

function extractAsin(name: string): string | null {
  const m = (name || '').match(/\b(B0[A-Z0-9]{8})\b/);
  return m ? m[1] : null;
}

const ENDPOINT_MAP: Record<string, string> = {
  na: 'https://advertising-api.amazon.com',
  eu: 'https://advertising-api-eu.amazon.com',
  fe: 'https://advertising-api-fe.amazon.com',
};

async function getAdsAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: ADS_CLIENT_ID,
      client_secret: ADS_CLIENT_SECRET,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Ads token: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function pauseCampaignOnAmazon(
  accessToken: string, profileId: string, campaignId: string
): Promise<boolean> {
  const endpoint = ENDPOINT_MAP[ADS_REGION] || ENDPOINT_MAP.na;
  const res = await fetch(`${endpoint}/v2/sp/campaigns`, {
    method: 'PUT',
    headers: {
      'Amazon-Advertising-API-ClientId': ADS_CLIENT_ID,
      'Amazon-Advertising-API-Scope': profileId,
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([{ campaignId, state: 'paused' }]),
  });
  return res.ok;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, dry_run = false } = body;
    if (!amazon_account_id) return Response.json({ error: 'amazon_account_id obrigatório' }, { status: 400 });

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id });
    const account = accounts[0];
    if (!account) return Response.json({ error: 'Conta não encontrada' }, { status: 404 });

    // Campanhas AUTO enabled
    const allCampaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id }, null, 500);
    const autoEnabled = allCampaigns.filter((c: any) =>
      (c.targeting_type || '').toUpperCase() === 'AUTO' &&
      (c.state === 'enabled' || c.status === 'enabled')
    );

    // Produtos com estoque
    const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id, status: 'active' }, null, 500);
    const inStockAsins = new Set(products.filter((p: any) => (p.fba_inventory || p.available_quantity || 0) > 0).map((p: any) => p.asin));

    // Kickoff agendados
    const queue = await base44.asServiceRole.entities.ProductKickoffQueue.filter({ amazon_account_id, status: 'scheduled' }, null, 200).catch(() => []);
    const kickoffAsins = new Set((queue as any[]).map((q: any) => q.asin));

    // Filtrar campanhas a pausar
    const toPause = autoEnabled.filter((c: any) => {
      const asin = c.asin || extractAsin(c.name || c.campaign_name);
      if (!asin) return false;
      return !inStockAsins.has(asin) && !kickoffAsins.has(asin);
    });

    if (toPause.length === 0) {
      return Response.json({ ok: true, paused: 0, message: 'Nenhuma campanha para pausar.' });
    }

    if (dry_run) {
      return Response.json({
        ok: true, dry_run: true, would_pause: toPause.length,
        campaigns: (toPause as any[]).map((c: any) => ({
          name: c.name || c.campaign_name,
          asin: c.asin || extractAsin(c.name || c.campaign_name),
          campaign_id: c.campaign_id || c.amazon_campaign_id,
        })),
      });
    }

    // Obter token Ads
    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '';
    let accessToken: string | null = null;
    try { accessToken = await getAdsAccessToken(refreshToken); } catch {}
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';

    const results: any[] = [];
    const now = new Date().toISOString();

    for (const c of toPause as any[]) {
      const asin = c.asin || extractAsin(c.name || c.campaign_name);
      let apiOk = false;

      // Tentar pausar na Amazon Ads API
      if (accessToken && profileId && (c.campaign_id || c.amazon_campaign_id)) {
        try {
          apiOk = await pauseCampaignOnAmazon(accessToken, profileId, c.campaign_id || c.amazon_campaign_id);
        } catch {}
      }

      // Sempre atualizar localmente
      await base44.asServiceRole.entities.Campaign.update(c.id, {
        state: 'paused', status: 'paused', updated_at: now,
      });

      results.push({ id: c.id, asin, name: c.name || c.campaign_name, api_ok: apiOk });
    }

    const apiPaused = results.filter(r => r.api_ok).length;
    const localOnly = results.filter(r => !r.api_ok).length;

    return Response.json({
      ok: true,
      paused: results.length,
      api_paused: apiPaused,
      local_only: localOnly,
      results,
      message: `${results.length} campanhas pausadas (${apiPaused} via API, ${localOnly} apenas local).`,
    });

  } catch (error: any) {
    console.error('[pauseAutoCampaignsNoStock]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});