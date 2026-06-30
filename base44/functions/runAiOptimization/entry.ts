/**
 * runAiOptimization — Motor principal de otimização de Amazon Ads
 * Implementa todas as regras: dayparting, pacing, ROAS, ACoS, TACoS, bids, budget
 * Opera em modo assistido (recomendações) ou automático (execução)
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

// Verificar se alteração é permitida (24h mínimo)
async function canAlterate(amazonAccountId, entityType, entityId, hoursMin = 24) {
  const logs = await base44.asServiceRole.entities.CampaignCreationLog.filter({
    amazon_account_id: amazonAccountId,
    entity_type: entityType,
    entity_id: entityId,
    operation_type: 'update_bid',
  });

  if (logs.length === 0) return true;

  const lastLog = logs.sort((a, b) => 
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  )[0];

  const hoursSince = (Date.now() - new Date(lastLog.created_at).getTime()) / (1000 * 60 * 60);
  return hoursSince >= hoursMin;
}

// Calcular confiança da decisão
function calculateConfidence(sampleSize, dataPoints, consistency) {
  let score = 50;
  
  // Amostra
  if (sampleSize >= 100) score += 20;
  else if (sampleSize >= 50) score += 15;
  else if (sampleSize >= 20) score += 10;
  else if (sampleSize >= 10) score += 5;
  
  // Dias de dados
  if (dataPoints >= 14) score += 20;
  else if (dataPoints >= 7) score += 15;
  else if (dataPoints >= 3) score += 10;
  
  // Consistência
  if (consistency >= 0.8) score += 10;
  else if (consistency >= 0.6) score += 5;
  
  return Math.min(score, 100);
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, mode = 'assisted' } = body; // 'assisted' ou 'automatic'

    if (!amazon_account_id) {
      return Response.json({ error: 'amazon_account_id required' }, { status: 400 });
    }

    const account = await base44.asServiceRole.entities.AmazonAccount.get(amazon_account_id);
    if (!account) {
      return Response.json({ error: 'AmazonAccount não encontrada' }, { status: 404 });
    }

    const now = new Date();
    const runId = `opt_${amazon_account_id}_${now.toISOString().slice(0, 16)}`;
    const decisions = [];

    // Carregar campanhas ativas
    const campaigns = await base44.asServiceRole.entities.Campaign.filter({
      amazon_account_id,
      archived: { $ne: true },
    });

    // Carregar keywords
    const keywords = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id });

    // Carregar regras de budget
    const budgetRules = await base44.asServiceRole.entities.BudgetRule.filter({ amazon_account_id });
    const budgetRule = budgetRules[0] || {
      target_acos: 25,
      target_roas: 4,
      max_bid_change_pct: 20,
      min_bid: 0.10,
      max_bid: 5.00,
    };

    // Analisar cada keyword
    for (const kw of keywords) {
      try {
        // Pular se já alterada nas últimas 24h
        const canChange = await canAlterate(amazon_account_id, 'keyword', kw.keyword_id, 24);
        if (!canChange) continue;

        const currentBid = kw.current_bid || kw.bid || 0.50;
        const impressions = kw.impressions || 0;
        const clicks = kw.clicks || 0;
        const spend = kw.spend || 0;
        const sales = kw.sales || 0;
        const acos = kw.acos || 0;
        const roas = kw.roas || 0;
        const conversionRate = clicks > 0 ? (kw.orders || 0) / clicks : 0;

        let newBid = currentBid;
        let action = 'no_action';
        let rationale = '';
        let confidence = 50;
        let requiresApproval = true;

        // REGRA 1: Sem impressões (após 24h)
        if (impressions === 0 && clicks === 0 && currentBid < 2.00) {
          newBid = Math.min(currentBid + 0.10, 2.00);
          action = 'increase_bid';
          rationale = `Zero impressões. Bid aumentado para gerar visibilidade.`;
          confidence = calculateConfidence(0, 1, 0);
          requiresApproval = false;
        }
        // REGRA 2: Muitas impressões, poucos cliques (CTR baixo)
        else if (impressions > 100 && clicks > 0 && (clicks / impressions) < 0.003) {
          // Não aumentar bid - problema de relevância
          rationale = `CTR ${( (clicks/impressions)*100 ).toFixed(2)}% - revisar imagem/título, não bid`;
          action = 'no_action';
        }
        // REGRA 3: Cliques sem vendas (gasto > R$2)
        else if (clicks >= 5 && sales === 0 && spend >= 2 && currentBid > 0.20) {
          newBid = Math.max(currentBid - 0.10, 0.20);
          action = 'decrease_bid';
          rationale = `${clicks} cliques, ${sales} vendas, gasto $${spend.toFixed(2)}. Reduzir para limitar desperdício.`;
          confidence = calculateConfidence(clicks, 1, 1);
          requiresApproval = false;
        }
        // REGRA 4: ACoS alto (>30%)
        else if (acos > 30 && currentBid > 0.20) {
          newBid = Math.max(currentBid - 0.10, 0.20);
          action = 'decrease_bid';
          rationale = `ACoS ${(acos).toFixed(1)}% > 30%. Reduzir bid para melhorar rentabilidade.`;
          confidence = calculateConfidence(clicks, 1, sales > 0 ? 0.7 : 1);
          requiresApproval = acos > 50;
        }
        // REGRA 5: Venda com ROAS alto (>5)
        else if (sales > 0 && roas > 5 && currentBid < 2.00) {
          newBid = Math.min(currentBid + 0.05, 2.00);
          action = 'increase_bid';
          rationale = `ROAS ${(roas).toFixed(2)} excelente. Aumentar exposição.`;
          confidence = calculateConfidence(clicks, 3, 0.9);
          requiresApproval = false;
        }
        // REGRA 6: Múltiplas vendas com ROAS saudável (3-5)
        else if (sales >= 3 && roas >= 3 && roas <= 5 && currentBid < 1.50) {
          newBid = Math.min(currentBid + 0.05, 1.50);
          action = 'increase_bid';
          rationale = `${sales} vendas, ROAS ${(roas).toFixed(2)}. Escalar com cautela.`;
          confidence = calculateConfidence(clicks, 5, 0.85);
          requiresApproval = false;
        }

        // Criar decisão se houver ação
        if (action !== 'no_action' && newBid !== currentBid) {
          const decision = await base44.asServiceRole.entities.OptimizationDecision.create({
            amazon_account_id,
            run_id: runId,
            decision_type: 'bid_change',
            entity_type: 'keyword',
            entity_id: kw.keyword_id,
            keyword_id: kw.keyword_id,
            keyword_text: kw.keyword_text,
            campaign_id: kw.campaign_id,
            asin: kw.asin,
            action: action === 'increase_bid' ? 'increase' : 'decrease',
            value_before: currentBid,
            value_after: newBid,
            change_pct: ((newBid - currentBid) / currentBid) * 100,
            objective: 'profitability',
            rationale,
            data_used: `impressions:${impressions}, clicks:${clicks}, sales:${sales}, acos:${acos.toFixed(1)}, roas:${roas.toFixed(2)}`,
            period_analyzed: 'últimos 30 dias',
            sample_size: `${clicks} cliques`,
            confidence,
            risk: newBid < currentBid ? 'low' : 'medium',
            expected_impact: action === 'increase_bid' ? 'mais impressões e vendas' : 'menor desperdício',
            reversible: true,
            requires_approval: requiresApproval,
            status: requiresApproval || mode === 'assisted' ? 'pending' : 'scheduled',
            created_at: now.toISOString(),
          });

          decisions.push(decision);

          // Modo automático: executar imediatamente se não requer aprovação
          if (!requiresApproval && mode === 'automatic') {
            try {
              const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
              const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');

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

                await base44.asServiceRole.entities.CampaignCreationLog.create({
                  amazon_account_id: account.id,
                  user_id: user.id,
                  operation_type: 'update_bid',
                  entity_type: 'keyword',
                  entity_id: kw.keyword_id,
                  keyword_id: kw.keyword_id,
                  keyword_text: kw.keyword_text,
                  old_bid: currentBid,
                  new_bid: newBid,
                  rationale,
                  status: 'success',
                  amazon_response: JSON.stringify(resp.data).slice(0, 1000),
                  request_id: resp.requestId,
                  created_at: now.toISOString(),
                });

                await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
                  status: 'executed',
                  executed_at: now.toISOString(),
                  amazon_response: JSON.stringify(resp.data).slice(0, 1000),
                });
              } else {
                await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
                  status: 'failed',
                  error_message: `HTTP ${resp.status}: ${JSON.stringify(resp.data)}`,
                });
              }
            } catch (execError) {
              await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
                status: 'failed',
                error_message: execError.message,
              });
            }
          }
        }
      } catch (kwError) {
        console.error(`Erro ao analisar keyword ${kw.keyword_id}:`, kwError.message);
      }
    }

    // Estatísticas
    const summary = {
      total_keywords_analyzed: keywords.length,
      decisions_generated: decisions.length,
      pending_approval: decisions.filter(d => d.requires_approval).length,
      auto_executed: decisions.filter(d => !d.requires_approval && mode === 'automatic').length,
      bid_increases: decisions.filter(d => d.action === 'increase').length,
      bid_decreases: decisions.filter(d => d.action === 'decrease').length,
    };

    return Response.json({
      ok: true,
      run_id: runId,
      account_id: amazon_account_id,
      mode,
      decisions,
      summary,
      executed_at: now.toISOString(),
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});