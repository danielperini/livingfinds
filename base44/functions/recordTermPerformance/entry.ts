/**
 * recordTermPerformance
 *
 * Grava ou atualiza um termo no TermBank com dados de performance.
 * Chamado:
 *   - Ao criar campanha manual (kickoff)
 *   - Ao harvester de search terms detectar conversão
 *   - Pelo sync diário para atualizar métricas
 *
 * Payload:
 *   amazon_account_id, term, asin, product_name?, source?, match_type?,
 *   campaign_id?, amazon_campaign_id?, keyword_id?,
 *   impressions?, clicks?, spend?, sales?, orders?, cpc?, ctr?,
 *   bid_initial?, bid_current?,
 *   compatible_asins?   — lista de outros ASINs onde este termo já converteu
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function normTerm(str) {
  return (str || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function calcPerformanceScore({ orders = 0, acos = 0, roas = 0, clicks = 0, conversion_rate = 0 }) {
  if (orders === 0 && clicks < 5) return 0;
  let score = 0;
  // Conversões (40 pts)
  score += Math.min(40, orders * 8);
  // ACoS (30 pts — 0% acos = 30, 50%+ = 0)
  if (acos > 0) score += Math.max(0, 30 - acos * 0.6);
  // Taxa de conversão (20 pts)
  score += Math.min(20, conversion_rate * 100);
  // Cliques (10 pts — logarítmico)
  score += Math.min(10, Math.log10(clicks + 1) * 5);
  return Math.round(Math.min(100, score));
}

function classify(score, orders, clicks, spend) {
  if (orders >= 4 && score >= 60) return 'winner';
  if (orders >= 1 && score >= 30) return 'learning';
  if (orders === 0 && clicks >= 10 && spend >= 5) return 'wasting';
  if (clicks >= 3) return 'learning';
  return 'new';
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    const {
      amazon_account_id, term, asin, product_name,
      source = 'search_term_auto', match_type = 'exact',
      campaign_id, amazon_campaign_id, keyword_id,
      impressions = 0, clicks = 0, spend = 0, sales = 0, orders = 0,
      cpc = 0, ctr = 0, bid_initial, bid_current,
      compatible_asins = [],
    } = body;

    if (!amazon_account_id || !term || !asin) {
      return Response.json({ ok: false, error: 'amazon_account_id, term e asin são obrigatórios' }, { status: 400 });
    }

    // Só entra no banco de termos quem vendeu pelo menos 4 vezes
    if ((orders || 0) < 4) {
      return Response.json({ ok: false, skipped: true, reason: 'Menos de 4 pedidos — termo não elegível para o banco' });
    }

    const now = new Date().toISOString();
    const termNorm = normTerm(term);
    const acos = sales > 0 ? (spend / sales) * 100 : 0;
    const roas = spend > 0 ? sales / spend : 0;
    const conversion_rate = clicks > 0 ? orders / clicks : 0;
    const performance_score = calcPerformanceScore({ orders, acos, roas, clicks, conversion_rate });
    const classification = classify(performance_score, orders, clicks, spend);

    // Buscar entrada existente para este term + asin
    const existing = await base44.asServiceRole.entities.TermBank.filter({
      amazon_account_id,
      term_normalized: termNorm,
      asin,
    }, null, 1);

    const entry = existing[0];

    if (entry) {
      // Atualizar métricas acumulando
      const merged_compatible = [...new Set([...(entry.compatible_asins || []), ...compatible_asins])];
      await base44.asServiceRole.entities.TermBank.update(entry.id, {
        impressions: Math.max(entry.impressions || 0, impressions),
        clicks: Math.max(entry.clicks || 0, clicks),
        spend: Math.max(entry.spend || 0, spend),
        sales: Math.max(entry.sales || 0, sales),
        orders: Math.max(entry.orders || 0, orders),
        acos: acos > 0 ? acos : (entry.acos || 0),
        roas: roas > 0 ? roas : (entry.roas || 0),
        cpc: cpc > 0 ? cpc : (entry.cpc || 0),
        ctr: ctr > 0 ? ctr : (entry.ctr || 0),
        conversion_rate: conversion_rate > 0 ? conversion_rate : (entry.conversion_rate || 0),
        bid_current: bid_current || entry.bid_current,
        performance_score,
        classification,
        compatible_asins: merged_compatible,
        campaign_id: campaign_id || entry.campaign_id,
        amazon_campaign_id: amazon_campaign_id || entry.amazon_campaign_id,
        keyword_id: keyword_id || entry.keyword_id,
        product_name: product_name || entry.product_name,
        last_seen_at: now,
        last_performance_update: now,
      });
      return Response.json({ ok: true, action: 'updated', id: entry.id, performance_score, classification });
    } else {
      // Criar novo registro
      const created = await base44.asServiceRole.entities.TermBank.create({
        amazon_account_id,
        term: term.toLowerCase().trim(),
        term_normalized: termNorm,
        asin,
        product_name: product_name || '',
        match_type,
        source,
        status: 'active',
        campaign_id: campaign_id || null,
        amazon_campaign_id: amazon_campaign_id || null,
        keyword_id: keyword_id || null,
        impressions,
        clicks,
        spend,
        sales,
        orders,
        acos,
        roas,
        cpc,
        ctr,
        conversion_rate,
        bid_initial: bid_initial || 0.50,
        bid_current: bid_current || bid_initial || 0.50,
        performance_score,
        classification,
        compatible_asins,
        first_seen_at: now,
        last_seen_at: now,
        last_performance_update: now,
        created_at: now,
      });
      return Response.json({ ok: true, action: 'created', id: created.id, performance_score, classification });
    }

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});