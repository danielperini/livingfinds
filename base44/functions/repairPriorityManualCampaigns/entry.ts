import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const normalize = (value: unknown) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toLowerCase();

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) {
      return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });
    }

    const targets = (Array.isArray(body.targets) ? body.targets : [])
      .map((target: any) => ({
        asin: String(target?.asin || '').trim().toUpperCase(),
        name: String(target?.name || '').trim(),
      }))
      .filter((target: any) => target.asin && target.name);
    if (!targets.length) {
      return Response.json({ ok: false, error: 'targets obrigatório' }, { status: 400 });
    }

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter(
      { status: 'connected' }, '-updated_at', 10,
    ).catch(() => []);
    const results: any[] = [];

    for (const account of accounts) {
      const campaigns = await base44.asServiceRole.entities.Campaign.filter(
        { amazon_account_id: account.id }, '-updated_at', 2000,
      ).catch(() => []);

      for (const target of targets) {
        const expectedName = normalize(target.name);
        const matches = campaigns.filter((campaign: any) => {
          const name = normalize(campaign.name || campaign.campaign_name);
          const campaignAsin = String(campaign.asin || '').trim().toUpperCase();
          return name === expectedName && (!campaignAsin || campaignAsin === target.asin);
        });
        const campaign = matches.find((row: any) =>
          normalize(row.state || row.status) === 'enabled'
        ) || matches[0];
        const campaignId = String(campaign?.amazon_campaign_id || campaign?.campaign_id || '');

        if (!campaign || !campaignId) {
          results.push({
            asin: target.asin,
            campaign_name: target.name,
            ok: false,
            status: 'campaign_not_found',
          });
          continue;
        }

        const response = await base44.asServiceRole.functions.invoke(
          'repairExactAdGroupIntegrity',
          {
            amazon_account_id: account.id,
            asin: target.asin,
            campaign_id: campaignId,
            _service_role: true,
          },
        ).catch((error: any) => ({
          data: { ok: false, error: error?.message || String(error) },
        }));
        const data = response?.data || response || {};
        results.push({
          asin: target.asin,
          campaign_id: campaignId,
          campaign_name: target.name,
          ok: data.ok === true,
          status: data.ok === true ? 'structure_verified' : 'repair_failed',
          details: data,
        });
      }
    }

    return Response.json({
      ok: results.every((row) => row.ok),
      checked: results.length,
      verified: results.filter((row) => row.ok).length,
      failed: results.filter((row) => !row.ok).length,
      results,
    });
  } catch (error: any) {
    return Response.json({
      ok: false,
      error: error?.message || String(error),
    }, { status: 500 });
  }
});
