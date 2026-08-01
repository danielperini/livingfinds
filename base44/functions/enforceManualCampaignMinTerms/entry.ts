/**
 * enforceManualCampaignMinTerms — v4 (EVIDENCE-BASED)
 *
 * REGRA ABSOLUTA: 1 campanha manual = 1 ASIN = 1 keyword EXACT
 *
 * Cada termo faltante cria uma NOVA campanha individual via createManualCampaignV2.
 * NUNCA adiciona múltiplas keywords em uma campanha existente via POST /sp/keywords.
 *
 * Regras:
 * 1. No máximo 2 posições iniciais por ASIN, preenchidas somente por termos com pedido atribuído.
 * 2. Não pausa nem repõe campanha sem impressão: o governador canônico trata entrega após 15 dias.
 * 3. Nunca cria campanha a partir de sugestão sem conversão apenas para cumprir uma cota.
 * 4. Bid limitado pelo CPC econômico validado; sem teto econômico, não cria.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';
import { economicsAreActionable, numberValue } from '../../shared/profitGuardPolicy.ts';

const EVIDENCED_EXACT_SLOTS_PER_ASIN = 2;
const MIN_BID = 0.35;
const MAX_BID = 3.00;
const MIN_BUDGET = 9.00;
const MAX_CAMPAIGNS_PER_RUN = 10;

function calcEvidenceBid(settings: any, economics: any, assessment: any, term: any): number | null {
  const maxBid = settings?.max_bid || MAX_BID;
  const minBid = settings?.min_bid || MIN_BID;
  const safeCpc = numberValue(assessment?.safe_max_cpc ?? economics?.safe_max_cpc, 0);
  if (safeCpc <= 0 || safeCpc < minBid) return null;
  const observedCpc = numberValue(term?.cpc, 0);
  const recommendedCpc = numberValue(term?.recommended_bid ?? term?.maximum_profitable_cpc, 0);
  const evidenceBid = recommendedCpc > 0 ? recommendedCpc : observedCpc > 0 ? observedCpc * 0.90 : safeCpc * 0.80;
  return Math.min(maxBid, safeCpc, Math.max(minBid, Math.round(evidenceBid * 100) / 100));
}

function normTerm(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/** Score de um termo do TermBank para priorização */
function termBankScore(st: any): number {
  return (st.orders_14d || st.orders || 0) * 50
    + (st.clicks || 0) * 2
    + (st.roas_14d || st.roas || 0) * 10
    - (st.acos_14d || st.acos || 0) * 2;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

Deno.serve(async (req) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    if (!body._service_role) {
      const user = await base44.auth.me();
      if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    // Resolver conta
    let account: any = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
      account = accs[0] || null;
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0] || null;
    }
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon conectada.' });
    const aid = account.id;

    const stats = {
      asins_checked: 0,
      campaigns_created: 0,
      terms_from_termbank: 0,
      blocked_without_economics: 0,
      blocked_without_conversion_evidence: 0,
      hard_guard_blocks: 0,
      errors: [] as string[],
    };

    // ── 1. Buscar todas as campanhas MANUAL ativas ──────────────────────────
    const allCampaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: aid, targeting_type: 'MANUAL' }, '-spend', 500
    );
    const manualActive = allCampaigns.filter((c: any) => {
      const st = (c.state || c.status || '').toLowerCase();
      return st !== 'archived' && !c.archived;
    });

    // Agrupar por ASIN
    const byAsin = new Map<string, any[]>();
    for (const c of manualActive) {
      const asin = c.asin;
      if (!asin) continue;
      if (!byAsin.has(asin)) byAsin.set(asin, []);
      byAsin.get(asin)!.push(c);
    }

    // Carregar metas de performance
    const perfSettings = await base44.asServiceRole.entities.PerformanceSettings.filter(
      { amazon_account_id: aid }, undefined, 1
    ).then((r: any[]) => r[0] || null).catch(() => null);

    // Carregar produtos para calcular bid
    const allProducts = await base44.asServiceRole.entities.Product.filter(
      { amazon_account_id: aid }, undefined, 500
    ).catch(() => []);
    const productByAsin = new Map<string, any>(allProducts.map((p: any) => [p.asin, p]));

    const [allEconomics, allAssessments] = await Promise.all([
      base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: aid }, '-updated_at', 2000).catch(() => []),
      base44.asServiceRole.entities.DailyProductAdsAssessment.filter({ amazon_account_id: aid }, '-assessment_date', 3000).catch(() => []),
    ]);
    const economicsByAsin = new Map<string, any>(allEconomics.filter((row: any) => row.asin).map((row: any) => [String(row.asin), row]));
    const assessmentByAsin = new Map<string, any>();
    for (const row of allAssessments) {
      if (row.asin && !assessmentByAsin.has(String(row.asin))) assessmentByAsin.set(String(row.asin), row);
    }

    // Somente termos observados no relatório de search terms.
    const allTermBank = await base44.asServiceRole.entities.SearchTerm.filter(
      { amazon_account_id: aid }, '-orders_14d', 2000
    );

    // Carregar keywords ativas do banco para deduplicação cross-ASIN
    const allKeywords = await base44.asServiceRole.entities.Keyword.filter(
      { amazon_account_id: aid }, undefined, 5000
    ).catch(() => []);

    // Índice de keywords ativas por ASIN (normalized_term)
    const activeTermsByAsin = new Map<string, Set<string>>();
    for (const kw of allKeywords) {
      if (!kw.asin) continue;
      const st = (kw.state || kw.status || '').toLowerCase();
      if (st === 'archived') continue;
      if (kw.match_type !== 'exact') continue;
      if (!activeTermsByAsin.has(kw.asin)) activeTermsByAsin.set(kw.asin, new Set());
      activeTermsByAsin.get(kw.asin)!.add(normTerm(kw.keyword_text || kw.keyword || ''));
    }

    let totalCreated = 0;

    // ── 2. Por ASIN: verificar campanhas ativas e fazer enforcement ──────────
    for (const [asin, camps] of byAsin.entries()) {
      stats.asins_checked++;
      const product = productByAsin.get(asin) || null;
      const economics = economicsByAsin.get(asin) || null;
      const assessment = assessmentByAsin.get(asin) || null;

      // Pular se produto sem estoque
      if (!product || product.inventory_status === 'out_of_stock' || Number(product.fba_inventory ?? 0) <= 0) continue;
      if (!economicsAreActionable(economics, assessment)) {
        stats.blocked_without_economics++;
        continue;
      }

      const activeCampCount = camps.filter((c: any) => {
        const st = (c.state || c.status || '').toLowerCase();
        return st === 'enabled';
      }).length;

      const deficit = EVIDENCED_EXACT_SLOTS_PER_ASIN - activeCampCount;
      const activeTerms = activeTermsByAsin.get(asin) || new Set<string>();

      // Criar somente quando há conversão observada; sem evidência, não preencher cota.
      if (deficit <= 0) continue;

      // Search terms com ao menos um pedido atribuído; sugestões sem venda não entram.
      const termBankCandidates = allTermBank
        .filter((st: any) => st.asin === asin
          && !activeTerms.has(normTerm(st.search_term || st.keyword_text || ''))
          && (st.search_term || st.keyword_text || '').trim().length >= 3
          && numberValue(st.orders_14d ?? st.orders_30d, 0) >= 1
          && st.promoted_to_manual !== true
          && !['irrelevant', 'WASTING', 'IRRELEVANT'].includes(String(st.relevance_status || st.classification || ''))
        )
        .sort((a: any, b: any) => termBankScore(b) - termBankScore(a))
        .slice(0, deficit);

      const fillerTerms: { keyword: string; bid: number; source: string; evidence: any }[] = termBankCandidates
        .map((st: any) => ({
          keyword: (st.search_term || st.keyword_text || '').trim(),
          bid: calcEvidenceBid(perfSettings, economics, assessment, st),
          source: 'search_term_conversion',
          evidence: st,
        }))
        .filter((term: any) => term.bid != null)
        .map((term: any) => ({ ...term, bid: Number(term.bid) }));
      if (!fillerTerms.length) {
        stats.blocked_without_conversion_evidence++;
        continue;
      }

      // Deduplicar por normalized term
      const seenTerms = new Set<string>([...activeTerms]);
      const uniqueFillers: typeof fillerTerms = [];
      for (const t of fillerTerms) {
        const norm = normTerm(t.keyword);
        if (!seenTerms.has(norm)) {
          seenTerms.add(norm);
          uniqueFillers.push(t);
        }
      }

      // Budget proporcional: max(9.00, totalBudget / totalCamps)
      const sourceBudget = camps.reduce((sum: number, c: any) => sum + (c.daily_budget || 0), 0);
      const budgetPerCamp = sourceBudget > 0
        ? Math.max(MIN_BUDGET, sourceBudget / (activeCampCount + uniqueFillers.length))
        : MIN_BUDGET;

      // ── CRIAR UMA CAMPANHA INDIVIDUAL POR TERMO (nunca em lote) ──────────
      for (const t of uniqueFillers.slice(0, Math.min(deficit, MAX_CAMPAIGNS_PER_RUN - totalCreated))) {
        if (totalCreated >= MAX_CAMPAIGNS_PER_RUN) break;

        // HARD GUARD: verificar se keyword já existe antes de chamar Amazon
        const termNorm = normTerm(t.keyword);
        const currentTerms = activeTermsByAsin.get(asin) || new Set<string>();
        if (currentTerms.has(termNorm)) {
          stats.hard_guard_blocks++;
          continue; // CANONICAL_MANUAL_CAMPAIGN_VIOLATION — bloqueado
        }

        const createRes = await base44.asServiceRole.functions.invoke('createManualCampaignV2', {
          _service_role: true,
          amazon_account_id: aid,
          asin,
          keyword: t.keyword,
          bid: t.bid,
          budget: Math.max(MIN_BUDGET, Math.round(budgetPerCamp * 100) / 100),
        }).catch(() => null);

        const resData = createRes?.data || createRes || {};

        if (resData?.ok) {
          stats.campaigns_created++;
          stats.terms_from_termbank++;
          totalCreated++;
          // Atualizar índice local para evitar duplicatas no mesmo run
          if (!activeTermsByAsin.has(asin)) activeTermsByAsin.set(asin, new Set());
          activeTermsByAsin.get(asin)!.add(termNorm);
          const sourceRow = t.evidence;
          if (sourceRow?.id) {
            await base44.asServiceRole.entities.SearchTerm.update(sourceRow.id, {
              promoted_to_manual: true,
              promoted_at: new Date().toISOString(),
              decision_status: 'executed',
              last_action: 'promoted_to_manual_exact',
              last_action_at: new Date().toISOString(),
            }).catch(() => {});
          }
          await base44.asServiceRole.entities.OptimizationDecision.create({
            amazon_account_id: aid,
            decision_type: 'keyword_add',
            entity_type: 'campaign',
            asin,
            action: 'promote_converting_search_term_to_manual_exact',
            rationale: `Ação: promover “${t.keyword}” após pedido atribuído. Consequência esperada: isolar aprendizado com bid limitado ao CPC seguro; reavaliar em 14 dias.`,
            rule_key: 'EVIDENCED_SEARCH_TERM_PROMOTION',
            data_used: JSON.stringify({ orders_14d: sourceRow?.orders_14d, sales_14d: sourceRow?.sales_14d, spend: sourceRow?.spend, observed_cpc: sourceRow?.cpc, safe_cpc: assessment?.safe_max_cpc ?? economics?.safe_max_cpc }),
            current_cpc: numberValue(sourceRow?.cpc, 0),
            safe_cpc: numberValue(assessment?.safe_max_cpc ?? economics?.safe_max_cpc, 0),
            proposed_value: t.bid,
            next_review_days: 14,
            confidence: 85,
            risk: 'low',
            requires_approval: false,
            status: 'executed',
            source_function: 'enforceManualCampaignMinTerms',
            created_at: new Date().toISOString(),
          }).catch(() => {});
        } else if (resData?.already_exists || resData?.blocked_duplicate) {
          stats.hard_guard_blocks++;
          if (!activeTermsByAsin.has(asin)) activeTermsByAsin.set(asin, new Set());
          activeTermsByAsin.get(asin)!.add(termNorm);
        } else if (resData?.error) {
          stats.errors.push(`ASIN ${asin} | "${t.keyword}": ${resData.error}`);
        }

        await sleep(3000); // rate limit — espaçamento entre criações
      }
    }

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'enforce_manual_campaign_terms_v4_evidence_based',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      status: stats.errors.length > 0 ? 'warning' : 'success',
      started_at: new Date(startedAt).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      records_processed: stats.campaigns_created,
      result_summary: JSON.stringify({
        asins_checked: stats.asins_checked,
        campaigns_created: stats.campaigns_created,
        hard_guard_blocks: stats.hard_guard_blocks,
        terms_from_termbank: stats.terms_from_termbank,
        blocked_without_economics: stats.blocked_without_economics,
        blocked_without_conversion_evidence: stats.blocked_without_conversion_evidence,
        errors_count: stats.errors.length,
        rule: 'evidence_first_2_slots_max_no_suggestion_autofill',
      }),
      error_message: stats.errors.length > 0 ? stats.errors.slice(0, 3).join('; ') : null,
    }).catch(() => {});

    return Response.json({
      ok: true,
      duration_ms: Date.now() - startedAt,
      stats,
      rule: '1 campanha = 1 keyword EXACT; promoção somente com pedido observado e CPC seguro',
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message, duration_ms: Date.now() - Date.now() }, { status: 500 });
  }
});
