/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║         LIVINGFINDS — AUTOMAÇÃO COMPLETA DE PRODUTOS (Manual §1–27)      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Orquestrador principal — Manual de Automação + Sistema de Conformidade (§1–27).
 *
 * Fluxo (§12 do manual de conformidade):
 *  1. Carrega todos os produtos ativos
 *  2. validateProductCompliance → produto deve ser APPROVED
 *  3. Garante campanha AUTO SP-AUTO-[SKU]
 *  4. Gera sugestões via Claude (suggestProductKeywordsWithAI)
 *  5. validateProductCompliance → filtros de política por termo (policy_confidence=100)
 *  6. Filtra commercial_confidence >= 80% E policy_confidence = 100
 *  7. Cria campanha manual SP-EXATA-[SKU], máx 10 termos, bid R$ 0,50
 *  8. Agenda negativação na AUTO após impressões confirmadas
 *  9. Regista auditoria completa por produto e termo (§23)
 *
 * Regras de bid (§14):
 *  - Inicial: R$ 0,50
 *  - Sem impressões 24h: R$ 0,55
 *  - Sem impressões 48h: R$ 0,60
 *  - Máximo sem venda: R$ 0,60
 *  - Com vendas rentáveis: +5% a +10% por ciclo até R$ 0,75 inicial
 *
 * Naming (§22):
 *  - AUTO:   SP-AUTO-[SKU]
 *  - MANUAL: SP-EXATA-[SKU]
 *  - GRUPO:  ADG-[SKU]
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ── Constantes canônicas (§2, §14) ────────────────────────────────────────────
const INITIAL_BID       = 0.50;
const BID_NO_IMP_24H    = 0.55;
const BID_NO_IMP_48H    = 0.60;
const BID_MAX_NO_SALE   = 0.60;
const BID_MAX_WITH_SALE = 0.75;
const BID_MAX_GLOBAL    = 5.00;
const MIN_CONFIDENCE    = 0.80;   // 80% (§8)
const MAX_KEYWORDS_CYCLE = 10;    // máx por produto por ciclo (§9)
const NO_IMP_PAUSE_DAYS = 5;      // pausar após 5 dias sem impressões (§15)
const CLICKS_REDUCE_BID = 10;     // 10 cliques sem venda → reduzir 10% (§16)
const CLICKS_PAUSE      = 15;     // 15 cliques sem venda → pausar (§16)
const CURRENCY          = 'BRL';
const SYMBOL            = 'R$';

// ── Amazon Ads token cache ─────────────────────────────────────────────────────
const tokenCache = {};
async function getAdsToken(refreshToken) {
  const cached = tokenCache['full'];
  if (cached && cached.expires_at > Date.now() + 5000) return cached.access_token;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: Deno.env.get('ADS_CLIENT_ID') || '',
    client_secret: Deno.env.get('ADS_CLIENT_SECRET') || '',
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Token Amazon falhou');
  tokenCache['full'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function getAdsBaseUrl() {
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsCall(method, path, body, refreshToken, profileId, ct = 'application/json') {
  const token = await getAdsToken(refreshToken);
  const res = await fetch(`${getAdsBaseUrl()}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': ct, 'Accept': ct,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data };
}

// ── Normalização de texto para deduplicação (§21) ─────────────────────────────
function norm(str) {
  return (str || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function isSimilar(a, b) {
  const na = norm(a), nb = norm(b);
  if (na === nb) return true;
  const ta = new Set(na.split(' ')), tb = new Set(nb.split(' '));
  const inter = [...ta].filter(t => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return union > 0 && inter / union >= 0.80;
}

// ── Verificar produto ativo (§3) ─────────────────────────────────────────────
function isProductEligible(product) {
  if (!product) return false;
  if (['inactive', 'archived'].includes(product.status)) return false;
  if (product.inventory_status === 'out_of_stock') return false;
  // Aceitar in_stock, low_stock, ou fba_inventory > 0
  const hasStock = product.inventory_status === 'in_stock'
    || product.inventory_status === 'low_stock'
    || (product.fba_inventory || 0) > 0;
  if (!hasStock) return false;
  if (product.should_activate_campaign === false) return false;
  return true;
}

// ── Extrair ID de resposta Amazon ─────────────────────────────────────────────
function extractId(data, field) {
  if (!data) return null;
  const paths = [
    () => data[field],
    () => data[`${field}s`]?.[0]?.[field],
    () => data[`${field}s`]?.success?.[0]?.[field],
    () => data.success?.[0]?.[field],
    () => data.data?.[field],
    () => Array.isArray(data) ? data[0]?.[field] : null,
  ];
  for (const fn of paths) {
    try { const v = fn(); if (v) return String(v); } catch {}
  }
  return null;
}

// ── Criar ou localizar campanha na Amazon ─────────────────────────────────────
async function ensureCampaign(base44, account, refreshToken, profileId, campaignName, targetingType, budget, now) {
  // 1. Verificar base local
  const localKey = targetingType === 'AUTO'
    ? { amazon_account_id: account.id, targeting_type: 'AUTO' }
    : { amazon_account_id: account.id, targeting_type: 'MANUAL' };

  // buscar pelo nome exato
  const allLocal = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: account.id }, '-created_date', 500);
  const existingLocal = allLocal.find(c =>
    c.campaign_name === campaignName || c.name === campaignName
  );
  if (existingLocal && existingLocal.state !== 'archived') {
    return { campaign_id: existingLocal.campaign_id, ad_group_id: null, already_exists: true };
  }

  // 2. Criar na Amazon
  const today = now.slice(0, 10);
  const campaignPayload = {
    campaigns: [{
      name: campaignName,
      targetingType,
      state: 'ENABLED',
      budget: { budgetType: 'DAILY', budget: parseFloat(budget.toFixed(2)) },
      startDate: today,
      ...(targetingType === 'AUTO' ? {} : { bidding: { strategy: 'LEGACY_FOR_SALES', adjustments: [] } }),
    }],
  };

  const campRes = await adsCall('POST', '/sp/campaigns', campaignPayload, refreshToken, profileId, 'application/vnd.spCampaign.v3+json');
  let campaignId = extractId(campRes.data, 'campaignId');

  // fallback: buscar na Amazon
  if (!campaignId && [200, 201, 207].includes(campRes.status)) {
    for (let i = 0; i < 3 && !campaignId; i++) {
      await new Promise(r => setTimeout(r, 800));
      const listRes = await adsCall('POST', '/sp/campaigns/list', {
        stateFilter: { include: ['ENABLED'] }, maxResults: 100,
      }, refreshToken, profileId, 'application/vnd.spCampaign.v3+json');
      const found = (listRes.data?.campaigns || []).find(c => c.name === campaignName);
      if (found) campaignId = String(found.campaignId);
    }
  }
  if (!campaignId) return null;

  // 3. Criar AdGroup
  const agRes = await adsCall('POST', '/sp/adGroups', {
    adGroups: [{ name: campaignName.replace('SP-AUTO-', 'ADG-').replace('SP-EXATA-', 'ADG-'), campaignId, defaultBid: INITIAL_BID, state: 'ENABLED' }],
  }, refreshToken, profileId, 'application/vnd.spAdGroup.v3+json');
  const adGroupId = extractId(agRes.data, 'adGroupId');

  // 4. Salvar local
  await base44.asServiceRole.entities.Campaign.create({
    amazon_account_id: account.id,
    campaign_id: campaignId,
    name: campaignName,
    campaign_name: campaignName,
    campaign_type: 'SP',
    targeting_type: targetingType,
    state: 'enabled', status: 'enabled',
    daily_budget: budget,
    created_by_app: true,
    launch_phase: 'new',
    days_running: 0,
    currency_code: CURRENCY, currency_symbol: SYMBOL,
    created_at: now, synced_at: now, last_sync_at: now,
    marketplace_id: account.marketplace_id || 'A2Q3Y263D00KWC',
  });

  if (adGroupId) {
    await base44.asServiceRole.entities.AdGroup.create({
      amazon_account_id: account.id,
      campaign_id: campaignId,
      ad_group_id: adGroupId,
      ad_group_name: campaignName.replace('SP-AUTO-', 'ADG-').replace('SP-EXATA-', 'ADG-'),
      name: campaignName.replace('SP-AUTO-', 'ADG-').replace('SP-EXATA-', 'ADG-'),
      default_bid: INITIAL_BID,
      state: 'enabled', status: 'enabled',
      synced_at: now,
    }).catch(() => {});
  }

  return { campaign_id: campaignId, ad_group_id: adGroupId, already_exists: false };
}

// ── Criar keywords exact na Amazon ────────────────────────────────────────────
async function createKeywords(refreshToken, profileId, campaignId, adGroupId, keywords) {
  if (!keywords.length) return { created: 0, errors: [] };
  const payload = {
    keywords: keywords.map(kw => ({
      campaignId,
      adGroupId,
      keywordText: kw,
      matchType: 'EXACT',
      state: 'ENABLED',
      bid: INITIAL_BID,
    })),
  };
  const res = await adsCall('POST', '/sp/keywords', payload, refreshToken, profileId, 'application/vnd.spKeyword.v3+json');
  const successes = res.data?.keywords?.success || res.data?.success || [];
  const errors = res.data?.keywords?.error || res.data?.error || [];
  return { created: successes.length, errors, raw_status: res.status };
}

// ── Criar produto anuncio (ProductAd) ─────────────────────────────────────────
async function createProductAd(refreshToken, profileId, campaignId, adGroupId, asin, sku) {
  const res = await adsCall('POST', '/sp/productAds', {
    productAds: [{ campaignId, adGroupId, asin, ...(sku ? { sku } : {}), state: 'ENABLED' }],
  }, refreshToken, profileId, 'application/vnd.spProductAd.v3+json');
  return extractId(res.data, 'adId');
}

// ══════════════════════════════════════════════════════════════════════════════
Deno.serve(async (req) => {
  const startTime = Date.now();
  const base44 = createClientFromRequest(req);
  const now = new Date().toISOString();

  try {
    const body = await req.json().catch(() => ({}));

    // ── Resolver conta ─────────────────────────────────────────────────────
    let account = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
      account = accs[0] || null;
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0] || null;
    }
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon conectada.' });

    const aid = account.id;
    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    if (!refreshToken || !profileId) return Response.json({ ok: false, error: 'Credenciais Ads não configuradas.' });

    // ── Verificar AutopilotConfig ──────────────────────────────────────────
    const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid });
    const cfg = configs[0] || {};
    if (cfg.enabled === false) return Response.json({ ok: true, skipped: true, reason: 'Autopilot desabilitado.' });

    const totalBudgetLimit = cfg.total_daily_budget || cfg.daily_budget_limit || 100;
    const maxBudgetPerCampaign = cfg.maximum_campaign_budget || 10;
    const targetAcos = cfg.target_acos || cfg.acos_target || 25;

    // ── Verificar budget disponível (§23) ─────────────────────────────────
    const allActiveCampaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: aid, state: 'enabled' }, null, 500
    );
    const currentTotalBudget = allActiveCampaigns.reduce((s, c) => s + (c.daily_budget || 0), 0);
    const availableBudget = Math.max(0, totalBudgetLimit - currentTotalBudget);
    if (availableBudget < 5) {
      return Response.json({ ok: false, error: `Budget diário esgotado. Usado: ${SYMBOL}${currentTotalBudget.toFixed(2)} / ${SYMBOL}${totalBudgetLimit.toFixed(2)}` });
    }

    // ── Carregar produtos ativos (§3) ─────────────────────────────────────
    const allProducts = await base44.asServiceRole.entities.Product.filter(
      { amazon_account_id: aid, status: 'active' }, '-fba_inventory', 500
    );
    const activeProducts = allProducts.filter(isProductEligible);

    const summary = {
      products_found: allProducts.length,
      products_eligible: activeProducts.length,
      products_blocked_policy: 0,      // produto PROHIBITED/RESTRICTED/REVIEW_REQUIRED
      auto_campaigns_created: 0,
      auto_campaigns_existing: 0,
      manual_campaigns_created: 0,
      manual_campaigns_existing: 0,
      keywords_created: 0,
      keywords_blocked_low_confidence: 0,
      keywords_blocked_duplicate: 0,
      keywords_blocked_policy: 0,      // reprovados pela validação de conformidade
      products_skipped_budget: 0,
      products_processed: 0,
      errors: [],
    };

    // Budget por produto (distribuição equitativa)
    const budgetPerProduct = Math.min(
      Math.max(availableBudget / Math.max(activeProducts.length, 1), 5),
      maxBudgetPerCampaign
    );

    // Carregar keywords e sugestões já existentes (deduplicação global)
    const [allKeywords, allSuggestions] = await Promise.all([
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid, state: 'enabled' }, null, 2000),
      base44.asServiceRole.entities.KeywordSuggestion.filter({ amazon_account_id: aid, status: 'created' }, '-created_at', 1000),
    ]);

    // Índice keyword → campaign para deduplicação (§21)
    const kwIndex = new Map(); // norm(kw) → campaign_id
    for (const k of allKeywords) {
      const n = norm(k.keyword_text || k.keyword || '');
      if (n) kwIndex.set(n, k.campaign_id);
    }

    // ── Loop por produto ───────────────────────────────────────────────────
    for (const product of activeProducts) {
      try {
        const sku = product.sku || product.asin;
        const asin = product.asin;
        if (!asin) continue;

        // Verificar budget restante para este produto
        const usedSoFar = summary.auto_campaigns_created * budgetPerProduct * 2; // auto + manual
        if (usedSoFar + budgetPerProduct * 2 > availableBudget) {
          summary.products_skipped_budget++;
          continue;
        }

        const autoCampaignName   = `SP-AUTO-${sku}`;
        const manualCampaignName = `SP-EXATA-${sku}`;

        // ── A. Validação de conformidade do produto (§4, §12) ────────────
        // Produto ativo ≠ produto automaticamente elegível para publicidade
        const productCompliance = await base44.asServiceRole.functions.invoke(
          'validateProductCompliance',
          { amazon_account_id: aid, asin, product_id: product.id, terms: [] }
        ).catch(() => null);

        const productStatus = productCompliance?.data?.product?.status || 'INSUFFICIENT_DATA';

        if (productStatus === 'PROHIBITED') {
          summary.products_blocked_policy++;
          // Registrar motivo para auditoria (§23)
          await base44.asServiceRole.entities.OptimizationDecision.create({
            amazon_account_id: aid,
            decision_type: 'pause',
            entity_type: 'campaign',
            entity_id: asin,
            asin,
            action: 'no_action',
            rationale: `CONFORMIDADE §4: produto ${asin} classificado como PROHIBITED — ${productCompliance?.data?.product?.reason || 'categoria ou conteúdo proibido'}`,
            risk: 'low',
            requires_approval: false,
            status: 'skipped',
            confidence: 100,
            objective: 'maintenance',
            currency_code: CURRENCY, currency_symbol: SYMBOL,
            idempotency_key: `${aid}|compliance_prohibited|${asin}`,
            source_function: 'runFullProductAutomation',
            created_at: now,
          }).catch(() => {});
          summary.products_processed++;
          continue;
        }

        if (productStatus === 'RESTRICTED' || productStatus === 'REVIEW_REQUIRED' || productStatus === 'INSUFFICIENT_DATA') {
          summary.products_blocked_policy++;
          // Produto requer revisão humana — não criar campanha automaticamente
          await base44.asServiceRole.entities.OptimizationDecision.create({
            amazon_account_id: aid,
            decision_type: 'pause',
            entity_type: 'campaign',
            entity_id: asin,
            asin,
            action: 'no_action',
            rationale: `CONFORMIDADE §4: produto ${asin} requer revisão humana (${productStatus}) — ${productCompliance?.data?.product?.reason || 'verificação necessária antes de criar campanha'}`,
            risk: 'medium',
            requires_approval: true,
            status: 'pending',
            confidence: 50,
            objective: 'maintenance',
            currency_code: CURRENCY, currency_symbol: SYMBOL,
            idempotency_key: `${aid}|compliance_review|${asin}`,
            source_function: 'runFullProductAutomation',
            created_at: now,
          }).catch(() => {});
          summary.products_processed++;
          continue;
        }
        // productStatus === 'APPROVED' → pode continuar

        // ── C. Garantir campanha AUTO ────────────────────────────────────
        const autoResult = await ensureCampaign(
          base44, account, refreshToken, profileId,
          autoCampaignName, 'AUTO', budgetPerProduct, now
        );

        if (!autoResult) {
          summary.errors.push(`${asin}: falha ao criar/localizar campanha AUTO`);
          continue;
        }

        if (autoResult.already_exists) {
          summary.auto_campaigns_existing++;
        } else {
          summary.auto_campaigns_created++;
          // Criar ProductAd na AUTO
          if (autoResult.ad_group_id) {
            await createProductAd(refreshToken, profileId, autoResult.campaign_id, autoResult.ad_group_id, asin, product.sku).catch(() => {});
          }
        }

        // ── D. Verificar se já tem campanha manual ───────────────────────
        const allLocal = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, '-created_date', 500);
        const existingManual = allLocal.find(c =>
          (c.campaign_name === manualCampaignName || c.name === manualCampaignName) &&
          c.targeting_type === 'MANUAL' && c.state !== 'archived'
        );

        // ── E. Obter sugestões de keywords via AI + validação de conformidade ──
        // Invocar suggestProductKeywordsWithAI
        let suggestions = [];
        try {
          await base44.asServiceRole.functions.invoke('suggestProductKeywordsWithAI', {
            amazon_account_id: aid,
            asin,
            product_id: product.id,
            _service_role: true,
          }).catch(() => {});

          // Buscar sugestões salvas no banco (a função agora persiste e não retorna arrays diretos)
          const savedSuggestions = await base44.asServiceRole.entities.KeywordSuggestion.filter(
            { amazon_account_id: aid, asin, status: 'suggested' }, '-created_at', 50
          ).catch(() => []);
          const allTerms = savedSuggestions.map((s: any) => ({
            keyword: s.keyword,
            confidence: s.confidence || 0,
            relevance_score: s.relevance_score || 0,
            match_type: s.match_type || 'exact',
            intent: s.intent || 'commercial',
            reason: s.reason || '',
            source: s.source || 'AUTOMATIC_SEARCH_TERM',
            id: s.id,
          }));

          // Filtrar confiança >= 80% (§8)
          const eligible = allTerms.filter(s => (s.confidence || 0) >= MIN_CONFIDENCE && s.status !== 'duplicate');

          // Ordenar: termos com histórico de vendas primeiro, depois por confiança (§9)
          eligible.sort((a, b) => {
            const aHasSales = (a.source === 'AUTOMATIC_SEARCH_TERM' || a.source === 'CONVERTED_TERM_EXPANSION') ? 1 : 0;
            const bHasSales = (b.source === 'AUTOMATIC_SEARCH_TERM' || b.source === 'CONVERTED_TERM_EXPANSION') ? 1 : 0;
            if (bHasSales !== aHasSales) return bHasSales - aHasSales;
            return (b.confidence || 0) - (a.confidence || 0);
          });

          // Validação de conformidade por termo (§8–10, §12)
          // policy_confidence deve ser 100 para publicação automática
          const termTexts = eligible.map(s => s.keyword).filter(Boolean);
          let policyResults = new Map(); // term → { status, policy_confidence }
          if (termTexts.length > 0) {
            const policyCheck = await base44.asServiceRole.functions.invoke(
              'validateProductCompliance',
              { amazon_account_id: aid, asin, product_id: product.id, terms: termTexts }
            ).catch(() => null);
            if (policyCheck?.data?.terms) {
              for (const tr of policyCheck.data.terms) {
                policyResults.set(norm(tr.term), tr);
              }
            }
          }

          // Máximo 10 termos por ciclo (§9), sem duplicatas globais e com conformidade 100%
          const selected = [];
          for (const s of eligible) {
            if (selected.length >= MAX_KEYWORDS_CYCLE) break;
            const nk = norm(s.keyword || '');
            if (!nk) continue;

            // Verificar conformidade de política (§10): policy_confidence deve ser 100
            const policyResult = policyResults.get(nk);
            if (policyResult && policyResult.status !== 'APPROVED') {
              summary.keywords_blocked_policy++;
              continue; // bloqueado por política — não criar
            }

            // Verificar duplicata global
            if (kwIndex.has(nk)) {
              summary.keywords_blocked_duplicate++;
              continue;
            }
            // Verificar se outra sugestão similar já foi aprovada/criada
            const alreadyCreated = allSuggestions.some(ps => isSimilar(ps.keyword || '', nk));
            if (alreadyCreated) {
              summary.keywords_blocked_duplicate++;
              continue;
            }
            selected.push(s);
          }

          suggestions = selected;

          // Contabilizar bloqueados por confiança baixa
          summary.keywords_blocked_low_confidence += allTerms.filter(s => (s.confidence || 0) < MIN_CONFIDENCE).length;
        } catch (e) {
          summary.errors.push(`${asin}: sugestão de keywords falhou — ${e.message}`);
        }

        if (!suggestions.length) {
          summary.products_processed++;
          continue; // sem termos elegíveis, pular criação da campanha manual
        }

        // ── F. Criar campanha manual se não existir ──────────────────────
        let manualCampaignId = existingManual?.campaign_id || null;
        let manualAdGroupId = null;

        if (!existingManual) {
          const manualResult = await ensureCampaign(
            base44, account, refreshToken, profileId,
            manualCampaignName, 'MANUAL', budgetPerProduct, now
          );
          if (!manualResult) {
            summary.errors.push(`${asin}: falha ao criar campanha manual`);
            summary.products_processed++;
            continue;
          }
          manualCampaignId = manualResult.campaign_id;
          manualAdGroupId = manualResult.ad_group_id;
          summary.manual_campaigns_created++;

          // Criar ProductAd na MANUAL
          if (manualAdGroupId) {
            await createProductAd(refreshToken, profileId, manualCampaignId, manualAdGroupId, asin, product.sku).catch(() => {});
          }
        } else {
          summary.manual_campaigns_existing++;
          // Buscar ad_group_id do grupo existente
          const adGroups = await base44.asServiceRole.entities.AdGroup.filter({ amazon_account_id: aid, campaign_id: manualCampaignId }, null, 5);
          manualAdGroupId = adGroups[0]?.ad_group_id || null;
        }

        if (!manualCampaignId || !manualAdGroupId) {
          summary.errors.push(`${asin}: campaign_id ou ad_group_id manual ausente`);
          summary.products_processed++;
          continue;
        }

        // ── G. Criar keywords exact com bid R$ 0,50 ──────────────────────
        const keywordTexts = suggestions.map(s => s.keyword.toLowerCase().trim());
        const kwResult = await createKeywords(refreshToken, profileId, manualCampaignId, manualAdGroupId, keywordTexts);
        summary.keywords_created += kwResult.created;

        // Atualizar índice para evitar duplicatas no próximo produto
        for (const kw of keywordTexts) kwIndex.set(norm(kw), manualCampaignId);

        // ── H. Registrar keywords localmente + marcar sugestão como "created" ──
        for (const s of suggestions) {
          const kn = norm(s.keyword);
          // Atualizar KeywordSuggestion status
          if (s.id) {
            await base44.asServiceRole.entities.KeywordSuggestion.update(s.id, {
              status: 'created',
              created_campaign_id: manualCampaignId,
              amazon_campaign_id: manualCampaignId,
              executed_at: now,
            }).catch(() => {});
          }

          // Registrar keyword no banco local
          await base44.asServiceRole.entities.Keyword.create({
            amazon_account_id: aid,
            campaign_id: manualCampaignId,
            ad_group_id: manualAdGroupId,
            keyword_id: `local_${aid}_${manualCampaignId}_${kn.replace(/\s/g, '_')}_${Date.now()}`,
            asin,
            sku: product.sku || null,
            keyword: s.keyword,
            keyword_text: s.keyword,
            match_type: 'exact',
            state: 'enabled', status: 'enabled',
            current_bid: INITIAL_BID,
            bid: INITIAL_BID,
            source: 'search_term',
            first_seen_at: now,
            synced_at: now,
          }).catch(() => {});
        }

        // ── I. Negativação na AUTO (§12) — agendar após confirmar impressões ──
        // Criamos uma OptimizationDecision pendente para ser executada quando
        // a campanha manual tiver impressões (verificado pela calibração diária)
        for (const s of suggestions) {
          await base44.asServiceRole.entities.OptimizationDecision.create({
            amazon_account_id: aid,
            decision_type: 'negative_keyword',
            entity_type: 'search_term',
            campaign_id: autoResult.campaign_id,
            ad_group_id: autoResult.ad_group_id || '',
            keyword_text: s.keyword,
            asin,
            action: 'negative_exact',
            rationale: `§12 Manual: termo "${s.keyword}" transferido para campanha manual SP-EXATA-${sku}. Negativar na AUTO após confirmar impressões na manual (prazo: 24h).`,
            data_used: JSON.stringify({ confidence: s.confidence, manual_campaign: manualCampaignName, auto_campaign: autoCampaignName }),
            risk: 'low',
            requires_approval: false,
            // status PENDING — executado pela negateKeywordInAutoCampaign quando manual tiver impressões
            status: 'pending',
            confidence: Math.round((s.confidence || 0.85) * 100),
            objective: 'discovery',
            currency_code: CURRENCY, currency_symbol: SYMBOL,
            idempotency_key: `${aid}|negate_auto|${autoResult.campaign_id}|${norm(s.keyword)}`,
            source_function: 'runFullProductAutomation',
            created_at: now,
          }).catch(() => {}); // idempotente — ignora duplicata
        }

        // ── J. Atualizar estado do produto ───────────────────────────────
        await base44.asServiceRole.entities.Product.update(product.id, {
          has_campaign: true,
          campaign_status: 'active',
          linked_campaign_id: manualCampaignId,
          manual_campaign_created_at: existingManual ? product.manual_campaign_created_at : now,
          last_sync_at: now,
        }).catch(() => {});

        // ── K. LearningEvent ──────────────────────────────────────────────
        await base44.asServiceRole.entities.LearningEvent.create({
          amazon_account_id: aid,
          event_type: 'campaign_created',
          entity_type: 'campaign',
          entity_id: manualCampaignId,
          observation: `Automação §27: produto ${asin} (SKU: ${sku}) — AUTO: ${autoCampaignName} | MANUAL: ${manualCampaignName} | ${kwResult.created} keywords criadas com bid inicial ${SYMBOL}${INITIAL_BID.toFixed(2)}`,
          recorded_at: now,
        }).catch(() => {});

        summary.products_processed++;

        // Pausa entre produtos para respeitar rate limits Amazon
        await new Promise(r => setTimeout(r, 500));

      } catch (productError) {
        summary.errors.push(`${product.asin}: ${productError.message}`);
      }
    }

    return Response.json({
      ok: true,
      summary,
      rules: {
        initial_bid: `${SYMBOL} ${INITIAL_BID.toFixed(2)}`,
        min_confidence: `${(MIN_CONFIDENCE * 100).toFixed(0)}%`,
        max_keywords_per_cycle: MAX_KEYWORDS_CYCLE,
        currency: CURRENCY,
        bid_no_impressions_24h: `${SYMBOL} ${BID_NO_IMP_24H.toFixed(2)}`,
        bid_no_impressions_48h: `${SYMBOL} ${BID_NO_IMP_48H.toFixed(2)}`,
        bid_max_no_sale: `${SYMBOL} ${BID_MAX_NO_SALE.toFixed(2)}`,
        pause_after_clicks_no_sale: CLICKS_PAUSE,
      },
      duration_ms: Date.now() - startTime,
      executed_at: now,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});