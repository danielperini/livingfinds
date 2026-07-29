import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const PAUSE_SKUS = new Set(['FBA-0087C','FBA-0008P','FBA-0100','SKU-002314A','FBA-0065PR','SKU-002314V']);
const BID_REDUCTIONS: Record<string, number> = { 'FBA-0088A': 0.15 };
const DAILY_ORDER_CAPS: Record<string, number> = { 'FBA-0087B': 1 };
const MIN_BID = 0.20;

const norm = (v: unknown) => String(v || '').trim().toUpperCase();
const todayBrt = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

async function tokenFor(account: any) {
  const refreshToken = Deno.env.get('ADS_REFRESH_TOKEN') || account.ads_refresh_token;
  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: refreshToken || '',
      client_id: Deno.env.get('ADS_CLIENT_ID') || '', client_secret: Deno.env.get('ADS_CLIENT_SECRET') || '',
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(data.error_description || data.error || `Token HTTP ${response.status}`);
  return data.access_token as string;
}

function baseUrl(account: any) {
  const region = norm(account.region || Deno.env.get('ADS_REGION') || 'NA');
  if (region.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (region.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsPut(account: any, token: string, path: string, body: any, contentType: string) {
  const response = await fetch(`${baseUrl(account)}${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': String(account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || ''),
      'Content-Type': contentType, Accept: contentType,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  const errors = data?.campaigns?.error || data?.keywords?.error || data?.errors || [];
  if (!response.ok || (Array.isArray(errors) && errors.length)) throw new Error(`Amazon HTTP ${response.status}: ${JSON.stringify(errors).slice(0, 400)}`);
  return data;
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const day = todayBrt();
    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id })
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' });
    const allResults: any[] = [];

    for (const account of accounts) {
      const [products, campaigns, keywords, metrics, priorEvents] = await Promise.all([
        base44.asServiceRole.entities.Product.filter({ amazon_account_id: account.id }, null, 500).catch(() => []),
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: account.id }, null, 1000).catch(() => []),
        base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: account.id }, null, 3000).catch(() => []),
        base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: account.id, date: day }, null, 3000).catch(() => []),
        base44.asServiceRole.entities.RuleExecution.filter({ amazon_account_id: account.id }, '-created_date', 1000).catch(() => []),
      ]);
      const token = body.dry_run ? '' : await tokenFor(account);
      const productBySku = new Map(products.map((p: any) => [norm(p.sku), p]));
      const skuForCampaign = (campaign: any) => {
        if (campaign.sku) return norm(campaign.sku);
        const product = products.find((p: any) => p.asin && campaign.asin && norm(p.asin) === norm(campaign.asin));
        return norm(product?.sku);
      };
      const campaignOrders = new Map<string, number>();
      for (const metric of metrics) {
        const id = String(metric.campaign_id || '');
        campaignOrders.set(id, (campaignOrders.get(id) || 0) + Number(metric.orders || metric.purchases || 0));
      }
      const actions: any[] = [];

      for (const campaign of campaigns) {
        if (campaign.archived || norm(campaign.state) === 'ARCHIVED') continue;
        const campaignId = String(campaign.campaign_id || campaign.amazon_campaign_id || '');
        const sku = skuForCampaign(campaign);
        if (!campaignId || !sku) continue;
        const state = norm(campaign.amazon_status || campaign.state || campaign.status);
        let desired: 'PAUSED' | 'ENABLED' | null = null;
        let reason = '';

        if (PAUSE_SKUS.has(sku)) {
          desired = 'PAUSED';
          reason = 'PROFIT_GUARD: prejuízo pós-Ads ou gasto sem vendas; pausa até correção econômica';
        } else if (DAILY_ORDER_CAPS[sku]) {
          const orders = campaignOrders.get(campaignId) || 0;
          const cappedToday = priorEvents.some((event: any) => event.rule_key === 'sku_daily_order_cap' && event.entity_id === campaignId && String(event.executed_at || event.created_date || '').slice(0, 10) === day && event.status === 'executed');
          if (orders >= DAILY_ORDER_CAPS[sku]) {
            desired = 'PAUSED';
            reason = `DAILY_ORDER_CAP: ${sku} atingiu ${orders} pedido(s) hoje; limite ${DAILY_ORDER_CAPS[sku]}`;
          } else if (state === 'PAUSED' && !cappedToday) {
            desired = 'ENABLED';
            reason = `DAILY_ORDER_CAP_RESET: ${sku} liberado para o primeiro pedido de ${day}`;
          }
        }
        if (!desired || state === desired) continue;

        if (!body.dry_run) {
          await adsPut(account, token, '/sp/campaigns', { campaigns: [{ campaignId, state: desired }] }, 'application/vnd.spCampaign.v3+json');
          await base44.asServiceRole.entities.Campaign.update(campaign.id, {
            state: desired.toLowerCase(), status: desired.toLowerCase(), amazon_status: desired.toLowerCase(),
            synced_at: new Date().toISOString(), last_activity_at: new Date().toISOString(),
          });
          await base44.asServiceRole.entities.RuleExecution.create({
            amazon_account_id: account.id, rule_key: DAILY_ORDER_CAPS[sku] ? 'sku_daily_order_cap' : 'sku_profit_hard_pause',
            rule_version: 1, entity_type: 'campaign', entity_id: campaignId, campaign_id: campaignId,
            asin: campaign.asin || productBySku.get(sku)?.asin || null, action_type: desired === 'PAUSED' ? 'pause_campaign' : 'enable_campaign',
            status: 'executed', reason, executed_at: new Date().toISOString(),
            idempotency_key: `sku_guard|${account.id}|${sku}|${campaignId}|${desired}|${day}`,
          }).catch(() => {});
        }
        actions.push({ sku, campaign_id: campaignId, action: desired, reason });
      }

      for (const [sku, reduction] of Object.entries(BID_REDUCTIONS)) {
        const product = productBySku.get(sku);
        const campaignIds = new Set(campaigns.filter((c: any) => skuForCampaign(c) === sku).map((c: any) => String(c.campaign_id || c.amazon_campaign_id || '')));
        for (const keyword of keywords) {
          const campaignId = String(keyword.campaign_id || '');
          if (!campaignIds.has(campaignId)) continue;
          const keywordId = String(keyword.amazon_keyword_id || keyword.keyword_id || '');
          const oldBid = Number(keyword.bid || keyword.current_bid || 0);
          // A Amazon aceita somente o ID remoto numérico. Registros legados "kw_*"
          // são IDs locais e nunca devem ser enviados à Ads API.
          if (!/^\d+$/.test(keywordId) || oldBid <= 0) continue;
          const already = priorEvents.some((event: any) => event.idempotency_key === `sku_guard_bid|${account.id}|${sku}|${keywordId}|${day}`);
          if (already) continue;
          const newBid = Math.max(MIN_BID, Math.round(oldBid * (1 - reduction) * 100) / 100);
          if (newBid >= oldBid) continue;
          if (!body.dry_run) {
            await adsPut(account, token, '/sp/keywords', { keywords: [{ keywordId, bid: newBid }] }, 'application/vnd.spKeyword.v3+json');
            await base44.asServiceRole.entities.Keyword.update(keyword.id, { bid: newBid, current_bid: newBid, last_bid_change_at: new Date().toISOString() });
            await base44.asServiceRole.entities.RuleExecution.create({
              amazon_account_id: account.id, rule_key: 'sku_low_margin_bid_reduction', rule_version: 1,
              entity_type: 'keyword', entity_id: keywordId, keyword_id: keywordId, campaign_id: campaignId,
              asin: product?.asin || keyword.asin || null, action_type: 'update_bid', value_before: oldBid, value_after: newBid,
              status: 'executed', reason: `${sku}: margem pós-Ads estreita; redução conservadora de ${Math.round(reduction * 100)}%`,
              executed_at: new Date().toISOString(), idempotency_key: `sku_guard_bid|${account.id}|${sku}|${keywordId}|${day}`,
            }).catch(() => {});
          }
          actions.push({ sku, keyword_id: keywordId, action: 'BID_DOWN', old_bid: oldBid, new_bid: newBid });
        }
      }

      allResults.push({ account_id: account.id, date: day, actions });
    }

    return Response.json({ ok: true, dry_run: Boolean(body.dry_run), policy: { pause_skus: [...PAUSE_SKUS], bid_reductions: BID_REDUCTIONS, daily_order_caps: DAILY_ORDER_CAPS }, results: allResults });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Falha na proteção econômica por SKU' }, { status: 500 });
  }
});
