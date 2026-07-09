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

const MAX_CAMPAIGNS_PER_PRODUCT = 4;
const MIN_BUDGET = 5.0;
const MIN_BID = 0.35;
const MAX_BID = 3.0;
const WINDOW_PAUSE_MS = 14000;

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

    // Verificar campanhas ativas para evitar duplicatas
    const existingCampaigns = await base44.asServiceRole.entities.Campaign.filter({
      amazon_account_id: aid, asin, targeting_type: 'MANUAL',
    }).catch(() => []);
    const existingKeywords = await base44.asServiceRole.entities.Keyword.filter({
      amazon_account_id: aid,
    }, null, 500).catch(() => []);
    const activeCampaignKeywords = new Set(
      existingKeywords
        .filter((k: any) => k.state === 'ENABLED' || k.status === 'enabled')
        .map((k: any) => (k.keyword_text || k.keyword || '').toLowerCase().trim())
    );

    const toCreate = eligible
      .filter((s: any) => !activeCampaignKeywords.has((s.normalized_keyword || s.keyword || '').toLowerCase()))
      .slice(0, Math.min(limit, MAX_CAMPAIGNS_PER_PRODUCT));

    if (!toCreate.length) {
      return Response.json({ ok: true, message: 'Todas as keywords elegíveis já têm campanha ativa', eligible: eligible.length });
    }

    if (dry_run) {
      return Response.json({ ok: true, dry_run: true, would_create: toCreate.length, keywords: toCreate.map((s: any) => s.keyword) });
    }

    const token = await getAdsToken(
      account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '',
      Deno.env.get('ADS_CLIENT_ID') || '',
      Deno.env.get('ADS_CLIENT_SECRET') || '',
    );
    const baseUrl = getAdsBaseUrl(account.region || 'NA');
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';

    const ap = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }, null, 1)
      .then((r: any[]) => r[0]).catch(() => null);
    const maxBudget = ap?.maximum_campaign_budget || 100;

    let created = 0, failed = 0;
    const results: any[] = [];

    for (const s of toCreate) {
      const keyword = s.keyword.trim();
      const bid = Math.min(MAX_BID, Math.max(MIN_BID, s.recommended_bid || s.amazon_suggested_bid || 0.50));
      const budget = Math.min(maxBudget, Math.max(MIN_BUDGET, s.recommended_budget || MIN_BUDGET));
      const campaignName = `SP | MANUAL | EXACT | ${asin} | ${keyword}`.slice(0, 128);
      const adGroupName = `AG | EXACT | ${asin}`.slice(0, 128);

      try {
        // Criar campanha
        const campRes = await fetch(`${baseUrl}/sp/campaigns`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
            'Amazon-Advertising-API-Scope': String(profileId),
            'Content-Type': 'application/vnd.spCampaign.v3+json',
            'Accept': 'application/vnd.spCampaign.v3+json',
          },
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
          await new Promise(r => setTimeout(r, 10000));
          failed++;
          results.push({ keyword, status: 'rate_limited' });
          await base44.asServiceRole.entities.KeywordSuggestion.update(s.id, {
            status: 'queued', error: 'Rate limit — reagendado',
          }).catch(() => {});
          continue;
        }

        const campData = await campRes.json();

        if (campRes.status === 400) {
          failed++;
          results.push({ keyword, status: 'bad_request', error: JSON.stringify(campData).slice(0, 200) });
          await base44.asServiceRole.entities.KeywordSuggestion.update(s.id, {
            status: 'failed', error: `400: ${JSON.stringify(campData).slice(0, 300)}`,
          }).catch(() => {});
          continue;
        }

        if (campRes.status === 403) {
          await base44.asServiceRole.entities.KeywordSuggestion.update(s.id, {
            status: 'failed', error: '403: Erro de autorização',
          }).catch(() => {});
          return Response.json({ ok: false, error: '403: Erro de autorização Amazon Ads. Verifique o token.', created, failed });
        }

        const amazonCampaignId = campData?.campaigns?.success?.[0]?.campaignId;
        if (!amazonCampaignId) {
          failed++;
          results.push({ keyword, status: 'no_campaign_id', error: JSON.stringify(campData).slice(0, 200) });
          await base44.asServiceRole.entities.KeywordSuggestion.update(s.id, {
            status: 'failed', error: 'Amazon não retornou campaignId',
          }).catch(() => {});
          continue;
        }

        await new Promise(r => setTimeout(r, 2000));

        // Criar ad group
        const agRes = await fetch(`${baseUrl}/sp/adGroups`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
            'Amazon-Advertising-API-Scope': String(profileId),
            'Content-Type': 'application/vnd.spAdGroup.v3+json',
            'Accept': 'application/vnd.spAdGroup.v3+json',
          },
          body: JSON.stringify({
            adGroups: [{
              campaignId: amazonCampaignId,
              name: adGroupName,
              defaultBid: bid,
              state: 'ENABLED',
            }],
          }),
        });

        const agData = await agRes.json();
        const adGroupId = agData?.adGroups?.success?.[0]?.adGroupId;
        if (!adGroupId) {
          failed++;
          results.push({ keyword, status: 'no_adgroup_id', campaign_id: amazonCampaignId });
          continue;
        }

        await new Promise(r => setTimeout(r, 2000));

        // Criar keyword
        const kwRes = await fetch(`${baseUrl}/sp/keywords`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
            'Amazon-Advertising-API-Scope': String(profileId),
            'Content-Type': 'application/vnd.spKeyword.v3+json',
            'Accept': 'application/vnd.spKeyword.v3+json',
          },
          body: JSON.stringify({
            keywords: [{
              campaignId: amazonCampaignId,
              adGroupId,
              state: 'ENABLED',
              keywordText: keyword,
              matchType: 'EXACT',
              bid,
            }],
          }),
        });

        const kwData = await kwRes.json();
        const keywordId = kwData?.keywords?.success?.[0]?.keywordId;

        // Só marcar como criada após Amazon confirmar campaignId
        await base44.asServiceRole.entities.KeywordSuggestion.update(s.id, {
          status: keywordId ? 'created' : 'failed',
          amazon_campaign_id: amazonCampaignId,
          created_keyword_id: keywordId || null,
          executed_at: now,
          error: keywordId ? null : 'Amazon não retornou keywordId',
        }).catch(() => {});

        // Salvar campanha localmente
        if (amazonCampaignId) {
          await base44.asServiceRole.entities.Campaign.create({
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
          }).catch(() => {});
        }

        if (keywordId) {
          created++;
          results.push({ keyword, status: 'created', campaign_id: amazonCampaignId, keyword_id: keywordId });
        } else {
          failed++;
          results.push({ keyword, status: 'keyword_failed', campaign_id: amazonCampaignId });
        }

        await new Promise(r => setTimeout(r, WINDOW_PAUSE_MS));

      } catch (e: any) {
        failed++;
        results.push({ keyword, status: 'error', error: e.message });
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
      in_window: inWindow,
      results,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});