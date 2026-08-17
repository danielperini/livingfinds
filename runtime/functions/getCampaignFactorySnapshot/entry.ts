import { createClientFromRequest } from "npm:@base44/sdk@0.8.6";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const serviceRole = body?._service_role === true;
    const user = serviceRole ? null : await base44.auth.me().catch(() => null);

    if (!serviceRole && !user) return json({ ok: false, error: "Não autenticado" }, 401);

    const account = body?.amazon_account_id
      ? (await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }))?.[0]
      : (await base44.asServiceRole.entities.AmazonAccount.filter({ user_id: user?.id }))?.[0];

    if (!account) return json({ ok: false, error: "Conta Amazon não encontrada" }, 404);
    if (!serviceRole && account.user_id && account.user_id !== user?.id) {
      return json({ ok: false, error: "Conta não autorizada" }, 403);
    }

    const refresh: Record<string, unknown> = {};
    if (body?.refresh !== false) {
      for (const [key, functionName] of [
        ["term_bank", "updateTermBankFromAutomaticCampaigns"],
        ["factory", "runCampaignFactory"],
      ]) {
        try {
          const result = await base44.asServiceRole.functions.invoke(functionName, {
            _service_role: true,
            amazon_account_id: account.id,
          });
          refresh[key] = result?.data || { ok: true };
        } catch (error) {
          refresh[key] = {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
    }

    const [keywordBank, plans, termBank, suggestions] = await Promise.all([
      base44.asServiceRole.entities.KeywordBank.filter(
        { amazon_account_id: account.id }, "-promotion_score", 3000,
      ),
      base44.asServiceRole.entities.CampaignFactoryPlan.filter(
        { amazon_account_id: account.id }, "-proposed_at", 1000,
      ),
      base44.asServiceRole.entities.TermBank.filter(
        { amazon_account_id: account.id }, "-confidence", 5000,
      ),
      base44.asServiceRole.entities.KeywordSuggestion.filter(
        { amazon_account_id: account.id }, "-created_at", 3000,
      ),
    ]);

    const lifecycle = keywordBank.reduce((acc: Record<string, number>, row: any) => {
      const key = String(row.lifecycle_status || "DISCOVERED").toUpperCase();
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    return json({
      ok: true,
      generated_at: new Date().toISOString(),
      keyword_bank: keywordBank,
      plans,
      term_bank_count: termBank.length,
      suggestions_count: suggestions.length,
      summary: { keyword_bank: keywordBank.length, plans: plans.length, lifecycle },
      refresh,
    });
  } catch (error) {
    console.error("getCampaignFactorySnapshot:", error);
    return json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, 500);
  }
});
