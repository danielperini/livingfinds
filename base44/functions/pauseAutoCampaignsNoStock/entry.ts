/**
 * pauseAutoCampaignsNoStock
 * - PAUSA na Amazon (PAUSED): campanhas AUTO sem estoque e sem kickoff agendado
 * - REATIVA na Amazon (ENABLED): campanhas AUTO pausadas cujo ASIN voltou a ter estoque
 * - ARQUIVA localmente + PAUSA na Amazon: duplicatas AUTO por ASIN (mantém a mais antiga)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const ADS_CLIENT_ID = Deno.env.get('ADS_CLIENT_ID') || '';
const ADS_CLIENT_SECRET = Deno.env.get('ADS_CLIENT_SECRET') || '';
const ADS_REGION = Deno.env.get('ADS_REGION') || 'na';

const ENDPOINT_MAP: Record<string, string> = {
  na: 'https://advertising-api.amazon.com',
  eu: 'https://advertising-api-eu.amazon.com',
  fe: 'https://advertising-api-fe.amazon.com',
};

function extractAsin(name: string): string | null {
  const m = (name || '').match(/\b(B0[A-Z0-9]{8})\b/);
  return m ? m[1] : null;
}

function getCampaignAsin(c: any): string | null {
  return c.asin || extractAsin(c.name || c.campaign_name || '');
}

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
  if (!res.ok) throw new Error(`Token error: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

// Envia batch de mudanças de estado para Amazon Ads API v3 SP
// state deve ser 'ENABLED' | 'PAUSED' (maiúsculas, conforme API v3)
async function batchSetCampaignState(
  accessToken: string,
  profileId: string,
  campaignIds: string[],
  state: 'ENABLED' | 'PAUSED'
): Promise<{ success: string[]; failed: string[] }> {
  const endpoint = ENDPOINT_MAP[ADS_REGION] || ENDPOINT_MAP.na;
  const allSuccess: string[] = [];
  const allFailed: string[] = [];

  // Processar em lotes de 10 (limite da API)
  for (let i = 0; i < campaignIds.length; i += 10) {
    const batch = campaignIds.slice(i, i + 10);
    const payload = { campaigns: batch.map(id => ({ campaignId: id, state })) };

    try {
      const res = await fetch(`${endpoint}/sp/campaigns`, {
        method: 'PUT',
        headers: {
          'Amazon-Advertising-API-ClientId': ADS_CLIENT_ID,
          'Amazon-Advertising-API-Scope': profileId,
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/vnd.spCampaign.v3+json',
          'Accept': 'application/vnd.spCampaign.v3+json',
        },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const data = await res.json();
        const successIds = (data?.campaigns?.success || []).map((s: any) => s.campaignId);
        const errorIds = (data?.campaigns?.error || []).map((e: any) => e.campaignId);
        allSuccess.push(...successIds);
        allFailed.push(...errorIds);
      } else {
        // Falhou o batch inteiro
        allFailed.push(...batch);
        console.error(`[batchSetCampaignState] batch failed: ${res.status} ${await res.text()}`);
      }
    } catch (e: any) {
      allFailed.push(...batch);
      console.error(`[batchSetCampaignState] error: ${e.message}`);
    }
  }

  return { success: allSuccess, failed: allFailed };
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

    // Carregar todas campanhas AUTO (exceto já arquivadas localmente)
    const allCampaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id }, null, 500);
    const autoCampaigns = allCampaigns.filter((c: any) =>
      (c.targeting_type || '').toUpperCase() === 'AUTO' &&
      !['archived', 'ARCHIVED'].includes(c.state || c.status || '')
    );

    const autoEnabled = autoCampaigns.filter((c: any) =>
      ['enabled', 'ENABLED'].includes(c.state || c.status || '')
    );
    const autoPaused = autoCampaigns.filter((c: any) =>
      ['paused', 'PAUSED'].includes(c.state || c.status || '')
    );

    // Produtos com estoque
    const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id, status: 'active' }, null, 500);
    const inStockAsins = new Set(
      products.filter((p: any) => (p.fba_inventory || p.available_quantity || 0) > 0).map((p: any) => p.asin)
    );

    // Kickoffs agendados
    const queue = await base44.asServiceRole.entities.ProductKickoffQueue.filter(
      { amazon_account_id, status: 'scheduled' }, null, 200
    ).catch(() => []);
    const kickoffAsins = new Set((queue as any[]).map((q: any) => q.asin));

    // ── Regra 1: Duplicatas AUTO por ASIN — manter mais antiga, arquivar restantes ──
    const byAsin = new Map<string, any[]>();
    for (const c of autoEnabled as any[]) {
      const asin = getCampaignAsin(c);
      if (!asin) continue;
      if (!byAsin.has(asin)) byAsin.set(asin, []);
      byAsin.get(asin)!.push(c);
    }

    const duplicatesToArchive: any[] = [];
    for (const [, camps] of byAsin.entries()) {
      if (camps.length <= 1) continue;
      // Ordenar por data de criação — manter a mais antiga (índice 0)
      camps.sort((a: any, b: any) =>
        new Date(a.created_date || a.created_at || 0).getTime() -
        new Date(b.created_date || b.created_at || 0).getTime()
      );
      for (let i = 1; i < camps.length; i++) {
        duplicatesToArchive.push(camps[i]);
      }
    }

    // ── Regra 2: AUTO ativas sem estoque e sem kickoff → pausar ──
    const archiveIds = new Set(duplicatesToArchive.map((c: any) => c.id));
    const noStockToPause = autoEnabled.filter((c: any) => {
      if (archiveIds.has(c.id)) return false;
      // Não pausar campanhas com proteção ativa (ads_protected=true)
      // exceto se estoque = 0 (fba_inventory do produto)
      if ((c as any).ads_protected === true) {
        const asin = getCampaignAsin(c);
        if (!asin) return false;
        // Permitir pausa apenas se realmente sem estoque
        return !inStockAsins.has(asin) && !kickoffAsins.has(asin);
      }
      const asin = getCampaignAsin(c);
      if (!asin) return false;
      return !inStockAsins.has(asin) && !kickoffAsins.has(asin);
    });

    // ── Regra 3: AUTO pausadas cujo ASIN voltou a ter estoque → reativar ──
    const toReactivate = autoPaused.filter((c: any) => {
      const asin = getCampaignAsin(c);
      if (!asin) return false;
      return inStockAsins.has(asin) || kickoffAsins.has(asin);
    });

    if (dry_run) {
      return Response.json({
        ok: true, dry_run: true,
        would_archive_duplicates: duplicatesToArchive.length,
        would_pause_no_stock: noStockToPause.length,
        would_reactivate: toReactivate.length,
        duplicates: duplicatesToArchive.map((c: any) => ({ name: c.name || c.campaign_name, asin: getCampaignAsin(c), campaign_id: c.campaign_id })),
        no_stock: noStockToPause.map((c: any) => ({ name: c.name || c.campaign_name, asin: getCampaignAsin(c), campaign_id: c.campaign_id })),
        reactivate: toReactivate.map((c: any) => ({ name: c.name || c.campaign_name, asin: getCampaignAsin(c), campaign_id: c.campaign_id })),
      });
    }

    // Obter token Ads
    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '';
    let accessToken: string | null = null;
    let tokenError: string | null = null;
    try {
      accessToken = await getAdsAccessToken(refreshToken);
    } catch (e: any) {
      tokenError = e.message;
    }
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';

    const now = new Date().toISOString();
    const results: any = { token_ok: !!accessToken, token_error: tokenError };

    // ── Executar: Pausar duplicatas na Amazon + arquivar localmente ──
    if (duplicatesToArchive.length > 0) {
      const idsToSend = duplicatesToArchive
        .map((c: any) => c.campaign_id || c.amazon_campaign_id)
        .filter(Boolean);

      if (accessToken && profileId && idsToSend.length > 0) {
        const r = await batchSetCampaignState(accessToken, profileId, idsToSend, 'PAUSED');
        results.duplicates_paused_on_amazon = r.success.length;
        results.duplicates_failed_on_amazon = r.failed.length;
      }

      // Arquivar localmente independente do resultado da API
      await Promise.all(
        duplicatesToArchive.map((c: any) =>
          base44.asServiceRole.entities.Campaign.update(c.id, { state: 'archived', status: 'archived', updated_at: now })
        )
      );
      results.archived_duplicates = duplicatesToArchive.length;
    }

    // ── Executar: Pausar sem estoque na Amazon + atualizar localmente ──
    if (noStockToPause.length > 0) {
      const idsToSend = noStockToPause
        .map((c: any) => c.campaign_id || c.amazon_campaign_id)
        .filter(Boolean);

      if (accessToken && profileId && idsToSend.length > 0) {
        const r = await batchSetCampaignState(accessToken, profileId, idsToSend, 'PAUSED');
        results.paused_on_amazon = r.success.length;
        results.pause_failed_on_amazon = r.failed.length;
      }

      await Promise.all(
        noStockToPause.map((c: any) =>
          base44.asServiceRole.entities.Campaign.update(c.id, { state: 'paused', status: 'paused', updated_at: now })
        )
      );
      results.paused_no_stock = noStockToPause.length;
    }

    // ── Executar: Reativar com estoque na Amazon + atualizar localmente ──
    if (toReactivate.length > 0) {
      const idsToSend = toReactivate
        .map((c: any) => c.campaign_id || c.amazon_campaign_id)
        .filter(Boolean);

      if (accessToken && profileId && idsToSend.length > 0) {
        const r = await batchSetCampaignState(accessToken, profileId, idsToSend, 'ENABLED');
        results.reactivated_on_amazon = r.success.length;
        results.reactivate_failed_on_amazon = r.failed.length;
      }

      await Promise.all(
        toReactivate.map((c: any) =>
          base44.asServiceRole.entities.Campaign.update(c.id, { state: 'enabled', status: 'enabled', updated_at: now })
        )
      );
      results.reactivated = toReactivate.length;
    }

    return Response.json({
      ok: true,
      ...results,
      message: [
        results.archived_duplicates ? `${results.archived_duplicates} duplicatas arquivadas (${results.duplicates_paused_on_amazon ?? 0} pausadas na Amazon)` : null,
        results.paused_no_stock ? `${results.paused_no_stock} pausadas por sem estoque (${results.paused_on_amazon ?? 0} pausadas na Amazon)` : null,
        results.reactivated ? `${results.reactivated} reativadas (${results.reactivated_on_amazon ?? 0} ativadas na Amazon)` : null,
        (!results.archived_duplicates && !results.paused_no_stock && !results.reactivated) ? 'Nenhuma ação necessária.' : null,
      ].filter(Boolean).join('; '),
    });

  } catch (error: any) {
    console.error('[pauseAutoCampaignsNoStock]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});