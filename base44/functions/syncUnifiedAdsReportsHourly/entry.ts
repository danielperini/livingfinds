/**
 * syncUnifiedAdsReportsHourly
 * Relatório unificado por HORA — máximo 14 dias.
 * Usado para dayparting, detecção de gasto sem conversão e horário de melhor CVR.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function getAdsBaseUrl(region) {
  const r = (region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function getAdsToken(refreshToken, clientId, clientSecret) {
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token failed');
  return data.access_token;
}

async function pollReport(baseUrl, token, clientId, profileId, reportId, maxWaitMs = 600000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 15000));
    const res = await fetch(`${baseUrl}/reporting/reports/${reportId}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Amazon-Advertising-API-ClientId': clientId, 'Amazon-Advertising-API-Scope': profileId },
    });
    if (!res.ok) continue;
    const data = await res.json();
    if (data.status === 'COMPLETED') return data;
    if (data.status === 'FAILED') throw new Error(`Report failed: ${data.statusDetails}`);
  }
  throw new Error('Hourly report polling timeout');
}

async function downloadReport(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buffer = await res.arrayBuffer();
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(new Uint8Array(buffer));
  writer.close();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const text = new TextDecoder().decode(chunks.reduce((a, b) => { const c = new Uint8Array(a.length + b.length); c.set(a); c.set(b, a.length); return c; }, new Uint8Array(0)));
  return JSON.parse(text);
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    let account = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
      account = accs[0];
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' });
    if (!account.unified_reports_access && body.force !== true) {
      return Response.json({ ok: false, skipped: true, reason: 'unified_reports_access=false' });
    }

    const days = Math.min(body.days || 7, 14); // máximo 14 dias para hourly
    const endDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const now = new Date().toISOString();

    const token = await getAdsToken(
      account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '',
      Deno.env.get('ADS_CLIENT_ID') || '',
      Deno.env.get('ADS_CLIENT_SECRET') || '',
    );
    const baseUrl = getAdsBaseUrl(account.region || 'NA');
    const profileId = String(account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '');
    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';

    const adsHeaders = {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': clientId,
      'Amazon-Advertising-API-Scope': profileId,
      'Content-Type': 'application/json',
    };

    // spAdvertisedProduct com groupBy ['advertiser'] retorna advertisedAsin — suportado no BR para HOURLY
    // Fallback sem ASIN: groupBy ['campaign'] se 400
    // spCampaigns HOURLY — colunas permitidas são um subconjunto (sem campaignName, adGroupId, hour como coluna)
    // 'hour' é propriedade automática do timeUnit=HOURLY, não uma coluna explícita
    // groupBy: ['campaign'] é o único suportado para spCampaigns HOURLY
    // Para ASIN: usar groupBy ['campaign','advertiser'] — fallback para ['campaign'] se 400
    const payloadWithAsin = {
      name: `LivingFinds_Hourly_ASIN_${startDate}_${endDate}`,
      startDate, endDate,
      configuration: {
        adProduct: 'SPONSORED_PRODUCTS',
        groupBy: ['campaign', 'advertiser'],
        columns: [
          'date', 'campaignId', 'campaignBudgetAmount', 'campaignStatus',
          'advertisedAsin', 'advertisedSku',
          'impressions', 'clicks', 'cost',
          'purchases14d', 'sales14d', 'roasClicks14d',
        ],
        reportTypeId: 'spCampaigns',
        timeUnit: 'HOURLY',
        format: 'GZIP_JSON',
      },
    };
    const payloadNoAsin = {
      name: `LivingFinds_Hourly_${startDate}_${endDate}`,
      startDate, endDate,
      configuration: {
        adProduct: 'SPONSORED_PRODUCTS',
        groupBy: ['campaign'],
        columns: [
          'date', 'campaignId', 'campaignBudgetAmount', 'campaignStatus',
          'impressions', 'clicks', 'cost',
          'purchases14d', 'sales14d', 'roasClicks14d',
        ],
        reportTypeId: 'spCampaigns',
        timeUnit: 'HOURLY',
        format: 'GZIP_JSON',
      },
    };

    // Tentativa 1: com ASIN
    let withAsin = true;
    let res1 = await fetch(`${baseUrl}/reporting/reports`, {
      method: 'POST', headers: adsHeaders, body: JSON.stringify(payloadWithAsin),
    });
    if (!res1.ok) {
      const errBody1 = await res1.text();
      if (res1.status === 400) {
        // Verificar se HOURLY não é suportado de forma geral (não só por causa do ASIN)
        if (errBody1.includes('timeUnit is not supported')) {
          await base44.asServiceRole.entities.SyncExecutionLog.create({
            amazon_account_id: account.id,
            operation: 'hourly_asin_pattern_sync',
            trigger_type: 'automatic',
            status: 'skipped',
            result_summary: 'HOURLY timeUnit não suportado nesta conta/marketplace — skipped',
            started_at: now,
            completed_at: new Date().toISOString(),
          }).catch(() => {});
          return Response.json({ ok: true, skipped: true, reason: 'hourly_not_supported_in_this_marketplace', records_saved: 0 });
        }
        // 400 por causa do groupBy com ASIN — tentar fallback sem ASIN
        withAsin = false;
        res1 = await fetch(`${baseUrl}/reporting/reports`, {
          method: 'POST', headers: adsHeaders, body: JSON.stringify(payloadNoAsin),
        });
      }
    }
    if (!res1.ok) {
      const errTxt = await res1.text();
      return Response.json({ ok: false, error: `Create report failed: ${res1.status} - ${errTxt.slice(0, 300)}` });
    }

    const createData = await res1.json();
    const reportId = createData.reportId;
    if (!reportId) return Response.json({ ok: false, error: 'No reportId', data: createData });

    // Timeout guardrail: 8 minutos
    const completedReport = await pollReport(baseUrl, token, clientId, profileId, reportId, 480000).catch((e: any) => {
      if ((e.message || '').includes('timeout')) return null;
      throw e;
    });
    if (!completedReport) {
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: account.id,
        operation: 'hourly_asin_pattern_sync',
        trigger_type: 'automatic',
        status: 'stale',
        result_summary: `Relatório HOURLY timeout após 8min — report_id: ${reportId}`,
        started_at: now,
        completed_at: new Date().toISOString(),
      }).catch(() => {});
      return Response.json({ ok: false, stale: true, report_id: reportId, error: 'Hourly report polling timeout (8min) — registrado como stale, pipeline não bloqueado' });
    }
    if (!completedReport.url) return Response.json({ ok: false, error: 'No download URL' });

    const records = await downloadReport(completedReport.url);
    if (!Array.isArray(records) || records.length === 0) {
      return Response.json({ ok: true, records_saved: 0, message: 'No hourly data' });
    }

    // ── Mapear campanhas para ASIN (fallback quando withAsin=false)
    const campaigns: any[] = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: account.id }, null, 2000
    ).catch(() => []);
    const campAsinMap = new Map<string, string>();
    for (const c of campaigns) {
      if (c.campaign_id && c.asin) campAsinMap.set(String(c.campaign_id), c.asin);
      if (c.amazon_campaign_id && c.asin) campAsinMap.set(String(c.amazon_campaign_id), c.asin);
    }

    // ── Persist com idempotência (chave composta: account+date+hour+campaign+adGroup+asin)
    const existingHourly: any[] = await base44.asServiceRole.entities.UnifiedAdsMetricsHourly.filter(
      { amazon_account_id: account.id }, '-date', 5000
    ).catch(() => []);
    const hourlyKeys = new Set(existingHourly.map((h: any) =>
      `${h.date}|${h.hour}|${h.campaign_id}|${h.ad_group_id}|${h.advertised_asin || ''}`
    ));

    const toCreate: any[] = [];
    const toUpdate: any[] = [];
    for (const r of records) {
      const advertisedAsin = (withAsin ? (r.advertisedAsin || '') : '') || campAsinMap.get(String(r.campaignId || '')) || '';
      // HOURLY timeUnit: campo 'hour' vem como propriedade separada; se não presente, extrair do startDate/date
      const hourVal = r.hour ?? r.startHour ?? (r.date && r.date.includes('T') ? new Date(r.date).getHours() : 0);
      const metricDate = String(r.date || r.startDate || '').slice(0, 10);
      const metricHour = Number(hourVal || 0);
      const key = `${metricDate}|${metricHour}|${r.campaignId}|${r.adGroupId || ''}|${advertisedAsin}`;
      const rec = {
        amazon_account_id: account.id,
        date: metricDate,
        hour: metricHour,
        ad_product: 'SPONSORED_PRODUCTS',
        campaign_id: String(r.campaignId || ''),
        campaign_name: r.campaignName || '',
        ad_group_id: String(r.adGroupId || ''),
        ad_group_name: r.adGroupName || '',
        advertised_asin: advertisedAsin,
        advertised_sku: withAsin ? (r.advertisedSku || '') : '',
        currency: account.currency_code || 'BRL',
        impressions: Number(r.impressions || 0),
        clicks: Number(r.clicks || 0),
        ctr: Number(r.clickThroughRate || 0),
        cpc: Number(r.costPerClick || 0),
        cost: Number(r.cost || 0),
        purchases: Number(r.purchases14d || 0),
        sales: Number(r.sales14d || 0),
        promoted_purchases: Number(r.promotedPurchases14d || 0),
        promoted_sales: Number(r.promotedSales14d || 0),
        source: 'unified_reports',
        synced_at: now,
      };
      const existing = hourlyKeys.has(key) ? existingHourly.find((h: any) =>
        h.date === metricDate && Number(h.hour) === metricHour &&
        h.campaign_id === String(r.campaignId || '') &&
        String(h.ad_group_id || '') === String(r.adGroupId || '') &&
        (h.advertised_asin || '') === advertisedAsin
      ) : null;
      if (existing) toUpdate.push({ id: existing.id, ...rec });
      else toCreate.push(rec);
    }

    let saved = 0;
    const persistenceErrors: string[] = [];
    for (let i = 0; i < toCreate.length; i += 100) {
      const batch = toCreate.slice(i, i + 100);
      try {
        await base44.asServiceRole.entities.UnifiedAdsMetricsHourly.bulkCreate(batch);
        saved += batch.length;
      } catch (error: any) {
        persistenceErrors.push(`create[${i}]: ${error?.message || String(error)}`);
      }
    }
    for (let i = 0; i < toUpdate.length; i += 100) {
      const batch = toUpdate.slice(i, i + 100);
      try {
        await base44.asServiceRole.entities.UnifiedAdsMetricsHourly.bulkUpdate(batch);
        saved += batch.length;
      } catch (error: any) {
        persistenceErrors.push(`update[${i}]: ${error?.message || String(error)}`);
      }
    }

    // ── Verificar se snapshotHourlySalesPattern já foi rodado hoje com >= 24 slots
    const todayBRT = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })).toISOString().slice(0, 10);
    const existingPatterns: any[] = await base44.asServiceRole.entities.HourlySalesPattern.filter(
      { amazon_account_id: account.id }, null, 200
    ).catch(() => []);
    const alreadySnapshotted = existingPatterns.some((p: any) =>
      p.last_computed_at && p.last_computed_at.slice(0, 10) === todayBRT
    );
    const totalSlots = existingPatterns.length;

    let patternResult: any = { skipped: true, reason: 'already_computed_today' };
    if (!alreadySnapshotted || totalSlots < 24) {
      // Chamar snapshotHourlySalesPattern inline via invoke (evita perda de contexto)
      patternResult = await base44.asServiceRole.functions.invoke('snapshotHourlySalesPattern', {
        amazon_account_id: account.id,
        _service_role: true,
      }).then((r: any) => r?.data ?? r).catch((e: any) => ({ error: e.message }));
    }

    // ── Guardrails + disparo de bid para slots PEAK_ELITE / PEAK_STRONG
    let bidDispatchResult: any = { skipped: true };
    try {
      const [perfSettings, autopilotCfg] = await Promise.all([
        base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: account.id }, null, 1).then((r: any[]) => r[0] || {}),
        base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: account.id }, null, 1).then((r: any[]) => r[0] || {}),
      ]);

      const daypartingEnabled = autopilotCfg.dayparting_enabled !== false;
      const targetAcos = Number(perfSettings.target_acos || autopilotCfg.target_acos || 25);
      const maxBidIncreasePct = Number(perfSettings.max_bid_increase_pct || autopilotCfg.max_bid_increase_pct || 15);

      if (!daypartingEnabled) {
        bidDispatchResult = { skipped: true, reason: 'dayparting_enabled=false' };
      } else {
        // Hora atual BRT
        const brtParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }).formatToParts(new Date());
        const currentHourBRT = Number(brtParts.find(p => p.type === 'hour')?.value ?? 0);
        const currentDow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })).getDay();

        // Slots PEAK_ELITE / PEAK_STRONG para a hora atual
        const eliteSlots = existingPatterns.filter((p: any) =>
          p.hour === currentHourBRT &&
          p.day_of_week === currentDow &&
          (p.classification === 'PEAK_ELITE' || p.classification === 'PEAK_STRONG')
        );

        if (eliteSlots.length === 0) {
          bidDispatchResult = { skipped: true, reason: 'no_elite_slots_current_hour' };
        } else {
          // Verificar ACoS 14d por ASIN nos dados recentes
          const recentMetrics: any[] = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
            { amazon_account_id: account.id }, '-date', 500
          ).catch(() => []);

          // Mapear ASIN → ACoS 14d (média ponderada por spend)
          const asinSpend = new Map<string, number>();
          const asinSales = new Map<string, number>();
          for (const m of recentMetrics) {
            // Usar campAsinMap para resolver ASIN de cada registro de métricas
            const asin = campAsinMap.get(String(m.campaign_id || '')) || '';
            if (!asin) continue;
            asinSpend.set(asin, (asinSpend.get(asin) || 0) + Number(m.spend || 0));
            asinSales.set(asin, (asinSales.get(asin) || 0) + Number(m.sales || 0));
          }

          // ASINs elegíveis: ACoS <= target_acos
          const eligibleAsins: string[] = [];
          for (const [asin, spend] of asinSpend.entries()) {
            const sales = asinSales.get(asin) || 0;
            const acos14d = sales > 0 ? (spend / sales) * 100 : 999;
            if (acos14d <= targetAcos) eligibleAsins.push(asin);
          }

          if (eligibleAsins.length === 0) {
            bidDispatchResult = { skipped: true, reason: 'no_asins_below_target_acos', target_acos: targetAcos };
          } else {
            // Disparar runDaypartingDecisionEngine com ASINs elegíveis e bid_multiplier clamped
            const maxMultiplier = 1 + (maxBidIncreasePct / 100);
            const avgMultiplier = Math.min(
              maxMultiplier,
              eliteSlots.reduce((s: number, p: any) => s + (p.bid_multiplier || 1), 0) / eliteSlots.length
            );

            bidDispatchResult = await base44.asServiceRole.functions.invoke('runDaypartingDecisionEngine', {
              amazon_account_id: account.id,
              trigger: 'hourly_peak_pattern',
              eligible_asins: eligibleAsins,
              bid_multiplier_override: avgMultiplier,
              current_hour: currentHourBRT,
              _service_role: true,
            }).then((r: any) => r?.data ?? r).catch((e: any) => ({ error: e.message, triggered: false }));
          }
        }
      }
    } catch (e: any) {
      bidDispatchResult = { error: e.message };
    }

    // ── Logging
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: account.id,
      operation: 'hourly_asin_pattern_sync',
      trigger_type: 'automatic',
      status: persistenceErrors.length === 0 ? 'success' : saved > 0 ? 'partial' : 'error',
      execution_date: todayBRT,
      started_at: now,
      completed_at: new Date().toISOString(),
      records_processed: saved,
      result_summary: JSON.stringify({
        report_id: reportId,
        with_asin: withAsin,
        records_saved: saved,
        pattern_result: patternResult,
        bid_dispatch: bidDispatchResult,
        period: `${startDate} → ${endDate}`,
        persistence_errors: persistenceErrors.slice(0, 5),
      }),
      error_message: persistenceErrors.length > 0 ? persistenceErrors.join(' | ').slice(0, 1000) : null,
    }).catch(() => {});

    return Response.json({
      ok: persistenceErrors.length === 0,
      partial: persistenceErrors.length > 0 && saved > 0,
      report_id: reportId,
      with_asin: withAsin,
      records_saved: saved,
      period: `${startDate} → ${endDate}`,
      pattern_update: patternResult,
      bid_dispatch: bidDispatchResult,
      persistence_errors: persistenceErrors.slice(0, 10),
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});
