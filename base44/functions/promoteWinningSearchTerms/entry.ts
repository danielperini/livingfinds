/**
 * promoteWinningSearchTerms — Motor determinístico AUTO → MANUAL EXACT → CROSS-ASIN
 *
 * Fluxo completo:
 *  1. Agregar Search Terms das campanhas AUTO (3d/7d/14d/30d)
 *  2. Detectar termos com >=2 vendas + rentabilidade aprovada
 *  3. Criar campanha SP|MANUAL|EXACT|ASIN|term no ASIN original
 *  4. Negativar EXACT na AUTO do mesmo ASIN (somente após confirmar manual criada)
 *  5. Buscar outros ASINs com relevância >=90% → criar campanhas de expansão (testing_72h)
 *  6. Atualizar TermBank
 *
 * Reutiliza:
 *  - negateKeywordInAutoCampaign (negativação)
 *  - amazonAdsCommand (chamadas à API)
 *  - SearchTermPromotion (registro de promoções)
 *  - CrossAsinTransfer (registro de expansões)
 *  - TermBank / KeywordBank (banco de termos)
 *  - runCrossAsinTransfer (score de relevância entre ASINs — invocado para zona cinzenta)
 *
 * Critérios determinísticos (sem IA para decisão de venda):
 *  - WINNER_STRONG: orders>=2, sales>0, ACoS<=15%
 *  - WINNER_PROFITABLE: orders>=2, sales>0, ACoS<=sustainable_acos
 *  - Expansão: relevância>=90% (heurística + LLM para zona cinzenta 70-95%)
 *  - Evidência mínima antes de pausa: nunca pausar por falta de dados
 *
 * Não cria motor paralelo. Integrado via runDailyMasterOrchestrator.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ── Configurações (sobrescritas por AutopilotConfig / PerformanceSettings) ──
const CFG = {
  MINIMUM_ORDERS_TO_PROMOTE: 2,
  TARGET_ACOS: 15,                    // meta operacional padrão
  MIN_CROSS_ASIN_RELEVANCE: 90,       // mínimo para expansão automática
  PREFERRED_CROSS_ASIN_RELEVANCE: 95, // preferência para alta confiança
  TEST_WINDOW_HOURS: 72,              // janela de teste cross-ASIN
  MAX_BID_CHANGE_PCT: 0.20,           // máximo +20% por ciclo
  INITIAL_BID_DEFAULT: 0.50,
  DAILY_BUDGET_DEFAULT: 5.00,
  MIN_BID: 0.25,
  MAX_BID: 3.00,
  ATTRIBUTION_SAFETY_HOURS: 72,       // excluir dados das últimas 72h (atribuição)
  HEURISTIC_HIGH_CONF: 95,            // acima → transfere sem LLM
  HEURISTIC_LOW_CONF: 70,             // abaixo → bloqueia sem LLM
  MAX_EXPANSIONS_PER_RUN: 10,         // rate limiting
};

// ── Normalização ──────────────────────────────────────────────────────────────
function normalizeTerm(t: string): string {
  return String(t || '').toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function campaignName(asin: string, term: string): string {
  const t = term.replace(/[|]/g, '-').slice(0, 55);
  return `SP | MANUAL | EXACT | ${asin} | ${t}`.slice(0, 128);
}

function adGroupName(asin: string): string {
  return `AG | EXACT | ${asin}`;
}

// ── Heurística de relevância entre ASINs (0-100) ─────────────────────────────
function tokenize(s: string): Set<string> {
  const stop = new Set(['de','da','do','para','com','sem','uma','um','os','as','o','a','e','em','no','na','por','que']);
  return new Set(normalizeTerm(s).split(' ').filter(t => t.length >= 2 && !stop.has(t)));
}

function calcHeuristic(kwText: string, srcTitle: string, srcBullets: string, srcCat: string,
                       dstTitle: string, dstBullets: string, dstCat: string): number {
  const kwT = tokenize(kwText);
  const srcT = tokenize(srcTitle + ' ' + srcBullets + ' ' + srcCat);
  const dstT = tokenize(dstTitle + ' ' + dstBullets + ' ' + dstCat);

  if (kwT.size === 0 || dstT.size === 0) return 0;

  const catSrcT = tokenize(srcCat), catDstT = tokenize(dstCat);
  const catOverlap = catSrcT.size > 0
    ? [...catSrcT].filter(t => catDstT.has(t)).length / Math.max(catSrcT.size, 1)
    : 0;
  const cat35 = Math.round(catOverlap * 35);

  let kwInDst = 0;
  for (const t of kwT) { if (dstT.has(t)) kwInDst++; }
  const use20 = Math.round((kwInDst / Math.max(kwT.size, 1)) * 20);

  const attrOverlap = [...srcT].filter(t => dstT.has(t)).length;
  const attr15 = Math.min(15, Math.round((attrOverlap / Math.max(srcT.size, 1)) * 20));

  const cat10 = catSrcT.size > 0 && catDstT.size > 0 &&
    normalizeTerm(srcCat) === normalizeTerm(dstCat) ? 10 : catOverlap >= 0.6 ? 6 : 0;

  const highRel = ['automatica','automatico','sensor','eletrico','inox','recarregavel'];
  const srcH = new Set(highRel.filter(t => srcT.has(t)));
  const dstH = new Set(highRel.filter(t => dstT.has(t)));
  const compat10 = srcH.size > 0 ? Math.round(([...srcH].filter(t => dstH.has(t)).length / srcH.size) * 10) : 5;

  const titleSrcT = tokenize(srcTitle), titleDstT = tokenize(dstTitle);
  const sem10 = Math.min(10, Math.round(([...titleSrcT].filter(t => titleDstT.has(t)).length / Math.max(titleSrcT.size, 1)) * 15));

  return Math.min(100, Math.max(0, cat35 + use20 + attr15 + cat10 + compat10 + sem10));
}

// ── Hard Blocker heurístico ───────────────────────────────────────────────────
function hasHardBlocker(kwText: string, srcFull: string, dstFull: string): { blocked: boolean; reason: string } {
  const kw = normalizeTerm(kwText);
  const src = normalizeTerm(srcFull);
  const dst = normalizeTerm(dstFull);

  const voltages = ['110v','220v','bivolt'];
  const sv = voltages.find(v => src.includes(v)), dv = voltages.find(v => dst.includes(v));
  if (sv && dv && sv !== dv && sv !== 'bivolt' && dv !== 'bivolt')
    return { blocked: true, reason: `Voltagem incompatível: ${sv} vs ${dv}` };

  const masc = ['masculino','men','homem'], fem = ['feminino','women','mulher'];
  if ((masc.some(t => src.includes(t)) && fem.some(t => dst.includes(t))) ||
      (fem.some(t => src.includes(t)) && masc.some(t => dst.includes(t))))
    return { blocked: true, reason: 'Gênero incompatível' };

  return { blocked: false, reason: '' };
}

// ── LLM para zona cinzenta (70-95) ────────────────────────────────────────────
async function llmRelevance(kwText: string, srcTitle: string, srcBullets: string,
                            dstTitle: string, dstBullets: string, hScore: number): Promise<number> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return hScore;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: Deno.env.get('AI_WEEKLY_REVIEW_MODEL') || 'claude-3-5-haiku-20241022',
        max_tokens: 256,
        messages: [{ role: 'user', content:
          `Relevância da keyword "${kwText}" para o produto DESTINO (Amazon Ads EXACT).\n` +
          `ORIGEM: ${srcTitle}\nBullets: ${srcBullets.slice(0,300)}\n` +
          `DESTINO: ${dstTitle}\nBullets: ${dstBullets.slice(0,300)}\n` +
          `Responda apenas: {"score": 0-100, "hard_blocker": true/false, "reason": "1 frase"}`
        }],
      }),
    });
    if (!res.ok) return hScore;
    const data = await res.json();
    const text = data?.content?.[0]?.text || '{}';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return hScore;
    const parsed = JSON.parse(m[0]);
    if (parsed.hard_blocker) return 0;
    return Number(parsed.score || hScore);
  } catch { return hScore; }
}

// ── amazonAdsCommand wrapper ──────────────────────────────────────────────────
async function adsCmd(base44: any, accountId: string, method: string, path: string, payload: any,
                      contentType?: string): Promise<{ ok: boolean; payload: any; status: number }> {
  const res = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
    amazon_account_id: accountId,
    _service_role: true,
    method,
    path,
    payload,
    ...(contentType ? { content_type: contentType, accept: contentType } : {}),
  });
  const d = res?.data || res || {};
  return { ok: d.ok === true || (d.status >= 200 && d.status < 300), payload: d.payload || d, status: d.status || 0 };
}

function firstId(payload: any, group: string, field: string): string | null {
  const p = payload || {};
  return p?.[group]?.success?.[0]?.[field]
    || p?.success?.[0]?.[field]
    || p?.[group]?.[0]?.[field]
    || null;
}

// ── HANDLER ──────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const t0 = Date.now();
  const now = new Date().toISOString();
  const today = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10); // BRT

  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const dry_run: boolean = body.dry_run === true;
    const force_asin: string | null = body.asin_filter || null; // filtro opcional

    // ── Resolver conta ─────────────────────────────────────────────────────
    let account: any = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
      account = accs[0];
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta conectada' });
    const aid = account.id;

    // ── Carregar configurações ────────────────────────────────────────────
    const [perfList, apList] = await Promise.all([
      base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, null, 1).catch(() => []),
      base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }, null, 1).catch(() => []),
    ]);
    const perf = perfList[0] || {}, ap = apList[0] || {};
    const TARGET_ACOS   = Number(perf.target_acos || ap.target_acos || CFG.TARGET_ACOS);
    const MIN_BID       = Number(perf.min_bid || ap.min_bid || CFG.MIN_BID);
    const MAX_BID       = Number(perf.max_bid || ap.max_bid || CFG.MAX_BID);
    const DAILY_BUDGET  = Number(perf.minimum_campaign_budget || ap.minimum_campaign_budget || CFG.DAILY_BUDGET_DEFAULT);
    const MIN_ORDERS    = CFG.MINIMUM_ORDERS_TO_PROMOTE;
    // SAFE_CUTOFF: excluir dados das últimas 72h (janela de atribuição Amazon).
    // Fallback: se não houver dados recentes suficientes, ampliar para 30d (dados históricos válidos).
    const safetyMs = CFG.ATTRIBUTION_SAFETY_HOURS * 3600000;
    const SAFE_CUTOFF   = new Date(Date.now() - safetyMs).toISOString().slice(0, 10);

    // ── Carregar dados base em paralelo ──────────────────────────────────
    const [searchTerms, products, existingKeywords, existingPromos, snapshots, economics] = await Promise.all([
      base44.asServiceRole.entities.SearchTerm.filter(
        { amazon_account_id: aid }, '-orders_14d', 5000
      ).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 500).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid, match_type: 'exact' }, null, 3000).catch(() => []),
      base44.asServiceRole.entities.SearchTermPromotion.filter({ amazon_account_id: aid }, '-created_at', 2000).catch(() => []),
      base44.asServiceRole.entities.ListingSnapshot.filter({ amazon_account_id: aid }, null, 500).catch(() => []),
      base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: aid }, null, 500).catch(() => []),
    ]);

    const productMap = new Map(products.map((p: any) => [p.asin, p]));
    const snapshotMap = new Map(snapshots.map((s: any) => [s.asin, s]));
    const econMap = new Map(economics.map((e: any) => [e.asin, e]));

    // Índice: ASIN|term → keyword exata já existe
    const exactKeyIndex = new Set(
      existingKeywords
        .filter((k: any) => !['archived'].includes(k.state || k.status || ''))
        .map((k: any) => `${k.asin}|${normalizeTerm(k.keyword_text || k.keyword || '')}`)
    );
    // Índice: ASIN|term → promoção já existe
    const promoIndex = new Set(
      existingPromos
        .filter((p: any) => !['failed', 'blocked_duplicate'].includes(p.promotion_status || p.status || ''))
        .map((p: any) => `${p.asin}|${normalizeTerm(p.normalized_search_term || p.source_search_term || '')}`)
    );

    // ── FASE 1: Agregar Search Terms ──────────────────────────────────────
    // Janela: dados anteriores à janela de atribuição de 72h
    const termMap = new Map<string, any>();

    for (const st of searchTerms) {
      if (!st.advertised_asin || !st.search_term) continue;
      // Excluir apenas dados MUITO recentes (atribuição incompleta).
      // Se date >= SAFE_CUTOFF → dentro dos últimos 72h → ignorar.
      // Se date for null ou muito antigo → incluir (dados estáveis).
      if (st.date && st.date >= SAFE_CUTOFF) continue;
      if (force_asin && st.advertised_asin !== force_asin) continue;

      const norm = normalizeTerm(st.search_term);
      if (!norm || norm.length < 2) continue;

      const key = `${st.advertised_asin}|${norm}`;
      if (!termMap.has(key)) {
        termMap.set(key, {
          asin: st.advertised_asin,
          search_term: st.search_term, // texto original preservado
          normalized_term: norm,
          campaign_id: st.campaign_id,
          ad_group_id: st.ad_group_id,
          orders: 0, sales: 0, spend: 0, clicks: 0, impressions: 0,
          orders_3d: 0, sales_3d: 0, spend_3d: 0,
          last_sale_at: null,
        });
      }
      const agg = termMap.get(key)!;
      // Agregar janelas disponíveis
      agg.orders += st.orders_14d || st.orders_7d || st.orders_30d || 0;
      agg.sales  += st.sales_14d  || st.sales_7d  || st.sales_30d  || 0;
      agg.spend  += st.spend || 0;
      agg.clicks += st.clicks || 0;
      agg.impressions += st.impressions || 0;
      agg.orders_3d += st.orders_7d || 0; // proxy para 3d quando não disponível
      agg.sales_3d  += st.sales_7d  || 0;
      agg.spend_3d  += st.spend || 0;

      // last_sale_at
      if (st.last_sale_at && (!agg.last_sale_at || st.last_sale_at > agg.last_sale_at))
        agg.last_sale_at = st.last_sale_at;
    }

    // ── FASE 2: Detectar termos vencedores ──────────────────────────────
    const winners: any[] = [];
    const rejected: any[] = [];

    for (const [key, agg] of termMap.entries()) {
      // Guardrail: zero vendas → ACoS = null (nunca interpretar 0 como bom)
      if (agg.orders < MIN_ORDERS || agg.sales <= 0) {
        rejected.push({ ...agg, reject_reason: `orders=${agg.orders} < ${MIN_ORDERS} ou sales=0` });
        continue;
      }

      const acos = agg.spend > 0 && agg.sales > 0 ? (agg.spend / agg.sales) * 100 : null;
      const roas = agg.spend > 0 && agg.sales > 0 ? agg.sales / agg.spend : null;

      // ACoS sustentável do produto
      const econ = econMap.get(agg.asin);
      const sustainableAcos = econ?.break_even_acos_percent || econ?.contribution_margin_percent || TARGET_ACOS * 1.5;

      // WINNER_STRONG: ACoS <= target
      // WINNER_PROFITABLE: ACoS <= sustainable (mas acima do target)
      let winnerTier: string | null = null;
      if (acos !== null && acos <= TARGET_ACOS) {
        winnerTier = 'WINNER_STRONG';
      } else if (acos !== null && acos <= sustainableAcos && sustainableAcos > TARGET_ACOS) {
        winnerTier = 'WINNER_PROFITABLE';
      } else if (acos === null) {
        rejected.push({ ...agg, reject_reason: 'ACoS não calculável (spend=0 ou sales=0)', acos });
        continue;
      } else {
        rejected.push({ ...agg, reject_reason: `ACoS=${acos?.toFixed(1)}% acima do sustentável (${sustainableAcos?.toFixed(1)}%)`, acos });
        continue;
      }

      // Verificar produto
      const product = productMap.get(agg.asin);
      if (!product) { rejected.push({ ...agg, reject_reason: 'Produto não encontrado' }); continue; }
      if (product.inventory_status === 'out_of_stock' || Number(product.fba_inventory || 0) <= 0) {
        rejected.push({ ...agg, reject_reason: 'Sem estoque' }); continue;
      }

      // Verificar duplicidade: não criar se já existe keyword exata ou promoção ativa
      const dupKey = `${agg.asin}|${agg.normalized_term}`;
      if (exactKeyIndex.has(dupKey)) {
        rejected.push({ ...agg, reject_reason: 'Keyword exata já existe para este ASIN', duplicate: true }); continue;
      }
      if (promoIndex.has(dupKey)) {
        rejected.push({ ...agg, reject_reason: 'Promoção já existe para este ASIN', duplicate: true }); continue;
      }

      winners.push({ ...agg, acos, roas, winner_tier: winnerTier, sustainable_acos: sustainableAcos });
    }

    // ── FASE 3: Criar campanhas manuais EXACT no ASIN original ───────────
    const createdOriginal: any[] = [];
    const crossAsinExpansions: any[] = [];
    const negationsApplied: any[] = [];
    const errors: any[] = [];
    let expansionsCount = 0;

    for (const winner of winners) {
      if (dry_run) {
        createdOriginal.push({ ...winner, dry_run: true, campaign_name: campaignName(winner.asin, winner.search_term) });
        continue;
      }

      // Calcular bid inicial
      const avgCpc = winner.clicks > 0 ? winner.spend / winner.clicks : 0;
      const sustainableCpc = (() => {
        const econ = econMap.get(winner.asin);
        const price = Number(econ?.current_price || productMap.get(winner.asin)?.price || 0);
        const cvr = winner.clicks > 0 ? winner.orders / winner.clicks : 0.05;
        if (price > 0 && cvr > 0) return price * cvr * (TARGET_ACOS / 100);
        return 0;
      })();
      let initialBid = avgCpc > 0
        ? Math.min(avgCpc * 1.05, sustainableCpc > 0 ? sustainableCpc : MAX_BID)
        : CFG.INITIAL_BID_DEFAULT;
      initialBid = Math.round(Math.max(MIN_BID, Math.min(MAX_BID, initialBid)) * 100) / 100;

      const campName = campaignName(winner.asin, winner.search_term);
      const agName = adGroupName(winner.asin);

      try {
        // STEP 1: Campanha
        const campR = await adsCmd(base44, aid, 'POST', '/sp/campaigns', {
          campaigns: [{
            name: campName,
            targetingType: 'MANUAL',
            state: 'ENABLED',
            startDate: today.replace(/-/g, ''),
            dailyBudget: DAILY_BUDGET,
            budgetType: 'DAILY',
          }]
        });
        const campaignId = firstId(campR.payload, 'campaigns', 'campaignId');
        if (!campaignId) throw new Error(`Campanha não criada: ${JSON.stringify(campR.payload).slice(0,200)}`);

        await new Promise(r => setTimeout(r, 2000));

        // STEP 2: Ad Group (defaultBid = initialBid — paridade com keyword)
        const agR = await adsCmd(base44, aid, 'POST', '/sp/adGroups', {
          adGroups: [{ name: agName, campaignId, defaultBid: initialBid, state: 'ENABLED' }]
        }, 'application/vnd.spAdGroup.v3+json');
        const adGroupId = firstId(agR.payload, 'adGroups', 'adGroupId');
        if (!adGroupId) throw new Error(`Ad Group não criado: ${JSON.stringify(agR.payload).slice(0,200)}`);

        await new Promise(r => setTimeout(r, 2000));

        // STEP 3: Product Ad
        const product = productMap.get(winner.asin);
        const paPayload: any = { campaignId, adGroupId, state: 'ENABLED' };
        if (product?.sku) paPayload.sku = product.sku; else paPayload.asin = winner.asin;
        await adsCmd(base44, aid, 'POST', '/sp/productAds', {
          productAds: [paPayload]
        }, 'application/vnd.spProductAd.v3+json');

        await new Promise(r => setTimeout(r, 2000));

        // STEP 4: Keyword EXACT (bid = initialBid para paridade com adGroup)
        const kwR = await adsCmd(base44, aid, 'POST', '/sp/keywords', {
          keywords: [{
            campaignId,
            adGroupId,
            keywordText: winner.search_term, // texto original preservado
            matchType: 'EXACT',
            bid: initialBid,
            state: 'ENABLED',
          }]
        }, 'application/vnd.spKeyword.v3+json');
        const keywordId = firstId(kwR.payload, 'keywords', 'keywordId');

        // STEP 5: Registrar no banco
        const promo = await base44.asServiceRole.entities.SearchTermPromotion.create({
          amazon_account_id: aid,
          asin: winner.asin,
          sku: product?.sku || '',
          source_campaign_id: winner.campaign_id,
          source_ad_group_id: winner.ad_group_id,
          source_search_term: winner.search_term,
          normalized_search_term: winner.normalized_term,
          orders: winner.orders,
          sales: winner.sales,
          spend: winner.spend,
          clicks: winner.clicks,
          average_cpc: Math.round((winner.clicks > 0 ? winner.spend / winner.clicks : 0) * 100) / 100,
          acos: winner.acos,
          roas: winner.roas,
          target_bid: initialBid,
          winner_tier: winner.winner_tier,
          promotion_type: 'ORIGINAL_WINNER',
          promotion_status: keywordId ? 'completed' : 'partial',
          destination_campaign_id: campaignId,
          destination_campaign_name: campName,
          destination_ad_group_id: adGroupId,
          destination_keyword_id: keywordId || null,
          idempotency_key: `${aid}|${winner.asin}|${winner.normalized_term}|EXACT|${today}`,
          protected_by_winner_term: true,
          completed_at: now,
          created_at: now,
          updated_at: now,
        }).catch(() => null);

        // Registrar no banco de campanhas locais
        await base44.asServiceRole.entities.Campaign.create({
          amazon_account_id: aid,
          campaign_id: campaignId,
          amazon_campaign_id: campaignId,
          name: campName,
          campaign_name: campName,
          asin: winner.asin,
          targeting_type: 'MANUAL',
          campaign_type: 'SP',
          state: 'enabled',
          status: 'enabled',
          daily_budget: DAILY_BUDGET,
          created_by_app: true,
          launch_phase: 'new',
          is_operational: true,
          created_at: now,
          last_sync_at: now,
          synced_at: now,
        }).catch(() => {});

        // Registrar keyword no banco local
        await base44.asServiceRole.entities.Keyword.create({
          amazon_account_id: aid,
          campaign_id: campaignId,
          ad_group_id: adGroupId,
          keyword_id: keywordId || `local_${Date.now()}`,
          asin: winner.asin,
          keyword: winner.search_term,
          keyword_text: winner.search_term,
          match_type: 'exact',
          bid: initialBid,
          current_bid: initialBid,
          state: 'enabled',
          status: 'enabled',
          source: 'search_term',
          first_seen_at: now,
          last_seen_at: now,
          synced_at: now,
        }).catch(() => {});

        // Atualizar índices locais para evitar dedup na mesma run
        exactKeyIndex.add(`${winner.asin}|${winner.normalized_term}`);
        promoIndex.add(`${winner.asin}|${winner.normalized_term}`);

        // Atualizar SearchTerm como promovido
        if (winner.id) {
          await base44.asServiceRole.entities.SearchTerm.update(winner.id, {
            promoted_to_manual: true, promoted_at: now,
          }).catch(() => {});
        }

        // Atualizar / criar no TermBank
        const termBankItems = await base44.asServiceRole.entities.TermBank.filter({
          amazon_account_id: aid,
          asin: winner.asin,
        }, null, 500).catch(() => []);
        const existingTB = termBankItems.find((t: any) =>
          normalizeTerm(t.term || t.keyword || '') === winner.normalized_term
        );
        if (existingTB) {
          await base44.asServiceRole.entities.TermBank.update(existingTB.id, {
            orders: Math.max(existingTB.orders || 0, winner.orders),
            sales: Math.max(existingTB.sales || 0, winner.sales),
            acos: winner.acos,
            roas: winner.roas,
            is_winner: true,
            winner_tier: winner.winner_tier,
            promoted_to_manual: true,
            promoted_at: now,
            last_win_at: now,
          }).catch(() => {});
        } else {
          await base44.asServiceRole.entities.TermBank.create({
            amazon_account_id: aid,
            asin: winner.asin,
            term: winner.search_term,
            keyword: winner.search_term,
            normalized_term: winner.normalized_term,
            source_type: 'AUTO_SEARCH_TERM',
            orders: winner.orders,
            sales: winner.sales,
            spend: winner.spend,
            acos: winner.acos,
            roas: winner.roas,
            is_winner: true,
            winner_tier: winner.winner_tier,
            promoted_to_manual: true,
            first_win_at: now,
            last_win_at: now,
            status: 'active',
            created_at: now,
          }).catch(() => {});
        }

        createdOriginal.push({
          asin: winner.asin,
          term: winner.search_term,
          winner_tier: winner.winner_tier,
          campaign_id: campaignId,
          ad_group_id: adGroupId,
          keyword_id: keywordId,
          bid: initialBid,
          orders: winner.orders,
          acos: winner.acos,
          campaign_name: campName,
        });

        // STEP 6: Negativar EXACT na AUTO SOMENTE se campanha manual confirmada
        if (keywordId) {
          await new Promise(r => setTimeout(r, 1500));
          const negRes = await base44.asServiceRole.functions.invoke('negateKeywordInAutoCampaign', {
            amazon_account_id: aid,
            asin: winner.asin,
            keyword_text: winner.search_term,
            manual_campaign_id: campaignId,
            triggered_by: 'promoteWinningSearchTerms',
            _service_role: true,
          }).catch((e: any) => ({ data: { ok: false, error: e.message } }));
          const negData = negRes?.data || {};
          negationsApplied.push({
            asin: winner.asin, term: winner.search_term,
            ok: negData.ok, skipped: negData.skipped,
          });
        }

      } catch (err: any) {
        errors.push({ asin: winner.asin, term: winner.search_term, error: err.message?.slice(0, 200) });
        console.error('[promoteWinningSearchTerms] Original winner error:', err.message);
      }
    }

    // ── FASE 4: Expansão Cross-ASIN ──────────────────────────────────────
    // Para cada winner: calcular relevância para outros ASINs ativos com estoque
    const activeProducts = products.filter((p: any) =>
      p.status === 'active' && Number(p.fba_inventory || 0) > 0
    );

    for (const winner of winners) {
      if (expansionsCount >= CFG.MAX_EXPANSIONS_PER_RUN) break;

      const srcSnap = snapshotMap.get(winner.asin);
      if (!srcSnap) continue;

      const srcTitle   = srcSnap.title || '';
      const srcBullets = (() => { try { return JSON.parse(srcSnap.bullets || '[]').join(' '); } catch { return srcSnap.bullets || ''; } })();
      const srcCat     = srcSnap.product_type || '';
      const srcFull    = srcTitle + ' ' + srcBullets;

      for (const destProd of activeProducts) {
        if (destProd.asin === winner.asin) continue;
        if (expansionsCount >= CFG.MAX_EXPANSIONS_PER_RUN) break;

        const destKey = `${destProd.asin}|${winner.normalized_term}`;
        if (exactKeyIndex.has(destKey) || promoIndex.has(destKey)) continue;

        const destSnap = snapshotMap.get(destProd.asin);
        if (!destSnap) continue;

        const destTitle   = destSnap.title || '';
        const destBullets = (() => { try { return JSON.parse(destSnap.bullets || '[]').join(' '); } catch { return destSnap.bullets || ''; } })();
        const destCat     = destSnap.product_type || '';
        const destFull    = destTitle + ' ' + destBullets;

        // Hard Blocker heurístico
        const blocker = hasHardBlocker(winner.search_term, srcFull, destFull);
        if (blocker.blocked) continue;

        // Score heurístico
        let score = calcHeuristic(winner.search_term, srcTitle, srcBullets, srcCat, destTitle, destBullets, destCat);
        if (score < CFG.HEURISTIC_LOW_CONF) continue;

        // Zona cinzenta: validar com LLM
        if (score < CFG.HEURISTIC_HIGH_CONF) {
          score = await llmRelevance(winner.search_term, srcTitle, srcBullets, destTitle, destBullets, score);
          score = Math.round((calcHeuristic(winner.search_term, srcTitle, srcBullets, srcCat, destTitle, destBullets, destCat) * 0.4 + score * 0.6));
        }

        if (score < CFG.MIN_CROSS_ASIN_RELEVANCE) continue;

        // Calcular bid para destino
        const destEcon = econMap.get(destProd.asin);
        const destAov  = Number(destEcon?.current_price || destProd.price || 0);
        const destTargetAcos = Number(destEcon?.target_acos || TARGET_ACOS);
        const destCvr  = winner.clicks > 0 ? winner.orders / winner.clicks : 0.05;
        const destSusCpc = destAov > 0 ? destAov * destCvr * (destTargetAcos / 100) : 0;
        const srcCpc = winner.clicks > 0 ? winner.spend / winner.clicks : CFG.INITIAL_BID_DEFAULT;
        let destBid = destSusCpc > 0 ? Math.min(srcCpc * 0.85, destSusCpc * 0.85) : srcCpc * 0.80;
        destBid = Math.round(Math.max(MIN_BID, Math.min(MAX_BID, destBid)) * 100) / 100;

        const destCampName = campaignName(destProd.asin, winner.search_term);
        const testEndsAt = new Date(Date.now() + CFG.TEST_WINDOW_HOURS * 3600000).toISOString();

        if (dry_run) {
          crossAsinExpansions.push({
            source_asin: winner.asin, destination_asin: destProd.asin,
            term: winner.search_term, relevance_score: score,
            bid: destBid, campaign_name: destCampName, dry_run: true,
          });
          expansionsCount++;
          continue;
        }

        try {
          // Criar campanha de expansão
          const campR = await adsCmd(base44, aid, 'POST', '/sp/campaigns', {
            campaigns: [{
              name: destCampName,
              targetingType: 'MANUAL',
              state: 'ENABLED',
              startDate: today.replace(/-/g, ''),
              dailyBudget: DAILY_BUDGET,
              budgetType: 'DAILY',
            }]
          });
          const destCampaignId = firstId(campR.payload, 'campaigns', 'campaignId');
          if (!destCampaignId) throw new Error(`Campanha cross-ASIN não criada`);

          await new Promise(r => setTimeout(r, 2000));

          const agR = await adsCmd(base44, aid, 'POST', '/sp/adGroups', {
            adGroups: [{ name: adGroupName(destProd.asin), campaignId: destCampaignId, defaultBid: destBid, state: 'ENABLED' }]
          }, 'application/vnd.spAdGroup.v3+json');
          const destAdGroupId = firstId(agR.payload, 'adGroups', 'adGroupId');

          await new Promise(r => setTimeout(r, 2000));

          const paP: any = { campaignId: destCampaignId, adGroupId: destAdGroupId, state: 'ENABLED' };
          if (destProd.sku) paP.sku = destProd.sku; else paP.asin = destProd.asin;
          await adsCmd(base44, aid, 'POST', '/sp/productAds', { productAds: [paP] }, 'application/vnd.spProductAd.v3+json');

          await new Promise(r => setTimeout(r, 2000));

          const kwR = await adsCmd(base44, aid, 'POST', '/sp/keywords', {
            keywords: [{
              campaignId: destCampaignId,
              adGroupId: destAdGroupId,
              keywordText: winner.search_term,
              matchType: 'EXACT',
              bid: destBid,
              state: 'ENABLED',
            }]
          }, 'application/vnd.spKeyword.v3+json');
          const destKeywordId = firstId(kwR.payload, 'keywords', 'keywordId');

          // Registrar promoção de expansão
          await base44.asServiceRole.entities.SearchTermPromotion.create({
            amazon_account_id: aid,
            asin: destProd.asin,
            source_campaign_id: winner.campaign_id,
            source_search_term: winner.search_term,
            normalized_search_term: winner.normalized_term,
            orders: 0, // expansão sem evidência de venda no destino
            sales: 0,
            spend: 0,
            clicks: 0,
            target_bid: destBid,
            winner_tier: 'CROSS_ASIN_EXPANSION',
            promotion_type: 'CROSS_ASIN_EXPANSION',
            promotion_status: destKeywordId ? 'testing' : 'partial',
            destination_campaign_id: destCampaignId,
            destination_campaign_name: destCampName,
            destination_ad_group_id: destAdGroupId || null,
            destination_keyword_id: destKeywordId || null,
            relevance_score: score,
            source_asin: winner.asin,
            source_orders: winner.orders,
            source_acos: winner.acos,
            source_roas: winner.roas,
            test_started_at: now,
            test_ends_at: testEndsAt,
            next_review_at: testEndsAt,
            idempotency_key: `${aid}|${destProd.asin}|${winner.normalized_term}|EXACT_CROSS|${today}`,
            created_at: now,
            updated_at: now,
          }).catch(() => {});

          // Registrar CrossAsinTransfer
          await base44.asServiceRole.entities.CrossAsinTransfer.create({
            amazon_account_id: aid,
            marketplace: 'BR',
            keyword: winner.search_term,
            normalized_keyword: winner.normalized_term,
            match_type: 'exact',
            source_asin: winner.asin,
            source_orders: winner.orders,
            source_acos: winner.acos,
            source_roas: winner.roas,
            source_cvr: winner.clicks > 0 ? winner.orders / winner.clicks : 0,
            source_winner_tier: winner.winner_tier,
            destination_asin: destProd.asin,
            destination_product_name: destProd.product_name || destProd.display_name || '',
            destination_sku: destProd.sku || '',
            destination_fba_inventory: Number(destProd.fba_inventory || 0),
            relevance_score: score,
            relevance_phase: score >= CFG.HEURISTIC_HIGH_CONF ? 'HEURISTIC_ONLY' : 'LLM_VALIDATED',
            transfer_decision: 'HIGH_CONFIDENCE_TRANSFER',
            rule_id: 'CROSS_ASIN_TERM_EXPANSION',
            initial_bid: destBid,
            campaign_job: 'VALIDATION',
            status: 'EXECUTING',
            created_campaign_id: destCampaignId,
            created_campaign_name: destCampName,
            proposed_at: now,
            executed_at: now,
            cycle_date: today,
            created_at: now,
          }).catch(() => {});

          // Registrar campanha localmente
          await base44.asServiceRole.entities.Campaign.create({
            amazon_account_id: aid,
            campaign_id: destCampaignId,
            amazon_campaign_id: destCampaignId,
            name: destCampName,
            campaign_name: destCampName,
            asin: destProd.asin,
            targeting_type: 'MANUAL',
            campaign_type: 'SP',
            state: 'enabled', status: 'enabled',
            daily_budget: DAILY_BUDGET,
            created_by_app: true,
            launch_phase: 'testing_72h',
            is_operational: true,
            created_at: now, last_sync_at: now, synced_at: now,
          }).catch(() => {});

          // Negativar na AUTO do ASIN de destino se keyword confirmada
          if (destKeywordId) {
            await new Promise(r => setTimeout(r, 1500));
            await base44.asServiceRole.functions.invoke('negateKeywordInAutoCampaign', {
              amazon_account_id: aid,
              asin: destProd.asin,
              keyword_text: winner.search_term,
              manual_campaign_id: destCampaignId,
              triggered_by: 'promoteWinningSearchTerms_crossAsin',
              _service_role: true,
            }).catch(() => {});
          }

          // Atualizar índices para evitar duplicação intra-run
          exactKeyIndex.add(destKey);
          promoIndex.add(destKey);

          crossAsinExpansions.push({
            source_asin: winner.asin, destination_asin: destProd.asin,
            term: winner.search_term, relevance_score: score,
            campaign_id: destCampaignId, bid: destBid,
            keyword_id: destKeywordId, campaign_name: destCampName,
            test_ends_at: testEndsAt,
          });
          expansionsCount++;

        } catch (err: any) {
          errors.push({ source_asin: winner.asin, dest_asin: destProd.asin, term: winner.search_term, error: err.message?.slice(0, 200) });
        }
      }
    }

    // ── Log de execução ───────────────────────────────────────────────────
    if (!dry_run) {
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: aid,
        operation: 'promote_winning_search_terms',
        trigger_type: 'automatic',
        status: errors.length > 0 ? 'warning' : 'success',
        execution_date: today,
        started_at: new Date(t0).toISOString(),
        completed_at: now,
        duration_ms: Date.now() - t0,
        records_processed: createdOriginal.length + crossAsinExpansions.length,
        result_summary: JSON.stringify({
          terms_analyzed: termMap.size,
          winners_found: winners.length,
          rejected: rejected.length,
          original_campaigns_created: createdOriginal.length,
          cross_asin_expansions: crossAsinExpansions.length,
          negations: negationsApplied.length,
          errors: errors.length,
        }),
      }).catch(() => {});
    }

    return Response.json({
      ok: true,
      dry_run,
      date: today,
      config: { TARGET_ACOS, MIN_ORDERS, MIN_BID, MAX_BID, DAILY_BUDGET, SAFE_CUTOFF },
      summary: {
        terms_analyzed: termMap.size,
        winners_found: winners.length,
        rejected_terms: rejected.length,
        original_campaigns_created: createdOriginal.length,
        cross_asin_expansions: crossAsinExpansions.length,
        negations_applied: negationsApplied.length,
        errors: errors.length,
      },
      winners_detected: winners.map(w => ({
        asin: w.asin, term: w.search_term, orders: w.orders,
        acos: w.acos?.toFixed(1), roas: w.roas?.toFixed(2), winner_tier: w.winner_tier,
      })),
      original_campaigns_created: createdOriginal,
      cross_asin_expansions: crossAsinExpansions,
      negations_applied: negationsApplied,
      rejected_terms: rejected.slice(0, 30),
      errors,
      duration_ms: Date.now() - t0,
    });

  } catch (err: any) {
    console.error('[promoteWinningSearchTerms]', err.message);
    return Response.json({ ok: false, error: err.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});