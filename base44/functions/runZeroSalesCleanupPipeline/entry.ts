import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { normalize } from '../../shared/textUtils.ts';

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const {
      amazon_account_id,
      phase = 'preview', // 'preview' | 'execute'
      campaign_ids_to_archive = [],
      spend_threshold = 5,
      days_window = 7,
      min_age_days = 14,
      batch_limit = 50,
    } = body;

    if (!amazon_account_id) return Response.json({ error: 'amazon_account_id required' }, { status: 400 });

    const base44sr = base44.asServiceRole;
    const now = new Date();

    // ── Buscar config de performance (target_acos) ──────────────────────────
    const perfSettings = await base44sr.entities.PerformanceSettings.filter(
      { amazon_account_id }
    ).catch(() => []);
    const targetAcos = perfSettings[0]?.target_acos || 30;

    if (phase === 'preview') {
      // ── FASE 1: DRY-RUN — identificar candidatos ──────────────────────────

      // Calcular janela de 7 dias
      const since = new Date(now.getTime() - days_window * 86400000).toISOString().slice(0, 10);
      const since14 = new Date(now.getTime() - 14 * 86400000).toISOString().slice(0, 10);

      // Buscar métricas dos últimos 7 dias
      const metrics7d = await base44sr.entities.CampaignMetricsDaily.filter(
        { amazon_account_id },
        '-date',
        2000
      ).catch(() => []);

      // Agrupar por campaign_id
      const metricsByCampaign = {};
      for (const m of metrics7d) {
        if (!m.campaign_id) continue;
        if (!metricsByCampaign[m.campaign_id]) {
          metricsByCampaign[m.campaign_id] = { spend: 0, orders: 0, clicks: 0, days: new Set() };
        }
        if (m.date >= since) {
          metricsByCampaign[m.campaign_id].spend += m.spend || 0;
          metricsByCampaign[m.campaign_id].orders += m.orders || 0;
          metricsByCampaign[m.campaign_id].clicks += m.clicks || 0;
          metricsByCampaign[m.campaign_id].days.add(m.date);
        }
      }

      // Métricas 14d para winner protection
      const orders14d = {};
      for (const m of metrics7d) {
        if (!m.campaign_id) continue;
        if (m.date >= since14) {
          orders14d[m.campaign_id] = (orders14d[m.campaign_id] || 0) + (m.orders || 0);
        }
      }

      // Buscar campanhas ativas/pausadas (não arquivadas)
      const campaigns = await base44sr.entities.Campaign.filter(
        { amazon_account_id },
        null,
        500
      ).catch(() => []);

      const activeCampaigns = campaigns.filter(c => {
        const state = (c.state || c.status || '').toLowerCase();
        return state !== 'archived' && state !== 'incomplete';
      });

      // Buscar produtos para checar estoque
      const products = await base44sr.entities.Product.filter(
        { amazon_account_id },
        null,
        500
      ).catch(() => []);
      const productsByAsin = {};
      for (const p of products) { productsByAsin[p.asin] = p; }

      const candidates = [];
      const protected_campaigns = [];

      for (const c of activeCampaigns) {
        const campId = c.campaign_id || c.amazon_campaign_id;
        if (!campId) continue;

        const metrics = metricsByCampaign[campId];
        if (!metrics) continue;

        const spend7d = metrics.spend;
        const orders7d = metrics.orders;
        const clicks7d = metrics.clicks;
        const activeDays = metrics.days.size;
        const orders14 = orders14d[campId] || 0;

        // Filtro: spend ≥ threshold e zero pedidos nos 7d
        if (spend7d < spend_threshold || orders7d > 0) continue;

        // Winner protection: pedidos nos 14d
        if (orders14 > 0) {
          protected_campaigns.push({
            campaign_id: campId,
            name: c.name || c.campaign_name,
            asin: c.asin,
            reason: `Winner protection: ${orders14} pedidos nos últimos 14 dias`,
          });
          continue;
        }

        // Checar idade da campanha
        const createdAt = c.created_at || c.start_date || c.created_date;
        let ageDays = 999;
        if (createdAt) {
          ageDays = Math.floor((now.getTime() - new Date(createdAt).getTime()) / 86400000);
        }

        const suggested_action = ageDays < min_age_days ? 'pause' : 'archive';
        const product = productsByAsin[c.asin];

        candidates.push({
          id: c.id,
          campaign_id: campId,
          name: c.name || c.campaign_name,
          asin: c.asin,
          targeting_type: (c.targeting_type || '').toUpperCase(),
          state: c.state || c.status,
          spend_7d: spend7d,
          clicks_7d: clicks7d,
          orders_7d: orders7d,
          active_days: activeDays,
          age_days: ageDays,
          suggested_action,
          product_name: product?.product_name || product?.display_name,
          has_stock: product ? (product.fba_inventory || 0) > 0 : null,
          inventory_status: product?.inventory_status,
        });
      }

      // Ordenar por gasto desc
      candidates.sort((a, b) => b.spend_7d - a.spend_7d);

      // Registrar log de preview
      await base44sr.entities.SyncExecutionLog.create({
        amazon_account_id,
        operation: 'zero_sales_cleanup',
        trigger_type: 'manual',
        status: 'completed',
        started_at: now.toISOString(),
        completed_at: new Date().toISOString(),
        result_summary: `Preview: ${candidates.length} candidatos identificados (${candidates.filter(c => c.suggested_action === 'archive').length} arquivar, ${candidates.filter(c => c.suggested_action === 'pause').length} pausar). ${protected_campaigns.length} protegidas.`,
      }).catch(() => {});

      return Response.json({
        ok: true,
        phase: 'preview',
        candidates: candidates.slice(0, 100),
        protected: protected_campaigns,
        total_candidates: candidates.length,
        threshold_used: { spend: spend_threshold, days: days_window },
        target_acos: targetAcos,
      });
    }

    if (phase === 'execute') {
      // ── FASE 2+3: ARQUIVO + NEGATIVAÇÃO + PROMOÇÃO ─────────────────────────

      if (!campaign_ids_to_archive.length) {
        return Response.json({ ok: false, error: 'campaign_ids_to_archive vazio' }, { status: 400 });
      }

      const idsToProcess = campaign_ids_to_archive.slice(0, batch_limit);

      // Buscar campanhas
      const allCampaigns = await base44sr.entities.Campaign.filter(
        { amazon_account_id },
        null,
        500
      ).catch(() => []);

      const campaignMap = {};
      for (const c of allCampaigns) {
        if (c.campaign_id) campaignMap[c.campaign_id] = c;
        if (c.amazon_campaign_id) campaignMap[c.amazon_campaign_id] = c;
        if (c.id) campaignMap[c.id] = c;
      }

      let archived = 0;
      let paused = 0;
      let keywords_marked = 0;
      let failed = 0;
      const archiveErrors = [];

      // Obter token Amazon para chamadas de API
      const tokenRes = await base44sr.functions.invoke('amazonAdsTokenManager', {
        amazon_account_id,
        action: 'get_valid_token',
      }).catch(() => null);

      const accessToken = tokenRes?.data?.access_token;
      const account = await base44sr.entities.AmazonAccount.filter(
        { id: amazon_account_id },
        null,
        1
      ).catch(() => []);
      const acc = account[0];
      const profileId = acc?.ads_profile_id;
      const region = acc?.region || 'FE';

      const API_HOSTS = {
        NA: 'https://advertising-api.amazon.com',
        EU: 'https://advertising-api-eu.amazon.com',
        FE: 'https://advertising-api-fe.amazon.com',
      };
      const apiHost = API_HOSTS[region] || API_HOSTS.FE;

      for (const campId of idsToProcess) {
        const campaign = campaignMap[campId];
        if (!campaign) { failed++; continue; }

        const amazonId = campaign.campaign_id || campaign.amazon_campaign_id;
        const isArchive = (campaign._suggested_action || 'archive') === 'archive';
        const newState = isArchive ? 'archived' : 'paused';
        const localState = isArchive ? 'archived' : 'paused';

        try {
          // Tentar chamar a API Amazon se tivermos o token
          if (accessToken && profileId && amazonId) {
            const apiPayload = [{ campaignId: amazonId, state: newState.toUpperCase() }];
            await fetch(`${apiHost}/sp/campaigns`, {
              method: 'PUT',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Amazon-Advertising-API-ClientId': acc?.ads_client_id || '',
                'Amazon-Advertising-API-Scope': profileId,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(apiPayload),
            }).catch(() => null);
          }

          // Atualizar localmente
          await base44sr.entities.Campaign.update(campaign.id, {
            state: localState,
            status: localState,
            archived: isArchive,
            archived_at: isArchive ? now.toISOString() : undefined,
            archive_reason: isArchive ? 'zero_sales_7d_cleanup' : undefined,
            last_activity_at: now.toISOString(),
          });

          // Se MANUAL EXACT: marcar keywords como archived_from_zero_sales
          if ((campaign.targeting_type || '').toUpperCase() === 'MANUAL') {
            const kws = await base44sr.entities.Keyword.filter(
              { campaign_id: amazonId || campaign.id },
              null,
              200
            ).catch(() => []);

            const activeKws = kws.filter(k => {
              const s = (k.state || k.status || '').toLowerCase();
              return s !== 'archived';
            });

            for (const kw of activeKws) {
              await base44sr.entities.Keyword.update(kw.id, {
                state: 'archived',
                status: 'archived',
                archive_reason: 'archived_from_zero_sales',
                archived_from_campaign_id: amazonId || campaign.id,
                archived_at: now.toISOString(),
              }).catch(() => {});
              keywords_marked++;
            }
          }

          // Registrar SearchTermPromotion para rastreamento do ciclo de vida
          await base44sr.entities.SearchTermPromotion.create({
            amazon_account_id,
            asin: campaign.asin,
            campaign_id: amazonId || campaign.id,
            keyword: `__campaign_cleanup__${campaign.name || campaign.campaign_name}`,
            normalized_keyword: `__cleanup__${campaign.asin}`,
            status: 'monitoring',
            promotion_type: 'zero_sales_archive',
            archived_reason: 'spend_without_conversion',
            archived_at: now.toISOString(),
            created_at: now.toISOString(),
          }).catch(() => {});

          if (isArchive) archived++;
          else paused++;
        } catch (e) {
          failed++;
          archiveErrors.push({ campaign_id: campId, error: e.message });
        }
      }

      // ── FASE 3: Promoção de termos lucrativos ──────────────────────────────
      const since7 = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);

      // Atualizar a fonte canônica antes de promover: termos de busca que
      // converteram nas campanhas AUTO -> TermBank -> KeywordBank/Factory.
      const termRefreshResponse = await base44sr.functions.invoke(
        'updateTermBankFromAutomaticCampaigns',
        { amazon_account_id, _service_role: true },
      ).catch((e) => ({ data: { ok: false, error: e.message } }));
      const factoryRefreshResponse = await base44sr.functions.invoke(
        'runCampaignFactory',
        { amazon_account_id, _service_role: true },
      ).catch((e) => ({ data: { ok: false, error: e.message } }));
      const termRefresh = termRefreshResponse?.data || termRefreshResponse || {};
      const factoryRefresh = factoryRefreshResponse?.data || factoryRefreshResponse || {};

      const factoryBank = await base44sr.entities.KeywordBank.filter(
        { amazon_account_id },
        '-promotion_score',
        5000,
      ).catch(() => []);
      const winnerKws = factoryBank.filter((entry) => {
        const source = String(entry.source_type || '').toUpperCase();
        const lifecycle = String(entry.lifecycle_status || '').toUpperCase();
        return ['AUTO_SEARCH_TERM', 'BROAD_SEARCH_TERM', 'PHRASE_SEARCH_TERM'].includes(source)
          && ['PROVEN', 'WINNER'].includes(lifecycle)
          && entry.harvest_candidate === true
          && Number(entry.orders || 0) >= 1
          && Number(entry.acos || 0) > 0
          && Number(entry.acos || 0) <= Number(entry.target_acos || targetAcos)
          && Number(entry.intent_score || 0) >= 72;
      });

      let terms_promoted = 0;
      const promotedTerms = [];

      // Buscar campanhas MANUAL EXACT existentes para evitar duplicatas
      const manualExactCampaigns = allCampaigns.filter(c => {
        const state = (c.state || c.status || '').toLowerCase();
        return state !== 'archived' &&
          (c.targeting_type || '').toUpperCase() === 'MANUAL' &&
          /^SP\s*\|\s*MANUAL\s*\|\s*EXACT\s*\|/i.test(c.name || c.campaign_name || '');
      });

      const existingExactTerms = new Set();
      for (const c of manualExactCampaigns) {
        const kws = await base44sr.entities.Keyword.filter(
          { campaign_id: c.campaign_id || c.amazon_campaign_id },
          null,
          100
        ).catch(() => []);
        for (const k of kws) {
          if (k.keyword_text) existingExactTerms.add(`${c.asin}::${normalize(k.keyword_text)}`);
        }
      }

      for (const kw of winnerKws.slice(0, 20)) {
        const keywordText = kw.keyword || kw.normalized_keyword;
        if (!keywordText || !kw.asin) continue;
        const key = `${kw.asin}::${normalize(keywordText)}`;
        if (existingExactTerms.has(key)) continue;

        // Verificar se já tem kickoff pendente para este termo
        const existingKickoff = await base44sr.entities.ProductKickoffQueue.filter(
          { amazon_account_id, asin: kw.asin, keyword: keywordText, status: 'scheduled' },
          null,
          1
        ).catch(() => []);
        if (existingKickoff.length > 0) continue;

        // Criar entrada na fila de kickoff
        await base44sr.entities.ProductKickoffQueue.create({
          amazon_account_id,
          asin: kw.asin,
          keyword: keywordText,
          mode: 'manual_only',
          source: 'cleanup_auto_search_term_harvest',
          source_keyword_bank_id: kw.id,
          source_score: Number(kw.promotion_score || kw.intent_score || 0),
          status: 'scheduled',
          queue_hour: now.getHours(),
          queue_window: 'cleanup_promotion',
          scheduled_at: new Date(now.getTime() + 5 * 60000).toISOString(), // 5 min delay
          attempt_count: 0,
          max_attempts: 5,
        }).catch(() => {});

        promotedTerms.push({
          asin: kw.asin,
          keyword: keywordText,
          orders: kw.orders || 0,
          acos: kw.acos || 0,
        });
        terms_promoted++;
        existingExactTerms.add(key);

        if (terms_promoted >= 10) break;
      }

      // ── FASE 4: Descoberta de novos termos para ASINs arquivados ───────────
      const archivedAsins = [...new Set(
        idsToProcess
          .map(id => campaignMap[id]?.asin)
          .filter(Boolean)
      )];

      let discovery_queued = 0;
      for (const asin of archivedAsins.slice(0, 10)) {
        const product = await base44sr.entities.Product.filter(
          { amazon_account_id, asin },
          null,
          1
        ).catch(() => []);

        const hasStock = (product[0]?.fba_inventory || 0) > 0;
        if (!hasStock) continue;

        // Disparar sincronização de sugestões Amazon em background (fire & forget)
        base44sr.functions.invoke('syncAmazonKeywordSuggestionsByAsin', {
          amazon_account_id,
          asin,
          trigger: 'zero_sales_cleanup_discovery',
        }).catch(() => {});
        discovery_queued++;
      }

      // Registrar log de execução
      await base44sr.entities.SyncExecutionLog.create({
        amazon_account_id,
        operation: 'zero_sales_cleanup',
        trigger_type: 'manual',
        status: 'completed',
        started_at: now.toISOString(),
        completed_at: new Date().toISOString(),
        records_processed: idsToProcess.length,
        result_summary: `Executado: ${archived} arquivadas, ${paused} pausadas, ${keywords_marked} keywords marcadas, ${terms_promoted} termos promovidos, ${discovery_queued} ASINs em descoberta. Erros: ${failed}.`,
      }).catch(() => {});

      return Response.json({
        ok: true,
        phase: 'execute',
        archived,
        paused,
        keywords_marked,
        terms_promoted,
        promoted_terms: promotedTerms,
        learning_refresh: {
          term_bank: termRefresh,
          campaign_factory: factoryRefresh,
        },
        discovery_queued,
        failed,
        errors: archiveErrors.slice(0, 10),
      });
    }

    return Response.json({ error: `Phase '${phase}' inválida. Use 'preview' ou 'execute'.` }, { status: 400 });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
