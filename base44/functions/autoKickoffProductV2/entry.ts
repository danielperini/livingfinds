import { hasFreshAdsInventory, availableAdsStock } from '../../shared/stockAdsPolicy.ts';
import { isProductEligibleForCampaignActivation, campaignMatchesProduct } from '../../shared/productCampaignPauseGuard.ts';
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms:number) => new Promise((resolve) => setTimeout(resolve, ms));

function brazilHour() {
  const parts = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).formatToParts(new Date());
  return Number(parts.find((part) => part.type === 'hour')?.value || 0);
}

function inWindow() { return [0, 1, 2, 3, 13].includes(brazilHour()); }

async function ads(base44:any, accountId:string, operation:string, method:string, path:string, payload:any, contentType='application/json') {
  const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
    amazon_account_id: accountId, operation, method, path, payload,
    content_type: contentType, accept: contentType, _service_role: true,
  });
  return response?.data || response || {};
}

function idFrom(data:any, group:string, field:string) {
  const payload = data?.payload || data || {};
  return payload?.[group]?.success?.[0]?.[field]
    || payload?.success?.[0]?.[field]
    || payload?.[group]?.[0]?.[field]
    || (Array.isArray(payload) ? payload[0]?.[field] : null);
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    const body = await request.json().catch(() => ({}));
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const accountId = body.amazon_account_id;
    const asin = String(body.asin || '').trim().toUpperCase();
    if (!accountId || !asin) return Response.json({ ok: false, error: 'amazon_account_id e asin são obrigatórios' }, { status: 400 });

    const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId, asin, ...(body.sku ? { sku: body.sku } : {}) }, '-updated_at', 100);
    const currentProducts = products.filter((p:any) => p.status !== 'archived');
    const product = currentProducts.length === 1 ? currentProducts[0] : null;
    if (!product) return Response.json({ ok: false, blocked: true, error: 'Produto não encontrado no banco do app.' }, { status: 404 });
    if (!hasFreshAdsInventory(product) || availableAdsStock(product) <= 0 || !isProductEligibleForCampaignActivation(product) || product.ads_scope_status !== 'authorized') {
      return Response.json({ ok: false, blocked: true, error: 'Kickoff requer FBA disponível atualizado, oferta elegível e SKU autorizado' });
    }
    if (product.cost_confirmed !== true || product.cost_confirmation_required === true) {
      return Response.json({
        ok: false, blocked: true, reason: 'cost_confirmation_required',
        error: 'Confirme o custo do produto e o custo extra antes de criar campanhas.',
        product_id: product.id, asin, product_cost: product.product_cost ?? null, extra_cost: product.extra_cost ?? 0,
      }, { status: 409 });
    }

    const price = Number(product.buy_box_price || product.price || 0);
    const productCost = Number(product.product_cost || 0);
    const extraCost = Number(product.extra_cost || 0);
    const amazonFees = Number(product.amazon_fees || 0);
    const availableProfit = Math.max(0, Number((price - productCost - extraCost - amazonFees).toFixed(2)));
    if (price <= 0 || availableProfit <= 0) {
      return Response.json({
        ok: false, blocked: true, reason: 'no_available_profit',
        error: 'Campanhas bloqueadas: preço ou lucro disponível por venda é insuficiente.',
        price, product_cost: productCost, extra_cost: extraCost, amazon_fees: amazonFees, available_profit_per_sale: availableProfit,
      }, { status: 409 });
    }

    const breakEvenAcos = Number(((availableProfit / price) * 100).toFixed(2));
    const maxAdSpendPerOrder = availableProfit;
    const budget = Math.max(1, Math.min(5, Number((availableProfit * 0.30).toFixed(2))));
    const bid = Math.max(0.10, Math.min(0.50, Number((availableProfit * 0.10).toFixed(2))));
    await base44.asServiceRole.entities.Product.update(product.id, {
      contribution_margin: availableProfit,
      available_profit_per_sale: availableProfit,
      maximum_ad_spend_per_order: maxAdSpendPerOrder,
      break_even_acos_pct: breakEvenAcos,
      profit_margin_pct: breakEvenAcos,
      auto_campaign_eligible: true,
    });

    if (!body._window_execution && !inWindow()) {
      const response = await base44.functions.invoke('scheduleProductKickoff', {
        amazon_account_id: accountId, asin, sku: product.sku, product_name: product.product_name || product.display_name || asin, mode: 'auto_plus_four',
      });
      return Response.json({ ...(response?.data || response || {}), profitability_guard: { available_profit_per_sale: availableProfit, maximum_ad_spend_per_order: maxAdSpendPerOrder, break_even_acos_pct: breakEvenAcos, initial_budget: budget, initial_bid: bid } });
    }

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: accountId }, null, 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon não encontrada' }, { status: 404 });

    const existingCampaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId, asin }, '-created_date', 200);
    const existingAuto = existingCampaigns.find((campaign:any) => campaignMatchesProduct(campaign, product) && String(campaign.targeting_type || '').toUpperCase() === 'AUTO' && !campaign.archived && !['archived', 'ended'].includes(String(campaign.state || campaign.status).toLowerCase()));
    let autoCampaign = existingAuto;
    const autoAlreadyExisted = Boolean(existingAuto);

    if (!autoAlreadyExisted) {
      const now = new Date().toISOString();
      const name = `AUTO | ${asin} | ${now.slice(0, 10)}`;
      const response = await ads(base44, accountId, 'createAutoCampaign', 'POST', '/sp/campaigns', {
        campaigns: [{ name, targetingType: 'AUTO', state: 'ENABLED', budget: { budgetType: 'DAILY', budget }, startDate: now.slice(0, 10) }],
      }, 'application/vnd.spCampaign.v3+json');
      const campaignId = idFrom(response, 'campaigns', 'campaignId');
      if (!campaignId) return Response.json({ ok: false, error: response?.errors?.[0]?.message || 'Amazon não retornou campaignId da AUTO' });

      await wait(14000);
      const adGroupResponse = await ads(base44, accountId, 'createAutoAdGroup', 'POST', '/sp/adGroups', {
        adGroups: [{ name: `AG | AUTO | ${asin}`, campaignId, defaultBid: bid, state: 'ENABLED' }],
      }, 'application/vnd.spAdGroup.v3+json');
      const adGroupId = idFrom(adGroupResponse, 'adGroups', 'adGroupId');
      if (adGroupId) {
        await wait(14000);
        await ads(base44, accountId, 'createAutoProductAd', 'POST', '/sp/productAds', {
          productAds: [{ campaignId, adGroupId, ...(product?.sku ? { sku: product.sku } : { asin }), state: 'ENABLED' }],
        }, 'application/vnd.spProductAd.v3+json');
      }
      autoCampaign = await base44.asServiceRole.entities.Campaign.create({
        amazon_account_id: accountId, campaign_id: String(campaignId), asin, sku: product.sku || null,
        name, campaign_name: name, campaign_type: 'SP', targeting_type: 'AUTO', state: 'enabled', status: 'enabled',
        daily_budget: budget, created_by_app: true, launch_phase: 'new', created_at: now, synced_at: now,
      });
    }

    const strategy = {
      version: 'kickoff-auto-discovery-v1', owner: 'runCanonicalDecisionCycle',
      phase: 'AUTO_DISCOVERY', initial_bid: bid, initial_daily_budget: budget,
      available_profit_per_sale: availableProfit,
      stages: ['AUTO_DISCOVERY', 'DAILY_SAME_SKU_REPORTS', 'PROFITABLE_EXACT_PROMOTION', 'CONTROLLED_EXPANSION'],
      winner_rule: 'confirmed_same_sku_sales_positive_margin_no_duplicate',
      no_fixed_manual_campaign_count: true, daily_review: true,
      source: 'decision_engine_fallback', created_at: new Date().toISOString(),
    };
    await base44.asServiceRole.entities.Product.update(product.id, { kickoff_strategy: strategy });
    const harvestResponse = await base44.asServiceRole.functions.invoke('runImmediateSameSkuSearchTermHarvest', {
      amazon_account_id: accountId, sku: product.sku, lookback_days: 30, max_promotions: 2,
      require_fresh_inventory: true, _service_role: true, trigger_type: 'kickoff_strategy',
    }).catch((error:any) => ({ data: { ok: false, error: error.message } }));
    const harvest = harvestResponse?.data || harvestResponse || {};
    return Response.json({
      ok: true, asin, strategy,
      auto_campaign: { ok: true, campaign_id: autoCampaign.campaign_id, already_exists: autoAlreadyExisted },
      manual_campaigns_created: (harvest.reports || []).reduce((sum:number, row:any) => sum + Number(row.promoted || 0), 0),
      manual_campaigns_waiting_for_evidence: true,
      winner_stage: harvest,
      profitability_guard: { price, product_cost: productCost, extra_cost: extraCost, amazon_fees: amazonFees, available_profit_per_sale: availableProfit, initial_budget: budget, initial_bid: bid },
      gateway: true,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro no Kick-off V2' }, { status: 500 });
  }
});