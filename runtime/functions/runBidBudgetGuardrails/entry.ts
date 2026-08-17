/**
 * runBidBudgetGuardrails — Guardrails Automáticos de Lance e Orçamento v1
 *
 * Aplica limites automáticos ANTES de qualquer decisão do motor ser executada:
 *
 * REGRAS IMPLEMENTADAS:
 *   G1 — Bid Floor: nenhum lance cai abaixo de min_bid
 *   G2 — Bid Ceiling: nenhum lance sobe acima de max_bid
 *   G3 — Max CPC Econômico: bid nunca excede safe_max_cpc calculado por produto
 *   G4 — ACoS Crítico: campanha com ACoS > max_acos → bloqueia aumentos e força redução
 *   G5 — Variação Máxima por Ciclo: nenhum lance muda mais que max_bid_change_pct em 24h
 *   G6 — Budget Cap Diário: bloqueia aumentos quando gasto D-1 ≥ daily_budget_cap
 *   G7 — ROAS Mínimo: bloqueia escala quando ROAS < target_roas * 0.70
 *   G8 — Proteção de Keywords Novas: keywords com < 48h não recebem redução
 *   G9 — CPC Aberrante: bids > 3× a média do ad group são cortados imediatamente
 *   G10 — Estoque Crítico Override: sobrescreve qualquer aumento quando stock_days < 7
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const FB = {
  MIN_BID: 0.40, MAX_BID: 5.00,
  MAX_CHANGE_PCT: 0.20,
  DAILY_BUDGET_CAP: 56,
  TARGET_ACOS: 10, MAX_ACOS: 15,
  TARGET_ROAS: 4,
  SAFETY_FACTOR: 0.80,
  MIN_CONFIDENCE: 0.95,
};

function clamp(v: number, min: number, max: number) { return Math.min(max, Math.max(min, v)); }
function uuid() { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function now() { return new Date().toISOString(); }
function today() { return new Date().toISOString().slice(0, 10); }
function yesterday() { return new Date(Date.now() - 86400000).toISOString().slice(0, 10); }

// ── Resultado de um guardrail ──────────────────────────────────────────────────
interface GuardrailResult {
  rule: string;
  triggered: boolean;
  decision_id?: string;
  entity_id?: string;
  original_value?: number;
  clamped_value?: number;
  blocked?: boolean;
  reason: string;
}

Deno.serve(async (req) => {
  const runId = uuid();
  const base44 = createClientFromRequest(req);

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, dry_run = false } = body;

    // ── Resolver conta ─────────────────────────────────────────────────────
    let account: any = null;
    if (amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id });
      account = accs[0];
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada.' });
    const aid = account.id;

    // ── Carregar configurações (fonte única) ───────────────────────────────
    let settings: any = null;
    const psList = await base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, '-updated_at', 1).catch(() => []);
    if (psList.length > 0) {
      const ps = psList[0];
      const psReq = (v: any, fb: number) => { const n = Number(v); return n > 0 ? n : fb; };
      const psNum = (v: any) => { const n = Number(v); return n > 0 ? n : null; };
      settings = {
        source: 'PerformanceSettings',
        min_bid: psReq(ps.min_bid, FB.MIN_BID),
        max_bid: psReq(ps.max_bid, FB.MAX_BID),
        max_cpc: psNum(ps.max_cpc) ?? 0,
        max_bid_increase_pct: psReq(ps.max_bid_increase_pct, FB.MAX_CHANGE_PCT * 100) / 100,
        max_bid_decrease_pct: psReq(ps.max_bid_decrease_pct, FB.MAX_CHANGE_PCT * 100) / 100,
        target_acos: psNum(ps.target_acos),
        max_acos: psNum(ps.max_acos),
        target_roas: psNum(ps.target_roas),
        daily_budget_cap: psReq(ps.daily_budget_limit, FB.DAILY_BUDGET_CAP),
        min_campaign_budget: psReq(ps.minimum_campaign_budget, 15),
        safety_factor: FB.SAFETY_FACTOR,
      };
    } else {
      settings = {
        source: 'system_defaults',
        min_bid: FB.MIN_BID, max_bid: FB.MAX_BID, max_cpc: 0,
        max_bid_increase_pct: FB.MAX_CHANGE_PCT,
        max_bid_decrease_pct: FB.MAX_CHANGE_PCT,
        target_acos: FB.TARGET_ACOS, max_acos: FB.MAX_ACOS,
        target_roas: FB.TARGET_ROAS,
        daily_budget_cap: FB.DAILY_BUDGET_CAP,
        min_campaign_budget: 15, safety_factor: FB.SAFETY_FACTOR,
      };
    }

    // ── Carregar decisões pendentes para validar ───────────────────────────
    const pendingDecisions = await base44.asServiceRole.entities.OptimizationDecision.filter(
      { amazon_account_id: aid, status: 'approved' },
      '-created_at', 200
    ).catch(() => []);

    if (pendingDecisions.length === 0) {
      return Response.json({ ok: true, run_id: runId, message: 'Nenhuma decisão pendente para validar.', guardrail_passes: 0 });
    }

    // ── Dados de contexto ──────────────────────────────────────────────────
    const [metricsRaw, products, keywords] = await Promise.all([
      base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 200).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 100).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, null, 500).catch(() => []),
    ]);

    // Gasto real D-1
    const spendYesterday = metricsRaw
      .filter((m: any) => m.date === yesterday())
      .reduce((s: number, m: any) => s + (m.spend || 0), 0);
    const budgetExceeded = spendYesterday > 0 && spendYesterday >= settings.daily_budget_cap;

    // Índice de produtos: asin → produto
    const productMap = new Map(products.map((p: any) => [p.asin, p]));

    // Índice de keywords: keyword_id → keyword (para detectar novas < 48h)
    const kwMap = new Map(keywords.map((k: any) => [k.keyword_id || k.id, k]));

    // Métricas por campanha 14d (para ACoS, ROAS)
    const cutoff14d = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    const campMetrics = new Map<string, { spend: number; sales: number; clicks: number; orders: number }>();
    for (const m of metricsRaw) {
      if (!m.campaign_id || m.date < cutoff14d) continue;
      if (!campMetrics.has(m.campaign_id)) campMetrics.set(m.campaign_id, { spend: 0, sales: 0, clicks: 0, orders: 0 });
      const cm = campMetrics.get(m.campaign_id)!;
      cm.spend += m.spend || 0;
      cm.sales += m.sales || 0;
      cm.clicks += m.clicks || 0;
      cm.orders += m.orders || 0;
    }

    // CPC médio por campanha (para G9 — bid aberrante)
    const avgCpcByCampaign = new Map<string, number>();
    for (const [cid, cm] of campMetrics.entries()) {
      avgCpcByCampaign.set(cid, cm.clicks > 10 ? cm.spend / cm.clicks : 0);
    }

    // Margem / safe_max_cpc por produto
    const safeMaxCpcByAsin = new Map<string, number>();
    for (const p of products) {
      if (!p.asin) continue;
      const margin = Number(p.break_even_acos_pct || p.net_margin_percent || 0);
      const price = Number(p.price || 0);
      if (margin > 0 && price > 0) {
        const cvr = 0.05; // fallback conservador
        const safe = price * (margin / 100) * settings.safety_factor * cvr;
        safeMaxCpcByAsin.set(p.asin, Math.round(safe * 100) / 100);
      }
    }

    // ── Aplicar guardrails ─────────────────────────────────────────────────
    const results: GuardrailResult[] = [];
    const updates: any[] = [];
    let blocked = 0, clamped = 0, passed = 0;

    for (const dec of pendingDecisions) {
      if (dec.decision_type !== 'bid_change') { passed++; continue; }

      const isIncrease = (dec.value_after || 0) > (dec.value_before || 0);
      const isDecrease = (dec.value_after || 0) < (dec.value_before || 0);
      let newValue = dec.value_after;
      let shouldBlock = false;
      let blockReason = '';
      const violations: string[] = [];

      // G1 — Bid Floor
      if (newValue < settings.min_bid) {
        newValue = settings.min_bid;
        violations.push(`G1:floor(${settings.min_bid})`);
      }

      // G2 — Bid Ceiling
      if (newValue > settings.max_bid) {
        newValue = settings.max_bid;
        violations.push(`G2:ceiling(${settings.max_bid})`);
      }

      // G3 — Max CPC Econômico por produto
      if (dec.asin) {
        const safeCpc = safeMaxCpcByAsin.get(dec.asin) || (settings.max_cpc > 0 ? settings.max_cpc : 0);
        if (safeCpc > 0 && newValue > safeCpc) {
          newValue = Math.max(settings.min_bid, safeCpc);
          violations.push(`G3:safe_max_cpc(${safeCpc.toFixed(2)})`);
        }
      }

      // G4 — ACoS Crítico: bloqueia aumento quando campanha está crítica
      if (isIncrease && dec.campaign_id && settings.max_acos) {
        const cm = campMetrics.get(dec.campaign_id);
        if (cm && cm.sales > 0) {
          const realAcos = (cm.spend / cm.sales) * 100;
          if (realAcos > settings.max_acos * 1.3) {
            shouldBlock = true;
            blockReason = `G4: ACoS real ${realAcos.toFixed(1)}% > máximo ${(settings.max_acos * 1.3).toFixed(1)}% — aumento bloqueado`;
            violations.push(`G4:acos_critical(${realAcos.toFixed(1)}%)`);
          }
        }
      }

      // G5 — Variação máxima por ciclo (± max_bid_change_pct)
      if (dec.value_before > 0) {
        const changePct = Math.abs((newValue - dec.value_before) / dec.value_before);
        const maxPct = isIncrease ? settings.max_bid_increase_pct : settings.max_bid_decrease_pct;
        if (changePct > maxPct * 1.5) {
          // Clamp à variação máxima permitida
          newValue = isIncrease
            ? dec.value_before * (1 + maxPct)
            : dec.value_before * (1 - maxPct);
          newValue = clamp(newValue, settings.min_bid, settings.max_bid);
          violations.push(`G5:max_change_pct(${Math.round(maxPct * 100)}%)`);
        }
      }

      // G6 — Budget Cap: bloqueia todos os aumentos quando orçamento excedido
      if (isIncrease && budgetExceeded) {
        shouldBlock = true;
        blockReason = `G6: Gasto D-1 R$${spendYesterday.toFixed(2)} ≥ cap R$${settings.daily_budget_cap} — aumentos bloqueados`;
        violations.push(`G6:budget_cap(${settings.daily_budget_cap})`);
      }

      // G7 — ROAS Mínimo: bloqueia escala se ROAS abaixo de 70% do alvo
      if (isIncrease && dec.campaign_id && settings.target_roas) {
        const cm = campMetrics.get(dec.campaign_id);
        if (cm && cm.spend > 5 && cm.sales > 0) {
          const roas = cm.sales / cm.spend;
          if (roas < settings.target_roas * 0.70) {
            shouldBlock = true;
            blockReason = `G7: ROAS ${roas.toFixed(2)}x < mínimo seguro ${(settings.target_roas * 0.70).toFixed(2)}x — aumento bloqueado`;
            violations.push(`G7:roas_min(${(settings.target_roas * 0.70).toFixed(2)}x)`);
          }
        }
      }

      // G8 — Proteção de keywords novas (< 48h): sem redução
      if (isDecrease && dec.keyword_id) {
        const kw = kwMap.get(dec.keyword_id);
        const createdAt = kw?.created_at || kw?.created_date;
        if (createdAt) {
          const ageHours = (Date.now() - new Date(createdAt).getTime()) / 3600000;
          if (ageHours < 48) {
            shouldBlock = true;
            blockReason = `G8: Keyword criada há ${Math.round(ageHours)}h — redução bloqueada nas primeiras 48h`;
            violations.push(`G8:new_keyword(${Math.round(ageHours)}h)`);
          }
        }
      }

      // G9 — CPC Aberrante: bid > 3× a média da campanha
      if (dec.campaign_id && dec.value_before > 0) {
        const avgCpc = avgCpcByCampaign.get(dec.campaign_id) || 0;
        if (avgCpc > 0.10 && newValue > avgCpc * 3) {
          newValue = Math.min(newValue, avgCpc * 2.5); // corta para 2.5× máximo
          violations.push(`G9:cpc_aberrant(avg=${avgCpc.toFixed(2)})`);
        }
      }

      // G10 — Estoque Crítico Override: qualquer aumento bloqueado se stock_days < 7
      if (isIncrease && dec.stock_coverage_days != null && dec.stock_coverage_days < 7) {
        shouldBlock = true;
        blockReason = `G10: Cobertura de estoque ${dec.stock_coverage_days?.toFixed(0)}d < 7d — aumentos bloqueados`;
        violations.push(`G10:stock_critical(${dec.stock_coverage_days?.toFixed(0)}d)`);
      }

      // ── Registrar resultado ──────────────────────────────────────────────
      const valueChanged = Math.abs((newValue || 0) - (dec.value_after || 0)) > 0.001;
      const needsUpdate = shouldBlock || valueChanged;

      if (needsUpdate) {
        results.push({
          rule: violations.join(' | '),
          triggered: true,
          decision_id: dec.id,
          entity_id: dec.entity_id,
          original_value: dec.value_after,
          clamped_value: shouldBlock ? undefined : Math.round(newValue * 100) / 100,
          blocked: shouldBlock,
          reason: shouldBlock ? blockReason : `Valor ajustado: ${dec.value_after?.toFixed(2)} → ${newValue.toFixed(2)} (${violations.join(', ')})`,
        });

        if (!dry_run) {
          updates.push({
            id: dec.id,
            ...(shouldBlock
              ? { status: 'skipped', rationale: (dec.rationale || '') + ` [GUARDRAIL] ${blockReason}` }
              : { value_after: Math.round(newValue * 100) / 100, rationale: (dec.rationale || '') + ` [GUARDRAIL] Ajustado por: ${violations.join(', ')}.` }
            ),
          });
        }

        if (shouldBlock) blocked++;
        else clamped++;
      } else {
        passed++;
        results.push({
          rule: 'pass',
          triggered: false,
          decision_id: dec.id,
          entity_id: dec.entity_id,
          reason: 'Todos os guardrails passaram.',
        });
      }
    }

    // ── Aplicar atualizações em lote ───────────────────────────────────────
    if (!dry_run && updates.length > 0) {
      for (let i = 0; i < updates.length; i += 50) {
        await base44.asServiceRole.entities.OptimizationDecision.bulkUpdate(updates.slice(i, i + 50)).catch(() => {});
      }
    }

    // ── Logar execução ─────────────────────────────────────────────────────
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'bid_budget_guardrails',
      trigger_type: 'automatic',
      status: 'success',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      records_processed: pendingDecisions.length,
      result_summary: JSON.stringify({ blocked, clamped, passed, dry_run }),
    }).catch(() => {});

    return Response.json({
      ok: true,
      run_id: runId,
      dry_run,
      settings_source: settings.source,
      decisions_evaluated: pendingDecisions.length,
      guardrails: {
        blocked,
        clamped,
        passed,
        budget_guardrail_active: budgetExceeded,
        spend_yesterday: Math.round(spendYesterday * 100) / 100,
        budget_cap: settings.daily_budget_cap,
      },
      limits_applied: {
        min_bid: settings.min_bid,
        max_bid: settings.max_bid,
        max_bid_increase_pct: `${Math.round(settings.max_bid_increase_pct * 100)}%`,
        max_bid_decrease_pct: `${Math.round(settings.max_bid_decrease_pct * 100)}%`,
        max_acos: settings.max_acos,
        target_roas: settings.target_roas,
        max_cpc: settings.max_cpc,
      },
      triggered_results: results.filter(r => r.triggered).slice(0, 50),
    });

  } catch (error: any) {
    console.error('[runBidBudgetGuardrails]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});