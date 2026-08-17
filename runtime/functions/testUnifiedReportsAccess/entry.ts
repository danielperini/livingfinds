/**
 * testUnifiedReportsAccess
 * Testa se a conta Amazon tem acesso à API de Relatórios Unificados.
 * Salva resultado em AmazonAccount.unified_reports_access
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function getAdsBaseUrl(region) {
  const r = (region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function getAdsToken(refreshToken, clientId, clientSecret) {
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token refresh failed');
  return data.access_token;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    let account = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
      account = accs[0];
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' });

    const now = new Date().toISOString();
    const endDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

    const token = await getAdsToken(
      account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '',
      Deno.env.get('ADS_CLIENT_ID') || '',
      Deno.env.get('ADS_CLIENT_SECRET') || '',
    );
    const baseUrl = getAdsBaseUrl(account.region || 'NA');
    const profileId = String(account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '');

    const payload = {
      name: `LivingFinds_AccessTest_${Date.now()}`,
      startDate,
      endDate,
      configuration: {
        adProduct: 'SPONSORED_PRODUCTS',
        groupBy: ['campaignId'],
        columns: ['impressions', 'clicks', 'cost', 'purchases14d', 'sales14d', 'costPerPurchase14d', 'roasClicks14d', 'clickThroughRate', 'costPerClick'],
        reportTypeId: 'spCampaigns',
        timeUnit: 'DAILY',
        format: 'GZIP_JSON',
      },
    };

    const createRes = await fetch(`${baseUrl}/reporting/reports`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
        'Amazon-Advertising-API-Scope': profileId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const statusCode = createRes.status;
    let responseData: any = {};
    try { responseData = await createRes.json(); } catch {}

    let has_access = false;
    let can_create = false;
    let can_download = false;
    let error_msg = null;
    const null_fields: string[] = [];
    const restricted_fields: string[] = [];

    if (statusCode === 200 || statusCode === 202) {
      has_access = true;
      can_create = true;
      // Verificar se campos vieram nulos
      if (responseData.reportId) can_download = true;
    } else if (statusCode === 400) {
      has_access = true; // acesso existe mas payload pode ser inválido
      error_msg = `HTTP 400: ${JSON.stringify(responseData).slice(0, 300)}`;
    } else if (statusCode === 403) {
      has_access = false;
      error_msg = `HTTP 403: Acesso negado aos Relatórios Unificados. Verifique permissões no Amazon Ads Console.`;
      restricted_fields.push('unified_reports');
    } else if (statusCode === 401) {
      has_access = false;
      error_msg = `HTTP 401: Token inválido ou expirado.`;
    } else {
      error_msg = `HTTP ${statusCode}: ${JSON.stringify(responseData).slice(0, 200)}`;
    }

    // Salvar resultado na conta
    await base44.asServiceRole.entities.AmazonAccount.update(account.id, {
      unified_reports_access: has_access,
      unified_reports_last_test_at: now,
      unified_reports_last_error: error_msg,
    }).catch(() => {});

    return Response.json({
      ok: true,
      has_unified_reports_api_access: has_access,
      can_create_report: can_create,
      can_download_report: can_download,
      http_status: statusCode,
      report_id: responseData.reportId || null,
      restricted_fields,
      null_fields,
      error: error_msg,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});