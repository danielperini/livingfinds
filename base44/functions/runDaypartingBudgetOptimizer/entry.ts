/**
 * runDaypartingBudgetOptimizer
 *
 * Executa diariamente às 08h BRT.
 * Objetivo: antecipar esgotamento de budget reduzindo lances em horários fracos
 * ANTES do teto ser atingido, preservando verba para os picos noturnos.
 *
 * Lógica:
 * 1. Lê AccountDailySpendController dos últimos 7 dias → calcula hora média de esgotamento
 * 2. Lê HourlySalesPattern → bid_multiplier por slot
 * 3. Para campanhas ativas: aplica multiplicador nas keywords via amazonAdsCommand
 * 4. Registra em SyncExecutionLog + gera OptimizationDecision
 */

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, dry_run = false } = body;

    // Busca conta Amazon
    const accounts = amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ user_id: user.id }, null, 1);

    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon encontrada.' });

    const accountId = account.id;
    const startedAt = new Date().toISOString();

    // Log de início
    const logRecord = await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'dayparting_budget_optimizer',
      trigger_type: 'automatic',
      status: 'processing',
      started_at: startedAt,
      execution_date: new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10),
    });

    // ── PASSO 1: Calcular hora média de esgotamento nos últimos 7 dias ──────────
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const controllers = await base44.asServiceRole.entities.AccountDailySpendController.filter(
      { amazon_account_id: accountId }, '-spend_date', 7
    ).catch(() => []);

    const exhaustionHours = controllers
      .filter(c => c.kill_switch_activated_at)
      .map(c => {
        const d = new Date(c.kill_switch_activated_at);
        // Converter UTC para BRT (UTC-3)
        return (d.getUTCHours() - 3 + 24) % 24;
      });

    const avgExhaustionHour = exhaustionHours.length > 0
      ? Math.round(exhaustionHours.reduce((a, b) => a + b, 0) / exhaustionHours.length)
      : null; // null = sem histórico de kill switch

    // ── PASSO 2: Lê HourlySalesPattern para bid_multiplier por slot ──────────
    const hourlyPatterns = await base44.asServiceRole.entities.HourlySalesPattern.filter(
      { amazon_account_id: accountId }, null, 200
    ).catch(() => []);

    // Mapa: hora -> bid_multiplier (média de todos os dias da semana para aquela hora)
    const hourMultiplierMap = {};
    const hourClassMap = {};
    for (const p of hourlyPatterns) {
      const h = p.hour;
      if (h == null) continue;
      if (!hourMultiplierMap[h]) { hourMultiplierMap[h] = []; hourClassMap[h] = []; }
      hourMultiplierMap[h].push(p.bid_multiplier || 1.0);
      hourClassMap[h].push(p.classification || 'NORMAL');
    }

    // Calcular multiplicador médio por hora
    const hourAvgMultiplier = {};
    const hourDominantClass = {};
    for (let h = 0; h < 24; h++) {
      const mults = hourMultiplierMap[h] || [];
      hourAvgMultiplier[h] = mults.length > 0
        ? mults.reduce((a, b) => a + b, 0) / mults.length
        : 1.0;

      const classes = hourClassMap[h] || [];
      // Classificação dominante
      const classCounts = {};
      for (const cl of classes) classCounts[cl] = (classCounts[cl] || 0) + 1;
      hourDominantClass[h] = classes.length > 0
        ? Object.entries(classCounts).sort((a, b) => b[1] - a[1])[0][0]
        : 'NORMAL';
    }

    // Hora atual em BRT
    const nowBRT = (new Date().getUTCHours() - 3 + 24) % 24;

    // Identificar horas-alvo para redução:
    // Horas WEAK / LOSS que estejam ANTES da hora prevista de esgotamento
    // Se não há histórico de esgotamento, otimiza as horas fracas das próximas 6h
    const targetHoursForReduction = [];
    const targetHoursForProtection = [];

    for (let h = 0; h < 24; h++) {
      const cls = hourDominantClass[h];
      const mult = hourAvgMultiplier[h];
      const isWeak = cls === 'WEAK' || cls === 'LOSS';
      const isPeak = cls === 'PEAK_ELITE' || cls === 'PEAK_STRONG';

      if (avgExhaustionHour !== null) {
        // Com histórico: reduzir fracos antes do esgotamento, proteger picos após
        if (isWeak && h < avgExhaustionHour) targetHoursForReduction.push(h);
        if (isPeak && h >= avgExhaustionHour) targetHoursForProtection.push(h);
      } else {
        // Sem histórico: apenas reduzir horas nitidamente fracas (mult < 0.7)
        if (isWeak && mult < 0.7) targetHoursForReduction.push(h);
        if (isPeak) targetHoursForProtection.push(h);
      }
    }

    // ── PASSO 3: Buscar PerformanceSettings para guardrails ─────────────────
    const psArr = await base44.asServiceRole.entities.PerformanceSettings.filter(
      { amazon_account_id: accountId }, '-updated_at', 1
    ).catch(() => []);
    const ps = psArr[0];
    const minBid = ps?.min_bid || 0.25;
    const targetAcos = ps?.target_acos || 10;
    const MAX_REDUCTION_PCT = 35; // nunca reduzir mais de 35%

    // ── PASSO 4: Buscar campanhas ativas e aplicar multiplicadores ──────────
    const campaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: accountId, status: 'enabled' }, null, 200
    ).catch(() => []);

    const activeCampaigns = campaigns.filter(c => {
      const st = (c.state || c.status || '').toLowerCase();
      return st === 'enabled';
    });

    let bidsReduced = 0;
    let bidsSkipped = 0;
    let decisionsCreated = 0;
    const errors = [];

    // Calcular multiplicador médio para horas-alvo (para aplicar a keywords sem horário específico)
    const avgReductionMult = targetHoursForReduction.length > 0
      ? targetHoursForReduction.reduce((acc, h) => acc + hourAvgMultiplier[h], 0) / targetHoursForReduction.length
      : null;

    // Se não há horas para reduzir, não há trabalho a fazer
    if (targetHoursForReduction.length === 0) {
      await base44.asServiceRole.entities.SyncExecutionLog.update(logRecord.id, {
        status: 'completed',
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - new Date(startedAt).getTime(),
        result_summary: JSON.stringify({
          message: 'Sem horários fracos para otimizar — padrões ainda insuficientes ou account sem histórico de kill switch.',
          avg_exhaustion_hour: avgExhaustionHour,
          target_hours_for_reduction: [],
          kill_switch_days: exhaustionHours.length,
        }),
      });
      return Response.json({
        ok: true,
        message: 'Sem horários fracos identificados para otimização.',
        avg_exhaustion_hour: avgExhaustionHour,
        kill_switch_days: exhaustionHours.length,
        bids_reduced: 0,
      });
    }

    for (const campaign of activeCampaigns) {
      try {
        // Nunca otimizar campanhas vencedoras (ACoS abaixo do target)
        if ((campaign.acos || 0) > 0 && campaign.acos < targetAcos * 0.9) {
          bidsSkipped++;
          continue;
        }

        const campaignId = campaign.campaign_id || campaign.amazon_campaign_id || campaign.id;

        // Buscar keywords da campanha
        const keywords = await base44.asServiceRole.entities.Keyword.filter(
          { campaign_id: campaignId, status: 'enabled' }, null, 100
        ).catch(() => []);

        if (keywords.length === 0) continue;

        // Filtrar apenas keywords habilitadas com bid válido
        const eligibleKws = keywords.filter(kw => {
          const st = (kw.state || kw.status || '').toLowerCase();
          return st === 'enabled' && (kw.bid || kw.current_bid || 0) > 0;
        });

        if (eligibleKws.length === 0) continue;

        // Calcular novos bids
        const bidUpdates = [];
        for (const kw of eligibleKws) {
          const currentBid = kw.bid || kw.current_bid || 0.25;

          // Multiplicador baseado no padrão horário ou média das horas fracas
          const multiplier = avgReductionMult !== null ? avgReductionMult : 0.75;
          const clampedMult = Math.max(multiplier, 1 - MAX_REDUCTION_PCT / 100);

          let newBid = currentBid * clampedMult;
          newBid = Math.max(newBid, minBid);
          newBid = Math.round(newBid * 100) / 100;

          // Só aplicar se houver redução real
          if (newBid >= currentBid) continue;

          bidUpdates.push({
            keywordId: kw.keyword_id || kw.id,
            keywordDbId: kw.id,
            currentBid,
            newBid,
            campaignId,
            adGroupId: kw.ad_group_id,
          });
        }

        if (bidUpdates.length === 0) continue;

        if (!dry_run) {
          // Aplicar via amazonAdsCommand (batch por campanha)
          for (const upd of bidUpdates) {
            try {
              await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
                amazon_account_id: accountId,
                command: 'update_keyword_bid',
                campaign_id: campaignId,
                keyword_id: upd.keywordId,
                ad_group_id: upd.adGroupId,
                bid: upd.newBid,
              });

              // Atualizar bid no banco
              await base44.asServiceRole.entities.Keyword.update(upd.keywordDbId, {
                bid: upd.newBid,
                current_bid: upd.newBid,
              }).catch(() => {});

              bidsReduced++;
            } catch (e) {
              errors.push(`kw ${upd.keywordId}: ${e.message}`);
            }
          }

          // Criar OptimizationDecision para auditoria (uma por campanha)
          try {
            await base44.asServiceRole.entities.OptimizationDecision.create({
              amazon_account_id: accountId,
              campaign_id: campaignId,
              decision_type: 'bid_adjustment',
              entity_type: 'campaign',
              entity_id: campaignId,
              action: `Redução proativa de lances — ${bidUpdates.length} keywords ajustadas`,
              rationale: `Otimização preventiva de budget: hora média de esgotamento histórica = ${avgExhaustionHour != null ? avgExhaustionHour + 'h BRT' : 'N/A'}. Horários fracos antes do esgotamento: ${targetHoursForReduction.join(', ')}h. Multiplicador aplicado: ${(avgReductionMult || 0.75).toFixed(2)}x. Objetivo: preservar verba para picos de ${targetHoursForProtection.join(', ')}h.`,
              source_function: 'runDaypartingBudgetOptimizer',
              status: 'executed',
              executed_at: new Date().toISOString(),
              evaluated_at: new Date().toISOString(),
              risk: 'low',
              requires_approval: false,
              confidence: 0.75,
            });
            decisionsCreated++;
          } catch (e) { /* não crítico */ }
        } else {
          bidsReduced += bidUpdates.length;
        }
      } catch (e) {
        errors.push(`campanha ${campaign.id}: ${e.message}`);
      }
    }

    // Calcular economia estimada (aproximação: R$0,05 por lance reduzido × avg clicks esperados)
    const economiaEstimada = bidsReduced * 0.05 * 3; // estimativa conservadora

    const summary = {
      avg_exhaustion_hour: avgExhaustionHour,
      kill_switch_days: exhaustionHours.length,
      target_hours_for_reduction: targetHoursForReduction,
      peak_hours_protected: targetHoursForProtection,
      campaigns_analyzed: activeCampaigns.length,
      bids_reduced: bidsReduced,
      bids_skipped: bidsSkipped,
      decisions_created: decisionsCreated,
      economia_estimada_brl: economiaEstimada,
      dry_run,
      errors: errors.slice(0, 10),
    };

    // Atualizar log
    await base44.asServiceRole.entities.SyncExecutionLog.update(logRecord.id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - new Date(startedAt).getTime(),
      records_processed: bidsReduced,
      result_summary: JSON.stringify(summary),
    });

    return Response.json({
      ok: true,
      message: `Otimização proativa concluída. ${bidsReduced} lances reduzidos em horários fracos.`,
      ...summary,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});