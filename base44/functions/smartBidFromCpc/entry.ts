/**
 * smartBidFromCpc — SMART_BID_CANONICAL_REDIRECT_V3
 *
 * P0 HOTFIX:
 * Esta função NÃO possui mais autorização para escrever bids diretamente
 * na Amazon. Todas as alterações de lance devem nascer como decisão no
 * motor unificado e seguir:
 *
 * snapshot -> governance -> arbitragem -> fila canônica ->
 * executeApprovedDecisionQueue -> Amazon -> confirmação.
 *
 * Mantida apenas como wrapper de compatibilidade para callers legados.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));

    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !payload._service_role) {
      return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const response = await base44.asServiceRole.functions.invoke(
      'runUnifiedDecisionEngine',
      {
        ...payload,
        _service_role: true,
        skip_direct_execution: true,
        trigger_type:
          payload.trigger_type ||
          'smart_bid_legacy_redirect_to_canonical_engine',
      },
    );

    const data = response?.data || response || {};

    return Response.json({
      ok: data?.ok !== false,
      deprecated_direct_executor: true,
      canonical_redirect: true,
      marker: 'SMART_BID_CANONICAL_REDIRECT_V3',
      redirected_to: 'runUnifiedDecisionEngine',
      direct_amazon_bid_write: false,
      result: data,
    });
  } catch (error: any) {
    return Response.json(
      {
        ok: false,
        canonical_redirect: true,
        marker: 'SMART_BID_CANONICAL_REDIRECT_V3',
        error: error?.message || String(error),
      },
      { status: 500 },
    );
  }
});
