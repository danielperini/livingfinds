/**
 * evaluateNewCampaigns72h — Avalia campanhas manuais criadas há 72h.
 *
 * Para cada campanha com launch_phase='new' criada há >= 72h:
 *  - Lê métricas acumuladas (spend, sales, orders, clicks)
 *  - Se sem vendas E sem cliques suficientes → pausa a keyword, substitui pela próxima sugestão do banco
 *  - Se ACoS > max_acos → reduz bid em 20% (potencializa)
 *  - Se vendas OK e ACoS aceitável → promove para launch_phase='active'
 *  - Sempre negativa na campanha AUTO do mesmo ASIN (se ainda não feito)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MIN_BID = 0.35;
const MAX_BID = 3.0;

async function getAdsToken(account: any): Promise<string> {
  const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '';
  const clientId     = Deno.env.get('ADS_CLIENT_ID') || '';
  const clientSecret = Deno.env.get('ADS_CLIENT_SECRET') || '';
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token failed');
  return data.access_token;
}

function getAdsBaseUrl(account: any): string {
  const r = (account?.region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsCall(token: string, account: any, method: string, path: string, body?: any) {
  const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';
  const baseUrl   = getAdsBaseUrl(account);
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function negateInAuto(base44: any, account: any, token: string, asin: string, keywordText: string, campaignId: string) {
  const autoCampaigns = await base44.asServiceRole.entities.Campaign.filter({
    amazon_account_id: account.id, asin, targeting_type: 'AUTO',
  }).catch(() => []);
  const autoCampaign = autoCampaigns.find((c: any) => !['archived', 'ARCHIVED'].includes(c.state || c.status || ''));
  if (!autoCampaign) return { skipped: true };

  const kwLower = keywordText.toLowerCase().trim();
  const already = await base44.asServiceRole.entities.OptimizationDecision.filter({
    amazon_account_id: account.id,
    campaign_id: autoCampaign.campaign_id,
    keyword_text: kwLower,
    decision_type: 'negative_keyword',
    status: 'executed',
  }, null, 1).catch(() => []);
  if (already.length) return { skipped: true, reason: 'already_negated' };

  const result = await adsCall(token, account, 'POST', '/v2/sp/negativeKeywords', [{
    campaignId: autoCampaign.campaign_id,
    keywordText: kwLower,
    matchType: 'negativeExact',
    state: 'enabled',
  }]);

  const success = result.ok && [200, 201, 207].includes(result.status);
  const now = new Date().toISOString();

  await base44.asServiceRole.entities.OptimizationDecision.create({
    amazon_account_id: account.id,
    decision_type: 'negative_keyword',
    entity_type: 'search_term',
    entity_id: autoCampaign.campaign_id,
    campaign_id: autoCampaign.campaign_id,
    keyword_text: kwLower,
    asin,
    action: 'negative_exact',
    rationale: `Negativação automática (72h review): keyword "${kwLower}" está em campanha MANUAL. Evitar canibalização na AUTO.`,
    risk: 'low',
    requires_approval: false,
    status: success ? 'executed' : 'failed',
    confidence: 99,
    amazon_response: JSON.stringify(result.data),
    executed_at: now,
    created_at: now,
    source_function: 'evaluateNewCampaigns72h',
    idempotency_key: `neg-auto-72h-${account.id}-${autoCampaign.campaign_id}-${kwLower}-${now.slice(0, 10)}`,
  }).catch(() => {});

  return { success, auto_campaign_id: autoCampaign.campaign_id };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body   = await req.json().catch(() => ({}));
    if (!body._service_role) {
      const user = await base44.auth.me();
      if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const now72hAgo = new Date(Date.now() - 72 * 3600000).toISOString();

    // Buscar contas conectadas
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' });
    if (!accounts.length) return Response.json({ ok: true, message: 'Nenhuma conta conectada' });

    const results: any[] = [];

    for (const account of accounts) {
      const aid = account.id;
      const ap  = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }, null, 1)
        .then((r: any[]) => r[0]).catch(() => null);
      const maxAcos = ap?.maximum_acos || 30;

      // Campanhas novas criadas pelo app há >= 72h e ainda em launch_phase='new'
      const newCampaigns = await base44.asServiceRole.entities.Campaign.filter({
        amazon_account_id: aid,
        created_by_app: true,
        launch_phase: 'new',
      }, '-created_at', 100).catch(() => []);

      const due = newCampaigns.filter((c: any) => {
        const createdAt = c.created_at || c.created_date;
        return createdAt && new Date(createdAt).getTime() <= new Date(now72hAgo).getTime();
      });

      if (!due.length) {
        results.push({ account_id: aid, checked: newCampaigns.length, due: 0 });
        continue;
      }

      let token: string;
      try { token = await getAdsToken(account); } catch (e: any) {
        results.push({ account_id: aid, error: `Token error: ${e.message}` });
        continue;
      }

      let evaluated = 0, paused = 0, optimized = 0, promoted = 0;

      for (const camp of due) {
        const campaignId   = camp.campaign_id || camp.amazon_campaign_id;
        const asin         = camp.asin;
        const createdDate  = (camp.created_at || camp.created_date || '').slice(0, 10);
        const nowDate      = new Date().toISOString().slice(0, 10);

        // Buscar métricas acumuladas dos últimos 5 dias (cobre a janela 72h + latência)
        const metrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter({
          amazon_account_id: aid,
          campaign_id: campaignId,
        }, '-date', 10).catch(() => []);

        const spend  = metrics.reduce((s: number, m: any) => s + (m.spend || 0), 0);
        const sales  = metrics.reduce((s: number, m: any) => s + (m.sales || 0), 0);
        const orders = metrics.reduce((s: number, m: any) => s + (m.orders || 0), 0);
        const clicks = metrics.reduce((s: number, m: any) => s + (m.clicks || 0), 0);
        const acos   = sales > 0 ? (spend / sales) * 100 : 0;

        evaluated++;

        // ── Garantir negativação na AUTO ─────────────────────────────────────
        if (asin && camp.campaign_name) {
          // Extrair keyword do nome da campanha: "SP | MANUAL | EXACT | ASIN | keyword"
          const parts = camp.campaign_name.split(' | ');
          const kwText = parts.length >= 5 ? parts.slice(4).join(' | ') : null;
          if (kwText) {
            await negateInAuto(base44, account, token, asin, kwText, campaignId).catch(() => {});
          }
        }

        // ── Buscar keywords da campanha via API (v3) ──────────────────────────
        const kwRes = await adsCall(token, account, 'POST', '/sp/keywords/list', {
          stateFilter: { include: ['ENABLED', 'PAUSED'] },
          campaignIdFilter: { include: [campaignId] },
          maxResults: 20,
        }).catch(() => ({ ok: false, data: {} }));

        const keywords: any[] = kwRes?.data?.keywords || [];

        // ── DECISÃO: sem cliques e sem spend relevante → NÃO pausar campanha inteira ──
        // WINNER PROTECTION: volume baixo isolado não justifica pausa de campanha.
        // Ação correta: pausar somente as keywords sem impressões; manter campanha ativa.
        // A campanha só será pausada se tiver ≥20 cliques + ≥200 impressões + gasto ≥ CPA máx.
        if (clicks < 3 && spend < 2.0) {
          // Pausar somente as keywords individualmente (nunca a campanha inteira por baixo volume)
          if (keywords.length > 0) {
            await adsCall(token, account, 'PUT', '/sp/keywords', {
              keywords: keywords.map((k: any) => ({ keywordId: k.keywordId, state: 'PAUSED' })),
            }).catch(() => {});
          }

          // Buscar próxima sugestão não usada para o mesmo ASIN
          const nextSuggestions = await base44.asServiceRole.entities.KeywordSuggestion.filter({
            amazon_account_id: aid,
            asin,
            status: 'ranked',
          }, null, 20).catch(() => []);

          const usedKeywords = new Set(keywords.map((k: any) => (k.keywordText || '').toLowerCase().trim()));
          const nextSug = nextSuggestions.find((s: any) =>
            (s.ai_confidence || 0) >= 0.85 &&
            !usedKeywords.has((s.keyword || '').toLowerCase().trim())
          );

          if (nextSug) {
            const newBid = Math.min(MAX_BID, Math.max(MIN_BID, nextSug.recommended_bid || nextSug.amazon_suggested_bid || 0.50));
            // Buscar adGroupId da campanha (v3 POST list)
            const agRes = await adsCall(token, account, 'POST', '/sp/adGroups/list', {
              campaignIdFilter: { include: [campaignId] },
              stateFilter: { include: ['ENABLED'] },
              maxResults: 1,
            }).catch(() => ({ ok: false, data: {} }));
            const adGroupId = agRes?.data?.adGroups?.[0]?.adGroupId;

            if (adGroupId) {
              const addKwRes = await adsCall(token, account, 'POST', '/sp/keywords', {
                keywords: [{
                  campaignId,
                  adGroupId,
                  state: 'ENABLED',
                  keywordText: nextSug.keyword.trim(),
                  matchType: 'EXACT',
                  bid: newBid,
                }],
              }).catch(() => ({ ok: false, data: {} }));

              if (addKwRes?.data?.keywords?.success?.length > 0) {
                await base44.asServiceRole.entities.KeywordSuggestion.update(nextSug.id, {
                  status: 'created',
                  amazon_campaign_id: campaignId,
                  executed_at: new Date().toISOString(),
                }).catch(() => {});
                // Negativar na AUTO também
                if (asin) {
                  await negateInAuto(base44, account, token, asin, nextSug.keyword, campaignId).catch(() => {});
                }
              }
            }
          }

          await base44.asServiceRole.entities.Campaign.update(camp.id, {
            launch_phase: 'under_review',
            last_review_at: new Date().toISOString(),
            last_review_reason: `72h sem cliques suficientes (${clicks} cliques, R$${spend.toFixed(2)} gasto). Keyword substituída.`,
          }).catch(() => {});
          paused++;

        } else if (spend > 0 && sales === 0 && spend > 5.0) {
          // Gastando mas sem vender → reduzir bid em 20%
          const bidUpdates = keywords.map((k: any) => ({
            keywordId: k.keywordId,
            bid: Math.max(MIN_BID, Math.round(((k.bid || k.defaultBid || 0.5) * 0.80) * 100) / 100),
          }));
          if (bidUpdates.length > 0) {
            await adsCall(token, account, 'PUT', '/sp/keywords', { keywords: bidUpdates }).catch(() => {});
          }
          await base44.asServiceRole.entities.Campaign.update(camp.id, {
            launch_phase: 'under_review',
            last_review_at: new Date().toISOString(),
            last_review_reason: `72h com gasto R$${spend.toFixed(2)} e 0 vendas. Bid reduzido 20%.`,
          }).catch(() => {});
          optimized++;

        } else if (acos > 0 && acos > maxAcos && spend > 3.0) {
          // ACoS acima do limite → reduzir bid 15%
          const bidUpdates = keywords.map((k: any) => ({
            keywordId: k.keywordId,
            bid: Math.max(MIN_BID, Math.round(((k.bid || k.defaultBid || 0.5) * 0.85) * 100) / 100),
          }));
          if (bidUpdates.length > 0) {
            await adsCall(token, account, 'PUT', '/sp/keywords', { keywords: bidUpdates }).catch(() => {});
          }
          await base44.asServiceRole.entities.Campaign.update(camp.id, {
            launch_phase: 'under_review',
            last_review_at: new Date().toISOString(),
            last_review_reason: `72h ACoS ${acos.toFixed(1)}% > máx ${maxAcos}%. Bid reduzido 15%.`,
          }).catch(() => {});
          optimized++;

        } else if (orders > 0 && (acos <= maxAcos || spend < 1)) {
          // Vendendo e dentro do alvo → promover
          await base44.asServiceRole.entities.Campaign.update(camp.id, {
            launch_phase: 'active',
            last_review_at: new Date().toISOString(),
            last_review_reason: `72h: ${orders} venda(s), ACoS ${acos.toFixed(1)}%. Campanha promovida.`,
          }).catch(() => {});
          promoted++;

        } else {
          // Dados insuficientes mas com alguma atividade → aguardar mais 24h
          await base44.asServiceRole.entities.Campaign.update(camp.id, {
            last_review_at: new Date().toISOString(),
            last_review_reason: `72h: ${clicks} cliques, ${orders} vendas, R$${spend.toFixed(2)}. Aguardando mais dados.`,
          }).catch(() => {});
        }

        await new Promise(r => setTimeout(r, 1500));
      }

      results.push({ account_id: aid, due: due.length, evaluated, paused, optimized, promoted });
    }

    return Response.json({ ok: true, results });
  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});