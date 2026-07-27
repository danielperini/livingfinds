import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

// Aprende o perfil horário de pico por ASIN a partir de UnifiedAdsMetricsHourly.
// Critérios de maturidade: ≥30 dias de histórico E ≥20 cliques por faixa horária.
// Persiste em HourlySalesPattern com os campos asin_* adicionados.

function nowBRT() {
  return new Date(Date.now() - 3 * 3600000);
}

function dateStrBRT(daysAgo = 0) {
  const d = nowBRT();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const targetAccountId = body.amazon_account_id || null;

    // Carregar contas
    let accounts = [];
    if (targetAccountId) {
      const acc = await base44.asServiceRole.entities.AmazonAccount.filter({ id: targetAccountId });
      accounts = acc;
    } else {
      accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ user_id: user.id });
    }

    if (!accounts.length) return Response.json({ ok: false, error: 'No accounts found' });

    const results = [];

    for (const account of accounts) {
      const accountId = account.id;
      const endDate = dateStrBRT(2); // D-2 para dados fechados
      const startDate = dateStrBRT(90); // Janela de 90 dias

      // Carregar métricas horárias dos últimos 90 dias
      const metrics = await base44.asServiceRole.entities.UnifiedAdsMetricsHourly.filter(
        { amazon_account_id: accountId },
        '-date', 5000
      ).catch(() => []);

      if (!metrics.length) {
        results.push({ account_id: accountId, skipped: true, reason: 'no_hourly_metrics' });
        continue;
      }

      // Filtrar pelo range de datas
      const filtered = metrics.filter(m => m.date >= startDate && m.date <= endDate);

      // Agrupar por campaign_id → asin → hour
      // Primeiro, mapear campaign_id → asin via Campaign
      const campaigns = await base44.asServiceRole.entities.Campaign.filter(
        { amazon_account_id: accountId },
        null, 1000
      ).catch(() => []);

      const campaignToAsin = {};
      for (const c of campaigns) {
        if (c.campaign_id && c.asin) campaignToAsin[c.campaign_id] = c.asin;
        if (c.amazon_campaign_id && c.asin) campaignToAsin[c.amazon_campaign_id] = c.asin;
      }

      // Agregar cliques, vendas, pedidos por ASIN × hora
      const asinHourData = {}; // { asin: { hour: { clicks, sales, orders, spend, cvr_sum, cvr_count, dates: Set } } }

      for (const m of filtered) {
        const asin = m.advertised_sku || campaignToAsin[m.campaign_id] || null;
        if (!asin) continue;
        const hour = m.hour;
        if (hour == null || hour < 0 || hour > 23) continue;

        if (!asinHourData[asin]) asinHourData[asin] = {};
        if (!asinHourData[asin][hour]) {
          asinHourData[asin][hour] = { clicks: 0, sales: 0, orders: 0, spend: 0, cvr_sum: 0, cvr_count: 0, dates: new Set() };
        }
        const slot = asinHourData[asin][hour];
        slot.clicks  += Number(m.clicks || 0);
        slot.sales   += Number(m.sales || 0);
        slot.orders  += Number(m.purchases || 0);
        slot.spend   += Number(m.cost || 0);
        if (m.date) slot.dates.add(m.date);
        if (m.clicks > 0) {
          slot.cvr_sum   += (m.purchases || 0) / m.clicks;
          slot.cvr_count += 1;
        }
      }

      // Para o pico médio da conta: agregar todas as horas sem filtro por ASIN
      const accountHourClicks = {};
      for (const m of filtered) {
        const h = m.hour;
        if (h == null) continue;
        accountHourClicks[h] = (accountHourClicks[h] || 0) + Number(m.clicks || 0);
      }
      const accountPeakHour = Object.entries(accountHourClicks)
        .sort((a, b) => b[1] - a[1])[0]?.[0];
      const accountPeakH = accountPeakHour != null ? parseInt(accountPeakHour) : 12;

      let asinProcessed = 0;
      let asinMature = 0;
      let asinInsufficient = 0;

      for (const [asin, hourMap] of Object.entries(asinHourData)) {
        asinProcessed++;

        // Contar dias únicos de dados
        const allDates = new Set();
        let minClicksPerHour = Infinity;
        let totalClicks = 0;

        for (const slot of Object.values(hourMap)) {
          for (const d of slot.dates) allDates.add(d);
          if (slot.clicks < minClicksPerHour) minClicksPerHour = slot.clicks;
          totalClicks += slot.clicks;
        }

        const daysOfData = allDates.size;
        const hoursWithData = Object.keys(hourMap).length;

        // Maturidade: ≥30 dias E ≥20 cliques por faixa horária (min entre todas as horas com dados)
        const mature = daysOfData >= 30 && hoursWithData >= 12 && (totalClicks / Math.max(hoursWithData, 1)) >= 20;

        if (!mature) {
          asinInsufficient++;
          // Ainda persistimos o registro para mostrar o status de insuficiência
          await upsertAsinProfile(base44, accountId, asin, {
            asin_data_maturity: 'insufficient',
            asin_days_of_data: daysOfData,
            asin_total_clicks: totalClicks,
            asin_profile_updated_at: new Date().toISOString(),
            asin_peak_hours_json: null,
            asin_low_hours_json: null,
            asin_neutral_hours_json: null,
            asin_peak_score_threshold: 0,
            asin_peak_diverges_from_account: false,
          });
          continue;
        }

        asinMature++;

        // Calcular score de valor por hora: CVR × volume normalizado
        const scores = {};
        let maxScore = 0;
        for (const [hourStr, slot] of Object.entries(hourMap)) {
          const h = parseInt(hourStr);
          const avgCvr = slot.cvr_count > 0 ? slot.cvr_sum / slot.cvr_count : 0;
          const volumeScore = slot.clicks / Math.max(totalClicks, 1); // 0-1
          const acosEff = slot.spend > 0 && slot.sales > 0 ? Math.min(slot.sales / slot.spend, 5) / 5 : 0.5;
          const score = (avgCvr * 0.4 + volumeScore * 0.4 + acosEff * 0.2) * 100;
          scores[h] = score;
          if (score > maxScore) maxScore = score;
        }

        // Classificar horas: top 20% = pico, bottom 30% = baixa, resto = neutro
        const sortedScores = Object.entries(scores).sort((a, b) => b[1] - a[1]);
        const total = sortedScores.length;
        const peakCount = Math.max(1, Math.round(total * 0.2));
        const lowCount  = Math.max(1, Math.round(total * 0.3));

        const peakHours   = sortedScores.slice(0, peakCount).map(([h]) => parseInt(h));
        const lowHours    = sortedScores.slice(total - lowCount).map(([h]) => parseInt(h));
        const neutralHours = sortedScores.slice(peakCount, total - lowCount).map(([h]) => parseInt(h));

        const peakThreshold = peakHours.length > 0 ? scores[peakHours[peakHours.length - 1]] : 0;

        // Verificar divergência do padrão da conta (>3h de diferença no pico principal)
        const asinMainPeak = peakHours[0];
        const hourDiff = Math.abs(asinMainPeak - accountPeakH);
        const diverges = hourDiff > 3 && hourDiff < 21; // wraparound 24h

        await upsertAsinProfile(base44, accountId, asin, {
          asin_data_maturity: 'sufficient',
          asin_days_of_data: daysOfData,
          asin_total_clicks: totalClicks,
          asin_profile_updated_at: new Date().toISOString(),
          asin_peak_hours_json: JSON.stringify(peakHours),
          asin_low_hours_json: JSON.stringify(lowHours),
          asin_neutral_hours_json: JSON.stringify(neutralHours),
          asin_peak_score_threshold: Math.round(peakThreshold * 100) / 100,
          asin_peak_diverges_from_account: diverges,
        });
      }

      // Log de execução
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: accountId,
        operation: 'runAsinPeakProfileLearning',
        trigger_type: body.trigger || 'scheduled',
        status: 'success',
        records_processed: asinProcessed,
        result_summary: `${asinMature} ASINs maduros, ${asinInsufficient} insuficientes de ${asinProcessed} total`,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      }).catch(() => {});

      results.push({
        account_id: accountId,
        asins_processed: asinProcessed,
        asins_mature: asinMature,
        asins_insufficient: asinInsufficient,
      });
    }

    return Response.json({ ok: true, results });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}

// Upsert: atualizar HourlySalesPattern mais recente para o ASIN (qualquer hora/dia — usamos hora=0 dia=0 como âncora do perfil)
async function upsertAsinProfile(base44, accountId, asin, profileFields) {
  const existing = await base44.asServiceRole.entities.HourlySalesPattern.filter(
    { amazon_account_id: accountId, asin, day_of_week: 0, hour: 0 },
    null, 1
  ).catch(() => []);

  if (existing.length) {
    await base44.asServiceRole.entities.HourlySalesPattern.update(existing[0].id, profileFields).catch(() => {});
  } else {
    await base44.asServiceRole.entities.HourlySalesPattern.create({
      amazon_account_id: accountId,
      asin,
      day_of_week: 0,
      hour: 0,
      ...profileFields,
    }).catch(() => {});
  }
}