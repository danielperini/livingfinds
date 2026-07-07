/**
 * evaluateAIKeywordsAfter48Hours
 *
 * Regra determinística pura (zero IA):
 *  - Busca keywords lifecycle com source=ai_generated, status=experimental
 *  - Verifica se evaluation_due_at <= agora (48h operacionais completas)
 *  - Confere pré-requisitos: campanha ENABLED, ad group ENABLED, product ad ativo
 *  - Se impressions=0 AND clicks=0 → pausa keyword na Amazon + atualiza lifecycle
 *  - Se impressions>0 OR clicks>0 → promove para status=learning
 *  - Registra tudo, nunca usa IA para contar tempo ou comparar métricas
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

async function getAdsAccessToken(account: any): Promise<string> {
  const clientId = Deno.env.get('ADS_CLIENT_ID') || account.ads_client_id;
  const clientSecret = Deno.env.get('ADS_CLIENT_SECRET') || account.ads_client_secret;
  const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
  if (!refreshToken || !clientId || !clientSecret) throw new Error('Credenciais ADS ausentes');
  const r = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  if (!r.ok) throw new Error(`Token ADS falhou: ${r.status}`);
  const d = await r.json();
  return d.access_token;
}

async function pauseKeywordOnAmazon(token: string, profileId: string, keywordId: string): Promise<boolean> {
  const region = Deno.env.get('ADS_REGION') || 'na';
  const endpointMap: Record<string, string> = { na: 'advertising-api.amazon.com', eu: 'advertising-api-eu.amazon.com', fe: 'advertising-api-fe.amazon.com' };
  const host = endpointMap[region] || endpointMap.na;
  const url = `https://${host}/v2/sp/keywords`;
  const r = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': profileId,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify([{ keywordId, state: 'paused' }]),
  });
  return r.ok || r.status === 207;
}

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const now = new Date();
  const nowIso = now.toISOString();

  try {
    const body = await req.json().catch(() => ({}));
    const serviceRole = body._service_role === true;
    if (!serviceRole) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { amazon_account_id, dry_run = false } = body;

    // ── Carregar conta ─────────────────────────────────────────────────
    const accountFilter = amazon_account_id ? { id: amazon_account_id } : { status: 'connected' };
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter(accountFilter, null, 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' });
    const aid = account.id;
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';

    // ── Buscar keywords experimentais com avaliação vencida ────────────
    const allLifecycles = await base44.asServiceRole.entities.KeywordLifecycle.filter(
      { amazon_account_id: aid, source: 'ai_generated', status: 'experimental' }, null, 500
    );

    const due = allLifecycles.filter(lc => {
      if (!lc.evaluation_due_at) return false;
      return new Date(lc.evaluation_due_at) <= now;
    });

    if (due.length === 0) {
      return Response.json({ ok: true, evaluated: 0, paused: 0, promoted_to_learning: 0, message: 'Nenhuma keyword experimental com avaliação vencida.' });
    }

    // ── Carregar dados de keywords e campanhas para validação ──────────
    const allKeywords = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, null, 1000);
    const allCampaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 500);
    const allAdGroups = await base44.asServiceRole.entities.AdGroup.filter({ amazon_account_id: aid }, null, 500);
    const allProductAds = await base44.asServiceRole.entities.ProductAd.filter({ amazon_account_id: aid }, null, 1000);

    const kwMap = new Map(allKeywords.map(k => [k.keyword_id, k]));
    const campMap = new Map(allCampaigns.map(c => [c.campaign_id, c]));
    const agMap = new Map(allAdGroups.map(ag => [ag.ad_group_id, ag]));

    let token: string | null = null;
    let paused = 0;
    let promotedToLearning = 0;
    let skipped = 0;
    const results: any[] = [];

    for (const lc of due) {
      const kw = kwMap.get(lc.keyword_id);
      const camp = campMap.get(lc.campaign_id);
      const ag = agMap.get(lc.ad_group_id);
      const productAds = allProductAds.filter(pa => pa.ad_group_id === lc.ad_group_id && pa.asin === lc.asin);
      const hasActiveProductAd = productAds.some(pa => pa.state === 'enabled' || pa.status === 'enabled');

      // Verificar pré-requisitos operacionais
      const campEnabled = camp?.state === 'enabled' || camp?.status === 'ENABLED';
      const agEnabled = ag?.state === 'enabled' || ag?.status === 'ENABLED';
      const kwEnabled = kw?.state === 'enabled' || kw?.status === 'enabled';

      if (!campEnabled || !agEnabled || !kwEnabled || !hasActiveProductAd) {
        // Não contabilizar — ainda não está operacional
        await base44.asServiceRole.entities.KeywordLifecycle.update(lc.id, {
          updated_at: nowIso,
          evaluation_due_at: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(), // +24h
        });
        skipped++;
        results.push({ keyword: lc.keyword_text, asin: lc.asin, action: 'postponed_not_operational' });
        continue;
      }

      // Métricas reais da keyword
      const impressions = Number(kw?.impressions || lc.impressions || 0);
      const clicks = Number(kw?.clicks || lc.clicks || 0);
      const spend = Number(kw?.spend || lc.spend || 0);
      const orders = Number(kw?.orders || lc.orders || 0);
      const sales = Number(kw?.sales || lc.sales || 0);

      const update: any = {
        impressions, clicks, spend, orders, sales,
        evaluation_done_at: nowIso,
        updated_at: nowIso,
      };

      if (impressions === 0 && clicks === 0) {
        // ── PAUSAR: zero impressões + zero cliques após 48h operacionais ──
        update.status = 'paused';
        update.pause_reason = 'Termo experimental criado pela IA sem impressões e sem cliques após 48 horas operacionais.';
        update.paused_at = nowIso;

        if (!dry_run) {
          // Pausar na Amazon
          try {
            if (!token) token = await getAdsAccessToken(account);
            if (lc.keyword_id) await pauseKeywordOnAmazon(token, profileId, lc.keyword_id);
            // Pausar no banco também
            if (kw) await base44.asServiceRole.entities.Keyword.update(kw.id, { state: 'paused', status: 'paused' });
          } catch (e) {
            update.pause_reason += ` [Erro ao pausar na Amazon: ${(e as Error).message}]`;
          }
          await base44.asServiceRole.entities.KeywordLifecycle.update(lc.id, update);
        }

        paused++;
        results.push({
          keyword: lc.keyword_text, asin: lc.asin, action: 'paused',
          impressions, clicks, campaign_id: lc.campaign_id,
          ad_group_id: lc.ad_group_id, keyword_id: lc.keyword_id,
          evaluation_due_at: lc.evaluation_due_at,
          reason: update.pause_reason,
        });
      } else {
        // ── MANTER: tem impressões ou cliques → promover para learning ──
        update.status = impressions > 0 && clicks > 0 ? 'learning' : 'no_delivery';
        if (!dry_run) await base44.asServiceRole.entities.KeywordLifecycle.update(lc.id, update);
        promotedToLearning++;
        results.push({ keyword: lc.keyword_text, asin: lc.asin, action: 'kept_learning', impressions, clicks });
      }
    }

    return Response.json({
      ok: true,
      dry_run,
      evaluated: due.length,
      paused,
      promoted_to_learning: promotedToLearning,
      skipped,
      results,
    });
  } catch (error) {
    return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
});