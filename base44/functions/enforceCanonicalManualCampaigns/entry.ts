/**
 * enforceCanonicalManualCampaigns — Regra canônica: 1 keyword EXACT por campanha manual
 *
 * Fluxo:
 * 1. Sync completo do estado Amazon (campanhas, ad groups, keywords, product ads)
 * 2. Identificar campanhas manuais com múltiplas keywords ativas
 * 3. Identificar termos duplicados por ASIN (mesma keyword em campanhas diferentes)
 * 4. Para cada violação: pausar campanha antiga → criar nova canônica → confirmar → arquivar antiga
 * 5. Processar até 20 campanhas por execução; fila contínua até pending=0
 *
 * Modo dry_run=true (padrão): só relatório, sem operações reais.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

const BATCH_SIZE = 20;
const THROTTLE_MS = 3000;
const DEFAULT_BID = 0.60;
const DEFAULT_BUDGET = 7.0;
const V3_CAMP_CT = 'application/vnd.spCampaign.v3+json';
const V3_AG_CT   = 'application/vnd.spAdGroup.v3+json';
const V3_KW_CT   = 'application/vnd.spKeyword.v3+json';
const V3_PA_CT   = 'application/vnd.spProductAd.v3+json';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function nowIso() { return new Date().toISOString(); }
function todayStr() { return new Date(Date.now() - 3*3600000).toISOString().slice(0,10); } // YYYY-MM-DD

function normalizeTerm(text: string): string {
  return (text || '')
    .toLowerCase().trim()
    .replace(/\s+/g, ' ')
    .replace(/[áàãâä]/g,'a').replace(/[éèêë]/g,'e')
    .replace(/[íìîï]/g,'i').replace(/[óòõôö]/g,'o')
    .replace(/[úùûü]/g,'u').replace(/[ç]/g,'c').replace(/[ñ]/g,'n');
}

async function adsCommand(base44: any, aid: string, method: string, path: string, payload: any, ct: string): Promise<any> {
  const res = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
    amazon_account_id: aid,
    method,
    path,
    payload,
    content_type: ct,
    accept: ct,
    max_attempts: 3,
    _service_role: true,
  });
  // Gateway retorna { ok, status, payload: <amazon_response>, ... }
  const d = res?.data || res || {};
  // Retornar o payload Amazon diretamente para facilitar parsing
  return d?.payload ?? d;
}



Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    // Auth
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const dry_run: boolean = body.dry_run !== false; // default true
    const batch_size: number = Math.min(body.batch_size || BATCH_SIZE, BATCH_SIZE);
    const now = nowIso();

    // ── Resolver conta ────────────────────────────────────────────────────
    let account: any = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
      account = accs[0];
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, null, 1);
      account = accs?.[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' });

    const aid = account.id;

    // ── 1. Sync estado real da Amazon via gateway centralizado ───────────
    // Buscar campanhas ENABLED e PAUSED em paralelo via amazonAdsCommand
    const [enabledRes, pausedRes] = await Promise.all([
      adsCommand(base44, aid, 'POST', '/sp/campaigns/list', {
        stateFilter: ['ENABLED'],
        campaignType: 'SPONSOREDPRODUCTS',
        count: 100,
        startIndex: 0,
      }, V3_CAMP_CT).catch(() => ({})),
      adsCommand(base44, aid, 'POST', '/sp/campaigns/list', {
        stateFilter: ['PAUSED'],
        campaignType: 'SPONSOREDPRODUCTS',
        count: 100,
        startIndex: 0,
      }, V3_CAMP_CT).catch(() => ({})),
    ]);

    const amazonEnabled = enabledRes?.campaigns || [];
    const amazonPaused  = pausedRes?.campaigns || [];
    const allAmazonCampaigns = [...amazonEnabled, ...amazonPaused];
    const amazonCampMap = new Map<string, any>();
    for (const c of allAmazonCampaigns) {
      amazonCampMap.set(String(c.campaignId), c);
    }

    // ── 3. Carregar campanhas manuais locais ──────────────────────────────
    const [localCampaigns, localKeywords, localAdGroups, localProductAds, localProducts] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 500),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, null, 3000),
      base44.asServiceRole.entities.AdGroup.filter({ amazon_account_id: aid }, null, 500),
      base44.asServiceRole.entities.ProductAd.filter({ amazon_account_id: aid }, null, 500).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 200),
    ]);

    const manualCampaigns = localCampaigns.filter(c =>
      (c.targeting_type || c.campaign_type || '').toUpperCase() === 'MANUAL'
    );

    // Sincronizar status local com Amazon (estado real)
    for (const c of manualCampaigns) {
      const cid = String(c.campaign_id || '');
      const amazonC = amazonCampMap.get(cid);
      if (amazonC) {
        const amazonState = (amazonC.state || '').toLowerCase();
        const localState  = (c.status || c.state || '').toLowerCase();
        if (amazonState !== localState) {
          await base44.asServiceRole.entities.Campaign.update(c.id, { status: amazonState, state: amazonState }).catch(() => {});
          c.status = amazonState;
          c.state  = amazonState;
        }
      }
    }

    // Produtos com estoque e listing elegível
    const eligibleAsins = new Set(
      localProducts
        .filter(p => p.inventory_status !== 'out_of_stock' && p.status !== 'inactive' && p.status !== 'archived')
        .map(p => p.asin)
    );

    // Índice de keywords por campaign_id (normalizadas)
    const kwByCamp = new Map<string, any[]>();
    for (const kw of localKeywords) {
      const cid = String(kw.campaign_id || '');
      if (!kwByCamp.has(cid)) kwByCamp.set(cid, []);
      kwByCamp.get(cid)!.push(kw);
    }

    // Ad groups por campaign_id
    const agByCamp = new Map<string, any>();
    for (const ag of localAdGroups) {
      const cid = String(ag.campaign_id || '');
      if (!agByCamp.has(cid)) agByCamp.set(cid, ag);
    }

    // ── 4. Mapear termos canônicos por ASIN ───────────────────────────────
    // chave: `${aid}|${asin}|${normalized_term}|exact`
    // valor: campanha que já representa este termo canonicamente
    const canonicalMap = new Map<string, any>(); // canônicas confirmadas
    const violationsMultiKw: any[] = []; // campanhas com múltiplas keywords
    const violationsDuplicate: any[] = []; // campanhas duplicando termo de outra

    // Primeiro: mapear todas as campanhas com 1 keyword EXACT habilitada
    for (const c of manualCampaigns) {
      if (!c.asin) continue;
      const cid = String(c.campaign_id || '');
      const kws = (kwByCamp.get(cid) || []).filter(k =>
        (k.match_type || '').toLowerCase() === 'exact' &&
        !['paused','archived','deleted'].includes((k.state || k.status || '').toLowerCase())
      );
      if (kws.length === 1) {
        const term = normalizeTerm(kws[0].keyword_text || kws[0].keyword || '');
        const key = `${aid}|${c.asin}|${term}|exact`;
        if (!canonicalMap.has(key)) {
          canonicalMap.set(key, { campaign: c, keyword: kws[0] });
        } else {
          violationsDuplicate.push({ campaign: c, keyword: kws[0], term, key });
        }
      } else if (kws.length > 1) {
        violationsMultiKw.push({ campaign: c, keywords: kws });
      }
    }

    // ── 5. Estatísticas para dry_run ──────────────────────────────────────
    const stats = {
      amazon_synced: allAmazonCampaigns.length,
      manual_total: manualCampaigns.length,
      manual_enabled: manualCampaigns.filter(c => ['enabled','active'].includes((c.status||c.state||'').toLowerCase())).length,
      manual_paused_amazon: amazonPaused.filter(c => (c.targetingType||'').toUpperCase()==='MANUAL').length,
      campaigns_multi_keyword: violationsMultiKw.length,
      campaigns_no_keyword: manualCampaigns.filter(c => (kwByCamp.get(String(c.campaign_id||''))||[]).length === 0).length,
      unique_terms_by_asin: canonicalMap.size,
      duplicate_term_pairs: violationsDuplicate.length,
      products_no_stock: manualCampaigns.filter(c => c.asin && !eligibleAsins.has(c.asin)).length,
      campaigns_to_recreate: violationsMultiKw.length + violationsDuplicate.length,
    };

    if (dry_run) {
      return Response.json({
        ok: true,
        dry_run: true,
        stats,
        violations_multi_kw_sample: violationsMultiKw.slice(0,5).map(v => ({
          campaign: v.campaign.campaign_name,
          asin: v.campaign.asin,
          kw_count: v.keywords.length,
          terms: v.keywords.map((k:any) => k.keyword_text),
        })),
        violations_duplicate_sample: violationsDuplicate.slice(0,5).map(v => ({
          campaign: v.campaign.campaign_name,
          asin: v.campaign.asin,
          term: v.term,
        })),
        canonical_map_size: canonicalMap.size,
        message: `Simulação concluída. ${stats.campaigns_to_recreate} campanhas precisam de correção.`,
        duration_ms: Date.now() - t0,
      });
    }

    // ── 6. EXECUÇÃO REAL ───────────────────────────────────────────────────
    const results = {
      paused: 0, archived: 0, created: 0, failed: 0, retries: 0,
      pending_confirmation: 0, duplicates_eliminated: 0,
    };
    const logs: string[] = [];

    // Coletar todas as violações para processar
    const toProcess: Array<{ type: 'multi_kw'|'duplicate'; campaign: any; keyword?: any; keywords?: any[]; term?: string }> = [
      ...violationsMultiKw.map(v => ({ type: 'multi_kw' as const, campaign: v.campaign, keywords: v.keywords })),
      ...violationsDuplicate.map(v => ({ type: 'duplicate' as const, campaign: v.campaign, keyword: v.keyword, term: v.term })),
    ];

    const batch = toProcess.slice(0, batch_size);
    const remaining = toProcess.length - batch.length;

    for (const item of batch) {
      const c = item.campaign;
      const cid = String(c.campaign_id || '');

      if (!c.asin || !eligibleAsins.has(c.asin)) {
        logs.push(`SKIP sem estoque: ${c.campaign_name}`);
        continue;
      }

      // ── Idempotency ────────────────────────────────────────────────────
      const iKey = `canonical_migration|${aid}|${cid}|${nowIso().slice(0,10)}`;

      // Determinar termos a migrar
      let termsToMigrate: string[] = [];
      if (item.type === 'multi_kw') {
        termsToMigrate = (item.keywords || []).map((k:any) => normalizeTerm(k.keyword_text || k.keyword || '')).filter(Boolean);
      } else {
        termsToMigrate = [item.term || ''].filter(Boolean);
      }

      for (const term of termsToMigrate) {
        if (!term) continue;
        const key = `${aid}|${c.asin}|${term}|exact`;

        // Já existe canônica? Só pausar/arquivar a duplicata
        if (canonicalMap.has(key) && item.type === 'duplicate') {
          // Pausar na Amazon
          try {
            await adsCommand(base44, aid, 'PUT', '/sp/campaigns', {
              campaigns: [{ campaignId: cid, state: 'PAUSED' }]
            }, V3_CAMP_CT);
            await sleep(THROTTLE_MS);
            await base44.asServiceRole.entities.Campaign.update(c.id, { status: 'paused', state: 'paused', updated_at: now });
            results.paused++;
            results.duplicates_eliminated++;
            logs.push(`PAUSADO duplicata: ${c.campaign_name} (termo "${term}" já existe canonicamente)`);
          } catch (e: any) {
            results.failed++;
            logs.push(`FALHA pausar duplicata: ${c.campaign_name} — ${e.message}`);
          }
          continue;
        }

        // Buscar bid sugerido (menor range da Amazon)
        let initialBid = DEFAULT_BID;
        const existingKw = canonicalMap.get(key);
        if (existingKw?.keyword?.amazon_suggested_bid_lower) {
          initialBid = Math.max(DEFAULT_BID, existingKw.keyword.amazon_suggested_bid_lower);
        }
        // Respeitar safe_max_cpc do produto
        const product = localProducts.find(p => p.asin === c.asin);
        const safeMaxCpc = product?.safe_max_cpc || product?.maximum_ad_spend_per_order || 5.0;
        initialBid = Math.min(initialBid, safeMaxCpc);

        const budget = c.daily_budget || c.budget || DEFAULT_BUDGET;
        const campaignName = `SP | MANUAL | EXACT | ${c.asin} | ${term}`;
        const today = todayStr();

        // ── Criar nova campanha na Amazon ──────────────────────────────
        let newCampaignId: string | null = null;
        try {
          const campPayload: any = {
            name: campaignName,
            targetingType: 'MANUAL',
            state: 'ENABLED',
            startDate: today,
            campaignType: 'sponsoredProducts',
            budget: { budgetType: 'DAILY', budget: Number(budget) },
          };
          if (c.portfolio_id) campPayload.portfolioId = c.portfolio_id;
          const campRes = await adsCommand(base44, aid, 'POST', '/sp/campaigns', {
            campaigns: [campPayload]
          }, V3_CAMP_CT);
          await sleep(THROTTLE_MS);

          // Amazon v3: { campaigns: { success: [{campaignId, ...}], error: [...] } }
          const created = campRes?.campaigns?.success?.[0] || campRes?.success?.[0] || (Array.isArray(campRes?.campaigns) ? campRes.campaigns[0] : null);
          if (created?.campaignId) {
            newCampaignId = String(created.campaignId);
          } else {
            // Verificar se é duplicateValueError — campanha já existe na Amazon
            const errMsg = JSON.stringify(campRes?.campaigns?.error || campRes);
            if (errMsg.includes('duplicateValueError') || errMsg.includes('duplicate')) {
              // Buscar a campanha existente pelo nome
              const existingRes = await adsCommand(base44, aid, 'POST', '/sp/campaigns/list', {
                name: campaignName,
              }, V3_CAMP_CT).catch(() => ({}));
              const existingCamp = existingRes?.campaigns?.find((c2: any) => c2.name === campaignName);
              if (existingCamp?.campaignId) {
                newCampaignId = String(existingCamp.campaignId);
                logs.push(`REUTILIZADO campanha existente: ${campaignName} (id: ${newCampaignId})`);
              } else {
                // Buscar localmente
                const localExisting = localCampaigns.find(lc => lc.campaign_name === campaignName || lc.name === campaignName);
                if (localExisting?.campaign_id) {
                  newCampaignId = String(localExisting.campaign_id);
                  logs.push(`REUTILIZADO campanha local: ${campaignName}`);
                } else {
                  results.pending_confirmation++;
                  logs.push(`PENDING_CONFIRMATION campanha duplicata não encontrada: ${campaignName}`);
                  continue;
                }
              }
            } else {
              const errDetail = errMsg.slice(0, 200);
              results.pending_confirmation++;
              logs.push(`PENDING_CONFIRMATION campanha: ${campaignName} — resp: ${errDetail}`);
              continue;
            }
          }
        } catch (e: any) {
          results.failed++;
          results.retries++;
          logs.push(`FALHA criar campanha: ${campaignName} — ${e.message}`);
          continue;
        }

        // ── Criar ad group ─────────────────────────────────────────────
        let newAdGroupId: string | null = null;
        try {
          const agRes = await adsCommand(base44, aid, 'POST', '/sp/adGroups', {
            adGroups: [{
              name: `AG | ${term}`,
              campaignId: newCampaignId,
              defaultBid: initialBid,
              state: 'ENABLED',
            }]
          }, V3_AG_CT);
          await sleep(THROTTLE_MS);

          const createdAg = agRes?.adGroups?.success?.[0] || agRes?.success?.[0] || (Array.isArray(agRes?.adGroups) ? agRes.adGroups[0] : null);
          if (createdAg?.adGroupId) {
            newAdGroupId = String(createdAg.adGroupId);
          } else {
            const errDetail = JSON.stringify(agRes).slice(0, 200);
            results.pending_confirmation++;
            logs.push(`PENDING_CONFIRMATION ad group para: ${campaignName} — resp: ${errDetail}`);
            continue;
          }
        } catch (e: any) {
          results.failed++;
          logs.push(`FALHA criar ad group: ${campaignName} — ${e.message}`);
          continue;
        }

        // ── Criar keyword EXACT ────────────────────────────────────────
        let newKeywordId: string | null = null;
        try {
          const kwRes = await adsCommand(base44, aid, 'POST', '/sp/keywords', {
            keywords: [{
              campaignId: newCampaignId,
              adGroupId: newAdGroupId,
              keywordText: term,
              matchType: 'EXACT',
              state: 'ENABLED',
              bid: initialBid,
            }]
          }, V3_KW_CT);
          await sleep(THROTTLE_MS);

          const createdKw = kwRes?.keywords?.success?.[0] || kwRes?.success?.[0] || (Array.isArray(kwRes?.keywords) ? kwRes.keywords[0] : null);
          if (createdKw?.keywordId) {
            newKeywordId = String(createdKw.keywordId);
          } else {
            const errDetail = JSON.stringify(kwRes).slice(0, 200);
            results.pending_confirmation++;
            logs.push(`PENDING_CONFIRMATION keyword para: ${campaignName} — resp: ${errDetail}`);
          }
        } catch (e: any) {
          results.failed++;
          logs.push(`FALHA criar keyword: ${campaignName} — ${e.message}`);
          continue;
        }

        // ── Criar Product Ad ───────────────────────────────────────────
        try {
          await adsCommand(base44, aid, 'POST', '/sp/productAds', {
            productAds: [{
              campaignId: newCampaignId,
              adGroupId: newAdGroupId,
              asin: c.asin,
              state: 'ENABLED',
            }]
          }, V3_PA_CT);
          await sleep(THROTTLE_MS);
        } catch (e: any) {
          logs.push(`AVISO Product Ad: ${campaignName} — ${e.message}`);
        }

        // ── Persistir localmente ──────────────────────────────────────
        if (newCampaignId && newAdGroupId) {
          await base44.asServiceRole.entities.Campaign.create({
            amazon_account_id: aid,
            campaign_id: newCampaignId,
            campaign_name: campaignName,
            name: campaignName,
            targeting_type: 'MANUAL',
            campaign_type: 'MANUAL',
            status: 'enabled',
            state: 'enabled',
            daily_budget: budget,
            budget,
            asin: c.asin,
            created_at: now,
            updated_at: now,
          }).catch(() => {});

          if (newKeywordId) {
            await base44.asServiceRole.entities.Keyword.create({
              amazon_account_id: aid,
              campaign_id: newCampaignId,
              ad_group_id: newAdGroupId,
              keyword_id: newKeywordId,
              keyword_text: term,
              keyword: term,
              match_type: 'exact',
              state: 'enabled',
              status: 'enabled',
              bid: initialBid,
              current_bid: initialBid,
              asin: c.asin,
              created_at: now,
              synced_at: now,
            }).catch(() => {});
          }

          results.created++;
          canonicalMap.set(key, { campaign: { campaign_id: newCampaignId, campaign_name: campaignName, asin: c.asin }, keyword: { keyword_text: term } });
          logs.push(`CRIADO: ${campaignName} (bid: R$${initialBid.toFixed(2)}, budget: R$${budget})`);
        }

        // ── Pausar campanha antiga (se violação confirmada resolvida) ─
        if (newCampaignId) {
          try {
            await adsCommand(base44, aid, 'PUT', '/sp/campaigns', {
              campaigns: [{ campaignId: cid, state: 'PAUSED' }]
            }, V3_CAMP_CT);
            await sleep(THROTTLE_MS);
            await base44.asServiceRole.entities.Campaign.update(c.id, { status: 'paused', state: 'paused', updated_at: now });
            results.paused++;
            logs.push(`PAUSADO antiga: ${c.campaign_name}`);

            // ── Arquivar se: pausada + nova ativa + mesmo ASIN + termos migrados
            await sleep(2000);
            // Confirmar via listagem filtrada por campaignId
            const confirmRes = await adsCommand(base44, aid, 'POST', '/sp/campaigns/list', {
              campaignIdFilter: { include: [newCampaignId] },
            }, V3_CAMP_CT).catch(() => null);
            const confirmedCamp = confirmRes?.campaigns?.[0] || null;
            const newState = (confirmedCamp?.state || '').toUpperCase();
            if (newState === 'ENABLED') {
              try {
                await adsCommand(base44, aid, 'PUT', '/sp/campaigns', {
                  campaigns: [{ campaignId: cid, state: 'ARCHIVED' }]
                }, V3_CAMP_CT);
                await base44.asServiceRole.entities.Campaign.update(c.id, { status: 'archived', state: 'archived', updated_at: now });
                results.archived++;
                logs.push(`ARQUIVADO: ${c.campaign_name}`);
              } catch (e: any) {
                logs.push(`AVISO arquivar: ${c.campaign_name} — ${e.message}`);
              }
            } else {
              results.pending_confirmation++;
              logs.push(`PENDING_CONFIRMATION nova campanha não confirmada: ${campaignName}`);
            }
          } catch (e: any) {
            results.failed++;
            logs.push(`FALHA pausar antiga: ${c.campaign_name} — ${e.message}`);
          }
        }
      }

      await sleep(500);
    }

    // ── Log de execução ────────────────────────────────────────────────────
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'enforce_canonical_manual_campaigns',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      status: results.failed > 0 ? 'warning' : 'success',
      execution_date: nowIso().slice(0,10),
      started_at: new Date(t0).toISOString(),
      completed_at: nowIso(),
      duration_ms: Date.now() - t0,
      records_processed: batch.length,
      result_summary: JSON.stringify({ ...results, remaining, logs_count: logs.length }).slice(0,500),
    }).catch(() => {});

    // ── Verificação final: ainda há campanhas inadequadas? ─────────────────
    const no_multi_kw_remaining = violationsMultiKw.length - batch.filter(b=>b.type==='multi_kw').length === 0 + remaining;
    const no_duplicates_remaining = violationsDuplicate.length - batch.filter(b=>b.type==='duplicate').length === 0 + remaining;

    return Response.json({
      ok: true,
      dry_run: false,
      batch_processed: batch.length,
      remaining_campaigns_pending: remaining,
      results,
      stats,
      logs,
      confirmations: {
        no_manual_campaigns_with_multi_keyword: violationsMultiKw.length === 0,
        no_duplicate_terms_per_asin: violationsDuplicate.length === 0,
        conclusion_safe: remaining === 0 && results.pending_confirmation === 0 && results.failed === 0,
      },
      duration_ms: Date.now() - t0,
    });

  } catch (error: any) {
    console.error('[enforceCanonicalManualCampaigns]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});