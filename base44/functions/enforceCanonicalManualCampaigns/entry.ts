/**
 * enforceCanonicalManualCampaigns — Regra canônica: 1 keyword EXACT por termo+ASIN
 *
 * Lógica de seleção da canônica:
 * 1. Campanha com vendas (orders > 0)
 * 2. Menor ACoS
 * 3. Maior número de pedidos
 * 4. Campanha mais antiga (created_at)
 * 5. Menor campaignId como desempate técnico
 *
 * Chave de unicidade: amazon_account_id + marketplace_id + asin + normalized_term + exact
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

const BATCH_SIZE = 20;
const THROTTLE_MS = 2000;
const DEFAULT_BID = 0.60;
const DEFAULT_BUDGET = 7.0;
const V3_CAMP_CT = 'application/vnd.spCampaign.v3+json';
const V3_AG_CT   = 'application/vnd.spAdGroup.v3+json';
const V3_KW_CT   = 'application/vnd.spKeyword.v3+json';
const V3_PA_CT   = 'application/vnd.spProductAd.v3+json';

// ASINs autorizados e monitorados
const AUTHORIZED_ASINS = new Set([
  'B0H59FPPKS','B0GHP612B8','B0DJ3RGHK6','B0GR6GXS1B','B0GNY7NYRN',
  'B0GNW1Q6V3','B0GHP68123','B0GHP958MV','B0GHP9PPWN','B0GFQ7SY5W',
  'B0FVW1TV6Y','B0FRVMB7BW','B0FCYR3VBD','B0F45JG27L'
]);

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function nowIso() { return new Date().toISOString(); }
function todayStr() { return new Date(Date.now() - 3*3600000).toISOString().slice(0,10); }

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
    amazon_account_id: aid, method, path, payload,
    content_type: ct, accept: ct, max_attempts: 3, _service_role: true,
  });
  const d = res?.data || res || {};
  return d?.payload ?? d;
}

/**
 * Seleciona qual campanha manter como canônica dado um grupo de campanhas com mesmo ASIN+termo.
 * Critérios em ordem:
 * 1. Tem vendas (orders > 0)
 * 2. Menor ACoS (quando ambas têm vendas)
 * 3. Maior orders
 * 4. Mais antiga (created_at)
 * 5. Menor campaignId (desempate técnico)
 */
function selectCanonical(campaigns: any[]): { canonical: any; duplicates: any[] } {
  if (campaigns.length === 1) return { canonical: campaigns[0], duplicates: [] };

  const scored = campaigns.map(c => {
    const orders = c.orders || c.current_orders || 0;
    const spend = c.spend || c.current_spend || 0;
    const sales = c.sales || c.current_sales || 0;
    const acos = sales > 0 ? spend / sales * 100 : 999;
    const createdTs = new Date(c.created_at || c.created_date || '2020-01-01').getTime();
    return { c, orders, acos, createdTs };
  });

  // Ordenar: 1) tem vendas DESC, 2) acos ASC, 3) orders DESC, 4) mais antiga ASC, 5) campaignId ASC
  scored.sort((a, b) => {
    const aHasSales = a.orders > 0 ? 1 : 0;
    const bHasSales = b.orders > 0 ? 1 : 0;
    if (bHasSales !== aHasSales) return bHasSales - aHasSales;
    if (a.acos !== b.acos) return a.acos - b.acos;
    if (b.orders !== a.orders) return b.orders - a.orders;
    if (a.createdTs !== b.createdTs) return a.createdTs - b.createdTs;
    return String(a.c.campaign_id || '').localeCompare(String(b.c.campaign_id || ''));
  });

  return { canonical: scored[0].c, duplicates: scored.slice(1).map(s => s.c) };
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const dry_run: boolean = body.dry_run !== false;
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
    const marketplace_id = account.marketplace_id || '';

    // ── Carregar dados locais ─────────────────────────────────────────────
    const [localCampaigns, localKeywords, localProducts] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 500),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, null, 3000),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 200),
    ]);

    // Produtos elegíveis: autorizados + com estoque + listing ativo
    const eligibleProducts = new Set(
      localProducts
        .filter(p =>
          AUTHORIZED_ASINS.has(p.asin) &&
          p.inventory_status !== 'out_of_stock' &&
          p.status !== 'inactive' &&
          p.status !== 'archived' &&
          p.listing_suppressed !== true &&
          p.ads_authorized_by_user === true
        )
        .map(p => p.asin)
    );

    // Campanhas manuais ativas ou pausadas (não arquivadas)
    const manualCampaigns = localCampaigns.filter(c => {
      const type = (c.targeting_type || c.campaign_type || '').toUpperCase();
      const state = (c.status || c.state || '').toLowerCase();
      return type === 'MANUAL' && state !== 'archived' && state !== 'deleted';
    });

    // Keywords por campaign_id (apenas EXACT ativas)
    const kwByCamp = new Map<string, any[]>();
    for (const kw of localKeywords) {
      const cid = String(kw.campaign_id || '');
      if (!kwByCamp.has(cid)) kwByCamp.set(cid, []);
      kwByCamp.get(cid)!.push(kw);
    }

    // ── Construir mapa de unicidade: chave → lista de campanhas ──────────
    // Chave: `${aid}|${marketplace_id}|${asin}|${normalized_term}|exact`
    const termToCampaigns = new Map<string, any[]>();

    for (const c of manualCampaigns) {
      const asin = c.asin;
      if (!asin) continue;

      const cid = String(c.campaign_id || '');
      const kws = (kwByCamp.get(cid) || []).filter(k => {
        const mt = (k.match_type || '').toLowerCase();
        const st = (k.state || k.status || '').toLowerCase();
        return mt === 'exact' && !['archived', 'deleted'].includes(st);
      });

      for (const kw of kws) {
        const term = normalizeTerm(kw.keyword_text || kw.keyword || '');
        if (!term) continue;
        const key = `${aid}|${marketplace_id}|${asin}|${term}|exact`;
        if (!termToCampaigns.has(key)) termToCampaigns.set(key, []);
        termToCampaigns.get(key)!.push({ ...c, _term: term, _keyword: kw });
      }
    }

    // ── Identificar duplicatas ────────────────────────────────────────────
    const violations: Array<{ key: string; canonical: any; duplicates: any[] }> = [];

    for (const [key, group] of termToCampaigns.entries()) {
      if (group.length <= 1) continue;
      const { canonical, duplicates } = selectCanonical(group);
      violations.push({ key, canonical, duplicates });
    }

    const stats = {
      manual_campaigns_total: manualCampaigns.length,
      unique_term_asin_keys: termToCampaigns.size,
      keys_with_duplicates: violations.length,
      total_duplicate_campaigns: violations.reduce((s, v) => s + v.duplicates.length, 0),
      eligible_asins: eligibleProducts.size,
    };

    if (dry_run) {
      return Response.json({
        ok: true, dry_run: true, stats,
        violations_sample: violations.slice(0, 10).map(v => ({
          key: v.key,
          canonical: v.canonical.campaign_name || v.canonical.name,
          canonical_orders: v.canonical.orders || 0,
          canonical_acos: v.canonical.acos || 0,
          duplicates: v.duplicates.map(d => ({
            name: d.campaign_name || d.name,
            orders: d.orders || 0,
            acos: d.acos || 0,
          })),
        })),
        message: `${violations.length} grupos com duplicatas. ${stats.total_duplicate_campaigns} campanhas a pausar.`,
        duration_ms: Date.now() - t0,
      });
    }

    // ── EXECUÇÃO: pausar duplicatas ───────────────────────────────────────
    const toProcess = violations.flatMap(v => v.duplicates.map(d => ({ ...d, _canonical_name: v.canonical.campaign_name || v.canonical.name })));
    const batch = toProcess.slice(0, batch_size);
    const remaining = toProcess.length - batch.length;

    const results = { paused: 0, already_paused: 0, failed: 0, pending_confirmation: 0 };
    const logs: string[] = [];

    for (const dup of batch) {
      const cid = String(dup.campaign_id || '');
      const currentState = (dup.status || dup.state || '').toLowerCase();

      if (['paused', 'archived'].includes(currentState)) {
        results.already_paused++;
        logs.push(`JÁ PAUSADA: ${dup.campaign_name || dup.name}`);
        continue;
      }

      try {
        await adsCommand(base44, aid, 'PUT', '/sp/campaigns', {
          campaigns: [{ campaignId: cid, state: 'PAUSED' }]
        }, V3_CAMP_CT);
        await sleep(THROTTLE_MS);

        await base44.asServiceRole.entities.Campaign.update(dup.id, {
          status: 'paused', state: 'paused', updated_at: now,
        }).catch(() => {});

        results.paused++;
        logs.push(`PAUSADO (duplicata de "${dup._canonical_name}"): ${dup.campaign_name || dup.name} | ASIN: ${dup.asin} | termo: ${dup._term}`);
      } catch (e: any) {
        results.failed++;
        logs.push(`FALHA pausar: ${dup.campaign_name || dup.name} — ${e.message}`);
      }
    }

    // ── Log de execução ───────────────────────────────────────────────────
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
      result_summary: JSON.stringify({ ...results, remaining, stats }).slice(0, 500),
    }).catch(() => {});

    return Response.json({
      ok: true,
      dry_run: false,
      batch_processed: batch.length,
      remaining_to_process: remaining,
      results,
      stats,
      logs,
      confirmations: {
        no_duplicate_terms_per_asin: violations.length === 0,
        all_processed: remaining === 0 && results.failed === 0,
      },
      duration_ms: Date.now() - t0,
    });

  } catch (error: any) {
    console.error('[enforceCanonicalManualCampaigns]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});