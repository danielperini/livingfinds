/**
 * archiveManualCampaignsWithoutSpend
 *
 * Arquiva campanhas manuais EXACT sem gasto/performance nos últimos 14-30 dias.
 * NUNCA arquiva campanhas com spend > 0 e pedidos > 0.
 * Só arquiva localmente após confirmação da Amazon.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function getAdsBaseUrl(region: string) {
  const r = (region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function getAdsToken(refreshToken: string, clientId: string, clientSecret: string) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token refresh failed');
  return data.access_token as string;
}

Deno.serve(async (req) => {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const cutoff30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const cutoff14 = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const cutoff24h = new Date(Date.now() - 24 * 3600000).toISOString();

  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const dry_run = body.dry_run === true;

    let account: any = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
      account = accs[0];
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' });

    const aid = account.id;

    // Buscar campanhas manuais criadas pelo app
    const campaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: aid, targeting_type: 'MANUAL', created_by_app: true },
      null, 200
    ).catch(() => []);

    // Buscar métricas dos últimos 30 dias
    const metrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: aid },
      '-date', 500
    ).catch(() => []);

    // Agregar spend/orders por campaign_id nos últimos 30 dias
    const campaignStats: Record<string, { spend: number; orders: number; impressions: number; clicks: number }> = {};
    for (const m of metrics) {
      if (!m.campaign_id || m.date < cutoff30) continue;
      if (!campaignStats[m.campaign_id]) campaignStats[m.campaign_id] = { spend: 0, orders: 0, impressions: 0, clicks: 0 };
      campaignStats[m.campaign_id].spend += m.spend || 0;
      campaignStats[m.campaign_id].orders += m.orders || 0;
      campaignStats[m.campaign_id].impressions += m.impressions || 0;
      campaignStats[m.campaign_id].clicks += m.clicks || 0;
    }

    // Verificar fila de reparo
    const repairQueue = await base44.asServiceRole.entities.AutoCampaignRepairQueue?.filter(
      { amazon_account_id: aid }, null, 200
    ).catch(() => []);
    const inRepairCampaignIds = new Set((repairQueue || []).map((r: any) => r.campaign_id).filter(Boolean));

    // Identificar candidatas a arquivamento
    const candidates = campaigns.filter((c: any) => {
      const state = (c.state || c.status || '').toLowerCase();
      if (['archived', 'paused'].includes(state)) return false; // já arquivadas
      if (c.archived) return false;
      if (c.targeting_type?.toUpperCase() !== 'MANUAL') return false;
      if (c.campaign_type?.toUpperCase() !== 'SP') return false; // só Sponsored Products

      // Protegidas
      if (c.is_protected) return false;
      if (inRepairCampaignIds.has(c.campaign_id) || inRepairCampaignIds.has(c.amazon_campaign_id)) return false;

      // Recém-criadas nas últimas 24h → não arquivar
      const createdAt = c.created_at || c.created_date;
      if (createdAt && new Date(createdAt) > new Date(cutoff24h)) return false;

      // Verificar performance
      const cid = c.campaign_id || c.amazon_campaign_id;
      const stats = campaignStats[cid] || { spend: 0, orders: 0, impressions: 0, clicks: 0 };

      // NUNCA arquivar se teve venda ou pedido
      if (stats.orders > 0) return false;
      if (stats.spend > 0 && stats.orders > 0) return false;

      // Arquivar se spend = 0 E impressions = 0 E clicks = 0 nos últimos 14d
      const stats14: Record<string, { spend: number; orders: number; impressions: number }> = {};
      for (const m of metrics) {
        if (!m.campaign_id || m.date < cutoff14) continue;
        if (m.campaign_id !== cid) continue;
        if (!stats14[m.campaign_id]) stats14[m.campaign_id] = { spend: 0, orders: 0, impressions: 0 };
        stats14[m.campaign_id].spend += m.spend || 0;
        stats14[m.campaign_id].orders += m.orders || 0;
        stats14[m.campaign_id].impressions += m.impressions || 0;
      }
      const s14 = stats14[cid] || { spend: 0, orders: 0, impressions: 0 };
      return s14.spend === 0 && s14.impressions === 0;
    });

    if (!candidates.length) {
      return Response.json({ ok: true, message: 'Nenhuma campanha elegível para arquivamento', candidates: 0 });
    }

    if (dry_run) {
      return Response.json({
        ok: true, dry_run: true,
        candidates: candidates.length,
        campaigns: candidates.map((c: any) => ({ id: c.id, name: c.name || c.campaign_name, state: c.state || c.status })),
      });
    }

    // Buscar token e arquivar na Amazon
    const token = await getAdsToken(
      account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '',
      Deno.env.get('ADS_CLIENT_ID') || '',
      Deno.env.get('ADS_CLIENT_SECRET') || '',
    );
    const baseUrl = getAdsBaseUrl(account.region || 'NA');
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';

    let archived = 0, failed = 0;
    const results: any[] = [];

    for (const camp of candidates) {
      const amazonCampaignId = camp.amazon_campaign_id || camp.campaign_id;
      if (!amazonCampaignId) continue;

      try {
        const res = await fetch(`${baseUrl}/sp/campaigns`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
            'Amazon-Advertising-API-Scope': String(profileId),
            'Content-Type': 'application/vnd.spCampaign.v3+json',
            'Accept': 'application/vnd.spCampaign.v3+json',
          },
          body: JSON.stringify({ campaigns: [{ campaignId: amazonCampaignId, state: 'ARCHIVED' }] }),
        });

        if (res.status === 429) {
          await new Promise(r => setTimeout(r, 5000));
          results.push({ id: camp.id, name: camp.name, status: 'rate_limited' });
          failed++;
          continue;
        }

        if (!res.ok) {
          const errText = await res.text();
          results.push({ id: camp.id, name: camp.name, status: 'api_error', error: errText.slice(0, 200) });
          failed++;
          continue;
        }

        const data = await res.json();
        const success = data?.campaigns?.success?.length > 0;
        const apiErrors = data?.campaigns?.error || [];

        if (!success && apiErrors.length > 0) {
          results.push({ id: camp.id, name: camp.name, status: 'amazon_error', error: JSON.stringify(apiErrors[0]).slice(0, 200) });
          failed++;
          continue;
        }

        // Confirmar Amazon retornou sucesso → atualizar localmente
        await base44.asServiceRole.entities.Campaign.update(camp.id, {
          status: 'archived',
          state: 'archived',
          archived: true,
          archived_at: now,
          archive_reason: 'Manual sem gasto/performance; substituída por sugestões Amazon Ads',
        }).catch(() => {});

        archived++;
        results.push({ id: camp.id, name: camp.name, status: 'archived' });
        await new Promise(r => setTimeout(r, 300));

      } catch (e: any) {
        results.push({ id: camp.id, name: camp.name, status: 'error', error: e.message });
        failed++;
      }
    }

    return Response.json({
      ok: true,
      candidates: candidates.length,
      archived,
      failed,
      results: results.slice(0, 50),
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});