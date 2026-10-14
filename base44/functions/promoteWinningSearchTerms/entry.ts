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
import { aggregateSearchTermSnapshotsByCampaign } from '../../shared/searchTermHarvestPolicy.ts';
import { areDistinctProductTargets, calculateCrossSkuSeedBid, crossSkuAttributeConflict, evaluateCrossSkuCandidate } from '../../shared/crossSkuTermTransferPolicy.ts';

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
  STOCK_MAX_AGE_HOURS: 48,
  MAX_ORIGINALS_PER_RUN: 5,
  MIN_TERM_WORDS: 3,
};

// ── Normalização ──────────────────────────────────────────────────────────────
function normalizeTerm(t: string): string {
  return String(t || '').toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function isAutomaticCampaign(campaign: any): boolean {
  const type = String(campaign?.targeting_type || '').toUpperCase();
  const name = String(campaign?.name || campaign?.campaign_name || '').toUpperCase();
  return type.includes('AUTO') || /^AUTO\s*\|/.test(name) || /\|\s*AUTO\s*\|/.test(name);
}

function campaignName(asin: string, term: string, sku = ''): string {
  const t = term.replace(/[|]/g, '-').slice(0, 55);
  const identity = sku || asin;
  return `SP | MANUAL | EXACT | ${identity} | ${t}`.slice(0, 128);
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
async function llmRelevance(kwText: string, srcTitle: string, srcBullets: string, srcCat: string,
                            dstTitle: string, dstBullets: string, dstCat: string, hScore: number): Promise<{ score: number; validated: boolean; reason: string; hardBlocker: boolean }> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return { score: hScore, validated: false, reason: 'llm_not_configured', hardBlocker: false };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: Deno.env.get('AI_WEEKLY_REVIEW_MODEL') || 'claude-3-5-haiku-20241022',
        max_tokens: 256,
        messages: [{ role: 'user', content:
          'Relevância da busca observada "' + kwText + '" para anunciar o SKU destino em Amazon Ads EXACT.\n' +
          'ORIGEM: ' + srcTitle + '\nCategoria: ' + srcCat + '\nAtributos: ' + srcBullets.slice(0,300) + '\n' +
          'DESTINO: ' + dstTitle + '\nCategoria: ' + dstCat + '\nAtributos: ' + dstBullets.slice(0,300) + '\n' +
          'Não transfira vendas nem margem entre produtos. Marque incompatibilidade de cor, tamanho, voltagem ou tipo quando explícita.\n' +
          'Responda apenas: {"score": 0-100, "hard_blocker": true/false, "reason": "1 frase"}'
        }],
      }),
    });
    if (!res.ok) return { score: hScore, validated: false, reason: 'llm_http_' + res.status, hardBlocker: false };
    const data = await res.json();
    const text = data?.content?.[0]?.text || '{}';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { score: hScore, validated: false, reason: 'llm_invalid_response', hardBlocker: false };
    const parsed = JSON.parse(m[0]);
    const score = Number(parsed.score);
    if (!Number.isFinite(score) || score < 0 || score > 100) return { score: hScore, validated: false, reason: 'llm_invalid_score', hardBlocker: false };
    return { score, validated: true, reason: String(parsed.reason || '').slice(0,240), hardBlocker: parsed.hard_blocker === true };
  } catch {
    return { score: hScore, validated: false, reason: 'llm_request_failed', hardBlocker: false };
  }
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
      base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, undefined, 1).catch(() => []),
      base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }, undefined, 1).catch(() => []),
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

    // ── Carregar dados base em paralelo ─────────────────────────��────────
    const [searchTerms, products, existingKeywords, existingPromos, snapshots, economics, campaigns] = await Promise.all([
      base44.asServiceRole.entities.SearchTerm.filter(
        { amazon_account_id: aid }, '-orders_14d', 5000
      ).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, undefined, 500).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid, match_type: 'exact' }, undefined, 3000).catch(() => []),
      base44.asServiceRole.entities.SearchTermPromotion.filter({ amazon_account_id: aid }, '-created_at', 2000).catch(() => []),
      base44.asServiceRole.entities.ListingSnapshot.filter({ amazon_account_id: aid }, undefined, 500).catch(() => []),
      base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: aid }, undefined, 500).catch(() => []),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, undefined, 3000).catch(() => []),
    ]);

    const productsByAsin = new Map<string, any[]>();
    const productRowsBySku = new Map<string, any[]>();
    for (const product of products) {
      const asin = String(product.asin || '').toUpperCase();
      const sku = String(product.sku || '').trim().toUpperCase();
      if (asin) {
        const rows = productsByAsin.get(asin) || [];
        rows.push(product);
        productsByAsin.set(asin, rows);
      }
      if (sku) {
        const rows = productRowsBySku.get(sku) || [];
        rows.push(product);
        productRowsBySku.set(sku, rows);
      }
    }
    const productsBySku = new Map([...productRowsBySku].filter(([, rows]) => rows.length === 1).map(([sku, rows]) => [sku, rows[0]]));
    const uniqueProductByAsin = new Map([...productsByAsin].filter(([, rows]) => rows.length === 1).map(([asin, rows]) => [asin, rows[0]]));
    const productForIdentity = (asin: string, sku: string) => {
      const normalizedAsin = String(asin || '').toUpperCase();
      const normalizedSku = String(sku || '').toUpperCase();
      if (normalizedSku) {
        const exact = productsBySku.get(normalizedSku);
        if (!exact || (normalizedAsin && String(exact.asin || '').toUpperCase() !== normalizedAsin)) return null;
        return exact;
      }
      return uniqueProductByAsin.get(normalizedAsin) || null;
    };
    const skuForIdentity = (asin: string, sku: string) =>
      String(sku || productForIdentity(asin, sku)?.sku || '').trim().toUpperCase();
    const termKey = (asin: string, sku: string, term: string) =>
      `${skuForIdentity(asin, sku) ? `SKU:${skuForIdentity(asin, sku)}` : `ASIN:${String(asin || '').toUpperCase()}` }|${normalizeTerm(term)}`;
    const snapshotMap = new Map(snapshots.map((snapshot: any) => [String(snapshot.asin || '').toUpperCase(), snapshot]));
    const economicsBySku = new Map<string, any>();
    for (const row of [...economics].sort((a: any, b: any) =>
      new Date(String(b.updated_at || b.synced_at || b.created_at || 0)).getTime() -
      new Date(String(a.updated_at || a.synced_at || a.created_at || 0)).getTime())) {
      const sku = String(row.sku || '').trim().toUpperCase();
      if (sku && !economicsBySku.has(sku)) economicsBySku.set(sku, row);
    }
    const economicsByAsinRows = new Map<string, any[]>();
    for (const row of economics) {
      const asin = String(row.asin || '').toUpperCase();
      if (!asin) continue;
      const rows = economicsByAsinRows.get(asin) || [];
      rows.push(row);
      economicsByAsinRows.set(asin, rows);
    }
    for (const rows of economicsByAsinRows.values()) {
      rows.sort((a: any, b: any) =>
        new Date(String(b.updated_at || b.synced_at || b.created_at || 0)).getTime() -
        new Date(String(a.updated_at || a.synced_at || a.created_at || 0)).getTime());
    }
    const econForIdentity = (asin: string, sku: string) =>
      (sku && economicsBySku.get(String(sku).toUpperCase())) ||
      (uniqueProductByAsin.has(String(asin || '').toUpperCase()) ? economicsByAsinRows.get(String(asin).toUpperCase())?.[0] : undefined);
    const autoCampaignIds = new Set(
      campaigns
        .filter((campaign: any) =>
          isAutomaticCampaign(campaign) &&
          !['archived'].includes(String(campaign.state || campaign.status || '').toLowerCase())
        )
        .flatMap((campaign: any) => [campaign.id, campaign.campaign_id, campaign.amazon_campaign_id])
        .filter(Boolean)
        .map(String)
    );
    const campaignById = new Map<string, any>();
    for (const campaign of campaigns) {
      for (const id of [campaign.id, campaign.campaign_id, campaign.amazon_campaign_id]) {
        if (id) campaignById.set(String(id), campaign);
      }
    }

    // Índice: ASIN|term → keyword exata já existe
    const exactKeyIndex = new Set(
      existingKeywords
        .filter((k: any) => !['archived'].includes(k.state || k.status || ''))
        .map((k: any) => termKey(k.asin, k.sku || uniqueProductByAsin.get(String(k.asin || '').toUpperCase())?.sku, k.keyword_text || k.keyword || ''))
    );
    // Índice: ASIN|term → promoção já existe
    const promoIndex = new Set(
      existingPromos
        .filter((p: any) => !['failed', 'blocked_duplicate'].includes(p.promotion_status || p.status || ''))
        .map((p: any) => termKey(p.asin, p.sku || uniqueProductByAsin.get(String(p.asin || '').toUpperCase())?.sku, p.normalized_search_term || p.source_search_term || ''))
    );

    // ── FASE 1: Agregar Search Terms sem somar janelas móveis sobrepostas ──
    // Mantém gasto diário da janela de atribuição e lê conversões do snapshot
    // mais recente por origem, para uma única venda não virar várias vendas.
    const termMap = new Map<string, any>();
    const sourceRows = searchTerms.filter((row: any) => {
      const campaign = campaignById.get(String(row.campaign_id || ''));
      const asin = String(row.advertised_asin || campaign?.asin || '').toUpperCase();
      const sku = String(row.advertised_sku || row.sku || campaign?.sku || uniqueProductByAsin.get(asin)?.sku || '').trim().toUpperCase();
      return Boolean(asin && sku && productForIdentity(asin, sku) && row.search_term && autoCampaignIds.has(String(row.campaign_id || '')) &&
        row.same_sku_attribution_verified === true && (!force_asin || asin === String(force_asin).toUpperCase()) &&
        (!row.date || row.date < SAFE_CUTOFF));
    });
    for (const aggregate of aggregateSearchTermSnapshotsByCampaign(sourceRows)) {
      const sourceCampaignId = aggregate.sourceCampaignId;
      const key = `${sourceCampaignId}|${termKey(aggregate.asin, aggregate.sku, aggregate.term)}`;
      if (!key || termMap.has(key)) continue;
      termMap.set(key, {
        asin: aggregate.asin,
        sku: aggregate.sku,
        search_term: aggregate.term,
        normalized_term: normalizeTerm(aggregate.term),
        campaign_id: aggregate.sources[0]?.campaignId || '',
        ad_group_id: aggregate.sources[0]?.adGroupId || '',
        orders: aggregate.sameSkuOrders,
        sales: aggregate.sameSkuSales,
        spend: aggregate.spend,
        clicks: aggregate.clicks,
        impressions: aggregate.impressions,
        orders_3d: aggregate.sameSkuOrders,
        sales_3d: aggregate.sameSkuSales,
        spend_3d: aggregate.spend,
        last_sale_at: aggregate.latestDate || null,
      });
    }

    // ── FASE 2: Detectar termos vencedores ──────────────────────────────
    const winners: any[] = [];
    const rejected: any[] = [];

    for (const [key, agg] of termMap.entries()) {
      const wordCount = normalizeTerm(agg.search_term).split(/\s+/).filter(Boolean).length;
      if (wordCount < CFG.MIN_TERM_WORDS) {
        rejected.push({ ...agg, reject_reason: `cauda_curta_bloqueada: ${wordCount} palavra(s)` });
        continue;
      }
      // Guardrail: zero vendas → ACoS = null (nunca interpretar 0 como bom)
      if (agg.orders < MIN_ORDERS || agg.sales <= 0) {
        rejected.push({ ...agg, reject_reason: `orders=${agg.orders} < ${MIN_ORDERS} ou sales=0` });
        continue;
      }

      const acos = agg.spend > 0 && agg.sales > 0 ? (agg.spend / agg.sales) * 100 : null;
      const roas = agg.spend > 0 && agg.sales > 0 ? agg.sales / agg.spend : null;

      // ACoS sustentável do produto
      const econ = econForIdentity(agg.asin, agg.sku);
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
      const product = productForIdentity(agg.asin, agg.sku);
      if (!product) { rejected.push({ ...agg, reject_reason: 'Produto não encontrado' }); continue; }
      if (product.inventory_status === 'out_of_stock' || Number(product.fba_inventory || 0) <= 0) {
        rejected.push({ ...agg, reject_reason: 'Sem estoque' }); continue;
      }

      // Verificar duplicidade: não criar se já existe keyword exata ou promoção ativa
      const dupKey = termKey(agg.asin, agg.sku, agg.normalized_term);
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

    const actionableWinners = winners
      .sort((a: any, b: any) => (b.orders - a.orders) || (a.acos - b.acos))
      .slice(0, CFG.MAX_ORIGINALS_PER_RUN);

    const promotedThisRun = new Set<string>();
    for (const winner of actionableWinners) {
      const winnerKey = termKey(winner.asin, winner.sku, winner.normalized_term);
      if (exactKeyIndex.has(winnerKey) || promoIndex.has(winnerKey) || promotedThisRun.has(winnerKey)) {
        rejected.push({ ...winner, reject_reason: 'Winner SKU+termo já promovido ou duplicado nesta execução', duplicate: true });
        continue;
      }
      promotedThisRun.add(winnerKey);
      if (dry_run) {
        createdOriginal.push({ ...winner, dry_run: true, campaign_name: campaignName(winner.asin, winner.search_term, winner.sku) });
        continue;
      }

      // Calcular bid inicial
      const avgCpc = winner.clicks > 0 ? winner.spend / winner.clicks : 0;
      const sustainableCpc = (() => {
        const econ = econForIdentity(winner.asin, winner.sku);
        const price = Number(econ?.current_price || productForIdentity(winner.asin, winner.sku)?.price || 0);
        const cvr = winner.clicks > 0 ? winner.orders / winner.clicks : 0.05;
        if (price > 0 && cvr > 0) return price * cvr * (TARGET_ACOS / 100);
        return 0;
      })();
      let initialBid = avgCpc > 0
        ? Math.min(avgCpc * 1.05, sustainableCpc > 0 ? sustainableCpc : MAX_BID)
        : CFG.INITIAL_BID_DEFAULT;
      initialBid = Math.round(Math.max(MIN_BID, Math.min(MAX_BID, initialBid)) * 100) / 100;

      const campName = campaignName(winner.asin, winner.search_term, winner.sku);
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
        const product = productForIdentity(winner.asin, winner.sku);
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
          sku: winner.sku || product?.sku || '',
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
          idempotency_key: `${aid}|${winner.sku || winner.asin}|${winner.normalized_term}|EXACT|${today}`,
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
          asin: winner.asin,
          sku: winner.sku || product?.sku || '',
          name: campName,
          campaign_name: campName,
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
          sku: winner.sku || product?.sku || '',
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
        exactKeyIndex.add(termKey(winner.asin, winner.sku, winner.normalized_term));
        promoIndex.add(termKey(winner.asin, winner.sku, winner.normalized_term));

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
          sku: winner.sku,
        }, undefined, 500).catch(() => []);
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
            sku: winner.sku,
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
          sku: winner.sku,
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
            sku: winner.sku,
            source_campaign_id: winner.campaign_id,
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
      p.status === 'active' && Number.isFinite(Number(p.fba_inventory)) && Number(p.fba_inventory) > 0
    );

    for (const winner of actionableWinners) {
      if (expansionsCount >= CFG.MAX_EXPANSIONS_PER_RUN) break;

      const srcSnap = snapshotMap.get(winner.asin);
      const srcProd = productForIdentity(winner.asin, winner.sku);
      if (!srcProd) continue;

      const srcTitle = srcProd.product_name || srcProd.display_name || srcSnap?.title || '';
      const srcBullets = (() => { try { return JSON.parse(srcSnap?.bullets || srcProd.key_product_features || '[]').join(' '); } catch { return srcSnap?.bullets || srcProd.key_product_features || ''; } })();
      const srcCat = srcProd.category || srcSnap?.product_type || '';
      const srcFull = srcTitle + ' ' + srcBullets;
      const srcEcon = econForIdentity(winner.asin, winner.sku);
      const sourceIdentity = {
        asin: winner.asin, sku: winner.sku,
        uniqueSku: productsBySku.has(String(winner.sku || '').toUpperCase()),
        uniqueAsin: uniqueProductByAsin.has(String(winner.asin || '').toUpperCase()),
      };

      for (const destProd of activeProducts) {
        if (expansionsCount >= CFG.MAX_EXPANSIONS_PER_RUN) break;
        const destinationIdentity = {
          asin: String(destProd.asin || '').toUpperCase(), sku: String(destProd.sku || '').toUpperCase(),
          uniqueSku: productsBySku.has(String(destProd.sku || '').toUpperCase()),
          uniqueAsin: uniqueProductByAsin.has(String(destProd.asin || '').toUpperCase()),
        };
        if (!areDistinctProductTargets({ source: sourceIdentity, destination: destinationIdentity })) continue;

        const destKey = termKey(destProd.asin, destProd.sku, winner.normalized_term);
        if (exactKeyIndex.has(destKey) || promoIndex.has(destKey)) continue;

        const destSnap = snapshotMap.get(destProd.asin);
        const destTitle = destProd.product_name || destProd.display_name || destSnap?.title || '';
        if (!destTitle) continue;
        const destBullets = (() => { try { return JSON.parse(destSnap?.bullets || destProd.key_product_features || '[]').join(' '); } catch { return destSnap?.bullets || destProd.key_product_features || ''; } })();
        const destCat = destProd.category || destSnap?.product_type || '';
        const destFull = destTitle + ' ' + destBullets;

        const attributeConflict = crossSkuAttributeConflict(winner.search_term, srcFull, destFull);
        if (attributeConflict) {
          rejected.push({ asin: destProd.asin, sku: destProd.sku || '', term: winner.search_term, reject_reason: attributeConflict });
          continue;
        }
        const blocker = hasHardBlocker(winner.search_term, srcFull, destFull);
        if (blocker.blocked) {
          rejected.push({ asin: destProd.asin, sku: destProd.sku || '', term: winner.search_term, reject_reason: blocker.reason });
          continue;
        }

        const heuristicScore = calcHeuristic(winner.search_term, srcTitle, srcBullets, srcCat, destTitle, destBullets, destCat);
        if (heuristicScore < CFG.HEURISTIC_LOW_CONF) continue;

        let aiScore: number | null = null;
        let aiValidated = false;
        let aiReason = '';
        if (heuristicScore < CFG.HEURISTIC_HIGH_CONF) {
          const ai = await llmRelevance(winner.search_term, srcTitle, srcBullets, srcCat, destTitle, destBullets, destCat, heuristicScore);
          aiScore = ai.score;
          aiValidated = ai.validated;
          aiReason = ai.reason;
          if (ai.hardBlocker) {
            rejected.push({ asin: destProd.asin, sku: destProd.sku || '', term: winner.search_term, reject_reason: 'ai_detected_product_attribute_conflict', ai_reason: aiReason });
            continue;
          }
        }

        const destEcon = econForIdentity(destProd.asin, destProd.sku);
        const destSku = String(destProd.sku || '').trim().toUpperCase();
        const stockSyncAt = Date.parse(String(destProd.inventory_last_synced_at || destProd.last_inventory_sync_at || destProd.last_sync_at || destProd.synced_at || ''));
        const listingCheckedAt = Date.parse(String(destProd.listing_checked_at || ''));
        const nowMs = Date.now();
        const stockFresh = Number.isFinite(stockSyncAt) && stockSyncAt <= nowMs && nowMs - stockSyncAt <= CFG.STOCK_MAX_AGE_HOURS * 3600000;
        const listingFresh = Number.isFinite(listingCheckedAt) && listingCheckedAt <= nowMs && nowMs - listingCheckedAt <= CFG.STOCK_MAX_AGE_HOURS * 3600000;
        const destinationEconomicsComplete = Boolean(destEcon && destSku &&
          String(destEcon.sku || '').trim().toUpperCase() === destSku &&
          destEcon.economic_data_complete === true &&
          destEcon.economics_status === 'complete' &&
          destEcon.costs_confirmed_by_user === true);
        const transferCheck = evaluateCrossSkuCandidate({
          source: {
            asin: winner.asin, sku: winner.sku,
            uniqueSku: sourceIdentity.uniqueSku, uniqueAsin: sourceIdentity.uniqueAsin,
            term: winner.search_term, attributedOrders: winner.orders,
            attributedSales: winner.sales, spend: winner.spend,
            attributionVerified: true, breakEvenAcos: Number(srcEcon?.break_even_acos || 0),
          },
          destination: {
            asin: destinationIdentity.asin, sku: destinationIdentity.sku,
            uniqueSku: destinationIdentity.uniqueSku, uniqueAsin: destinationIdentity.uniqueAsin,
            availableFba: destProd.fba_inventory == null ? null : Number(destProd.fba_inventory),
            stockFresh,
            adsAuthorized: destProd.ads_scope_status === 'authorized' && destProd.ads_authorized_by_user === true,
            listingBuyable: destProd.listing_buyable === true && destProd.listing_status === 'active' && listingFresh,
            economicsComplete: destinationEconomicsComplete,
            safeMaxCpc: Number(destEcon?.safe_max_cpc || 0),
            exactAlreadyExists: exactKeyIndex.has(destKey),
            promotionAlreadyExists: promoIndex.has(destKey),
          },
          relevance: {
            heuristicScore, aiScore, aiValidated,
            minimumScore: CFG.MIN_CROSS_ASIN_RELEVANCE,
            minimumHeuristicScore: CFG.HEURISTIC_LOW_CONF,
            heuristicOnlyMinimum: CFG.HEURISTIC_HIGH_CONF,
          },
        });
        if (!transferCheck.eligible) {
          rejected.push({ asin: destProd.asin, sku: destSku, term: winner.search_term, reject_reason: transferCheck.reason, relevance_score: transferCheck.effectiveRelevance });
          continue;
        }
        const score = transferCheck.effectiveRelevance;
        const sourceObservedCpc = winner.clicks > 0 ? winner.spend / winner.clicks : 0;
        const destinationSafeMaxCpc = Number(destEcon?.safe_max_cpc || 0);
        const destBid = calculateCrossSkuSeedBid({
          sourceObservedCpc, destinationSafeMaxCpc, minBid: MIN_BID, maxBid: MAX_BID,
        });
        if (destBid == null) {
          rejected.push({ asin: destProd.asin, sku: destSku, term: winner.search_term, reject_reason: 'destination_economic_bid_below_minimum', relevance_score: score });
          continue;
        }
        const destAov = Number(destEcon?.current_price || destProd.price || 0);
        const destTargetAcos = Number(destEcon?.target_acos || TARGET_ACOS);

        if (dry_run) {
          crossAsinExpansions.push({
            source_asin: winner.asin, source_sku: winner.sku,
            destination_asin: destProd.asin, destination_sku: destSku,
            term: winner.search_term, relevance_score: score,
            ai_validated: aiValidated, ai_score: aiScore,
            bid: destBid, campaign_name: campaignName(destProd.asin, winner.search_term, destSku), dry_run: true,
          });
          expansionsCount++;
          continue;
        }

        const destCampName = campaignName(destProd.asin, winner.search_term, destProd.sku);
        const testEndsAt = new Date(Date.now() + CFG.TEST_WINDOW_HOURS * 3600000).toISOString();

        if (dry_run) {
          crossAsinExpansions.push({
            source_asin: winner.asin, source_sku: winner.sku, destination_asin: destProd.asin, destination_sku: destProd.sku,
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
            sku: destProd.sku || '',
            source_sku: winner.sku,
            destination_sku: destProd.sku || '',
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
            ai_validated: aiValidated,
            ai_relevance_check: JSON.stringify({ heuristic_score: heuristicScore, ai_score: aiScore, ai_reason: aiReason }).slice(0, 1000),
            source_asin: winner.asin,
            source_orders: winner.orders,
            source_acos: winner.acos,
            source_roas: winner.roas,
            test_started_at: now,
            test_ends_at: testEndsAt,
            next_review_at: testEndsAt,
            idempotency_key: `${aid}|SKU:${destProd.sku || destProd.asin}|${winner.normalized_term}|EXACT_CROSS|${today}`,
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
            source_sku: winner.sku,
            source_orders: winner.orders,
            source_acos: winner.acos,
            source_roas: winner.roas,
            source_cvr: winner.clicks > 0 ? winner.orders / winner.clicks : 0,
            source_winner_tier: winner.winner_tier,
            destination_asin: destProd.asin,
            destination_product_name: destProd.product_name || destProd.display_name || '',
            destination_sku: destProd.sku || '',
            destination_fba_inventory: Number(destProd.fba_inventory || 0),
            destination_aov: destAov,
            destination_target_acos: destTargetAcos,
            destination_sustainable_cpc: destinationSafeMaxCpc,
            destination_safe_max_cpc: destinationSafeMaxCpc,
            relevance_score: score,
            heuristic_score: heuristicScore,
            llm_score: aiScore,
            llm_reason: aiReason,
            relevance_phase: aiValidated ? 'LLM_VALIDATED' : 'HEURISTIC_ONLY',
            transfer_decision: 'HIGH_CONFIDENCE_TRANSFER',
            rule_id: 'CROSS_ASIN_TERM_EXPANSION',
            initial_bid: destBid,
            campaign_job: 'VALIDATION',
            idempotency_key: `${aid}|SKU:${destProd.sku || destProd.asin}|${winner.normalized_term}|EXACT_CROSS|${today}`,
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
            sku: destProd.sku || '',
            targeting_type: 'MANUAL',
            campaign_type: 'SP',
            state: 'enabled', status: 'enabled',
            daily_budget: DAILY_BUDGET,
            created_by_app: true,
            launch_phase: 'testing_72h',
            is_operational: true,
            created_at: now, last_sync_at: now, synced_at: now,
          }).catch(() => {});

          // Manter a AUTO do destino ativa durante o teste da EXACT.

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

