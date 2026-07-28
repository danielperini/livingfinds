/**
 * archiveLegacyCampaignsNoAsin
 *
 * Fluxo 2 do PRD de limpeza canônica:
 * Arquiva campanhas MANUAIS sem ASIN vinculado, spend total = 0 nos últimos 7 dias,
 * e criadas há mais de 7 dias.
 *
 * SALVAGUARDAS:
 * - Nunca arquiva com orders > 0 nos últimos 30 dias
 * - Nunca arquiva com qualquer spend > 0 (mesmo R$0,01) — essas vão para revisão manual
 * - Recém-criadas (< 7 dias) são ignoradas
 * - Campanha marcada is_protected é ignorada
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

const CT_CAMPAIGN = 'application/vnd.spCampaign.v3+json';
const DAYS_7 = 7 * 24 * 3600 * 1000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function invoke(base44: any, fn: string, payload: any): Promise<any> {
  const res = await base44.asServiceRole.functions.invoke(fn, payload);
  return res?.data || res || {};
}

async function archiveOnAmazon(base44: any, accountId: string, amazonCampaignId: string): Promise<boolean> {
  try {
    await invoke(base44, 'amazonAdsCommand', {
      amazon_account_id: accountId,
      operation: 'archiveLegacyNoAsin',
      method: 'PUT',
      path: '/sp/campaigns',
      payload: { campaigns: [{ campaignId: amazonCampaignId, state: 'ARCHIVED' }] },
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

    // Permitir chamada autenticada (usuário) ou service_role (automação)
    if (!body._service_role) {
      try { await base44.auth.me(); } catch {
        return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
      }
    }

    const dry_run = body.dry_run === true;
    const now = new Date();
    const cutoff7d = new Date(now.getTime() - DAYS_7).toISOString();
    const cutoff30dStr = new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);

    // Resolver conta
    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon não encontrada' }, { status: 404 });

    const accountId = account.id;

    // Buscar campanhas manuais sem ASIN (ou ASIN vazio)
    const allCampaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: accountId, targeting_type: 'MANUAL' }, '-created_at', 3000
    ).catch(() => []);

    // Métricas dos últimos 30 dias para verificar spend/orders histórico
    const metrics30d = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: accountId }, '-date', 1000
    ).catch(() => []);

    // Agregar spend/orders por campaign_id nos últimos 30d
    const statsMap = new Map<string, { spend: number; orders: number }>();
    for (const m of metrics30d) {
      if (!m.campaign_id || !m.date || m.date < cutoff30dStr) continue;
      const prev = statsMap.get(m.campaign_id) || { spend: 0, orders: 0 };
      prev.spend += Number(m.spend || 0);
      prev.orders += Number(m.orders || 0);
      statsMap.set(m.campaign_id, prev);
    }

    // Filtrar candidatas
    const candidates: any[] = [];
    const preserved: any[] = []; // tem spend > 0 → revisão manual

    for (const c of allCampaigns) {
      const state = String(c.state || c.status || '').toLowerCase();
      if (state === 'archived') continue;
      if (c.archived) continue;
      if (c.is_protected) continue;
      if (String(c.campaign_type || '').toUpperCase() !== 'SP') continue;

      // Deve ser campanha SEM ASIN vinculado
      const hasAsin = c.asin && String(c.asin).trim().length > 0;
      if (hasAsin) continue;

      // Deve ter sido criada há mais de 7 dias
      const createdAt = c.created_at || c.created_date;
      if (createdAt && new Date(createdAt) > new Date(cutoff7d)) continue;

      const cid = c.campaign_id || c.amazon_campaign_id;
      const stats = statsMap.get(cid) || { spend: 0, orders: 0 };

      // Salvaguarda: nunca arquivar com orders > 0
      if (stats.orders > 0) {
        preserved.push({ id: c.id, name: c.name || c.campaign_name, reason: 'has_orders' });
        continue;
      }

      // Salvaguarda: spend histórico > 0 → sinalizar para revisão manual, não arquivar
      const totalSpend = Number(c.spend || 0) + stats.spend;
      if (totalSpend > 0) {
        preserved.push({ id: c.id, name: c.name || c.campaign_name, reason: 'has_historical_spend', spend: totalSpend });
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
        campaigns_to_archive: candidates.slice(0, 50).map(c => ({
          id: c.id,
          name: c.name || c.campaign_name,
          state: c.state || c.status,
          created_at: c.created_at,
        })),
        campaigns_preserved: preserved.slice(0, 20),
      });
    }

    let archived = 0;
    let failed = 0;
    let local_only = 0;
    const results: any[] = [];

    for (const camp of candidates) {
      const amazonCampaignId = camp.amazon_campaign_id || camp.campaign_id;

      // Se não tiver Amazon campaign_id válido (ID local UUID), apenas marcar localmente
      const hasAmazonId = amazonCampaignId && /^\d+$/.test(String(amazonCampaignId));

      let success = false;
      if (hasAmazonId) {
        success = await archiveOnAmazon(base44, accountId, amazonCampaignId);
      } else {
        // Campanha só existe localmente (sem amazon_campaign_id numérico)
        success = true;
        local_only++;
      }

      if (success) {
        await base44.asServiceRole.entities.Campaign.update(camp.id, {
          state: 'archived',
          status: 'archived',
          archived: true,
          archived_at: new Date().toISOString(),
          archive_reason: 'legacy_no_asin_spend_zero_7d',
        }).catch(() => {});
        archived++;
        results.push({ id: camp.id, name: camp.name || camp.campaign_name, status: 'archived', local_only: !hasAmazonId });
      } else {
        failed++;
        results.push({ id: camp.id, name: camp.name || camp.campaign_name, status: 'failed' });
      }

      await sleep(300);
    }

    // Log de execução
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'archive_legacy_no_asin',
      trigger_type: body.trigger_type || 'manual',
      status: failed > 0 ? 'warning' : 'success',
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      records_processed: archived,
      result_summary: JSON.stringify({
        candidates: candidates.length,
        archived,
        failed,
        local_only,
        preserved: preserved.length,
      }),
    }).catch(() => {});

    return Response.json({
      ok: true,
      candidates: candidates.length,
      archived,
      failed,
      local_only,
      preserved: preserved.length,
      preserved_details: preserved.slice(0, 20),
      results: results.slice(0, 100),
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
});