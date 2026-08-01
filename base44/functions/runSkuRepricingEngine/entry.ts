/**
 * Adaptador legado de repricing.
 *
 * Toda avaliação e eventual escrita de preço pertence exclusivamente a
 * runAutomaticRepricing. Este nome permanece disponível somente para não
 * quebrar chamadores antigos; por padrão, ele força recommendation_only.
 */
import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

function unwrap(result: any): any {
  return result?.data ?? result ?? {};
}

function boundedProducts(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(Math.trunc(parsed), 200))
    : 20;
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) {
      const authenticated = await base44.auth.isAuthenticated().catch(() =>
        false
      );
      if (!authenticated) {
        return Response.json({ ok: false, error: "Não autorizado" }, {
          status: 401,
        });
      }
    }

    const operation = body.full_evaluation === true
      ? "full_evaluation"
      : "evaluate";
    const recommendationOnly = body.dry_run === true ||
      body.allow_canonical_execution !== true;
    const invoked = await base44.asServiceRole.functions.invoke(
      "runAutomaticRepricing",
      {
        _service_role: true,
        amazon_account_id: body.amazon_account_id,
        operation,
        max_products: boundedProducts(body.max_skus ?? body.max_products),
        recommendation_only: recommendationOnly,
        trigger_type: "legacy_runSkuRepricingEngine_adapter",
      },
    );
    const result = unwrap(invoked);
    return Response.json({
      ...result,
      source: "runSkuRepricingEngine",
      delegated_to: "runAutomaticRepricing",
      legacy_entrypoint: true,
      recommendation_only: recommendationOnly,
    }, { status: result?.ok === false ? 502 : 200 });
  } catch (error: any) {
    return Response.json({
      ok: false,
      source: "runSkuRepricingEngine",
      delegated_to: "runAutomaticRepricing",
      legacy_entrypoint: true,
      error: error?.message || "Falha ao delegar para o motor canônico.",
    }, { status: 500 });
  }
});
