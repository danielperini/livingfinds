/**
 * executeApprovedKeywords
 * Executa KeywordSuggestions com status 'approved', criando campanhas manuais SP via API v3.
 * Processa um lote por chamada (default: 3) para evitar timeout.
 * Reutiliza a lógica de createManualCampaignV2 (via amazonAdsCommand / v3).
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ads(base44: any, accountId: string, operation: string, method: string, path: string, payload: any, contentType: string) {
  const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
    amazon_account_id: accountId,
    operation,
    method,
    path,
    payload,
    content_type: contentType,
    accept: contentType,
    _service_role: true,
  });
  return response?.data || response || {};
}

function extract(data: any, group: string, field: string) {
  const p = data?.payload || data || {};
  return p?.[group]?.success?.[0]?.[field]
    || p?.success?.[0]?.[field]
    || p?.[group]?.[0]?.[field]
    || (Array.isArray(p) ? p[0]?.[field] : null);
}

function norm(s: string) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    // Auth: usuário autenticado OU service role
    if (!body._service_role) {
      const user = await base44.auth.me();
      if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Resolver conta
    let account: any = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
      account = accs[0] || null;
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0] || null;
    }
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon conectada.' });

    const aid = account.id;
    const now = new Date().toISOString();

    // Buscar todas as keywords aprovadas
    const approved = await base44.asServiceRole.entities.KeywordSuggestion.filter(
      { amazon_account_id: aid, status: 'approved' }, '-approved_at', 100
    );

    if (approved.length === 0) {
      return Response.json({ ok: true, message: 'Nenhuma keyword aprovada pendente.', created: 0, remaining: 0 });
    }

    const batchSize = Math.min(Number(body.batch_size) || 3, 10);
    const batch = approved.slice(0, batchSize);

    // Pré-carregar dados
    const [allProducts, allCampaigns, allKeywords, cfgList] = await Promise.all([
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 500),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, '-created_date', 500),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, '-created_date', 1000),
      base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }),
    ]);

    const autopilot = cfgList[0] || {};
    const minBid = autopilot.min_bid || 0.25;
    const maxBid = autopilot.max_bid || 5.0;
    const MIN_BUDGET = 5.00;

    const productByAsin = new Map(allProducts.map((p: any) => [p.asin, p]));

    const campaignsByAsin = new Map<string, any[]>();
    for (const c of allCampaigns) {
      if (!c.asin) continue;
      if (!campaignsByAsin.has(c.asin)) campaignsByAsin.set(c.asin, []);
      campaignsByAsin.get(c.asin)!.push(c);
    }

    const keywordsByAsin = new Map<string, any[]>();
    for (const k of allKeywords) {
      const a = k.asin || '';
      if (!keywordsByAsin.has(a)) keywordsByAsin.set(a, []);
      keywordsByAsin.get(a)!.push(k);
    }

    const results: any[] = [];

    for (const suggestion of batch) {
      const { id: sid, asin, keyword } = suggestion;

      // Checar produto sem estoque
      const product = productByAsin.get(asin);
      if (product?.inventory_status === 'out_of_stock') {
        await base44.asServiceRole.entities.KeywordSuggestion.update(sid, { status: 'blocked', block_reason: 'Produto sem estoque.' });
        results.push({ id: sid, keyword, ok: false, blocked: true });
        continue;
      }

      // Checar keyword duplicada
      const asinKws = keywordsByAsin.get(asin) || [];
      if (asinKws.some((k: any) => norm(k.keyword_text || k.keyword) === norm(keyword) && k.match_type === 'exact' && k.state !== 'archived')) {
        await base44.asServiceRole.entities.KeywordSuggestion.update(sid, { status: 'duplicate', block_reason: 'Keyword exact já existe.' });
        results.push({ id: sid, keyword, ok: false, duplicate: true });
        continue;
      }

      // Checar campanha com mesmo nome
      const cleanKw = keyword.replace(/[^a-z0-9\sáéíóúâêôãõç-]/gi, '').trim().slice(0, 40);
      const campName = `SP | MANUAL | EXACT | ${asin} | ${cleanKw}`.slice(0, 128);
      const asinCamps = campaignsByAsin.get(asin) || [];
      if (asinCamps.some((c: any) => norm(c.name || c.campaign_name) === norm(campName))) {
        await base44.asServiceRole.entities.KeywordSuggestion.update(sid, { status: 'duplicate', block_reason: 'Campanha com mesmo nome já existe.' });
        results.push({ id: sid, keyword, ok: false, duplicate: true });
        continue;
      }

      const bid = Math.min(Math.max(suggestion.recommended_bid || 0.50, minBid), maxBid);
      const budget = Math.max(suggestion.recommended_budget || MIN_BUDGET, MIN_BUDGET);

      await base44.asServiceRole.entities.KeywordSuggestion.update(sid, { status: 'creating' });

      try {
        // 1. Campanha v3
        const campResp = await ads(base44, aid, 'createManualCampaignApprovedKw', 'POST', '/sp/campaigns', {
          campaigns: [{ name: campName, targetingType: 'MANUAL', state: 'ENABLED', budget: { budgetType: 'DAILY', budget }, startDate: now.slice(0, 10) }],
        }, 'application/vnd.spCampaign.v3+json');
        const campaignId = extract(campResp, 'campaigns', 'campaignId');
        if (!campaignId) throw new Error(campResp?.errors?.[0]?.message || 'Amazon não retornou campaignId');

        await wait(14000);

        // 2. Ad group v3
        const agResp = await ads(base44, aid, 'createManualAdGroupApprovedKw', 'POST', '/sp/adGroups', {
          adGroups: [{ name: `AG | EXACT | ${asin}`, campaignId, defaultBid: bid, state: 'ENABLED' }],
        }, 'application/vnd.spAdGroup.v3+json');
        const adGroupId = extract(agResp, 'adGroups', 'adGroupId');
        if (!adGroupId) throw new Error(agResp?.errors?.[0]?.message || 'Amazon não retornou adGroupId');

        await wait(14000);

        // 3. Product ad v3
        const sku = product?.sku || suggestion.sku || null;
        await ads(base44, aid, 'createProductAdApprovedKw', 'POST', '/sp/productAds', {
          productAds: [{ campaignId, adGroupId, ...(sku ? { sku } : { asin }), state: 'ENABLED' }],
        }, 'application/vnd.spProductAd.v3+json');

        await wait(14000);

        // 4. Keyword exact v3
        const kwResp = await ads(base44, aid, 'createExactKeywordApprovedKw', 'POST', '/sp/keywords', {
          keywords: [{ campaignId, adGroupId, keywordText: keyword, matchType: 'EXACT', state: 'ENABLED', bid: { value: bid, bidType: 'DEFAULT' } }],
        }, 'application/vnd.spKeyword.v3+json');
        const keywordId = extract(kwResp, 'keywords', 'keywordId');
        if (!keywordId) throw new Error(kwResp?.errors?.[0]?.message || 'Amazon não retornou keywordId');

        // 5. Persistir no banco
        const [campaignRecord, keywordRecord] = await Promise.all([
          base44.asServiceRole.entities.Campaign.create({
            amazon_account_id: aid,
            campaign_id: String(campaignId),
            asin, sku: sku || null,
            name: campName, campaign_name: campName,
            campaign_type: 'SP', targeting_type: 'MANUAL',
            state: 'enabled', status: 'enabled',
            daily_budget: budget,
            created_by_app: true, learning_eligible: true,
            launch_phase: 'new', days_running: 0,
            created_at: now, synced_at: now,
          }),
          base44.asServiceRole.entities.Keyword.create({
            amazon_account_id: aid,
            campaign_id: String(campaignId),
            ad_group_id: String(adGroupId),
            keyword_id: String(keywordId),
            asin, keyword_text: keyword, keyword,
            match_type: 'exact', state: 'enabled', status: 'enabled',
            current_bid: bid, bid, source: 'manual',
            first_seen_at: now, last_seen_at: now, synced_at: now,
          }),
        ]);

        // 6. Atualizar sugestão + decisão
        await Promise.all([
          base44.asServiceRole.entities.KeywordSuggestion.update(sid, {
            status: 'created',
            created_campaign_id: campaignRecord.id,
            created_keyword_id: keywordRecord.id,
            amazon_campaign_id: String(campaignId),
            executed_at: now,
          }),
          base44.asServiceRole.entities.OptimizationDecision.create({
            amazon_account_id: aid,
            decision_type: 'create_campaign',
            entity_type: 'campaign',
            entity_id: String(campaignId),
            campaign_id: String(campaignId),
            asin, keyword_text: keyword,
            action: 'create_campaign', value_after: budget,
            rationale: `Campanha manual SP criada via executeApprovedKeywords. Termo: "${keyword}".`,
            risk: 'low', requires_approval: false, status: 'executed',
            confidence: Math.round((suggestion.confidence || 0) * 100),
            objective: 'launch',
            country_code: account.country_code || 'BR',
            currency_code: account.currency_code || 'BRL',
            amazon_response: JSON.stringify({ campaignId, adGroupId, keywordId }),
            executed_at: now,
            source_function: 'executeApprovedKeywords',
            created_at: now,
          }),
        ]);

        // Atualizar índice local
        if (!keywordsByAsin.has(asin)) keywordsByAsin.set(asin, []);
        keywordsByAsin.get(asin)!.push({ keyword_text: keyword, keyword, match_type: 'exact', state: 'enabled' });

        results.push({ id: sid, ok: true, keyword, campaign_name: campName, amazon_campaign_id: String(campaignId) });

      } catch (err: any) {
        await base44.asServiceRole.entities.KeywordSuggestion.update(sid, {
          status: 'failed',
          error: String(err?.message || err).slice(0, 500),
        });
        results.push({ id: sid, ok: false, keyword, error: String(err?.message || err).slice(0, 200) });
      }
    }

    return Response.json({
      ok: true,
      total_approved: approved.length,
      batch_processed: batch.length,
      remaining: Math.max(0, approved.length - batchSize),
      created: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok && !r.blocked && !r.duplicate).length,
      skipped: results.filter(r => r.blocked || r.duplicate).length,
      results,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
});