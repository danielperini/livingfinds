/**
 * pauseAndArchiveAutoNoAsin
 *
 * Pausa na Amazon e arquiva localmente todas as campanhas AUTO (targeting_type=AUTO)
 * sem ASIN vinculado (campo asin vazio E nome sem padrão B0XXXXXXXXX).
 *
 * Salvaguardas:
 * - Campanhas com orders > 0 nos últimos 30 dias são preservadas (não pausadas)
 * - Dry-run disponível para inspecionar candidatas antes de executar
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const CT_CAMPAIGN = 'application/vnd.spCampaign.v3+json';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function extractAsinFromName(name) {
  if (!name) return null;
  const m = String(name).match(/\b(B0[A-Z0-9]{8})\b/i);
  return m ? m[1].toUpperCase() : null;
}

async function pauseOnAmazon(base44, accountId, amazonCampaignId) {
  try {
    await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
      amazon_account_id: accountId,
      operation: 'pauseAutoNoAsin',
      method: 'PUT',
      path: '/sp/campaigns',
      payload: { campaigns: [{ campaignId: amazonCampaignId, state: 'PAUSED' }] },
      content_type: CT_CAMPAIGN,
      accept: CT_CAMPAIGN,
      max_attempts: 2,
      _service_role: true,
    });
    return true;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    if (!body._service_role) {
      try { await base44.auth.me(); } catch {
        return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
      }
    }

    const dry_run = body.dry_run === true;

    // Resolver conta
    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon não encontrada' }, { status: 404 });

    const accountId = account.id;

    // Buscar todas as campanhas AUTO não-arquivadas
    const allCampaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: accountId, targeting_type: 'AUTO' }, null, 1000
    ).catch(() => []);

    // Métricas 30d para salvaguarda de orders
    const cutoff30dStr = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const metrics30d = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: accountId }, '-date', 2000
    ).catch(() => []);

    const ordersMap = new Map();
    for (const m of metrics30d) {
      if (!m.campaign_id || !m.date || m.date < cutoff30dStr) continue;
      ordersMap.set(m.campaign_id, (ordersMap.get(m.campaign_id) || 0) + Number(m.orders || 0));
    }

    const candidates = [];
    const preserved = [];

    for (const c of allCampaigns) {
      const state = String(c.state || c.status || '').toLowerCase();
      if (state === 'archived') continue;
      if (c.archived) continue;

      // Verificar se tem ASIN
      const hasAsinField = c.asin && String(c.asin).trim().length > 0;
      const hasAsinInName = extractAsinFromName(c.name || c.campaign_name);
      if (hasAsinField || hasAsinInName) continue; // tem ASIN → ignorar

      // Salvaguarda: orders > 0 nos últimos 30d → preservar
      const cid = c.campaign_id || c.amazon_campaign_id;
      const orders30d = ordersMap.get(cid) || 0;
      if (orders30d > 0) {
        preserved.push({ id: c.id, name: c.name || c.campaign_name, reason: 'has_orders_30d', orders: orders30d });
        continue;
      }

      candidates.push(c);
    }

    if (dry_run) {
      return Response.json({
        ok: true,
        dry_run: true,
        candidates: candidates.length,
        preserved: preserved.length,
        campaigns_to_pause: candidates.map(c => ({
          id: c.id,
          name: c.name || c.campaign_name,
          state: c.state || c.status,
          spend: c.spend || 0,
          campaign_id: c.campaign_id || c.amazon_campaign_id,
        })),
        campaigns_preserved: preserved,
      });
    }

    let paused = 0;
    let local_only = 0;
    let failed = 0;
    const results = [];

    for (const camp of candidates) {
      const amazonCampaignId = camp.amazon_campaign_id || camp.campaign_id;
      const hasAmazonId = amazonCampaignId && /^\d+$/.test(String(amazonCampaignId));

      let pauseOk = false;
      if (hasAmazonId) {
        pauseOk = await pauseOnAmazon(base44, accountId, amazonCampaignId);
      } else {
        // ID local sem numérico — só existe no banco
        pauseOk = true;
        local_only++;
      }

      if (pauseOk) {
        await base44.asServiceRole.entities.Campaign.update(camp.id, {
          state: 'archived',
          status: 'archived',
          archived: true,
          archived_at: new Date().toISOString(),
          archive_reason: 'auto_no_asin_paused_and_archived',
        }).catch(() => {});
        paused++;
        results.push({ id: camp.id, name: camp.name || camp.campaign_name, status: 'paused_and_archived', local_only: !hasAmazonId });
      } else {
        failed++;
        results.push({ id: camp.id, name: camp.name || camp.campaign_name, status: 'failed' });
      }

      await sleep(350);
    }

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'pause_archive_auto_no_asin',
      trigger_type: body.trigger_type || 'manual',
      status: failed > 0 ? 'warning' : 'success',
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      records_processed: paused,
      result_summary: JSON.stringify({ candidates: candidates.length, paused, failed, local_only, preserved: preserved.length }),
    }).catch(() => {});

    return Response.json({
      ok: true,
      candidates: candidates.length,
      paused,
      failed,
      local_only,
      preserved: preserved.length,
      preserved_details: preserved,
      results,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    });

  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
});