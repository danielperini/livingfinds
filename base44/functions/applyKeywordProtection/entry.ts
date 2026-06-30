/**
 * applyKeywordProtection — Aplica regras de proteção contra prejuízo
 * Calcula limite econômico, aplica redução de bid/pausa/negativação conforme regras
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const tokenCache = {};

async function getAdsToken(refreshToken) {
  const cached = tokenCache['ads'];
  if (cached && cached.expires_at > Date.now() + 5000) return cached.access_token;
  
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: Deno.env.get('ADS_CLIENT_ID') || '',
    client_secret: Deno.env.get('ADS_CLIENT_SECRET') || '',
  });
  
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Token failed');
  
  tokenCache['ads'] = {
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
  };
  return data.access_token;
}

function getAdsBaseUrl() {
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsRequest(method, path, body, refreshToken, profileId, contentType = 'application/json') {
  const token = await getAdsToken(refreshToken);
  const res = await fetch(`${getAdsBaseUrl()}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': contentType,
      'Accept': contentType,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data, requestId: res.headers.get('x-amzn-requestid') || '' };
}

// Calcular fator de tolerância baseado no estágio do produto
function getToleranceFactor(product) {
  const daysSinceLaunch = product.days_since_launch || 0;
  const totalSales = product.total_sales_30d || 0;
  
  if (daysSinceLaunch <= 14) return 1.0; // Lançamento: 100%
  if (daysSinceLaunch <= 30) return 0.8; // Crescimento: 80%
  if (totalSales >= 50) return 0.6; // Rentabilidade: 60%
  return 0.4; // Margem apertada: 40%
}

// Verificar se alteração é permitida (24h mínimo)
async function canAlterate(amazonAccountId, keywordId, hoursMin = 24) {
  const logs = await base44.asServiceRole.entities.KeywordProtectionLog.filter({
    amazon_account_id: amazonAccountId,
    keyword_id: keywordId,
  });

  if (logs.length === 0) return { allowed: true, lastChange: null };

  const lastLog = logs.sort((a, b) => 
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  )[0];

  const hoursSince = (Date.now() - new Date(lastLog.created_at).getTime()) / (1000 * 60 * 60);
  return { allowed: hoursSince >= hoursMin, lastChange: lastLog, hoursSince };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, keyword_id, asin, mode = 'assisted' } = body;

    if (!amazon_account_id) {
      return Response.json({ error: 'amazon_account_id required' }, { status: 400 });
    }

    const account = await base44.asServiceRole.entities.AmazonAccount.get(amazon_account_id);
    if (!account) {
      return Response.json({ error: 'AmazonAccount não encontrada' }, { status: 404 });
    }

    const now = new Date();
    const actions = [];

    // Carregar keywords
    let keywords = [];
    if (keyword_id) {
      keywords = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id, keyword_id });
    } else if (asin) {
      keywords = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id, asin });
    } else {
      keywords = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id });
    }

    // Carregar produtos para cálculo de margem
    const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id });
    const productMap = {};
    for (const p of products) {
      productMap[p.asin] = p;
    }

    for (const kw of keywords) {
      try {
        const product = productMap[kw.asin];
        
        // === CÁLCULO DO LIMITE ECONÔMICO ===
        const price = product?.price || 0;
        const estimatedCost = price * 0.4; // Simplificado: 40% do preço
        const amazonFees = price * 0.15; // 15% taxas
        const logistics = 10; // Fixo simplificado
        
        const profitBeforeAds = price - estimatedCost - amazonFees - logistics;
        const toleranceFactor = product ? getToleranceFactor(product) : 0.6;
        const economicLimit = profitBeforeAds * toleranceFactor;

        // Métricas atuais
        const spend = kw.spend || 0;
        const clicks = kw.clicks || 0;
        const sales = kw.sales || 0;
        const orders = kw.orders || 0;
        const acos = kw.acos || 0;
        const roas = kw.roas || 0;
        const currentBid = kw.current_bid || kw.bid || 0.50;

        // Calcular quanto do limite já foi consumido
        const limitReachedPct = economicLimit > 0 ? (spend / economicLimit) * 100 : 0;

        // === CLASSIFICAÇÃO DE RISCO ===
        let riskLevel = 'low';
        let action = 'maintain';
        let rationale = '';
        let newBid = currentBid;

        // Risco crítico: gasto acima do limite econômico sem venda
        if (spend >= economicLimit * 1.5 && orders === 0) {
          riskLevel = 'critical';
          action = 'negative_exact';
          rationale = `Gasto R$${spend.toFixed(2)} (150% do limite R$${economicLimit.toFixed(2)}) sem vendas`;
        }
        // Gasto acima de 100% do limite sem venda
        else if (spend >= economicLimit && orders === 0) {
          riskLevel = 'critical';
          action = 'pause';
          rationale = `Gasto R$${spend.toFixed(2)} atingiu limite econômico de R$${economicLimit.toFixed(2)} sem vendas`;
        }
        // Gasto entre 75-100% do limite sem venda
        else if (spend >= economicLimit * 0.75 && orders === 0) {
          riskLevel = 'high';
          action = 'reduce_bid';
          newBid = Math.max(currentBid - 0.10, 0.20);
          rationale = `Gasto R$${spend.toFixed(2)} em 75% do limite. Reduzir bid de R$${currentBid.toFixed(2)} para R$${newBid.toFixed(2)}`;
        }
        // 10+ cliques sem venda
        else if (clicks >= 10 && orders === 0) {
          riskLevel = 'high';
          action = 'reduce_bid';
          newBid = Math.max(currentBid - 0.10, 0.20);
          rationale = `${clicks} cliques sem vendas. Reduzir bid para limitar desperdício`;
        }
        // 7-9 cliques sem venda
        else if (clicks >= 7 && orders === 0) {
          riskLevel = 'moderate';
          action = 'reduce_bid';
          newBid = Math.max(currentBid - 0.05, 0.25);
          rationale = `${clicks} cliques sem vendas. Redução preventiva de bid`;
        }
        // ACoS muito alto (com vendas)
        else if (orders > 0 && acos > 50) {
          riskLevel = 'high';
          action = 'reduce_bid';
          newBid = Math.max(currentBid - 0.10, 0.20);
          rationale = `ACoS ${(acos).toFixed(1)}% muito elevado. Reduzir para melhorar rentabilidade`;
        }
        // ACoS acima da meta (com vendas)
        else if (orders > 0 && acos > 30) {
          riskLevel = 'moderate';
          action = 'reduce_bid';
          newBid = Math.max(currentBid - 0.05, 0.30);
          rationale = `ACoS ${(acos).toFixed(1)}% acima da meta. Ajuste moderado`;
        }
        // Risco baixo: dentro dos limites
        else {
          riskLevel = 'low';
          action = 'maintain';
          rationale = 'Dentro dos limites aceitáveis';
        }

        // Verificar se pode alterar (24h mínimo)
        const { allowed: canChange, lastChange, hoursSince } = await canAlterate(amazon_account_id, kw.keyword_id, 24);
        
        if (!canChange && action !== 'maintain') {
          rationale += ` (Alteração bloqueada: última mudança há ${hoursSince.toFixed(1)}h)`;
          action = 'maintain'; // Não aplicar alteração
        }

        // Aplicar ação se permitido e necessário
        if (action !== 'maintain' && canChange && mode === 'automatic') {
          try {
            const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
            const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');

            if (action === 'reduce_bid' && newBid !== currentBid) {
              const updatePayload = {
                keywords: [{
                  keywordId: kw.keyword_id,
                  bid: newBid,
                }],
              };

              const resp = await adsRequest('PUT', '/sp/keywords', updatePayload, refreshToken, profileId, 'application/vnd.spKeyword.v3+json');

              if ([200, 207].includes(resp.status)) {
                await base44.asServiceRole.entities.Keyword.update(kw.id, {
                  current_bid: newBid,
                  bid: newBid,
                  last_seen_at: now.toISOString(),
                });

                action = 'bid_reduced';
              }
            } else if (action === 'pause') {
              const updatePayload = {
                keywords: [{
                  keywordId: kw.keyword_id,
                  state: 'PAUSED',
                }],
              };

              const resp = await adsRequest('PUT', '/sp/keywords', updatePayload, refreshToken, profileId, 'application/vnd.spKeyword.v3+json');

              if ([200, 207].includes(resp.status)) {
                await base44.asServiceRole.entities.Keyword.update(kw.id, {
                  state: 'paused',
                  status: 'paused',
                });
                action = 'paused';
              }
            }
          } catch (execError) {
            console.error(`Erro ao aplicar ação para ${kw.keyword_text}:`, execError.message);
            rationale += ` [Erro na execução: ${execError.message}]`;
          }
        }

        // Salvar log
        const log = await base44.asServiceRole.entities.KeywordProtectionLog.create({
          amazon_account_id,
          keyword_id: kw.keyword_id,
          keyword_text: kw.keyword_text,
          search_term: kw.keyword_text,
          campaign_id: kw.campaign_id,
          ad_group_id: kw.ad_group_id,
          asin: kw.asin,
          match_type: kw.match_type,
          spend_accumulated: spend,
          clicks_accumulated: clicks,
          sales_accumulated: sales,
          orders_accumulated: orders,
          acos,
          roas,
          profit_before_ads: parseFloat(profitBeforeAds.toFixed(2)),
          economic_limit: parseFloat(economicLimit.toFixed(2)),
          tolerance_factor: toleranceFactor,
          limit_reached_pct: parseFloat(limitReachedPct.toFixed(1)),
          risk_level: riskLevel,
          action_taken: action,
          bid_before: currentBid,
          bid_after: newBid,
          rationale,
          relevance_score: 75, // Simplificado
          days_analyzed: kw.first_seen_at ? 
            Math.floor((Date.now() - new Date(kw.first_seen_at).getTime()) / (1000 * 60 * 60 * 24)) : 0,
          data_maturity: clicks >= 20 ? 'mature' : clicks >= 10 ? 'maturing' : 'provisional',
          can_reactivate: action === 'pause' || action === 'negative_exact',
          reactivation_requirements: action === 'pause' ? 
            ['Revisão de preço', 'Melhoria no listing', 'Nova estratégia'] : 
            ['Autorização manual', 'Mudança de contexto'],
          created_at: now.toISOString(),
        });

        actions.push({
          keyword_id: kw.keyword_id,
          keyword_text: kw.keyword_text,
          asin: kw.asin,
          risk_level: riskLevel,
          action: action,
          rationale,
          economic_limit: parseFloat(economicLimit.toFixed(2)),
          limit_reached_pct: parseFloat(limitReachedPct.toFixed(1)),
          bid_before: currentBid,
          bid_after: newBid,
          executed: canChange && mode === 'automatic',
          log_id: log.id,
        });

      } catch (kwError) {
        console.error(`Erro ao processar keyword ${kw.keyword_id}:`, kwError.message);
      }
    }

    // Estatísticas
    const stats = {
      total: actions.length,
      critical: actions.filter(a => a.risk_level === 'critical').length,
      high: actions.filter(a => a.risk_level === 'high').length,
      moderate: actions.filter(a => a.risk_level === 'moderate').length,
      low: actions.filter(a => a.risk_level === 'low').length,
      actions_taken: actions.filter(a => a.action !== 'maintain').length,
      bids_reduced: actions.filter(a => a.action === 'bid_reduced').length,
      paused: actions.filter(a => a.action === 'paused').length,
      negatives: actions.filter(a => a.action === 'negative_exact' || a.action === 'negative_phrase').length,
    };

    return Response.json({
      ok: true,
      account_id: amazon_account_id,
      analyzed_at: now.toISOString(),
      mode,
      actions,
      stats,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});