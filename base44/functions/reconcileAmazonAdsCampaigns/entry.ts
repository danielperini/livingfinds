import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { chooseDuplicateWinner, classifyRemoteCampaign, normState, proposedAction } from '../../shared/campaignReconciliationPolicy.ts';

const CT: Record<string, string> = {
  campaigns: 'application/vnd.spCampaign.v3+json', adGroups: 'application/vnd.spAdGroup.v3+json',
  productAds: 'application/vnd.spProductAd.v3+json', keywords: 'application/vnd.spKeyword.v3+json',
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const id = (value: any) => String(value || '').trim();
const asinFrom = (value: any) => String(value?.asin || value?.name || value?.campaign_name || '').match(/\bB0[A-Z0-9]{8}\b/i)?.[0]?.toUpperCase() || '';
const stock = (product: any) => Number(product?.available_quantity ?? product?.fulfillable_quantity ?? product?.stock ?? product?.quantity ?? 0);
const baseUrl = (region: string) => String(region || 'NA').toUpperCase().includes('EU')
  ? 'https://advertising-api-eu.amazon.com' : String(region || '').toUpperCase().includes('FE')
  ? 'https://advertising-api-fe.amazon.com' : 'https://advertising-api.amazon.com';

async function token(base44: any, accountId: string) {
  const response = await base44.asServiceRole.functions.invoke('amazonAdsTokenManager', { _service_role: true, amazon_account_id: accountId });
  const data = response?.data || response;
  if (!data?.ok || !data?.access_token) throw Object.assign(new Error(data?.error || 'Amazon Ads token indisponível'), { retryable: data?.retryable });
  return data.access_token;
}

async function request(accessToken: string, profileId: string, region: string, method: string, path: string, body?: any, contentType = 'application/json', attempts = 3): Promise<any> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await fetch(`${baseUrl(region)}${path}`, { method, headers: {
      Authorization: `Bearer ${accessToken}`, 'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': profileId, 'Content-Type': contentType, Accept: contentType,
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let data: any = {}; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (response.ok) return { ok: true, status: response.status, data, requestId: response.headers.get('Amazon-Advertising-API-RequestId') };
    if (response.status === 429 && attempt < attempts) {
      const retryAfter = Math.min(60, Math.max(1, Number(response.headers.get('Retry-After') || 2)));
      await sleep(retryAfter * 1000); continue;
    }
    return { ok: false, status: response.status, data, retryable: [429, 504, 524].includes(response.status),
      retryAfter: Number(response.headers.get('Retry-After') || ([504, 524].includes(response.status) ? 300 : 0)),
      requestId: response.headers.get('Amazon-Advertising-API-RequestId') };
  }
}

async function profiles(accessToken: string, region: string) {
  const response = await fetch(`${baseUrl(region)}/v2/profiles`, { headers: {
    Authorization: `Bearer ${accessToken}`, 'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
  } });
  if (!response.ok) throw Object.assign(new Error(`profiles HTTP ${response.status}`), { retryable: [429, 504, 524].includes(response.status) });
  const data = await response.json().catch(() => []);
  return Array.isArray(data) ? data : [];
}

async function pages(accessToken: string, profileId: string, region: string, resource: keyof typeof CT, filter: any = {}) {
  const rows: any[] = []; const seen = new Set<string>(); let nextToken: string | undefined;
  do {
    const body = { ...filter, maxResults: 500, ...(nextToken ? { nextToken } : {}) };
    const result = await request(accessToken, profileId, region, 'POST', `/sp/${resource}/list`, body, CT[resource]);
    if (!result.ok) throw Object.assign(new Error(`${resource} HTTP ${result.status}`), result);
    rows.push(...(Array.isArray(result.data?.[resource]) ? result.data[resource] : []));
    nextToken = result.data?.nextToken;
    if (nextToken && seen.has(nextToken)) throw new Error(`Paginação repetida em ${resource}`);
    if (nextToken) seen.add(nextToken);
  } while (nextToken);
  return rows;
}

function indexByCampaign(rows: any[]) {
  const map = new Map<string, any[]>();
  for (const row of rows) { const key = id(row.campaignId); const list = map.get(key) || []; list.push(row); map.set(key, list); }
  return map;
}

async function remoteSnapshot(accessToken: string, profileId: string, region: string) {
  const campaigns = await pages(accessToken, profileId, region, 'campaigns', { stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] } });
  const [adGroups, productAds, keywords] = await Promise.all([
    pages(accessToken, profileId, region, 'adGroups'), pages(accessToken, profileId, region, 'productAds'), pages(accessToken, profileId, region, 'keywords'),
  ]);
  return { campaigns, adGroups: indexByCampaign(adGroups), productAds: indexByCampaign(productAds), keywords: indexByCampaign(keywords) };
}

async function allLocal(entity: any, filter: any, limit = 500) {
  const rows: any[] = []; let skip = 0;
  for (let page = 0; page < 200; page++) { const batch = await entity.filter(filter, '-updated_date', limit, skip); rows.push(...batch); if (batch.length < limit) break; skip += limit; }
  return rows;
}

function duplicateKey(remote: any, productAsin: string) {
  return `${String(remote.targetingType || '').toUpperCase()}|${productAsin}|${String(remote.name || '').replace(/\d{4}-\d{2}-\d{2}.*/, '').trim().toLowerCase()}`;
}

function createdId(result: any, resource: string, field: string) {
  return id(result?.data?.[resource]?.success?.[0]?.[field] || result?.data?.[resource]?.[0]?.[field] || result?.data?.success?.[0]?.[field]);
}

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req); const body = await req.json().catch(() => ({}));
  const mode = ['dry_run', 'sync', 'execute_safe'].includes(body.mode) ? body.mode : 'dry_run';
  const runId = crypto.randomUUID(); const startedAt = new Date().toISOString(); const errors: any[] = [];
  try {
    const [accounts, products, locals] = await Promise.all([
      body.amazon_account_id ? base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, undefined, 10)
        : base44.asServiceRole.entities.AmazonAccount.list('-updated_date', 100),
      allLocal(base44.asServiceRole.entities.Product, {}), allLocal(base44.asServiceRole.entities.Campaign, {}),
    ]);
    const productByAsin = new Map(products.filter((p: any) => p.asin).map((p: any) => [id(p.asin).toUpperCase(), p]));
    const productBySku = new Map(products.filter((p: any) => p.sku).map((p: any) => [id(p.sku).toUpperCase(), p]));
    const localByRemote = new Map(locals.filter((c: any) => c.campaign_id || c.amazon_campaign_id).map((c: any) => [id(c.campaign_id || c.amazon_campaign_id), c]));
    const remoteRows: any[] = [];
    const visitedProfiles = new Set<string>();
    for (const account of accounts.filter((a: any) => a.ads_profile_id)) {
      try {
        const accessToken = await token(base44, account.id);
        const accessible = await profiles(accessToken, account.region || 'NA').catch(() => []);
        const profileIds = [...new Set([id(account.ads_profile_id), ...accessible.map((p: any) => id(p.profileId))].filter(Boolean))];
        for (const profileId of profileIds) {
          if (visitedProfiles.has(profileId)) continue;
          visitedProfiles.add(profileId);
          try {
            const snapshot = await remoteSnapshot(accessToken, profileId, account.region || 'NA');
            for (const remote of snapshot.campaigns) remoteRows.push({ account, accessToken, profileId, remote,
              adGroups: snapshot.adGroups.get(id(remote.campaignId)) || [], productAds: snapshot.productAds.get(id(remote.campaignId)) || [],
              keywords: snapshot.keywords.get(id(remote.campaignId)) || [] });
          } catch (error: any) {
            errors.push({ amazon_account_id: account.id, profile_id: profileId, error: error.message, retryable: error.retryable === true });
          }
        }
      } catch (error: any) { errors.push({ amazon_account_id: account.id, profile_id: account.ads_profile_id, error: error.message, retryable: error.retryable === true }); }
    }
    if (remoteRows.length === 0 && errors.length) throw Object.assign(new Error('Nenhum perfil Amazon foi sincronizado integralmente; dados locais preservados'), { errors });

    const groups = new Map<string, any[]>();
    for (const row of remoteRows) { const asin = asinFrom(row.remote) || asinFrom(localByRemote.get(id(row.remote.campaignId))); const key = duplicateKey(row.remote, asin); const list = groups.get(key) || []; list.push(row); groups.set(key, list); }
    const duplicateLosers = new Set<string>();
    for (const group of groups.values()) if (group.length > 1) {
      const winner = chooseDuplicateWinner(group.map((x) => ({ ...x.remote, ...localByRemote.get(id(x.remote.campaignId)) })));
      for (const row of group) if (id(row.remote.campaignId) !== id(winner.campaignId || winner.campaign_id)) duplicateLosers.add(id(row.remote.campaignId));
    }

    const details = remoteRows.map((row) => {
      const campaignId = id(row.remote.campaignId); const local = localByRemote.get(campaignId);
      const advertised = row.productAds.find((x: any) => x.asin || x.sku);
      const productFromAd = productByAsin.get(id(advertised?.asin).toUpperCase()) || productBySku.get(id(advertised?.sku).toUpperCase());
      const asin = id(productFromAd?.asin).toUpperCase() || asinFrom(row.remote) || asinFrom(local);
      const product = productFromAd || productByAsin.get(asin); const classification = classifyRemoteCampaign({ remote: row.remote, local, product,
        adGroups: row.adGroups, productAds: row.productAds, keywords: row.keywords, duplicate: duplicateLosers.has(campaignId) });
      return { campaign_id: campaignId, profile_id: row.profileId, amazon_account_id: row.account.id, name: row.remote.name,
        asin, remote_state: normState(row.remote.state), local_state: local ? normState(local.state ?? local.status ?? local.amazon_status) : null,
        targeting_type: row.remote.targetingType, classification, proposed_action: proposedAction(classification, local),
        ad_groups: row.adGroups.length, product_ads: row.productAds.length,
        active_exact_keywords: row.keywords.filter((x: any) => normState(x.state) === 'enabled' && String(x.matchType).toUpperCase() === 'EXACT').length,
        stock: product ? stock(product) : null, local_id: local?.id || null };
    });

    const confirmed: any[] = [];
    if (mode !== 'dry_run') {
      for (const detail of details) {
        const remoteRow = remoteRows.find((x) => id(x.remote.campaignId) === detail.campaign_id)!;
        const local = localByRemote.get(detail.campaign_id); const now = new Date().toISOString();
        if (mode === 'execute_safe' && detail.classification === 'INCOMPLETA_REPARAVEL' && detail.asin && Number(detail.stock) > 0) {
          const key = `reconcile:v1:${detail.profile_id}:${detail.campaign_id}:repair-structure`;
          const existing = await base44.asServiceRole.entities.AmazonActionQueue.filter({ idempotency_key: key }, undefined, 1).catch(() => []);
          const queueItem = existing[0] || await base44.asServiceRole.entities.AmazonActionQueue.create({ amazon_account_id: detail.amazon_account_id,
            campaign_id: detail.campaign_id, entity_type: 'campaign', entity_id: detail.campaign_id,
            operation: 'repair_campaign_structure', status: 'processing', idempotency_key: key,
            reason: 'INCOMPLETA_REPARAVEL', source: 'reconcileAmazonAdsCampaigns', started_at: now });

          let adGroup = remoteRow.adGroups.find((x: any) => normState(x.state) === 'enabled');
          if (!adGroup) {
            const response = await request(remoteRow.accessToken, detail.profile_id, remoteRow.account.region || 'NA', 'POST', '/sp/adGroups',
              { adGroups: [{ campaignId: detail.campaign_id, name: `AG | RECONCILED | ${detail.asin}`, state: 'ENABLED', defaultBid: 0.2 }] }, CT.adGroups);
            if (response.ok) adGroup = { adGroupId: createdId(response, 'adGroups', 'adGroupId'), state: 'ENABLED' };
            else if (response.status !== 409) errors.push({ campaign_id: detail.campaign_id, step: 'adGroup', status: response.status, retryable: response.retryable });
          }
          const adGroupId = id(adGroup?.adGroupId);
          if (adGroupId && !remoteRow.productAds.some((x: any) => normState(x.state) === 'enabled')) {
            const product = productByAsin.get(detail.asin);
            const response = await request(remoteRow.accessToken, detail.profile_id, remoteRow.account.region || 'NA', 'POST', '/sp/productAds',
              { productAds: [{ campaignId: detail.campaign_id, adGroupId, ...(product?.sku ? { sku: product.sku } : { asin: detail.asin }), state: 'ENABLED' }] }, CT.productAds);
            if (!response.ok && response.status !== 409) errors.push({ campaign_id: detail.campaign_id, step: 'productAd', status: response.status, retryable: response.retryable });
          }
          if (adGroupId && String(detail.targeting_type).toUpperCase() === 'MANUAL' && detail.active_exact_keywords === 0) {
            const keywordText = String(detail.name || '').split('|').slice(4).join('|').trim();
            if (keywordText) {
              const response = await request(remoteRow.accessToken, detail.profile_id, remoteRow.account.region || 'NA', 'POST', '/sp/keywords',
                { keywords: [{ campaignId: detail.campaign_id, adGroupId, keywordText, matchType: 'EXACT', state: 'ENABLED', bid: 0.2 }] }, CT.keywords);
              if (!response.ok && response.status !== 409) errors.push({ campaign_id: detail.campaign_id, step: 'keyword', status: response.status, retryable: response.retryable });
            }
          }
          // 409 e respostas assíncronas convergem aqui: reler recursos existentes.
          const verified = await remoteSnapshot(remoteRow.accessToken, detail.profile_id, remoteRow.account.region || 'NA').catch(() => null);
          if (verified) {
            const verifiedCampaign = verified.campaigns.find((x: any) => id(x.campaignId) === detail.campaign_id);
            const verifiedClass = classifyRemoteCampaign({ remote: verifiedCampaign || remoteRow.remote, local,
              product: productByAsin.get(detail.asin), adGroups: verified.adGroups.get(detail.campaign_id) || [],
              productAds: verified.productAds.get(detail.campaign_id) || [], keywords: verified.keywords.get(detail.campaign_id) || [] });
            if (['ATIVA_COMPLETA', 'PROTEGIDA_ALTA_PERFORMANCE'].includes(verifiedClass)) {
              detail.classification = verifiedClass;
              detail.proposed_action = 'NONE';
              confirmed.push({ campaign_id: detail.campaign_id, action: 'REPAIR_STRUCTURE', idempotency_key: key, confirmed_at: now });
              await base44.asServiceRole.entities.AmazonActionQueue.update(queueItem.id, { status: 'confirmed', completed_at: now, confirmation_checked_at: now });
            }
          }
        }
        if (mode === 'execute_safe' && ['SEM_ESTOQUE', 'DUPLICADA'].includes(detail.classification) && detail.remote_state === 'enabled') {
          const key = `reconcile:v1:${detail.profile_id}:${detail.campaign_id}:pause:${detail.classification}`;
          const existing = await base44.asServiceRole.entities.AmazonActionQueue.filter({ idempotency_key: key }, undefined, 1).catch(() => []);
          const queueItem = existing[0] || await base44.asServiceRole.entities.AmazonActionQueue.create({ amazon_account_id: detail.amazon_account_id,
            campaign_id: detail.campaign_id, entity_type: 'campaign', entity_id: detail.campaign_id,
            operation: 'pause_campaign', status: 'processing', idempotency_key: key,
            reason: detail.classification, source: 'reconcileAmazonAdsCampaigns', started_at: now });
          const changed = await request(remoteRow.accessToken, detail.profile_id, remoteRow.account.region || 'NA', 'PUT', '/sp/campaigns',
            { campaigns: [{ campaignId: detail.campaign_id, state: 'PAUSED' }] }, CT.campaigns);
          if (changed.ok) {
            const verification = await pages(remoteRow.accessToken, detail.profile_id, remoteRow.account.region || 'NA', 'campaigns', { campaignIdFilter: { include: [detail.campaign_id] } });
            if (verification.some((x: any) => id(x.campaignId) === detail.campaign_id && normState(x.state) === 'paused')) {
              confirmed.push({ campaign_id: detail.campaign_id, action: 'PAUSE', idempotency_key: key, confirmed_at: now });
              await base44.asServiceRole.entities.AmazonActionQueue.update(queueItem.id, { status: 'confirmed', completed_at: now, confirmation_checked_at: now });
            }
          } else if (changed.status === 409) {
            confirmed.push({ campaign_id: detail.campaign_id, action: 'RECONCILE_EXISTING_AFTER_409', idempotency_key: key, pending_confirmation: true });
          } else if (changed.retryable) errors.push({ campaign_id: detail.campaign_id, status: changed.status, retry_after: changed.retryAfter, retryable: true });
        }
        const finalState = confirmed.some((x) => x.campaign_id === detail.campaign_id && x.action === 'PAUSE') ? 'paused' : detail.remote_state;
        if (mode === 'sync' || mode === 'execute_safe') {
          const confirmedRecord = {
            state: finalState, status: detail.classification === 'INCOMPLETA_REPARAVEL' ? 'incomplete' : finalState,
            is_operational: finalState === 'enabled' && ['ATIVA_COMPLETA', 'PROTEGIDA_ALTA_PERFORMANCE'].includes(detail.classification),
            reconciliation_class: detail.classification, reconciliation_run_id: runId, remote_confirmed_at: now,
            remote_profile_id: detail.profile_id, last_api_sync_at: now, reconciliation_notes: detail.proposed_action,
          };
          if (local) {
            // Atualização de estado nunca sobrescreve métricas, decisões ou histórico.
            await base44.asServiceRole.entities.Campaign.update(local.id, confirmedRecord);
          } else {
            // Toda campanha real entra no app, inclusive pausada/incompleta; apenas
            // completas e ENABLED são operacionais.
            await base44.asServiceRole.entities.Campaign.create({
              amazon_account_id: detail.amazon_account_id, ads_profile_id: detail.profile_id,
              campaign_id: detail.campaign_id, amazon_campaign_id: detail.campaign_id,
              name: detail.name, campaign_name: detail.name, campaign_type: 'SP',
              targeting_type: String(detail.targeting_type || 'AUTO').toUpperCase() === 'MANUAL' ? 'MANUAL' : 'AUTO',
              ...(detail.asin ? { asin: detail.asin } : {}), source: 'api', amazon_status: finalState,
              daily_budget: Number(remoteRow.remote?.budget?.budget || remoteRow.remote?.dailyBudget || 0),
              synced_at: now, ...confirmedRecord,
            });
          }
        }
      }
    }

    const count = (name: string) => details.filter((x) => x.classification === name).length;
    const summary = { total_amazon: details.length, total_local: locals.length,
      active_amazon: details.filter((x) => x.remote_state === 'enabled').length,
      active_in_app: details.filter((x) => x.remote_state === 'enabled' && ['ATIVA_COMPLETA', 'PROTEGIDA_ALTA_PERFORMANCE'].includes(x.classification)).length,
      paused: count('PAUSADA'), incomplete: count('INCOMPLETA_REPARAVEL'), divergences: count('DIVERGENCIA_DE_ESTADO'),
      duplicates: count('DUPLICADA'), without_product: count('SEM_PRODUTO'), without_stock: count('SEM_ESTOQUE'),
      protected: count('PROTEGIDA_ALTA_PERFORMANCE'), actions_proposed: details.filter((x) => !['NONE', 'PROTECT'].includes(x.proposed_action)).length,
      actions_confirmed: confirmed.length, profiles_complete: new Set(details.map((x) => x.profile_id)).size, errors: errors.length };
    const run = await base44.asServiceRole.entities.CampaignReconciliationRun.create({ run_id: runId, mode,
      status: errors.length ? 'partial' : 'completed', started_at: startedAt, completed_at: new Date().toISOString(), summary,
      campaigns: details, actions_proposed: details.filter((x) => !['NONE', 'PROTECT'].includes(x.proposed_action)), actions_confirmed: confirmed, errors });
    return Response.json({ ok: true, run_id: runId, record_id: run.id, mode, summary, campaigns: details, actions_confirmed: confirmed, errors });
  } catch (error: any) {
    return Response.json({ ok: false, run_id: runId, mode, error: error.message, errors: error.errors || errors,
      safety: 'Dados locais anteriores não foram substituídos.' }, { status: 502 });
  }
});
