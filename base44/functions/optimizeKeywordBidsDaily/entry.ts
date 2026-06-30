/**
 * optimizeKeywordBidsDaily — Rotina diária de otimização de bids para campanhas do Acelerador.
 * 
 * Regras:
 * 1. Keywords sem impressões: aumentar bid em R$0.10 (até limite de R$2.00)
 * 2. Keywords com ACoS alto (>30%): reduzir bid em R$0.10
 * 3. Keywords com vendas e ACoS bom (<20%): manter ou aumentar R$0.05
 * 4. Respeitar intervalo mínimo de 24h entre alterações
 * 5. Logar todas as decisões
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

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    
    // Pode ser executado por scheduler (sem user)
    const user = await base44.auth.me().catch(() => null);
    
    // Carregar todas as contas conectadas
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' });
    
    const summary = {
      accounts_processed: 0,
      keywords_analyzed: 0,
      bids_increased: 0,
      bids_decreased: 0,
      bids_unchanged: 0,
      errors: [],
    };
    
    for (const account of accounts) {
      try {
        const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
        if (!refreshToken) continue;
        
        const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
        if (!profileId) continue;
        
        // Carregar keywords de campanhas MANUAIS criadas pelo app
        const keywords = await base44.asServiceRole.entities.Keyword.filter({
          amazon_account_id: account.id,
          source: 'manual',
        });
        
        if (keywords.length === 0) continue;
        
        summary.keywords_analyzed += keywords.length;
        const now = new Date();
        const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        
        for (const kw of keywords) {
          try {
            // Verificar se já houve alteração nas últimas 24h
            const recentChanges = await base44.asServiceRole.entities.CampaignCreationLog.filter({
              amazon_account_id: account.id,
              entity_type: 'keyword',
              entity_id: kw.keyword_id,
              operation_type: 'update_bid',
            });
            
            const lastChange = recentChanges.length > 0
              ? new Date(Math.max(...recentChanges.map(l => new Date(l.created_at).getTime())))
              : null;
            
            if (lastChange && lastChange > twentyFourHoursAgo) {
              summary.bids_unchanged++;
              continue;
            }
            
            // Analisar métricas
            const impressions = kw.impressions || 0;
            const clicks = kw.clicks || 0;
            const spend = kw.spend || 0;
            const sales = kw.sales || 0;
            const acos = kw.acos || 0;
            const currentBid = kw.current_bid || kw.bid || 0.50;
            
            let newBid = currentBid;
            let rationale = '';
            
            // Regra 1: Sem impressões
            if (impressions === 0 && currentBid < 2.00) {
              newBid = Math.min(currentBid + 0.10, 2.00);
              rationale = `Zero impressões. Bid aumentado de R$${currentBid.toFixed(2)} para R$${newBid.toFixed(2)}`;
              
              if (newBid === 2.00) {
                rationale += '. Limite máximo atingido — revisar keyword.';
              }
            }
            // Regra 2: ACoS alto (>30%)
            else if (acos > 30 && currentBid > 0.20) {
              newBid = Math.max(currentBid - 0.10, 0.20);
              rationale = `ACoS ${(acos).toFixed(1)}% > 30%. Bid reduzido de R$${currentBid.toFixed(2)} para R$${newBid.toFixed(2)}`;
            }
            // Regra 3: Cliques sem venda (gasto > R$2 sem venda)
            else if (clicks >= 5 && sales === 0 && spend >= 2 && currentBid > 0.20) {
              newBid = Math.max(currentBid - 0.10, 0.20);
              rationale = `${clicks} cliques, ${sales} vendas, gasto $${spend.toFixed(2)}. Bid reduzido para R$${newBid.toFixed(2)}`;
            }
            // Regra 4: Bom desempenho (vendas, ACoS <20%)
            else if (sales > 0 && acos > 0 && acos < 20 && currentBid < 2.00) {
              // Manter bid, talvez aumentar em outra rotina
              rationale = `Bom desempenho: ${sales} vendas, ACoS ${(acos).toFixed(1)}%. Bid mantido em R$${currentBid.toFixed(2)}`;
            }
            else {
              summary.bids_unchanged++;
              continue;
            }
            
            // Atualizar bid na Amazon Ads API
            if (newBid !== currentBid) {
              const updatePayload = {
                keywords: [{
                  keywordId: kw.keyword_id,
                  bid: newBid,
                }],
              };
              
              const resp = await adsRequest('PUT', '/sp/keywords', updatePayload, refreshToken, profileId, 'application/vnd.spKeyword.v3+json');
              
              if ([200, 207].includes(resp.status)) {
                // Atualizar no banco local
                await base44.asServiceRole.entities.Keyword.update(kw.id, {
                  current_bid: newBid,
                  bid: newBid,
                  last_seen_at: now.toISOString(),
                });
                
                // Log da alteração
                await base44.asServiceRole.entities.CampaignCreationLog.create({
                  amazon_account_id: account.id,
                  user_id: user?.id || 'scheduler',
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
                
                if (newBid > currentBid) summary.bids_increased++;
                else summary.bids_decreased++;
              } else {
                summary.errors.push(`Falha ao atualizar keyword ${kw.keyword_id}: HTTP ${resp.status}`);
              }
            }
          } catch (kwError) {
            summary.errors.push(`Erro keyword ${kw.keyword_id}: ${kwError.message}`);
          }
        }
        
        summary.accounts_processed++;
      } catch (accError) {
        summary.errors.push(`Erro conta ${account.id}: ${accError.message}`);
      }
    }
    
    return Response.json({
      ok: true,
      summary,
      executed_at: new Date().toISOString(),
    });
    
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});