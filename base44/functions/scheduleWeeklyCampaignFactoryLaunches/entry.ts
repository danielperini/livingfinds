import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const norm = (value: unknown) => String(value || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().trim().replace(/\s+/g, ' ');
const number = (value: unknown) => Number(value || 0);
const words = (value: unknown) => norm(value).split(' ').filter(Boolean);
const weekKey = (date = new Date()) => {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
};

const blockedGenericTerms = new Set([
  'lixeira', 'lixeiras', 'banheiro', 'cozinha', 'casa', 'escritorio',
  'interruptor', 'moedor', 'cafe', 'headset', 'fechadura', 'sensor',
  'automatico', 'automatica', 'inteligente', 'produto', 'oferta',
]);

function eligibility(row: any) {
  const keyword = row.keyword || row.normalized_keyword;
  const tokens = words(keyword);
  const score = Math.max(number(row.intent_score), number(row.promotion_score));
  if (!keyword || !row.asin) return { ok: false, reason: 'missing_keyword_or_asin', score, tokens };
  if (score < 72) return { ok: false, reason: 'score_below_72', score, tokens };
  if (row.in_negative_bank === true) return { ok: false, reason: 'negative_bank', score, tokens };
  if (['FAILED', 'RETIRED'].includes(String(row.lifecycle_status || '').toUpperCase())) {
    return { ok: false, reason: 'retired_or_failed', score, tokens };
  }
  // 72–85%: obrigatoriamente cauda longa. Acima de 85%: pelo menos
  // cauda média específica; head terms de uma ou duas palavras não entram.
  if (score <= 85 && tokens.length < 4) return { ok: false, reason: 'long_tail_required', score, tokens };
  if (score > 85 && tokens.length < 3) return { ok: false, reason: 'short_tail_blocked', score, tokens };
  if (tokens.length === 1 && blockedGenericTerms.has(tokens[0])) {
    return { ok: false, reason: 'generic_head_term', score, tokens };
  }
  return { ok: true, reason: score <= 85 ? 'long_tail_72_85' : 'high_relevance_specific', score, tokens };
}

Deno.serve(async (request) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1).catch(() => [])
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 10).catch(() => []);
    const cap = Math.max(1, Math.min(10, number(body.max_campaigns) || 10));
    const currentWeek = weekKey();
    const dryRun = body.dry_run === true;
    const reports: any[] = [];

    for (const account of accounts) {
      const aid = account.id;
      const previous = await base44.asServiceRole.entities.SyncExecutionLog.filter({
        amazon_account_id: aid,
        operation: 'weekly_campaign_factory_launches',
      }, '-created_date', 100).catch(() => []);
      const alreadyScheduled = previous.reduce((sum: number, row: any) => {
        try {
          const summary = JSON.parse(row.result_summary || '{}');
          return summary.week === currentWeek ? sum + number(summary.scheduled) : sum;
        } catch { return sum; }
      }, 0);
      const available = Math.max(0, cap - alreadyScheduled);
      if (available === 0) {
        reports.push({ amazon_account_id: aid, week: currentWeek, scheduled: 0, skipped: 'weekly_cap_reached' });
        continue;
      }

      const [bank, products, campaigns, queue] = await Promise.all([
        base44.asServiceRole.entities.KeywordBank.filter({ amazon_account_id: aid }, '-promotion_score', 5000).catch(() => []),
        base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, '-updated_at', 1000).catch(() => []),
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, '-updated_at', 5000).catch(() => []),
        base44.asServiceRole.entities.ProductKickoffQueue.filter({ amazon_account_id: aid }, '-created_date', 3000).catch(() => []),
      ]);

      const productByAsin = new Map(products.map((row: any) => [String(row.asin || '').toUpperCase(), row]));
      const used = new Set<string>();
      for (const campaign of campaigns) {
        const asin = String(campaign.asin || '').toUpperCase();
        const name = norm(campaign.name || campaign.campaign_name);
        const match = name.match(/sp \| manual \| exact \| [^|]+ \| (.+)$/);
        if (asin && match?.[1]) used.add(`${asin}|${norm(match[1])}`);
      }
      for (const item of queue) {
        if (!['cancelled', 'failed'].includes(String(item.status || '').toLowerCase())) {
          used.add(`${String(item.asin || '').toUpperCase()}|${norm(item.keyword)}`);
        }
      }

      const rejected: Record<string, number> = {};
      const candidates = bank.map((row: any) => ({ row, rule: eligibility(row) }))
        .filter(({ row, rule }: any) => {
          if (!rule.ok) {
            rejected[rule.reason] = (rejected[rule.reason] || 0) + 1;
            return false;
          }
          const asin = String(row.asin || '').toUpperCase();
          const product = productByAsin.get(asin);
          const stock = number(product?.fba_inventory ?? product?.available_quantity ?? product?.fulfillable_quantity);
          if (!product || product.inventory_status === 'out_of_stock' || stock <= 0) {
            rejected.out_of_stock = (rejected.out_of_stock || 0) + 1;
            return false;
          }
          if (product.ads_scope_status && product.ads_scope_status !== 'authorized') {
            rejected.not_authorized = (rejected.not_authorized || 0) + 1;
            return false;
          }
          if (product.ads_eligibility_status && product.ads_eligibility_status !== 'eligible') {
            rejected.not_eligible = (rejected.not_eligible || 0) + 1;
            return false;
          }
          if (used.has(`${asin}|${norm(row.keyword || row.normalized_keyword)}`)) {
            rejected.duplicate = (rejected.duplicate || 0) + 1;
            return false;
          }
          return true;
        })
        .sort((a: any, b: any) =>
          b.rule.score - a.rule.score
          || number(b.row.orders) - number(a.row.orders)
          || number(b.row.sales) - number(a.row.sales)
          || number(b.row.confidence_score) - number(a.row.confidence_score)
        );

      const selected = candidates.slice(0, available);
      if (dryRun) {
        reports.push({
          amazon_account_id: aid,
          week: currentWeek,
          dry_run: true,
          weekly_cap: cap,
          previously_scheduled: alreadyScheduled,
          eligible: candidates.length,
          scheduled: 0,
          rejected,
          preview: selected.map(({ row, rule }: any) => ({
            asin: row.asin,
            keyword: row.keyword || row.normalized_keyword,
            score: rule.score,
            words: rule.tokens.length,
          })),
        });
        continue;
      }
      const scheduled: any[] = [];
      for (const { row, rule } of selected) {
        const asin = String(row.asin).toUpperCase();
        const product: any = productByAsin.get(asin);
        const keyword = String(row.keyword || row.normalized_keyword).trim();
        const bid = Math.max(0.25, Math.min(
          1.50,
          number(row.estimated_initial_bid || row.sustainable_cpc || row.amazon_suggested_bid || 0.50),
        ));
        const queueItem = await base44.asServiceRole.entities.ProductKickoffQueue.create({
          amazon_account_id: aid,
          asin,
          sku: product?.sku || null,
          product_name: product?.product_name || product?.title || asin,
          mode: 'manual_only',
          keyword,
          bid_initial: Number(bid.toFixed(2)),
          source: 'campaign_factory_weekly',
          source_keyword_bank_id: row.id,
          source_score: Number(rule.score.toFixed(2)),
          selection_week: currentWeek,
          status: 'scheduled',
          queue_hour: 13,
          queue_window: '13:00-14:00',
          scheduled_at: new Date().toISOString(),
          attempt_count: 0,
          max_attempts: 5,
        });
        await base44.asServiceRole.entities.KeywordBank.update(row.id, {
          lifecycle_status: 'VALIDATING',
          harvest_candidate: true,
          harvest_action: 'CREATE_EXACT',
          harvest_reason: `Seleção semanal ${currentWeek}: ${rule.reason}; aderência ${rule.score.toFixed(1)}%; ${rule.tokens.length} palavras.`,
          harvest_proposed_at: new Date().toISOString(),
          last_decision: 'WEEKLY_MANUAL_EXACT_SCHEDULED',
          last_decision_at: new Date().toISOString(),
        }).catch(() => {});
        scheduled.push({ queue_id: queueItem?.id, asin, keyword, score: rule.score, words: rule.tokens.length, bid });
        used.add(`${asin}|${norm(keyword)}`);
      }

      const summary = {
        week: currentWeek,
        weekly_cap: cap,
        previously_scheduled: alreadyScheduled,
        eligible: candidates.length,
        scheduled: scheduled.length,
        rejected,
      };
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: aid,
        operation: 'weekly_campaign_factory_launches',
        trigger_type: body.trigger_type || 'weekly_automatic',
        status: 'success',
        execution_date: new Date().toISOString().slice(0, 10),
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        records_processed: bank.length,
        result_summary: JSON.stringify(summary),
      }).catch(() => {});
      reports.push({ amazon_account_id: aid, ...summary, selected: scheduled });
    }

    return Response.json({ ok: true, week: currentWeek, dry_run: dryRun, reports });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
});
