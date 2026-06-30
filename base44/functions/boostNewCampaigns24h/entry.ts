/**
 * boostNewCampaigns24h — Ajuste de bids para campanhas novas nas primeiras 24 horas
 * 
 * Regra: Se uma campanha nova (AUTO ou MANUAL) não tiver impressões e não tiver gasto
 * nas primeiras 24 horas após criação, aumentar o bid em pelo menos R$0.10 ou 5% (o que for maior).
 * 
 * Após as primeiras 24h, as campanhas seguem as regras normais de otimização diária.
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
    const user = await base44.auth.me().catch(() => null);
    
    // Carregar todas as contas conectadas
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' });
    
    const summary = {
      accounts_processed: 0,
      campaigns_analyzed: 0,
      campaigns_eligible: 0,
      keywords_boosted: 0,
      keywords_unchanged: 0,
      errors: [],
    };
    
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    
    for (const account of accounts) {
      try {
        const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
        if (!refreshToken) continue;
        
        const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
        if (!profileId) continue;
        
        // Buscar campanhas criadas nas últimas 24 horas
        const recentCampaigns = await base44.asServiceRole.entities.Campaign.filter({
          amazon_account_id: account.id,
          created_by_app: true,
        });
        
        // Filtrar apenas campanhas com menos de 24h
        const newCampaigns = recentCampaigns.filter(c => {
          if (!c.created_at) return false;
          const createdAt = new Date(c.created_at);
          return createdAt > twentyFourHoursAgo;
        });
        
        if (newCampaigns.length === 0) continue;
        
        summary.campaigns_analyzed += newCampaigns.length;
        
        for (const campaign of newCampaigns) {
          // Verificar métricas da campanha (sem impressões e sem gasto)
          const impressions = campaign.impressions || 0;
          const spend = campaign.spend || 0;
          
          // Só aplicar boost se não teve impressões E não teve gasto
          if (impressions === 0 && spend === 0) {
            summary.campaigns_eligible++;
            
            // Buscar keywords desta campanha
            const keywords = await base44.asServiceRole.entities.Keyword.filter({
              amazon_account_id: account.id,
              campaign_id: campaign.campaign_id,
            });
            
            for (const kw of keywords) {
              try {
                const currentBid = kw.current_bid || kw.bid || 0.25;
                
                // Calcular aumento: R$0.10 ou 5% (o que for maior)
                const increasePercent = currentBid * 0.05;
                const increaseAmount = Math.max(0.10, increasePercent);
                const newBid = currentBid + increaseAmount;
                
                // Atualizar bid na Amazon Ads API
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
                    rationale: `Campanha nova (<24h) sem impressões/gasto. Boost: R$${increaseAmount.toFixed(2)} (${(increasePercent * 100).toFixed(1)}%)`,
                    rule_applied: 'new_campaign_24h_boost',
                    status: 'success',
                    amazon_response: JSON.stringify(resp.data).slice(0, 1000),
                    request_id: resp.requestId,
                    created_at: now.toISOString(),
                  });
                  
                  summary.keywords_boosted++;
                } else {
                  summary.errors.push(`Falha ao atualizar keyword ${kw.keyword_id}: HTTP ${resp.status}`);
                }
              } catch (kwError) {
                summary.errors.push(`Erro keyword ${kw.keyword_id}: ${kwError.message}`);
              }
            }
          } else {
            // Campanha já teve impressões ou gasto - não aplicar boost
            summary.keywords_unchanged += keywords?.length || 0;
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
      executed_at: now.toISOString(),
      rule: 'new_campaign_24h_boost',
      description: 'Aumento de bid para campanhas novas sem impressões/gasto nas primeiras 24h',
    });
    
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});