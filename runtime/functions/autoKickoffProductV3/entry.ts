import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }
    if (!body.amazon_account_id || !body.asin) {
      return Response.json({ ok: false, error: 'amazon_account_id e asin são obrigatórios' }, { status: 400 });
    }

    const kickoffResponse = await base44.asServiceRole.functions.invoke('autoKickoffProductV2', {
      ...body,
      _service_role: true,
    });
    const kickoff = kickoffResponse?.data || kickoffResponse || {};

    if (kickoff?.scheduled && !body._window_execution) {
      return Response.json(kickoff);
    }

    if (!kickoff?.ok) {
      return Response.json({
        ...kickoff,
        ok: false,
        completion_status: 'incomplete',
        message: kickoff?.message || kickoff?.error || 'Kick-off não concluído.',
      }, { status: kickoff?.status || 500 });
    }

    const repairResponse = await base44.asServiceRole.functions.invoke('repairIncompleteAutoCampaigns', {
      amazon_account_id: body.amazon_account_id,
      asins: [body.asin],
      _window_execution: true,
      _service_role: true,
    });
    const repair = repairResponse?.data || repairResponse || {};
    const repairedItem = Array.isArray(repair?.results)
      ? repair.results.find((item: any) => String(item.asin) === String(body.asin))
      : null;

    const complete = repair?.ok === true && repairedItem?.complete === true;
    if (!complete) {
      return Response.json({
        ok: false,
        scheduled: Boolean(repair?.scheduled || repairedItem?.retry_scheduled),
        completion_status: 'incomplete',
        asin: body.asin,
        auto_campaign: kickoff?.auto_campaign || null,
        manual_campaigns: kickoff?.manual_campaigns || [],
        repair,
        message: repair?.message || repairedItem?.error || 'A campanha AUTO foi criada, mas ainda está em reparo para concluir ad group e anúncio do produto.',
      }, { status: repair?.scheduled ? 202 : 500 });
    }

    return Response.json({
      ...kickoff,
      ok: true,
      completion_status: 'complete',
      repair,
      message: 'Kick-off concluído. Campanha AUTO verificada com campanha, ad group e anúncio do produto ativos.',
    });
  } catch (error) {
    return Response.json({ ok: false, completion_status: 'incomplete', error: error?.message || 'Erro no Kick-off V3' }, { status: 500 });
  }
});
