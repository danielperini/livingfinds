import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const num = (value: any) => Number(value || 0);
const campaignId = (row: any) => String(row.campaign_id || row.amazon_campaign_id || '').trim();
const isEnabled = (row: any) => String(row.amazon_status || row.state || row.status || '').toUpperCase() === 'ENABLED';
const isManual = (row: any) => String(row.targeting_type || '').toUpperCase() === 'MANUAL'
  || String(row.name || row.campaign_name || '').toUpperCase().includes('MANUAL');

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const body = await req.json().catch(() => ({}));
  if (body._service_role !== true) {
    const user = await base44.auth.me().catch(() => null);
    if (!user || user.role !== 'admin') return Response.json({ ok: false, error: 'Admin only' }, { status: 403 });
  }

  const aid = String(body.amazon_account_id || '').trim();
  if (!aid) return Response.json({ ok: false, error: 'amazon_account_id required' }, { status: 400 });
  const days = 10;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [campaigns, metrics] = await Promise.all([
    base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, '-updated_date', 5000),
    base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 10000),
  ]);

  const totals = new Map<string, { spend: number; sales: number; orders: number }>();
  const todayTotals = new Map<string, { spend: number; sales: number; orders: number }>();
  for (const row of metrics) {
    if (String(row.date || '').slice(0, 10) < cutoff) continue;
    const cid = String(row.campaign_id || row.amazon_campaign_id || '').trim();
    if (!cid) continue;
    const total = totals.get(cid) || { spend: 0, sales: 0, orders: 0 };
    total.spend += num(row.spend);
    total.sales += num(row.sales || row.sales_14d || row.attributed_sales);
    total.orders += num(row.orders || row.orders_14d || row.attributed_conversions);
    totals.set(cid, total);
    if (String(row.date || '').slice(0, 10) === today) {
      const daily = todayTotals.get(cid) || { spend: 0, sales: 0, orders: 0 };
      daily.spend += num(row.spend);
      daily.sales += num(row.sales || row.sales_14d || row.attributed_sales);
      daily.orders += num(row.orders || row.orders_14d || row.attributed_conversions);
      todayTotals.set(cid, daily);
    }
  }

  const candidates = campaigns.filter((campaign: any) => {
    const cid = campaignId(campaign);
    const performance = totals.get(cid);
    const created = String(campaign.created_at || campaign.created_date || '').slice(0, 10);
    const daily = todayTotals.get(cid);
    const tenDayWaste = (!created || created <= cutoff) && num(performance?.spend) > 0
      && num(performance?.sales) === 0 && num(performance?.orders) === 0;
    const dailyLossCap = num(daily?.spend) >= 10 && num(daily?.sales) === 0 && num(daily?.orders) === 0;
    return cid && isEnabled(campaign) && isManual(campaign) && (tenDayWaste || dailyLossCap);
  });

  const paused: any[] = [];
  const errors: any[] = [];
  for (const campaign of candidates) {
    const cid = campaignId(campaign);
    const performance = totals.get(cid)!;
    const daily = todayTotals.get(cid) || { spend: 0, sales: 0, orders: 0 };
    const dailyCapTriggered = daily.spend >= 10 && daily.sales === 0 && daily.orders === 0;
    const reasonCode = dailyCapTriggered ? 'DAILY_ZERO_SALES_LOSS_CAP_10_BRL' : 'MANUAL_SPEND_ZERO_SALES_10D';
    const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
      _service_role: true, amazon_account_id: aid, operation: 'pauseManualCampaignNoSales10d',
      method: 'PUT', path: '/sp/campaigns', payload: { campaigns: [{ campaignId: cid, state: 'PAUSED' }] },
      content_type: 'application/vnd.spCampaign.v3+json', accept: 'application/vnd.spCampaign.v3+json',
    }).catch((error: any) => ({ data: { ok: false, error: error?.message } }));
    const data = response?.data || response || {};
    if (data.ok !== true) {
      errors.push({ campaign_id: cid, campaign_name: campaign.name || campaign.campaign_name, error: data.error || 'Amazon rejected pause' });
      continue;
    }
    const now = new Date().toISOString();
    await base44.asServiceRole.entities.Campaign.update(campaign.id, {
      state: 'paused', status: 'paused', amazon_status: 'PAUSED', is_operational: false,
      last_pause_reason: reasonCode, last_activity_at: now, synced_at: now,
    });
    await base44.asServiceRole.entities.Decision.create({
      amazon_account_id: aid, campaign_id: cid, campaign_name: campaign.name || campaign.campaign_name,
      asin: campaign.asin || null, sku: campaign.sku || null, entity_type: 'campaign', entity_id: cid,
      decision_type: 'campaign_pause', action: 'pause_campaign', canonical_action_type: 'PAUSE_CAMPAIGN',
      status: 'confirmed', queue_status: 'confirmed', amazon_confirmation_status: 'confirmed',
      reason_code: reasonCode, rationale: dailyCapTriggered
        ? `Campanha MANUAL atingiu R$ ${daily.spend.toFixed(2)} hoje sem venda. Teto diário de perda de R$10 acionado e pausa confirmada pela Amazon.`
        : `Campanha MANUAL gastou R$ ${performance.spend.toFixed(2)} e teve zero vendas nos últimos 10 dias. Pausa confirmada pela Amazon.`,
      data_used: JSON.stringify({ lookback_days: days, spend: performance.spend, daily_spend: daily.spend, sales: 0, orders: 0 }),
      operational_visibility: 'visible', executed_at: now, confirmed_at: now, created_at: now,
    }).catch(() => {});
    paused.push({ campaign_id: cid, campaign_name: campaign.name || campaign.campaign_name,
      reason_code: reasonCode, spend_10d: Number(performance.spend.toFixed(2)), spend_today: Number(daily.spend.toFixed(2)) });
  }

  return Response.json({ ok: errors.length === 0, lookback_days: days, evaluated: campaigns.length,
    candidates: candidates.length, paused_count: paused.length, paused, errors });
});
