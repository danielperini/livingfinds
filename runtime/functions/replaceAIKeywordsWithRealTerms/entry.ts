/**
 * replaceAIKeywordsWithRealTerms
 *
 * Substitui termos de IA por termos reais da campanha automática.
 * Prioridade: vendas > conversão > cliques relevantes > sugestões Amazon > IA
 *
 * Regra de substituição: search term real com >= 1 venda, conversão comprovada
 * ou desempenho superior ao termo de IA existente.
 *
 * Promoção para campanha manual EXACT: orders >= 3
 * Zero IA nesta função — apenas matemática e lógica de estado.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function norm(s: string) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function isSimilar(a: string, b: string): boolean {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = new Set(na.split(' ')), tb = new Set(nb.split(' '));
  const inter = [...ta].filter(t => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return union > 0 && inter / union >= 0.75;
}

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const now = new Date().toISOString();

  try {
    const body = await req.json().catch(() => ({}));
    const serviceRole = body._service_role === true;
    if (!serviceRole) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { amazon_account_id, dry_run = false } = body;
    const accountFilter = amazon_account_id ? { id: amazon_account_id } : { status: 'connected' };
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter(accountFilter, null, 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' });
    const aid = account.id;

    // ── Buscar dados necessários ───────────────────────────────────────
    const [aiLifecycles, searchTerms, existingKeywords] = await Promise.all([
      base44.asServiceRole.entities.KeywordLifecycle.filter(
        { amazon_account_id: aid, source: 'ai_generated' }, null, 500
      ),
      base44.asServiceRole.entities.SearchTerm.filter(
        { amazon_account_id: aid }, '-orders_14d', 500
      ),
      base44.asServiceRole.entities.Keyword.filter(
        { amazon_account_id: aid }, null, 1000
      ),
    ]);

    // Agrupar search terms por ASIN com métricas agregadas
    const stByAsin = new Map<string, any[]>();
    for (const st of searchTerms as any[]) {
      const asin = st.advertised_asin || st.asin;
      if (!asin) continue;
      if (!stByAsin.has(asin)) stByAsin.set(asin, []);
      stByAsin.get(asin)!.push(st);
    }

    const replacements: any[] = [];
    const promotionCandidates: any[] = [];
    let replaced = 0, promoted = 0;

    for (const lc of aiLifecycles as any[]) {
      if (['replaced', 'promoted', 'blocked'].includes(lc.status)) continue;

      const asinTerms = stByAsin.get(lc.asin) || [];

      // Termos reais com vendas para este ASIN
      const realWinners = asinTerms
        .filter(st => {
          const orders = Number(st.orders_14d || st.orders_7d || 0);
          const clicks = Number(st.clicks || 0);
          return orders > 0 || clicks >= 3;
        })
        .sort((a: any, b: any) => {
          const ordA = Number(a.orders_14d || a.orders_7d || 0);
          const ordB = Number(b.orders_14d || b.orders_7d || 0);
          if (ordB !== ordA) return ordB - ordA;
          return Number(b.clicks || 0) - Number(a.clicks || 0);
        });

      if (realWinners.length === 0) continue;

      // Verificar se o termo de IA é similar a algum vencedor
      const similarWinner = realWinners.find(st =>
        isSimilar(st.search_term || st.keyword_text || '', lc.keyword_text)
      );

      // Termos reais superiores (não similares ao termo de IA — são substitutos)
      const superiorTerms = realWinners.filter(st => {
        const stNorm = norm(st.search_term || st.keyword_text || '');
        const kwNorm = norm(lc.keyword_text);
        // Verificar que não já existe como keyword manual
        const alreadyExists = (existingKeywords as any[]).some(kw => {
          if (kw.state === 'archived' || kw.status === 'archived') return false;
          return norm(kw.keyword_text || '') === stNorm && kw.asin === lc.asin && kw.match_type === 'exact';
        });
        return !isSimilar(stNorm, kwNorm) && !alreadyExists;
      });

      // Marcar termo de IA como replaced se houver substituto real
      if (superiorTerms.length > 0 && (similarWinner || realWinners[0])) {
        const bestReal = superiorTerms[0];
        const update: any = {
          status: 'replaced',
          source_search_term: bestReal.search_term || bestReal.keyword_text,
          updated_at: now,
        };
        if (!dry_run) await base44.asServiceRole.entities.KeywordLifecycle.update(lc.id, update);

        replacements.push({
          ai_keyword: lc.keyword_text,
          asin: lc.asin,
          replaced_by: bestReal.search_term || bestReal.keyword_text,
          orders: Number(bestReal.orders_14d || bestReal.orders_7d || 0),
          clicks: Number(bestReal.clicks || 0),
        });
        replaced++;
      }

      // Candidatos à promoção EXACT: >= 3 pedidos
      for (const st of realWinners) {
        const orders = Number(st.orders_14d || st.orders_7d || 0);
        if (orders < 3) continue;

        const term = norm(st.search_term || st.keyword_text || '');
        const alreadyExists = (existingKeywords as any[]).some(kw => {
          if (kw.state === 'archived') return false;
          return norm(kw.keyword_text || '') === term && kw.asin === lc.asin && kw.match_type === 'exact';
        });
        if (alreadyExists) continue;

        // Verificar se já há promoção pendente
        const existingPromo = await base44.asServiceRole.entities.SearchTermPromotion.filter({
          amazon_account_id: aid,
          asin: lc.asin,
          source_search_term: st.search_term || st.keyword_text,
        }, null, 1);
        if (existingPromo.length > 0) continue;

        const avgCpc = Number(st.spend || 0) > 0 && Number(st.clicks || 0) > 0
          ? Number(st.spend) / Number(st.clicks)
          : 0.50;

        if (!dry_run) {
          await base44.asServiceRole.entities.SearchTermPromotion.create({
            amazon_account_id: aid,
            asin: lc.asin,
            sku: lc.sku || '',
            source_campaign_id: lc.source_auto_campaign_id || lc.campaign_id,
            source_ad_group_id: lc.ad_group_id,
            source_search_term: st.search_term || st.keyword_text,
            normalized_search_term: term,
            orders: orders,
            clicks: Number(st.clicks || 0),
            spend: Number(st.spend || 0),
            sales: Number(st.sales_14d || st.sales_7d || 0),
            average_cpc: avgCpc,
            acos: Number(st.spend || 0) > 0 && Number(st.sales_14d || st.sales_7d || 0) > 0
              ? (Number(st.spend) / Number(st.sales_14d || st.sales_7d)) * 100 : 0,
            target_bid: Math.min(Math.max(avgCpc * 1.10, 0.30), 5.00),
            promotion_status: 'identified',
            created_at: now,
            updated_at: now,
          });
        }

        promotionCandidates.push({
          term: st.search_term || st.keyword_text,
          asin: lc.asin,
          orders,
          clicks: Number(st.clicks || 0),
        });
        promoted++;
      }
    }

    return Response.json({
      ok: true,
      dry_run,
      replaced,
      promotion_candidates_created: promoted,
      replacements,
      promotion_candidates: promotionCandidates,
    });
  } catch (error) {
    return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
});