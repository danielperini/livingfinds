import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

async function getToken() {
  const refreshToken = Deno.env.get('AMAZON_SP_REFRESH_TOKEN') || Deno.env.get('SP_REFRESH_TOKEN');
  const clientId = Deno.env.get('AMAZON_LWA_CLIENT_ID') || Deno.env.get('SP_CLIENT_ID');
  const clientSecret = Deno.env.get('AMAZON_LWA_CLIENT_SECRET') || Deno.env.get('SP_CLIENT_SECRET');
  if (!refreshToken || !clientId || !clientSecret) throw new Error('Credenciais SP-API incompletas.');

  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(data.error_description || data.error || 'Falha no token SP-API.');
  return data.access_token;
}

function apiBase(region) {
  const value = String(region || 'NA').toUpperCase();
  if (value.includes('EU')) return 'https://sellingpartnerapi-eu.amazon.com';
  if (value.includes('FE')) return 'https://sellingpartnerapi-fe.amazon.com';
  return 'https://sellingpartnerapi-na.amazon.com';
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const amazon_account_id = body.amazon_account_id;
    if (!amazon_account_id) return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });

    const account = await base44.asServiceRole.entities.AmazonAccount.get(amazon_account_id);
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon não encontrada' }, { status: 404 });

    const accessToken = await getToken();
    const marketplaceId = account.marketplace_id || Deno.env.get('AMAZON_MARKETPLACE_ID') || 'A2Q3Y263D00KWC';
    const reportTypes = ['GET_MERCHANT_LISTINGS_ALL_DATA', 'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA'];
    const requested = [];
    const errors = [];

    for (const reportType of reportTypes) {
      const response = await fetch(`${apiBase(account.region)}/reports/2021-06-30/reports`, {
        method: 'POST',
        headers: {
          'x-amz-access-token': accessToken,
          'x-amz-date': new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''),
          'user-agent': 'LivingFinds/1.0 (Language=TypeScript)',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reportType, marketplaceIds: [marketplaceId] }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.reportId) requested.push({ reportType, reportId: data.reportId });
      else errors.push({ reportType, status: response.status, response: data });
    }

    const now = new Date().toISOString();
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id,
      operation: 'product_reports_request',
      status: errors.length === reportTypes.length ? 'error' : 'completed',
      started_at: now,
      completed_at: now,
      records_processed: requested.length,
      result_summary: JSON.stringify({ requested, errors }).slice(0, 4000),
    }).catch(() => {});

    return Response.json({ ok: requested.length > 0, requested, errors, requested_at: now }, { status: requested.length > 0 ? 200 : 502 });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao solicitar relatórios' }, { status: 500 });
  }
});
