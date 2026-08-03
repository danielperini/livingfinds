/**
 * deduplicateAutoCampaignsByAsin v2
 * Para cada ASIN com mais de 1 campanha AUTO não-arquivada:
 * - Mantém a de maior lucro, vendas, pedidos e histórico; gasto nunca decide sozinho
 * - Pausa as demais na Amazon (reversível; nunca exclui dados)
 * - Atualiza localmente somente após confirmação remota
 * - Registra SyncExecutionLog com total arquivado
 * Aceita dry_run: true para retornar candidatos sem executar.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

const ASIN_REGEX = /B0[A-Z0-9]{8}/i;

function extractAsin(campaign: any): string | null {
  if (campaign.asin) return campaign.asin;
  const name = campaign.name || campaign.campaign_name || '';
  const match = name.match(ASIN_REGEX);
  return match ? match[0].toUpperCase() : null;
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, dry_run = false } = body;
    const requestedAsins = new Set((Array.isArray(body.asins) ? body.asins : [])
      .map((value: unknown) => String(value || '').trim().toUpperCase()).filter(Boolean));

    // Resolver conta
    let account: any;
    if (amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id }, null, 1);
      account = accs[0];
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({}, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta configurada' }, { status: 404 });

    const accountId = account.id;

    // Carregar todas as campanhas AUTO não-arquivadas
    const allCampaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: accountId, targeting_type: 'AUTO' }, null, 3000
    ).catch(() => [] as any[]);

    const activeCampaigns = allCampaigns.filter((c: any) => {
      const s = (c.state || c.status || '').toLowerCase();
      return s !== 'archived';
    });

    // Agrupar por ASIN
    const byAsin = new Map<string, any[]>();
    for (const c of activeCampaigns) {
      const asin = extractAsin(c);
      if (!asin) continue;
      if (requestedAsins.size > 0 && !requestedAsins.has(asin)) continue;
      if (!byAsin.has(asin)) byAsin.set(asin, []);
      byAsin.get(asin)!.push(c);
    }

    const details: any[] = [];
    let totalArchived = 0;
    let totalFailed = 0;

    for (const [asin, group] of byAsin) {
      if (group.length <= 1) continue;

      // Proteger a campanha economicamente vencedora. Spend entra apenas no
      // cálculo de lucro, nunca como critério positivo isolado.
      group.sort((a: any, b: any) => {
        const profit = (row: any) => Number(row.sales || 0) - Number(row.spend || row.current_spend || 0);
        const protectedDiff = Number(b.protected_high_performance === true) - Number(a.protected_high_performance === true);
        if (protectedDiff !== 0) return protectedDiff;
        const profitDiff = profit(b) - profit(a);
        if (profitDiff !== 0) return profitDiff;
        const salesDiff = Number(b.sales || 0) - Number(a.sales || 0);
        if (salesDiff !== 0) return salesDiff;
        const ordersDiff = Number(b.orders || 0) - Number(a.orders || 0);
        if (ordersDiff !== 0) return ordersDiff;
        const historyDiff = Number(b.days_running || 0) - Number(a.days_running || 0);
        if (historyDiff !== 0) return historyDiff;
        const dateA = new Date(a.created_at || a.created_date || 0).getTime();
        const dateB = new Date(b.created_at || b.created_date || 0).getTime();
        return dateA - dateB; // mais antiga primeiro
      });

      const canonical = group[0];
      const duplicates = group.slice(1);

      for (const dup of duplicates) {
        const dupEntry: any = {
          asin,
          canonical_id: canonical.campaign_id,
          canonical_name: canonical.name || canonical.campaign_name,
          canonical_spend: Number(canonical.spend || 0),
          deduped_id: dup.campaign_id,
          deduped_name: dup.name || dup.campaign_name,
          deduped_spend: Number(dup.spend || 0),
          archived_on_amazon: false,
          archived_locally: false,
        };

        if (dry_run) {
          details.push(dupEntry);
          totalArchived++;
          continue;
        }

        // 1. Arquivar na Amazon (state: ARCHIVED)
        const amazonId = dup.amazon_campaign_id || dup.campaign_id;
        if (amazonId && String(amazonId) !== 'undefined' && String(amazonId) !== 'null') {
          try {
            const archiveResponse = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
              _service_role: true,
              amazon_account_id: accountId,
              operation: 'pauseConfirmedDuplicateAutoCampaign',
              path: '/sp/campaigns',
              method: 'PUT',
              content_type: 'application/vnd.spCampaign.v3+json',
              accept: 'application/vnd.spCampaign.v3+json',
              payload: { campaigns: [{ campaignId: String(amazonId), state: 'PAUSED' }] },
            });
            const archiveData = archiveResponse?.data || archiveResponse || {};
            if (archiveData.ok !== true) throw new Error(archiveData.error || archiveData.message ||
              JSON.stringify(archiveData.errors || archiveData).slice(0, 500) || 'Amazon não confirmou pausa');
            await sleep(300);
            const verifyResponse = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
              _service_role: true,
              amazon_account_id: accountId,
              operation: 'confirmPausedDuplicateAutoCampaign',
              path: '/sp/campaigns/list',
              method: 'POST',
              content_type: 'application/vnd.spCampaign.v3+json',
              accept: 'application/vnd.spCampaign.v3+json',
              payload: {
                stateFilter: { include: ['PAUSED'] },
                campaignIdFilter: { include: [String(amazonId)] },
                maxResults: 10,
              },
            });
            const verifyData = verifyResponse?.data || verifyResponse || {};
            const confirmedCampaign = (verifyData?.payload?.campaigns || []).find((row: any) =>
              String(row?.campaignId || '') === String(amazonId));
            const remoteState = String(confirmedCampaign?.state || '').toUpperCase();
            if (verifyData.ok !== true || remoteState !== 'PAUSED') {
              throw new Error(`Estado remoto não confirmado como PAUSED: ${remoteState || 'desconhecido'}`);
            }
            dupEntry.archived_on_amazon = true;
          } catch (e: any) {
            console.warn(`[dedup] Falha ao arquivar ${amazonId} na Amazon:`, e.message);
            dupEntry.error = String(e?.message || e).slice(0, 500);
            totalFailed++;
          }
        }

        // 2. O app só muda depois da confirmação direta na Amazon.
        if (dupEntry.archived_on_amazon) {
          await base44.asServiceRole.entities.Campaign.update(dup.id, {
            state: 'paused',
            status: 'paused',
            amazon_status: 'paused',
            is_operational: false,
            reconciliation_status: 'ok',
            reconciliation_notes: 'DUPLICATE_AUTO_CAMPAIGN_PAUSED_CONFIRMED',
            archived: false,
            synced_at: new Date().toISOString(),
          }).catch(() => {});
          dupEntry.archived_locally = true;
          totalArchived++;
        }

        details.push(dupEntry);
      }
    }

    // Registrar log
    if (!dry_run) {
      const now = new Date().toISOString();
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: accountId,
        operation: 'deduplicateAutoCampaignsByAsin_v2',
        status: totalFailed === 0 ? 'success' : 'warning',
        trigger_type: 'manual',
        started_at: now,
        completed_at: new Date().toISOString(),
        records_processed: totalArchived,
        result_summary: JSON.stringify({ archived: totalArchived, failed: totalFailed, asins: byAsin.size }).slice(0, 2000),
        error_message: totalFailed > 0 ? `${totalFailed} falha(s) ao arquivar na Amazon` : null,
      }).catch(() => {});
    }

    return Response.json({
      ok: true,
      dry_run,
      archived: dry_run ? 0 : totalArchived,
      candidates: dry_run ? totalArchived : undefined,
      failed: totalFailed,
      asins_processed: [...byAsin.values()].filter(g => g.length > 1).length,
      asin_scope_count: requestedAsins.size,
      details,
      duration_ms: Date.now() - t0,
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});
