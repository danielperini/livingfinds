/**
 * runDaypartDecisionEngine
 *
 * Motor de dayparting baseado em métricas por hora (HourlyMetric).
 * Classifica blocos horários, gera decisões de bid temporário via AmazonActionQueue.
 *
 * Regras:
 * - Não altera bid base permanente (apenas bid temporário por bloco)
 * - Bloco ruim (waste): reduz bid -10% a -20%
 * - Bloco bom (high_conversion/scale_candidate): aumenta bid +5% a +10%
 * - Após bloco, restaura bid_base
 * - Nunca abaixo de min_bid ou acima de max_bid
 * - confidence >= 90 para execução automática
 * - NÃO usa IA. NÃO chama Amazon diretamente. Usa AmazonActionQueue.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function safe(v: unknown): number {
  const n = Number(v);
  return isNaN(n) || !isFinite(n) ? 0 : n;
}

function safeDiv(a: number, b: number): number {
  return b > 0 ? a / b : 0;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoStr(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

// Blocos horários canônicos
const HOUR_BLOCKS = [
  { name: 'madrugada', start: 0, end: 5 },
  { name: 'manhã_cedo', start: 6, end: 8 },
  { name: 'manhã', start: 9, end: 11 },
  { name: 'almoço', start: 12, end: 14 },
  { name: 'tarde', start: 15, end: 17 },
  { name: 'fim_tarde', start: 18, end: 20 },
  { name: 'noite', start: 21, end: 23 },
];

function getBlock(hour: number) {
  return HOUR_BLOCKS.find(b => hour >= b.start && hour <= b.end) || HOUR_BLOCKS[0];
}

// Classificar um bloco horário
function classifyBlock(metrics: {
  impressions: number; clicks: number; spend: number; orders: number; sales: number;
  acos: number; roas: number; cpc: number; ctr: number; cvr: number;
  days_with_data: number;
}, cfg: {
  target_acos: number; max_acos: number; target_roas: number; target_cpc: number; max_cpc: number;
  min_impressions: number; min_clicks: number;
}): {
  classification: 'high_conversion' | 'efficient_volume' | 'waste' | 'low_data' | 'no_delivery' | 'protect_budget' | 'scale_candidate';
  confidence: number;
  recommended_action: 'reduce' | 'increase' | 'hold' | 'observe';
  reduce_pct: number;
  increase_pct: number;
  notes: string[];
} {
  const notes: string[] = [];

  // No delivery
  if (metrics.impressions < 5 || (metrics.impressions < 20 && metrics.days_with_data > 3)) {
    return { classification: 'no_delivery', confidence: 60, recommended_action: 'observe', reduce_pct: 0, increase_pct: 0, notes: ['Sem delivery neste bloco'] };
  }

  // Dados insuficientes
  const hasEnoughData = metrics.impressions >= cfg.min_impressions || metrics.clicks >= cfg.min_clicks || metrics.orders >= 1;
  if (!hasEnoughData) {
    return { classification: 'low_data', confidence: 40, recommended_action: 'observe', reduce_pct: 0, increase_pct: 0, notes: ['Volume insuficiente para decisão'] };
  }

  // Desperdício: gasto sem venda
  const hasSpend = metrics.spend >= 1.0;
  const hasConversion = metrics.orders >= 1;
  const acosOk = cfg.target_acos > 0 ? metrics.acos <= cfg.max_acos : true;
  const cpcOk = cfg.max_cpc > 0 ? metrics.cpc <= cfg.max_cpc : true;

  if (hasSpend && !hasConversion && metrics.clicks >= 3) {
    // Bloco de desperdício: gasto com zero conversão
    notes.push(`R$${metrics.spend.toFixed(2)} gastos sem pedido (${metrics.clicks} cliques)`);
    const confidence = metrics.clicks >= 10 ? 85 : metrics.clicks >= 5 ? 75 : 65;
    // Quanto mais gasto sem venda, mais agressiva a redução
    const reduce_pct = metrics.spend >= 10 ? 20 : metrics.spend >= 5 ? 15 : 10;
    return { classification: 'waste', confidence, recommended_action: 'reduce', reduce_pct, increase_pct: 0, notes };
  }

  // Alta conversão: tem venda, ACoS na meta
  if (hasConversion && metrics.acos > 0 && metrics.acos <= cfg.target_acos * 1.05) {
    notes.push(`${metrics.orders} pedidos com ACoS ${metrics.acos.toFixed(1)}% (meta: ${cfg.target_acos}%)`);
    const confidence = metrics.orders >= 3 ? 92 : metrics.orders >= 2 ? 85 : 78;
    const increase_pct = metrics.acos <= cfg.target_acos * 0.7 ? 10 : 5;
    // Bloco candidato a escalar se tem margem
    const cls = metrics.orders >= 2 && metrics.acos <= cfg.target_acos * 0.8 ? 'scale_candidate' : 'high_conversion';
    return { classification: cls, confidence, recommended_action: 'increase', reduce_pct: 0, increase_pct, notes };
  }

  // Volume eficiente: alto volume, CPC aceitável
  if (metrics.impressions >= cfg.min_impressions * 2 && cpcOk && metrics.acos <= cfg.max_acos) {
    notes.push(`Volume eficiente: ${metrics.impressions} impressões, CPC R$${metrics.cpc.toFixed(2)}`);
    return { classification: 'efficient_volume', confidence: 70, recommended_action: 'hold', reduce_pct: 0, increase_pct: 0, notes };
  }

  // Proteger budget: bloco consome muito sem ser eficiente
  if (hasSpend && metrics.acos > cfg.max_acos && hasConversion) {
    notes.push(`ACoS ${metrics.acos.toFixed(1)}% > máximo ${cfg.max_acos}% — proteger orçamento`);
    return { classification: 'protect_budget', confidence: 75, recommended_action: 'reduce', reduce_pct: 10, increase_pct: 0, notes };
  }

  return { classification: 'low_data', confidence: 50, recommended_action: 'observe', reduce_pct: 0, increase_pct: 0, notes: ['Sem padrão claro'] };
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    if (!body._service_role) {
      const auth = await base44.auth.isAuthenticated().catch(() => false);
      if (!auth) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    let amazonAccountId = body.amazon_account_id;
    if (!amazonAccountId) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      if (!accs.length) return Response.json({ ok: false, error: 'Nenhuma conta conectada' });
      amazonAccountId = accs[0].id;
    }

    // ── 1. Carregar configuração ──────────────────────────────────────────
    const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: amazonAccountId });
    const cfg = configs[0] || {};

    if (cfg.dayparting_enabled === false) {
      return Response.json({ ok: true, skipped: true, reason: 'Dayparting desabilitado na configuração' });
    }

    const TARGET_ACOS = safe(cfg.target_acos || cfg.acos_target || 25);
    const MAX_ACOS = safe(cfg.maximum_acos || 40);
    const TARGET_ROAS = safe(cfg.target_roas || 4);
    const TARGET_CPC = safe(cfg.target_cpc || 0);
    const MAX_CPC = safe(cfg.maximum_cpc || 0);
    const MIN_BID = safe(cfg.min_bid || 0.10);
    const MAX_BID = safe(cfg.max_bid || 5.0);
    const AUTONOMY = safe(cfg.autonomy_level ?? 2);
    const MIN_IMPRESSIONS = safe(cfg.min_clicks_per_time_block ? cfg.min_clicks_per_time_block * 10 : 100);
    const MIN_CLICKS = safe(cfg.min_clicks_per_time_block || 10);

    const today = todayStr();
    const yesterday = daysAgoStr(1);

    // ── 2. Carregar HourlyMetric (últimos 14 dias fechados) ───────────────
    const hourlyRaw = await base44.asServiceRole.entities.HourlyMetric.filter(
      { amazon_account_id: amazonAccountId }, '-date', 1000
    );
    // Excluir hoje (dados parciais)
    const closedHourly = hourlyRaw.filter((h: Record<string, unknown>) => {
      const d = String(h.date || '');
      return d < today && d >= daysAgoStr(14);
    });

    // Deduplicar por campaign_id + date + hour
    const hourlyDedupe = new Map<string, Record<string, unknown>>();
    for (const h of closedHourly) {
      const k = `${h.campaign_id}|${h.date}|${h.hour}`;
      if (!hourlyDedupe.has(k)) hourlyDedupe.set(k, h);
    }
    const hourly = Array.from(hourlyDedupe.values());

    if (hourly.length === 0) {
      return Response.json({ ok: true, skipped: true, reason: 'Sem dados horários para análise' });
    }

    // ── 3. Carregar keywords ativas ───────────────────────────────────────
    const keywords = await base44.asServiceRole.entities.Keyword.filter(
      { amazon_account_id: amazonAccountId }, '-spend', 500
    );
    const activeKeywords = keywords.filter((k: Record<string, unknown>) => {
      const st = String(k.state || k.status || '').toLowerCase();
      return st === 'enabled';
    });

    // ── 4. Carregar estoque ───────────────────────────────────────────────
    const products = await base44.asServiceRole.entities.Product.filter(
      { amazon_account_id: amazonAccountId }, null, 200
    );
    const productMap = new Map(products.map((p: Record<string, unknown>) => [String(p.asin || ''), p]));

    // ── 5. Agregar métricas por bloco horário ─────────────────────────────
    const blockData: Record<string, {
      block_name: string; start_hour: number; end_hour: number;
      impressions: number; clicks: number; spend: number; orders: number; sales: number;
      days_with_data: number; day_set: Set<string>;
    }> = {};

    for (const block of HOUR_BLOCKS) {
      blockData[block.name] = {
        block_name: block.name, start_hour: block.start, end_hour: block.end,
        impressions: 0, clicks: 0, spend: 0, orders: 0, sales: 0,
        days_with_data: 0, day_set: new Set(),
      };
    }

    for (const h of hourly) {
      const hour = safe(h.hour);
      const block = getBlock(hour);
      const bd = blockData[block.name];
      bd.impressions += safe(h.impressions);
      bd.clicks += safe(h.clicks);
      bd.spend += safe(h.spend);
      bd.orders += safe(h.orders);
      bd.sales += safe(h.sales);
      bd.day_set.add(String(h.date || ''));
    }
    for (const b of Object.values(blockData)) {
      b.days_with_data = b.day_set.size;
    }

    // ── 6. Classificar blocos ─────────────────────────────────────────────
    const classifiedBlocks = Object.values(blockData).map(bd => {
      const acos = safeDiv(bd.spend, bd.sales) * 100;
      const roas = safeDiv(bd.sales, bd.spend);
      const cpc = safeDiv(bd.spend, bd.clicks);
      const ctr = safeDiv(bd.clicks, bd.impressions) * 100;
      const cvr = safeDiv(bd.orders, bd.clicks) * 100;

      const metrics = { impressions: bd.impressions, clicks: bd.clicks, spend: bd.spend, orders: bd.orders, sales: bd.sales, acos, roas, cpc, ctr, cvr, days_with_data: bd.days_with_data };
      const cfgBlock = { target_acos: TARGET_ACOS, max_acos: MAX_ACOS, target_roas: TARGET_ROAS, target_cpc: TARGET_CPC, max_cpc: MAX_CPC, min_impressions: MIN_IMPRESSIONS, min_clicks: MIN_CLICKS };
      const result = classifyBlock(metrics, cfgBlock);

      return {
        block_name: bd.block_name,
        start_hour: bd.start_hour,
        end_hour: bd.end_hour,
        days_with_data: bd.days_with_data,
        ...metrics,
        ...result,
      };
    });

    // ── 7. Gerar ações de dayparting para AmazonActionQueue ───────────────
    const enqueued: unknown[] = [];
    const skipped: unknown[] = [];
    const blockClassifications: unknown[] = classifiedBlocks;

    // Idempotency: não criar ação duplicada no mesmo dia + bloco + keyword
    const existingActions = await base44.asServiceRole.entities.AmazonActionQueue.filter(
      { amazon_account_id: amazonAccountId }, '-created_date', 200
    );
    const usedKeys = new Set(existingActions.map((a: Record<string, unknown>) => String(a.idempotency_key || '')));

    for (const block of classifiedBlocks) {
      if (block.recommended_action === 'observe' || block.recommended_action === 'hold') continue;
      if (block.confidence < 70) { skipped.push({ block: block.block_name, reason: `confidence ${block.confidence} < 70` }); continue; }

      for (const kw of activeKeywords.slice(0, 100)) { // limitar para evitar timeout
        const kwCampaignId = String(kw.campaign_id || '');
        const kwKeywordId = String(kw.keyword_id || kw.id || '');
        const asin = String(kw.asin || '');
        const currentBid = safe(kw.current_bid || kw.bid || 0.25);

        // Verificar estoque
        const product = asin ? productMap.get(asin) : null;
        if (product && String(product.inventory_status || '') === 'out_of_stock') continue;

        let newBid = currentBid;
        let actionType = '';
        const confidence = block.confidence;

        if (block.recommended_action === 'reduce' && block.reduce_pct > 0) {
          const reducePct = block.reduce_pct / 100;
          newBid = Math.max(currentBid * (1 - reducePct), MIN_BID);
          actionType = 'daypart_bid_decrease';
        } else if (block.recommended_action === 'increase' && block.increase_pct > 0) {
          if (confidence < 90) { skipped.push({ block: block.block_name, kw: kwKeywordId, reason: `confidence ${confidence} < 90 para aumento` }); continue; }
          const increasePct = block.increase_pct / 100;
          newBid = Math.min(currentBid * (1 + increasePct), MAX_BID);
          actionType = 'daypart_bid_increase';
        } else {
          continue;
        }

        if (Math.abs(newBid - currentBid) < 0.01) continue; // mudança insignificante

        const iKey = `daypart|${amazonAccountId}|${kwKeywordId}|${block.block_name}|${today}|${actionType}`;
        if (usedKeys.has(iKey)) continue;

        // Para ação automática: exige confidence >= 90
        const autoExecute = AUTONOMY >= 2 && confidence >= 90;

        await base44.asServiceRole.entities.AmazonActionQueue.create({
          amazon_account_id: amazonAccountId,
          operation: actionType,
          entity_type: 'keyword',
          entity_id: kwKeywordId,
          campaign_id: kwCampaignId,
          keyword_id: kwKeywordId,
          payload: JSON.stringify({
            bid: Number(newBid.toFixed(2)),
            bid_before: currentBid,
            block: block.block_name,
            start_hour: block.start_hour,
            end_hour: block.end_hour,
            classification: block.classification,
            notes: block.notes,
          }),
          idempotency_key: iKey,
          scheduled_at: new Date().toISOString(),
          priority: block.recommended_action === 'reduce' ? 2 : 3,
          confidence: Math.round(confidence),
          status: autoExecute ? 'approved' : 'pending',
          source_function: 'runDaypartDecisionEngine',
          expected_impact: block.notes.join(' | '),
          created_at: new Date().toISOString(),
        }).catch(() => {});

        enqueued.push({ block: block.block_name, kw: kwKeywordId, actionType, bid_before: currentBid, bid_after: Number(newBid.toFixed(2)), confidence });
      }
    }

    return Response.json({
      ok: true,
      blocks_analyzed: classifiedBlocks.length,
      blocks_with_action: classifiedBlocks.filter(b => b.recommended_action !== 'observe' && b.recommended_action !== 'hold').length,
      actions_enqueued: enqueued.length,
      actions_skipped: skipped.length,
      block_classifications: blockClassifications,
      duration_ms: Date.now() - startTime,
    });

  } catch (error) {
    return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
});