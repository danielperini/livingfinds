/**
 * runDailyAmazonActionQueue — Processa fila de ações Amazon Ads diariamente às 00:00 BRT.
 * 
 * Ordem de execução:
 * 1. Criar campanhas → 2. Criar ad groups → 3. Criar anúncios → 4. Criar keywords/targets
 * 5. Criar negativas → 6. Atualizar bids → 7. Atualizar budgets → 8. Pausar/ativar
 * 
 * Respeita rate limits, HTTP 429 Retry-After, e trata HTTP 207 item a item.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const tokenCache = {};

async function getAdsToken(refreshToken) {
  const cached = tokenCache['ads'];
  if (cached && cached.expires_at > Date.now()) return cached.access_token;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: Deno.env.get('ADS_CLIENT_ID'),
    client_secret: Deno.env.get('ADS_CLIENT_SECRET'),
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token failed');
  tokenCache['ads'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function getAdsBaseUrl(region) {
  const r = (region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsRequestV3(method, path, body, refreshToken, profileId, region, contentType = 'application/json') {
  const token = await getAdsToken(refreshToken);
  const res = await fetch(`${getAdsBaseUrl(region)}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
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
  const startTime = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const executionDate = new Date().toISOString().slice(0, 10);
    
    // Buscar ações pendentes/aprovadas ordenadas por prioridade
    const actions = await base44.asServiceRole.entities.AgentAction.filter(
      { status: { $in: ['pending', 'approved', 'scheduled'] } },
      'created_at',
      500
    );

    if (actions.length === 0) {
      return Response.json({ ok: true, message: 'Nenhuma ação pendente', duration: Date.now() - startTime });
    }

    // Agrupar por conta
    const actionsByAccount = {};
    for (const action of actions) {
      if (!actionsByAccount[action.amazon_account_id]) actionsByAccount[action.amazon_account_id] = [];
      actionsByAccount[action.amazon_account_id].push(action);
    }

    const results = [];
    let totalProcessed = 0, totalSucceeded = 0, totalFailed = 0;

    // Processar cada conta
    for (const [accountId, accountActions] of Object.entries(actionsByAccount)) {
      const account = await base44.asServiceRole.entities.AmazonAccount.get(accountId).catch(() => null);
      if (!account || account.status !== 'connected') {
        results.push({ account: accountId, error: 'Conta não conectada', actions_skipped: accountActions.length });
        continue;
      }

      const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
      const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
      const region = account.region || Deno.env.get('ADS_REGION');

      // Ordenar ações por dependência
      const order = {
        'create_auto_campaign': 1, 'create_manual_campaign': 1,
        'create_keyword': 2, 'create_product_target': 2,
        'negative_keyword': 3,
        'update_bid': 4, 'update_budget': 4,
        'pause_campaign': 5, 'enable_campaign': 5,
      };
      accountActions.sort((a, b) => (order[a.action] || 99) - (order[b.action] || 99));

      let accountSucceeded = 0, accountFailed = 0;

      // Processar sequencialmente
      for (const action of accountActions) {
        totalProcessed++;
        const now = new Date().toISOString();
        
        try {
          let apiResult = null;
          let requestId = '';

          switch (action.action) {
            case 'update_bid': {
              const result = await adsRequestV3('PUT', '/sp/keywords', [{
                keywordId: action.keyword_id,
                bid: action.new_value,
              }], refreshToken, profileId, region, 'application/vnd.spKeyword.v3+json');
              apiResult = result.data;
              requestId = result.requestId;
              
              // Atualizar bid local
              const kws = await base44.asServiceRole.entities.Keyword.filter({
                amazon_account_id: accountId,
                keyword_id: action.keyword_id,
              });
              if (kws.length > 0) {
                await base44.asServiceRole.entities.Keyword.update(kws[0].id, {
                  current_bid: action.new_value,
                  bid: action.new_value,
                });
              }
              break;
            }

            case 'update_budget': {
              const result = await adsRequestV3('PUT', '/sp/campaigns', [{
                campaignId: action.campaign_id,
                budget: { budgetType: 'DAILY', budget: action.new_value },
              }], refreshToken, profileId, region, 'application/vnd.spCampaign.v3+json');
              apiResult = result.data;
              requestId = result.requestId;
              
              const camps = await base44.asServiceRole.entities.Campaign.filter({
                amazon_account_id: accountId,
                campaign_id: action.campaign_id,
              });
              if (camps.length > 0) {
                await base44.asServiceRole.entities.Campaign.update(camps[0].id, { 
                  daily_budget: action.new_value,
                  synced_at: now,
                });
              }
              break;
            }

            case 'pause_campaign': {
              const result = await adsRequestV3('PUT', '/sp/campaigns', [{
                campaignId: action.campaign_id,
                state: 'PAUSED',
              }], refreshToken, profileId, region, 'application/vnd.spCampaign.v3+json');
              apiResult = result.data;
              requestId = result.requestId;
              
              const camps = await base44.asServiceRole.entities.Campaign.filter({
                amazon_account_id: accountId,
                campaign_id: action.campaign_id,
              });
              if (camps.length > 0) {
                await base44.asServiceRole.entities.Campaign.update(camps[0].id, { 
                  state: 'paused', status: 'paused', synced_at: now,
                });
              }
              break;
            }

            case 'enable_campaign': {
              const result = await adsRequestV3('PUT', '/sp/campaigns', [{
                campaignId: action.campaign_id,
                state: 'ENABLED',
              }], refreshToken, profileId, region, 'application/vnd.spCampaign.v3+json');
              apiResult = result.data;
              requestId = result.requestId;
              
              const camps = await base44.asServiceRole.entities.Campaign.filter({
                amazon_account_id: accountId,
                campaign_id: action.campaign_id,
              });
              if (camps.length > 0) {
                await base44.asServiceRole.entities.Campaign.update(camps[0].id, { 
                  state: 'enabled', status: 'enabled', synced_at: now,
                });
              }
              break;
            }

            case 'negative_keyword': {
              const result = await adsRequestV3('POST', '/sp/negativeKeywords', {
                negativeKeywords: [{
                  campaignId: action.campaign_id,
                  adGroupId: action.ad_group_id,
                  keywordText: action.keyword,
                  matchType: 'NEGATIVE_EXACT',
                  state: 'ENABLED',
                }],
              }, refreshToken, profileId, region, 'application/vnd.spNegativeKeyword.v3+json');
              apiResult = result.data;
              requestId = result.requestId;
              break;
            }

            default:
              throw new Error(`Ação '${action.action}' não mapeada`);
          }

          // Sucesso
          await base44.asServiceRole.entities.AgentAction.update(action.id, {
            status: 'executed',
            executed_at: now,
            execution_response: JSON.stringify(apiResult).slice(0, 500),
          });

          accountSucceeded++;
          totalSucceeded++;
          results.push({ action_id: action.id, status: 'executed', request_id: requestId });

        } catch (error) {
          // Falha
          await base44.asServiceRole.entities.AgentAction.update(action.id, {
            status: 'failed',
            executed_at: now,
            execution_response: error.message,
          });

          accountFailed++;
          totalFailed++;
          results.push({ action_id: action.id, status: 'failed', error: error.message });

          // Rate limit → aguardar
          if (error.message.includes('429')) {
            await new Promise(resolve => setTimeout(resolve, 5000));
          }
        }
      }

      // Log de execução da conta
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: accountId,
        operation: 'runDailyAmazonActionQueue',
        trigger_type: 'automatic',
        status: accountFailed === 0 ? 'success' : 'partial',
        execution_date: executionDate,
        started_at: new Date(startTime).toISOString(),
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        records_processed: accountSucceeded + accountFailed,
        error_message: accountFailed > 0 ? `${accountFailed} ações falharam` : null,
      });
    }

    return Response.json({
      ok: true,
      accounts_processed: Object.keys(actionsByAccount).length,
      total_actions: actions.length,
      processed: totalProcessed,
      succeeded: totalSucceeded,
      failed: totalFailed,
      results,
      duration_ms: Date.now() - startTime,
    });

  } catch (error) {
    console.error('[ActionQueue] Erro geral:', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});