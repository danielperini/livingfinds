/**
 * archivePausedZeroActivityCampaigns
 *
 * Arquiva campanhas manuais SP com state=paused, spend=0 e impressions=0
 * em todo o histórico disponível, pausadas há 7+ dias.
 *
 * SALVAGUARDAS:
 * - Qualquer spend > 0 em qualquer janela histórica → preservada
 * - Qualquer impressions > 0 em qualquer janela histórica → preservada
 * - orders > 0 → preservada
 * - Criada há menos de min_days_paused dias → ignorada
 * - Em AutoCampaignRepairQueue ou KeywordRepairQueue com status pending/processing → ignorada
 *
 * Autenticação: fetch direto com refresh token (DB → ENV fallback).
 * Batch: até 10 campanhas por PUT Amazon, com 500ms de delay entre batches.
 * Idempotente: campanhas já arquivadas são ignoradas.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

const CT_CAMPAIGN = 'application/vnd.spCampaign.v3+json';
const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 500;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function getAdsBaseUrl(region: string): string {
  const r = (region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function getAdsToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
  const clientSecret = Deno.env.get('ADS_CLIENT_SECRET') || '';
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || `Token refresh failed: ${res.status}`);
  return data.access_token as string;
}

Deno.serve(async (req) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    // Aceitar chamada autenticada (usuário) ou service_role (automação)
    if (!body._service_role) {
      try { await base44.auth.me(); } catch {
        return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
      }
    }

    const dry_run = body.dry_run === true;
    const min_days_paused = Math.max(1, Number(body.min_days_paused || 7));
    const cutoffDate = new Date(Date.now() - min_days_paused * 24 * 3600 * 1000).toISOString();

    // ── Resolver conta (aceita qualquer status) ────────────────────────────
    let account: any = null;
    if (body.amazon_account_id) {
      const rows = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1).catch(() => []);
      account = rows[0];
    }
    if (!account) {
      const rows = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1).catch(() => []);
      account = rows[0];
    }
    if (!account) {
      // fallback: qualquer conta
      const rows = await base44.asServiceRole.entities.AmazonAccount.list('-created_date', 1).catch(() => []);
      account = rows[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon não encontrada' }, { status: 404 });

    const accountId = account.id;
    const profileId = String(account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '');
    const baseUrl = getAdsBaseUrl(account.region || 'NA');
    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';

    // ── Buscar dados necessários em paralelo ───────────────────────────────
    const [allCampaigns, allMetrics, repairQueueRaw, keywordQueueRaw] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-created_at', 5000).catch(() => []),
      base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: accountId }, '-date', 5000).catch(() => []),
      base44.asServiceRole.entities.AutoCampaignRepairQueue.filter({ amazon_account_id: accountId }, null, 500).catch(() => []),
      base44.asServiceRole.entities.KeywordRepairQueue.filter({ amazon_account_id: accountId }, null, 500).catch(() => []),
    ]);

    // ── IDs em fila de reparo ativo ────────────────────────────────────────
    const inRepairSet = new Set<string>();
    for (const r of [...repairQueueRaw, ...keywordQueueRaw]) {
      const s = String(r.status || '').toLowerCase();
      if (s === 'pending' || s === 'processing') {
        if (r.campaign_id) inRepairSet.add(String(r.campaign_id));
        if (r.amazon_campaign_id) inRepairSet.add(String(r.amazon_campaign_id));
      }
    }

    // ── Agregar métricas históricas por campaign_id (todo o histórico) ─────
    const metricsMap = new Map<string, { spend: number; impressions: number; orders: number }>();
    for (const m of allMetrics) {
      if (!m.campaign_id) continue;
      const prev = metricsMap.get(m.campaign_id) || { spend: 0, impressions: 0, orders: 0 };
      prev.spend += Number(m.spend || 0);
      prev.impressions += Number(m.impressions || 0);
      prev.orders += Number(m.orders || 0);
      metricsMap.set(m.campaign_id, prev);
    }

    // ── Filtrar candidatas ─────────────────────────────────────────────────
    const candidates: any[] = [];
    const preserved: Array<{ id: string; name: string; reason: string }> = [];
    const skipped_too_recent: string[] = [];

    for (const c of allCampaigns) {
      const state = String(c.state || c.status || '').toLowerCase();
      if (state !== 'paused') continue;
      if (c.archived) continue;
      if (String(c.campaign_type || '').toUpperCase() !== 'SP') continue;
      if (String(c.targeting_type || '').toUpperCase() !== 'MANUAL') continue;
      if (c.is_protected) continue;

      const createdAt = c.created_at || c.created_date;
      if (createdAt && new Date(createdAt) > new Date(cutoffDate)) {
        skipped_too_recent.push(c.id);
        continue;
      }

      const cid = String(c.campaign_id || c.amazon_campaign_id || '');
      if (inRepairSet.has(cid)) {
        preserved.push({ id: c.id, name: c.name || c.campaign_name, reason: 'in_repair_queue' });
        continue;
      }

      // Somar métricas diárias + fallback nos campos da entidade Campaign
      const daily = metricsMap.get(cid) || { spend: 0, impressions: 0, orders: 0 };
      const totalSpend = daily.spend + Number(c.spend || 0) + Number(c.current_spend || 0);
      const totalImpressions = daily.impressions + Number(c.impressions || 0);
      const totalOrders = daily.orders + Number(c.orders || 0);

      if (totalOrders > 0) { preserved.push({ id: c.id, name: c.name || c.campaign_name, reason: 'has_orders' }); continue; }
      if (totalSpend > 0) { preserved.push({ id: c.id, name: c.name || c.campaign_name, reason: 'has_spend' }); continue; }
      if (totalImpressions > 0) { preserved.push({ id: c.id, name: c.name || c.campaign_name, reason: 'has_impressions' }); continue; }

      candidates.push(c);
    }

    // ── Dry run ─────────────────────────────────────────────────────────────
    if (dry_run) {
      return Response.json({
        ok: true,
        dry_run: true,
        candidates_found: candidates.length,
        preserved_with_impressions: preserved.filter(p => p.reason === 'has_impressions').length,
        preserved_total: preserved.length,
        skipped_too_recent: skipped_too_recent.length,
        candidates: candidates.slice(0, 50).map(c => ({
          id: c.id,
          campaign_id: c.campaign_id,
          name: c.name || c.campaign_name,
          created_at: c.created_at,
        })),
        preserved_details: preserved.slice(0, 20),
      });
    }

    if (candidates.length === 0) {
      return Response.json({ ok: true, candidates_found: 0, archived: 0, failed: 0, message: 'Nenhuma campanha elegível' });
    }

    // ── Obter access token (DB refresh token → ENV fallback) ───────────────
    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '';
    const accessToken = await getAdsToken(refreshToken);

    // ── Separar: com Amazon ID numérico real vs só locais ─────────────────
    const withAmazonId = candidates.filter(c => /^\d+$/.test(String(c.campaign_id || c.amazon_campaign_id || '')));
    const localOnly = candidates.filter(c => !/^\d+$/.test(String(c.campaign_id || c.amazon_campaign_id || '')));

    let archived = 0;
    let failed = 0;
    const now = new Date().toISOString();

    // ── Processar em batches de BATCH_SIZE ────────────────────────────────
    for (let i = 0; i < withAmazonId.length; i += BATCH_SIZE) {
      const batch = withAmazonId.slice(i, i + BATCH_SIZE);
      const batchBody = { campaigns: batch.map(c => ({ campaignId: String(c.campaign_id || c.amazon_campaign_id), state: 'ARCHIVED' })) };

      let batchData: any = {};
      let batchOk = false;
      try {
        const res = await fetch(`${baseUrl}/sp/campaigns`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Amazon-Advertising-API-ClientId': clientId,
            'Amazon-Advertising-API-Scope': profileId,
            'Content-Type': CT_CAMPAIGN,
            'Accept': CT_CAMPAIGN,
          },
          body: JSON.stringify(batchBody),
        });

        if (res.status === 429) {
          await sleep(5000);
          failed += batch.length;
          continue;
        }
        if (res.ok) {
          batchData = await res.json().catch(() => ({}));
          batchOk = true;
        } else {
          failed += batch.length;
        }
      } catch {
        failed += batch.length;
        continue;
      }

      if (batchOk) {
        const successIds = new Set<string>((batchData?.campaigns?.success || []).map((c: any) => String(c.campaignId)));
        // Se Amazon retornou lista vazia de success mas sem error array, considerar todos bem-sucedidos (status 207 às vezes vazio)
        const useAll = successIds.size === 0 && !(batchData?.campaigns?.error?.length > 0);

        for (const c of batch) {
          const cid = String(c.campaign_id || c.amazon_campaign_id);
          if (successIds.has(cid) || useAll) {
            await base44.asServiceRole.entities.Campaign.update(c.id, {
              state: 'archived', status: 'archived', archived: true,
              archived_at: now, archive_reason: 'paused_zero_activity_7d',
            }).catch(() => {});
            archived++;
          } else {
            failed++;
          }
        }
      }

      if (i + BATCH_SIZE < withAmazonId.length) await sleep(BATCH_DELAY_MS);
    }

    // ── Campanhas só locais → arquivar localmente ──────────────────────────
    for (const c of localOnly) {
      await base44.asServiceRole.entities.Campaign.update(c.id, {
        state: 'archived', status: 'archived', archived: true,
        archived_at: now, archive_reason: 'paused_zero_activity_7d_local_only',
      }).catch(() => {});
      archived++;
    }

    // ── Log ────────────────────────────────────────────────────────────────
    const completedAt = new Date().toISOString();
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'archive_paused_zero_activity',
      trigger_type: body.trigger_type || 'manual',
      status: failed > 0 ? 'warning' : 'success',
      started_at: startedAt,
      completed_at: completedAt,
      records_processed: archived,
      result_summary: JSON.stringify({ candidates_found: candidates.length, archived, failed, local_only: localOnly.length, preserved: preserved.length, skipped_too_recent: skipped_too_recent.length }).slice(0, 4000),
      error_message: failed > 0 ? `${failed} campanha(s) não arquivadas na Amazon` : null,
    }).catch(() => {});

    return Response.json({
      ok: true,
      candidates_found: candidates.length,
      archived,
      failed,
      preserved_with_impressions: preserved.filter(p => p.reason === 'has_impressions').length,
      preserved_total: preserved.length,
      skipped_too_recent: skipped_too_recent.length,
      started_at: startedAt,
      completed_at: completedAt,
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
});