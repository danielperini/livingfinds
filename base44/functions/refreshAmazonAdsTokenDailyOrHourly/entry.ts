/**
 * refreshAmazonAdsTokenDailyOrHourly — Renovação preventiva de tokens Amazon Ads
 *
 * Objetivo: renovar proativamente antes de expirar, reduzindo falhas em produção.
 * - Roda a cada 50 minutos via automação agendada
 * - Só renova se token expira em menos de 10 minutos (ou ausente)
 * - Não renova se refresh_token ausente (evita erro desnecessário)
 * - Suporta múltiplas contas Amazon
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    // Aceitar chamada via automação (sem auth) ou service_role explícito
    const isAuto = req.headers.get('x-automation-trigger') === 'true' || body._service_role === true;
    if (!isAuto) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Buscar todas as contas ativas com refresh_token
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter(
      { status: 'connected' }, '-updated_date', 20
    );

    const results: any[] = [];
    const now = Date.now();

    for (const account of accounts) {
      const id = account.id;

      // Pular se não tem refresh_token
      if (!account.ads_refresh_token || !account.ads_refresh_token.startsWith('Atzr|')) {
        results.push({ account_id: id, skipped: true, reason: 'no_refresh_token' });
        continue;
      }

      // Pular se token ainda válido por mais de 10 minutos
      if (account.ads_access_token_expires_at) {
        const expiresMs = new Date(account.ads_access_token_expires_at).getTime();
        const minutesLeft = (expiresMs - now) / 60000;
        if (minutesLeft > 10) {
          results.push({ account_id: id, skipped: true, reason: 'token_still_valid', minutes_left: Math.round(minutesLeft) });
          continue;
        }
      }

      // Renovar
      try {
        const res = await base44.asServiceRole.functions.invoke('amazonAdsTokenManager', {
          amazon_account_id: id,
          force_refresh: false,
          _service_role: true,
        });
        const d = res?.data || res || {};
        results.push({
          account_id: id,
          ok: d.ok,
          from_cache: d.from_cache,
          expires_at: d.expires_at,
          error_type: d.error_type,
          requires_reauthorization: d.requires_reauthorization,
        });
      } catch (e: any) {
        results.push({ account_id: id, ok: false, error: e.message?.slice(0, 100) });
      }
    }

    const refreshed = results.filter(r => r.ok && !r.skipped && !r.from_cache).length;
    const skipped = results.filter(r => r.skipped).length;
    const failed = results.filter(r => !r.ok && !r.skipped).length;

    console.log(`[tokenRefreshCron] ${refreshed} renovados · ${skipped} pulados · ${failed} erros | ${Date.now() - t0}ms`);

    return Response.json({
      ok: true,
      accounts_processed: accounts.length,
      refreshed,
      skipped,
      failed,
      results,
      duration_ms: Date.now() - t0,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Erro interno' }, { status: 500 });
  }
});