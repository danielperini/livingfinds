/**
 * forcePauseCampaignsByAsin
 *
 * Pausa forçada em lote de campanhas divergentes (state=paused no DB mas amazon_status=enabled na API).
 * Suporta dry_run=true para diagnóstico sem aplicar mudanças.
 *
 * Payload: { amazon_account_id, asin?, dry_run?, _service_role? }
 * Returns: { total_found, paused_ok, paused_failed, campaign_ids_failed, dry_run_details? }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const BATCH_SIZE = 10;
const MAX_CAMPAIGNS = 50;
const TIME_LIMIT_MS = 85000;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function chunks<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}

function unique(arr: string[]): string[] {
  return [...new Set(arr.filter(Boolean))];
}

function norm(s: any): string {
  return String(s || '').toLowerCase().trim();
}

async function getToken(refreshToken: string): Promise<string> {
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: Deno.env.get('ADS_CLIENT_ID') || '',
      client_secret: Deno.env.get('ADS_CLIENT_SECRET') || '',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`Token error ${res.status}: ${data.error_description || data.error || ''}`);
  return data.access_token;
}

function getBaseUrl(region?: string): string {
  const r = String(region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

/** PUT /sp/campaigns — pausa em lote (até 10 por chamada) */
async function pauseBatch(token: string, profileId: string, baseUrl: string, ids: string[]): Promise<{ paused: string[]; failed: string[] }> {
  const CT = 'application/vnd.spCampaign.v3+json';
  const res = await fetch(`${baseUrl}/sp/campaigns`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': profileId,
      'Content-Type': CT,
      'Accept': CT,
    },
    body: JSON.stringify({ campaigns: ids.map(id => ({ campaignId: id, state: 'PAUSED' })) }),
  });

  const data = await res.json().catch(() => ({}));
  const successes: string[] = [];
  const failures: string[] = [];

  // v3 format: { campaigns: { success: [...], error: [...] } }
  const successList = data?.campaigns?.success || data?.success || [];
  const errorList = data?.campaigns?.error || data?.error || [];

  for (const s of successList) {
    const id = s?.campaignId || s?.campaign?.campaignId;
    if (id) successes.push(String(id));
  }
  for (const e of errorList) {
    const id = e?.campaignId || e?.campaign?.campaignId;
    if (id) failures.push(String(id));
  }

  // Se não houve resposta estruturada mas o PUT foi ok (2xx), considerar todos pausados
  if (!res.ok) {
    return { paused: [], failed: ids };
  }
  if (successes.length === 0 && errorList.length === 0 && res.ok) {
    return { paused: ids, failed: [] };
  }
  return { paused: successes, failed: failures };
}

/** GET /sp/campaigns/list — confirma estado real após pausa */
async function confirmState(token: string, profileId: string, baseUrl: string, ids: string[]): Promise<Map<string, string>> {
  const CT = 'application/vnd.spCampaign.v3+json';
  const res = await fetch(`${baseUrl}/sp/campaigns/list`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': profileId,
      'Content-Type': CT,
      'Accept': CT,
    },
    body: JSON.stringify({ campaignIdFilter: { include: ids }, maxResults: ids.length }),
  });
  const data = await res.json().catch(() => ({}));
  const stateMap = new Map<string, string>();
  for (const c of (data?.campaigns || [])) {
    if (c?.campaignId) stateMap.set(String(c.campaignId), String(c.state || '').toUpperCase());
  }
  return stateMap;
}

export default async function(req: Request): Promise<Response> {
  const t0 = Date.now();
  const now = new Date().toISOString();

  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    // Auth: aceita _service_role (automação) ou usuário autenticado
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const { amazon_account_id, asin, dry_run = false } = body;
    if (!amazon_account_id) return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });

    // Resolver conta
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id }, null, 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' }, { status: 404 });

    const refreshToken = Deno.env.get('ADS_REFRESH_TOKEN') || account.ads_refresh_token;
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    if (!refreshToken || !profileId) return Response.json({ ok: false, error: 'Credenciais Ads ausentes' }, { status: 400 });

    // Buscar campanhas divergentes: state=paused no DB mas amazon_status=enabled
    const query: any = {
      amazon_account_id,
      $or: [
        { state: 'paused', amazon_status: 'ENABLED' },
        { state: 'paused', amazon_status: 'enabled' },
        { status: 'paused', amazon_status: 'ENABLED' },
        { status: 'paused', amazon_status: 'enabled' },
      ],
    };

    // Filtro por ASIN se fornecido
    let allDivergent = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id },
      null, 500
    ).catch(() => []);

    // Filtrar divergentes: (state=paused OU status=paused) E amazon_status=enabled/ENABLED
    allDivergent = allDivergent.filter((c: any) => {
      const localPaused = norm(c.state) === 'paused' || norm(c.status) === 'paused';
      const amazonEnabled = norm(c.amazon_status) === 'enabled';
      const notArchived = norm(c.state) !== 'archived' && c.archived !== true;
      const asinMatch = asin ? norm(c.asin) === norm(asin) : true;
      return localPaused && amazonEnabled && notArchived && asinMatch;
    });

    // Deduplicar por amazon_campaign_id
    const seen = new Set<string>();
    const divergent = allDivergent.filter((c: any) => {
      const id = String(c.campaign_id || c.amazon_campaign_id || '');
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    const totalFound = divergent.length;

    if (dry_run) {
      return Response.json({
        ok: true,
        dry_run: true,
        total_found: totalFound,
        campaigns: divergent.slice(0, 100).map((c: any) => ({
          id: c.id,
          amazon_campaign_id: c.campaign_id || c.amazon_campaign_id,
          name: c.name || c.campaign_name,
          asin: c.asin,
          local_state: c.state || c.status,
          amazon_status: c.amazon_status,
        })),
        message: `${totalFound} campanhas divergentes encontradas. dry_run=true, nenhuma ação aplicada.`,
      });
    }

    if (totalFound === 0) {
      return Response.json({
        ok: true,
        total_found: 0,
        paused_ok: 0,
        paused_failed: 0,
        campaign_ids_failed: [],
        message: 'Nenhuma divergência encontrada.',
      });
    }

    // Processar no máximo MAX_CAMPAIGNS por execução
    const toProcess = divergent.slice(0, MAX_CAMPAIGNS);
    const remaining = divergent.length - toProcess.length;

    let token: string;
    try {
      token = await getToken(refreshToken);
    } catch (e: any) {
      return Response.json({ ok: false, error: `Falha no token: ${e.message}` }, { status: 500 });
    }

    const baseUrl = getBaseUrl(account.region);
    const amazonIds = unique(toProcess.map((c: any) => String(c.campaign_id || c.amazon_campaign_id || '')).filter(Boolean));
    const batches = chunks(amazonIds, BATCH_SIZE);

    const pausedOk: string[] = [];
    const pausedFailed: string[] = [];
    let batchNum = 0;

    for (const batch of batches) {
      if (Date.now() - t0 > TIME_LIMIT_MS - 5000) break;

      batchNum++;
      let batchPaused: string[] = [];
      let batchFailed: string[] = [];

      try {
        const result = await pauseBatch(token, profileId, baseUrl, batch);
        batchPaused = result.paused;
        batchFailed = result.failed;
      } catch {
        batchFailed = batch;
      }

      // Confirmação pós-pausa (1 tentativa imediata)
      if (batchPaused.length > 0) {
        await sleep(1500);
        try {
          const stateMap = await confirmState(token, profileId, baseUrl, batchPaused);
          const confirmed: string[] = [];
          const stillEnabled: string[] = [];

          for (const id of batchPaused) {
            const realState = stateMap.get(id);
            if (realState === 'PAUSED' || realState === 'paused' || !realState) {
              confirmed.push(id);
            } else {
              // Still enabled after pause attempt — retry once after 3s
              stillEnabled.push(id);
            }
          }

          if (stillEnabled.length > 0) {
            await sleep(3000);
            try {
              const retry = await pauseBatch(token, profileId, baseUrl, stillEnabled);
              confirmed.push(...retry.paused);
              batchFailed.push(...retry.failed);
            } catch {
              batchFailed.push(...stillEnabled);
            }
          }

          batchPaused = confirmed;
        } catch {
          // confirmação falhou, manter como pausadas tentadas
        }
      }

      pausedOk.push(...batchPaused);
      pausedFailed.push(...batchFailed);

      // Atualizar banco local após cada lote confirmado
      const confirmedSet = new Set(batchPaused);
      const stillFailedSet = new Set(batchFailed);

      for (const campaign of toProcess) {
        const cid = String(campaign.campaign_id || campaign.amazon_campaign_id || '');
        if (!cid) continue;

        if (confirmedSet.has(cid)) {
          await base44.asServiceRole.entities.Campaign.update(campaign.id, {
            amazon_status: 'paused',
            state: 'paused',
            status: 'paused',
            requires_attention: false,
            last_activity_at: now,
            last_sync_at: now,
          }).catch(() => {});
        } else if (stillFailedSet.has(cid)) {
          await base44.asServiceRole.entities.Campaign.update(campaign.id, {
            requires_attention: true,
            last_activity_at: now,
          }).catch(() => {});
        }
      }

      // Log por lote
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id,
        operation: 'force_pause_campaigns_batch',
        trigger_type: body._service_role ? 'auto_repair' : 'user_action',
        status: batchFailed.length === 0 ? 'success' : batchPaused.length > 0 ? 'partial' : 'error',
        execution_date: now.slice(0, 10),
        started_at: now,
        completed_at: new Date().toISOString(),
        records_processed: batch.length,
        result_summary: JSON.stringify({
          batch: batchNum,
          asin: asin || 'all',
          attempted: batch.length,
          paused: batchPaused.length,
          failed: batchFailed.length,
        }),
      }).catch(() => {});

      if (batchNum < batches.length) await sleep(500);
    }

    // Se ficaram campanhas além do limite, enfileirar para próxima execução
    if (remaining > 0) {
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id,
        operation: 'force_pause_campaigns_queued',
        trigger_type: body._service_role ? 'auto_repair' : 'user_action',
        status: 'pending',
        execution_date: now.slice(0, 10),
        started_at: now,
        result_summary: `${remaining} campanhas restantes serão processadas na próxima execução`,
      }).catch(() => {});
    }

    return Response.json({
      ok: true,
      asin: asin || null,
      total_found: totalFound,
      processed: toProcess.length,
      paused_ok: pausedOk.length,
      paused_failed: pausedFailed.length,
      campaign_ids_failed: pausedFailed,
      remaining_queued: remaining,
      duration_ms: Date.now() - t0,
      message: `${pausedOk.length} campanhas pausadas na Amazon${pausedFailed.length > 0 ? `, ${pausedFailed.length} falharam` : ''}${remaining > 0 ? `, ${remaining} restantes p/ próxima execução` : ''}.`,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Erro interno' }, { status: 500 });
  }
}