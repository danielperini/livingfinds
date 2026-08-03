import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { availableAdsStock, stockAdsDecision } from '../../shared/stockAdsPolicy.ts';
import { clearManualPauseLockPatch } from '../../shared/productCampaignPauseGuard.ts';

const MANUAL_FLOOR = 5;
const enabled = (c: any) => String(c.amazon_status || c.state || c.status || '').toUpperCase() === 'ENABLED';
const manual = (c: any) => {
  const type = String(c.targeting_type || '').toUpperCase();
  const name = String(c.name || c.campaign_name || '').toUpperCase();
  return !name.includes('AUTO') && (type === 'MANUAL' || name.includes('MANUAL'));
};
const archived = (c: any) => c.archived === true || String(c.amazon_status || c.state || c.status || '').toUpperCase() === 'ARCHIVED';
const idOf = (c: any) => String(c.campaign_id || c.amazon_campaign_id || '').trim();
const num = (v: any) => Number(v || 0);
const norm = (v: any) => String(v || '').toLowerCase().trim().replace(/\s+/g, ' ');

function uniqueCampaigns(rows: any[]) {
  const seen = new Set<string>();
  return rows.filter((row: any) => {
    const id = idOf(row);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function titleSeeds(product: any): string[] {
  const title = norm(product.product_name || product.title || product.name || '')
    .replace(/[^a-z0-9\sáéíóúâêôãõç-]/gi, ' ');
  const words = title.split(/\s+/).filter((word: string) => word.length > 2);
  const seeds = [title.slice(0, 40)];
  for (let size = 5; size >= 2; size--) {
    for (let i = 0; i + size <= words.length; i++) seeds.push(words.slice(i, i + size).join(' ').slice(0, 40));
  }
  return [...new Set(seeds.map(norm).filter((term) => term.length >= 5))];
}

function belongsTo(c: any, sku: string, asin: string) {
  const cAsin = String(c.asin || '').trim().toUpperCase();
  const cSku = String(c.sku || '').trim().toUpperCase();
  const name = String(c.name || c.campaign_name || '').toUpperCase();
  return cAsin === asin || cSku === sku.toUpperCase() || name.includes(asin) || name.includes(sku.toUpperCase());
}

function amazonErrors(result: any): any[] {
  const data = result?.data || result || {};
  const payload = data?.payload || data;
  return payload?.campaigns?.error || payload?.campaigns?.errors || payload?.errors || [];
}

async function remoteCampaigns(base44: any, aid: string, ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))];
  const rows: any[] = [];
  for (let i = 0; i < unique.length; i += 100) {
    const batch = unique.slice(i, i + 100);
    const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
      _service_role: true, amazon_account_id: aid, operation: 'verifySkuCampaignFloorRemote',
      method: 'POST', path: '/sp/campaigns/list',
      payload: { campaignIdFilter: { include: batch }, stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] }, maxResults: 100 },
      content_type: 'application/vnd.spCampaign.v3+json', accept: 'application/vnd.spCampaign.v3+json',
    }).catch((error: any) => ({ data: { ok: false, error: error?.message } }));
    const data = response?.data || response || {};
    if (data.ok !== true) throw new Error(data.error || data.errors?.[0]?.message || 'Falha ao confirmar campanhas na Amazon');
    const payload = data.payload || data;
    rows.push(...(Array.isArray(payload.campaigns) ? payload.campaigns : []));
  }
  return rows;
}

const remoteEnabled = (c: any) => String(c.state || '').toUpperCase() === 'ENABLED';
const remoteManual = (c: any) => String(c.targetingType || c.targeting_type || '').toUpperCase() === 'MANUAL';
const remoteAuto = (c: any) => String(c.targetingType || c.targeting_type || '').toUpperCase() === 'AUTO';

Deno.serve(async (req) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    if (body._service_role !== true) {
      const user = await base44.auth.me().catch(() => null);
      if (!user || user.role !== 'admin') return Response.json({ ok: false, error: 'Admin only' }, { status: 403 });
    }

    const floor = Math.max(MANUAL_FLOOR, Number(body.manual_floor || MANUAL_FLOOR));
    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.list('-updated_date', 50);
    const connected = accounts.filter((a: any) => a.ads_profile_id && (a.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN')));
    const results: any[] = [];

    for (const account of connected) {
      const aid = account.id;
      const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, '-updated_date', 2000);
      const campaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, '-updated_date', 5000);
      const eligible = products.filter((p: any) => availableAdsStock(p) > 1 && stockAdsDecision(p) === 'activate'
        && p.listing_suppressed !== true && String(p.sku || '').trim() && /^B0[A-Z0-9]{8}$/.test(String(p.asin || '').trim().toUpperCase()));
      const seen = new Set<string>();

      for (const product of eligible) {
        const sku = String(product.sku).trim();
        const asin = String(product.asin).trim().toUpperCase();
        if (seen.has(`${sku}|${asin}`)) continue;
        seen.add(`${sku}|${asin}`);

        // O pedido de cobertura total autoriza Ads para este SKU elegivel.
        // Limpar todas as linhas duplicadas do catalogo, pois uma unica linha
        // stale com manual_block bloqueia o gateway para o ASIN inteiro.
        const now = new Date().toISOString();
        const sameProductRows = products.filter((p: any) =>
          String(p.asin || '').trim().toUpperCase() === asin || String(p.sku || '').trim().toUpperCase() === sku.toUpperCase());
        for (const row of sameProductRows) {
          await base44.asServiceRole.entities.Product.update(row.id, {
            ...clearManualPauseLockPatch(now, 'sku_campaign_floor_authorization'),
            ads_scope_status: 'authorized', ads_authorized_by_user: true,
            ads_authorized_at: now, ads_authorized_by: 'decision_engine',
            should_activate_campaign: true,
          }).catch(() => {});
        }

        const autoResult = await base44.asServiceRole.functions.invoke('createAutoCampaignForAsin', {
          _service_role: true, amazon_account_id: aid, sku, asin,
          product_name: product.product_name || product.title || product.name || '',
        }).catch((error: any) => ({ data: { ok: false, error: error?.message } }));
        let auto = autoResult?.data || autoResult || {};
        if (auto.campaign_id) {
          const probe = (await remoteCampaigns(base44, aid, [String(auto.campaign_id)]))[0];
          if (String(probe?.state || '').toUpperCase() === 'ARCHIVED') {
            const stale = campaigns.find((c: any) => idOf(c) === String(auto.campaign_id));
            if (stale) await base44.asServiceRole.entities.Campaign.update(stale.id, {
              state: 'archived', status: 'archived', amazon_status: 'ARCHIVED', archived: true,
              is_operational: false, requires_attention: true, synced_at: new Date().toISOString(),
            }).catch(() => {});
            const replacement = await base44.asServiceRole.functions.invoke('createAutoCampaignForAsin', {
              _service_role: true, amazon_account_id: aid, sku, asin,
              product_name: product.product_name || product.title || product.name || '',
            }).catch((error: any) => ({ data: { ok: false, error: error?.message } }));
            auto = replacement?.data || replacement || {};
          }
        }
        const candidates = uniqueCampaigns(campaigns.filter((c: any) => manual(c) && !archived(c) && idOf(c) && belongsTo(c, sku, asin)));
        const ranked = [...candidates].sort((a: any, b: any) => {
          const canonicalA = String(a.name || a.campaign_name || '').toUpperCase().startsWith('SP | MANUAL') ? 1 : 0;
          const canonicalB = String(b.name || b.campaign_name || '').toUpperCase().startsWith('SP | MANUAL') ? 1 : 0;
          return canonicalB - canonicalA || num(b.orders) - num(a.orders) || num(b.sales) - num(a.sales)
            || num(b.roas) - num(a.roas) || num(a.spend) - num(b.spend);
        });
        // Reafirmar o piso diretamente na Amazon mesmo quando o banco local
        // estiver stale. Estado local nunca conta como prova de ativacao.
        const selected = ranked.slice(0, floor);
        const reactivated: string[] = [];
        const errors: any[] = [];

        for (let i = 0; i < selected.length; i += 10) {
          const batch = selected.slice(i, i + 10);
          const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
            _service_role: true, amazon_account_id: aid, operation: 'ensureSkuManualCampaignFloor',
            method: 'PUT', path: '/sp/campaigns',
            payload: { campaigns: batch.map((c: any) => ({ campaignId: idOf(c), state: 'ENABLED' })) },
            content_type: 'application/vnd.spCampaign.v3+json', accept: 'application/vnd.spCampaign.v3+json',
          }).catch((error: any) => ({ data: { ok: false, error: error?.message } }));
          const responseData = response?.data || response || {};
          const batchErrors = amazonErrors(response);
          if (responseData.ok !== true) {
            errors.push(...batch.map((campaign: any) => ({ campaign_id: idOf(campaign), error: responseData.error || responseData.errors?.[0]?.message || `Amazon HTTP ${responseData.status || 'unknown'}` })));
            continue;
          }
          for (const campaign of batch) {
            const campaignId = idOf(campaign);
            const rejected = batchErrors.find((e: any) => String(e.campaignId || e.campaign_id || '') === campaignId);
            if (rejected) { errors.push({ campaign_id: campaignId, error: rejected.message || rejected.code }); continue; }
            reactivated.push(campaignId);
          }
        }

        let remoteRows = await remoteCampaigns(base44, aid, [auto.campaign_id, ...candidates.map(idOf)].filter(Boolean));
        const autoRemote = remoteRows.find((c: any) => String(c.campaignId || '') === String(auto.campaign_id || ''));
        const autoActive = Boolean(auto.ok !== false && autoRemote && remoteEnabled(autoRemote) && remoteAuto(autoRemote));
        let enabledManualRows = remoteRows.filter((c: any) => remoteEnabled(c) && remoteManual(c));
        let manualActive = new Set(enabledManualRows.map((c: any) => String(c.campaignId))).size;
        const created: any[] = [];
        if (manualActive < floor) {
          const searchTerms = await base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id: aid, advertised_asin: asin }, '-date', 1000).catch(() => []);
          const empirical = searchTerms
            .filter((t: any) => num(t.same_sku_orders) > 0 || (t.same_sku_attribution_verified === true && num(t.total_orders) > 0))
            .sort((a: any, b: any) => num(b.same_sku_orders) - num(a.same_sku_orders) || num(b.total_sales) - num(a.total_sales))
            .map((t: any) => norm(t.search_term));
          const used = new Set(candidates.map((c: any) => {
            const name = String(c.name || c.campaign_name || '');
            return norm(name.split('|').pop());
          }));
          const terms = [...new Set([...empirical, ...titleSeeds(product)])].filter((term) => term && !used.has(term))
            .slice(0, floor - manualActive);
          const creationResults = await Promise.all(terms.map(async (keyword) => {
            const response = await base44.asServiceRole.functions.invoke('createManualCampaignV2', {
              _service_role: true, amazon_account_id: aid, asin, sku, keyword,
              inventory_verified: true, verified_stock: availableAdsStock(product),
              bid: Math.max(0.25, Number(product.minimum_ads_bid || 0.25)), budget: 5,
            }).catch((error: any) => ({ data: { ok: false, error: error?.message } }));
            const data = response?.data || response || {};
            return { keyword, ok: data.ok === true, campaign_id: data.campaign_id || null, error: data.error || null };
          }));
          created.push(...creationResults);
          remoteRows = await remoteCampaigns(base44, aid, [auto.campaign_id, ...candidates.map(idOf), ...creationResults.map((r: any) => r.campaign_id)].filter(Boolean));
          enabledManualRows = remoteRows.filter((c: any) => remoteEnabled(c) && remoteManual(c));
          manualActive = new Set(enabledManualRows.map((c: any) => String(c.campaignId))).size;
        }
        for (const campaign of candidates) {
          const confirmed = enabledManualRows.some((row: any) => String(row.campaignId) === idOf(campaign));
          await base44.asServiceRole.entities.Campaign.update(campaign.id, {
            state: confirmed ? 'enabled' : 'paused', status: confirmed ? 'enabled' : 'paused',
            amazon_status: confirmed ? 'ENABLED' : 'PAUSED', is_operational: confirmed,
            requires_attention: !confirmed, synced_at: new Date().toISOString(),
          }).catch(() => {});
        }
        results.push({ sku, asin, auto_active: autoActive, auto_campaign_id: auto.campaign_id || null,
          manual_floor: floor, manual_active: manualActive, manual_existing: candidates.length,
          manual_reactivated: reactivated.length, reactivated_campaign_ids: reactivated,
          manual_created: created.filter((r: any) => r.ok).length, created,
          deficit: Math.max(0, floor - manualActive), errors,
          remote_verified: true, auto_remote_state: autoRemote?.state || 'NOT_FOUND',
          auto_error: auto.error || (!autoActive ? 'AUTO nao confirmada ENABLED na Amazon' : null) });
      }
    }

    // Erros ao tentar reaproveitar campanhas antigas ficam como auditoria, mas
    // nao invalidam o piso quando a consulta remota confirmou substitutas
    // ENABLED suficientes para o SKU.
    const deficits = results.filter((r: any) => !r.auto_active || r.deficit > 0);
    const warnings = results.flatMap((r: any) => r.errors.map((error: any) => ({ sku: r.sku, asin: r.asin, ...error })));
    return Response.json({ ok: deficits.length === 0, manual_floor: floor, products: results.length,
      compliant: results.length - deficits.length, deficits_count: deficits.length, deficits,
      warnings_count: warnings.length, warnings, results,
      started_at: startedAt, completed_at: new Date().toISOString() }, { status: deficits.length ? 207 : 200 });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error), started_at: startedAt }, { status: 500 });
  }
});
