/**
 * Adapter legado para sugestões de keyword.
 * Sugestões de IA/Amazon nunca criam campanhas diretamente: cada termo passa
 * pelo gate canônico de Search Term Reports, atribuição ao mesmo SKU, economia,
 * estoque e deduplicação de createManualCampaignV2.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { isTitleFragmentKeyword, normalizeSearchTerm } from '../../shared/searchTermHarvestPolicy.ts';

const MAX_SUGGESTIONS_PER_RUN = 4;

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role && !(await base44.auth.isAuthenticated().catch(() => false))) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }
    const accountId = String(body.amazon_account_id || '');
    const asin = String(body.asin || '').trim().toUpperCase();
    if (!accountId || !/^B0[A-Z0-9]{8}$/.test(asin)) {
      return Response.json({ ok: false, error: 'Conta e ASIN válido são obrigatórios' }, { status: 400 });
    }

    const [accounts, products, suggestions] = await Promise.all([
      base44.asServiceRole.entities.AmazonAccount.filter({ id: accountId }, undefined, 1),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId, asin }, undefined, 1),
      base44.asServiceRole.entities.KeywordSuggestion.filter({
        amazon_account_id: accountId, asin, source: 'AMAZON_ADS_SUGGESTED_KEYWORD', status: 'ranked',
      }, undefined, 100).catch(() => []),
    ]);
    const account = accounts[0];
    const product = products[0];
    if (!account || !product) return Response.json({ ok: false, error: 'Conta ou produto não encontrado' }, { status: 404 });
    const title = String(product.product_name || product.display_name || product.title || '').trim();
    const seen = new Set<string>();
    const candidates = suggestions
      .filter((suggestion: any) => {
        const term = normalizeSearchTerm(suggestion.keyword || '');
        const tokens = term.split(' ').filter(Boolean);
        if (suggestion.should_create_campaign !== true || Number(suggestion.ai_confidence || 0) < 0.9) return false;
        if (!['low', 'medium'].includes(String(suggestion.risk_level || 'high'))) return false;
        if (tokens.length < 2 || isTitleFragmentKeyword(term, title) || seen.has(term)) return false;
        seen.add(term);
        return true;
      })
      .sort((a: any, b: any) => Number(a.ai_rank || 99) - Number(b.ai_rank || 99))
      .slice(0, MAX_SUGGESTIONS_PER_RUN);

    const results: any[] = [];
    for (const suggestion of candidates) {
      const response = await base44.asServiceRole.functions.invoke('createManualCampaignV2', {
        _service_role: true,
        amazon_account_id: accountId,
        asin,
        sku: product.sku || suggestion.sku || null,
        product_name: title,
        keyword: suggestion.keyword,
        dry_run: body.dry_run === true,
      }).catch((error: any) => ({ data: { ok: false, error: error?.message || 'promotion_failed' } }));
      const data = response?.data || response || {};
      const created = data.ok === true && Boolean(data.campaign_id);
      if (created && body.dry_run !== true && suggestion.id) {
        await base44.asServiceRole.entities.KeywordSuggestion.update(suggestion.id, {
          status: 'created', amazon_campaign_id: data.campaign_id, executed_at: new Date().toISOString(),
        }).catch(() => {});
      }
      results.push({
        suggestion_id: suggestion.id || null,
        keyword: suggestion.keyword,
        ok: created,
        blocked: data.blocked === true || !created,
        campaign_id: data.campaign_id || null,
        reason: data.error || (created ? null : 'Sem duas vendas verificadas do mesmo SKU, margem segura e estoque atualizado.'),
      });
    }

    const created = results.filter((result) => result.ok).length;
    return Response.json({
      ok: true,
      dry_run: body.dry_run === true,
      asin,
      candidates_checked: candidates.length,
      created,
      blocked: results.filter((result) => result.blocked).length,
      blocked_title_fragments: suggestions.filter((suggestion: any) => isTitleFragmentKeyword(suggestion.keyword, title)).length,
      policy: 'verified_same_sku_search_term_only',
      results,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: String(error?.message || error).slice(0, 500) }, { status: 500 });
  }
});
