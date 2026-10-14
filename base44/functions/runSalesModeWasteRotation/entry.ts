import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { aggregateSearchTermWasteTargets, decideWasteProgression, firstWasteBid, isTermTargetWaste } from '../../shared/searchTermWastePolicy.ts';

const n = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const active = (value: unknown) => ['enabled', 'active'].includes(String(value || '').toLowerCase());
const campaignId = (row: any) => String(row.amazon_campaign_id || row.campaign_id || row.id || '');

function brDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function shiftDate(date: string, days: number) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function unwrap(response: any) { return response?.data ?? response ?? {}; }

function productIdentity(campaign: any) {
  return {
    asin: String(campaign.asin || campaign.advertised_asin || '').trim().toUpperCase(),
    sku: String(campaign.sku || campaign.advertised_sku || '').trim().toUpperCase(),
  };
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, undefined, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 50);
    const lookbackDays = Math.max(7, Math.min(30, Number(body.lookback_days ?? 30)));
    const minAgeDays = Math.max(3, Math.min(30, Number(body.min_age_days ?? 7)));
    const dryRun = body.dry_run === true;
    const throughDate = shiftDate(brDate(), -1); // Closed report date in São Paulo, never partial today.
    const fromDate = shiftDate(throughDate, -(lookbackDays - 1));
    const results: any[] = [];

    for (const account of accounts) {
      const aid = String(account.id);
      const [campaigns, products, terms, settingsRows, decisions] = await Promise.all([
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, '-created_at', 10000).catch(() => []),
        base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, '-inventory_snapshot_at', 5000).catch(() => []),
        base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id: aid }, '-date', 50000).catch(() => []),
        base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, '-updated_at', 1).catch(() => []),
        base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: aid }, '-created_at', 50000).catch(() => []),
      ]);
      const settings = settingsRows[0] || {};
      const minimumSpend = Math.max(n(settings.min_spend_for_decision ?? 5) * 2, 8);
      const campaignMap = new Map<string, any>();
      for (const campaign of campaigns) {
        const id = campaignId(campaign);
        if (id) campaignMap.set(id, campaign);
      }
      const allEvidence = aggregateSearchTermWasteTargets(terms, campaignMap, { fromDate, throughDate });
      const byCampaign = new Map<string, any[]>();
      const eligible: any[] = [];
      const skipped: any[] = [];
      for (const evidence of allEvidence) {
        const campaign = campaignMap.get(evidence.campaignId);
        if (!campaign || !active(campaign.state || campaign.status)) continue;
        const createdAt = new Date(String(campaign.created_at || campaign.created_date || '')).getTime();
        const ageDays = Number.isFinite(createdAt) ? (Date.now() - createdAt) / 86400000 : 999;
        if (ageDays < minAgeDays) continue;
        const identity = productIdentity(campaign);
        const product = products.find((row: any) => {
          const asin = String(row.asin || row.amazon_asin || '').trim().toUpperCase();
          const sku = String(row.sku || row.seller_sku || '').trim().toUpperCase();
          return (identity.asin && asin === identity.asin) || (identity.sku && sku === identity.sku);
        });
        const stockUpdatedAt = new Date(String(product?.inventory_snapshot_at || product?.inventory_updated_at || '')).getTime();
        const stockFresh = Number.isFinite(stockUpdatedAt) && Date.now() - stockUpdatedAt <= 36 * 3600000;
        if (!product || !stockFresh || n(product.fba_inventory) <= 0) {
          skipped.push({ campaign_id: evidence.campaignId, target_id: evidence.targetId, reason: 'fresh_positive_fba_stock_required' });
          continue;
        }
        if (!isTermTargetWaste({ ...evidence, minimumSpend, throughDate, maxReportAgeDays: 3 })) continue;
        const candidates = byCampaign.get(evidence.campaignId) || [];
        candidates.push({ ...evidence, campaign, product, ageDays });
        byCampaign.set(evidence.campaignId, candidates);
      }

      const candidateCampaignIds = [...byCampaign.keys()];
      const liveTargets = new Map<string, any>();
      const liveKeywords = new Map<string, any>();
      const liveCampaigns = new Set<string>();
      for (let i = 0; i < candidateCampaignIds.length; i += 10) {
        const batch = candidateCampaignIds.slice(i, i + 10);
        const [campaignResponse, targetResponse, keywordResponse] = await Promise.all([
          base44.asServiceRole.functions.invoke('amazonAdsCommand', {
            amazon_account_id: aid, operation: 'listCampaigns', method: 'POST', path: '/sp/campaigns/list',
            payload: { campaignIdFilter: { include: batch }, stateFilter: { include: ['ENABLED'] }, maxResults: 100 },
            content_type: 'application/vnd.spCampaign.v3+json', accept: 'application/vnd.spCampaign.v3+json', _service_role: true,
          }).catch(() => null),
          base44.asServiceRole.functions.invoke('amazonAdsCommand', {
            amazon_account_id: aid, operation: 'listTargets', method: 'POST', path: '/sp/targets/list',
            payload: { campaignIdFilter: { include: batch }, stateFilter: { include: ['ENABLED'] }, maxResults: 100 },
            content_type: 'application/vnd.spTargetingClause.v3+json', accept: 'application/vnd.spTargetingClause.v3+json', _service_role: true,
          }).catch(() => null),
          base44.asServiceRole.functions.invoke('amazonAdsCommand', {
            amazon_account_id: aid, operation: 'listKeywords', method: 'POST', path: '/sp/keywords/list',
            payload: { campaignIdFilter: { include: batch }, stateFilter: { include: ['ENABLED'] }, maxResults: 100 },
            content_type: 'application/vnd.spKeyword.v3+json', accept: 'application/vnd.spKeyword.v3+json', _service_role: true,
          }).catch(() => null),
        ]);
        const campaignRows = unwrap(campaignResponse)?.payload?.campaigns || [];
        for (const row of campaignRows) if (active(row.state)) liveCampaigns.add(String(row.campaignId));
        const targetRows = unwrap(targetResponse)?.payload?.targetingClauses || [];
        for (const row of targetRows) if (active(row.state)) liveTargets.set(String(row.targetId), row);
        const keywordRows = unwrap(keywordResponse)?.payload?.keywords || [];
        for (const row of keywordRows) if (active(row.state)) liveKeywords.set(String(row.keywordId), row);
      }

      const created: any[] = [];
      for (const [id, candidates] of byCampaign) {
        if (!liveCampaigns.has(id)) {
          skipped.push({ campaign_id: id, reason: 'campaign_not_confirmed_enabled_in_amazon' });
          continue;
        }
        for (const candidate of candidates) {
          const live = candidate.isAutomatic ? liveTargets.get(candidate.targetId) : liveKeywords.get(candidate.targetId);
          const currentBid = n(live?.bid);
          if (!live || currentBid <= 0 || String(live.campaignId) !== id) {
            skipped.push({ campaign_id: id, target_id: candidate.targetId, reason: 'target_not_confirmed_enabled_in_amazon' });
            continue;
          }
          const confirmedReductions = decisions.filter((decision: any) =>
            String(decision.source_function || '') === 'runSalesModeWasteRotation' &&
            String(decision.campaign_id || '') === id && String(decision.entity_id || decision.target_id || '') === candidate.targetId &&
            decision.action === 'reduce_bid' && ['executed', 'completed'].includes(String(decision.status || '').toLowerCase()) &&
            String(decision.confirmation_status || '').toLowerCase() === 'confirmed',
          ).sort((a: any, b: any) => String(a.executed_at || a.created_at).localeCompare(String(b.executed_at || b.created_at)));
          const lastReduction = confirmedReductions.at(-1);
          const elapsedHours = lastReduction ? (Date.now() - new Date(String(lastReduction.executed_at || lastReduction.created_at)).getTime()) / 3600000 : Infinity;
          const firstAt = lastReduction
            ? new Date(String(confirmedReductions[0].executed_at || confirmedReductions[0].created_at)).getTime()
            : Date.now();
          const lastReductionAt = lastReduction ? new Date(String(lastReduction.executed_at || lastReduction.created_at)) : null;
          const lastReductionDate = lastReductionAt ? brDate(lastReductionAt) : throughDate;
          const afterReductionRows = lastReductionAt
            ? terms.filter((row: any) => String(row.campaign_id || '') === id &&
              String(row.source_target_id || row.target_id || row.keyword_id || '') === candidate.targetId &&
              String(row.date || '').slice(0, 10) > lastReductionDate && String(row.date || '').slice(0, 10) <= throughDate)
            : [];
          const postReduction = afterReductionRows.length
            ? aggregateSearchTermWasteTargets(afterReductionRows, campaignMap, { fromDate: shiftDate(lastReductionDate, 1), throughDate })
              .find((row) => row.campaignId === id && row.targetId === candidate.targetId)
            : undefined;
          const existingNegatives = new Set(decisions.filter((decision: any) =>
            String(decision.campaign_id || '') === id && ['negative_exact', 'negative_keyword'].includes(String(decision.action || '')) &&
            ['executed', 'completed'].includes(String(decision.status || '').toLowerCase()) && String(decision.confirmation_status || '').toLowerCase() === 'confirmed',
          ).map((decision: any) => String(decision.keyword_text || '').trim().toLowerCase()));
          const unresolvedTargetMutation = decisions.some((decision: any) =>
            String(decision.campaign_id || '') === id && String(decision.entity_id || decision.target_id || '') === candidate.targetId &&
            ['reduce_bid', 'increase_bid', 'update_bid', 'set_bid'].includes(String(decision.action || '')) &&
            ['approved', 'pending', 'executing', 'confirming'].includes(String(decision.status || '').toLowerCase()),
          );
          if (unresolvedTargetMutation) continue;
          const termForNegative = postReduction?.terms.find((item: any) => item.attributionComplete === true && item.orders === 0 && item.sales === 0 && item.spend >= minimumSpend && item.clicks >= 8 && !existingNegatives.has(item.text));
          const progression = decideWasteProgression({
            priorConfirmedReductions: confirmedReductions.length,
            hoursSinceLastReduction: elapsedHours,
            hoursSinceFirstReduction: (Date.now() - firstAt) / 3600000,
            spendSinceLastReduction: n(postReduction?.spend),
            clicksSinceLastReduction: n(postReduction?.clicks),
            ordersSinceLastReduction: n(postReduction?.orders),
            salesSinceLastReduction: n(postReduction?.sales),
            termAfterLastReduction: termForNegative,
            minimumSpend,
            alreadyNegative: false,
          });
          if (progression === 'HOLD') continue;
          if (progression === 'NEGATIVE_EXACT') {
            // A campaign/target is never paused by this rotation. Exact negatives
            // require renewed spend on that exact term after two confirmed cuts.
            const term = termForNegative;
            if (!term) continue;
            const key = `SALES_MODE_WASTE_NEGATIVE_EXACT|${aid}|${id}|${candidate.targetId}|${term.text}|${throughDate}`;
            if (decisions.some((decision: any) =>
              (decision.idempotency_key === key || (String(decision.campaign_id || '') === id && String(decision.keyword_text || '').trim().toLowerCase() === term.text && ['negative_exact', 'negative_keyword'].includes(String(decision.action || '')))) &&
              !['failed', 'rejected', 'cancelled', 'expired'].includes(String(decision.status || '').toLowerCase()),
            )) continue;
            const rationale = `Termo exato “${term.text}” gastou R$ ${term.spend.toFixed(2)} e teve ${term.clicks} cliques sem pedido; target recebeu duas reduções confirmadas há pelo menos 72h. A campanha permanece ativa.`;
            if (dryRun) { created.push({ campaign_id: id, target_id: candidate.targetId, action: 'negative_exact', keyword_text: term.text, rationale, dry_run: true }); continue; }
            const decision = await base44.asServiceRole.entities.OptimizationDecision.create({
              amazon_account_id: aid, decision_type: 'sales_mode_waste_rotation', entity_type: 'keyword', entity_id: candidate.targetId,
              campaign_id: id, campaign_name: candidate.campaign.name || candidate.campaign.campaign_name || null,
              asin: candidate.campaign.asin || candidate.campaign.advertised_asin || null, keyword_text: term.text,
              action: 'negative_exact', canonical_action_type: 'NEGATIVE_KEYWORD_CREATE', rationale,
              rule_key: 'SALES_MODE_TERM_WASTE_NEGATIVE_EXACT', reason_code: 'PERSISTENT_TERM_WASTE_AFTER_TWO_CONFIRMED_REDUCTIONS',
              value_before: currentBid, value_after: 'NEGATIVE_EXACT', confidence: 0.96, risk: 'medium', requires_approval: false,
              approval_status: 'auto_approved_deterministic', status: 'approved', queue_status: 'pending', priority_class: 'P1',
              execution_mode: 'EXPEDITED_QUEUE', confirmation_required: true, confirmation_status: 'pending', idempotency_key: key,
              conflict_group: `${aid}|campaign|${id}|negative|${term.text}`, source_function: 'runSalesModeWasteRotation',
              model_version: 'sales-mode-v1.3-term-target-waste', data_used: JSON.stringify({ from_date: fromDate, through_date: throughDate, term_spend: term.spend, term_clicks: term.clicks, target_spend: candidate.spend, target_orders: candidate.orders, fba_inventory: candidate.product.fba_inventory }),
              created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
            });
            created.push({ decision_id: decision.id, campaign_id: id, action: 'negative_exact', keyword_text: term.text, rationale });
            continue;
          }

          const action = progression;
          const after = action === 'REDUCE_BID_30'
            ? firstWasteBid(currentBid)
            : Math.max(0.02, Math.round(currentBid * 0.9 * 100) / 100);
          if (after >= currentBid) continue;
          const key = `SALES_MODE_WASTE_${action}|${aid}|${id}|${candidate.targetId}|${throughDate}`;
          if (decisions.some((decision: any) => decision.idempotency_key === key && !['failed', 'rejected', 'cancelled', 'expired'].includes(String(decision.status || '').toLowerCase()))) continue;
          const topTerm = candidate.terms[0];
          const rationale = `${lookbackDays} dias fechados, target ${candidate.isAutomatic ? 'automático' : 'manual'} do SKU ${candidate.product.sku || candidate.campaign.sku || '—'}: gasto R$ ${candidate.spend.toFixed(2)}, ${candidate.clicks} cliques e zero pedidos/vendas no target; última linha ${candidate.latestDate}. Lance confirmado na Amazon: R$ ${currentBid.toFixed(2)} → R$ ${after.toFixed(2)} (${action === 'REDUCE_BID_30' ? '-30%' : '-10%'}). Termo de maior gasto: “${topTerm?.text || '—'}”. O SKU tem ${n(candidate.product.fba_inventory)} unidades FBA, atualização ${candidate.product.inventory_snapshot_at || candidate.product.inventory_updated_at}.`;
          if (dryRun) { created.push({ campaign_id: id, target_id: candidate.targetId, action, before: currentBid, after, rationale, dry_run: true }); continue; }
          const decision = await base44.asServiceRole.entities.OptimizationDecision.create({
            amazon_account_id: aid, decision_type: 'sales_mode_waste_rotation', entity_type: candidate.isAutomatic ? 'product_target' : 'keyword',
            entity_id: candidate.targetId, target_id: candidate.isAutomatic ? candidate.targetId : null,
            keyword_id: candidate.isAutomatic ? null : candidate.targetId, campaign_id: id,
            campaign_name: candidate.campaign.name || candidate.campaign.campaign_name || null,
            asin: candidate.campaign.asin || candidate.campaign.advertised_asin || null, sku: candidate.product.sku || candidate.campaign.sku || null,
            keyword_text: topTerm?.text || null, action: 'reduce_bid', canonical_action_type: 'KEYWORD_BID_CHANGE', rationale,
            rule_key: `SALES_MODE_${action}`, reason_code: action === 'REDUCE_BID_30' ? 'FIRST_DAY_TARGET_WASTE_REDUCTION_30_PERCENT' : 'PERSISTENT_TARGET_WASTE_REDUCTION_10_PERCENT',
            value_before: currentBid, value_after: after, confidence: 0.93, risk: 'medium', requires_approval: false,
            approval_status: 'auto_approved_deterministic', status: 'approved', queue_status: 'pending', priority_class: 'P1',
            execution_mode: 'EXPEDITED_QUEUE', confirmation_required: true, confirmation_status: 'pending', idempotency_key: key,
            conflict_group: `${aid}|campaign|${id}|target|${candidate.targetId}`, source_function: 'runSalesModeWasteRotation',
            model_version: 'sales-mode-v1.3-term-target-waste', data_used: JSON.stringify({ from_date: fromDate, through_date: candidate.latestDate, target_spend: candidate.spend, target_sales: candidate.sales, target_orders: candidate.orders, target_clicks: candidate.clicks, top_terms: candidate.terms.slice(0, 10), minimum_spend: minimumSpend, fba_inventory: candidate.product.fba_inventory, inventory_snapshot_at: candidate.product.inventory_snapshot_at || candidate.product.inventory_updated_at, prior_confirmed_reductions: confirmedReductions.length }),
            created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          });
          created.push({ decision_id: decision.id, campaign_id: id, target_id: candidate.targetId, action, before: currentBid, after, rationale });
        }
      }
      eligible.push(...[...byCampaign.values()].flat().map((item) => ({ campaign_id: item.campaignId, target_id: item.targetId, spend: Number(item.spend.toFixed(2)), clicks: item.clicks, orders: item.orders, sales: Number(item.sales.toFixed(2)), latest_date: item.latestDate })));
      results.push({ amazon_account_id: aid, policy: 'term_target_level_no_sale_waste_with_fba_and_remote_state_guards', report_window: { from_date: fromDate, through_date: throughDate }, candidate_targets: eligible.length, decisions_created: created.length, decisions: created, eligible, skipped: skipped.slice(0, 100) });
    }
    return Response.json({ ok: true, engine: 'sales-mode-waste-rotation-v1.3', dry_run: dryRun, report_window: { from_date: fromDate, through_date: throughDate }, results });
  } catch (error: any) {
    return Response.json({ ok: false, engine: 'sales-mode-waste-rotation-v1.3', error: error?.message || 'Falha na rotação de desperdício' }, { status: 500 });
  }
});
