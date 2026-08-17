import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function slot() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
    }).formatToParts(new Date()).map((x) => [x.type, x.value])
  );
  const h = Number(p.hour || 0);
  const day = `${p.year}-${p.month}-${p.day}`;
  if (h < 3) {
    const n = h + 1;
    return {
      hour: n,
      window: `${String(n).padStart(2, '0')}:00-${String(n + 1).padStart(2, '0')}:00`,
      at: new Date(`${day}T${String(n).padStart(2, '0')}:00:00-03:00`),
    };
  }
  if (h < 13) return { hour: 13, window: '13:00-14:00', at: new Date(`${day}T13:00:00-03:00`) };
  const t = new Date(`${day}T12:00:00-03:00`);
  t.setDate(t.getDate() + 1);
  const d = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(t);
  return { hour: 0, window: '00:00-01:00', at: new Date(`${d}T00:00:00-03:00`) };
}

const active = (c: any) => !['archived', 'ended', 'deleted'].includes(String(c.state || c.status || '').toLowerCase());

function extractSku(name: string) {
  const match = String(name || '').match(/FBA-[A-Za-z0-9-]+/i);
  return match?.[0] || null;
}

function extractAsin(name: string) {
  const match = String(name || '').toUpperCase().match(/\bB0[A-Z0-9]{8}\b/);
  return match?.[0] || null;
}

Deno.serve(async (req) => {
  try {
    const b = createClientFromRequest(req);
    const x = await req.json().catch(() => ({}));
    const auth = await b.auth.isAuthenticated().catch(() => false);
    if (!auth && !x._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    if (!x.amazon_account_id) return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });

    const s = slot();
    const campaigns = await b.asServiceRole.entities.Campaign.filter({ amazon_account_id: x.amazon_account_id }, '-updated_at', 5000).catch(() => []);
    const products = await b.asServiceRole.entities.Product.filter({ amazon_account_id: x.amazon_account_id }, '-updated_at', 5000).catch(() => []);
    const productBySku = new Map(products.map((p: any) => [String(p.sku || '').toLowerCase(), p]));
    const productByAsin = new Map(products.map((p: any) => [String(p.asin || '').toUpperCase(), p]));

    let auto = 0;
    let exact = 0;
    let existing = 0;
    let unresolved = 0;

    for (const c of campaigns.filter(active)) {
      const name = String(c.name || c.campaign_name || '');
      const target = String(c.targeting_type || '').toUpperCase();
      const campaignId = c.campaign_id ? String(c.campaign_id) : c.amazon_campaign_id ? String(c.amazon_campaign_id) : null;
      const skuFromName = extractSku(name);
      const asinFromName = extractAsin(name);
      const product = productByAsin.get(String(c.asin || asinFromName || '').toUpperCase())
        || productBySku.get(String(c.sku || skuFromName || '').toLowerCase())
        || null;
      const asin = String(c.asin || asinFromName || product?.asin || '').trim().toUpperCase();
      const sku = String(c.sku || skuFromName || product?.sku || '').trim();

      if (!campaignId || !asin) {
        unresolved += 1;
        await b.asServiceRole.entities.Campaign.update(c.id, {
          completion_status: 'incomplete',
          is_incomplete: true,
          repair_status: 'needs_product_mapping',
          last_repair_error: !campaignId ? 'campaign_id ausente.' : 'Não foi possível resolver ASIN por nome, SKU ou produto.',
        }).catch(() => {});
        continue;
      }

      const commonCampaignUpdate = {
        asin,
        sku: sku || null,
        repair_queue_window: s.window,
        repair_scheduled_at: s.at.toISOString(),
      };

      if (target === 'AUTO' || name.toUpperCase().startsWith('AUTO |') || name.toUpperCase().startsWith('SP-AUTO-')) {
        const q = await b.asServiceRole.entities.AutoCampaignRepairQueue.filter({
          amazon_account_id: x.amazon_account_id,
          campaign_id: campaignId,
          status: 'scheduled',
        }, '-created_date', 1).catch(() => []);

        if (q.length) {
          existing += 1;
        } else {
          await b.asServiceRole.entities.AutoCampaignRepairQueue.create({
            amazon_account_id: x.amazon_account_id,
            asin,
            sku: sku || null,
            campaign_id: campaignId,
            campaign_name: name || null,
            status: 'scheduled',
            queue_hour: s.hour,
            queue_window: s.window,
            scheduled_at: s.at.toISOString(),
            attempt_count: 0,
            max_attempts: 5,
          });
          auto += 1;
        }

        await b.asServiceRole.entities.Campaign.update(c.id, {
          ...commonCampaignUpdate,
          completion_status: 'verification_pending',
          repair_status: 'scheduled',
        }).catch(() => {});
      }

      if (target === 'MANUAL' || name.toUpperCase().includes('EXATA') || name.toUpperCase().includes('EXACT')) {
        const kws = await b.asServiceRole.entities.Keyword.filter({
          amazon_account_id: x.amazon_account_id,
          campaign_id: campaignId,
          match_type: 'exact',
        }, '-updated_at', 100).catch(() => []);
        const enabled = kws.filter((k: any) => ['enabled', 'active'].includes(String(k.state || k.status || '').toLowerCase()));
        if (enabled.length && c.completion_status === 'complete') continue;

        const q = await b.asServiceRole.entities.KeywordRepairQueue.filter({
          amazon_account_id: x.amazon_account_id,
          campaign_id: campaignId,
          status: 'scheduled',
        }, '-created_date', 1).catch(() => []);

        if (q.length) {
          existing += 1;
        } else {
          await b.asServiceRole.entities.KeywordRepairQueue.create({
            amazon_account_id: x.amazon_account_id,
            asin,
            sku: sku || null,
            campaign_id: campaignId,
            ad_group_id: c.ad_group_id ? String(c.ad_group_id) : null,
            campaign_name: name || null,
            status: 'scheduled',
            queue_hour: s.hour,
            queue_window: s.window,
            scheduled_at: s.at.toISOString(),
            attempt_count: 0,
            max_attempts: 5,
          });
          exact += 1;
        }

        await b.asServiceRole.entities.Campaign.update(c.id, {
          ...commonCampaignUpdate,
          completion_status: 'incomplete',
          is_incomplete: true,
          repair_status: 'scheduled',
          last_repair_error: enabled.length ? null : 'Grupo EXACT sem palavra-chave ativa confirmada.',
        }).catch(() => {});
      }
    }

    return Response.json({
      ok: true,
      prepared_at: new Date().toISOString(),
      queue_window: s.window,
      scheduled_at: s.at.toISOString(),
      campaigns_scanned: campaigns.length,
      auto_repairs_queued: auto,
      exact_keyword_repairs_queued: exact,
      already_queued: existing,
      unresolved_campaigns: unresolved,
      total_new_repairs: auto + exact,
      queue_identity: 'campaign_id',
      sku_to_asin_resolution: true,
      message: `Reparos preparados por campanha antes da janela ${s.window}.`,
    });
  } catch (e) {
    return Response.json({ ok: false, error: e?.message || 'Erro ao preparar reparos' }, { status: 500 });
  }
});