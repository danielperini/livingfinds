/**
 * runWeeklyWasteTermsCleanup
 *
 * Varredura semanal de "desperdício":
 *
 * PARTE 1 — Termos que só gastam (search terms)
 *   Critério: presente há >= 21 dias, spend > 0, orders = 0 (nenhuma conversão)
 *   Ação: criar negative keyword NEGATIVE_EXACT na campanha de origem
 *
 * PARTE 2 — Campanhas sem retorno (AUTO e MANUAL)
 *   Critério: ACoS > maximum_acos E spend > limiar mínimo E >= 21 dias de dados
 *   OU: spend > 0 por 21 dias, zero conversões (gasta sem converter)
 *   Ação: pausar campanha na Amazon e marcar no banco
 *
 * CAMPANHAS AUTO viáveis (ACoS dentro da meta) são preservadas mesmo sem conversões recentes.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function adsBase(region: string | undefined) {
  const v = String(region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (v.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (v.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function getToken(account: any) {
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: account.ads_refresh_token,
      client_id: Deno.env.get('ADS_CLIENT_ID') || '',
      client_secret: Deno.env.get('ADS_CLIENT_SECRET') || '',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.error_description || 'Falha no token');
  return data.access_token;
}

function norm(t: string) { return String(t || '').toLowerCase().trim().replace(/\s+/g, ' '); }

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user || user.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const accountId = body.amazon_account_id;
    if (!accountId) return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: accountId }, null, 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' }, { status: 404 });

    const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: accountId }, null, 1);
    const config = configs[0] || {};

    // Thresholds da config (ou defaults seguros)
    const maxAcos = config.maximum_acos || 45;           // % — acima disso é prejudicial
    const minSpendForDecision = config.min_spend_for_decision || 5; // R$ mínimo para decidir
    const WEEKS = 3;
    const CUTOFF_DAYS = WEEKS * 7; // 21 dias

    const cutoffDate = new Date(Date.now() - CUTOFF_DAYS * 86400000).toISOString().slice(0, 10);
    // Janela de atribuição segura: não tomar decisão sobre dados recentes
    const attributionCutoff = new Date(Date.now() - 72 * 3600000).toISOString().slice(0, 10);

    const token = await getToken(account);
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    const baseUrl = adsBase(account.region);

    const authHeaders = {
      Authorization: `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': String(profileId),
    };

    async function adsCall(method: string, path: string, payload: any, ct = 'application/vnd.spCampaign.v3+json') {
      const h = { ...authHeaders, 'Content-Type': ct, Accept: ct };
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: h,
        body: method !== 'GET' ? JSON.stringify(payload) : undefined,
      });
      const text = await res.text().catch(() => '');
      let parsed: any = {};
      try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
      return { ok: res.status >= 200 && res.status < 300, status: res.status, payload: parsed };
    }

    // ── Carregar dados ─────────────────────────────────────────────────────
    const [allSearchTerms, allCampaigns, existingNegKws] = await Promise.all([
      base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id: accountId }, '-date', 15000),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, null, 2000),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId, match_type: 'negative_exact' }, null, 5000).catch(() => []),
    ]);

    // Índice de negativos já existentes (evitar duplicatas)
    const alreadyNegated = new Set(
      existingNegKws.map((k: any) => `${k.campaign_id}|${norm(k.keyword_text || k.text || '')}`)
    );

    // ── PARTE 1: Termos que só gastam ─────────────────────────────────────
    // Agregar por (campaign_id, ad_group_id, normalized_term)
    // Considerar apenas registros com date <= attributionCutoff (dados consolidados)
    const termAgg = new Map<string, any>();
    for (const t of allSearchTerms) {
      if (!t.search_term || !t.campaign_id || !t.ad_group_id) continue;
      if (t.date > attributionCutoff) continue; // dados dentro da janela de atribuição — ignorar

      const n = norm(t.search_term);
      const k = `${t.campaign_id}|${t.ad_group_id}|${n}`;

      if (!termAgg.has(k)) {
        termAgg.set(k, {
          campaign_id: t.campaign_id,
          ad_group_id: t.ad_group_id,
          normalized_term: n,
          asin: t.advertised_asin || '',
          first_seen: t.date || attributionCutoff,
          last_seen: t.date || attributionCutoff,
          spend: 0, orders: 0, clicks: 0, sales: 0,
        });
      }
      const agg = termAgg.get(k)!;
      if (t.date < agg.first_seen) agg.first_seen = t.date;
      if (t.date > agg.last_seen) agg.last_seen = t.date;
      agg.spend += t.spend || 0;
      agg.clicks += t.clicks || 0;
      // Melhor janela disponível
      agg.orders += t.orders_14d || t.orders_30d || t.orders_7d || 0;
      agg.sales += t.sales_14d || t.sales_30d || t.sales_7d || 0;
    }

    // Filtrar: >= 21 dias de presença, gasta, zero conversões
    const wasteTerms = Array.from(termAgg.values()).filter(t => {
      const daysSinceFirst = (new Date(attributionCutoff).getTime() - new Date(t.first_seen).getTime()) / 86400000;
      return daysSinceFirst >= CUTOFF_DAYS
        && t.spend >= minSpendForDecision
        && t.orders === 0;
    });

    const stats = {
      waste_terms_found: wasteTerms.length,
      negatives_created: 0,
      negatives_skipped: 0,
      campaigns_analyzed: 0,
      campaigns_paused: 0,
      campaigns_preserved: 0,
      campaigns_skipped: 0,
      amazon_calls: 0,
      errors: 0,
    };

    const negativeActions: any[] = [];
    const pauseActions: any[] = [];

    // Criar negative keywords em lote (máx 50 por chamada)
    const negBatch: any[] = [];
    for (const t of wasteTerms) {
      const negKey = `${t.campaign_id}|${t.normalized_term}`;
      if (alreadyNegated.has(negKey)) { stats.negatives_skipped++; continue; }

      negBatch.push({
        campaignId: t.campaign_id,
        adGroupId: t.ad_group_id,
        keywordText: t.normalized_term,
        matchType: 'NEGATIVE_EXACT',
        state: 'ENABLED',
      });
      alreadyNegated.add(negKey);
      negativeActions.push({ term: t.normalized_term, campaign_id: t.campaign_id, spend: t.spend, action: 'negatived' });
    }

    // Processar em lotes de 50
    for (let i = 0; i < negBatch.length; i += 50) {
      const batch = negBatch.slice(i, i + 50);
      const r = await adsCall('POST', '/sp/negativeKeywords',
        { negativeKeywords: batch },
        'application/vnd.spNegativeKeyword.v3+json');
      stats.amazon_calls++;
      if (r.ok || r.status === 207) {
        stats.negatives_created += batch.length;
      } else {
        stats.errors++;
      }
      await wait(1500);
    }

    // ── PARTE 2: Campanhas com prejuízo / sem retorno ──────────────────────
    // Agregar métricas de campanhas a partir dos search terms (janela 30 dias)
    const campMetrics = new Map<string, any>();
    for (const t of allSearchTerms) {
      if (!t.campaign_id || t.date > attributionCutoff) continue;
      if (!campMetrics.has(t.campaign_id)) {
        campMetrics.set(t.campaign_id, { spend: 0, orders: 0, sales: 0, first_date: t.date, last_date: t.date });
      }
      const m = campMetrics.get(t.campaign_id)!;
      m.spend += t.spend || 0;
      m.orders += t.orders_14d || t.orders_30d || t.orders_7d || 0;
      m.sales += t.sales_14d || t.sales_30d || t.sales_7d || 0;
      if (t.date < m.first_date) m.first_date = t.date;
      if (t.date > m.last_date) m.last_date = t.date;
    }

    // Filtrar campanhas ativas (não arquivadas, não já pausadas)
    const activeCampaigns = allCampaigns.filter((c: any) =>
      c.state === 'enabled' || c.status === 'enabled' || c.state === 'ENABLED' || c.status === 'ENABLED'
    );
    stats.campaigns_analyzed = activeCampaigns.length;

    const campaignsToPause: any[] = [];

    for (const camp of activeCampaigns) {
      const cid = camp.campaign_id || camp.id;
      const metrics = campMetrics.get(String(cid));
      if (!metrics) { stats.campaigns_skipped++; continue; }

      const daySpan = (new Date(metrics.last_date).getTime() - new Date(metrics.first_date).getTime()) / 86400000;
      if (daySpan < CUTOFF_DAYS) { stats.campaigns_skipped++; continue; }
      if (metrics.spend < minSpendForDecision) { stats.campaigns_skipped++; continue; }

      const acos = metrics.sales > 0 ? (metrics.spend / metrics.sales) * 100 : (metrics.spend > 0 ? 999 : 0);
      const isAuto = String(camp.targeting_type || camp.campaign_type || '').toUpperCase().includes('AUTO');
      const isManual = !isAuto;

      // Regras de pausa:
      // 1. Zero conversões + spend >= limiar + >= 21 dias → pausar qualquer tipo
      // 2. ACoS > maximum_acos E não é AUTO viável (AUTO com acos OK é preservada)
      const zeroConversion = metrics.orders === 0 && metrics.spend >= minSpendForDecision * 3;
      const highAcos = acos > maxAcos && metrics.spend >= minSpendForDecision;

      let shouldPause = false;
      let reason = '';

      if (zeroConversion && daySpan >= CUTOFF_DAYS) {
        // AUTO com zero conversão mas spend baixo → preservar (ainda aprendendo)
        if (isAuto && metrics.spend < minSpendForDecision * 5) {
          stats.campaigns_preserved++;
          continue;
        }
        shouldPause = true;
        reason = `${daySpan.toFixed(0)} dias sem conversão, gasto R$${metrics.spend.toFixed(2)}`;
      } else if (highAcos && daySpan >= CUTOFF_DAYS) {
        // AUTO viável: se ACoS está alto mas ainda tem conversões, preservar AUTO e apenas registrar
        if (isAuto && metrics.orders > 0 && acos < maxAcos * 1.5) {
          stats.campaigns_preserved++;
          continue;
        }
        shouldPause = true;
        reason = `ACoS ${acos.toFixed(0)}% > meta ${maxAcos}% por ${daySpan.toFixed(0)} dias`;
      }

      if (shouldPause) {
        campaignsToPause.push({ camp, cid: String(cid), metrics, acos, reason, isAuto });
      } else {
        stats.campaigns_preserved++;
      }
    }

    // Pausar campanhas em lotes de 50 na Amazon + atualizar banco
    for (let i = 0; i < campaignsToPause.length; i += 50) {
      const batch = campaignsToPause.slice(i, i + 50);
      const payload = batch.map(b => ({ campaignId: b.cid, state: 'PAUSED' }));
      const r = await adsCall('PUT', '/sp/campaigns', { campaigns: payload });
      stats.amazon_calls++;
      await wait(2000);

      for (const b of batch) {
        if (r.ok || r.status === 207) {
          // Atualizar estado no banco
          await base44.asServiceRole.entities.Campaign.updateMany(
            { amazon_account_id: accountId, campaign_id: b.cid },
            { $set: { state: 'PAUSED', status: 'paused', paused_by_cleanup: true, cleanup_reason: b.reason, cleanup_at: new Date().toISOString() } }
          ).catch(() => {});
          stats.campaigns_paused++;
          pauseActions.push({
            campaign_id: b.cid,
            campaign_name: b.camp.name || b.camp.campaign_name,
            reason: b.reason,
            type: b.isAuto ? 'AUTO' : 'MANUAL',
            spend: b.metrics.spend,
            acos: b.acos,
          });
        } else {
          stats.errors++;
        }
      }
    }

    // Registrar execução como SyncExecutionLog
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'runWeeklyWasteTermsCleanup',
      status: 'completed',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      result_summary: JSON.stringify({
        waste_terms: stats.waste_terms_found,
        negatives_created: stats.negatives_created,
        campaigns_paused: stats.campaigns_paused,
        campaigns_preserved: stats.campaigns_preserved,
      }),
    }).catch(() => {});

    return Response.json({
      ok: true,
      stats,
      negative_actions: negativeActions.slice(0, 100),
      pause_actions: pauseActions,
      config_used: { maxAcos, minSpendForDecision, cutoff_days: CUTOFF_DAYS },
      ran_at: new Date().toISOString(),
    });
  } catch (err: any) {
    return Response.json({ ok: false, error: err?.message || 'Erro inesperado' }, { status: 500 });
  }
});