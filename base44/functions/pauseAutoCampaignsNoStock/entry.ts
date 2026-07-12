/**
 * pauseAutoCampaignsNoStock
 * Executado automaticamente (cron) e manualmente.
 *
 * PAUSA: campanhas AUTO cujo ASIN não tem estoque nem kickoff agendado.
 * REATIVA: campanhas AUTO pausadas (por este sistema) cujo ASIN voltou a ter estoque ou kickoff.
 * ARQUIVA DUPLICATAS: para cada ASIN com múltiplas AUTO ativas, mantém a mais antiga, arquiva as demais.
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

async function setCampaignStateOnAmazon(
  accessToken: string, profileId: string, campaignId: string, state: 'paused' | 'enabled'
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
    body: JSON.stringify([{ campaignId, state }]),
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

    // Todas campanhas AUTO (ativas e pausadas)
    const allCampaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id }, null, 500);
    const autoCampaigns = allCampaigns.filter((c: any) =>
      (c.targeting_type || '').toUpperCase() === 'AUTO'
    );
    const autoEnabled = autoCampaigns.filter((c: any) =>
      c.state === 'enabled' || c.status === 'enabled' || c.state === 'ENABLED'
    );
    const autoPaused = autoCampaigns.filter((c: any) =>
      c.state === 'paused' || c.status === 'paused' || c.state === 'PAUSED'
    );

    // Produtos com estoque
    const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id, status: 'active' }, null, 500);
    const inStockAsins = new Set(
      products.filter((p: any) => (p.fba_inventory || p.available_quantity || 0) > 0).map((p: any) => p.asin)
    );

    // Kickoff agendados
    const queue = await base44.asServiceRole.entities.ProductKickoffQueue.filter(
      { amazon_account_id, status: 'scheduled' }, null, 200
    ).catch(() => []);
    const kickoffAsins = new Set((queue as any[]).map((q: any) => q.asin));

    // ── Regra 1: Múltiplas AUTO ativas por ASIN — arquivar mais recentes, manter mais antiga ──
    const byAsin = new Map<string, any[]>();
    for (const c of autoEnabled as any[]) {
      const asin = c.asin || extractAsin(c.name || c.campaign_name || '');
      if (!asin) continue;
      if (!byAsin.has(asin)) byAsin.set(asin, []);
      byAsin.get(asin)!.push(c);
    }

    const duplicatesToArchive: any[] = [];
    for (const [, camps] of byAsin.entries()) {
      if (camps.length <= 1) continue;
      camps.sort((a: any, b: any) => {
        const da = new Date(a.created_date || a.created_at || 0).getTime();
        const db = new Date(b.created_date || b.created_at || 0).getTime();
        return da - db;
      });
      for (let i = 1; i < camps.length; i++) {
        duplicatesToArchive.push(camps[i]);
      }
    }

    const archiveIds = new Set(duplicatesToArchive.map((c: any) => c.id));

    // ── Regra 2: AUTO ativas sem estoque e sem kickoff ──
    const noStockToPause = autoEnabled.filter((c: any) => {
      if (archiveIds.has(c.id)) return false;
      const asin = c.asin || extractAsin(c.name || c.campaign_name || '');
      if (!asin) return false;
      return !inStockAsins.has(asin) && !kickoffAsins.has(asin);
    });

    // ── Regra 3: AUTO pausadas cujo ASIN voltou a ter estoque ou kickoff — reativar ──
    const toReactivate = autoPaused.filter((c: any) => {
      const asin = c.asin || extractAsin(c.name || c.campaign_name || '');
      if (!asin) return false;
      return inStockAsins.has(asin) || kickoffAsins.has(asin);
    });

    if (dry_run) {
      return Response.json({
        ok: true, dry_run: true,
        would_archive_duplicates: duplicatesToArchive.length,
        would_pause_no_stock: noStockToPause.length,
        would_reactivate: toReactivate.length,
        duplicates: duplicatesToArchive.map((c: any) => ({ name: c.name || c.campaign_name })),
        no_stock: noStockToPause.map((c: any) => ({ name: c.name || c.campaign_name })),
        reactivate: toReactivate.map((c: any) => ({ name: c.name || c.campaign_name })),
      });
    }

    // Obter token Ads
    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '';
    let accessToken: string | null = null;
    try { accessToken = await getAdsAccessToken(refreshToken); } catch {}
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';

    const now = new Date().toISOString();

    // Arquivar duplicatas
    for (const c of duplicatesToArchive as any[]) {
      if (accessToken && profileId && (c.campaign_id || c.amazon_campaign_id)) {
        try { await setCampaignStateOnAmazon(accessToken, profileId, c.campaign_id || c.amazon_campaign_id, 'paused'); } catch {}
      }
      await base44.asServiceRole.entities.Campaign.update(c.id, { state: 'archived', status: 'archived', updated_at: now });
    }

    // Pausar sem estoque
    for (const c of noStockToPause as any[]) {
      if (accessToken && profileId && (c.campaign_id || c.amazon_campaign_id)) {
        try { await setCampaignStateOnAmazon(accessToken, profileId, c.campaign_id || c.amazon_campaign_id, 'paused'); } catch {}
      }
      await base44.asServiceRole.entities.Campaign.update(c.id, { state: 'paused', status: 'paused', updated_at: now });
    }

    // Reativar campanhas com estoque de volta
    for (const c of toReactivate as any[]) {
      if (accessToken && profileId && (c.campaign_id || c.amazon_campaign_id)) {
        try { await setCampaignStateOnAmazon(accessToken, profileId, c.campaign_id || c.amazon_campaign_id, 'enabled'); } catch {}
      }
      await base44.asServiceRole.entities.Campaign.update(c.id, { state: 'enabled', status: 'enabled', updated_at: now });
    }

    return Response.json({
      ok: true,
      archived_duplicates: duplicatesToArchive.length,
      paused_no_stock: noStockToPause.length,
      reactivated: toReactivate.length,
      message: `${duplicatesToArchive.length} duplicatas arquivadas, ${noStockToPause.length} pausadas por sem estoque, ${toReactivate.length} reativadas.`,
    });

  } catch (error: any) {
    console.error('[pauseAutoCampaignsNoStock]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});