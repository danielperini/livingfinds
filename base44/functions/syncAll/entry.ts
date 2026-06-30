/**
 * syncAll — DEPRECATED: função obsoleta que dependia de Xano externo.
 * Substituída por runUnifiedAdsPipeline.
 * Mantida temporariamente para rollback.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const amazon_account_id = body.amazon_account_id;

    return Response.json({
      ok: false,
      deprecated: true,
      replacement: 'runUnifiedAdsPipeline',
      message: 'syncAll foi descontinuada. Use runUnifiedAdsPipeline.',
    });
  } catch (error) {
    return Response.json({ ok: false, error: error.message });
  }
});