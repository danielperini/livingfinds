import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const n = (value: any) => Number(value || 0);
const state = (row: any) => String(row?.state || row?.status || '').toLowerCase();

Deno.serve(async (req) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accountRows = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1).catch(() => [])
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 1).catch(() => []);
    const account = accountRows[0];
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon não encontrada' }, { status: 404 });

    const aid = account.id;
    const fullExpansion = body.full_expansion === true;
    const dryRun = body.dry_run === true;
    const today = new Date().toISOString().slice(0, 10);
    const since7 = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

    const [campaigns, metrics, searchTerms] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, '-updated_at', 3000).catch(() => []),
      base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 10000).catch(() => []),
      base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id: aid }, '-orders_30d', 5000).catch(() => []),
    ]);

    const active = campaigns.filter((campaign: any) =>
      ['enabled', 'active'].includes(state(campaign)) && !campaign.archived
    );
    const metricsByCampaign = new Map<string, any>();
    for (const row of metrics) {
      if (!row.campaign_id || String(row.date || '') < since7) continue;
      const key = String(row.campaign_id);
      const agg = metricsByCampaign.get(key) || { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0 };
      agg.spend += n(row.spend);
      agg.sales += n(row.sales);
      agg.orders += n(row.orders);
      agg.clicks += n(row.clicks);
      agg.impressions += n(row.impressions);
      metricsByCampaign.set(key, agg);
    }

    const spendWithoutConversion: any[] = [];
    const activeWithoutSpend: any[] = [];
    for (const campaign of active) {
      const id = String(campaign.campaign_id || campaign.amazon_campaign_id || '');
      const m = metricsByCampaign.get(id) || { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0 };
      if (m.spend >= 5 && m.orders === 0) {
        spendWithoutConversion.push({
          campaign_id: id,
          name: campaign.name || campaign.campaign_name,
          targeting_type: campaign.targeting_type,
          spend_7d: Number(m.spend.toFixed(2)),
          clicks_7d: m.clicks,
          recommended_path: m.clicks >= 20 || m.spend >= 15 ? 'pause_or_reduce_after_engine_guardrails' : 'reduce_bid_and_recheck',
        });
      } else if (m.spend === 0) {
        activeWithoutSpend.push({
          campaign_id: id,
          name: campaign.name || campaign.campaign_name,
          targeting_type: campaign.targeting_type,
          impressions_7d: m.impressions,
          recommended_path: m.impressions === 0 ? 'structure_listing_bid_diagnosis' : 'term_relevance_and_bid_review',
        });
      }
    }

    const automaticCampaignIds = new Set(
      active
        .filter((campaign: any) => String(campaign.targeting_type || '').toUpperCase() === 'AUTO')
        .map((campaign: any) => String(campaign.campaign_id || campaign.amazon_campaign_id || ''))
    );
    const convertingAutoTerms = searchTerms.filter((term: any) =>
      automaticCampaignIds.has(String(term.campaign_id || '')) &&
      Math.max(n(term.orders_30d), n(term.orders_14d), n(term.orders)) > 0 &&
      !/^B0[A-Z0-9]{8}$/i.test(String(term.search_term || '').trim())
    );

    const invoke = async (name: string, payload: any = {}) => {
      try {
        const response = await base44.asServiceRole.functions.invoke(name, {
          amazon_account_id: aid,
          _service_role: true,
          ...payload,
        });
        const data = response?.data || response || {};
        return { name, ok: data?.ok !== false, data };
      } catch (error: any) {
        return { name, ok: false, error: error?.message || String(error) };
      }
    };

    const stages: any[] = [];
    stages.push(await invoke('runDeterministicDecisionEngine', { force: true, dry_run: dryRun }));
    stages.push(await invoke('runManualZeroDeliveryBootstrap', { dry_run: dryRun }));
    stages.push(await invoke('runAutoCampaignLearning', { dry_run: dryRun }));

    if (fullExpansion) {
      stages.push(await invoke('updateTermBankFromAutomaticCampaigns'));
      stages.push(await invoke('runCampaignFactory', { dry_run: dryRun }));
      stages.push(await invoke('promoteWinningSearchTerms', { dry_run: dryRun }));
      if (!dryRun) {
        stages.push(await invoke('expandCoverageForAsin', {
          max_campaigns: 1,
          trigger_type: 'weekly_portfolio_growth',
        }));
      }
    }

    const summary = {
      active_campaigns: active.length,
      active_without_spend: activeWithoutSpend.length,
      spend_without_conversion: spendWithoutConversion.length,
      automatic_campaigns_monitored: automaticCampaignIds.size,
      converting_auto_terms: convertingAutoTerms.length,
      converting_auto_asins: new Set(convertingAutoTerms.map((term: any) => term.advertised_asin).filter(Boolean)).size,
      full_expansion: fullExpansion,
      stages_ok: stages.filter(stage => stage.ok).length,
      stages_failed: stages.filter(stage => !stage.ok).length,
    };

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'campaign_portfolio_growth_cycle',
      trigger_type: fullExpansion ? 'weekly_automatic' : 'daily_automatic',
      status: summary.stages_failed ? 'warning' : 'success',
      execution_date: today,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      records_processed: active.length,
      result_summary: JSON.stringify(summary),
    }).catch(() => {});

    return Response.json({
      ok: true,
      dry_run: dryRun,
      summary,
      spend_without_conversion: spendWithoutConversion.slice(0, 100),
      active_without_spend: activeWithoutSpend.slice(0, 300),
      converting_auto_terms_sample: convertingAutoTerms.slice(0, 50).map((term: any) => ({
        asin: term.advertised_asin,
        term: term.search_term,
        orders: Math.max(n(term.orders_30d), n(term.orders_14d), n(term.orders)),
        spend: n(term.spend),
        sales: Math.max(n(term.sales_30d), n(term.sales_14d), n(term.sales)),
      })),
      stages: stages.map(stage => ({
        name: stage.name,
        ok: stage.ok,
        error: stage.error || stage.data?.error,
        summary: stage.data?.summary || null,
      })),
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
});
