/**
 * syncFinanceEventsFromSpApi
 *
 * Busca Finance Events da SP-API para os últimos 7 dias fechados (D-7 a D-1).
 * Extrai por ShipmentEvent: Principal (gross_revenue), FBAFee, ReferralFee,
 * MarketplaceFacilitatorTax e outros.
 * Persiste em SalesDaily (por data agregada, não por ASIN).
 * Atualiza ProductEconomics quando divergência de amazon_fees > 5%.
 * Registra em SyncExecutionLog.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function r2(v) { return parseFloat((Number(v) || 0).toFixed(2)); }

// BRT helpers
function brtDateStr(daysAgo = 0) {
  const d = new Date(Date.now() - (3 * 3600000) - (daysAgo * 86400000));
  return d.toISOString().slice(0, 10);
}

// Obter SP-API access token via LWA
async function getSpAccessToken() {
  const clientId     = Deno.env.get('SP_CLIENT_ID')     || Deno.env.get('AMAZON_LWA_CLIENT_ID');
  const clientSecret = Deno.env.get('SP_CLIENT_SECRET') || Deno.env.get('AMAZON_LWA_CLIENT_SECRET');
  const refreshToken = Deno.env.get('SP_REFRESH_TOKEN') || Deno.env.get('AMAZON_SP_REFRESH_TOKEN');

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('SP-API credentials missing (SP_CLIENT_ID / SP_CLIENT_SECRET / SP_REFRESH_TOKEN)');
  }

  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LWA token error ${res.status}: ${err.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.access_token;
}

// Chamar SP-API Finance Events
async function fetchFinanceEvents(accessToken, sellerId, marketplaceId, postedAfter, postedBefore, nextToken = null) {
  const base = 'https://sellingpartnerapi-na.amazon.com';
  let url = `${base}/finances/2024-06-19/financialEvents?PostedAfter=${postedAfter}T00:00:00Z&PostedBefore=${postedBefore}T23:59:59Z&MaxResultsPerPage=100`;
  if (nextToken) url += `&NextToken=${encodeURIComponent(nextToken)}`;

  const res = await fetch(url, {
    headers: {
      'x-amz-access-token': accessToken,
      'x-amz-date': new Date().toISOString().replace(/[:-]/g, '').slice(0, 15) + 'Z',
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

// Extrair valor monetário de estruturas Amazon { CurrencyCode, CurrencyAmount }
function moneyVal(obj) {
  if (!obj) return 0;
  return Number(obj.CurrencyAmount || obj.amount || 0);
}

// Agregar ShipmentEvents por data
function aggregateShipmentEvents(events) {
  const byDate = {};

  for (const ev of events || []) {
    // Determinar data do evento (BRT)
    const raw = ev.PostedDate || ev.postedDate;
    if (!raw) continue;
    const dateBRT = new Date(new Date(raw).getTime() - 3 * 3600000).toISOString().slice(0, 10);

    if (!byDate[dateBRT]) {
      byDate[dateBRT] = {
        gross_revenue: 0, referral_fee: 0, fba_fee: 0,
        tax_withheld: 0, other_fees: 0, events_count: 0,
      };
    }
    const agg = byDate[dateBRT];
    agg.events_count++;

    // ShipmentItems
    for (const item of ev.ShipmentItemList || []) {
      // Principal (faturamento bruto)
      for (const charge of item.ItemChargeList || []) {
        const type = (charge.ChargeType || '').toLowerCase();
        const val  = moneyVal(charge.ChargeAmount);
        if (type === 'principal') agg.gross_revenue += val;
      }

      // Taxas itemizadas
      for (const fee of item.ItemFeeList || []) {
        const type = (fee.FeeType || '').toLowerCase();
        const val  = moneyVal(fee.FeeAmount);
        if (type.includes('referral') || type === 'referralfee') {
          agg.referral_fee += Math.abs(val);
        } else if (type.includes('fba') || type.includes('fulfillment') || type === 'fbaperorderfulfilmentfee' || type === 'fbaperunitfulfilmentfee' || type === 'fbaweightbasedfee') {
          agg.fba_fee += Math.abs(val);
        } else {
          agg.other_fees += Math.abs(val);
        }
      }

      // Impostos retidos (MarketplaceFacilitatorTax)
      for (const tax of item.MarketplaceTaxInfoList || item.MarketplaceFacilitatorTaxList || []) {
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

    // Auth: service role ou usuário autenticado
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
    const sellerId     = Deno.env.get('AMAZON_SELLER_ID') || account.seller_id || '';
    const marketplaceId = Deno.env.get('AMAZON_MARKETPLACE_ID') || account.marketplace_id || '';

    // Janela: D-7 até D-1 (fechado)
    const postedBefore = brtDateStr(1); // ontem
    const postedAfter  = brtDateStr(7); // 7 dias atrás

    // Obter token SP-API
    let accessToken;
    try {
      accessToken = await getSpAccessToken();
    } catch (e) {
      return Response.json({ ok: false, error: `Auth SP-API: ${e.message}` }, { status: 502 });
    }

    // Buscar todos os Finance Events (paginado)
    let allShipmentEvents = [];
    let nextToken = null;
    let pages = 0;

    do {
      const resp = await fetchFinanceEvents(accessToken, sellerId, marketplaceId, postedAfter, postedBefore, nextToken);
      const payload = resp?.payload || resp;
      const shipEvents = payload?.FinancialEvents?.ShipmentEventList || [];
      allShipmentEvents = allShipmentEvents.concat(shipEvents);
      nextToken = payload?.NextToken || null;
      pages++;
      if (nextToken) await sleep(500);
    } while (nextToken && pages < 20);

    // Agregar por data
    const byDate = aggregateShipmentEvents(allShipmentEvents);

    // Carregar ProductEconomics para referência de CMV
    const economics = await base44.asServiceRole.entities.ProductEconomics.filter(
      { amazon_account_id: aid }, null, 500
    ).catch(() => []);

    // Soma de custos variáveis por unidade (referência para gross_profit)
    const avgUnitCost = economics.length > 0
      ? economics.reduce((s, e) => s + Number(e.unit_cost || e.total_variable_cost_per_unit || 0), 0) / economics.length
      : 0;

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
    let econUpdated = 0;

    for (const [date, agg] of Object.entries(byDate)) {
      const totalFees = r2(agg.referral_fee + agg.fba_fee + agg.other_fees);
      const grossRevenue = r2(agg.gross_revenue);
      const netRevenue   = r2(grossRevenue - totalFees - agg.tax_withheld);
      const adsSpend     = r2(adsSpendByDate[date] || 0);

      // Gross profit estimado usando CMV médio e unidades vendidas (proxy)
      // Sem dados de unidades por dia nos Finance Events, usar margem de net_revenue como referência
      // gross_profit ≈ net_revenue * (1 - avgUnitCostRatio), mas sem unidades exatas usamos net direto
      const grossProfit = r2(netRevenue); // será refinado quando unidades estiverem disponíveis
      const grossMarginPct = grossRevenue > 0 ? r2((grossProfit / grossRevenue) * 100) : 0;
      const mpaPct = grossRevenue > 0 ? r2((totalFees / grossRevenue) * 100) : 0;
      const profitAfterAds = r2(grossProfit - adsSpend);

      // Upsert em SalesDaily (por conta + data — agrega todos os ASINs)
      const existing = await base44.asServiceRole.entities.SalesDaily.filter(
        { amazon_account_id: aid, date, asin: null }, null, 1
      ).catch(async () => {
        // Fallback: buscar sem asin null
        return base44.asServiceRole.entities.SalesDaily.filter(
          { amazon_account_id: aid, date }, null, 1
        ).catch(() => []);
      });

      // Buscar registro sem ASIN (dia agregado)
      const allDayRecords = await base44.asServiceRole.entities.SalesDaily.filter(
        { amazon_account_id: aid, date }, null, 10
      ).catch(() => []);
      const aggRecord = allDayRecords.find(r => !r.asin);

      const financeData = {
        gross_revenue: grossRevenue,
        net_revenue: netRevenue,
        amazon_fees: totalFees,
        referral_fee: r2(agg.referral_fee),
        fba_fee: r2(agg.fba_fee),
        tax_withheld: r2(agg.tax_withheld),
        other_fees: r2(agg.other_fees),
        gross_profit: grossProfit,
        gross_margin_pct: grossMarginPct,
        mpa_pct: mpaPct,
        ads_spend: adsSpend,
        profit_after_ads: profitAfterAds,
        finance_sync_status: 'synced',
        finance_synced_at: now,
        finance_events_count: agg.events_count,
      };

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

      // Verificar divergência de amazon_fees vs ProductEconomics cadastrado
      // amazon_fee_amount é o fee por unidade — comparar com total/unidades do dia se disponível
      const dayUnits = allDayRecords.reduce((s, r) => s + (r.units_ordered || 0), 0);
      if (dayUnits > 0 && totalFees > 0 && economics.length > 0) {
        const avgFeePerUnit = totalFees / dayUnits;
        for (const econ of economics) {
          const storedFee = Number(econ.amazon_fee_amount || 0);
          if (storedFee <= 0) continue;
          const delta = Math.abs(avgFeePerUnit - storedFee) / storedFee;
          if (delta > 0.05) { // > 5%
            // Registrar em ProductEconomicsHistory antes de atualizar
            await base44.asServiceRole.entities.ProductEconomicsHistory.create({
              amazon_account_id: aid,
              product_id: econ.id,
              asin: econ.asin,
              sku: econ.sku,
              snapshot_date: date,
              change_source: 'finance_sync_auto_correction',
              change_reason: `Divergência de taxas Amazon: ${(delta * 100).toFixed(1)}% entre Finance Events (R$${avgFeePerUnit.toFixed(2)}/un) e cadastro (R$${storedFee.toFixed(2)}/un)`,
              amazon_fee_amount_before: storedFee,
              amazon_fee_amount_after: r2(avgFeePerUnit),
              created_at: now,
            }).catch(() => {});

            // Recalcular contribution_margin e break_even
            const price = Number(econ.current_price || econ.average_sale_price || 0);
            const totalVarCost = Number(econ.total_variable_cost_per_unit || econ.unit_cost || 0);
            const newContribMarginAmt = price > 0 ? r2(price - totalVarCost - avgFeePerUnit) : econ.contribution_margin_amount;
            const newContribMarginPct = price > 0 ? r2((newContribMarginAmt / price) * 100) : econ.contribution_margin_percent;
            const newBreakEven = price > 0 ? r2((newContribMarginAmt / price) * 100) : econ.break_even_acos;

            await base44.asServiceRole.entities.ProductEconomics.update(econ.id, {
              amazon_fee_amount: r2(avgFeePerUnit),
              amazon_fee_percent: price > 0 ? r2((avgFeePerUnit / price) * 100) : econ.amazon_fee_percent,
              contribution_margin_amount: newContribMarginAmt,
              contribution_margin_percent: newContribMarginPct,
              break_even_acos: newBreakEven,
              fees_source: 'finance_events_auto',
              last_calculated_at: now,
              updated_at: now,
            }).catch(() => {});
            econUpdated++;
          }
        }
      }

      results.push({
        date,
        gross_revenue: grossRevenue,
        net_revenue: netRevenue,
        amazon_fees: totalFees,
        mpa_pct: mpaPct,
        profit_after_ads: profitAfterAds,
        events_count: agg.events_count,
      });
    }

    // Log de execução
    const yesterday = brtDateStr(1);
    const yesterdayResult = results.find(r => r.date === yesterday);

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'syncFinanceEventsFromSpApi',
      status: 'success',
      trigger_type: 'finance_sync',
      started_at: new Date(t0).toISOString(),
      completed_at: now,
      duration_ms: Date.now() - t0,
      records_processed: updatedDays,
      result_summary: JSON.stringify({
        window: `${postedAfter} → ${postedBefore}`,
        days_processed: updatedDays,
        econ_updated: econUpdated,
        total_events: allShipmentEvents.length,
        pages,
        yesterday_snapshot: yesterdayResult || null,
        // Referência do Seller Central de 19/jul (conforme PRD)
        seller_central_ref: {
          date: '2026-07-19',
          gross: 1001.56,
          net: 825.08,
          gross_profit: 250.33,
          margin_pct: 24.99,
          ads_spend: 95.74,
          tacos_pct: 9.56,
          profit_after_ads: 154.59,
          mpa_pct: 15.43,
        },
      }).slice(0, 4000),
    }).catch(() => {});

    return Response.json({
      ok: true,
      window: `${postedAfter} → ${postedBefore}`,
      pages_fetched: pages,
      total_events: allShipmentEvents.length,
      days_processed: updatedDays,
      econ_updated: econUpdated,
      results,
      duration_ms: Date.now() - t0,
    });

  } catch (err) {
    return Response.json({ ok: false, error: err.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});