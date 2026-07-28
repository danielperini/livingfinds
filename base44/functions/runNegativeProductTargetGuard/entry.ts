import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

/**
 * runNegativeProductTargetGuard
 *
 * Para cada campanha MANUAL EXACT com ≥7 dias de dados:
 * - Identifica ASINs de terceiros nos relatórios de Product Targeting com
 *   clicks >= 3 e orders = 0 nos últimos 14 dias.
 * - Insere NegativeProductTarget via Amazon Ads API para cada ASIN canibalizador.
 * - Registra OptimizationDecision por inserção e alerta em caso de falha de API.
 */

function todayBRT() { return new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10); }
function nowIso() { return new Date().toISOString(); }
function daysAgo(n: number) { return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); }

Deno.serve(async (req) => {
  const startedAt = nowIso();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const amazon_account_id = body.amazon_account_id;
    if (!amazon_account_id) return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });

    const today = todayBRT();
    const window14Start = daysAgo(14);
    const MIN_CLICKS = Number(body.min_clicks ?? 3);
    const MIN_CAMPAIGN_DAYS = Number(body.min_campaign_days ?? 7);

    // ── 1. Carregar campanhas MANUAL EXACT elegíveis ──────────────────────
    const campaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id, targeting_type: 'MANUAL' }, null, 500
    ).catch(() => []);

    const eligibleCampaigns = campaigns.filter((c: any) => {
      const state = (c.state || c.status || '').toLowerCase();
      if (state === 'archived') return false;
      const created = c.created_at || c.start_date || '';
      if (created) {
        const daysRunning = (Date.now() - new Date(created).getTime()) / 86400000;
        if (daysRunning < MIN_CAMPAIGN_DAYS) return false;
      }
      return true;
    });

    if (eligibleCampaigns.length === 0) {
      return Response.json({ ok: true, message: 'Nenhuma campanha MANUAL elegível encontrada', negatives_inserted: 0 });
    }

    const campaignIds = eligibleCampaigns.map((c: any) => c.campaign_id || c.id).filter(Boolean);

    // ── 2. Carregar Ad Groups para mapear campaignId → adGroupId ─────────
    const adGroups = await base44.asServiceRole.entities.AdGroup.filter(
      { amazon_account_id }, null, 1000
    ).catch(() => []);

    const adGroupByCampaign = new Map<string, string>(); // campaignId → adGroupId
    for (const ag of adGroups) {
      if (ag.campaign_id && ag.ad_group_id) {
        if (!adGroupByCampaign.has(ag.campaign_id)) {
          adGroupByCampaign.set(ag.campaign_id, ag.ad_group_id);
        }
      }
    }

    // ── 3. Ler relatório de Product Targeting dos últimos 14 dias ─────────
    // Fonte: ProductTarget entity (sincronizado via relatórios)
    const productTargets = await base44.asServiceRole.entities.ProductTarget.filter(
      { amazon_account_id }, null, 2000
    ).catch(() => []);

    // Filtrar: targetType=ASIN, orders=0, clicks>=MIN_CLICKS, janela 14 dias
    // Agrupar por adGroupId + targetedAsin para somar métricas
    const candidateMap = new Map<string, { adGroupId: string; campaignId: string; targetedAsin: string; clicks: number; orders: number }>();

    for (const pt of productTargets) {
      const expression = String(pt.expression || pt.target_expression || '');
      const isAsinTarget = expression.toLowerCase().includes('asinsame') || pt.target_type === 'ASIN';
      if (!isAsinTarget) continue;

      const campaignId = pt.campaign_id;
      if (!campaignId || !campaignIds.includes(campaignId)) continue;

      const adGroupId = pt.ad_group_id || adGroupByCampaign.get(campaignId);
      if (!adGroupId) continue;

      // Extrair ASIN alvo da expressão
      let targetedAsin = pt.targeted_asin || pt.resolved_expression || '';
      if (!targetedAsin) {
        const match = expression.match(/asinSameAs[":\s]+([A-Z0-9]{10})/i);
        if (match) targetedAsin = match[1];
      }
      if (!targetedAsin || !/^[A-Z0-9]{10}$/i.test(targetedAsin)) continue;

      const clicks = Number(pt.clicks ?? 0);
      const orders = Number(pt.orders ?? 0);
      if (clicks < MIN_CLICKS || orders > 0) continue;

      // Verificar se está dentro da janela de 14 dias
      const recordDate = pt.date || pt.synced_at || '';
      if (recordDate && recordDate < window14Start) continue;

      const key = `${adGroupId}::${targetedAsin}`;
      if (!candidateMap.has(key)) {
        candidateMap.set(key, { adGroupId, campaignId, targetedAsin, clicks: 0, orders: 0 });
      }
      const entry = candidateMap.get(key)!;
      entry.clicks += clicks;
      entry.orders += orders;
    }

    // Filtrar final: agregar e confirmar clicks >= MIN_CLICKS e orders = 0
    const candidates = Array.from(candidateMap.values()).filter(c => c.clicks >= MIN_CLICKS && c.orders === 0);

    if (candidates.length === 0) {
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id, operation: 'negative_product_target_guard',
        trigger_type: 'automatic', status: 'success',
        execution_date: today, started_at: startedAt, completed_at: nowIso(),
        result_summary: 'Nenhum ASIN canibalizador detectado na janela de 14 dias',
        records_processed: 0,
      }).catch(() => {});
      return Response.json({ ok: true, message: 'Nenhum ASIN canibalizador detectado', negatives_inserted: 0, campaigns_evaluated: eligibleCampaigns.length });
    }

    // ── 4. Verificar negativos já existentes para evitar duplicatas ────────
    const existingDecisions = await base44.asServiceRole.entities.OptimizationDecision.filter(
      { amazon_account_id, decision_type: 'target_change', entity_type: 'product_target', status: 'executed' },
      '-created_at', 500
    ).catch(() => []);

    const alreadyNegated = new Set(existingDecisions.map((d: any) => {
      try { const data = JSON.parse(d.data_used || '{}'); return `${data.ad_group_id}::${data.targeted_asin}`; } catch { return ''; }
    }).filter(Boolean));

    const toProcess = candidates.filter(c => !alreadyNegated.has(`${c.adGroupId}::${c.targetedAsin}`));

    // ── 5. Executar inserção via Amazon Ads API ───────────────────────────
    let inserted = 0;
    let failed = 0;

    // Carregar perfil
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter(
      { id: amazon_account_id }, null, 1
    ).catch(() => []);
    const account = accounts[0];
    const profileId = account?.ads_profile_id;

    for (const candidate of toProcess) {
      try {
        const payload = [{
          adGroupId: candidate.adGroupId,
          campaignId: candidate.campaignId,
          expression: [{ type: 'asinSameAs', value: candidate.targetedAsin }],
          expressionType: 'manual',
          state: 'enabled',
        }];

        const apiRes = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
          _service_role: true,
          amazon_account_id,
          profile_id: profileId,
          method: 'POST',
          path: '/sp/negativeTargets',
          body: payload,
        }).catch((e: any) => ({ data: { error: e?.message || 'invoke failed' } }));

        const apiData = apiRes?.data || apiRes || {};
        const success = !apiData?.error && (Array.isArray(apiData) ? apiData[0]?.code === 'SUCCESS' : apiData?.ok !== false);

        if (success) {
          await base44.asServiceRole.entities.OptimizationDecision.create({
            amazon_account_id,
            decision_type: 'target_change',
            entity_type: 'product_target',
            campaign_id: candidate.campaignId,
            ad_group_id: candidate.adGroupId,
            action: `Negativo de produto inserido: ASIN ${candidate.targetedAsin}`,
            rationale: `ASIN ${candidate.targetedAsin} identificado como canibalizador: ${candidate.clicks} clicks e 0 pedidos em 14 dias. Inserido como NegativeProductTarget no Ad Group ${candidate.adGroupId} para proteger a margem da campanha MANUAL EXACT.`,
            data_used: JSON.stringify({ ad_group_id: candidate.adGroupId, targeted_asin: candidate.targetedAsin, clicks: candidate.clicks, orders: 0, window_days: 14 }),
            confidence: 85,
            risk: 'low',
            requires_approval: false,
            status: 'executed',
            source_function: 'runNegativeProductTargetGuard',
            idempotency_key: `neg_target:${candidate.adGroupId}:${candidate.targetedAsin}:${today}`,
            evaluated_at: nowIso(),
            executed_at: nowIso(),
            created_at: nowIso(),
            updated_at: nowIso(),
          }).catch(() => {});
          inserted++;
        } else {
          throw new Error(String(apiData?.error || JSON.stringify(apiData)).slice(0, 300));
        }
      } catch (err: any) {
        failed++;
        const errMsg = String(err?.message || err).slice(0, 400);
        console.error(`[runNegativeProductTargetGuard] Falha ao inserir negativo para ${candidate.targetedAsin}:`, errMsg);

        await base44.asServiceRole.entities.SyncExecutionLog.create({
          amazon_account_id, operation: 'negative_product_target_guard:api_error',
          trigger_type: 'automatic', status: 'error',
          execution_date: today, started_at: startedAt, completed_at: nowIso(),
          error_message: `ASIN ${candidate.targetedAsin} | AdGroup ${candidate.adGroupId}: ${errMsg}`,
        }).catch(() => {});

        // Alert de severidade média por falha individual
        const dedupKey = `neg_target_fail:${candidate.adGroupId}:${candidate.targetedAsin}:${today}`;
        const existingAlert = await base44.asServiceRole.entities.Alert.filter(
          { amazon_account_id, deduplication_key: dedupKey }, null, 1
        ).catch(() => []);

        if (existingAlert.length === 0) {
          await base44.asServiceRole.entities.Alert.create({
            amazon_account_id,
            alert_type: 'sync_error',
            alert_family: 'campaign',
            severity: 'medium',
            status: 'active',
            title: `Falha ao inserir NegativeProductTarget: ${candidate.targetedAsin}`,
            message: errMsg,
            deduplication_key: dedupKey,
            ad_group_id: candidate.adGroupId,
            campaign_id: candidate.campaignId,
            source_function: 'runNegativeProductTargetGuard',
            first_detected_at: nowIso(),
            last_detected_at: nowIso(),
            created_at: nowIso(),
            updated_at: nowIso(),
          }).catch(() => {});
        }
      }
    }

    // ── 6. Log final ──────────────────────────────────────────────────────
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id, operation: 'negative_product_target_guard',
      trigger_type: 'automatic', status: 'success',
      execution_date: today, started_at: startedAt, completed_at: nowIso(),
      records_processed: inserted,
      result_summary: JSON.stringify({
        campaigns_evaluated: eligibleCampaigns.length,
        candidates_found: candidates.length,
        already_negated: candidates.length - toProcess.length,
        inserted,
        failed,
      }).slice(0, 2000),
    }).catch(() => {});

    return Response.json({
      ok: true,
      campaigns_evaluated: eligibleCampaigns.length,
      candidates_found: candidates.length,
      negatives_inserted: inserted,
      negatives_failed: failed,
      skipped_already_negated: candidates.length - toProcess.length,
    });

  } catch (error: any) {
    console.error('[runNegativeProductTargetGuard] erro:', error?.message);
    return Response.json({ ok: false, error: error?.message }, { status: 500 });
  }
});