import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { availableAdsStock, stockAdsDecision } from '../../shared/stockAdsPolicy.ts';

async function listEnabled(base44: any, aid: string) {
  const campaigns: any[] = [];
  let nextToken: string | undefined;
  for (let page = 0; page < 30; page++) {
    const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
      _service_role: true, amazon_account_id: aid, operation: 'verifyRemoteSkuCampaignFloor',
      method: 'POST', path: '/sp/campaigns/list',
      payload: { stateFilter: { include: ['ENABLED'] }, maxResults: 100, ...(nextToken ? { nextToken } : {}) },
      content_type: 'application/vnd.spCampaign.v3+json', accept: 'application/vnd.spCampaign.v3+json',
    });
    const data = response?.data || response || {};
    if (data.ok !== true) throw new Error(data.error || data.errors?.[0]?.message || 'Falha ao listar campanhas ENABLED na Amazon');
    const payload = data.payload || data;
    campaigns.push(...(Array.isArray(payload.campaigns) ? payload.campaigns : []));
    nextToken = payload.nextToken;
    if (!nextToken) break;
  }
  return campaigns;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    if (body._service_role !== true) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });
    const floor = Math.max(1, Number(body.manual_floor || 1));
    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.list('-updated_date', 50);
    const connected = accounts.filter((a: any) => a.ads_profile_id && (a.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN')));
    const results: any[] = [];

    for (const account of connected) {
      const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: account.id }, '-updated_date', 2000);
      const eligible = products.filter((p: any) => availableAdsStock(p) > 1 && stockAdsDecision(p) === 'activate'
        && p.listing_suppressed !== true && String(p.sku || '').trim() && /^B0[A-Z0-9]{8}$/.test(String(p.asin || '').trim().toUpperCase()));
      let remote = await listEnabled(base44, account.id);
      // A listagem da Amazon pode atrasar alguns segundos depois de PUT/POST.
      // Repetir somente enquanto o conjunto ainda nao cobre todos os ASINs.
      for (let attempt = 0; attempt < 3; attempt++) {
        const missing = eligible.some((p: any) => {
          const asin = String(p.asin || '').trim().toUpperCase();
          const linked = remote.filter((c: any) => String(c.name || '').toUpperCase().includes(asin));
          return linked.filter((c: any) => String(c.targetingType || '').toUpperCase() === 'AUTO').length < 1
            || linked.filter((c: any) => String(c.targetingType || '').toUpperCase() === 'MANUAL').length < floor;
        });
        if (!missing) break;
        await new Promise((resolve) => setTimeout(resolve, 10000));
        remote = await listEnabled(base44, account.id);
      }
      const seen = new Set<string>();
      for (const product of eligible) {
        const sku = String(product.sku).trim();
        const asin = String(product.asin).trim().toUpperCase();
        if (seen.has(`${sku}|${asin}`)) continue;
        seen.add(`${sku}|${asin}`);
        const linked = remote.filter((c: any) => String(c.name || '').toUpperCase().includes(asin));
        const autos = linked.filter((c: any) => String(c.targetingType || '').toUpperCase() === 'AUTO');
        const manuals = linked.filter((c: any) => String(c.targetingType || '').toUpperCase() === 'MANUAL');
        results.push({ sku, asin, auto_active: autos.length, manual_active: manuals.length,
          // AUTO e intencionalmente 1: uma segunda AUTO disputa os mesmos
          // termos de descoberta e infla gasto. O verificador deve expor tanto
          // ausencia quanto duplicidade como divergencia operacional.
          compliant: autos.length === 1 && manuals.length >= floor,
          auto_campaign_ids: autos.map((c: any) => String(c.campaignId)),
          manual_campaign_ids: manuals.map((c: any) => String(c.campaignId)) });
      }
    }
    const deficits = results.filter((r: any) => !r.compliant);
    return Response.json({ ok: deficits.length === 0, source: 'amazon_ads_remote_enabled_list', manual_floor: floor,
      products: results.length, compliant: results.length - deficits.length, deficits_count: deficits.length,
      deficits, results, verified_at: new Date().toISOString() }, { status: deficits.length ? 207 : 200 });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
});
