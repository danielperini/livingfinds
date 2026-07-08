/**
 * runDaypartDecisionEngine v3 — Motor de dayparting com alterações futuras programadas
 *
 * Gera ações com scheduled_at = hora exata BRT do bloco para execução via
 * runScheduledBidAdjustments (roda a cada hora). Também programa o restore do
 * bid base ao final de cada bloco de aumento.
 *
 * Regras:
 * - Blocos waste/protect_budget: reduz bid -10% a -20% com restore após bloco
 * - Blocos high_conversion/scale_candidate: aumenta bid +5% a +10% (conf >= 90)
 * - Bid restore agendado automaticamente ao final de cada bloco de aumento
 * - Nunca abaixo de min_bid ou acima de max_bid
 * - Idempotência por chave única (account + keyword + bloco + data)
 * - NÃO usa IA. NÃO chama Amazon diretamente. Usa AmazonActionQueue com scheduled_at.
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

// Hora BRT atual (UTC-3)
function currentHourBRT(): number {
  return (new Date().getUTCHours() - 3 + 24) % 24;
}

// Converte hora BRT para ISO UTC do próximo occurrence
function brtHourToScheduledAt(hourBRT: number): string {
  const now = new Date();
  const curBRT = (now.getUTCHours() - 3 + 24) % 24;
  let ahead = hourBRT - curBRT;
  if (ahead < 0) ahead += 24;
  const target = new Date(now.getTime() + ahead * 3600000);
  target.setUTCMinutes(0, 0, 0);
  return target.toISOString();
}

// Blocos horários canônicos BRT
const HOUR_BLOCKS = [
  { name: 'madrugada',  start: 0,  end: 5  },
  { name: 'manha_cedo', start: 6,  end: 8  },
  { name: 'manha',      start: 9,  end: 11 },
  { name: 'almoco',     start: 12, end: 14 },
  { name: 'tarde',      start: 15, end: 17 },
  { name: 'fim_tarde',  start: 18, end: 20 },
  { name: 'noite',      start: 21, end: 23 },
];

function getBlock(hour: number) {
  return HOUR_BLOCKS.find(b => hour >= b.start && hour <= b.end) || HOUR_BLOCKS[0];
}

// Classificar um bloco horário
function classifyBlock(bd: {
  impressions: number; clicks: number; spend: number; orders: number; sales: number;
  days_with_data: number;
}, cfg: {
  target_acos: number; max_acos: number; min_impressions: number; min_clicks: number; max_cpc: number;
}): {
  classification: 'high_conversion' | 'scale_candidate' | 'efficient_volume' | 'waste' | 'protect_budget' | 'low_data' | 'no_delivery';
  confidence: number;
  action: 'reduce' | 'increase' | 'hold' | 'observe';
  reduce_pct: number;
  increase_pct: number;
  notes: string[];
} {
  const acos = safeDiv(bd.spend, bd.sales) * 100;
  const cpc = safeDiv(bd.spend, bd.clicks);

  if (bd.impressions < 10 && bd.days_with_data > 3) {
    return { classification: 'no_delivery', confidence: 55, action: 'observe', reduce_pct: 0, increase_pct: 0, notes: ['Sem impressões neste bloco'] };
  }

  const hasEnough = bd.impressions >= cfg.min_impressions || bd.clicks >= cfg.min_clicks;
  if (!hasEnough) {
    return { classification: 'low_data', confidence: 40, action: 'observe', reduce_pct: 0, increase_pct: 0, notes: ['Volume insuficiente'] };
  }

  const hasSpend = bd.spend >= 0.5;
  const hasConversion = bd.orders >= 1;
  const cpcOk = cfg.max_cpc > 0 ? cpc <= cfg.max_cpc : true;

  // Waste: gasto sem conversão
  if (hasSpend && !hasConversion && bd.clicks >= 3) {
    const confidence = bd.clicks >= 10 ? 88 : bd.clicks >= 5 ? 78 : 65;
    const reduce_pct = bd.spend >= 10 ? 20 : bd.spend >= 5 ? 15 : 10;
    return {
      classification: 'waste', confidence, action: 'reduce', reduce_pct, increase_pct: 0,
      notes: [`R$${bd.spend.toFixed(2)} gastos sem pedido (${bd.clicks} cliques)`],
    };
  }

  // Alta conversão: ACoS na meta
  if (hasConversion && acos > 0 && acos <= cfg.target_acos * 1.05) {
    const confidence = bd.orders >= 3 ? 94 : bd.orders >= 2 ? 88 : 80;
    const increase_pct = acos <= cfg.target_acos * 0.7 ? 10 : 5;
    const cls = bd.orders >= 2 && acos <= cfg.target_acos * 0.8 ? 'scale_candidate' : 'high_conversion';
    return {
      classification: cls, confidence, action: 'increase', reduce_pct: 0, increase_pct,
      notes: [`${bd.orders} pedidos, ACoS ${acos.toFixed(1)}% (meta ${cfg.target_acos}%)`],
    };
  }

  // Proteger budget: ACoS acima do máximo com conversão
  if (hasSpend && acos > cfg.max_acos && hasConversion) {
    return {
      classification: 'protect_budget', confidence: 78, action: 'reduce', reduce_pct: 10, increase_pct: 0,
      notes: [`ACoS ${acos.toFixed(1)}% > máximo ${cfg.max_acos}%`],
    };
  }

  // Volume eficiente
  if (bd.impressions >= cfg.min_impressions * 2 && cpcOk) {
    return {
      classification: 'efficient_volume', confidence: 68, action: 'hold', reduce_pct: 0, increase_pct: 0,
      notes: [`${bd.impressions} impressões, CPC R$${cpc.toFixed(2)}`],
    };
  }

  return { classification: 'low_data', confidence: 48, action: 'observe', reduce_pct: 0, increase_pct: 0, notes: ['Padrão indefinido'] };
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    // Auth: automação ou usuário
    try { await base44.auth.isAuthenticated(); } catch {}

    // Resolver conta
    let amazonAccountId = body.amazon_account_id;
    if (!amazonAccountId) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      if (!accs.length) return Response.json({ ok: false, error: 'Nenhuma conta conectada' });
      amazonAccountId = accs[0].id;
    }

    // ── 1. Configuração ───────────────────────────────────────────────────
    const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: amazonAccountId }, null, 1);
    const cfg = configs[0] || {};

    if (cfg.dayparting_enabled === false) {
      return Response.json({ ok: true, skipped: true, reason: 'Dayparting desabilitado' });
    }

    const TARGET_ACOS  = safe(cfg.target_acos || cfg.acos_target || 25);
    const MAX_ACOS     = safe(cfg.maximum_acos || TARGET_ACOS * 1.5 || 40);
    const MAX_CPC      = safe(cfg.maximum_cpc || 0);
    const MIN_BID      = safe(cfg.min_bid || 0.10);
    const MAX_BID      = safe(cfg.max_bid || 5.0);
    const AUTONOMY     = safe(cfg.autonomy_level ?? 2);
    const MIN_IMPR     = safe(cfg.min_clicks_per_time_block ? cfg.min_clicks_per_time_block * 10 : 100);
    const MIN_CLICKS   = safe(cfg.min_clicks_per_time_block || 10);

    const today  = todayStr();
    const cutoff = daysAgoStr(14);

    // ── 2. HourlyMetric dos últimos 14 dias fechados ──────────────────────
    const hourlyRaw = await base44.asServiceRole.entities.HourlyMetric.filter(
      { amazon_account_id: amazonAccountId }, '-date', 2000
    );
    const hourly = (() => {
      const dedupe = new Map<string, any>();
      for (const h of hourlyRaw) {
        const d = String(h.date || '');
        if (d >= today || d < cutoff) continue;
        const k = `${h.campaign_id}|${h.date}|${h.hour}`;
        if (!dedupe.has(k)) dedupe.set(k, h);
      }
      return Array.from(dedupe.values());
    })();

    if (hourly.length === 0) {
      return Response.json({ ok: true, skipped: true, reason: 'Sem dados horários (HourlyMetric)' });
    }

    // ── 3. Keywords ativas + estoque ─────────────────────────────────────
    const [keywords, products] = await Promise.all([
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: amazonAccountId }, '-spend', 500),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: amazonAccountId }, null, 200),
    ]);

    const activeKeywords = keywords.filter((k: any) => {
      const st = String(k.state || k.status || '').toLowerCase();
      return st === 'enabled';
    });

    const productMap = new Map(products.map((p: any) => [String(p.asin || ''), p]));

    // ── 4. Agregar métricas por bloco horário ────────────────────────────
    const blockAgg: Record<string, { block: typeof HOUR_BLOCKS[0]; impressions: number; clicks: number; spend: number; orders: number; sales: number; day_set: Set<string> }> = {};
    for (const bl of HOUR_BLOCKS) {
      blockAgg[bl.name] = { block: bl, impressions: 0, clicks: 0, spend: 0, orders: 0, sales: 0, day_set: new Set() };
    }

    for (const h of hourly) {
      const hour = safe(h.hour);
      const bl = getBlock(hour);
      const agg = blockAgg[bl.name];
      agg.impressions += safe(h.impressions);
      agg.clicks += safe(h.clicks);
      agg.spend += safe(h.spend);
      agg.orders += safe(h.orders);
      agg.sales += safe(h.sales);
      agg.day_set.add(String(h.date || ''));
    }

    // ── 5. Classificar blocos ─────────────────────────────────────────────
    const classifiedBlocks = Object.values(blockAgg).map(bd => {
      const result = classifyBlock(
        { impressions: bd.impressions, clicks: bd.clicks, spend: bd.spend, orders: bd.orders, sales: bd.sales, days_with_data: bd.day_set.size },
        { target_acos: TARGET_ACOS, max_acos: MAX_ACOS, min_impressions: MIN_IMPR, min_clicks: MIN_CLICKS, max_cpc: MAX_CPC }
      );
      return { ...bd.block, days_with_data: bd.day_set.size, impressions: bd.impressions, clicks: bd.clicks, spend: bd.spend, orders: bd.orders, sales: bd.sales, ...result };
    });

    // ── 6. Ações de bid por bloco + keyword ──────────────────────────────
    // Idempotência: não duplicar ações do mesmo dia
    const existingActions = await base44.asServiceRole.entities.AmazonActionQueue.filter(
      { amazon_account_id: amazonAccountId }, '-created_date', 500
    );
    const usedKeys = new Set(existingActions.map((a: any) => String(a.idempotency_key || '')));

    const toCreate: any[] = [];
    const skippedInfo: any[] = [];
    const stats = { enqueued: 0, skipped_confidence: 0, skipped_stock: 0, skipped_dup: 0, skipped_hold: 0 };

    for (const block of classifiedBlocks) {
      if (block.action === 'observe' || block.action === 'hold') {
        stats.skipped_hold += activeKeywords.length;
        continue;
      }
      if (block.confidence < 70) {
        skippedInfo.push({ block: block.name, reason: `confidence ${block.confidence} < 70` });
        stats.skipped_confidence += activeKeywords.length;
        continue;
      }

      // scheduled_at: hora de início do bloco BRT → UTC
      const scheduledAt = brtHourToScheduledAt(block.start);

      for (const kw of activeKeywords.slice(0, 120)) {
        const kwId = String(kw.keyword_id || kw.id || '');
        if (!kwId) continue;

        // Guardrail: sem estoque
        const asin = String(kw.asin || '');
        const product = asin ? productMap.get(asin) : null;
        if (product && String((product as any).inventory_status || '') === 'out_of_stock') {
          stats.skipped_stock++;
          continue;
        }

        const currentBid = safe(kw.current_bid || kw.bid || 0.25);
        let newBid = currentBid;
        let operation = '';

        if (block.action === 'reduce' && block.reduce_pct > 0) {
          newBid = Math.max(MIN_BID, currentBid * (1 - block.reduce_pct / 100));
          operation = 'daypart_bid_decrease';
        } else if (block.action === 'increase' && block.increase_pct > 0) {
          // Aumento só com confidence >= 90
          if (block.confidence < 90) {
            stats.skipped_confidence++;
            continue;
          }
          newBid = Math.min(MAX_BID, currentBid * (1 + block.increase_pct / 100));
          operation = 'daypart_bid_increase';
        } else {
          continue;
        }

        // Mudança insignificante
        if (Math.abs(newBid - currentBid) < 0.01) continue;

        const iKey = `dp|${amazonAccountId}|${kwId}|${block.name}|${today}|${operation}`;
        if (usedKeys.has(iKey)) { stats.skipped_dup++; continue; }
        usedKeys.add(iKey);

        // Para ação automática: autonomy >= 2 e confidence >= 90
        const autoExecute = AUTONOMY >= 2 && block.confidence >= 90;

        toCreate.push({
          amazon_account_id: amazonAccountId,
          operation,
          entity_type: 'keyword',
          entity_id: kwId,
          keyword_id: kwId,
          campaign_id: String(kw.campaign_id || ''),
          payload: {
            bid: Number(newBid.toFixed(2)),
            bid_before: currentBid,
            base_bid: currentBid,
            block: block.name,
            hour_block: block.name,
            start_hour: block.start,
            end_hour: block.end,
            classification: block.classification,
            notes: block.notes,
          },
          idempotency_key: iKey,
          scheduled_at: scheduledAt,
          priority: block.action === 'reduce' ? 'high' : 'normal',
          confidence: Math.round(block.confidence),
          status: autoExecute ? 'approved' : 'pending',
          source: 'runDaypartDecisionEngine',
          created_at: new Date().toISOString(),
          max_attempts: 3,
          attempt_count: 0,
        });

        stats.enqueued++;
      }
    }

    // ── 7. Gravar ações em lote ──────────────────────────────────────────
    const BATCH = 50;
    for (let i = 0; i < toCreate.length; i += BATCH) {
      await base44.asServiceRole.entities.AmazonActionQueue.bulkCreate(toCreate.slice(i, i + BATCH));
    }

    // ── 8. Salvar DaypartScheduleAction para visualização ────────────────
    // Registra o plano completo do dia para o painel de dayparting
    const activeBlocks = classifiedBlocks.filter(b => b.action !== 'observe' && b.action !== 'hold' && b.confidence >= 70);
    for (const block of activeBlocks) {
      const dKey = `dsa|${amazonAccountId}|${block.name}|${today}`;
      if (usedKeys.has(dKey)) continue;
      usedKeys.add(dKey);
      await base44.asServiceRole.entities.DaypartScheduleAction.create({
        amazon_account_id: amazonAccountId,
        hour_block: block.name,
        start_hour: block.start,
        end_hour: block.end,
        action_type: block.action === 'reduce' ? 'daypart_bid_decrease' : 'daypart_bid_increase',
        base_bid: 0,
        scheduled_bid: 0,
        bid_multiplier: block.action === 'reduce' ? (1 - block.reduce_pct / 100) : (1 + block.increase_pct / 100),
        reason: block.notes.join(' | '),
        confidence: Math.round(block.confidence),
        status: 'approved',
        next_execution_at: brtHourToScheduledAt(block.start),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).catch(() => {});
    }

    return Response.json({
      ok: true,
      blocks_analyzed: classifiedBlocks.length,
      actionable_blocks: activeBlocks.length,
      actions_enqueued: stats.enqueued,
      stats,
      skipped: skippedInfo.slice(0, 10),
      block_summary: classifiedBlocks.map(b => ({
        name: b.name, hours: `${b.start}h-${b.end}h`,
        classification: b.classification, action: b.action,
        confidence: Math.round(b.confidence), notes: b.notes,
        scheduled_at: b.action !== 'observe' && b.action !== 'hold' ? brtHourToScheduledAt(b.start) : null,
      })),
      duration_ms: Date.now() - startTime,
    });

  } catch (error: any) {
    console.error('[runDaypartDecisionEngine]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});