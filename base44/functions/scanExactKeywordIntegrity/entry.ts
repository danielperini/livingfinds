import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role || !body.amazon_account_id) {
      return Response.json({ ok: false, error: 'Uso interno e amazon_account_id obrigatório' }, { status: 400 });
    }

    const campaigns = await base44.asServiceRole.entities.Campaign.filter({
      amazon_account_id: body.amazon_account_id,
      targeting_type: 'MANUAL',
    }, '-updated_at', 2000).catch(() => []);

    const asins = [...new Set(campaigns
      .filter((campaign: any) => {
        const name = String(campaign.name || campaign.campaign_name || '').toUpperCase();
        const state = String(campaign.state || campaign.status || '').toLowerCase();
        return name.includes('EXACT') && !['archived', 'ended'].includes(state) && campaign.asin;
      })
      .map((campaign: any) => String(campaign.asin))
    )];

    if (!asins.length) return Response.json({ ok: true, checked_asins: 0, message: 'Nenhuma campanha manual EXACT encontrada.' });

    const results = [];
    for (let offset = 0; offset < asins.length; offset += 10) {
      const batch = asins.slice(offset, offset + 10);
      const response = await base44.asServiceRole.functions.invoke('repairExactAdGroupKeywords', {
        amazon_account_id: body.amazon_account_id,
        asins: batch,
        _window_execution: body._window_execution === true,
        _service_role: true,
      });
      const data = response?.data || response || {};
      results.push({ asins: batch, ...data });
    }

    return Response.json({
      ok: results.every((item: any) => item.ok !== false),
      checked_asins: asins.length,
      batches: results.length,
      repaired_groups: results.reduce((sum: number, item: any) => sum + Number(item.repaired || 0), 0),
      incomplete_groups: results.reduce((sum: number, item: any) => sum + Number(item.incomplete || 0), 0),
      results,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao verificar keywords EXACT' }, { status: 500 });
  }
});
