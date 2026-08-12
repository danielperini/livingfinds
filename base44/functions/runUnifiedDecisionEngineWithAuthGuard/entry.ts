import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { ADS_TOKEN_REVOKED_REAUTH_REQUIRED } from '../../shared/amazonCredentials.ts';

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && body._service_role !== true) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1).catch(() => [])
      : await base44.asServiceRole.entities.AmazonAccount.list('-updated_date', 100).catch(() => []);

    if (!accounts.length) {
      return Response.json({
        ok: false,
        engine: 'unified-marketplace-decision-governance',
        error_code: 'ADS_AUTH_PRECHECK_NO_ACCOUNT',
        error: 'Nenhuma AmazonAccount disponível para a pré-checagem Ads.',
        aborted_before_decisions: true,
        decisions_enqueued: 0,
      }, { status: 409 });
    }

    const checks: any[] = [];
    for (const account of accounts) {
      const response = await base44.asServiceRole.functions.invoke('amazonAdsTokenManager', {
        _service_role: true,
        amazon_account_id: account.id,
        force_refresh: false,
        triggered_by: 'runUnifiedDecisionEngineWithAuthGuard',
      }).catch((error: any) => ({ ok: false, error_type: 'ADS_AUTH_PRECHECK_EXCEPTION', message: error?.message || String(error) }));
      const data = response?.data || response || {};
      checks.push({
        amazon_account_id: account.id,
        ok: data.ok === true,
        error_type: data.error_type || null,
        amazon_error_code: data.amazon_error_code || null,
        requires_reauthorization: data.requires_reauthorization === true,
      });

      if (data.ok !== true) {
        const revoked = data.requires_reauthorization === true || data.error_type === ADS_TOKEN_REVOKED_REAUTH_REQUIRED;
        await base44.asServiceRole.entities.SyncExecutionLog.create({
          amazon_account_id: account.id,
          operation: 'amazon_ads:decision_engine_auth_precheck',
          status: 'error',
          trigger_type: body.trigger_type || 'scheduler_intraday',
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          records_processed: 0,
          error_message: revoked
            ? ADS_TOKEN_REVOKED_REAUTH_REQUIRED
            : String(data.message || data.error_type || 'ADS_AUTH_PRECHECK_FAILED').slice(0, 500),
          result_summary: JSON.stringify({
            aborted_before_decisions: true,
            decisions_enqueued: 0,
            error_type: data.error_type || null,
            amazon_error_code: data.amazon_error_code || null,
            requires_reauthorization: data.requires_reauthorization === true,
          }).slice(0, 4000),
        }).catch(() => {});

        return Response.json({
          ok: false,
          engine: 'unified-marketplace-decision-governance',
          error_code: revoked ? ADS_TOKEN_REVOKED_REAUTH_REQUIRED : 'ADS_AUTH_PRECHECK_FAILED',
          amazon_error_code: data.amazon_error_code || null,
          requires_reauthorization: revoked,
          message: revoked
            ? 'Amazon Ads revogada. Reautorize em /amazon-oauth-setup antes de executar o motor.'
            : String(data.message || 'Pré-checagem Amazon Ads falhou.'),
          aborted_before_decisions: true,
          decisions_enqueued: 0,
          auth_checks: checks,
        }, { status: revoked ? 401 : 503 });
      }
    }

    const result = await base44.asServiceRole.functions.invoke('runUnifiedDecisionEngine', {
      ...body,
      _service_role: true,
      auth_precheck_passed: true,
      auth_precheck_function: 'runUnifiedDecisionEngineWithAuthGuard',
    });
    const data = result?.data || result || {};
    return Response.json({ ...data, auth_precheck: { ok: true, accounts_checked: checks.length } });
  } catch (error: any) {
    return Response.json({
      ok: false,
      engine: 'unified-marketplace-decision-governance',
      error_code: 'ADS_AUTH_PRECHECK_INTERNAL_ERROR',
      error: error?.message || String(error),
      aborted_before_decisions: true,
      decisions_enqueued: 0,
    }, { status: 500 });
  }
});
