import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

/**
 * runAutoCampaignCleanup v2
 *
 * CORREÇÃO PRINCIPAL: Chama a Amazon Ads API diretamente via PUT /v2/sp/campaigns
 * (obtendo o token via amazonAdsTokenManager), verifica o response antes de
 * atualizar o banco. O banco só é alterado após confirmação de sucesso da API.
 *
 * Três sub-rotinas:
 *   (a) Deduplicação AUTO por ASIN — arquiva redundantes (mantém a de maior spend)
 *   (b) Pausa AUTO quando MANUAL enabled com spend 14d existe
 *   (c) Limpeza de AUTO zero-atividade (0 impressões + 0 spend) nos últimos 14 dias
 *
 * Cooldown: campo dedicado cleanup_last_action_at (48h), separado do last_activity_at.
 * dry_run=true: retorna preview completo por regra sem tocar na Amazon.
 */

const ZERO_ACTIVITY_DAYS   = 14;
const MANUAL_SPEND_DAYS    = 14;
const COOLDOWN_HOURS       = 48;

async function getAdsToken(base44: any, amazon_account_id: string): Promise<string> {
  const res = await base44.asServiceRole.functions.invoke('amazonAdsTokenManager', {
    amazon_account_id,
    _service_role: true,
  });
  const data = res?.data || res || {};
  if (!data.ok || !data.access_token) {
    throw new Error(`Token Amazon Ads indisponível: ${data.message || data.error || 'erro desconhecido'}`);
  }
  return String(data.access_token);
}

function adsBase(region?: string): string {
  const r = String(region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

/**
 * Aplica archive ou pause na Amazon Ads API via PUT /v2/sp/campaigns.
 * Retorna { ok, http_status, detail } — NUNCA lança exceção para facilitar
 * o tratamento por campanha individual sem interromper o loop.
 */
async function callAmazonCampaignUpdate(
  accessToken: string,
  profileId: string,
  region: string | undefined,
  amazonCampaignId: string,
  state: 'archived' | 'paused',
): Promise<{ ok: boolean; http_status: number; detail: string }> {
  const base = adsBase(region);
  const url  = `${base}/v2/sp/campaigns`;
  const clientId = Deno.env.get('ADS_CLIENT_ID') || '';

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Amazon-Advertising-API-ClientId': clientId,
        'Amazon-Advertising-API-Scope': profileId,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify([{ campaignId: amazonCampaignId, state }]),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err: any) {
    return { ok: false, http_status: 0, detail: `network_error: ${err?.message}` };
  }

  const text = await response.text().catch(() => '');
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }

  // API retorna 207 com array de resultados — verificar code individual
  if (response.status === 207) {
    const item = Array.isArray(parsed) ? parsed[0] : (parsed?.campaigns?.[0] || parsed);
    const code = String(item?.code || '').toUpperCase();
    if (code === 'SUCCESS') {
      return { ok: true, http_status: 207, detail: 'SUCCESS' };
    }
    return { ok: false, http_status: 207, detail: `code=${code} description=${item?.description || text.slice(0, 200)}` };
  }

  const ok = response.status >= 200 && response.status < 300;
  return { ok, http_status: response.status, detail: text.slice(0, 300) };
}

export default async function handler(req: Request): Promise<Response> {
  const startedAt = new Date().toISOString();
  const base44 = createClientFromRequest(req);

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, dry_run = false, trigger_type = 'manual' } = body as any;
    if (!amazon_account_id) return Response.json({ error: 'amazon_account_id obrigatório' }, { status: 400 });

    // ── Buscar conta para obter profile_id e region ─────────────────────
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id }, null, 1);
    const account = accounts[0];
    if (!account) return Response.json({ error: 'Conta não encontrada' }, { status: 404 });

    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';
    const region    = account.region;

    // ── Token (só obter se não for dry_run) ────────────────────────────
    let accessToken = '';
    if (!dry_run) {
      try {
        accessToken = await getAdsToken(base44, amazon_account_id);
      } catch (e: any) {
        return Response.json({ ok: false, error: `Falha ao obter token Amazon Ads: ${e.message}` }, { status: 503 });
      }
    }

    const now       = Date.now();
    const cooldownMs = COOLDOWN_HOURS * 3600 * 1000;
    const cutoff14d  = new Date(now - ZERO_ACTIVITY_DAYS * 86400000).toISOString().slice(0, 10);

    // ── Buscar dados ───────────────────────────────────────────────────
    const [allCampaigns, recentMetrics] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id }, null, 1000),
      base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id }, '-date', 2000).catch(() => []),
    ]);

    // Só trabalhar com não-archived e com ASIN
    const activeCampaigns = allCampaigns.filter((c: any) =>
      (c.status || '').toLowerCase() !== 'archived' && !c.archived && c.asin
    );
    const autoCampaigns = activeCampaigns.filter((c: any) =>
      (c.targeting_type || '').toUpperCase() === 'AUTO'
    );
    const manualEnabled = activeCampaigns.filter((c: any) =>
      (c.targeting_type || '').toUpperCase() === 'MANUAL' &&
      (c.status || '').toLowerCase() === 'enabled'
    );

    // Somar spend + impressões 14d por campaign_id
    const activity14d = new Map<string, { impressions: number; spend: number }>();
    for (const m of recentMetrics) {
      if (!m.date || m.date < cutoff14d) continue;
      const cid = m.campaign_id;
      const prev = activity14d.get(cid) || { impressions: 0, spend: 0 };
      prev.impressions += m.impressions || 0;
      prev.spend       += m.spend || 0;
      activity14d.set(cid, prev);
    }

    // Spend manual por ASIN (últimos 14d)
    const manualSpendByAsin = new Map<string, number>();
    for (const mc of manualEnabled) {
      const cid   = mc.campaign_id || mc.amazon_campaign_id || mc.id;
      const spend = activity14d.get(cid)?.spend || 0;
      manualSpendByAsin.set(mc.asin, (manualSpendByAsin.get(mc.asin) || 0) + spend);
    }
    const manualAsinSet = new Set(manualEnabled.map((c: any) => c.asin).filter(Boolean));

    // Helpers
    const getAmazonId = (c: any): string => String(c.amazon_campaign_id || c.campaign_id || '').trim();

    // Cooldown: usa cleanup_last_action_at (isolado), fallback archived_at
    const passesCooldown = (c: any): boolean => {
      const ref = c.cleanup_last_action_at || (c.archived ? c.archived_at : null);
      if (!ref) return true;
      return (now - new Date(ref).getTime()) > cooldownMs;
    };

    // Conjuntos para evitar processar a mesma campanha 2x
    const processed = new Set<string>();

    const results = {
      archived_duplicates:   [] as any[],
      paused_has_manual:     [] as any[],
      archived_zero_activity:[] as any[],
      skipped:               [] as any[],
      errors:                [] as any[],
      preview:               {
        rule_a: [] as any[],
        rule_b: [] as any[],
        rule_c: [] as any[],
      },
    };

    /**
     * Executa a ação: chama a Amazon, atualiza banco SÓ após confirmação.
     * Retorna true se bem-sucedido.
     */
    const doAction = async (
      campaign: any,
      action: 'archive' | 'pause',
      reason: string,
    ): Promise<boolean> => {
      const aid = getAmazonId(campaign);
      if (!aid) {
        results.skipped.push({ campaign: campaign.campaign_name || campaign.name, reason: 'sem_amazon_campaign_id' });
        return false;
      }
      if (dry_run) return true; // dry_run: simular sucesso

      const state  = action === 'archive' ? 'archived' : 'paused';
      const apiRes = await callAmazonCampaignUpdate(accessToken, profileId, region, aid, state);

      if (!apiRes.ok) {
        const errMsg = `HTTP ${apiRes.http_status}: ${apiRes.detail}`;
        results.errors.push({
          campaign: campaign.campaign_name || campaign.name,
          amazon_campaign_id: aid,
          action,
          reason: errMsg,
          http_status: apiRes.http_status,
        });
        // Registrar falha isolada de API
        base44.asServiceRole.entities.SyncExecutionLog.create({
          amazon_account_id,
          operation: `auto_campaign_cleanup:${action}_failed`,
          trigger_type,
          status: 'error',
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          records_processed: 0,
          error_message: `${campaign.campaign_name}: ${errMsg}`,
          result_summary: JSON.stringify({ aid, action, http_status: apiRes.http_status }).slice(0, 500),
        }).catch(() => {});
        return false;
      }

      // ✅ Amazon confirmou — atualiza o banco imediatamente
      const patch: any = {
        cleanup_last_action_at: new Date().toISOString(),
      };
      if (action === 'archive') {
        patch.status       = 'archived';
        patch.archived     = true;
        patch.archived_at  = new Date().toISOString();
        patch.archive_reason = reason;
      } else {
        patch.status = 'paused';
      }
      await base44.asServiceRole.entities.Campaign.update(campaign.id, patch).catch(() => {});

      // ── Verificação pós-arquivamento (só para ações 'archive') ─────────
      if (action === 'archive') {
        // Aguardar 60s para propagação na Amazon
        await new Promise((r) => setTimeout(r, 60000));

        const base   = adsBase(region);
        const getUrl = `${base}/v2/sp/campaigns/${aid}`;
        const clientId = Deno.env.get('ADS_CLIENT_ID') || '';

        try {
          const verifyRes = await fetch(getUrl, {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Amazon-Advertising-API-ClientId': clientId,
              'Amazon-Advertising-API-Scope': profileId,
              'Accept': 'application/json',
            },
            signal: AbortSignal.timeout(15000),
          });
          const verifyText = await verifyRes.text().catch(() => '');
          let verifyData: any = {};
          try { verifyData = verifyText ? JSON.parse(verifyText) : {}; } catch {}

          const confirmedState = String(verifyData?.state || '').toLowerCase();
          if (confirmedState !== 'archived') {
            // Não revertemos o estado local — apenas alertamos
            const dedupKey = `archive_verify_${aid}`;
            await base44.asServiceRole.entities.Alert.create({
              amazon_account_id,
              alert_type: 'sync_error',
              alert_family: 'campaign',
              severity: 'high',
              status: 'active',
              entity_type: 'campaign',
              entity_id: campaign.id,
              campaign_id: aid,
              title: 'Arquivamento não confirmado pela Amazon',
              message: `A campanha "${campaign.campaign_name || campaign.name}" (ID: ${aid}) não retornou estado 'archived' após 60s. Estado lido: "${confirmedState || 'desconhecido'}". Verifique manualmente no Amazon Ads.`,
              deduplication_key: dedupKey,
              source_function: 'runAutoCampaignCleanup',
              created_at: new Date().toISOString(),
            }).catch(() => {});

            await base44.asServiceRole.entities.Campaign.update(campaign.id, {
              reconciliation_status: 'review_required',
            }).catch(() => {});
          }
        } catch {
          // Falha na verificação — criar alerta preventivo
          const dedupKey = `archive_verify_${aid}`;
          await base44.asServiceRole.entities.Alert.create({
            amazon_account_id,
            alert_type: 'sync_error',
            alert_family: 'campaign',
            severity: 'high',
            status: 'active',
            entity_type: 'campaign',
            entity_id: campaign.id,
            campaign_id: aid,
            title: 'Arquivamento não confirmado pela Amazon',
            message: `Não foi possível verificar o estado da campanha "${campaign.campaign_name || campaign.name}" (ID: ${aid}) após arquivamento. Verifique manualmente no Amazon Ads.`,
            deduplication_key: `archive_verify_${aid}`,
            source_function: 'runAutoCampaignCleanup',
            created_at: new Date().toISOString(),
          }).catch(() => {});
        }
      }

      return true;
    };

    // ── (a) Deduplicação AUTO por ASIN ────────────────────────────────
    const autoBySingleAsin = new Map<string, any[]>();
    for (const c of autoCampaigns) {
      if (!autoBySingleAsin.has(c.asin)) autoBySingleAsin.set(c.asin, []);
      autoBySingleAsin.get(c.asin)!.push(c);
    }

    for (const [asin, group] of autoBySingleAsin.entries()) {
      if (group.length <= 1) continue;

      const withSpend = group
        .map((c: any) => ({
          c,
          spend: activity14d.get(c.campaign_id || c.amazon_campaign_id || c.id)?.spend || c.spend || 0,
        }))
        .sort((a: any, b: any) => b.spend - a.spend);

      const principal   = withSpend[0].c;
      const redundantes = group.filter((c: any) => c.id !== principal.id);

      for (const c of redundantes) {
        const aid = getAmazonId(c);
        const preview = {
          campaign: c.campaign_name || c.name,
          asin,
          amazon_campaign_id: aid,
          action: 'archive',
          reason: 'duplicata_auto',
          passes_cooldown: passesCooldown(c),
          has_amazon_id: !!aid,
        };
        results.preview.rule_a.push(preview);

        if (!aid) { results.skipped.push({ campaign: preview.campaign, reason: 'sem_amazon_campaign_id' }); continue; }
        if (!passesCooldown(c)) { results.skipped.push({ campaign: preview.campaign, reason: 'cooldown_48h' }); continue; }

        const ok = await doAction(c, 'archive', `duplicata_auto_asin_${asin}`);
        if (ok) { results.archived_duplicates.push(preview); processed.add(c.id); }
      }
    }

    // ── (b) Pausa AUTO com MANUAL ativa e spend > 0 ────────────────────
    for (const c of autoCampaigns) {
      if (processed.has(c.id)) continue;
      if ((c.status || '').toLowerCase() !== 'enabled') continue;

      const manualSpend = manualSpendByAsin.get(c.asin) || 0;
      const hasManual   = manualAsinSet.has(c.asin);
      const aid         = getAmazonId(c);

      const preview = {
        campaign: c.campaign_name || c.name,
        asin: c.asin,
        amazon_campaign_id: aid,
        action: 'pause',
        reason: `manual_ativa_spend_14d=${manualSpend.toFixed(2)}`,
        passes_cooldown: passesCooldown(c),
        has_amazon_id: !!aid,
      };
      results.preview.rule_b.push({ ...preview, has_manual: hasManual, manual_spend_14d: manualSpend });

      if (!hasManual || manualSpend <= 0) { results.skipped.push({ campaign: preview.campaign, reason: 'sem_manual_com_spend' }); continue; }
      if (!aid) { results.skipped.push({ campaign: preview.campaign, reason: 'sem_amazon_campaign_id' }); continue; }
      if (!passesCooldown(c)) { results.skipped.push({ campaign: preview.campaign, reason: 'cooldown_48h' }); continue; }

      const ok = await doAction(c, 'pause', preview.reason);
      if (ok) { results.paused_has_manual.push({ ...preview, manual_spend_14d: manualSpend }); processed.add(c.id); }
    }

    // ── (c) Archive AUTO zero-atividade 14d ───────────────────────────
    for (const c of autoCampaigns) {
      if (processed.has(c.id)) continue;

      const cid = c.campaign_id || c.amazon_campaign_id || c.id;
      const act = activity14d.get(cid) || { impressions: 0, spend: 0 };
      const aid = getAmazonId(c);

      const preview = {
        campaign: c.campaign_name || c.name,
        asin: c.asin,
        amazon_campaign_id: aid,
        action: 'archive',
        reason: 'zero_atividade_14d',
        passes_cooldown: passesCooldown(c),
        has_amazon_id: !!aid,
        impressions_14d: act.impressions,
        spend_14d: act.spend,
      };
      results.preview.rule_c.push(preview);

      if (act.impressions > 0 || act.spend > 0) { continue; } // tem atividade
      if ((c.spend || 0) > 0) { results.skipped.push({ campaign: preview.campaign, reason: 'tem_spend_historico' }); continue; }
      if (!aid) { results.skipped.push({ campaign: preview.campaign, reason: 'sem_amazon_campaign_id' }); continue; }
      if (!passesCooldown(c)) { results.skipped.push({ campaign: preview.campaign, reason: 'cooldown_48h' }); continue; }

      const ok = await doAction(c, 'archive', 'zero_atividade_14d');
      if (ok) { results.archived_zero_activity.push(preview); processed.add(c.id); }
    }

    // ── Log final ──────────────────────────────────────────────────────
    const totalActions = results.archived_duplicates.length + results.paused_has_manual.length + results.archived_zero_activity.length;
    const finalStatus  = results.errors.length > 0 && totalActions === 0 ? 'error'
      : results.errors.length > 0 ? 'partial' : 'success';

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id,
      operation: 'auto_campaign_cleanup',
      trigger_type,
      status: dry_run ? 'skipped' : finalStatus,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      records_processed: totalActions,
      result_summary: dry_run
        ? `dry_run: rule_a=${results.preview.rule_a.length} rule_b=${results.preview.rule_b.length} rule_c=${results.preview.rule_c.length}`
        : `archived_dup:${results.archived_duplicates.length} paused_manual:${results.paused_has_manual.length} archived_zero:${results.archived_zero_activity.length} skipped:${results.skipped.length} errors:${results.errors.length}`,
      error_message: results.errors.length > 0
        ? results.errors.slice(0, 3).map((e: any) => `${e.campaign}: HTTP ${e.http_status} ${e.reason}`).join(' | ')
        : undefined,
    }).catch(() => {});

    return Response.json({
      ok: true,
      dry_run,
      total_auto_campaigns: autoCampaigns.length,
      archived_duplicates:   results.archived_duplicates.length,
      paused_has_manual:     results.paused_has_manual.length,
      archived_zero_activity:results.archived_zero_activity.length,
      skipped: results.skipped.length,
      errors:  results.errors,
      preview: results.preview,
    });

  } catch (error: any) {
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: '',
      operation: 'auto_campaign_cleanup',
      trigger_type: 'automatic',
      status: 'error',
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      records_processed: 0,
      error_message: error.message,
    }).catch(() => {});
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}