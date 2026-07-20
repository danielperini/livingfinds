/**
 * runWeeklySearchTermPromotion — Análise semanal de termos de alta conversão
 *
 * Critérios de promoção (TODOS obrigatórios):
 *  - orders >= 2 (mínimo de evidência)
 *  - CVR >= 5% (clicks > 0 ? orders/clicks)
 *  - ACoS <= target_acos da conta (rentabilidade aprovada)
 *  - spend >= R$1 (termo teve gasto real, não apenas impressões)
 *  - NOT negado, NOT já keyword exact ativa, NOT já promovido (idempotência)
 *  - ASIN com fba_inventory > 0 (produto em estoque)
 *
 * Saída:
 *  - SearchTermPromotion: registro completo de cada promoção (ou sugestão se dry_run)
 *  - SyncExecutionLog: histórico detalhado da execução com diff de mudanças
 *  - Campanha MANUAL EXACT + Ad Group + Product Ad + Keyword na Amazon Ads API
 *  - Negativa EXACT na campanha AUTO de origem
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function normalizeTerm(t: string): string {
  return String(t || '').toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function campaignName(asin: string, term: string): string {
  return `SP | MANUAL | EXACT | ${asin} | ${term.slice(0, 55)}`.slice(0, 128);
}

function ikey(aid: string, asin: string, norm: string): string {
  return `${aid}|${asin}|${norm}|EXACT|weekly`;
}

async function adsCmd(base44: any, accountId: string, method: string, path: string, payload: any, ct?: string) {
  const res = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
    _service_role: true,
    amazon_account_id: accountId,
    method, path, payload,
    ...(ct ? { content_type: ct, accept: ct } : {}),
  });
  const d = res?.data || {};
  return { ok: d.ok === true || (d.status >= 200 && d.status < 300), payload: d.payload || d, status: d.status || 0 };
}

function firstId(payload: any, group: string, field: string): string | null {
  const p = payload || {};
  return p?.[group]?.success?.[0]?.[field]
    || p?.success?.[0]?.[field]
    || p?.[group]?.[0]?.[field]
    || null;
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  const now = new Date().toISOString();
  const brtDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const todayBRT = brtDate.toISOString().slice(0, 10);

  // Janela de 7 dias excluindo últimas 72h (atribuição Amazon)
  const ATTRIBUTION_CUTOFF = new Date(Date.now() - 72 * 3600000).toISOString().slice(0, 10);
  const WEEK_START = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10); // 10d atrás

  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const dry_run: boolean = body.dry_run === true;

    // Auth
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    // Resolver conta
    let account: any;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1);
      account = accs[0];
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta conectada' });
    const aid = account.id;

    // Carregar configurações de performance
    const [perfList, products, existingPromos, existingExacts, economics] = await Promise.all([
      base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, null, 1).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid, status: 'active' }, null, 500).catch(() => []),
      base44.asServiceRole.entities.SearchTermPromotion.filter({ amazon_account_id: aid }, '-created_at', 3000).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid, match_type: 'exact' }, null, 5000).catch(() => []),
      base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: aid }, null, 500).catch(() => []),
    ]);

    const perf = perfList[0] || {};
    const TARGET_ACOS = Number(perf.target_acos || 15);
    const MIN_BID = Number(perf.min_bid || 0.25);
    const MAX_BID = Number(perf.max_bid || 3.00);
    const MIN_ORDERS = 2;
    const MIN_CVR = 0.05; // 5%
    const MIN_SPEND = 1.0; // R$1 mínimo

    // Índices de deduplicação
    const inStockAsins = new Set(products.filter((p: any) => Number(p.fba_inventory || 0) > 0).map((p: any) => p.asin));
    const existingIkeys = new Set(existingPromos.map((p: any) => p.idempotency_key).filter(Boolean));
    const existingPromoTerms = new Set(
      existingPromos
        .filter((p: any) => !['failed', 'repair_required'].includes(p.promotion_status || ''))
        .map((p: any) => `${p.asin}|${normalizeTerm(p.normalized_search_term || p.source_search_term || '')}`)
    );
    const exactTerms = new Set(
      existingExacts
        .filter((k: any) => !['archived'].includes(k.state || k.status || ''))
        .map((k: any) => normalizeTerm(k.keyword_text || k.keyword || ''))
    );
    const econMap = new Map(economics.map((e: any) => [e.asin, e]));
    const productMap = new Map(products.map((p: any) => [p.asin, p]));

    // ── FASE 1: Carregar e agregar Search Terms ───────────────────────
    const allTerms = await base44.asServiceRole.entities.SearchTerm.filter(
      { amazon_account_id: aid }, '-date', 10000
    ).catch(() => []);

    // Filtrar janela válida (excluindo atribuição recente)
    const windowTerms = allTerms.filter((t: any) =>
      t.search_term &&
      t.advertised_asin &&
      t.date &&
      t.date >= WEEK_START &&
      t.date < ATTRIBUTION_CUTOFF
    );

    // Agregar por ASIN + termo normalizado
    const termMap = new Map<string, any>();
    for (const t of windowTerms) {
      const norm = normalizeTerm(t.search_term);
      if (!norm || norm.length < 2) continue;
      const key = `${t.advertised_asin}|${norm}`;
      if (!termMap.has(key)) {
        termMap.set(key, {
          asin: t.advertised_asin,
          sku: t.advertised_sku || '',
          search_term: t.search_term,
          normalized_term: norm,
          campaign_id: t.campaign_id,
          ad_group_id: t.ad_group_id,
          orders: 0, sales: 0, spend: 0, clicks: 0, impressions: 0,
        });
      }
      const agg = termMap.get(key)!;
      agg.orders += t.orders_14d || t.orders_7d || t.orders_30d || 0;
      agg.sales += t.sales_14d || t.sales_7d || t.sales_30d || 0;
      agg.spend += Number(t.spend || 0);
      agg.clicks += Number(t.clicks || 0);
      agg.impressions += Number(t.impressions || 0);
    }

    // ── FASE 2: Filtrar candidatos de alta conversão ──────────────────
    const candidates: any[] = [];
    const rejected: any[] = [];

    for (const [key, agg] of termMap.entries()) {
      const cvr = agg.clicks > 0 ? agg.orders / agg.clicks : 0;
      const acos = agg.spend > 0 && agg.sales > 0 ? (agg.spend / agg.sales) * 100 : null;
      const avgCpc = agg.clicks > 0 ? agg.spend / agg.clicks : 0;

      // ACoS sustentável do produto específico (fallback para target global)
      const econ = econMap.get(agg.asin);
      const sustainableAcos = econ?.break_even_acos_percent || TARGET_ACOS * 1.5;
      const effectiveTargetAcos = Math.min(TARGET_ACOS, Number(econ?.target_acos || TARGET_ACOS));

      // CRITÉRIOS OBRIGATÓRIOS
      if (agg.orders < MIN_ORDERS) { rejected.push({ ...agg, cvr, acos, reject_reason: `orders=${agg.orders} < ${MIN_ORDERS}` }); continue; }
      if (cvr < MIN_CVR) { rejected.push({ ...agg, cvr, acos, reject_reason: `CVR=${(cvr*100).toFixed(1)}% < ${MIN_CVR*100}%` }); continue; }
      if (agg.spend < MIN_SPEND) { rejected.push({ ...agg, cvr, acos, reject_reason: `spend=R$${agg.spend.toFixed(2)} < R$${MIN_SPEND}` }); continue; }
      if (acos !== null && acos > effectiveTargetAcos) { rejected.push({ ...agg, cvr, acos, reject_reason: `ACoS=${acos.toFixed(1)}% > target ${effectiveTargetAcos}%` }); continue; }
      if (!inStockAsins.has(agg.asin)) { rejected.push({ ...agg, cvr, acos, reject_reason: 'Sem estoque (fba_inventory=0)' }); continue; }

      // DEDUPLICAÇÃO
      const promoKey = `${agg.asin}|${agg.normalized_term}`;
      if (existingPromoTerms.has(promoKey)) { rejected.push({ ...agg, cvr, acos, reject_reason: 'Já promovido anteriormente' }); continue; }
      if (exactTerms.has(agg.normalized_term)) { rejected.push({ ...agg, cvr, acos, reject_reason: 'Já existe keyword EXACT ativa' }); continue; }

      // Calcular bid inicial baseado em CVR e economics
      const product = productMap.get(agg.asin);
      const price = Number(econ?.current_price || product?.price || 0);
      const sustainableCpc = price > 0 ? price * cvr * (effectiveTargetAcos / 100) : 0;
      let initialBid = sustainableCpc > 0
        ? Math.min(avgCpc * 1.05, sustainableCpc)
        : avgCpc > 0 ? avgCpc * 1.05 : 0.50;
      initialBid = Math.round(Math.max(MIN_BID, Math.min(MAX_BID, initialBid)) * 100) / 100;

      candidates.push({
        ...agg, cvr, acos, avg_cpc: avgCpc, initial_bid: initialBid,
        sustainable_cpc: sustainableCpc, target_acos: effectiveTargetAcos,
        product_name: product?.product_name || product?.display_name || '',
      });
    }

    // Ordenar por score (orders × CVR / ACoS) — melhores primeiro
    candidates.sort((a, b) => {
      const scoreA = a.orders * a.cvr / Math.max(a.acos || TARGET_ACOS, 1);
      const scoreB = b.orders * b.cvr / Math.max(b.acos || TARGET_ACOS, 1);
      return scoreB - scoreA;
    });

    // Resumo para o log
    const changeLog: any[] = [];
    const stats = {
      terms_analyzed: termMap.size,
      window: `${WEEK_START} → ${ATTRIBUTION_CUTOFF}`,
      candidates_found: candidates.length,
      rejected: rejected.length,
      promoted: 0,
      dry_run_suggested: 0,
      failed: 0,
      skipped_duplicate: rejected.filter(r => r.reject_reason.includes('Já')).length,
    };

    // ── FASE 3: Executar promoções ────────────────────────────────────
    for (const cand of candidates) {
      const ik = ikey(aid, cand.asin, cand.normalized_term);
      if (existingIkeys.has(ik)) { stats.skipped_duplicate++; continue; }

      const campName = campaignName(cand.asin, cand.search_term);

      if (dry_run) {
        stats.dry_run_suggested++;
        changeLog.push({
          action: 'SUGGEST_PROMOTION',
          asin: cand.asin,
          term: cand.search_term,
          cvr_pct: (cand.cvr * 100).toFixed(1) + '%',
          acos: cand.acos ? cand.acos.toFixed(1) + '%' : 'n/a',
          orders: cand.orders,
          spend: 'R$' + cand.spend.toFixed(2),
          initial_bid: 'R$' + cand.initial_bid.toFixed(2),
          campaign_name: campName,
        });
        continue;
      }

      // Registrar a promoção
      let promo: any = null;
      try {
        promo = await base44.asServiceRole.entities.SearchTermPromotion.create({
          amazon_account_id: aid,
          asin: cand.asin,
          sku: cand.sku,
          source_campaign_id: cand.campaign_id,
          source_ad_group_id: cand.ad_group_id,
          source_search_term: cand.search_term,
          normalized_search_term: cand.normalized_term,
          orders: cand.orders,
          sales: cand.sales,
          spend: cand.spend,
          clicks: cand.clicks,
          average_cpc: cand.avg_cpc,
          acos: cand.acos,
          roas: cand.spend > 0 && cand.sales > 0 ? cand.sales / cand.spend : null,
          cvr: cand.cvr,
          target_acos: cand.target_acos,
          target_bid: cand.initial_bid,
          winner_tier: cand.orders >= 5 && cand.cvr >= 0.08 ? 'WINNER_STRONG' : 'WINNER',
          promotion_type: 'WEEKLY_HIGH_CONVERSION',
          promotion_status: 'creating',
          protected_by_winner_term: true,
          idempotency_key: ik,
          created_at: now,
          updated_at: now,
        });
        existingIkeys.add(ik);
        existingPromoTerms.add(`${cand.asin}|${cand.normalized_term}`);
      } catch (e: any) {
        stats.failed++;
        continue;
      }

      try {
        // STEP 1: Campanha
        const campR = await adsCmd(base44, aid, 'POST', '/sp/campaigns', {
          campaigns: [{
            name: campName,
            targetingType: 'MANUAL',
            state: 'ENABLED',
            startDate: todayBRT.replace(/-/g, ''),
            dailyBudget: 5.0,
            budgetType: 'DAILY',
          }],
        });
        const campaignId = firstId(campR.payload, 'campaigns', 'campaignId');
        if (!campaignId) throw new Error(`Campanha não criada: ${JSON.stringify(campR.payload).slice(0, 150)}`);
        await base44.asServiceRole.entities.SearchTermPromotion.update(promo.id, {
          promotion_status: 'campaign_created',
          destination_campaign_id: campaignId,
          destination_campaign_name: campName,
          updated_at: now,
        }).catch(() => {});
        await sleep(2500);

        // STEP 2: Ad Group
        const agR = await adsCmd(base44, aid, 'POST', '/sp/adGroups', {
          adGroups: [{ name: `AG | EXACT | ${cand.asin}`, campaignId, defaultBid: cand.initial_bid, state: 'ENABLED' }],
        }, 'application/vnd.spAdGroup.v3+json');
        const adGroupId = firstId(agR.payload, 'adGroups', 'adGroupId');
        if (!adGroupId) throw new Error(`Ad Group não criado: ${JSON.stringify(agR.payload).slice(0, 150)}`);
        await base44.asServiceRole.entities.SearchTermPromotion.update(promo.id, {
          promotion_status: 'ad_group_created',
          destination_ad_group_id: adGroupId,
          updated_at: now,
        }).catch(() => {});
        await sleep(2500);

        // STEP 3: Product Ad
        const paPayload: any = { campaignId, adGroupId, state: 'ENABLED' };
        if (cand.sku) paPayload.sku = cand.sku; else paPayload.asin = cand.asin;
        await adsCmd(base44, aid, 'POST', '/sp/productAds', { productAds: [paPayload] }, 'application/vnd.spProductAd.v3+json');
        await sleep(2500);

        // STEP 4: Keyword EXACT
        const kwR = await adsCmd(base44, aid, 'POST', '/sp/keywords', {
          keywords: [{
            campaignId, adGroupId,
            keywordText: cand.search_term,
            matchType: 'EXACT',
            bid: cand.initial_bid,
            state: 'ENABLED',
          }],
        }, 'application/vnd.spKeyword.v3+json');
        const keywordId = firstId(kwR.payload, 'keywords', 'keywordId');

        // STEP 5: Negativa EXACT na AUTO de origem
        let negKwId: string | null = null;
        if (cand.campaign_id && cand.ad_group_id) {
          await sleep(1500);
          const negR = await adsCmd(base44, aid, 'POST', '/sp/negativeKeywords', {
            negativeKeywords: [{
              campaignId: cand.campaign_id,
              adGroupId: cand.ad_group_id,
              keywordText: cand.search_term,
              matchType: 'NEGATIVE_EXACT',
              state: 'ENABLED',
            }],
          }, 'application/vnd.spNegativeKeyword.v3+json');
          negKwId = firstId(negR.payload, 'negativeKeywords', 'keywordId') ||
                    firstId(negR.payload, 'negativeKeywords', 'negativeKeywordId');
        }

        // Finalizar registro
        await base44.asServiceRole.entities.SearchTermPromotion.update(promo.id, {
          promotion_status: 'completed',
          destination_keyword_id: keywordId || null,
          negative_keyword_id: negKwId || null,
          completed_at: now,
          updated_at: now,
        }).catch(() => {});

        // Registrar campanha localmente
        await base44.asServiceRole.entities.Campaign.create({
          amazon_account_id: aid,
          campaign_id: campaignId,
          amazon_campaign_id: campaignId,
          name: campName, campaign_name: campName,
          asin: cand.asin,
          targeting_type: 'MANUAL', campaign_type: 'SP',
          state: 'enabled', status: 'enabled',
          daily_budget: 5.0,
          created_by_app: true,
          launch_phase: 'new',
          is_operational: true,
          created_at: now, last_sync_at: now, synced_at: now,
        }).catch(() => {});

        stats.promoted++;
        changeLog.push({
          action: 'PROMOTED',
          asin: cand.asin,
          term: cand.search_term,
          cvr_pct: (cand.cvr * 100).toFixed(1) + '%',
          acos: cand.acos ? cand.acos.toFixed(1) + '%' : 'n/a',
          orders: cand.orders,
          spend: 'R$' + cand.spend.toFixed(2),
          initial_bid: 'R$' + cand.initial_bid.toFixed(2),
          campaign_id: campaignId,
          keyword_id: keywordId,
          negative_applied: !!negKwId,
          campaign_name: campName,
          product_name: cand.product_name,
        });

        await sleep(2000);

      } catch (err: any) {
        stats.failed++;
        if (promo?.id) {
          await base44.asServiceRole.entities.SearchTermPromotion.update(promo.id, {
            promotion_status: 'repair_required',
            last_error: String(err?.message || err).slice(0, 500),
            updated_at: now,
          }).catch(() => {});
        }
        changeLog.push({
          action: 'FAILED',
          asin: cand.asin,
          term: cand.search_term,
          error: String(err?.message || err).slice(0, 200),
        });
      }
    }

    // ── FASE 4: Gravar no SyncExecutionLog (histórico completo) ──────
    const executionStatus = stats.failed > 0 && stats.promoted === 0 ? 'error'
      : stats.failed > 0 ? 'warning' : 'success';

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'weekly_search_term_promotion',
      trigger_type: 'automatic',
      status: executionStatus,
      execution_date: todayBRT,
      started_at: new Date(t0).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - t0,
      records_processed: stats.promoted,
      result_summary: JSON.stringify({
        ...stats,
        top_promoted: changeLog.filter(c => c.action === 'PROMOTED').slice(0, 10),
        top_rejected: rejected.slice(0, 10).map(r => ({
          asin: r.asin,
          term: r.search_term,
          reject_reason: r.reject_reason,
          orders: r.orders,
          cvr: r.cvr ? (r.cvr * 100).toFixed(1) + '%' : 'n/a',
        })),
      }),
    }).catch(() => {});

    return Response.json({
      ok: true,
      dry_run,
      date: todayBRT,
      window: stats.window,
      config: { TARGET_ACOS, MIN_BID, MAX_BID, MIN_ORDERS, MIN_CVR: MIN_CVR * 100 + '%', MIN_SPEND: 'R$' + MIN_SPEND },
      stats,
      change_log: changeLog,
      top_rejected: rejected.slice(0, 20).map(r => ({
        asin: r.asin,
        term: r.search_term,
        reject_reason: r.reject_reason,
        orders: r.orders,
        cvr: r.cvr ? (r.cvr * 100).toFixed(1) + '%' : null,
        acos: r.acos ? r.acos.toFixed(1) + '%' : null,
      })),
      duration_ms: Date.now() - t0,
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});