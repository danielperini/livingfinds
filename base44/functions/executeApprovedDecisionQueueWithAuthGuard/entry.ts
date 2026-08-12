import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { ADS_TOKEN_REVOKED_REAUTH_REQUIRED } from '../../shared/amazonCredentials.ts';

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && body._service_role !== true) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    let accounts: any[] = [];
    if (body.amazon_account_id) {
      accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1).catch(() => []);
    } else {
      accounts = await base44.asServiceRole.entities.AmazonAccount.list('-updated_date', 100).catch(() => []);
    }
    if (!accounts.length) return Response.json({ ok: true, skipped: true, reason: 'Nenhuma conta Amazon disponível' });

    for (const account of accounts) {
      const response = await base44.asServiceRole.functions.invoke('amazonAdsTokenManager', {
        _service_role: true,
        amazon_account_id: account.id,
        force_refresh: false,
        triggered_by: 'executeApprovedDecisionQueueWithAuthGuard',
      }).catch((error: any) => ({ ok: false, error_type: 'ADS_AUTH_PRECHECK_EXCEPTION', message: error?.message || String(error) }));
      const data = response?.data || response || {};
      if (data.ok !== true) {
        const revoked = data.requires_reauthorization === true || data.error_type === ADS_TOKEN_REVOKED_REAUTH_REQUIRED;
        return Response.json({
          ok: false,
          skipped: true,
          executed: 0,
          queue_unchanged: true,
          error_code: revoked ? ADS_TOKEN_REVOKED_REAUTH_REQUIRED : 'ADS_AUTH_PRECHECK_FAILED',
          amazon_error_code: data.amazon_error_code || null,
          requires_reauthorization: revoked,
          message: revoked
            ? 'Execução bloqueada: Amazon Ads requer reautorização.'
            : String(data.message || 'Pré-checagem Amazon Ads falhou.'),
        }, { status: revoked ? 401 : 503 });
      }
    }

    const result = await base44.asServiceRole.functions.invoke('executeApprovedDecisionQueue', {
      ...body,
      _service_role: true,
      auth_precheck_passed: true,
      auth_precheck_function: 'executeApprovedDecisionQueueWithAuthGuard',
    });
    return Response.json(result?.data || result || {});
  } catch (error: any) {
    return Response.json({ ok: false, executed: 0, queue_unchanged: true, error_code: 'ADS_AUTH_PRECHECK_INTERNAL_ERROR', error: error?.message || String(error) }, { status: 500 });
  }
});
