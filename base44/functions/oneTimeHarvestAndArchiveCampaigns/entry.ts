import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const NAMES = [
  'AUTO | B0G1MZLYS9 | 2026-06-30','Organizador Talheres Manual Produtos','Organizador Talheres Manual Palavras',
  'Gimbal Manual Palavras','Gimbal Manual Produtos','Bastão Selfie [Produtos]','Ventilador [Produtos]',
  'Ventilador [PALAVRAS]','LIXEIRA 15 LTS [PRODUTOS]','Lixeiras Sensor [PALAVRAS]',
  'NEBULIZADOR [PRODUTOS]','Nebulizador Mesh [PALAVRAS]',
  'Campanha Manual PRODUTO - Lapela - 17/01','Manual Palavras - Lapela - 17/01'
];

const norm = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const n = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
const wanted = new Set(NAMES.map(norm));

function calc(r) {
  const orders = n(r.orders_30d ?? r.orders_14d ?? r.orders_7d ?? r.orders ?? r.purchases ?? r.units_ordered);
  const sales = n(r.sales_30d ?? r.sales_14d ?? r.sales_7d ?? r.sales ?? r.revenue ?? r.sales_amount);
  const spend = n(r.spend_30d ?? r.spend ?? r.cost);
  const clicks = n(r.clicks_30d ?? r.clicks);
  const impressions = n(r.impressions_30d ?? r.impressions);
  const acos = sales > 0 ? spend / sales * 100 : 999;
  const roas = spend > 0 ? sales / spend : sales > 0 ? 99 : 0;
  const conversion = clicks > 0 ? orders / clicks * 100 : orders > 0 ? 100 : 0;
  const score = Math.min(100, Math.round(Math.min(40, orders * 4) + Math.min(25, roas * 8) + Math.min(20, conversion) + (acos <= 25 ? 15 : acos <= 40 ? 8 : 0)));
  return { orders, sales, spend, clicks, impressions, acos, roas, conversion, score };
}

Deno.serve(async (req) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(req);
    if (!await base44.auth.isAuthenticated().catch(() => false)) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const accountId = body.amazon_account_id;
    if (!accountId) return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });
    if (body.confirm !== 'EXECUTAR_UNICA_VEZ') return Response.json({ ok: false, error: 'Use confirm=EXECUTAR_UNICA_VEZ.' }, { status: 400 });

    const done = await base44.asServiceRole.entities.SyncExecutionLog.filter({ amazon_account_id: accountId, operation: 'one_time_fill_term_bank_from_legacy_campaigns', status: 'success' }, '-completed_at', 1);
    if (done.length) return Response.json({ ok: true, already_executed: true, message: 'O Banco de Termos já foi preenchido por esta rotina.' });

    const campaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-created_date', 10000);
    const selected = campaigns.filter(c => wanted.has(norm(c.name || c.campaign_name)));
    const ids = new Set(selected.map(c => String(c.campaign_id)));
    const cmap = new Map(selected.map(c => [String(c.campaign_id), c]));

    const [terms, keywords] = await Promise.all([
      base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id: accountId }, '-orders', 10000),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId }, '-orders', 10000)
    ]);

    const rows = [
      ...terms.filter(r => ids.has(String(r.campaign_id))).map(r => ({ r, source: 'search_term_auto' })),
      ...keywords.filter(r => ids.has(String(r.campaign_id))).map(r => ({ r, source: 'manual_kickoff' }))
    ];

    const best = new Map();
    for (const item of rows) {
      const text = String(item.r.search_term || item.r.term || item.r.keyword_text || item.r.keyword || '').trim();
      const m = calc(item.r);
      if (!text || m.orders <= 5 || m.sales <= 0 || !((m.acos <= 40 || m.roas >= 2) && m.score >= 60)) continue;
      const key = norm(text);
      if (!best.has(key) || m.orders > best.get(key).m.orders) best.set(key, { ...item, text, m });
    }

    let created = 0, updated = 0;
    for (const item of best.values()) {
      const campaign = cmap.get(String(item.r.campaign_id));
      const key = norm(item.text);
      const existing = await base44.asServiceRole.entities.TermBank.filter({ amazon_account_id: accountId, normalized_term: key }, '-updated_at', 1);
      const record = {
        amazon_account_id: accountId, term: item.text, normalized_term: key,
        asin: item.r.advertised_asin || item.r.asin || campaign?.asin || null,
        sku: item.r.sku || campaign?.sku || null, campaign_id: String(item.r.campaign_id),
        source: item.source, classification: 'winner', orders: item.m.orders, sales: item.m.sales,
        spend: item.m.spend, clicks: item.m.clicks, impressions: item.m.impressions,
        acos: Number(item.m.acos.toFixed(2)), roas: Number(item.m.roas.toFixed(2)),
        conversion_rate: Number(item.m.conversion.toFixed(2)), performance_score: item.m.score,
        last_seen_at: new Date().toISOString(), notes: 'Importado uma única vez de campanha histórica com mais de 5 vendas e bom desempenho.'
      };
      if (existing.length) { await base44.asServiceRole.entities.TermBank.update(existing[0].id, record); updated++; }
      else { await base44.asServiceRole.entities.TermBank.create(record); created++; }
    }

    const completedAt = new Date().toISOString();
    const summary = { campaigns_found: selected.length, search_terms_scanned: terms.filter(r => ids.has(String(r.campaign_id))).length, keywords_scanned: keywords.filter(r => ids.has(String(r.campaign_id))).length, unique_winners: best.size, created, updated, campaigns_archived: 0 };
    await base44.asServiceRole.entities.SyncExecutionLog.create({ amazon_account_id: accountId, operation: 'one_time_fill_term_bank_from_legacy_campaigns', status: 'success', trigger_type: 'manual_one_time', started_at: startedAt, completed_at: completedAt, records_processed: created + updated, result_summary: JSON.stringify(summary), error_message: null });

    return Response.json({ ok: true, one_time: true, archived_any_campaign: false, summary });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao preencher o Banco de Termos' }, { status: 500 });
  }
});
