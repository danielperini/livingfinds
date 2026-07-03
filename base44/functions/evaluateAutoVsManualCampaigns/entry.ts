import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const n = (v) => Number(v || 0);

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const { amazon_account_id, asin } = await req.json().catch(() => ({}));
    if (!amazon_account_id) return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });

    const campaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id }, '-created_date', 5000);
    const groups = new Map();
    for (const c of campaigns) {
      if (asin && c.asin !== asin) continue;
      if (!c.asin || ['archived', 'ended'].includes(String(c.state || c.status).toLowerCase())) continue;
      const list = groups.get(c.asin) || [];
      list.push(c); groups.set(c.asin, list);
    }

    const decisions = [];
    for (const [productAsin, list] of groups) {
      const autos = list.filter((c) => String(c.targeting_type || '').toUpperCase() === 'AUTO');
      const manuals = list.filter((c) => String(c.targeting_type || '').toUpperCase() === 'MANUAL');
      if (!autos.length || !manuals.length) continue;

      const manualOrders = manuals.reduce((s, c) => s + n(c.orders_30d ?? c.orders), 0);
      const manualSales = manuals.reduce((s, c) => s + n(c.sales_30d ?? c.sales), 0);
      const manualSpend = manuals.reduce((s, c) => s + n(c.spend_30d ?? c.spend), 0);
      const manualRoas = manualSpend > 0 ? manualSales / manualSpend : 0;
      const manualAcos = manualSales > 0 ? manualSpend / manualSales * 100 : 999;

      for (const auto of autos) {
        const autoOrders = n(auto.orders_30d ?? auto.orders);
        const autoSales = n(auto.sales_30d ?? auto.sales);
        const autoSpend = n(auto.spend_30d ?? auto.spend);
        const autoRoas = autoSpend > 0 ? autoSales / autoSpend : 0;
        const autoAcos = autoSales > 0 ? autoSpend / autoSales * 100 : 999;

        const enoughData = manualSpend >= 5 && (manualOrders + autoOrders) >= 2;
        const roasWin = manualRoas > autoRoas * 1.15;
        const acosWin = manualAcos < autoAcos * 0.85;
        const orderWin = manualOrders >= Math.max(2, autoOrders);
        const autoDecline = autoSpend > 0 && (autoOrders === 0 || autoRoas < 1);
        const confidence = Math.min(0.99,
          (enoughData ? 0.35 : 0) +
          (roasWin ? 0.25 : 0) +
          (acosWin ? 0.20 : 0) +
          (orderWin ? 0.10 : 0) +
          (autoDecline ? 0.10 : 0)
        );

        if (confidence >= 0.85) {
          const pause = await base44.functions.invoke('pauseCampaign', {
            amazon_account_id,
            campaign_id: auto.campaign_id,
            asin: productAsin,
            sku: auto.sku || null,
          });
          decisions.push({ asin: productAsin, campaign_id: auto.campaign_id, action: pause?.data?.ok ? 'paused' : 'pause_failed', confidence });
        } else {
          decisions.push({ asin: productAsin, campaign_id: auto.campaign_id, action: 'kept_active', confidence });
        }
      }
    }

    return Response.json({ ok: true, evaluated: decisions.length, decisions, threshold: 0.85 });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro na avaliação AUTO x manual' }, { status: 500 });
  }
});
