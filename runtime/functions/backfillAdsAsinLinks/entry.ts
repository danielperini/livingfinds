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

async function loadKeywordLinks(entity: any, amazonAccountId: string, keywordIds: string[]): Promise<any[]> {
  const rows: any[] = [];
  for (let i = 0; i < keywordIds.length; i += 100) {
    const ids = keywordIds.slice(i, i + 100);
    const page = await entity.filter(
      { amazon_account_id: amazonAccountId, keyword_id: { $in: ids } },
      '-updated_date',
      Math.max(500, ids.length * 5),
    ).catch(() => []);
    if (Array.isArray(page)) rows.push(...page);
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

    const amazonAccountId = String(body.amazon_account_id || '').trim();
    if (!amazonAccountId) return Response.json({ ok: false, error: 'amazon_account_id required' }, { status: 400 });

    const dryRun = body.dry_run !== false;
    const scope = body.scope === 'keywords' ? 'keywords' : 'logs';
    const skip = Math.max(Number(body.skip) || 0, 0);
    const limitCap = scope === 'logs' ? 1000 : 5000;
    const limit = Math.min(Math.max(Number(body.limit) || (scope === 'logs' ? 300 : 2000), 1), limitCap);
    const filter = { amazon_account_id: amazonAccountId };
    const [campaigns, productAds] = await Promise.all([
      loadAll(base44.asServiceRole.entities.Campaign, filter, '-updated_date', 10000),
      loadAll(base44.asServiceRole.entities.ProductAd, filter, '-updated_date', 20000),
    ]);

    if (scope === 'keywords') {
      const keywords = await base44.asServiceRole.entities.Keyword.filter(filter, '-updated_date', limit, skip).catch(() => []);
      const campaignAsinById = buildCampaignAsinIndex(campaigns, productAds);
      const updates: any[] = [];
      for (const keyword of keywords) {
        if (normalizeAsin(keyword.asin)) continue;
        const asin = campaignAsinById.get(String(keyword.campaign_id || keyword.amazon_campaign_id || '').trim()) || '';
        if (asin) updates.push({ id: keyword.id, asin });
      }
      const updated = await bulkUpdate(base44.asServiceRole.entities.Keyword, updates, dryRun);
      return Response.json({
        ok: true,
        dry_run: dryRun,
        scope,
        page: { skip, limit, scanned: keywords.length, has_more: keywords.length === limit },
        recoverable: updates.length,
        updated,
        duration_ms: Date.now() - startedAt,
      });
    }

    const logs = await base44.asServiceRole.entities.AdsBidChangeLog.filter(filter, '-created_at', limit, skip).catch(() => []);
    const keywordIds = [...new Set(
      logs
        .filter((log: any) => !normalizeAsin(log.asin))
        .map((log: any) => String(log.keyword_id || (log.entity_type === 'keyword' ? log.entity_id : '')).trim())
        .filter(Boolean),
    )];
    const keywords = await loadKeywordLinks(base44.asServiceRole.entities.Keyword, amazonAccountId, keywordIds);
    const campaignAsinById = buildCampaignAsinIndex(campaigns, productAds, keywords);
    const keywordAsinById = buildKeywordAsinIndex(keywords);
    const updates: any[] = [];
    const unresolved: any[] = [];
    for (const log of logs) {
      if (normalizeAsin(log.asin)) continue;
      const asin = resolveAdsAsin(log, keywordAsinById, campaignAsinById);
      if (asin) {
        updates.push({ id: log.id, asin });
      } else if (unresolved.length < 25) {
        unresolved.push({
          id: log.id,
          created_at: log.created_at || log.created_date || '',
          keyword_id: log.keyword_id || '',
          keyword: log.keyword || log.keyword_text || '',
          campaign_id: log.campaign_id || '',
        });
      }
    }
    const updated = await bulkUpdate(base44.asServiceRole.entities.AdsBidChangeLog, updates, dryRun);
    return Response.json({
      ok: true,
      dry_run: dryRun,
      scope,
      page: { skip, limit, scanned: logs.length, has_more: logs.length === limit },
      supporting_keywords: keywords.length,
      recoverable: updates.length,
      updated,
      unresolved,
      duration_ms: Date.now() - startedAt,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error), duration_ms: Date.now() - startedAt }, { status: 500 });
  }
});
