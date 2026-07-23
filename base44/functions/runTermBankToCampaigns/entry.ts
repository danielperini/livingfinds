/**
 * runTermBankToCampaigns
 *
 * Lê termos do TermBank com classification='winner' ou confidence >= 85
 * que ainda não têm campanha manual canônica criada (promotion_status != 'promoted_to_manual')
 * e cria uma campanha MANUAL EXACT para cada um via createManualCampaignV2.
 *
 * Regras de segurança:
 *  - Máximo de max_per_run campanhas por execução (padrão 10)
 *  - Não cria se já existe campanha canônica SP | MANUAL | EXACT | {asin} com este termo
 *  - Não cria se produto sem estoque (fba_inventory = 0)
 *  - Não cria se ASIN já tem >= max_per_asin campanhas MANUAIS EXACT ativas (padrão 5)
 *  - Bid inicial: cpc médio do termo (bid_current) ou R$ 0,50 mínimo
 *  - Budget: R$ 15 (mínimo canônico)
 *  - Registra resultado no SyncExecutionLog
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const DEFAULT_MAX_PER_RUN  = 10;
const DEFAULT_MAX_PER_ASIN = 15; // ASINs com muitos termos winners no TermBank
const DEFAULT_MIN_BID      = 0.50;
const DEFAULT_BUDGET       = 15;
const COOLDOWN_HOURS       = 24; // aguardar entre tentativas para o mesmo ASIN+termo

function safeFloat(v: any, fallback = 0): number {
  const n = parseFloat(String(v ?? ''));
  return isNaN(n) ? fallback : n;
}

Deno.serve(async (req) => {
  const t0      = Date.now();
  const startAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(req);
    const body   = await req.json().catch(() => ({}));

    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 403 });
    }

    const db = base44.asServiceRole;

    // ── Resolver conta ────────────────────────────────────────────────────
    const accountId   = body.amazon_account_id as string | undefined;
    const maxPerRun   = Number(body.max_per_run  ?? DEFAULT_MAX_PER_RUN);
    const maxPerAsin  = Number(body.max_per_asin ?? DEFAULT_MAX_PER_ASIN);
    const dryRun      = body.dry_run === true;
    const forceAsin   = body.asin_filter as string | undefined;

    const accounts = accountId
      ? await db.entities.AmazonAccount.filter({ id: accountId }, null, 1)
      : await db.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_date', 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta conectada' }, { status: 404 });
    const aid = account.id;

    // ── Carregar dados em paralelo ─────────────────────────────────────────
    const [termBankRaw, products, campaigns] = await Promise.all([
      db.entities.TermBank.filter({ amazon_account_id: aid }, '-orders', 2000).catch(() => [] as any[]),
      db.entities.Product.filter({ amazon_account_id: aid }, null, 1000).catch(() => [] as any[]),
      db.entities.Campaign.filter({ amazon_account_id: aid }, null, 3000).catch(() => [] as any[]),
    ]);

    // ── Índices ────────────────────────────────────────────────────────────
    const productMap = new Map<string, any>();
    for (const p of products) { if (p.asin) productMap.set(p.asin, p); }

    // Campanhas MANUAL EXACT ativas/pausadas por ASIN → contar e indexar por keyword
    const manualExactByAsin = new Map<string, number>();
    const existingCampaignNames = new Set<string>();
    for (const c of campaigns) {
      const st    = (c.state || c.status || '').toLowerCase();
      const isManualExact = /^SP\s*\|\s*MANUAL\s*\|\s*EXACT\s*\|/i.test(c.name || c.campaign_name || '');
      if (isManualExact && ['enabled', 'paused', 'incomplete'].includes(st)) {
        if (c.asin) manualExactByAsin.set(c.asin, (manualExactByAsin.get(c.asin) || 0) + 1);
        existingCampaignNames.add((c.name || c.campaign_name || '').toLowerCase().trim());
      }
    }

    // ── Filtrar candidatos do TermBank ─────────────────────────────────────
    const candidateTerms = termBankRaw.filter((t: any) => {
      if (t.status === 'negative' || t.status === 'archived') return false;
      if (t.promotion_status === 'promoted_to_manual') return false;
      if (!t.term || !t.asin) return false;
      if (forceAsin && t.asin !== forceAsin) return false;

      // Apenas termos com boa classificação ou alta confiança
      const isWinner     = t.classification === 'winner';
      const highConfidence = safeFloat(t.confidence) >= 85;
      if (!isWinner && !highConfidence) return false;

      // Produto deve existir e ter estoque
      const prod = productMap.get(t.asin);
      if (!prod) return false;
      if (safeFloat(prod.fba_inventory) <= 0) return false;

      return true;
    });

    // Ordenar: winners primeiro, depois por orders desc
    candidateTerms.sort((a: any, b: any) => {
      if (a.classification === 'winner' && b.classification !== 'winner') return -1;
      if (b.classification === 'winner' && a.classification !== 'winner') return 1;
      return safeFloat(b.orders) - safeFloat(a.orders);
    });

    // ── Processar até maxPerRun ────────────────────────────────────────────
    const created: any[]  = [];
    const skipped: any[]  = [];
    const errors: any[]   = [];
    const asinCount = new Map<string, number>(manualExactByAsin);

    for (const term of candidateTerms) {
      if (created.length >= maxPerRun) break;

      const asin = term.asin;
      const kw   = String(term.term || '').trim();
      if (!kw) { skipped.push({ term: kw, asin, reason: 'empty_term' }); continue; }

      // Cap por ASIN
      if ((asinCount.get(asin) || 0) >= maxPerAsin) {
        skipped.push({ term: kw, asin, reason: 'asin_cap_reached' });
        continue;
      }

      // Verificar se campanha com este nome já existe
      const prod         = productMap.get(asin)!;
      const kwSlug       = kw.replace(/[^a-z0-9\sáéíóúâêôãõç-]/gi, '').trim().slice(0, 40);
      const campaignName = `SP | MANUAL | EXACT | ${asin} | ${kwSlug}`.slice(0, 128).toLowerCase().trim();
      if (existingCampaignNames.has(campaignName)) {
        skipped.push({ term: kw, asin, reason: 'campaign_already_exists' });
        // Marcar como promovido para não tentar novamente
        if (!dryRun) {
          await db.entities.TermBank.update(term.id, { promotion_status: 'promoted_to_manual' }).catch(() => {});
        }
        continue;
      }

      // Calcular bid inicial
      const bidCurrent = safeFloat(term.bid_current, 0);
      const cpc        = safeFloat(term.cpc, 0);
      const bid        = Math.max(DEFAULT_MIN_BID, Math.min(2.50, bidCurrent > 0 ? bidCurrent : (cpc > 0 ? cpc : DEFAULT_MIN_BID)));

      if (dryRun) {
        created.push({
          dry_run: true,
          asin,
          keyword: kw,
          bid: parseFloat(bid.toFixed(2)),
          budget: DEFAULT_BUDGET,
          classification: term.classification,
          confidence: term.confidence,
          orders: term.orders,
          acos: term.acos,
        });
        asinCount.set(asin, (asinCount.get(asin) || 0) + 1);
        continue;
      }

      // Criar campanha via createManualCampaignV2
      try {
        const res  = await db.functions.invoke('createManualCampaignV2', {
          amazon_account_id: aid,
          asin,
          sku: prod.sku || term.sku || null,
          product_name: prod.product_name || prod.display_name || term.product_name || asin,
          keyword: kw,
          bid: parseFloat(bid.toFixed(2)),
          budget: DEFAULT_BUDGET,
          _service_role: true,
        });

        const d = res?.data || res || {};

        if (d?.ok || d?.campaign_id) {
          // Marcar como promovido no TermBank
          await db.entities.TermBank.update(term.id, {
            promotion_status: 'promoted_to_manual',
            updated_at: new Date().toISOString(),
          }).catch(() => {});

          asinCount.set(asin, (asinCount.get(asin) || 0) + 1);
          existingCampaignNames.add(campaignName);
          created.push({
            asin, keyword: kw, bid: parseFloat(bid.toFixed(2)),
            campaign_id: d.campaign_id || d.amazon_campaign_id || null,
            campaign_name: d.campaign_name || null,
          });
        } else {
          errors.push({ asin, keyword: kw, error: d?.error || 'Falha ao criar campanha' });
        }
      } catch (e: any) {
        errors.push({ asin, keyword: kw, error: e?.message || 'Erro desconhecido' });
      }

      // Pequeno intervalo para não sobrecarregar a API
      await new Promise(r => setTimeout(r, 600));
    }

    // ── Log ────────────────────────────────────────────────────────────────
    if (!dryRun) {
      await db.entities.SyncExecutionLog.create({
        amazon_account_id: aid,
        operation: 'runTermBankToCampaigns',
        trigger_type: body._service_role ? 'automatic' : 'manual',
        status: errors.length > 0 ? 'warning' : 'success',
        started_at: startAt,
        completed_at: new Date().toISOString(),
        records_processed: created.length,
        result_summary: JSON.stringify({
          candidates: candidateTerms.length,
          created: created.length,
          skipped: skipped.length,
          errors: errors.length,
        }),
      }).catch(() => {});
    }

    return Response.json({
      ok: true,
      dry_run: dryRun,
      candidates: candidateTerms.length,
      created: created.length,
      skipped: skipped.length,
      errors: errors.length,
      created_list: created,
      error_list: errors.slice(0, 20),
      skipped_list: skipped.slice(0, 30),
      duration_ms: Date.now() - t0,
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err?.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});