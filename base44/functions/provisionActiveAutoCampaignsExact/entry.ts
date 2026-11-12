import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const CAMPAIGN_CT = 'application/vnd.spCampaign.v3+json';
const AD_GROUP_CT = 'application/vnd.spAdGroup.v3+json';
const PRODUCT_AD_CT = 'application/vnd.spProductAd.v3+json';
const EXPECTED_AMAZON_STRATEGY = 'LEGACY_FOR_SALES';

const unwrap = (value: any) => value?.data || value || {};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function listOf(response: any, key: string): any[] {
  const data = unwrap(response);
  const payload = data?.payload || data;
  const value = payload?.[key];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.success)) return value.success;
  if (Array.isArray(payload?.success)) return payload.success;
  return [];
}

function campaignIdOf(row: any): string {
  return String(row?.campaignId || row?.campaign_id || row?.amazon_campaign_id || '');
}

function adGroupIdOf(row: any): string {
  return String(row?.adGroupId || row?.ad_group_id || '');
}

function defaultBidOf(row: any): number {
  return Number(row?.defaultBid?.amount ?? row?.defaultBid ?? row?.default_bid ?? 0);
}

function upper(value: unknown): string {
  return String(value || '').trim().toUpperCase();
}

async function invoke(base44: any, name: string, payload: any): Promise<any> {
  const response = await base44.asServiceRole.functions.invoke(name, payload);
  return unwrap(response);
}

async function adsCommand(base44: any, accountId: string, input: any): Promise<any> {
  return await invoke(base44, 'amazonAdsCommand', {
    amazon_account_id: accountId,
    _service_role: true,
    max_attempts: 3,
    ...input,
  });
}

async function listWithRetry(
  base44: any,
  accountId: string,
  path: string,
  key: string,
  contentType: string,
  payload: any,
  minimumRows: number,
): Promise<{ response: any; rows: any[] }> {
  let response: any = null;
  let rows: any[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    response = await adsCommand(base44, accountId, {
      operation: 'provision_active_auto_verify_' + key,
      method: 'POST',
      path,
      content_type: contentType,
      accept: contentType,
      payload,
    }).catch((error: any) => ({ ok: false, error: error?.message || String(error) }));
    rows = listOf(response, key);
    if (response?.ok === true && rows.length >= minimumRows) break;
    if (attempt < 4) await wait(1000 * (attempt + 1));
  }
  return { response, rows };
}

Deno.serve(async (req) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    if (body._service_role !== true) {
      const user = await base44.auth.me().catch(() => null);
      if (!user || user.role !== 'admin') {
        return Response.json({ ok: false, error: 'Admin only' }, { status: 403 });
      }
    }

    const bid = Math.round(Number(body.initial_bid ?? 1) * 100) / 100;
    if (!Number.isFinite(bid) || bid < 0.02 || bid > 1000) {
      return Response.json({ ok: false, error: 'initial_bid inválido' }, { status: 400 });
    }
    const strategyMode = String(body.strategy_mode || 'down_only').toLowerCase();
    if (strategyMode !== 'down_only') {
      return Response.json({ ok: false, error: 'Esta operação aceita apenas estratégia down_only.' }, { status: 400 });
    }

    const dryRun = body.dry_run === true;
    const accountRows = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, undefined, 1)
      : await base44.asServiceRole.entities.AmazonAccount.list('-created_date', 50);
    const accounts = accountRows.filter((account: any) =>
      account.ads_profile_id && (account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN'))
    );
    if (!accounts.length) {
      return Response.json({ ok: false, error: 'Nenhuma conta Amazon Ads conectada' }, { status: 409 });
    }

    const accountResults: any[] = [];

    for (const account of accounts) {
      const accountId = String(account.id);
      const stages: any[] = [];
      const runStage = async (stage: string, fn: string, payload: any, critical = false) => {
        try {
          const result = await invoke(base44, fn, {
            _service_role: true,
            amazon_account_id: accountId,
            ...payload,
          });
          const failed = result?.ok === false;
          stages.push({ stage, ok: !failed, critical, error: failed ? (result.error || result.message || 'Falha sem detalhe') : null });
          return result;
        } catch (error: any) {
          stages.push({ stage, ok: false, critical, error: String(error?.message || error).slice(0, 500) });
          return { ok: false, error: error?.message || String(error) };
        }
      };

      if (!dryRun && body.sync_first !== false) {
        await runStage('refresh_ads_token', 'refreshAmazonAdsTokenDailyOrHourly', {
          force: true,
          precheck_operation: 'provision_active_auto_campaigns',
          trigger_type: 'user_requested_active_auto_campaigns',
        }, true);
        await runStage('catalog_sync', 'syncProductCatalogV2', {}, true);
        await runStage('offer_sync', 'syncAmazonOfferAvailability', {
          max_products: Math.min(200, Math.max(1, Number(body.max_products || 200))),
        });
        await runStage('stock_guard', 'autoStockCampaignGuard', { low_stock_pause_threshold: 0 });
        await runStage('campaign_state_sync', 'syncAdsCampaignStatesV2', {}, true);
        await runStage('ad_group_sync', 'syncAdGroupsAndKeywords', {});
        await runStage('auto_deduplication', 'deduplicateAutoCampaignsByAsin', { dry_run: false }, true);
      }

      const criticalFailures = stages.filter((stage) => stage.critical && stage.ok === false);
      if (criticalFailures.length) {
        accountResults.push({
          amazon_account_id: accountId,
          ok: false,
          active_products: 0,
          processed: 0,
          verified: 0,
          errors: criticalFailures.length,
          stage_results: stages,
          proof: [],
        });
        continue;
      }

      const coverage = await invoke(base44, 'ensureActiveProductCampaignCoverage', {
        _service_role: true,
        amazon_account_id: accountId,
        dry_run: dryRun,
        fast_mode: true,
        max_products: Math.min(500, Math.max(1, Number(body.max_products || 200))),
        run_harvest: false,
        initial_bid: bid,
        strategy_mode: strategyMode,
        force_reactivate: false,
        require_actions: true,
      }).catch((error: any) => ({ ok: false, error: error?.message || String(error) }));

      const accountCoverage = (coverage?.accounts || []).find((row: any) =>
        String(row.amazon_account_id) === accountId
      ) || coverage?.accounts?.[0] || null;
      const rows = Array.isArray(accountCoverage?.rows) ? accountCoverage.rows : [];

      if (dryRun) {
        accountResults.push({
          amazon_account_id: accountId,
          ok: coverage?.ok !== false,
          dry_run: true,
          active_products: Number(accountCoverage?.active_products || rows.length),
          processed: rows.length,
          verified: 0,
          errors: Number(accountCoverage?.failed || 0),
          stage_results: stages,
          planned_actions: rows,
          proof: [],
        });
        continue;
      }

      const missingRows = rows.filter((row: any) => row?.ok === false || !row?.campaign_id);
      const configuredRows = rows.filter((row: any) => row?.ok !== false && row?.campaign_id);
      const campaignIds = [...new Set(configuredRows.map((row: any) => String(row.campaign_id)).filter(Boolean))];

      if (coverage?.ok === false || !accountCoverage || campaignIds.length === 0) {
        accountResults.push({
          amazon_account_id: accountId,
          ok: false,
          active_products: Number(accountCoverage?.active_products || 0),
          processed: rows.length,
          verified: 0,
          errors: Math.max(1, missingRows.length + Number(accountCoverage?.failed || 0)),
          coverage_error: coverage?.error || 'Nenhuma campanha elegível foi confirmada.',
          stage_results: stages,
          coverage_rows: rows,
          proof: [],
        });
        continue;
      }

      const campaignFilter = { include: campaignIds };
      const groupRead = await listWithRetry(
        base44,
        accountId,
        '/sp/adGroups/list',
        'adGroups',
        AD_GROUP_CT,
        {
          campaignIdFilter: campaignFilter,
          stateFilter: { include: ['ENABLED', 'PAUSED'] },
          maxResults: 100,
        },
        campaignIds.length,
      );
      const adGroups = groupRead.rows.filter((group: any) =>
        campaignIds.includes(campaignIdOf(group)) && upper(group.state) !== 'ARCHIVED'
      );
      const groupIds = [...new Set(adGroups.map(adGroupIdOf).filter(Boolean))];
      const campaignsWithoutGroup = campaignIds.filter((campaignId) =>
        !adGroups.some((group: any) => campaignIdOf(group) === campaignId)
      );

      let bidUpdate: any = { ok: false, error: 'Nenhum Ad Group remoto encontrado.' };
      if (groupIds.length) {
        bidUpdate = await adsCommand(base44, accountId, {
          operation: 'user_requested_set_active_auto_bid_1_brl',
          method: 'PUT',
          path: '/sp/adGroups',
          content_type: AD_GROUP_CT,
          accept: AD_GROUP_CT,
          payload: {
            adGroups: adGroups.map((group: any) => ({
              adGroupId: adGroupIdOf(group),
              state: 'ENABLED',
              defaultBid: bid,
            })),
          },
        }).catch((error: any) => ({ ok: false, error: error?.message || String(error) }));
      }

      const strategyUpdate = await adsCommand(base44, accountId, {
        operation: 'user_requested_active_auto_down_only',
        method: 'PUT',
        path: '/sp/campaigns',
        content_type: CAMPAIGN_CT,
        accept: CAMPAIGN_CT,
        payload: {
          campaigns: campaignIds.map((campaignId) => ({
            campaignId,
            dynamicBidding: { strategy: EXPECTED_AMAZON_STRATEGY },
          })),
        },
      }).catch((error: any) => ({ ok: false, error: error?.message || String(error) }));

      const enableUpdate = bidUpdate?.ok === true && strategyUpdate?.ok === true
        ? await adsCommand(base44, accountId, {
            operation: 'user_requested_enable_configured_active_auto_campaigns',
            method: 'PUT',
            path: '/sp/campaigns',
            content_type: CAMPAIGN_CT,
            accept: CAMPAIGN_CT,
            payload: {
              campaigns: campaignIds.map((campaignId) => ({ campaignId, state: 'ENABLED' })),
            },
          }).catch((error: any) => ({ ok: false, error: error?.message || String(error) }))
        : { ok: false, skipped: true, error: 'Ativação não executada porque lance ou estratégia não foi confirmado.' };

      await invoke(base44, 'syncAdsCampaignStatesV2', {
        _service_role: true,
        amazon_account_id: accountId,
      }).catch(() => null);
      await invoke(base44, 'syncAdGroupsAndKeywords', {
        _service_role: true,
        amazon_account_id: accountId,
      }).catch(() => null);

      const [campaignVerification, groupVerification, adVerification] = await Promise.all([
        listWithRetry(
          base44, accountId, '/sp/campaigns/list', 'campaigns', CAMPAIGN_CT,
          {
            campaignIdFilter: campaignFilter,
            stateFilter: { include: ['ENABLED', 'PAUSED'] },
            maxResults: 100,
          },
          campaignIds.length,
        ),
        listWithRetry(
          base44, accountId, '/sp/adGroups/list', 'adGroups', AD_GROUP_CT,
          {
            campaignIdFilter: campaignFilter,
            stateFilter: { include: ['ENABLED', 'PAUSED'] },
            maxResults: 100,
          },
          campaignIds.length,
        ),
        listWithRetry(
          base44, accountId, '/sp/productAds/list', 'productAds', PRODUCT_AD_CT,
          {
            campaignIdFilter: campaignFilter,
            stateFilter: { include: ['ENABLED', 'PAUSED'] },
            maxResults: 100,
          },
          campaignIds.length,
        ),
      ]);

      const remoteCampaigns = campaignVerification.rows;
      const remoteGroups = groupVerification.rows;
      const remoteAds = adVerification.rows;
      const proof = configuredRows.map((row: any) => {
        const campaignId = String(row.campaign_id);
        const campaign = remoteCampaigns.find((item: any) => campaignIdOf(item) === campaignId);
        const groups = remoteGroups.filter((item: any) => campaignIdOf(item) === campaignId && upper(item.state) !== 'ARCHIVED');
        const productAds = remoteAds.filter((item: any) => campaignIdOf(item) === campaignId && upper(item.state) !== 'ARCHIVED');
        const campaignState = upper(campaign?.state);
        const targetingType = upper(campaign?.targetingType || campaign?.targeting_type);
        const amazonStrategy = upper(campaign?.dynamicBidding?.strategy || campaign?.bidding?.strategy);
        const bids = groups.map(defaultBidOf);
        const allBidsMatch = bids.length > 0 && bids.every((value) => Math.abs(value - bid) < 0.001);
        const adGroupsEnabled = groups.length > 0 && groups.every((item: any) => upper(item.state) === 'ENABLED');
        const productAdsEnabled = productAds.length > 0 && productAds.some((item: any) => upper(item.state) === 'ENABLED');
        const verified = campaignState === 'ENABLED'
          && targetingType === 'AUTO'
          && amazonStrategy === EXPECTED_AMAZON_STRATEGY
          && allBidsMatch
          && adGroupsEnabled
          && productAdsEnabled;
        return {
          asin: row.asin,
          sku: row.sku,
          campaign_id: campaignId,
          campaign_name: campaign?.name || row.campaign_name || null,
          source_action: row.action,
          campaign_state: campaignState || null,
          targeting_type: targetingType || null,
          amazon_bidding_strategy: amazonStrategy || null,
          bidding_mode: amazonStrategy === EXPECTED_AMAZON_STRATEGY ? 'dynamic_down_only' : 'unverified',
          ad_group_ids: groups.map(adGroupIdOf),
          default_bids: bids,
          product_ad_ids: productAds.map((item: any) => String(item.adId || item.ad_id || '')).filter(Boolean),
          verified,
        };
      });

      const verified = proof.filter((row: any) => row.verified).length;
      const operationErrors = [
        ...missingRows.map((row: any) => ({ asin: row.asin, sku: row.sku, error: row.error || 'campaign_id ausente' })),
        ...campaignsWithoutGroup.map((campaignId) => ({ campaign_id: campaignId, error: 'Ad Group remoto ausente' })),
        ...(bidUpdate?.ok === true ? [] : [{ stage: 'bid_update', error: bidUpdate?.error || bidUpdate?.errors?.[0]?.message || 'Falha no lance' }]),
        ...(strategyUpdate?.ok === true ? [] : [{ stage: 'strategy_update', error: strategyUpdate?.error || strategyUpdate?.errors?.[0]?.message || 'Falha na estratégia' }]),
        ...(enableUpdate?.ok === true ? [] : [{ stage: 'enable_campaigns', error: enableUpdate?.error || enableUpdate?.errors?.[0]?.message || 'Falha na ativação' }]),
        ...proof.filter((row: any) => !row.verified).map((row: any) => ({ campaign_id: row.campaign_id, asin: row.asin, error: 'Verificação remota incompleta' })),
      ];

      accountResults.push({
        amazon_account_id: accountId,
        ok: operationErrors.length === 0 && verified === configuredRows.length,
        active_products: Number(accountCoverage?.active_products || configuredRows.length),
        processed: configuredRows.length,
        created: Number(accountCoverage?.created || 0),
        reactivated: configuredRows.filter((row: any) => row.action === 'existing_paused_preserved').length,
        already_enabled: configuredRows.filter((row: any) => row.action === 'existing_enabled').length,
        verified,
        errors: operationErrors.length,
        operation_errors: operationErrors,
        stage_results: stages,
        proof,
      });
    }

    const activeProducts = accountResults.reduce((sum, row) => sum + Number(row.active_products || 0), 0);
    const processed = accountResults.reduce((sum, row) => sum + Number(row.processed || 0), 0);
    const verified = accountResults.reduce((sum, row) => sum + Number(row.verified || 0), 0);
    const errors = accountResults.reduce((sum, row) => sum + Number(row.errors || 0), 0);
    const ok = errors === 0 && processed > 0 && verified === processed && activeProducts === processed;

    return Response.json({
      ok,
      verification_complete: ok,
      dry_run: dryRun,
      requested_initial_bid: bid,
      requested_strategy: strategyMode,
      amazon_strategy: EXPECTED_AMAZON_STRATEGY,
      active_products: activeProducts,
      processed,
      verified,
      errors,
      accounts: accountResults,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      ...(processed === 0 ? { error: 'Nenhum produto ativo e elegível foi processado.' } : {}),
    }, { status: ok ? 200 : processed === 0 ? 409 : 207 });
  } catch (error: any) {
    return Response.json({
      ok: false,
      verification_complete: false,
      error: error?.message || String(error),
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    }, { status: 500 });
  }
});
