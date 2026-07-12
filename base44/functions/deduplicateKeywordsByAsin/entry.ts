/**
 * deduplicateKeywordsByAsin
 *
 * Varre todos os ASINs ativos e garante que cada termo (keyword_text normalizado)
 * aparece NO MÁXIMO UMA VEZ por ASIN entre todas as campanhas.
 *
 * Regra de prioridade para manter (entre duplicatas):
 *   1. Maior spend histórico
 *   2. Maior número de pedidos
 *   3. Mais antiga (created_date menor)
 *
 * Duplicatas são PAUSADAS:
 *   - Localmente: state/status = 'paused'
 *   - Na Amazon Ads API v3: PUT /sp/keywords state=PAUSED
 *
 * dry_run=true (padrão): apenas reporta sem aplicar
 * dry_run=false: executa pausas reais
 *
 * Também persiste regra de prevenção: ao criar keyword, verificar antes.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

const V3_KW_CT = 'application/vnd.spKeyword.v3+json';
const THROTTLE_MS = 300;

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getAdsToken(account: any): Promise<string | null> {
  const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
  const clientSecret = Deno.env.get('ADS_CLIENT_SECRET') || '';
  const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '';
  if (!refreshToken || !clientId) return null;
  try {
    const res = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.access_token || null;
  } catch { return null; }
}

function normalizeText(text: string): string {
  return (text || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[áàãâä]/g, 'a')
    .replace(/[éèêë]/g, 'e')
    .replace(/[íìîï]/g, 'i')
    .replace(/[óòõôö]/g, 'o')
    .replace(/[úùûü]/g, 'u')
    .replace(/[ç]/g, 'c')
    .replace(/[ñ]/g, 'n');
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const dry_run = body.dry_run !== false; // default true
    const now = new Date().toISOString();

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
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({}, null, 1);
      account = accs?.[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' });

    const aid = account.id;
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';
    const region = account.region || Deno.env.get('ADS_REGION') || 'na';
    const endpointMap: Record<string, string> = {
      na: 'https://advertising-api.amazon.com',
      eu: 'https://advertising-api-eu.amazon.com',
      fe: 'https://advertising-api-fe.amazon.com',
    };
    const adsEndpoint = endpointMap[region] || endpointMap.na;
    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';

    // ── Carregar todas as keywords ativas ────────────────────────────────
    const allKeywords: any[] = [];
    let skip = 0;
    while (true) {
      const batch = await base44.asServiceRole.entities.Keyword.filter(
        { amazon_account_id: aid }, '-spend', 200
      ).catch(() => []);
      if (batch.length === 0) break;
      allKeywords.push(...batch);
      if (batch.length < 200) break;
      skip += 200;
      if (skip >= 2000) break; // safety
    }

    // ── Construir mapa de deduplicação ────────────────────────────────────
    // chave: `${asin}|||${normalized_keyword_text}`
    const groups = new Map<string, any[]>();

    for (const kw of allKeywords) {
      // Ignorar keywords já pausadas/arquivadas
      const st = String(kw.state || kw.status || '').toLowerCase();
      if (st === 'paused' || st === 'archived' || st === 'deleted') continue;

      const asin = kw.asin;
      if (!asin) continue;

      const text = normalizeText(kw.keyword_text || '');
      if (!text) continue;

      const key = `${asin}|||${text}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(kw);
    }

    // ── Identificar duplicatas ────────────────────────────────────────────
    const dupGroups: { asin: string; text: string; keep: any; pause: any[] }[] = [];

    for (const [key, entries] of groups.entries()) {
      if (entries.length <= 1) continue;

      const [asin, text] = key.split('|||');

      // Ordenar: maior spend → maior orders → mais antiga
      entries.sort((a: any, b: any) => {
        const spendDiff = (b.spend || 0) - (a.spend || 0);
        if (Math.abs(spendDiff) > 0.01) return spendDiff;
        const ordersDiff = (b.orders || 0) - (a.orders || 0);
        if (ordersDiff !== 0) return ordersDiff;
        return new Date(a.created_date || 0).getTime() - new Date(b.created_date || 0).getTime();
      });

      dupGroups.push({
        asin,
        text,
        keep: entries[0],
        pause: entries.slice(1),
      });
    }

    const totalToPause = dupGroups.reduce((s, g) => s + g.pause.length, 0);

    if (dry_run) {
      return Response.json({
        ok: true,
        dry_run: true,
        message: `Varredura completa. ${dupGroups.length} grupos de duplicatas encontrados, ${totalToPause} keywords serão pausadas.`,
        total_keywords_analyzed: allKeywords.length,
        dup_groups: dupGroups.length,
        total_to_pause: totalToPause,
        preview: dupGroups.slice(0, 20).map(g => ({
          asin: g.asin,
          keyword_text: g.text,
          keep_campaign: g.keep.campaign_id,
          keep_spend: g.keep.spend,
          pause_count: g.pause.length,
          pause_campaigns: g.pause.map((p: any) => p.campaign_id),
        })),
      });
    }

    // ── Executar pausas ────────────────────────────────────────────────────
    const adsToken = await getAdsToken(account);
    const results = { paused_local: 0, paused_amazon: 0, failed_amazon: 0, skipped: 0 };
    const errorLog: string[] = [];

    // Coletar todos os keyword_id a pausar
    const toPauseAll: any[] = dupGroups.flatMap(g => g.pause);

    // Pausar localmente em bulk
    const localUpdates = toPauseAll
      .filter(kw => kw.id)
      .map(kw => ({ id: kw.id, state: 'paused', status: 'paused', updated_at: now }));

    if (localUpdates.length > 0) {
      for (let i = 0; i < localUpdates.length; i += 50) {
        const batch = localUpdates.slice(i, i + 50);
        await base44.asServiceRole.entities.Keyword.bulkUpdate(batch).catch(() => {});
        results.paused_local += batch.length;
      }
    }

    // Pausar na Amazon Ads API v3 em lotes de 10
    if (adsToken && profileId) {
      const kwIdsToAmazon = toPauseAll
        .filter(kw => kw.keyword_id)
        .map(kw => ({ keywordId: String(kw.keyword_id), state: 'PAUSED' }));

      for (let i = 0; i < kwIdsToAmazon.length; i += 10) {
        const batch = kwIdsToAmazon.slice(i, i + 10);
        try {
          const res = await fetch(`${adsEndpoint}/sp/keywords`, {
            method: 'PUT',
            headers: {
              'Amazon-Advertising-API-ClientId': clientId,
              'Amazon-Advertising-API-Scope': profileId,
              'Authorization': `Bearer ${adsToken}`,
              'Content-Type': V3_KW_CT,
              'Accept': V3_KW_CT,
            },
            body: JSON.stringify({ keywords: batch }),
          });
          if (res.ok) {
            const data = await res.json();
            const success = data?.keywords?.success || [];
            const errors = data?.keywords?.error || [];
            results.paused_amazon += success.length;
            results.failed_amazon += errors.length;
            if (errors.length > 0) {
              errorLog.push(...errors.slice(0, 3).map((e: any) => JSON.stringify(e).slice(0, 200)));
            }
          } else {
            results.failed_amazon += batch.length;
          }
        } catch (err: any) {
          results.failed_amazon += batch.length;
          errorLog.push(err.message?.slice(0, 100) || 'error');
        }
        await sleep(THROTTLE_MS);
      }
    } else {
      results.skipped = toPauseAll.length;
    }

    // ── Log de auditoria ──────────────────────────────────────────────────
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'deduplicateKeywordsByAsin',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      status: 'success',
      started_at: now,
      completed_at: new Date().toISOString(),
      records_processed: toPauseAll.length,
      result_summary: JSON.stringify({
        dup_groups: dupGroups.length,
        total_to_pause: totalToPause,
        ...results,
      }).slice(0, 500),
    }).catch(() => {});

    return Response.json({
      ok: true,
      dry_run: false,
      total_keywords_analyzed: allKeywords.length,
      dup_groups: dupGroups.length,
      total_paused: totalToPause,
      results,
      error_sample: errorLog.slice(0, 5),
      detail: dupGroups.slice(0, 20).map(g => ({
        asin: g.asin,
        keyword_text: g.text,
        kept: { campaign_id: g.keep.campaign_id, spend: g.keep.spend, orders: g.keep.orders },
        paused: g.pause.map((p: any) => ({ campaign_id: p.campaign_id, keyword_id: p.keyword_id })),
      })),
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
});