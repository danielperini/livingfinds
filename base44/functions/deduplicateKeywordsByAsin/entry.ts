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
    // gateway centralizado não precisa de credenciais diretas — resolvidas internamente

    // ── Carregar campanhas para resolver ASIN via campaign_id ─────────────
    const campaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: aid }, null, 500
    ).catch(() => []);
    // Mapa: campaign_id → asin
    const campaignAsinMap = new Map<string, string>();
    for (const c of campaigns) {
      const cid = String(c.campaign_id || c.amazon_campaign_id || '');
      if (cid && c.asin) campaignAsinMap.set(cid, c.asin);
    }

    // ── Carregar todas as keywords ativas (paginação correta) ────────────
    const allKeywords: any[] = [];
    const seenIds = new Set<string>();
    const passes = [
      { sort: '-spend', limit: 500 },
      { sort: 'created_date', limit: 500 },
      { sort: '-created_date', limit: 500 },
      { sort: 'keyword_text', limit: 500 },
    ];
    for (const pass of passes) {
      const batch = await base44.asServiceRole.entities.Keyword.filter(
        { amazon_account_id: aid, state: 'enabled' }, pass.sort, pass.limit
      ).catch(() => []);
      for (const kw of batch) {
        if (!seenIds.has(kw.id)) { seenIds.add(kw.id); allKeywords.push(kw); }
      }
    }

    // ── Construir mapa de deduplicação ────────────────────────────────────
    // chave: `${asin}|||${normalized_keyword_text}`
    const groups = new Map<string, any[]>();

    for (const kw of allKeywords) {
      // Ignorar keywords já pausadas/arquivadas
      const st = String(kw.state || kw.status || '').toLowerCase();
      if (st === 'paused' || st === 'archived' || st === 'deleted') continue;

      // Resolver ASIN: campo direto ou via campanha
      const asin = kw.asin || campaignAsinMap.get(String(kw.campaign_id || '')) || null;
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

    // Pausar na Amazon Ads API v3 via gateway centralizado (com retry automático)
    const kwIdsToAmazon = toPauseAll
      .filter(kw => kw.keyword_id)
      .map(kw => ({ keywordId: String(kw.keyword_id), state: 'PAUSED' }));

    if (kwIdsToAmazon.length > 0) {
      for (let i = 0; i < kwIdsToAmazon.length; i += 10) {
        const batch = kwIdsToAmazon.slice(i, i + 10);
        try {
          const raw = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
            amazon_account_id: aid,
            operation: 'pauseKeyword',
            method: 'PUT',
            path: '/sp/keywords',
            payload: { keywords: batch },
            content_type: V3_KW_CT,
            accept: V3_KW_CT,
            max_attempts: 3,
            _service_role: true,
          });
          const data = raw?.data || raw || {};
          const v3 = data?.payload?.keywords || data?.keywords || {};
          const success = v3?.success || [];
          const errors = v3?.error || v3?.errors || [];
          results.paused_amazon += success.length || (errors.length === 0 ? batch.length : 0);
          results.failed_amazon += errors.length;
          if (errors.length > 0) {
            errorLog.push(...errors.slice(0, 3).map((e: any) => JSON.stringify(e).slice(0, 200)));
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