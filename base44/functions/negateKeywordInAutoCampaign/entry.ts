/**
 * negateKeywordInAutoCampaign — Quando uma campanha MANUAL é criada para um ASIN,
 * negativaExact a mesma keyword na campanha AUTO vinculada ao mesmo produto.
 *
 * Regras:
 * - Busca campanha AUTO ativa para o mesmo ASIN/amazon_account_id
 * - Cria negative keyword via Amazon Ads API na campanha AUTO
 * - Registra no OptimizationDecision e CampaignChangeHistory
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const tokenCache: Record<string, { access_token: string; expires_at: number }> = {};

async function getAdsToken(refreshToken: string | null | undefined): Promise<string> {
  const cached = tokenCache['neg'];
  if (cached && cached.expires_at > Date.now()) return cached.access_token;
  const clientId = Deno.env.get('ADS_CLIENT_ID') || '';\n  const clientSecret = Deno.env.get('ADS_CLIENT_SECRET') || '';\n  const token = refreshToken || Deno.env.get('ADS_REFRESH_TOKEN') || '';\n  if (!clientId || !clientSecret || !token) throw new Error('Credenciais Amazon Ads incompletas');\n  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken || Deno.env.get('ADS_REFRESH_TOKEN'),
    client_id: Deno.env.get('ADS_CLIENT_ID'),
    client_secret: Deno.env.get('ADS_CLIENT_SECRET'),
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token failed');
  tokenCache['neg'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function getAdsBaseUrl(account: any): string {
  const r = (account?.region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsCall(account: any, method: string, path: string, body: unknown) {
  const token = await getAdsToken(account?.ads_refresh_token);
  const profileId = account?.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
  const res = await fetch(`${getAdsBaseUrl(account)}${path}`, {
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

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    const { amazon_account_id, asin, sku, keyword_text, manual_campaign_id, source_campaign_id, triggered_by } = body;
    if (!amazon_account_id || !asin || !keyword_text) {
      return Response.json({ ok: false, error: 'amazon_account_id, asin e keyword_text são obrigatórios' }, { status: 400 });
    }

    const now = new Date().toISOString();
    const account = await base44.asServiceRole.entities.AmazonAccount.get(amazon_account_id).catch(() => null);
    if (!account) return Response.json({ ok: false, error: 'AmazonAccount não encontrada' });

    const [campaigns, productAds] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id }, '-updated_at', 5000).catch(() => []),
      base44.asServiceRole.entities.ProductAd.filter({ amazon_account_id }, '-updated_at', 10000).catch(() => []),
    ]);
    const targetSku = String(sku || '').trim().toUpperCase();
    const targetAsin = String(asin || '').trim().toUpperCase();
    const isAutomatic = (campaign: any) => {
      const type = String(campaign.targeting_type || '').toUpperCase();
      const name = String(campaign.name || campaign.campaign_name || '').toUpperCase();
      return type.includes('AUTO') || /^AUTO\s*\|/.test(name) || /\|\s*AUTO\s*\|/.test(name);
    };
    const isUsable = (campaign: any) =>
      !campaign.archived && !['archived', 'deleted'].includes(String(campaign.state || campaign.status || '').toLowerCase());
    const campaignIds = (campaign: any) =>
      [campaign.id, campaign.campaign_id, campaign.amazon_campaign_id].filter(Boolean).map(String);
    const campaignSkus = (campaign: any) => new Set([
      String(campaign.sku || '').trim().toUpperCase(),
      ...productAds.filter((ad: any) => String(ad.amazon_campaign_id || ad.campaign_id || '') === String(campaign.campaign_id || campaign.amazon_campaign_id || campaign.id || ''))
        .map((ad: any) => String(ad.sku || '').trim().toUpperCase()),
    ].filter(Boolean));

    let candidate: any | null = null;
    if (source_campaign_id) {
      const sourceId = String(source_campaign_id);
      candidate = campaigns.find((campaign: any) =>
        campaignIds(campaign).includes(sourceId) && isAutomatic(campaign) && isUsable(campaign)
      ) || null;
      if (candidate && targetSku && !campaignSkus(candidate).has(targetSku)) {
        return Response.json({ ok: true, skipped: true, reason: 'source_campaign_sku_mismatch' });
      }
      if (candidate && String(candidate.asin || '').toUpperCase() && String(candidate.asin || '').toUpperCase() !== targetAsin) {
        return Response.json({ ok: true, skipped: true, reason: 'source_campaign_asin_mismatch' });
      }
    } else {
      const candidates = campaigns.filter((campaign: any) => {
        if (!isAutomatic(campaign) || !isUsable(campaign)) return false;
        const linkedSkus = campaignSkus(campaign);
        if (targetSku) return linkedSkus.size === 1 && linkedSkus.has(targetSku);
        return String(campaign.asin || '').toUpperCase() === targetAsin && linkedSkus.size <= 1;
      });
      const unique = new Map<string, any>();
      for (const campaign of candidates) unique.set(String(campaign.campaign_id || campaign.amazon_campaign_id || campaign.id), campaign);
      if (unique.size === 1) candidate = [...unique.values()][0];
      else if (unique.size > 1) {
        return Response.json({ ok: true, skipped: true, reason: 'multiple_auto_campaigns_match_sku_review_required' });
      }
    }

    if (!candidate) {
      return Response.json({
        ok: true,
        skipped: true,
        reason: `Nenhuma campanha AUTO inequívoca encontrada para SKU ${targetSku || 'não informado'} / ASIN ${targetAsin}; nenhuma negativação aplicada.`,
      });
    }

    const autoCampaignId = String(candidate.campaign_id || candidate.amazon_campaign_id || candidate.id || '');
    if (!autoCampaignId) return Response.json({ ok: false, error: 'Campanha automática sem ID remoto' });
    const kwText = keyword_text.toLowerCase().trim();

    // ── Verificar se já existe essa negativa ──────────────────────────────────
    const existingDecisions = await base44.asServiceRole.entities.OptimizationDecision.filter({
      amazon_account_id,
      campaign_id: autoCampaignId,
      keyword_text: kwText,
      decision_type: 'negative_keyword',
      status: 'executed',
    }, undefined, 1);

    if (existingDecisions.length > 0) {
      return Response.json({
        ok: true,
        skipped: true,
        reason: `Keyword "${kwText}" já está negativada na campanha AUTO ${autoCampaignId}.`,
      });
    }

    // ── Criar negativa via Amazon Ads API ─────────────────────────────────────
    const result = await adsCall(account, 'POST', '/v2/sp/negativeKeywords', [{
      campaignId: autoCampaignId,
      keywordText: kwText,
      matchType: 'NEGATIVE_EXACT', // Amazon Ads API exige UPPERCASE para matchType de negative keywords
      state: 'enabled',
    }]);

    const success = result.ok && [200, 201, 207].includes(result.status);

    // ── Registrar na OptimizationDecision (fonte canônica) ────────────────────
    await base44.asServiceRole.entities.OptimizationDecision.create({
      amazon_account_id,
      decision_type: 'negative_keyword',
      entity_type: 'search_term',
      entity_id: autoCampaignId,
      campaign_id: autoCampaignId,
      keyword_text: kwText,
      asin,
      sku: targetSku || null,
      action: 'negative_exact',
      rationale: `Negativação automática: keyword "${kwText}" foi criada como MANUAL na campanha ${manual_campaign_id || 'nova'}. Regra: a mesma palavra deve ser negativada na campanha AUTO vinculada ao mesmo produto (ASIN: ${asin}).`,
      data_used: JSON.stringify({ triggered_by: triggered_by || 'manual_campaign_creation', manual_campaign_id, auto_campaign_id: autoCampaignId }),
      risk: 'low',
      requires_approval: false,
      status: success ? 'executed' : 'failed',
      confidence: 99,
      objective: 'profitability',
      reversible: true,
      amazon_response: JSON.stringify(result.data),
      error_message: success ? null : JSON.stringify(result.data).slice(0, 200),
      executed_at: now,
      created_at: now,
      source_function: 'negateKeywordInAutoCampaign',
      idempotency_key: `neg-auto-${amazon_account_id}-${autoCampaignId}-${kwText}-${now.slice(0, 10)}`,
    });

    // ── Registrar no CampaignChangeHistory (auditoria centralizada) ───────────
    await base44.asServiceRole.entities.CampaignChangeHistory.create({
      amazon_account_id,
      campaign_id: autoCampaignId,
      change_type: 'NEGATIVE_CREATED',
      entity_type: 'keyword',
      entity_id: autoCampaignId,
      field_name: 'negative_keyword',
      old_value: null,
      new_value: kwText,
      source: 'AUTOPILOT',
      source_function: 'negateKeywordInAutoCampaign',
      reason: `Keyword "${kwText}" negativada automaticamente na campanha AUTO ao ser criada como MANUAL. Produto: ${asin}.`,
      amazon_response: JSON.stringify(result.data),
      status: success ? 'executed' : 'failed',
      error: success ? null : JSON.stringify(result.data).slice(0, 200),
      changed_at: now,
      changed_by: triggered_by || 'autopilot',
    });

    return Response.json({
      ok: success,
      auto_campaign_id: autoCampaignId,
      keyword_negated: kwText,
      asin,
      amazon_status: result.status,
      amazon_response: result.data,
      message: success
        ? `Keyword "${kwText}" negativada com sucesso na campanha AUTO ${autoCampaignId} (ASIN: ${asin}).`
        : `Falha ao negativar keyword "${kwText}" via API. Decisão registrada para retry.`,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});