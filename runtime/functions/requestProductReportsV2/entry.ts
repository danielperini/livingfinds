import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

async function lwaToken() {
  const refresh = Deno.env.get('AMAZON_SP_REFRESH_TOKEN') || Deno.env.get('SP_REFRESH_TOKEN');
  const client = Deno.env.get('AMAZON_LWA_CLIENT_ID') || Deno.env.get('SP_CLIENT_ID');
  const secret = Deno.env.get('AMAZON_LWA_CLIENT_SECRET') || Deno.env.get('SP_CLIENT_SECRET');
  if (!refresh || !client || !secret) throw new Error('Credenciais SP-API incompletas.');
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: client, client_secret: secret }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.error_description || data.error || 'Falha no token SP-API.');
  return data.access_token;
}

function base(region) {
  const r = String(region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://sellingpartnerapi-eu.amazon.com';
  if (r.includes('FE')) return 'https://sellingpartnerapi-fe.amazon.com';
  return 'https://sellingpartnerapi-na.amazon.com';
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const auth = await base44.auth.isAuthenticated().catch(() => false);
    if (!auth && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    if (!body.amazon_account_id) return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });

    const account = await base44.asServiceRole.entities.AmazonAccount.get(body.amazon_account_id);
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' }, { status: 404 });

    const token = await lwaToken();
    const marketplace = account.marketplace_id || Deno.env.get('AMAZON_MARKETPLACE_ID') || 'A2Q3Y263D00KWC';
    const types = ['GET_MERCHANT_LISTINGS_ALL_DATA', 'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA'];
    const requested = [];
    const errors = [];

    for (const reportType of types) {
      const call = await base44.asServiceRole.functions.invoke('amazonApiGateway', {
        amazon_account_id: body.amazon_account_id,
        api_family: 'SP_API_REPORTS',
        operation: `createReport:${reportType}`,
        endpoint: `${base(account.region)}/reports/2021-06-30/reports`,
        method: 'POST',
        headers: {
          'x-amz-access-token': token,
          'x-amz-date': new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''),
          'user-agent': 'LivingFinds/1.0 (Language=TypeScript)',
          'Content-Type': 'application/json',
        },
        payload: { reportType, marketplaceIds: [marketplace] },
        queue_type: 'REPORT',
        max_attempts: 5,
        _service_role: true,
      });
      const result = call?.data || call || {};
      const payload = result.payload || {};
      if (result.ok && payload.reportId) requested.push({ reportType, reportId: payload.reportId, requestId: result.request_id || null });
      else errors.push({ reportType, status: result.status || 500, errors: result.errors || [] });
    }

    const now = new Date().toISOString();
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: body.amazon_account_id,
      operation: 'product_reports_request_v2',
      status: errors.length === types.length ? 'error' : 'completed',
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
