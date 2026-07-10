/**
 * repairAmazonAdsAuthState — repara locks e falso estado conectado da integração Amazon Ads
 *
 * Uso: botão "Reparar conexão Amazon" ou chamada service_role.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const auth = await base44.auth.isAuthenticated().catch(() => false);

    if (!auth && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accountId = body.amazon_account_id;
    if (!accountId) {
      return Response.json({ ok: false, error_type: 'missing_account_id', error: 'amazon_account_id obrigatório' }, { status: 400 });
    }

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: accountId }, null, 1);
    const account = accounts[0];
    if (!account) {
      return Response.json({ ok: false, error_type: 'account_not_found', error: 'Conta Amazon não encontrada' }, { status: 404 });
    }

    const now = new Date().toISOString();
    const dbRefreshToken = String(account.ads_refresh_token || '');
    const envRefreshToken = String(Deno.env.get('ADS_REFRESH_TOKEN') || '');

    // 1) Limpar lock preso e marcar diagnóstico em andamento.
    await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
      ads_token_refresh_in_progress: false,
      ads_token_refresh_started_at: null,
      ads_token_status: dbRefreshToken?.startsWith('Atzr|') ? 'checking' : 'missing',
      ads_active_token_source: dbRefreshToken ? 'database' : 'missing',
      ads_env_token_present: !!envRefreshToken,
      ads_token_source_conflict: !!(dbRefreshToken && envRefreshToken && dbRefreshToken !== envRefreshToken),
      ads_token_last_error: null,
      updated_at: now,
    }).catch(() => {});

    if (!dbRefreshToken || !dbRefreshToken.startsWith('Atzr|')) {
      const msg = 'Refresh token ausente ou inválido no banco. Reconecte Amazon Ads via OAuth.';
      await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
        ads_token_status: 'missing',
        ads_requires_reauth: true,
        status: 'error',
        error_message: msg,
        ads_token_last_error: msg,
      }).catch(() => {});
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: accountId,
        operation: 'amazon_ads:repair_auth_state',
        status: 'error',
        trigger_type: body.trigger_type || 'manual',
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        records_processed: 0,
        error_message: msg,
      }).catch(() => {});
      return Response.json({ ok: false, requires_reauthorization: true, error_type: 'missing_refresh_token', message: msg });
    }

    // 2) Rodar diagnóstico real de ponta a ponta.
    const diagResponse = await base44.asServiceRole.functions.invoke('testAmazonAdsTokenEndToEnd', {
      amazon_account_id: accountId,
      _service_role: true,
    });
    const diag = diagResponse?.data || diagResponse || {};

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'amazon_ads:repair_auth_state',
      status: diag.ok ? 'success' : 'error',
      trigger_type: body.trigger_type || 'manual',
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      records_processed: diag.ok ? 1 : 0,
      result_summary: diag.ok ? JSON.stringify(diag).slice(0, 4000) : null,
      error_message: diag.ok ? null : String(diag.message || diag.error || 'Falha no reparo').slice(0, 500),
    }).catch(() => {});

    return Response.json({
      ok: diag.ok === true,
      repaired: diag.ok === true,
      diagnostic: diag,
      message: diag.ok
        ? 'Conexão Amazon Ads reparada e validada com refresh real + /v2/profiles.'
        : (diag.message || 'Não foi possível reparar a conexão Amazon Ads.'),
    }, { status: diag.ok ? 200 : 400 });
  } catch (error: any) {
    return Response.json({ ok: false, error_type: 'internal_error', error: String(error?.message || 'Erro ao reparar conexão Amazon Ads').slice(0, 500) }, { status: 500 });
  }
});
