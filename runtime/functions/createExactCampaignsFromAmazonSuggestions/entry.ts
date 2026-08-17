/**
 * createExactCampaignsFromAmazonSuggestions
 *
 * Cria campanhas manuais EXACT usando APENAS sugestões oficiais da Amazon Ads.
 * Máximo 4 por produto por ciclo.
 * Só cria na janela Amazon (00h-04h ou 13h-14h BRT) ou agenda para a próxima.
 * Só cria se: source = AMAZON_ADS_SUGGESTED_KEYWORD, ai_confidence >= 0.90,
 *             should_create_campaign = true, produto com estoque, sem campanha ativa igual.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const KEYWORDS_PER_CAMPAIGN = 4;  // 1 campanha com 4 keywords
const MIN_BUDGET = 15.0;           // mínimo por campanha consolidada
const MIN_BID = 0.35;
const MAX_BID = 3.0;
const WINDOW_PAUSE_MS = 3000;

function getAdsBaseUrl(region: string) {
  const r = (region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function getAdsToken(refreshToken: string, clientId: string, clientSecret: string) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token refresh failed');
  return data.access_token as string;
}

function isInAmazonWindow(brazilHour: number): boolean {
  return (brazilHour >= 0 && brazilHour <= 3) || brazilHour === 13;
}

function currentBrazilHour(): number {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit', hour12: false,
  }).formatToParts(new Date());
  return Number(parts.find(p => p.type === 'hour')?.value || 0);
}

function nextWindowDate(): string {
  const now = new Date();
  const h = currentBrazilHour();
  let hoursUntil = h < 13 ? (13 - h) : (24 - h);
  return new Date(now.getTime() + hoursUntil * 3600000).toISOString();
}

Deno.serve(async (req) => {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const {
      amazon_account_id,
      asin,
      limit = MAX_CAMPAIGNS_PER_PRODUCT,
      execute_now_if_window = true,
      dry_run = false,
    } = body;

    if (!asin) return Response.json({ ok: false, error: 'asin obrigatório' });

    let account: any = null;
    if (amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id });
      account = accs[0];
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' });

    const aid = account.id;
    const brazilHour = currentBrazilHour();
    const inWindow = isInAmazonWindow(brazilHour);

    if (execute_now_if_window && !inWindow && !dry_run) {
      return Response.json({
        ok: true,
        scheduled: true,
        message: `Fora da janela Amazon. Agendado para ${nextWindowDate()}`,
        next_window: nextWindowDate(),
        brazil_hour: brazilHour,
      });
    }

    // Verificar produto
    const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid, asin });
    const prod = products[0];
    if (!prod) return Response.json({ ok: false, error: 'Produto não encontrado' });
    if ((prod.fba_inventory || 0) === 0 || prod.inventory_status === 'out_of_stock') {
      return Response.json({ ok: false, error: 'Produto sem estoque' });
    }
    if (prod.status !== 'active') {
      return Response.json({ ok: false, error: 'Produto inativo' });
    }
    if (!prod.price || prod.price <= 0) {
      return Response.json({ ok: false, error: 'Produto sem preço válido' });
    }

    // Verificar auto campanha ativa (não criar manual se auto estiver incompleta)
    const autoCampaigns = await base44.asServiceRole.entities.Campaign.filter({
      amazon_account_id: aid, asin, targeting_type: 'AUTO',
    }).catch(() => []);
    const hasIncompleteAuto = autoCampaigns.some((c: any) =>
      ['incomplete', 'INCOMPLETE'].includes(c.state || c.status || '')
    );
    if (hasIncompleteAuto) {
      return Response.json({ ok: false, error: 'Campanha AUTO incompleta detectada. Reparar primeiro.' });
    }

    // Buscar sugestões aprovadas pela IA
    const suggestions = await base44.asServiceRole.entities.KeywordSuggestion.filter({
      amazon_account_id: aid,
      asin,
      source: 'AMAZON_ADS_SUGGESTED_KEYWORD',
      status: 'ranked',
    }, null, 50).catch(() => []);

    const eligible = suggestions.filter((s: any) =>
      (s.ai_confidence || 0) >= 0.90 &&
      s.should_create_campaign === true &&
      ['low', 'medium'].includes(s.risk_level || 'high') &&
      s.keyword && s.keyword.trim().length >= 2
    ).sort((a: any, b: any) => (a.ai_rank || 99) - (b.ai_rank || 99));

    if (!eligible.length) {
      return Response.json({ ok: true, message: 'Nenhuma sugestão elegível para criar campanha', eligible: 0 });
    }

    // Verificar keywords já ativas para evitar duplicatas
    const existingKeywords = await base44.asServiceRole.entities.Keyword.filter({
      amazon_account_id: aid,
    }, null, 500).catch(() => []);
    const activeCampaignKeywords = new Set(
      existingKeywords
        .filter((k: any) => k.state === 'ENABLED' || k.status === 'enabled')
        .map((k: any) => (k.keyword_text || k.keyword || '').toLowerCase().trim())
    );

    // KeywordSuggestions já criadas recentemente (evitar duplicata por status)
    const alreadyCreated = await base44.asServiceRole.entities.KeywordSuggestion.filter({
      amazon_account_id: aid, asin, status: 'created',
    }, null, 100).catch(() => []);
    const createdKeywords = new Set(alreadyCreated.map((s: any) => (s.keyword || '').toLowerCase().trim()));

    const dedupedEligible = eligible.filter((s: any) => {
      const kw = (s.normalized_keyword || s.keyword || '').toLowerCase().trim();
      return !activeCampaignKeywords.has(kw) && !createdKeywords.has(kw);
    });

    // Pegar até KEYWORDS_PER_CAMPAIGN keywords para 1 campanha consolidada
    const toCreate = dedupedEligible.slice(0, KEYWORDS_PER_CAMPAIGN);

    if (!toCreate.length) {
      return Response.json({ ok: true, message: 'Todas as keywords elegíveis já têm campanha ativa', eligible: eligible.length });
    }

    if (dry_run) {
      return Response.json({ ok: true, dry_run: true, would_create: 1, keywords: toCreate.map((s: any) => s.keyword) });
    }

    const token = await getAdsToken(
      account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '',
      Deno.env.get('ADS_CLIENT_ID') || '',
      Deno.env.get('ADS_CLIENT_SECRET') || '',
    );
    const baseUrl   = getAdsBaseUrl(account.region || 'NA');
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';
    const clientId  = Deno.env.get('ADS_CLIENT_ID') || '';

    const ap = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }, null, 1)
      .then((r: any[]) => r[0]).catch(() => null);
    const maxBudget = ap?.maximum_campaign_budget || 100;

    // Nome da campanha consolidada com as 4 keywords principais
    const topKeyword   = toCreate[0].keyword.trim();
    const campaignName = `SP | MANUAL | EXACT | ${asin} | ${topKeyword}${toCreate.length > 1 ? ' +' + (toCreate.length - 1) : ''}`.slice(0, 128);
    const adGroupName  = `AG | EXACT | ${asin}`.slice(0, 128);
    const budget       = Math.min(maxBudget, Math.max(MIN_BUDGET, toCreate[0].recommended_budget || MIN_BUDGET));

    const makeHeaders = (contentType: string) => ({
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': clientId,
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': contentType,
      'Accept': contentType,
    });

    let created = 0, failed = 0;
    const results: any[] = [];

    try {
      // ── 1. Criar campanha ──────────────────────────────────────────────────
      const campRes = await fetch(`${baseUrl}/sp/campaigns`, {
        method: 'POST',
        headers: makeHeaders('application/vnd.spCampaign.v3+json'),
        body: JSON.stringify({
          campaigns: [{
            name: campaignName,
            targetingType: 'MANUAL',
            state: 'ENABLED',
            dynamicBidding: { strategy: 'LEGACY_FOR_SALES' },
            budget: { budgetType: 'DAILY', budget },
          }],
        }),
      });

      if (campRes.status === 429) {
        return Response.json({ ok: false, error: 'Rate limit Amazon Ads. Tente novamente em 15 minutos.', created: 0, failed: 1 });
      }
      if (campRes.status === 403) {
        return Response.json({ ok: false, error: '403: Erro de autorização Amazon Ads. Verifique o token.', created: 0, failed: 1 });
      }

      const campData = await campRes.json();
      const amazonCampaignId = campData?.campaigns?.success?.[0]?.campaignId;
      if (!amazonCampaignId) {
        return Response.json({ ok: false, error: `Amazon não retornou campaignId: ${JSON.stringify(campData).slice(0, 300)}`, created: 0, failed: 1 });
      }

      await new Promise(r => setTimeout(r, 2000));

      // ── 2. Criar ad group ──────────────────────────────────────────────────
      const agRes = await fetch(`${baseUrl}/sp/adGroups`, {
        method: 'POST',
        headers: makeHeaders('application/vnd.spAdGroup.v3+json'),
        body: JSON.stringify({
          adGroups: [{
            campaignId: amazonCampaignId,
            name: adGroupName,
            defaultBid: Math.min(MAX_BID, Math.max(MIN_BID, toCreate[0].recommended_bid || toCreate[0].amazon_suggested_bid || 0.50)),
            state: 'ENABLED',
          }],
        }),
      });

      const agData = await agRes.json();
      const adGroupId = agData?.adGroups?.success?.[0]?.adGroupId;
      if (!adGroupId) {
        return Response.json({ ok: false, error: `Amazon não retornou adGroupId: ${JSON.stringify(agData).slice(0, 200)}`, created: 0, failed: 1 });
      }

      await new Promise(r => setTimeout(r, 2000));

      // ── 3. Criar todas as keywords no mesmo ad group (bulk) ────────────────
      const keywordsPayload = toCreate.map((s: any) => ({
        campaignId: amazonCampaignId,
        adGroupId,
        state: 'ENABLED',
        keywordText: s.keyword.trim(),
        matchType: 'EXACT',
        bid: Math.min(MAX_BID, Math.max(MIN_BID, s.recommended_bid || s.amazon_suggested_bid || 0.50)),
      }));

      const kwRes = await fetch(`${baseUrl}/sp/keywords`, {
        method: 'POST',
        headers: makeHeaders('application/vnd.spKeyword.v3+json'),
        body: JSON.stringify({ keywords: keywordsPayload }),
      });

      const kwData = await kwRes.json();
      const successKws: any[] = kwData?.keywords?.success || [];
      const failedKws: any[]  = kwData?.keywords?.error   || [];

      // Atualizar status de cada sugestão
      for (const s of toCreate) {
        const match = successKws.find((k: any) => k.keywordText?.toLowerCase() === s.keyword.toLowerCase().trim());
        await base44.asServiceRole.entities.KeywordSuggestion.update(s.id, {
          status: match ? 'created' : 'failed',
          amazon_campaign_id: amazonCampaignId,
          created_keyword_id: match?.keywordId || null,
          executed_at: now,
          error: match ? null : `Keyword não confirmada pela Amazon`,
        }).catch(() => {});
        if (match) {
          created++;
          results.push({ keyword: s.keyword, status: 'created', keyword_id: match.keywordId });
        } else {
          failed++;
          results.push({ keyword: s.keyword, status: 'keyword_failed' });
        }
      }

      // ── 4. Salvar campanha localmente ──────────────────────────────────────
      const campRecord = await base44.asServiceRole.entities.Campaign.create({
        amazon_account_id: aid,
        ads_profile_id: profileId,
        asin,
        amazon_campaign_id: amazonCampaignId,
        campaign_id: amazonCampaignId,
        name: campaignName,
        campaign_name: campaignName,
        campaign_type: 'SP',
        targeting_type: 'MANUAL',
        state: 'enabled',
        status: 'enabled',
        daily_budget: budget,
        created_by_app: true,
        launch_phase: 'new',
        created_at: now,
      }).catch(() => null);

      // ── 5. Negativar TODAS as keywords na campanha AUTO do mesmo ASIN ──────
      const autoCampaigns = await base44.asServiceRole.entities.Campaign.filter({
        amazon_account_id: aid, asin, targeting_type: 'AUTO',
      }).catch(() => []);
      const autoCampaign = autoCampaigns.find((c: any) => !['archived', 'ARCHIVED'].includes(c.state || c.status || ''));

      if (autoCampaign) {
        const negPayload = toCreate.map((s: any) => ({
          campaignId: autoCampaign.campaign_id,
          keywordText: s.keyword.toLowerCase().trim(),
          matchType: 'negativeExact',
          state: 'enabled',
        }));

        const negRes = await fetch(`${baseUrl}/v2/sp/negativeKeywords`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Amazon-Advertising-API-ClientId': clientId,
            'Amazon-Advertising-API-Scope': String(profileId),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(negPayload),
        }).catch(() => null);

        const negOk = negRes ? [200, 201, 207].includes(negRes.status) : false;

        // Registrar cada negativação no OptimizationDecision
        for (const s of toCreate) {
          await base44.asServiceRole.entities.OptimizationDecision.create({
            amazon_account_id: aid,
            decision_type: 'negative_keyword',
            entity_type: 'search_term',
            entity_id: autoCampaign.campaign_id,
            campaign_id: autoCampaign.campaign_id,
            keyword_text: s.keyword.toLowerCase().trim(),
            asin,
            action: 'negative_exact',
            rationale: `Negativação automática: keyword criada como MANUAL EXACT (campanha ${amazonCampaignId}). Evitar canibalização na AUTO.`,
            risk: 'low',
            requires_approval: false,
            status: negOk ? 'executed' : 'failed',
            confidence: 99,
            executed_at: now,
            created_at: now,
            source_function: 'createExactCampaignsFromAmazonSuggestions',
            idempotency_key: `neg-auto-create-${aid}-${autoCampaign.campaign_id}-${s.keyword.toLowerCase().trim()}-${now.slice(0, 10)}`,
          }).catch(() => {});
        }
      }

    } catch (e: any) {
      failed = toCreate.length;
      results.push({ status: 'error', error: e.message });
      for (const s of toCreate) {
        await base44.asServiceRole.entities.KeywordSuggestion.update(s.id, {
          status: 'failed', error: e.message.slice(0, 300),
        }).catch(() => {});
      }
    }

    return Response.json({
      ok: true,
      asin,
      eligible: eligible.length,
      attempted: toCreate.length,
      created,
      failed,
      keywords_in_campaign: toCreate.length,
      in_window: inWindow,
      results,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});