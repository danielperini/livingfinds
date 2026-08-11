import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import {
  buildCampaignAsinIndex,
  buildKeywordAsinIndex,
  normalizeAsin,
  resolveAdsAsin,
} from '../../shared/adsAsinResolution.ts';

async function loadAll(
  entity: any,
  filter: Record<string, unknown>,
  sort: string,
  maxRows: number,
): Promise<any[]> {
  const rows: any[] = [];
  const pageSize = 1000;
  for (let skip = 0; skip < maxRows; skip += pageSize) {
    const page = await entity.filter(filter, sort, Math.min(pageSize, maxRows - skip), skip).catch(() => []);
    if (!Array.isArray(page) || page.length === 0) break;
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

async function bulkUpdate(entity: any, rows: any[], dryRun: boolean): Promise<number> {
  if (dryRun || rows.length === 0) return 0;
  let updated = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    await entity.bulkUpdate(batch);
    updated += batch.length;
  }
  return updated;
}

Deno.serve(async (req) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const dryRun = body.dry_run !== false;
    const maxKeywords = Math.min(Math.max(Number(body.max_keywords) || 60000, 1), 100000);
    const maxLogs = Math.min(Math.max(Number(body.max_logs) || 20000, 1), 50000);
    const accountIds = body.amazon_account_id
      ? [String(body.amazon_account_id)]
      : (await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 100))
        .map((row: any) => String(row.id));

    const accounts: any[] = [];
    for (const amazonAccountId of accountIds) {
      const filter = { amazon_account_id: amazonAccountId };
      const [campaigns, productAds, keywords, logs] = await Promise.all([
        loadAll(base44.asServiceRole.entities.Campaign, filter, '-updated_date', 10000),
        loadAll(base44.asServiceRole.entities.ProductAd, filter, '-updated_date', 20000),
        loadAll(base44.asServiceRole.entities.Keyword, filter, '-updated_date', maxKeywords),
        loadAll(base44.asServiceRole.entities.AdsBidChangeLog, filter, '-created_at', maxLogs),
      ]);

      const campaignAsinById = buildCampaignAsinIndex(campaigns, productAds, keywords);
      const keywordUpdates: any[] = [];
      for (const keyword of keywords) {
        if (normalizeAsin(keyword.asin)) continue;
        const asin = campaignAsinById.get(String(keyword.campaign_id || keyword.amazon_campaign_id || '').trim()) || '';
        if (asin) keywordUpdates.push({ id: keyword.id, asin });
      }

      const keywordsWithBackfill = keywords.map((keyword) => {
        if (normalizeAsin(keyword.asin)) return keyword;
        const asin = campaignAsinById.get(String(keyword.campaign_id || keyword.amazon_campaign_id || '').trim()) || '';
        return asin ? { ...keyword, asin } : keyword;
      });
      const keywordAsinById = buildKeywordAsinIndex(keywordsWithBackfill);
      const logUpdates: any[] = [];
      const unresolvedRecent: any[] = [];
      for (const log of logs) {
        if (normalizeAsin(log.asin)) continue;
        const asin = resolveAdsAsin(log, keywordAsinById, campaignAsinById);
        if (asin) {
          logUpdates.push({ id: log.id, asin });
        } else if (unresolvedRecent.length < 25) {
          unresolvedRecent.push({
            id: log.id,
            created_at: log.created_at || log.created_date || '',
            keyword_id: log.keyword_id || '',
            keyword: log.keyword || log.keyword_text || '',
            campaign_id: log.campaign_id || '',
          });
        }
      }

      const keywordRowsUpdated = await bulkUpdate(base44.asServiceRole.entities.Keyword, keywordUpdates, dryRun);
      const logRowsUpdated = await bulkUpdate(base44.asServiceRole.entities.AdsBidChangeLog, logUpdates, dryRun);
      accounts.push({
        amazon_account_id: amazonAccountId,
        scanned: { campaigns: campaigns.length, product_ads: productAds.length, keywords: keywords.length, logs: logs.length },
        recoverable: { keywords: keywordUpdates.length, logs: logUpdates.length },
        updated: { keywords: keywordRowsUpdated, logs: logRowsUpdated },
        unresolved_recent: unresolvedRecent,
      });
    }

    return Response.json({ ok: true, dry_run: dryRun, accounts, duration_ms: Date.now() - startedAt });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error), duration_ms: Date.now() - startedAt }, { status: 500 });
  }
});
