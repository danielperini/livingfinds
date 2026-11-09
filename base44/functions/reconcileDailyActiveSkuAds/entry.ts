import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { AUTONOMOUS_ADS_RISK_POLICY } from '../../shared/dailyAiAdsPolicy.ts';

const ACCOUNT_ID = 'amazon_account_id';
const MAX_PRODUCTS = 2500;
const MAX_CAMPAIGNS = 3000;

function value(row: any, key: string, fallback: unknown = undefined): unknown {
  return row?.[key] ?? row?.data?.[key] ?? fallback;
}

function text(row: any, key: string): string {
  return String(value(row, key, '') || '').trim();
}

function number(row: any, ...keys: string[]): number {
  for (const key of keys) {
    const parsed = Number(value(row, key, undefined));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function todayBrt(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function dateBrt(input: unknown): string {
  if (!input) return '';
  const date = new Date(String(input));
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function stateOf(row: any): string {
  return text(row, 'state') || text(row, 'status') || text(row, 'amazon_status');
}

function productKey(row: any): string {
  const asin = text(row, 'asin').toUpperCase();
  const sku = text(row, 'sku').toUpperCase();
  return `${asin}|${sku}`;
}

function campaignId(row: any): string {
  return text(row, 'amazon_campaign_id') || text(row, 'campaign_id');
}

function campaignAsin(row: any): string {
  return text(row, 'asin').toUpperCase();
}

function campaignSku(row: any): string {
  return text(row, 'sku').toUpperCase();
}

function isArchivedCampaign(row: any): boolean {
  return row?.archived === true || stateOf(row).toLowerCase() === 'archived';
}

function isEnabledCampaign(row: any): boolean {
  return ['enabled', 'active'].includes(stateOf(row).toLowerCase());
}

function isPausedOrIncomplete(row: any): boolean {
  return ['paused', 'incomplete'].includes(stateOf(row).toLowerCase());
}

function isAutoCampaign(row: any): boolean {
  const type = text(row, 'targeting_type').toUpperCase();
  const name = (text(row, 'name') || text(row, 'campaign_name')).toUpperCase();
  return type === 'AUTO' || (name.includes('AUTO') && !name.includes('MANUAL'));
}

function hasSalesEvidence(row: any): boolean {
  return number(
    row,
    'orders', 'purchases', 'orders_7d', 'orders_14d', 'orders_30d',
    'sales', 'sales_7d', 'sales_14d', 'sales_30d', 'lifetime_sales',
  ) > 0;
}

function isInactiveProduct(row: any): boolean {
  const status = text(row, 'status').toLowerCase();
  const lifecycle = text(row, 'lifecycle_status').toLowerCase();
  return ['inactive', 'archived', 'deleted', 'removed', 'not_found'].includes(status)
    || ['inactive', 'archived', 'deleted', 'removed', 'not_found'].includes(lifecycle)
    || value(row, 'offer_active', undefined) === false
    || value(row, 'listing_buyable', undefined) === false
    || value(row, 'listing_suppressed', undefined) === true;
}

function hasStock(row: any): boolean {
  return number(row, 'fba_inventory', 'available_quantity', 'total_quantity', 'fba_quantity') > 0;
}

function productIsActiveAndSellable(row: any): boolean {
  const status = text(row, 'status').toLowerCase();
  return !isInactiveProduct(row)
    && !['draft', 'deleted', 'removed'].includes(status)
    && hasStock(row);
}

function campaignMatchesInactiveProduct(campaign: any, inactiveKeys: Set<string>, inactiveAsinsWithoutActiveSku: Set<string>): boolean {
  const asin = campaignAsin(campaign);
  const sku = campaignSku(campaign);
  if (sku && inactiveKeys.has(`${asin}|${sku}`)) return true;
  return !sku && inactiveAsinsWithoutActiveSku.has(asin);
}

function adsBase(region: unknown): string {
  const normalized = String(region || 'NA').toUpperCase();
  if (normalized.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (normalized.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function getToken(base44: any, accountId: string): Promise<string> {
  const result = await base44.asServiceRole.functions.invoke('amazonAdsTokenManager', {
    [ACCOUNT_ID]: accountId,
    _service_role: true,
  });
  const data = result?.data || result || {};
  if (!data.ok || !data.access_token) throw new Error(data.message || data.error || 'TOKEN_UNAVAILABLE');
  return String(data.access_token);
}

async function updateRemoteCampaignState(
  token: string,
  account: any,
  id: string,
  state: 'ENABLED' | 'PAUSED',
): Promise<{ ok: boolean; status: number; detail?: string }> {
  const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';
  const response = await fetch(`${adsBase(account.region)}/sp/campaigns`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': 'application/vnd.spCampaign.v3+json',
      Accept: 'application/vnd.spCampaign.v3+json',
    },
    body: JSON.stringify({ campaigns: [{ campaignId: String(id), state }] }),
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await response.text().catch(() => '');
  if (!response.ok) return { ok: false, status: response.status, detail: raw.slice(0, 300) };
  if (response.status !== 207) return { ok: true, status: response.status };
  let parsed: any = {};
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* 207 may be empty */ }
  const items = Array.isArray(parsed?.campaigns) ? parsed.campaigns : Array.isArray(parsed) ? parsed : [];
  const item = items.find((candidate: any) => String(candidate?.campaignId || id) === String(id)) || items[0];
  if (item?.code && String(item.code).toUpperCase() !== 'SUCCESS') {
    return { ok: false, status: response.status, detail: item.description || item.code };
  }
  return { ok: true, status: response.status };
}

async function countCreatedToday(base44: any, accountId: string, day: string, campaigns: any[]): Promise<number> {
  const local = campaigns.filter((row) =>
    dateBrt(value(row, 'created_at', value(row, 'created_date'))) === day
    && !isArchivedCampaign(row)
    && (row.created_by_app === true || row.created_by_app === 'true'),
  ).length;
  const logs = await base44.asServiceRole.entities.SyncExecutionLog.filter({
    [ACCOUNT_ID]: accountId,
    operation: 'daily_active_sku_ads_lifecycle',
    execution_date: day,
    status: 'success',
  }, '-started_at', 10).catch(() => []);
  return local + logs.reduce((sum: number, row: any) => {
    try { return sum + Number(JSON.parse(row.result_summary || '{}').created_auto_campaigns || 0); } catch { return sum; }
  }, 0);
}

function unwrap(valueToUnwrap: any): any {
  return valueToUnwrap?.data || valueToUnwrap || {};
}

Deno.serve(async (request) => {
  const startedAt = new Date().toISOString();
  const day = todayBrt();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role && !(await base44.auth.isAuthenticated().catch(() => false))) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: String(body.amazon_account_id) }, '-updated_at', 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 20);
    const reports: any[] = [];

    for (const account of accounts) {
      const accountId = String(account.id);
      const [products, campaigns] = await Promise.all([
        base44.asServiceRole.entities.Product.filter({ [ACCOUNT_ID]: accountId }, '-updated_at', MAX_PRODUCTS).catch(() => []),
        base44.asServiceRole.entities.Campaign.filter({ [ACCOUNT_ID]: accountId }, '-updated_at', MAX_CAMPAIGNS).catch(() => []),
      ]);
      const byKey = new Map<string, any>();
      const byAsin = new Map<string, any[]>();
      for (const product of products) {
        const key = productKey(product);
        if (key !== '|') byKey.set(key, product);
        const asin = text(product, 'asin').toUpperCase();
        if (asin) byAsin.set(asin, [...(byAsin.get(asin) || []), product]);
      }
      const activeProducts = products.filter(productIsActiveAndSellable);
      const activeKeys = new Set(activeProducts.map(productKey));
      const activeAsins = new Set(activeProducts.map((row: any) => text(row, 'asin').toUpperCase()).filter(Boolean));
      const inactiveKeys = new Set(products
        .filter(isInactiveProduct)
        .map(productKey)
        .filter((key: string) => key !== '|'));
      // Do not let one inactive variation pause a different active SKU of the same ASIN.
      const inactiveAsinsWithoutActiveSku = new Set(products
        .filter(isInactiveProduct)
        .map((row: any) => text(row, 'asin').toUpperCase())
        .filter((asin: string) => asin && !activeAsins.has(asin)));
      const nonArchivedCampaigns = campaigns.filter((row: any) => !isArchivedCampaign(row) && campaignId(row));
      const inactiveCampaigns = nonArchivedCampaigns.filter((row: any) => {
        const asin = campaignAsin(row);
        const sku = campaignSku(row);
        return campaignMatchesInactiveProduct(row, inactiveKeys, inactiveAsinsWithoutActiveSku)
          || (sku && !activeKeys.has(`${asin}|${sku}`) && isInactiveProduct(byKey.get(`${asin}|${sku}`)));
      }).filter(isEnabledCampaign);

      const report: any = {
        [ACCOUNT_ID]: accountId,
        active_skus: activeProducts.length,
        inactive_products: products.filter(isInactiveProduct).length,
        paused_inactive_campaigns: 0,
        reactivated_sold_campaigns: 0,
        created_auto_campaigns: 0,
        skipped_no_sales_evidence: 0,
        missing_auto_before: 0,
        missing_auto_after: 0,
        errors: [],
        paused: [],
        reactivated: [],
        created: [],
      };

      const dryRun = body.dry_run === true;
      let token: string | null = null;
      const ensureToken = async () => token || (token = await getToken(base44, accountId));
      const pauseInactive = body.pause_inactive !== false;
      if (pauseInactive && inactiveCampaigns.length && !dryRun) {
        for (const campaign of inactiveCampaigns) {
          try {
            const result = await updateRemoteCampaignState(await ensureToken(), account, campaignId(campaign), 'PAUSED');
            if (!result.ok) {
              report.errors.push({ campaign_id: campaignId(campaign), action: 'pause', error: result.detail || `HTTP_${result.status}` });
              continue;
            }
            await base44.asServiceRole.entities.Campaign.update(campaign.id, {
              status: 'paused', state: 'paused', reconciliation_status: 'ok',
              reconciliation_notes: 'inactive_product_campaign_paused',
              last_sync_at: new Date().toISOString(),
            }).catch(() => {});
            report.paused_inactive_campaigns += 1;
            report.paused.push({ campaign_id: campaignId(campaign), asin: campaignAsin(campaign), sku: campaignSku(campaign) });
          } catch (error: any) {
            report.errors.push({ campaign_id: campaignId(campaign), action: 'pause', error: String(error?.message || error).slice(0, 300) });
          }
        }
      } else if (dryRun) {
        report.paused_inactive_campaigns = inactiveCampaigns.length;
      }

      const currentCampaigns = nonArchivedCampaigns.filter((row: any) =>
        !campaignMatchesInactiveProduct(row, inactiveKeys, inactiveAsinsWithoutActiveSku));
      const activeProductRows = [...new Map(activeProducts.map((row: any) => [productKey(row), row])).values()];
      const activeCampaignsByKey = new Map<string, any[]>();
      for (const campaign of currentCampaigns) {
        const asin = campaignAsin(campaign);
        const sku = campaignSku(campaign);
        const key = activeKeys.has(`${asin}|${sku}`) ? `${asin}|${sku}` : `${asin}|`;
        activeCampaignsByKey.set(key, [...(activeCampaignsByKey.get(key) || []), campaign]);
      }

      let createdToday = await countCreatedToday(base44, accountId, day, campaigns);
      let remainingCreates = Math.max(0, AUTONOMOUS_ADS_RISK_POLICY.maxNewCampaignsPerDay - createdToday);
      const missingProducts: any[] = [];
      for (const product of activeProductRows) {
        const asin = text(product, 'asin').toUpperCase();
        const sku = text(product, 'sku').toUpperCase();
        const linked = (activeCampaignsByKey.get(`${asin}|${sku}`) || activeCampaignsByKey.get(`${asin}|`) || []);
        const autos = linked.filter(isAutoCampaign);
        if (!autos.length) missingProducts.push(product);

        if (!dryRun) {
          for (const campaign of linked.filter(isPausedOrIncomplete)) {
            try {
              const result = await updateRemoteCampaignState(await ensureToken(), account, campaignId(campaign), 'ENABLED');
              if (!result.ok) {
                report.errors.push({ campaign_id: campaignId(campaign), action: 'reactivate', error: result.detail || `HTTP_${result.status}` });
                continue;
              }
              await base44.asServiceRole.entities.Campaign.update(campaign.id, {
                status: 'enabled', state: 'enabled', reconciliation_status: 'ok',
                reconciliation_notes: 'reactivated_active_sku_with_stock',
                last_sync_at: new Date().toISOString(),
              }).catch(() => {});
              report.reactivated_sold_campaigns += 1;
              report.reactivated.push({ campaign_id: campaignId(campaign), asin, sku });
            } catch (error: any) {
              report.errors.push({ campaign_id: campaignId(campaign), action: 'reactivate', error: String(error?.message || error).slice(0, 300) });
            }
          }
        }
      }
      report.missing_auto_before = missingProducts.length;

      for (const product of missingProducts) {
        if (remainingCreates <= 0) break;
        if (dryRun) {
          report.created.push({ asin: text(product, 'asin').toUpperCase(), sku: text(product, 'sku').toUpperCase(), dry_run: true });
          remainingCreates -= 1;
          continue;
        }
        try {
          const created = unwrap(await base44.asServiceRole.functions.invoke('createAutoCampaignForAsin', {
            _service_role: true,
            [ACCOUNT_ID]: accountId,
            asin: text(product, 'asin').toUpperCase(),
            sku: text(product, 'sku'),
            product_name: text(product, 'product_name') || text(product, 'title') || text(product, 'name'),
            launch_at_minimum: true,
            trigger_type: 'daily_active_sku_ads_lifecycle',
          }));
          if (created.ok === false) {
            report.errors.push({ asin: text(product, 'asin').toUpperCase(), action: 'create_auto', error: created.error || 'create_auto_failed' });
            continue;
          }
          const existing = created.already_exists === true || String(created.action_label || '').startsWith('existing_') || created.reactivated === true;
          if (!existing) {
            report.created_auto_campaigns += 1;
            createdToday += 1;
            remainingCreates -= 1;
          }
          report.created.push({ asin: text(product, 'asin').toUpperCase(), sku: text(product, 'sku'), campaign_id: created.campaign_id || null, already_exists: existing });
        } catch (error: any) {
          report.errors.push({ asin: text(product, 'asin').toUpperCase(), action: 'create_auto', error: String(error?.message || error).slice(0, 300) });
        }
      }

      report.missing_auto_after = Math.max(0, report.missing_auto_before - report.created_auto_campaigns);
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        [ACCOUNT_ID]: accountId,
        operation: 'daily_active_sku_ads_lifecycle',
        trigger_type: body._service_role ? 'automatic' : 'manual',
        status: report.errors.length ? 'partial' : 'success',
        execution_date: day,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        records_processed: activeProductRows.length + inactiveCampaigns.length,
        error_message: report.errors.length ? JSON.stringify(report.errors).slice(0, 500) : null,
        result_summary: JSON.stringify({
          created_auto_campaigns: report.created_auto_campaigns,
          paused_inactive_campaigns: report.paused_inactive_campaigns,
          reactivated_sold_campaigns: report.reactivated_sold_campaigns,
          missing_auto_before: report.missing_auto_before,
          missing_auto_after: report.missing_auto_after,
          max_new_campaigns_per_day: AUTONOMOUS_ADS_RISK_POLICY.maxNewCampaignsPerDay,
          active_skus: report.active_skus,
        }).slice(0, 4000),
      }).catch(() => {});
      reports.push(report);
    }

    const failed = reports.reduce((sum, report) => sum + report.errors.length, 0);
    return Response.json({
      ok: failed === 0,
      operation: 'daily_active_sku_ads_lifecycle',
      date: day,
      policy: {
        max_new_campaigns_per_day: AUTONOMOUS_ADS_RISK_POLICY.maxNewCampaignsPerDay,
        inactive_product_campaign_pause: true,
        reactivation_requires_active_stock: true,
        historical_data_deleted: false,
      },
      reports,
    }, { status: failed === 0 ? 200 : 207 });
  } catch (error: any) {
    return Response.json({ ok: false, operation: 'daily_active_sku_ads_lifecycle', error: String(error?.message || error).slice(0, 500) }, { status: 500 });
  }
});
