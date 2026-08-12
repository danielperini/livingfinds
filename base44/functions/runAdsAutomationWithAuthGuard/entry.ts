import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { ADS_TOKEN_REVOKED_REAUTH_REQUIRED } from '../../shared/amazonCredentials.ts';

const ALLOWED_TARGETS = new Set([
  'runCanonicalDaypartingEngine',
  'runServingCampaignGrowthObjective',
]);

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && body._service_role !== true) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const targetFunction = String(body.target_function || '');
    if (!ALLOWED_TARGETS.has(targetFunction)) {
      return Response.json({ ok: false, error: 'TARGET_FUNCTION_NOT_ALLOWED', target_function: targetFunction }, { status: 400 });
    }

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1).catch(() => [])
      : await base44.asServiceRole.entities.AmazonAccount.list('-updated_date', 100).catch(() => []);

    if (!accounts.length) {
      return Response.json({
        ok: false,
        skipped: true,
        error_code: 'ADS_AUTH_PRECHECK_NO_ACCOUNT',
        aborted_before_decisions: true,
        decisions_enqueued: 0,
      }, { status: 409 });
    }

    for (const account of accounts) {
      const response = await base44.asServiceRole.functions.invoke('amazonAdsTokenManager', {
        _service_role: true,
        amazon_account_id: account.id,
        force_refresh: false,
        triggered_by: `runAdsAutomationWithAuthGuard:${targetFunction}`,
      }).catch((error: any) => ({
        ok: false,
        error_type: 'ADS_AUTH_PRECHECK_EXCEPTION',
        message: error?.message || String(error),
      }));
      const data = response?.data || response || {};
      if (data.ok !== true) {
        const revoked = data.requires_reauthorization === true || data.error_type === ADS_TOKEN_REVOKED_REAUTH_REQUIRED;
        await base44.asServiceRole.entities.SyncExecutionLog.create({
          amazon_account_id: account.id,
          operation: `amazon_ads:auth_guard:${targetFunction}`,
          status: 'error',
          trigger_type: body.trigger_type || 'scheduler',
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          records_processed: 0,
          error_message: revoked ? ADS_TOKEN_REVOKED_REAUTH_REQUIRED : String(data.message || data.error_type || 'ADS_AUTH_PRECHECK_FAILED').slice(0, 500),
          result_summary: JSON.stringify({
            target_function: targetFunction,
            aborted_before_decisions: true,
            decisions_enqueued: 0,
            amazon_error_code: data.amazon_error_code || null,
            requires_reauthorization: revoked,
          }).slice(0, 4000),
        }).catch(() => {});

        return Response.json({
          ok: false,
          skipped: true,
          target_function: targetFunction,
          error_code: revoked ? ADS_TOKEN_REVOKED_REAUTH_REQUIRED : 'ADS_AUTH_PRECHECK_FAILED',
          amazon_error_code: data.amazon_error_code || null,
          requires_reauthorization: revoked,
          aborted_before_decisions: true,
          decisions_enqueued: 0,
          message: revoked
            ? 'Amazon Ads requer reautorização. O job foi abortado antes de propor ou enfileirar decisões.'
            : String(data.message || 'Pré-checagem Amazon Ads falhou.'),
        }, { status: revoked ? 401 : 503 });
      }
    }

    const { target_function: _targetFunction, ...forwardPayload } = body;
    const result = await base44.asServiceRole.functions.invoke(targetFunction, {
      ...forwardPayload,
      _service_role: true,
      auth_precheck_passed: true,
      auth_precheck_function: 'runAdsAutomationWithAuthGuard',
    });
    return Response.json(result?.data || result || {});
  } catch (error: any) {
    return Response.json({
      ok: false,
      error_code: 'ADS_AUTH_PRECHECK_INTERNAL_ERROR',
      error: error?.message || String(error),
      aborted_before_decisions: true,
      decisions_enqueued: 0,
    }, { status: 500 });
  }
});
