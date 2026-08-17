/**
 * createProductTarget — Cria segmentação por produto (ASIN, categoria, marca)
 * API v3, com validação e auditoria
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
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token failed');
  tokenCache['ads'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function getAdsBaseUrl() {
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsRequestV3(method, path, body, refreshToken, profileId, contentType = 'application/json') {
  const token = await getAdsToken(refreshToken);
  const res = await fetch(`${getAdsBaseUrl()}${path}`, {
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
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const {
      amazon_account_id,
      campaign_id,
      ad_group_id,
      target_type, // 'asin', 'category', 'brand'
      target_value, // ASIN, categoria ou marca
      bid,
      is_negative = false,
    } = body;

    if (!amazon_account_id || !campaign_id || !ad_group_id || !target_type || !target_value) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Buscar conta Amazon
    const account = await base44.asServiceRole.entities.AmazonAccount.get(amazon_account_id).catch(() => null);
    if (!account) return Response.json({ ok: false, error: 'AmazonAccount não encontrada' });

    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
    if (!refreshToken) return Response.json({ ok: false, error: 'Sem refresh_token' });

    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    if (!profileId) return Response.json({ ok: false, error: 'ads_profile_id não configurado' });

    const now = new Date().toISOString();

    // API v3: POST /sp/targets
    const targetPayload = {
      productTargets: [{
        campaignId: campaign_id,
        adGroupId: ad_group_id,
        expression: target_type === 'asin' ? 'asinSameAs' : target_type === 'category' ? 'category' : 'brand',
        expressionType: 'manual',
        bid: bid || 0.30,
        state: 'ENABLED',
      }],
    };

    // Para ASIN, usar o valor diretamente
    if (target_type === 'asin') {
      targetPayload.productTargets[0].expression = target_value;
      targetPayload.productTargets[0].expressionType = 'asinSameAs';
    } else if (target_type === 'category') {
      targetPayload.productTargets[0].expression = target_value;
      targetPayload.productTargets[0].expressionType = 'category';
    } else if (target_type === 'brand') {
      targetPayload.productTargets[0].expression = target_value;
      targetPayload.productTargets[0].expressionType = 'brand';
    }

    const result = await adsRequestV3('POST', '/sp/targets', targetPayload, refreshToken, profileId, 'application/vnd.spProductTarget.v3+json');

    if (![200, 201, 207].includes(result.status)) {
      return Response.json({
        ok: false,
        error: 'Falha ao criar product target',
        amazon_status: result.status,
        amazon_error: JSON.stringify(result.data).slice(0, 300),
      });
    }

    // Extrair targetId
    const targetId = result.data?.productTargets?.success?.[0]?.targetId ||
                     result.data?.success?.[0]?.targetId || '';

    // Salvar entidade
    await base44.asServiceRole.entities.ProductTarget.create({
      amazon_account_id,
      campaign_id,
      ad_group_id,
      target_id: targetId,
      target_type,
      target_value,
      bid: bid || 0.30,
      state: is_negative ? 'archived' : 'enabled',
      status: is_negative ? 'negative' : 'enabled',
      is_negative,
      synced_at: now,
    }).catch(() => {});

    // Auditoria
    await base44.asServiceRole.entities.CampaignCreationLog.create({
      amazon_account_id,
      user_id: user.id,
      operation_type: 'create_product_ad',
      entity_type: 'product_target',
      entity_id: targetId,
      campaign_id,
      ad_group_id,
      rule_applied: 'Criação de product target',
      rationale: `Target ${target_type}: ${target_value}, bid: $${bid || 0.30}`,
      status: 'success',
      amazon_response: JSON.stringify(result.data).slice(0, 500),
      request_id: result.requestId,
      created_at: now,
    }).catch(() => {});

    return Response.json({
      ok: true,
      target_id: targetId,
      target_type,
      target_value,
      bid: bid || 0.30,
      request_id: result.requestId,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});