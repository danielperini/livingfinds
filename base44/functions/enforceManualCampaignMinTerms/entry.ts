/**
 * enforceManualCampaignMinTerms — v3 (CANONICAL)
 *
 * REGRA ABSOLUTA: 1 campanha manual = 1 ASIN = 1 keyword EXACT
 *
 * Cada termo faltante cria uma NOVA campanha individual via createManualCampaignV2.
 * NUNCA adiciona múltiplas keywords em uma campanha existente via POST /sp/keywords.
 *
 * Regras:
 * 1. Cada ASIN deve ter no mínimo 10 campanhas MANUAL EXACT ativas.
 * 2. Campanhas com 0 impressões após 72h → pausar a campanha inteira (não substituir keywords).
 * 3. Budget por nova campanha: max(9.00, sourceBudget / keywords_count), mínimo R$9,00.
 * 4. Bid padrão: R$0,50 — nunca herdar da campanha antiga multi-keyword.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

const MIN_TERMS_PER_ASIN = 10;
const ZERO_IMPRESSION_PAUSE_HOURS = 72;
const DEFAULT_BID = 0.50;
const MIN_BID = 0.35;
const MAX_BID = 3.00;
const MIN_BUDGET = 9.00;
const MAX_CAMPAIGNS_PER_RUN = 20; // limitar criações por execução

function hoursAgo(dateStr: string): number {
  if (!dateStr) return 0;
  return (Date.now() - new Date(dateStr).getTime()) / 3600000;
}

function calcBidFromGoals(settings: any, product: any): number {
  const targetAcos = settings?.target_acos || 0;
  const maxBid = settings?.max_bid || MAX_BID;
  const minBid = settings?.min_bid || MIN_BID;
  const price = product?.price || 0;
  if (targetAcos > 0 && price > 0) {
    const bid = price * (targetAcos / 100) * 0.10;
    return Math.min(maxBid, Math.max(minBid, Math.round(bid * 100) / 100));
  }
  return DEFAULT_BID;
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

/** Score de uma sugestão Amazon */
function suggestionScore(s: any): number {
  const conf = s.ai_confidence != null ? (s.ai_confidence <= 1 ? s.ai_confidence : s.ai_confidence / 100) : 0;
  return conf * 200
    + (s.amazon_relevance_score || 0) * 100
    + (s.amazon_suggested_bid || 0) * 20
    + (s.ai_rank ? Math.max(0, 20 - s.ai_rank) * 10 : 0);
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

    const now = new Date().toISOString();

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
      campaigns_paused: 0,
      terms_from_termbank: 0,
      terms_from_suggestions: 0,
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
      { amazon_account_id: aid }, null, 1
    ).then((r: any[]) => r[0] || null).catch(() => null);

    // Carregar produtos para calcular bid
    const allProducts = await base44.asServiceRole.entities.Product.filter(
      { amazon_account_id: aid }, null, 500
    ).catch(() => []);
    const productByAsin = new Map<string, any>(allProducts.map((p: any) => [p.asin, p]));

    // Carregar TermBank e Sugestões
    const allTermBank = await base44.asServiceRole.entities.SearchTerm.filter(
      { amazon_account_id: aid }, '-orders_14d', 2000
    );
    const allSuggestions = await base44.asServiceRole.entities.KeywordSuggestion.filter(
      { amazon_account_id: aid }, null, 2000
    );

    // Carregar keywords ativas do banco para deduplicação cross-ASIN
    const allKeywords = await base44.asServiceRole.entities.Keyword.filter(
      { amazon_account_id: aid }, null, 5000
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

    // Métricas recentes para identificar campanhas sem impressões
    const metricsRecent = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: aid }, '-date', 500
    ).catch(() => []);

    const cutoff3d = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const campaignMetricsMap = new Map<string, { impressions: number }>();
    for (const m of metricsRecent) {
      if (!m.date || m.date < cutoff3d) continue;
      const cid = m.campaign_id;
      if (!cid) continue;
      const ex = campaignMetricsMap.get(cid) || { impressions: 0 };
      ex.impressions += m.impressions || 0;
      campaignMetricsMap.set(cid, ex);
    }

    let totalCreated = 0;

    // ── 2. Por ASIN: verificar campanhas ativas e fazer enforcement ──────────
    for (const [asin, camps] of byAsin.entries()) {
      stats.asins_checked++;
      const product = productByAsin.get(asin) || null;

      // Pular se produto sem estoque
      if (!product || product.inventory_status === 'out_of_stock' || Number(product.fba_inventory ?? 0) <= 0) continue;

      const activeCampCount = camps.filter((c: any) => {
        const st = (c.state || c.status || '').toLowerCase();
        return st === 'enabled';
      }).length;

      const deficit = MIN_TERMS_PER_ASIN - activeCampCount;
      const activeTerms = activeTermsByAsin.get(asin) || new Set<string>();

      // ── 2a. HARD GUARD: pausar campanhas com >= 72h sem impressões ────────
      // (pausar a campanha inteira — não adicionar substitutos na mesma campanha)
      for (const camp of camps) {
        const st = (camp.state || camp.status || '').toLowerCase();
        if (st !== 'enabled') continue;

        const ageHours = hoursAgo(camp.created_at || camp.created_date || now);
        const cid = camp.campaign_id || camp.amazon_campaign_id;
        const metrics = campaignMetricsMap.get(cid) || { impressions: 0 };

        if (metrics.impressions === 0 && ageHours >= ZERO_IMPRESSION_PAUSE_HOURS) {
          // Pausar via createManualCampaignV2 chamando o pauseCampaign
          await base44.asServiceRole.functions.invoke('pauseCampaign', {
            amazon_account_id: aid,
            campaign_id: cid,
            reason: `enforceMinTerms: ${Math.round(ageHours)}h sem impressões (limite: ${ZERO_IMPRESSION_PAUSE_HOURS}h)`,
            _service_role: true,
          }).catch(() => {});

          await base44.asServiceRole.entities.Campaign.update(camp.id, {
            state: 'paused',
            status: 'paused',
          }).catch(() => {});

          await base44.asServiceRole.entities.OptimizationDecision.create({
            amazon_account_id: aid,
            decision_type: 'pause',
            entity_type: 'campaign',
            campaign_id: cid,
            asin,
            action: `Campanha pausada após ${Math.round(ageHours)}h sem impressões`,
            rationale: `CANONICAL: Campanha ${cid} sem impressões após ${Math.round(ageHours)}h. Regra: pausar campanha inteira, nunca adicionar keywords substitutos na mesma campanha.`,
            status: 'executed',
            risk: 'medium',
            requires_approval: false,
            confidence: 90,
            source_function: 'enforceManualCampaignMinTerms',
            executed_at: now,
            created_at: now,
          }).catch(() => {});

          stats.campaigns_paused++;
          await sleep(1000);
        }
      }

      // ── 2b. Criar novas campanhas para cobrir o déficit ───────────────────
      if (deficit <= 0) continue;

      // Coletar termos candidatos — TermBank primeiro, depois sugestões Amazon
      const termBankCandidates = allTermBank
        .filter((st: any) => st.asin === asin
          && !activeTerms.has(normTerm(st.search_term || st.keyword_text || ''))
          && (st.search_term || st.keyword_text || '').trim().length >= 3
        )
        .sort((a: any, b: any) => termBankScore(b) - termBankScore(a))
        .slice(0, deficit);

      let fillerTerms: { keyword: string; bid: number; source: string }[] = termBankCandidates.map((st: any) => ({
        keyword: (st.search_term || st.keyword_text || '').trim(),
        bid: calcBidFromGoals(perfSettings, product),
        source: 'termbank',
      }));

      if (fillerTerms.length < deficit) {
        const needed = deficit - fillerTerms.length;
        const usedTexts = new Set<string>([...activeTerms, ...fillerTerms.map(f => normTerm(f.keyword))]);
        const suggCandidates = allSuggestions
          .filter((s: any) => s.asin === asin
            && !['archived_by_policy', 'superseded', 'created'].includes(s.status || '')
            && !usedTexts.has(normTerm(s.keyword || ''))
            && (s.keyword || '').trim().length >= 3
          )
          .sort((a: any, b: any) => suggestionScore(b) - suggestionScore(a))
          .slice(0, needed);

        fillerTerms = fillerTerms.concat(suggCandidates.map((s: any) => ({
          keyword: (s.keyword || '').trim(),
          bid: calcBidFromGoals(perfSettings, product),
          source: 'suggestion',
        })));
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

        if (resData?.ok || resData?.already_exists || resData?.blocked_duplicate) {
          stats.campaigns_created++;
          if (t.source === 'termbank') stats.terms_from_termbank++;
          else stats.terms_from_suggestions++;
          totalCreated++;
          // Atualizar índice local para evitar duplicatas no mesmo run
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
      operation: 'enforce_manual_campaign_min_terms_v3',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      status: stats.errors.length > 0 ? 'warning' : 'success',
      started_at: new Date(startedAt).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      records_processed: stats.campaigns_created + stats.campaigns_paused,
      result_summary: JSON.stringify({
        asins_checked: stats.asins_checked,
        campaigns_created: stats.campaigns_created,
        campaigns_paused: stats.campaigns_paused,
        hard_guard_blocks: stats.hard_guard_blocks,
        terms_from_termbank: stats.terms_from_termbank,
        terms_from_suggestions: stats.terms_from_suggestions,
        errors_count: stats.errors.length,
        rule: '1_campaign_1_keyword_canonical',
      }),
      error_message: stats.errors.length > 0 ? stats.errors.slice(0, 3).join('; ') : null,
    }).catch(() => {});

    return Response.json({
      ok: true,
      duration_ms: Date.now() - startedAt,
      stats,
      rule: '1_campanha_1_keyword_EXACT — nunca POST /sp/keywords com múltiplos termos',
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message, duration_ms: Date.now() - Date.now() }, { status: 500 });
  }
});