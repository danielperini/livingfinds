import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { runPortfolioBudgetPacing } from '../../shared/portfolioBudgetPacing.ts';

/**
 * Entrada única do pacing intradiário da conta.
 * Os checkpoints antigos continuam aceitos apenas para compatibilidade e auditoria.
 */
Deno.serve(async (request) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 50);
    if (!accounts.length) {
      return Response.json({ ok: false, error: 'Nenhuma AmazonAccount conectada' }, { status: 404 });
    }

    const results = [];
    for (const account of accounts) results.push(await runPortfolioBudgetPacing(base44, account, body));
    const single = results.length === 1 ? results[0] : null;
    return Response.json({
      ...(single || {}),
      ok: results.every((result: any) => result?.ok !== false),
      accounts_processed: results.length,
      checkpoint_compatibility: body.checkpoint || null,
      results: results.length > 1 ? results : undefined,
      duration_ms: Date.now() - startedAt,
    });
  } catch (error: any) {
    return Response.json({
      ok: false,
      error: error?.message || 'Falha no pacing intradiário do portfólio',
      duration_ms: Date.now() - startedAt,
    }, { status: 500 });
  }
});
