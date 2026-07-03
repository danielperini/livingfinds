/**
 * runDailyDayparting v2 — Dayparting baseado em frequência de vendas por faixa horária
 *
 * Lógica de bid por horário:
 *   - Horário PICO (peak_high_profit):  bid base × (1 + roasIndex × 0.30) → máx +130%
 *   - Horário BOM (peak_conversion):    bid base × (1 + roasIndex × 0.20) → máx +100%
 *   - Horário EFICIENTE:                mantém bid base
 *   - Horário BAIXA (deficit/ineficiente): bid fixo R$0,25 (piso absoluto)
 *
 * As janelas calculadas ficam no campo `data_used` da OptimizationDecision para
 * serem lidas pelo applyDaypartingSchedule.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// Piso e tetos de bid por dayparting
const BID_FLOOR = 0.25;           // piso absoluto para horários de baixa
const PEAK_MAX_INCREASE = 1.30;   // +130% máximo nos horários de alta demanda
const GOOD_MAX_INCREASE = 1.00;   // +100% máximo nos horários de boa conversão

Deno.serve(async (req) => {
  const startTime = Date.now();
  const now = new Date().toISOString();

  try {
    const base44 = createClientFromRequest(req);
    await base44.auth.isAuthenticated().catch(() => false);

    const body = await req.json().catch(() => ({}));

    // ── 1. Resolver conta ─────────────────────────────────────────────────
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
    const sym = account.currency_symbol || 'R$';

    // ── 2. Verificar AutopilotConfig ──────────────────────────────────────
    const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid });
    const cfg = configs[0] || {};
    if (cfg.enabled === false || cfg.dayparting_enabled === false) {
      return Response.json({ ok: true, skipped: true, reason: 'Dayparting desabilitado na configuração.' });
    }

    const autonomyLevel = cfg.autonomy_level ?? 3;
    const MIN_BID = cfg.min_bid || BID_FLOOR;

    // ── 3. Buscar campanhas ativas com tempo suficiente ───────────────────
    const allCampaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: aid, status: 'enabled' }, '-spend', 200
    );
    const eligible = allCampaigns.filter(c => {
      const startDate = c.start_date || c.created_at;
      if (!startDate) return false;
      return (Date.now() - new Date(startDate).getTime()) / 86400000 >= 30;
    });

    if (eligible.length === 0) {
      return Response.json({ ok: true, skipped: true, reason: `Nenhuma campanha elegível (≥30 dias). Total ativas: ${allCampaigns.length}.` });
    }

    // ── 4. Cooldown: não reaplicar na mesma semana ────────────────────────
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const recentRules = await base44.asServiceRole.entities.DaypartingRule.filter(
      { amazon_account_id: aid }, '-created_at', 200
    );
    const recentCampaignIds = new Set(
      recentRules
        .filter(r => r.created_at && r.created_at > sevenDaysAgo && r.status === 'active')
        .map(r => r.campaign_id)
    );

    // ── 5. Evitar duplicata de decisão hoje ───────────────────────────────
    const today = now.slice(0, 10);
    const existingDecs = await base44.asServiceRole.entities.OptimizationDecision.filter(
      { amazon_account_id: aid, decision_type: 'dayparting_rule' }, '-created_at', 100
    );
    const existingToday = new Set(
      existingDecs
        .filter(d => (d.created_at || '').slice(0, 10) === today && ['pending', 'approved', 'executing'].includes(d.status))
        .map(d => d.campaign_id)
    );

    // ── 6. Pré-carregar HourlyMetrics em batch ────────────────────────────
    const thirtyDaysAgoDate = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    let allHourlyMetrics = [];
    try {
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
      if (!m.campaign_id) continue;
      if (!hourlyByCampaign[m.campaign_id]) hourlyByCampaign[m.campaign_id] = [];
      hourlyByCampaign[m.campaign_id].push(m);
    }

    // ── 7. Carregar keywords para obter bid atual por campanha ────────────
    const keywords = await base44.asServiceRole.entities.Keyword.filter(
      { amazon_account_id: aid, state: 'enabled' }, null, 500
    );
    // Bid médio por campaign_id
    const bidByCampaign: Record<string, number> = {};
    for (const kw of keywords) {
      const cid = kw.campaign_id;
      if (!cid) continue;
      const bid = kw.current_bid || kw.bid || 0.50;
      if (!bidByCampaign[cid]) bidByCampaign[cid] = bid;
      else bidByCampaign[cid] = (bidByCampaign[cid] + bid) / 2;
    }

    const stats = { analyzed: 0, auto_applied: 0, pending_review: 0, skipped_cooldown: 0, skipped_no_data: 0, errors: 0 };
    const autoApplied = [];
    const pendingReview = [];
    const errors = [];

    // ── 8. Analisar e aplicar por campanha ───────────────────────────────
    const campaignsToProcess = eligible.slice(0, 50);
    for (const campaign of campaignsToProcess) {
      const cid = campaign.campaign_id;

      if (recentCampaignIds.has(cid) || existingToday.has(cid)) {
        stats.skipped_cooldown++;
        continue;
      }

      stats.analyzed++;

      try {
        const hourlyMetrics = hourlyByCampaign[cid] || [];
        if (hourlyMetrics.length === 0) { stats.skipped_no_data++; continue; }

        const daysWithData = new Set(hourlyMetrics.filter(h => h.impressions > 0).map(h => h.date)).size;
        if (daysWithData < 14) { stats.skipped_no_data++; continue; }

        // ── Métricas globais ────────────────────────────────────────────
        const totalClicks = hourlyMetrics.reduce((s, h) => s + (h.clicks || 0), 0);
        const totalSales  = hourlyMetrics.reduce((s, h) => s + (h.sales || 0), 0);
        const totalSpend  = hourlyMetrics.reduce((s, h) => s + (h.spend || 0), 0);
        const totalOrders = hourlyMetrics.reduce((s, h) => s + (h.orders || 0), 0);

        if (totalClicks < 50 || totalOrders < 3) { stats.skipped_no_data++; continue; }

        const avgRoas = totalSpend > 0 ? totalSales / totalSpend : 0;
        const avgAcos = totalSales > 0 ? (totalSpend / totalSales) * 100 : 100;
        const baseBid = bidByCampaign[cid] || campaign.daily_budget ? Math.max(MIN_BID, bidByCampaign[cid] || 0.50) : 0.50;

        // ── Construir matriz horária (agregado por hora do dia, 0–23) ───
        // Ignora dia da semana — analisa padrão horário geral
        const hourMatrix: Record<number, any> = {};
        for (let h = 0; h < 24; h++) {
          hourMatrix[h] = { hour: h, clicks: 0, spend: 0, sales: 0, orders: 0, impressions: 0, days: 0 };
        }
        const dateSet = new Set<string>();
        for (const m of hourlyMetrics) {
          const h = m.hour;
          if (h == null || h < 0 || h > 23) continue;
          hourMatrix[h].clicks     += m.clicks     || 0;
          hourMatrix[h].spend      += m.spend      || 0;
          hourMatrix[h].sales      += m.sales      || 0;
          hourMatrix[h].orders     += m.orders     || 0;
          hourMatrix[h].impressions+= m.impressions|| 0;
          if (m.date) dateSet.add(`${m.date}-${h}`);
        }
        // Contar dias distintos com dados por hora
        for (let h = 0; h < 24; h++) {
          hourMatrix[h].days = [...dateSet].filter(k => k.endsWith(`-${h}`)).length;
        }

        // ── Classificar cada hora com bid recomendado ───────────────────
        const classifiedHours = Object.values(hourMatrix).map((d: any) => {
          const roas = d.spend > 0 ? d.sales / d.spend : 0;
          const acos = d.sales > 0 ? (d.spend / d.sales) * 100 : (d.clicks > 0 ? 999 : 0);
          const cvr  = d.clicks > 0 ? d.orders / d.clicks : 0;
          const roasIndex = avgRoas > 0 ? roas / avgRoas : 0;
          // Frequência de vendas por hora: vendas totais nesta hora / dias com dados
          const salesFreq = d.days > 0 ? d.sales / d.days : 0;
          const avgSalesFreq = totalSales / (daysWithData * 24) || 0;
          const salesFreqIndex = avgSalesFreq > 0 ? salesFreq / avgSalesFreq : 0;

          let classification = 'insufficient_data';
          let recommendedBid = baseBid; // padrão: manter bid atual

          if (d.clicks >= 8 && d.orders >= 1) {
            if (roasIndex >= 1.3 && salesFreqIndex >= 1.2) {
              // PICO: alta demanda + alta frequência de vendas → +100% a +130%
              const increaseMultiplier = Math.min(PEAK_MAX_INCREASE, 1.0 + (roasIndex - 1) * 0.5 + (salesFreqIndex - 1) * 0.3);
              recommendedBid = Math.round(baseBid * (1 + increaseMultiplier) * 100) / 100;
              classification = 'peak_high_profit';
            } else if (roasIndex >= 1.1 && salesFreqIndex >= 1.0) {
              // BOA conversão: até +100%
              const increaseMultiplier = Math.min(GOOD_MAX_INCREASE, 0.5 + (roasIndex - 1) * 0.4);
              recommendedBid = Math.round(baseBid * (1 + increaseMultiplier) * 100) / 100;
              classification = 'peak_conversion';
            } else if (roasIndex >= 0.85) {
              // EFICIENTE: mantém bid
              classification = 'efficient';
              recommendedBid = baseBid;
            } else {
              // BAIXA eficiência com gasto: reduzir para o piso
              recommendedBid = MIN_BID;
              classification = 'low_efficiency';
            }
          } else if (d.clicks >= 5 && d.orders === 0 && d.spend > 0) {
            // DÉFICIT: gasto sem retorno → piso absoluto
            recommendedBid = MIN_BID;
            classification = 'deficit';
          } else if (d.clicks > 0) {
            classification = 'discovery';
            recommendedBid = baseBid; // sem dados suficientes — manter
          }

          return {
            ...d,
            roas, acos, cvr, roasIndex, salesFreqIndex, salesFreq,
            classification, recommendedBid,
            bidChange: recommendedBid - baseBid,
            bidChangePct: baseBid > 0 ? ((recommendedBid - baseBid) / baseBid * 100) : 0,
          };
        });

        // ── Filtrar janelas de ação ──────────────────────────────────────
        const peakWindows   = classifiedHours.filter(h => ['peak_high_profit', 'peak_conversion'].includes(h.classification));
        const deficitWindows= classifiedHours.filter(h => ['deficit', 'low_efficiency'].includes(h.classification) && h.clicks >= 5);

        if (peakWindows.length === 0 && deficitWindows.length === 0) {
          stats.skipped_no_data++;
          continue;
        }

        // ── Calcular confidence_score ────────────────────────────────────
        const daysRunning = campaign.start_date
          ? Math.floor((Date.now() - new Date(campaign.start_date).getTime()) / 86400000) : 30;

        const activeHours   = classifiedHours.filter(h => h.clicks > 0).length;
        const highConfHours = classifiedHours.filter(h => ['peak_high_profit', 'peak_conversion'].includes(h.classification)).length;
        const coveredDays   = daysWithData;

        const sampleScore   = Math.min(1.0, Math.log10(Math.max(totalClicks, 1) + 1) / Math.log10(501));
        const maturityScore = Math.min(1.0, daysRunning / 90);
        const coverageScore = Math.min(1.0, coveredDays / 30);
        const confRatio     = activeHours > 0 ? highConfHours / activeHours : 0;

        const confidenceScore = Math.round((
          sampleScore   * 0.35 +
          maturityScore * 0.25 +
          coverageScore * 0.25 +
          confRatio     * 0.15
        ) * 100);

        // ── Construir payload de janelas para o applyDaypartingSchedule ──
        // Formato: { hour: N, recommendedBid, classification, bidChangePct }[]
        const daypartingSchedule = classifiedHours
          .filter(h => h.classification !== 'insufficient_data' && h.classification !== 'discovery')
          .map(h => ({
            hour: h.hour,
            classification: h.classification,
            baseBid: Number(baseBid.toFixed(2)),
            recommendedBid: Number(h.recommendedBid.toFixed(2)),
            bidChangePct: Number(h.bidChangePct.toFixed(1)),
            clicks: h.clicks,
            orders: h.orders,
            roas: Number((h.roas || 0).toFixed(2)),
            roasIndex: Number((h.roasIndex || 0).toFixed(2)),
            salesFreq: Number((h.salesFreq || 0).toFixed(4)),
          }));

        // Sumário para o rationale
        const peakSummary    = peakWindows.slice(0, 4).map(h => `${h.hour}h (+${h.bidChangePct.toFixed(0)}%, ROAS ${h.roas.toFixed(1)}x)`).join(', ');
        const deficitSummary = deficitWindows.slice(0, 4).map(h => `${h.hour}h (R$0,25, sem retorno)`).join(', ');
        const estSavings     = deficitWindows.reduce((s, h) => s + (h.spend / Math.max(daysWithData, 1)) * 0.6, 0);
        const estRoasGain    = peakWindows.length * 2.5; // estimativa conservadora

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
            `Dayparting por frequência de vendas — Campanha "${campaign.name || campaign.campaign_name}".`,
            `\nAnálise: ${daysRunning} dias de dados, ${totalClicks} cliques, ${totalOrders} pedidos, ROAS médio ${avgRoas.toFixed(2)}x.`,
            `\nHorários de pico (bid aumentado): ${peakSummary || 'nenhum identificado'}.`,
            `\nHorários de baixa (bid → R$0,25): ${deficitSummary || 'nenhum identificado'}.`,
            `\nLógica: bid base R$${baseBid.toFixed(2)} × índice ROAS × frequência de vendas → faixa +100% a +130% no pico, R$0,25 na baixa.`,
            `\nConfiança: ${confidenceScore}% | ${autoApplyNow ? 'Execução automática.' : 'Aguarda aprovação.'}`,
            `\nEconomia estimada: ${sym}${estSavings.toFixed(2)}/dia nos horários de baixa. Ganho de ROAS estimado: +${estRoasGain.toFixed(1)}%.`,
          ].join(''),
          data_used: JSON.stringify({
            base_bid: baseBid,
            bid_floor: MIN_BID,
            days_with_data: daysWithData,
            days_running: daysRunning,
            total_clicks: totalClicks,
            total_orders: totalOrders,
            total_spend: Number(totalSpend.toFixed(2)),
            avg_roas: Number(avgRoas.toFixed(2)),
            avg_acos: Number(avgAcos.toFixed(1)),
            peak_windows_count: peakWindows.length,
            deficit_windows_count: deficitWindows.length,
            confidence_score: confidenceScore,
            dayparting_schedule: daypartingSchedule,  // ← LIDO pelo applyDaypartingSchedule
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
          expected_impact: `Pico: +${peakWindows.length} janelas bid ×${(1 + PEAK_MAX_INCREASE).toFixed(1)}x máx. Baixa: ${deficitWindows.length} janelas → R$0,25.`,
          evaluation_due_at: new Date(Date.now() + 14 * 86400000).toISOString(),
          source_function: 'runDailyDayparting',
          created_at: now,
        };

        const created = await base44.asServiceRole.entities.OptimizationDecision.create(decisionPayload);

        if (autoApplyNow) {
          const applyRes = await base44.asServiceRole.functions.invoke('applyDaypartingSchedule', {
            opportunity_id: created.id,
            approve: true,
            auto_apply: true,
          }).catch(e => ({ data: { ok: false, error: e.message } }));

          const ok = applyRes?.data?.ok;
          if (ok) {
            stats.auto_applied++;
            autoApplied.push({ campaign_id: cid, campaign_name: campaign.name || campaign.campaign_name, confidence: confidenceScore, peak_windows: peakWindows.length, deficit_windows: deficitWindows.length, base_bid: baseBid });
          } else {
            stats.pending_review++;
            pendingReview.push({ campaign_id: cid, confidence: confidenceScore, reason: `apply_failed: ${applyRes?.data?.error}` });
          }
        } else {
          stats.pending_review++;
          pendingReview.push({ campaign_id: cid, campaign_name: campaign.name || campaign.campaign_name, confidence: confidenceScore, peak_windows: peakWindows.length, deficit_windows: deficitWindows.length, base_bid: baseBid });
        }

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
      bid_floor: MIN_BID,
      peak_max_increase_pct: PEAK_MAX_INCREASE * 100,
      good_max_increase_pct: GOOD_MAX_INCREASE * 100,
      duration_ms: Date.now() - startTime,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});