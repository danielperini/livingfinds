/**
 * syncFinanceEventsFromSpApi
 *
 * Busca Finance Events da SP-API (D-7 → D-1).
 * Usa ADS credentials (AMAZON_LWA_CLIENT_ID / AMAZON_LWA_CLIENT_SECRET)
 * com SP refresh token (AMAZON_SP_REFRESH_TOKEN) — mesma app LWA registrada.
 * Agrega ShipmentEvents por data e persiste em SalesDaily com campos financeiros reais.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function r2(v) { return parseFloat((Number(v) || 0).toFixed(2)); }

function brtDateStr(daysAgo = 0) {
  const d = new Date(Date.now() - (3 * 3600000) - (daysAgo * 86400000));
  return d.toISOString().slice(0, 10);
}

async function getSpAccessToken() {
  // Tenta todas as combinações de credenciais disponíveis
  const combos = [
    {
      clientId: Deno.env.get('AMAZON_LWA_CLIENT_ID'),
      clientSecret: Deno.env.get('AMAZON_LWA_CLIENT_SECRET'),
      refreshToken: Deno.env.get('AMAZON_SP_REFRESH_TOKEN'),
      label: 'AMAZON_LWA + SP_REFRESH',
    },
    {
      clientId: Deno.env.get('SP_CLIENT_ID'),
      clientSecret: Deno.env.get('SP_CLIENT_SECRET'),
      refreshToken: Deno.env.get('SP_REFRESH_TOKEN') || Deno.env.get('AMAZON_SP_REFRESH_TOKEN'),
      label: 'SP_CLIENT + SP_REFRESH',
    },
    {
      clientId: Deno.env.get('ADS_CLIENT_ID'),
      clientSecret: Deno.env.get('ADS_CLIENT_SECRET'),
      refreshToken: Deno.env.get('AMAZON_SP_REFRESH_TOKEN'),
      label: 'ADS_CLIENT + SP_REFRESH',
    },
  ];

  let lastError = '';
  for (const combo of combos) {
    if (!combo.clientId || !combo.clientSecret || !combo.refreshToken) continue;
    const res = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: combo.refreshToken,
        client_id: combo.clientId,
        client_secret: combo.clientSecret,
      }).toString(),
    });
    if (res.ok) {
      const json = await res.json();
      return { token: json.access_token, source: combo.label };
    }
    const txt = await res.text();
    lastError = `[${combo.label}] ${res.status}: ${txt.slice(0, 150)}`;
  }
  throw new Error(`Todas as combinações de credenciais falharam. Último erro: ${lastError}`);
}

async function fetchFinanceEvents(token, postedAfter, postedBefore, nextToken = null) {
  const region = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  const baseMap = {
    NA: 'https://sellingpartnerapi-na.amazon.com',
    EU: 'https://sellingpartnerapi-eu.amazon.com',
    FE: 'https://sellingpartnerapi-fe.amazon.com',
  };
  const base = baseMap[region] || baseMap.NA;

  let url = `${base}/finances/2024-06-19/financialEvents?PostedAfter=${postedAfter}T00:00:00Z&PostedBefore=${postedBefore}T23:59:59Z&MaxResultsPerPage=100`;
  if (nextToken) url += `&NextToken=${encodeURIComponent(nextToken)}`;

  const res = await fetch(url, {
    headers: {
      'x-amz-access-token': token,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SP-API Finance Events ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

function moneyVal(obj) {
  if (!obj) return 0;
  return Number(obj.CurrencyAmount || obj.amount || 0);
}

function aggregateShipmentEvents(events) {
  const byDate = {};
  for (const ev of events || []) {
    const raw = ev.PostedDate || ev.postedDate;
    if (!raw) continue;
    const dateBRT = new Date(new Date(raw).getTime() - 3 * 3600000).toISOString().slice(0, 10);
    if (!byDate[dateBRT]) {
      byDate[dateBRT] = { gross_revenue: 0, referral_fee: 0, fba_fee: 0, tax_withheld: 0, other_fees: 0, orders: 0, units: 0, events_count: 0 };
    }
    const agg = byDate[dateBRT];
    agg.events_count++;

    for (const item of ev.ShipmentItemList || []) {
      // Contar unidades
      agg.units += Number(item.QuantityShipped || 1);
      agg.orders += 1;

      for (const charge of item.ItemChargeList || []) {
        const type = (charge.ChargeType || '').toLowerCase();
        const val = moneyVal(charge.ChargeAmount);
        if (type === 'principal') agg.gross_revenue += val;
      }
      for (const fee of item.ItemFeeList || []) {
        const type = (fee.FeeType || '').toLowerCase();
        const val = Math.abs(moneyVal(fee.FeeAmount));
        if (type.includes('referral')) agg.referral_fee += val;
        else if (type.includes('fba') || type.includes('fulfillment')) agg.fba_fee += val;
        else agg.other_fees += val;
      }
      for (const tax of (item.MarketplaceTaxInfoList || item.MarketplaceFacilitatorTaxList || [])) {
        agg.tax_withheld += Math.abs(moneyVal(tax.TaxAmount || tax.taxAmount));
      }
    }
  }
  return byDate;
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  const now = new Date().toISOString();

  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    // Resolver conta
    let account;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1);
      account = accs[0];
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta conectada' }, { status: 404 });

    const aid = account.id;
    const postedBefore = brtDateStr(1);
    const postedAfter  = brtDateStr(7);

    // Auth SP-API
    let tokenResult;
    let authError = null;
    try {
      tokenResult = await getSpAccessToken();
    } catch (e) {
      authError = e.message;
    }

    if (authError || !tokenResult) {
      // Gravar status de erro no SyncExecutionLog para diagnóstico
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: aid,
        operation: 'syncFinanceEventsFromSpApi',
        status: 'error',
        trigger_type: body._service_role ? 'automatic' : 'manual',
        started_at: new Date(t0).toISOString(),
        completed_at: now,
        duration_ms: Date.now() - t0,
        records_processed: 0,
        error_message: authError || 'Token não obtido',
        result_summary: JSON.stringify({ auth_error: authError, window: `${postedAfter} → ${postedBefore}` }),
      }).catch(() => {});

      return Response.json({
        ok: false,
        error_type: 'auth_error',
        error: authError,
        help: 'Verifique as credenciais SP-API: AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET, AMAZON_SP_REFRESH_TOKEN nas configurações → Variáveis de ambiente.',
      }, { status: 502 });
    }

    const { token, source: tokenSource } = tokenResult;

    // Buscar Finance Events (paginado)
    let allEvents = [];
    let nextToken = null;
    let pages = 0;
    let fetchError = null;

    try {
      do {
        const resp = await fetchFinanceEvents(token, postedAfter, postedBefore, nextToken);
        const payload = resp?.payload || resp;
        const evs = payload?.FinancialEvents?.ShipmentEventList || [];
        allEvents = allEvents.concat(evs);
        nextToken = payload?.NextToken || null;
        pages++;
        if (nextToken) await sleep(400);
      } while (nextToken && pages < 20);
    } catch (e) {
      fetchError = e.message;
    }

    if (fetchError) {
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: aid,
        operation: 'syncFinanceEventsFromSpApi',
        status: 'error',
        trigger_type: body._service_role ? 'automatic' : 'manual',
        started_at: new Date(t0).toISOString(),
        completed_at: now,
        duration_ms: Date.now() - t0,
        records_processed: 0,
        error_message: fetchError,
        result_summary: JSON.stringify({ fetch_error: fetchError, token_source: tokenSource }),
      }).catch(() => {});

      return Response.json({ ok: false, error_type: 'api_error', error: fetchError }, { status: 502 });
    }

    const byDate = aggregateShipmentEvents(allEvents);

    // Carregar gasto de ads por data (CampaignMetricsDaily)
    const adsMetrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: aid }, '-date', 500
    ).catch(() => []);
    const adsSpendByDate = {};
    for (const m of adsMetrics) {
      if (!m.date) continue;
      adsSpendByDate[m.date] = (adsSpendByDate[m.date] || 0) + Number(m.spend || 0);
    }

    const results = [];
    let updatedDays = 0;

    for (const [date, agg] of Object.entries(byDate)) {
      const totalFees  = r2(agg.referral_fee + agg.fba_fee + agg.other_fees);
      const grossRev   = r2(agg.gross_revenue);
      const netRev     = r2(grossRev - totalFees - agg.tax_withheld);
      const adsSpend   = r2(adsSpendByDate[date] || 0);
      const mpaPct     = grossRev > 0 ? r2((totalFees / grossRev) * 100) : 0;
      const tacos      = grossRev > 0 ? r2((adsSpend / grossRev) * 100) : 0;
      const profitAfterAds = r2(netRev - adsSpend);
      const ticketMedio = agg.orders > 0 ? r2(grossRev / agg.orders) : 0;

      const financeData = {
        gross_revenue: grossRev,
        net_revenue: netRev,
        amazon_fees: totalFees,
        referral_fee: r2(agg.referral_fee),
        fba_fee: r2(agg.fba_fee),
        tax_withheld: r2(agg.tax_withheld),
        other_fees: r2(agg.other_fees),
        mpa_pct: mpaPct,
        ads_spend: adsSpend,
        profit_after_ads: profitAfterAds,
        finance_sync_status: 'synced',
        finance_synced_at: now,
        finance_events_count: agg.events_count,
        // Campos para exibição no Dashboard
        orders: agg.orders,
        units_ordered: agg.units,
        ordered_product_sales: grossRev, // compatibilidade com campo existente
      };

      // Upsert: buscar registro agregado do dia (sem asin) ou criar novo
      const dayRecords = await base44.asServiceRole.entities.SalesDaily.filter(
        { amazon_account_id: aid, date }, null, 10
      ).catch(() => []);
      const aggRecord = dayRecords.find(r => !r.asin);

      if (aggRecord) {
        await base44.asServiceRole.entities.SalesDaily.update(aggRecord.id, financeData).catch(() => {});
      } else {
        await base44.asServiceRole.entities.SalesDaily.create({
          amazon_account_id: aid,
          date,
          ...financeData,
        }).catch(() => {});
      }

      updatedDays++;
      results.push({ date, gross_revenue: grossRev, net_revenue: netRev, amazon_fees: totalFees, mpa_pct: mpaPct, ads_spend: adsSpend, tacos, profit_after_ads: profitAfterAds, orders: agg.orders, units: agg.units, ticket_medio: ticketMedio, events_count: agg.events_count });
    }

    const yesterday = brtDateStr(1);
    const yResult = results.find(r => r.date === yesterday);

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'syncFinanceEventsFromSpApi',
      status: 'success',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      started_at: new Date(t0).toISOString(),
      completed_at: now,
      duration_ms: Date.now() - t0,
      records_processed: updatedDays,
      result_summary: JSON.stringify({ window: `${postedAfter} → ${postedBefore}`, days_processed: updatedDays, total_events: allEvents.length, pages, token_source: tokenSource, yesterday: yResult || null }).slice(0, 4000),
    }).catch(() => {});

    return Response.json({
      ok: true,
      token_source: tokenSource,
      window: `${postedAfter} → ${postedBefore}`,
      pages_fetched: pages,
      total_events: allEvents.length,
      days_processed: updatedDays,
      results,
      duration_ms: Date.now() - t0,
    });

  } catch (err) {
    return Response.json({ ok: false, error: err.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});