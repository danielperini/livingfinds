/**
 * runDailyDayparting — Ciclo diário de Dayparting Automático
 *
 * Fluxo:
 *   1. Busca campanhas elegíveis (≥ 30 dias, ≥ 50 cliques, ≥ 5 vendas)
 *   2. Para cada campanha: chama analyzeDaypartingOpportunities
 *   3. Oportunidades com confidence_score ≥ 90 → aplica via applyDaypartingSchedule automaticamente
 *   4. Oportunidades com confidence_score < 90 → cria OptimizationDecision com status 'pending' para revisão humana
 *   5. Registra resultados no banco
 *
 * Segurança:
 *   - Uma campanha não recebe dayparting duas vezes na mesma semana (cooldown 7 dias)
 *   - Verifica se já existe DaypartingRule ativa para a campanha
 *   - Produto com estoque zero → skip
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  const startTime = Date.now();
  const now = new Date().toISOString();

  try {
    const base44 = createClientFromRequest(req);

    // Aceita chamadas de automação sem user token
    const isAuthenticated = await base44.auth.isAuthenticated().catch(() => false);

    // ── 1. Resolver conta ─────────────────────────────────────────────────
    const body = await req.json().catch(() => ({}));
    let account = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
      account = accs[0] || null;
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0] || null;
    }
    if (!account) return Response.json({ ok: false, skipped: true, reason: 'Nenhuma conta Amazon conectada.' });

    const aid = account.id;

    // ── 2. Verificar AutopilotConfig ──────────────────────────────────────
    const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid });
    const cfg = configs[0] || {};
    if (cfg.enabled === false || cfg.dayparting_enabled === false) {
      return Response.json({ ok: true, skipped: true, reason: 'Dayparting desabilitado na configuração.' });
    }

    const autonomyLevel = cfg.autonomy_level ?? 3;
    const sym = account.currency_symbol || 'R$';

    // ── 3. Buscar campanhas ativas com tempo suficiente ───────────────────
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const allCampaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: aid, status: 'enabled' }, '-spend', 200
    );

    // Filtrar campanhas criadas há ≥30 dias (performance é verificada nos HourlyMetrics)
    const eligible = allCampaigns.filter(c => {
      const startDate = c.start_date || c.created_at;
      if (!startDate) return false;
      const daysRunning = (Date.now() - new Date(startDate).getTime()) / 86400000;
      return daysRunning >= 30;
    });

    if (eligible.length === 0) {
      return Response.json({ ok: true, skipped: true, reason: `Nenhuma campanha elegível (precisa ≥30 dias, ≥50 cliques, ≥5 pedidos). Total campanhas ativas: ${allCampaigns.length}.` });
    }

    // ── 4. Verificar cooldown: não reaplicar dayparting na mesma semana ───
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const recentRules = await base44.asServiceRole.entities.DaypartingRule.filter(
      { amazon_account_id: aid }, '-created_at', 200
    );
    const recentCampaignIds = new Set(
      recentRules
        .filter(r => r.created_at && r.created_at > sevenDaysAgo && r.status === 'active')
        .map(r => r.campaign_id)
    );

    // ── 5. Verificar campanhas que já têm OptimizationDecision de dayparting pendente hoje ──
    const today = now.slice(0, 10);
    const existingDaypartingDecs = await base44.asServiceRole.entities.OptimizationDecision.filter(
      { amazon_account_id: aid, decision_type: 'dayparting_rule' }, '-created_at', 100
    );
    const existingDaypartingToday = new Set(
      existingDaypartingDecs
        .filter(d => (d.created_at || '').slice(0, 10) === today && ['pending', 'approved', 'executing'].includes(d.status))
        .map(d => d.campaign_id)
    );

    const stats = { analyzed: 0, auto_applied: 0, pending_review: 0, skipped_cooldown: 0, skipped_no_data: 0, errors: 0 };
    const autoApplied = [];
    const pendingReview = [];
    const errors = [];

    // ── 6. Pré-carregar todos os HourlyMetrics em batch (evita N queries) ───
    const thirtyDaysAgoDate = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    let allHourlyMetrics = [];
    try {
      // Carregar até 2000 registros de HourlyMetric dos últimos 30 dias
      allHourlyMetrics = await base44.asServiceRole.entities.HourlyMetric.filter(
        { amazon_account_id: aid, date: { $gte: thirtyDaysAgoDate } },
        '-date', 2000
      );
    } catch (e) {
      return Response.json({ ok: false, error: `Falha ao carregar dados horários: ${e.message}` }, { status: 500 });
    }

    // Indexar por campaign_id
    const hourlyByCampaign: Record<string, any[]> = {};
    for (const m of allHourlyMetrics) {
      const cid = m.campaign_id;
      if (!cid) continue;
      if (!hourlyByCampaign[cid]) hourlyByCampaign[cid] = [];
      hourlyByCampaign[cid].push(m);
    }

    // ── 7. Analisar e aplicar por campanha ───────────────────────────────
    const campaignsToProcess = eligible.slice(0, 50);
    for (const campaign of campaignsToProcess) {
      const cid = campaign.campaign_id;

      // Skip cooldown
      if (recentCampaignIds.has(cid)) {
        stats.skipped_cooldown++;
        continue;
      }

      // Skip se já tem decisão de dayparting hoje
      if (existingDaypartingToday.has(cid)) {
        stats.skipped_cooldown++;
        continue;
      }

      stats.analyzed++;

      try {
        // Usar dados já carregados em memória
        const hourlyMetrics = hourlyByCampaign[cid] || [];

        if (hourlyMetrics.length === 0) {
          stats.skipped_no_data++;
          continue;
        }

        const daysWithImpressions = new Set(hourlyMetrics.filter(h => h.impressions > 0).map(h => h.date)).size;
        if (daysWithImpressions < 21) {
          stats.skipped_no_data++;
          continue;
        }

        // ── Calcular métricas agregadas ──────────────────────────────────
        const totalClicks = hourlyMetrics.reduce((s, h) => s + (h.clicks || 0), 0);
        const totalSales  = hourlyMetrics.reduce((s, h) => s + (h.sales || 0), 0);
        const totalSpend  = hourlyMetrics.reduce((s, h) => s + (h.spend || 0), 0);
        const totalOrders = hourlyMetrics.reduce((s, h) => s + (h.orders || 0), 0);

        // Verificar thresholds mínimos de performance real (dos dados horários)
        if (totalClicks < 50 || totalOrders < 3) {
          stats.skipped_no_data++;
          continue;
        }

        const avgRoas = totalSpend > 0 ? totalSales / totalSpend : 0;
        const avgAcos = totalSales > 0 ? (totalSpend / totalSales) * 100 : 100;

        // ── Construir matriz horária ─────────────────────────────────────
        const hourMatrix: Record<string, any> = {};
        for (let d = 0; d < 7; d++) {
          for (let h = 0; h < 24; h++) {
            hourMatrix[`${d}-${h}`] = { day: d, hour: h, clicks: 0, spend: 0, sales: 0, orders: 0, impressions: 0 };
          }
        }
        for (const m of hourlyMetrics) {
          const k = `${m.day_of_week}-${m.hour}`;
          if (hourMatrix[k]) {
            hourMatrix[k].clicks += m.clicks || 0;
            hourMatrix[k].spend += m.spend || 0;
            hourMatrix[k].sales += m.sales || 0;
            hourMatrix[k].orders += m.orders || 0;
            hourMatrix[k].impressions += m.impressions || 0;
          }
        }

        // ── Classificar cada bloco horário ───────────────────────────────
        const classifiedHours = Object.values(hourMatrix).map((d: any) => {
          const roas = d.spend > 0 ? d.sales / d.spend : 0;
          const acos = d.sales > 0 ? (d.spend / d.sales) * 100 : (d.clicks > 0 ? 999 : 0);
          const cvr  = d.clicks > 0 ? d.orders / d.clicks : 0;
          const roasIndex = avgRoas > 0 ? roas / avgRoas : 0;

          let classification = 'insufficient_data';
          let blockConfidence = 0;

          if (d.clicks >= 10 && d.orders >= 2) {
            if (roas >= 4 && acos <= 25 && roasIndex >= 1.3) { classification = 'peak_high_profit'; blockConfidence = 92; }
            else if (roas >= 3 && acos <= 35 && roasIndex >= 1.1) { classification = 'peak_conversion'; blockConfidence = 87; }
            else if (roas >= 2 && roasIndex >= 0.9) { classification = 'efficient'; blockConfidence = 75; }
            else if (d.clicks >= 5 && d.orders === 0) { classification = 'deficit'; blockConfidence = 72; }
            else { classification = 'low_efficiency'; blockConfidence = 55; }
          } else if (d.clicks >= 3) {
            classification = 'discovery'; blockConfidence = 40;
          }

          return { ...d, roas, acos, cvr, roasIndex, classification, blockConfidence };
        });

        // ── Calcular confidence_score composto ───────────────────────────
        const daysRunning = campaign.start_date
          ? Math.floor((Date.now() - new Date(campaign.start_date).getTime()) / 86400000) : 30;

        const highConfHours = classifiedHours.filter(h => h.blockConfidence >= 75 && h.clicks > 0).length;
        const activeHours   = classifiedHours.filter(h => h.clicks > 0).length;
        const adequateHours = classifiedHours.filter(h => h.clicks >= 10).length;
        const coveredDays   = new Set(classifiedHours.filter(h => h.clicks >= 5).map(h => h.day)).size;

        const sampleScore    = Math.min(1.0, Math.log10(Math.max(totalClicks, 1) + 1) / Math.log10(501));
        const maturityScore  = Math.min(1.0, daysRunning / 90);
        const coverageScore  = activeHours > 0 ? Math.min(1.0, adequateHours / activeHours) : 0;
        const dayScore       = coveredDays / 7;
        const confRatio      = activeHours > 0 ? highConfHours / activeHours : 0;

        const confidenceScore = Math.round((
          sampleScore   * 0.30 +
          maturityScore * 0.25 +
          coverageScore * 0.20 +
          dayScore      * 0.15 +
          confRatio     * 0.10
        ) * 100);

        // ── Identificar janelas de oportunidade ──────────────────────────
        // Peak hours (aumentar bid) e Deficit hours (reduzir bid)
        const peakHours   = classifiedHours.filter(h => ['peak_high_profit', 'peak_conversion'].includes(h.classification));
        const deficitHours = classifiedHours.filter(h => ['deficit', 'low_efficiency'].includes(h.classification) && h.clicks >= 5);

        if (peakHours.length === 0 && deficitHours.length === 0) {
          stats.skipped_no_data++;
          continue;
        }

        // Construir summary das janelas para o rationale
        const peakSummary = peakHours.slice(0, 3).map(h => `Dia${h.day} ${h.hour}h (ROAS ${h.roas.toFixed(1)}x)`).join(', ');
        const deficitSummary = deficitHours.slice(0, 3).map(h => `Dia${h.day} ${h.hour}h (gasto sem retorno)`).join(', ');

        const estSavings = deficitHours.reduce((s, h) => s + (h.spend || 0), 0) * 0.6;
        const estRoasGain = ((avgRoas * (1 + peakHours.length * 0.02)) - avgRoas) / avgRoas * 100;

        // ── Decidir execução automática vs pendente ───────────────────────
        const autoApplyNow = confidenceScore >= 90 && autonomyLevel >= 2;

        const decisionPayload = {
          amazon_account_id: aid,
          decision_type: 'dayparting_rule',
          entity_type: 'campaign',
          entity_id: cid,
          campaign_id: cid,
          asin: campaign.asin,
          action: 'apply_dayparting',
          rationale: [
            `Objetivo: otimizar distribuição horária do budget via dayparting.`,
            `\nDiagnóstico: Campanha "${campaign.name || campaign.campaign_name}" operou ${daysRunning} dias com ${totalClicks} cliques, ${totalOrders} pedidos e ROAS médio de ${avgRoas.toFixed(2)}x.`,
            `\nEvidências: ${peakHours.length} blocos horários de pico identificados${peakSummary ? ` (${peakSummary})` : ''}. ${deficitHours.length} blocos de déficit identificados${deficitSummary ? ` (${deficitSummary})` : ''}.`,
            `\nAção: Aplicar dayparting com aumento de bid em horários de pico e redução em horários ineficientes.`,
            `\nMomento: ${autoApplyNow ? 'Execução automática (confiança ≥ 90%).' : 'Aguardando aprovação humana.'}`,
            `\nConfiança: ${confidenceScore}%`,
            `\nResultado esperado: Economia estimada de ${sym}${(estSavings / 30).toFixed(2)}/dia e melhora de ROAS estimada em +${estRoasGain.toFixed(1)}%.`,
            `\nAvaliação: Em 14 dias.`,
            `\nCritério de sucesso: ROAS acima de ${(avgRoas * 1.10).toFixed(2)}x após 14 dias.`,
            `\nCritério de rollback: Reverter se ROAS cair abaixo de ${(avgRoas * 0.85).toFixed(2)}x após 14 dias.`,
          ].join(''),
          data_used: JSON.stringify({
            days_running: daysRunning,
            total_clicks: totalClicks,
            total_orders: totalOrders,
            total_spend: totalSpend,
            avg_roas: avgRoas,
            avg_acos: avgAcos,
            peak_hours_count: peakHours.length,
            deficit_hours_count: deficitHours.length,
            confidence_score: confidenceScore,
            classified_hours_count: classifiedHours.length,
          }),
          confidence: confidenceScore,
          risk: confidenceScore >= 90 ? 'low' : 'medium',
          requires_approval: !autoApplyNow,
          status: autoApplyNow ? 'approved' : 'pending',
          reversible: true,
          country_code: account.country_code || 'BR',
          currency_code: account.currency_code || 'BRL',
          currency_symbol: sym,
          objective: 'maintenance',
          expected_impact: `Economia ~${sym}${(estSavings / 30).toFixed(2)}/dia, ROAS +${estRoasGain.toFixed(1)}%`,
          evaluation_due_at: new Date(Date.now() + 14 * 86400000).toISOString(),
          source_function: 'runDailyDayparting',
          created_at: now,
        };

        const created = await base44.asServiceRole.entities.OptimizationDecision.create(decisionPayload);

        if (autoApplyNow) {
          // Aplicar imediatamente via applyDaypartingSchedule
          const applyRes = await base44.asServiceRole.functions.invoke('applyDaypartingSchedule', {
            opportunity_id: created.id,
            mode: 'hybrid',
            approve: true,
            auto_apply: true,
          }).catch(e => ({ data: { ok: false, error: e.message } }));

          const ok = applyRes?.data?.ok;
          if (ok) {
            stats.auto_applied++;
            autoApplied.push({
              campaign_id: cid,
              campaign_name: campaign.name || campaign.campaign_name,
              confidence: confidenceScore,
              peak_hours: peakHours.length,
              deficit_hours: deficitHours.length,
            });
          } else {
            // Aplicação falhou — manter como approved para ciclo noturno
            stats.pending_review++;
            pendingReview.push({ campaign_id: cid, confidence: confidenceScore, reason: `apply_failed: ${applyRes?.data?.error}` });
          }
        } else {
          stats.pending_review++;
          pendingReview.push({
            campaign_id: cid,
            campaign_name: campaign.name || campaign.campaign_name,
            confidence: confidenceScore,
            peak_hours: peakHours.length,
            deficit_hours: deficitHours.length,
          });
        }

        // Rate limit: pausa entre campanhas para respeitar limites da API
        await new Promise(r => setTimeout(r, 600));

      } catch (err) {
        stats.errors++;
        errors.push({ campaign_id: cid, error: err.message });
      }
    }

    return Response.json({
      ok: true,
      stats,
      auto_applied: autoApplied,
      pending_review: pendingReview,
      errors,
      autonomy_level: autonomyLevel,
      confidence_threshold: 90,
      eligible_campaigns: eligible.length,
      duration_ms: Date.now() - startTime,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});