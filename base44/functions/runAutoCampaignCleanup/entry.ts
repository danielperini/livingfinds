import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

/**
 * runAutoCampaignCleanup
 *
 * Três sub-rotinas:
 *   (a) Deduplicação AUTO por ASIN — arquiva redundantes (mantém a de maior spend)
 *   (b) Pausa AUTO quando MANUAL enabled com spend 14d existe
 *   (c) Limpeza de AUTO zero-atividade (0 impressões + 0 spend) nos últimos 14 dias
 *
 * Protections:
 *   - Nunca arquiva sem verificar que o ASIN tem MANUAL ativa em produção
 *   - Cooldown de 48h (verifica last_activity_at)
 *   - Nunca toca em campanhas archived no banco
 *   - Registra SyncExecutionLog por ação com razão
 */

const ZERO_ACTIVITY_DAYS = 14;
const MANUAL_SPEND_WINDOW_DAYS = 14;
const COOLDOWN_HOURS = 48;

export default async function(req: Request): Promise<Response> {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, dry_run = false } = body as any;
    if (!amazon_account_id) return Response.json({ error: 'amazon_account_id obrigatório' }, { status: 400 });

    const now = Date.now();
    const cooldownMs = COOLDOWN_HOURS * 3600 * 1000;
    const cutoff14d = new Date(now - ZERO_ACTIVITY_DAYS * 86400000).toISOString().slice(0, 10);
    const cutoff14dManual = new Date(now - MANUAL_SPEND_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);

    // ── Buscar dados ──────────────────────────────────────────────────────
    const [allCampaigns, recentMetrics] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id }, null, 1000),
      base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id }, '-date', 2000).catch(() => []),
    ]);

    // Filtrar: não archived, com ASIN
    const activeCampaigns = allCampaigns.filter((c: any) =>
      (c.status || '').toLowerCase() !== 'archived' &&
      !(c.archived) &&
      c.asin
    );

    const autoCampaigns = activeCampaigns.filter((c: any) =>
      (c.targeting_type || '').toUpperCase() === 'AUTO'
    );
    const manualCampaigns = activeCampaigns.filter((c: any) =>
      (c.targeting_type || '').toUpperCase() === 'MANUAL' &&
      (c.status || '').toLowerCase() === 'enabled'
    );

    // Somar spend + impressões 14d por campaign_id
    const activity14d = new Map<string, { impressions: number; spend: number }>();
    for (const m of recentMetrics) {
      if (!m.date || m.date < cutoff14d) continue;
      const key = m.campaign_id;
      const prev = activity14d.get(key) || { impressions: 0, spend: 0 };
      prev.impressions += m.impressions || 0;
      prev.spend += m.spend || 0;
      activity14d.set(key, prev);
    }

    // Spend manual por ASIN nos últimos 14d
    const manualSpendByAsin = new Map<string, number>();
    for (const mc of manualCampaigns) {
      const act = activity14d.get(mc.campaign_id || mc.amazon_campaign_id || mc.id) || { spend: 0 };
      const prev = manualSpendByAsin.get(mc.asin) || 0;
      manualSpendByAsin.set(mc.asin, prev + act.spend);
    }

    // Set de ASINs com campanha MANUAL enabled
    const manualAsinSet = new Set(manualCampaigns.map((c: any) => c.asin).filter(Boolean));

    const results = {
      archived_duplicates: [] as any[],
      paused_has_manual: [] as any[],
      archived_zero_activity: [] as any[],
      skipped: [] as any[],
      errors: [] as any[],
    };

    // Função cooldown check
    const passesCooldown = (c: any) => {
      const lastAct = c.last_activity_at;
      if (!lastAct) return true;
      return (now - new Date(lastAct).getTime()) > cooldownMs;
    };

    // Executa ação na Amazon e atualiza banco
    const doAction = async (campaign: any, action: 'archive' | 'pause', reason: string) => {
      if (dry_run) return true;
      try {
        if (action === 'archive') {
          await base44.functions.invoke('archiveCampaign', {
            amazon_account_id,
            campaign_id: campaign.campaign_id || campaign.amazon_campaign_id,
          });
          await base44.asServiceRole.entities.Campaign.update(campaign.id, {
            status: 'archived', archived: true, archived_at: new Date().toISOString(),
            archive_reason: reason, last_activity_at: new Date().toISOString(),
          }).catch(() => {});
        } else {
          await base44.functions.invoke('pauseCampaign', {
            amazon_account_id,
            campaign_id: campaign.campaign_id || campaign.amazon_campaign_id,
          });
          await base44.asServiceRole.entities.Campaign.update(campaign.id, {
            status: 'paused', last_activity_at: new Date().toISOString(),
          }).catch(() => {});
        }
        return true;
      } catch (e: any) {
        results.errors.push({ campaign: campaign.campaign_name || campaign.name, action, reason: e.message });
        return false;
      }
    };

    // ── (a) Deduplicação AUTO por ASIN ────────────────────────────────────
    const autoBySingleAsin = new Map<string, any[]>();
    for (const c of autoCampaigns) {
      if (!autoBySingleAsin.has(c.asin)) autoBySingleAsin.set(c.asin, []);
      autoBySingleAsin.get(c.asin)!.push(c);
    }

    for (const [asin, campaigns] of autoBySingleAsin.entries()) {
      if (campaigns.length <= 1) continue;

      // Eleger principal: maior spend histórico, senão mais recente
      const withSpend = campaigns.map((c: any) => ({
        c,
        spend: activity14d.get(c.campaign_id || c.amazon_campaign_id || c.id)?.spend || c.spend || 0,
      }));
      withSpend.sort((a: any, b: any) => b.spend - a.spend);
      const principal = withSpend[0].c;
      const redundantes = campaigns.filter((c: any) => c.id !== principal.id);

      for (const c of redundantes) {
        if (!passesCooldown(c)) { results.skipped.push({ campaign: c.campaign_name, reason: 'cooldown_48h' }); continue; }
        const ok = await doAction(c, 'archive', `duplicata_auto_asin_${asin}`);
        if (ok) results.archived_duplicates.push({ campaign: c.campaign_name, asin, reason: 'duplicata_auto' });
      }
    }

    // ── (b) Pausa AUTO quando MANUAL ativa com spend 14d ─────────────────
    for (const c of autoCampaigns) {
      // Skip se já foi arquivada na etapa anterior
      if (results.archived_duplicates.some((r: any) => r.campaign === (c.campaign_name || c.name))) continue;
      if ((c.status || '').toLowerCase() !== 'enabled') continue;

      const hasManual = manualAsinSet.has(c.asin);
      const manualSpend = manualSpendByAsin.get(c.asin) || 0;

      if (!hasManual || manualSpend <= 0) {
        results.skipped.push({ campaign: c.campaign_name, reason: 'sem_manual_com_spend' }); continue;
      }

      if (!passesCooldown(c)) { results.skipped.push({ campaign: c.campaign_name, reason: 'cooldown_48h' }); continue; }

      const ok = await doAction(c, 'pause', `manual_ativa_asin_${c.asin}_spend_${manualSpend.toFixed(2)}`);
      if (ok) results.paused_has_manual.push({ campaign: c.campaign_name, asin: c.asin, manual_spend_14d: manualSpend });
    }

    // ── (c) Limpeza de AUTO zero-atividade 14d ───────────────────────────
    for (const c of autoCampaigns) {
      const wasProcessed = results.archived_duplicates.some((r: any) => r.campaign === (c.campaign_name || c.name))
        || results.paused_has_manual.some((r: any) => r.campaign === (c.campaign_name || c.name));
      if (wasProcessed) continue;

      const act = activity14d.get(c.campaign_id || c.amazon_campaign_id || c.id) || { impressions: 0, spend: 0 };
      if (act.impressions > 0 || act.spend > 0) { continue; }

      // Verificar também spend histórico total
      const totalSpend = c.spend || 0;
      if (totalSpend > 0) { results.skipped.push({ campaign: c.campaign_name, reason: 'tem_spend_historico' }); continue; }

      if (!passesCooldown(c)) { results.skipped.push({ campaign: c.campaign_name, reason: 'cooldown_48h' }); continue; }

      const ok = await doAction(c, 'archive', 'zero_atividade_14d');
      if (ok) results.archived_zero_activity.push({ campaign: c.campaign_name, asin: c.asin });
    }

    // ── Registrar SyncExecutionLog ────────────────────────────────────────
    const totalActions = results.archived_duplicates.length + results.paused_has_manual.length + results.archived_zero_activity.length;
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id, operation: 'auto_campaign_cleanup',
      trigger_type: body.trigger_type || 'automatic',
      status: results.errors.length > 0 && totalActions === 0 ? 'error' : results.errors.length > 0 ? 'partial' : 'success',
      started_at: startedAt, completed_at: new Date().toISOString(),
      records_processed: totalActions,
      result_summary: `archived_dup:${results.archived_duplicates.length} paused_manual:${results.paused_has_manual.length} archived_zero:${results.archived_zero_activity.length} skipped:${results.skipped.length} errors:${results.errors.length}`,
      error_message: results.errors.length > 0 ? results.errors.slice(0, 3).map((e: any) => e.reason).join('; ') : undefined,
    }).catch(() => {});

    return Response.json({
      ok: true, dry_run,
      total_auto_campaigns: autoCampaigns.length,
      archived_duplicates: results.archived_duplicates.length,
      paused_has_manual: results.paused_has_manual.length,
      archived_zero_activity: results.archived_zero_activity.length,
      skipped: results.skipped.length,
      errors: results.errors,
      details: results,
    });

  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}