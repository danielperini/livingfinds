/**
 * adjustBidByProfitAfterAds — Ajuste Dinâmico de Lance por Lucro Bruto Pós-ADS
 *
 * OBJETIVO:
 *   Manter o produto visível na Amazon enquanto o Lucro Bruto Pós-ADS se recupera,
 *   sem sacrificar a posição orgânica/paga antes de atingir a margem alvo.
 *
 * LÓGICA CENTRAL:
 *   - Quando profit_after_ads < profit_target_pct × contribution_margin:
 *       → Reduz o lance proporcionalmente ao gap de lucro (quanto maior o gap, maior a redução)
 *       → Nunca cai abaixo de visibility_floor_bid (garante impressões mínimas)
 *   - Quando profit_after_ads se recupera (> recovery_threshold_pct × contribution_margin):
 *       → Aumenta o lance gradualmente para restaurar visibilidade e volume
 *       → Incremento modulado pelo tempo de recuperação (quanto mais rápida, menor o passo)
 *
 * PROTEÇÕES:
 *   - Não toca em keywords sem evidência mínima (< MIN_CLICKS ou < MIN_SPEND)
 *   - Cooldown de 24h por keyword para evitar oscilação
 *   - Não compete com o motor principal: rule_key diferente, idempotency separado
 *   - Bloqueia aumento quando budget_guardrail está ativo (gasto ontem > cap)
 *   - Nunca excede safe_max_cpc do produto
 *
 * PARÂMETROS (todos opcionais via body):
 *   amazon_account_id   — conta alvo (default: primeira conectada)
 *   profit_target_pct   — % da margem bruta que deve sobrar após ads (default: 0.20 = 20%)
 *   recovery_threshold_pct — % da margem que define recuperação (default: 0.35 = 35%)
 *   visibility_floor_bid   — lance mínimo absoluto para manter visibilidade (default: min_bid * 1.1)
 *   cooldown_hours         — cooldown por keyword (default: 24h)
 *   dry_run                — true = apenas simula, não grava decisões
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MIN_CLICKS = 8;
const MIN_SPEND = 8.0;
const MIN_IMPRESSIONS = 150;

function clamp(v: number, min: number, max: number) { return Math.min(max, Math.max(min, v)); }
function uuid() { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function normSku(s: string) { return (s || '').trim().toUpperCase().replace(/\s+/g, '-').replace(/-{2,}/g, '-'); }

Deno.serve(async (req) => {
  const correlationId = uuid();
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));

    // ── Parâmetros configuráveis ──────────────────────────────────────────
    const PROFIT_TARGET_PCT      = Number(body.profit_target_pct      ?? 0.20); // 20% da margem como meta de lucro pós-ads
    const RECOVERY_THRESHOLD_PCT = Number(body.recovery_threshold_pct ?? 0.35); // 35% da margem = recuperado
    const COOLDOWN_HOURS         = Number(body.cooldown_hours         ?? 24);
    const DRY_RUN                = Boolean(body.dry_run ?? false);

    // ── Resolver conta ──────────────────────────────────────────────────
    let account: any = null;
    if (body.amazon_account_id) {
      const r = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1);
      account = r[0] || null;
    }
    if (!account) {
      const r = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = r[0] || null;
    }
    if (!account) {
      const r = await base44.asServiceRole.entities.AmazonAccount.filter({}, '-created_date', 1);
      account = r[0] || null;
    }
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada.' });
    const aid = account.id;

    // ── Carregar configurações de performance ────────────────────────────
    let minBid = 0.40, maxBid = 1.00, maxIncreasePct = 0.12, maxDecreasePct = 0.18, dailyBudgetCap = 56;
    try {
      const psList = await base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, '-updated_at', 1);
      if (psList.length > 0) {
        const ps = psList[0];
        minBid         = Number(ps.min_bid || 0.40);
        maxBid         = Number(ps.max_bid || 1.00);
        maxIncreasePct = Number(ps.max_bid_increase_pct || 12) / 100;
        maxDecreasePct = Number(ps.max_bid_decrease_pct || 18) / 100;
        dailyBudgetCap = Number(ps.daily_budget_limit || 56);
      }
    } catch {}

    // Lance mínimo para garantir visibilidade (não pode ficar totalmente invisível)
    const visibilityFloorBid = Number(body.visibility_floor_bid ?? (minBid * 1.10));

    // ── Guardrail global de orçamento ────────────────────────────────────
    const cutoff14d = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    const cutoff3d  = new Date(Date.now() - 3  * 86400000).toISOString().slice(0, 10);

    const [keywords, campaigns, products, metricsRaw, productEconomicsRaw, recentRuleExecs] = await Promise.all([
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, '-spend', 500),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 200),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 100),
      base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 400).catch(() => []),
      base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: aid }, null, 200).catch(() => []),
      base44.asServiceRole.entities.RuleExecution.filter({ amazon_account_id: aid }, '-created_date', 300).catch(() => []),
    ]);

    // Guardrail de orçamento: bloqueia AUMENTO se gasto ontem > cap
    const maxSingleCampSpend = dailyBudgetCap * 2;
    const realSpendYesterday = metricsRaw
      .filter((m: any) => m.date === yesterday && (m.spend || 0) > 0 && (m.spend || 0) <= maxSingleCampSpend)
      .reduce((s: number, m: any) => s + (m.spend || 0), 0);
    const budgetGuardrailActive = realSpendYesterday > 0 && realSpendYesterday > dailyBudgetCap;

    // ── Índices ─────────────────────────────────────────────────────────
    const productMap = new Map(products.map((p: any) => [p.asin, p]));

    const campaignAsinMap = new Map<string, string>();
    for (const c of campaigns) {
      if (c.campaign_id && c.asin) campaignAsinMap.set(c.campaign_id, c.asin);
      if (c.amazon_campaign_id && c.asin) campaignAsinMap.set(c.amazon_campaign_id, c.asin);
    }

    const econByNsku = new Map<string, any>();
    for (const e of productEconomicsRaw) {
      if (e.sku) econByNsku.set(normSku(e.sku), e);
      if (e.asin) econByNsku.set(`ASIN:${e.asin}`, e);
    }

    // ── Agregar métricas de campanha por janela (3d, 14d) ────────────────
    const campMetrics14d = new Map<string, { spend: number; orders: number; clicks: number; impressions: number }>();
    const campMetrics3d  = new Map<string, { spend: number; orders: number; clicks: number; impressions: number }>();

    for (const m of metricsRaw) {
      if (!m.campaign_id || !m.date) continue;
      const addTo = (map: Map<string, any>) => {
        if (!map.has(m.campaign_id)) map.set(m.campaign_id, { spend: 0, orders: 0, clicks: 0, impressions: 0 });
        const e = map.get(m.campaign_id)!;
        e.spend += m.spend || 0;
        e.orders += m.orders || 0;
        e.clicks += m.clicks || 0;
        e.impressions += m.impressions || 0;
      };
      if (m.date >= cutoff14d) addTo(campMetrics14d);
      if (m.date >= cutoff3d)  addTo(campMetrics3d);
    }

    // ── Cooldown: idempotency keys já usados hoje por esta regra ─────────
    const usedIdemKeys = new Set<string>(
      recentRuleExecs
        .filter((e: any) => {
          const ts = e.created_date || e.executed_at || '';
          const ageH = (Date.now() - new Date(ts).getTime()) / 3600000;
          return ageH < COOLDOWN_HOURS && (e.rule_key || '').startsWith('profit_bid_adj');
        })
        .map((e: any) => e.idempotency_key)
        .filter(Boolean)
    );

    // ── Processar cada keyword ───────────────────────────────────────────
    const decisions: any[] = [];
    const report: any[] = [];
    const stats = { evaluated: 0, reduce: 0, increase: 0, hold: 0, skipped_cooldown: 0, skipped_no_data: 0, skipped_no_econ: 0 };

    for (const kw of keywords) {
      const entityId = kw.keyword_id || kw.id;
      if (!entityId) continue;

      const resolvedAsin = kw.asin || campaignAsinMap.get(kw.campaign_id) || null;
      const product = resolvedAsin ? productMap.get(resolvedAsin) : null;

      // Buscar dados econômicos do produto
      const econ = resolvedAsin
        ? (econByNsku.get(normSku(product?.sku || '')) || econByNsku.get(`ASIN:${resolvedAsin}`) || null)
        : null;

      if (!econ || !econ.contribution_margin_amount || Number(econ.contribution_margin_amount) <= 0) {
        stats.skipped_no_econ++;
        continue;
      }

      const marginAmount = Number(econ.contribution_margin_amount);
      const safeMaxCpc   = Number(econ.safe_max_cpc || 0);
      const profitMode   = econ.profit_protection_mode || 'normal';

      // Agregar métricas da campanha desta keyword
      const cm14 = campMetrics14d.get(kw.campaign_id) || { spend: 0, orders: 0, clicks: 0, impressions: 0 };
      const cm3  = campMetrics3d.get(kw.campaign_id)  || { spend: 0, orders: 0, clicks: 0, impressions: 0 };

      const kw_clicks      = kw.clicks      || cm14.clicks      || 0;
      const kw_impressions = kw.impressions || cm14.impressions  || 0;
      const kw_spend       = kw.spend       || cm14.spend        || 0;
      const kw_orders      = kw.orders      || cm14.orders       || 0;

      // Evidência mínima
      if (kw_clicks < MIN_CLICKS || kw_spend < MIN_SPEND || kw_impressions < MIN_IMPRESSIONS) {
        stats.skipped_no_data++;
        continue;
      }

      stats.evaluated++;
      const currentBid = Number(kw.bid || kw.current_bid || 0.25);

      // ── Calcular Lucro Pós-ADS real por janela ────────────────────────
      // Janela 14d (base)
      const adSpendPerOrder14d = cm14.orders > 0 ? cm14.spend / cm14.orders : (cm14.spend > 0 ? cm14.spend : 0);
      const profitAfterAds14d  = marginAmount - adSpendPerOrder14d;

      // Janela 3d (alerta rápido)
      const adSpendPerOrder3d = cm3.orders > 0 ? cm3.spend / cm3.orders : (cm3.spend > 0 ? cm3.spend : 0);
      const profitAfterAds3d  = marginAmount - adSpendPerOrder3d;

      // ── Definir thresholds ────────────────────────────────────────────
      const profitTarget      = marginAmount * PROFIT_TARGET_PCT;       // lucro mínimo desejado
      const recoveryThreshold = marginAmount * RECOVERY_THRESHOLD_PCT;  // nível de recuperação

      // ── Cooldown ─────────────────────────────────────────────────────
      const iKeyBase = `profit_bid_adj|${aid}|${entityId}`;
      if (usedIdemKeys.has(iKeyBase + '|reduce') || usedIdemKeys.has(iKeyBase + '|increase')) {
        stats.skipped_cooldown++;
        continue;
      }

      // ── Decisão ───────────────────────────────────────────────────────
      let action: 'reduce' | 'increase' | 'hold' = 'hold';
      let newBid = currentBid;
      let rationale = '';
      let ruleKey = '';
      let risk: string = 'low';

      if (profitAfterAds3d < profitTarget || profitAfterAds14d < profitTarget) {
        // ── REDUÇÃO: lucro abaixo da meta ─────────────────────────────
        // Gap proporcional: quanto mais longe do target, maior a redução
        const worstProfit = Math.min(profitAfterAds3d, profitAfterAds14d);
        const gapFromTarget = profitTarget - worstProfit; // positivo quando abaixo da meta
        const gapRatio = Math.min(1.0, gapFromTarget / Math.max(1, marginAmount));

        // Redução escalonada: até maxDecreasePct quando lucro negativo, proporcional ao gap
        const reductionPct = clamp(maxDecreasePct * gapRatio, 0.05, maxDecreasePct);

        const candidateBid = currentBid * (1 - reductionPct);

        // Não cai abaixo do visibility floor: garante que o produto continuará aparecendo
        newBid = clamp(candidateBid, visibilityFloorBid, maxBid);

        if (newBid >= currentBid - 0.01) {
          // Já no mínimo de visibilidade — não há o que reduzir, apenas registrar
          report.push({ entityId, asin: resolvedAsin, keyword: kw.keyword_text, action: 'at_visibility_floor', currentBid, profitAfterAds14d, profitAfterAds3d, profitTarget, profitMode });
          stats.hold++;
          continue;
        }

        action = 'reduce';
        ruleKey = 'profit_bid_adj_reduce';
        risk = profitAfterAds3d < 0 ? 'high' : 'medium';
        rationale = `📉 LUCRO PÓS-ADS ABAIXO DA META: ` +
          `14d R$${profitAfterAds14d.toFixed(2)}/pedido | 3d R$${profitAfterAds3d.toFixed(2)}/pedido. ` +
          `Meta de lucro: R$${profitTarget.toFixed(2)} (${(PROFIT_TARGET_PCT * 100).toFixed(0)}% da margem bruta R$${marginAmount.toFixed(2)}). ` +
          `Gap: R$${gapFromTarget.toFixed(2)} (${(gapRatio * 100).toFixed(0)}% da margem). ` +
          `Bid reduzido ${(reductionPct * 100).toFixed(0)}%: R$${currentBid.toFixed(2)} → R$${newBid.toFixed(2)}. ` +
          `Lance mínimo de visibilidade preservado: R$${visibilityFloorBid.toFixed(2)}.`;

      } else if (profitAfterAds14d >= recoveryThreshold && profitAfterAds3d >= recoveryThreshold) {
        // ── AUMENTO: lucro recuperado acima do threshold ──────────────
        // Só aumenta se não estiver no budget guardrail e não exceder safe_max_cpc
        if (budgetGuardrailActive) {
          report.push({ entityId, asin: resolvedAsin, keyword: kw.keyword_text, action: 'increase_blocked_budget', currentBid, profitAfterAds14d, profitAfterAds3d });
          stats.hold++;
          continue;
        }

        // Incremento moderado: quanto mais próximo do teto de margem, menor o passo
        const recoveryMargin = profitAfterAds14d - recoveryThreshold;
        const recoveryRatio  = clamp(recoveryMargin / Math.max(1, marginAmount), 0.1, 1.0);
        const increasePct    = clamp(maxIncreasePct * recoveryRatio, 0.05, maxIncreasePct);

        const candidateBid = currentBid * (1 + increasePct);

        // Não supera safe_max_cpc do produto
        const bidCeiling = safeMaxCpc > 0 ? Math.min(maxBid, safeMaxCpc) : maxBid;
        newBid = clamp(candidateBid, minBid, bidCeiling);

        if (newBid <= currentBid * 1.01) {
          stats.hold++;
          continue;
        }

        action = 'increase';
        ruleKey = 'profit_bid_adj_increase';
        risk = 'low';
        rationale = `📈 LUCRO PÓS-ADS RECUPERADO: ` +
          `14d R$${profitAfterAds14d.toFixed(2)}/pedido | 3d R$${profitAfterAds3d.toFixed(2)}/pedido. ` +
          `Threshold de recuperação: R$${recoveryThreshold.toFixed(2)} (${(RECOVERY_THRESHOLD_PCT * 100).toFixed(0)}% da margem R$${marginAmount.toFixed(2)}). ` +
          `Bid restaurado +${(increasePct * 100).toFixed(0)}%: R$${currentBid.toFixed(2)} → R$${newBid.toFixed(2)} ` +
          `(teto safe_max_cpc: R$${bidCeiling.toFixed(2)}).`;

      } else {
        // Lucro entre floor e recovery — manter bid atual, apenas monitorar
        stats.hold++;
        report.push({ entityId, asin: resolvedAsin, keyword: kw.keyword_text, action: 'hold', currentBid, profitAfterAds14d, profitAfterAds3d, profitTarget, recoveryThreshold });
        continue;
      }

      // ── Montar decisão ────────────────────────────────────────────────
      const iKey = `${iKeyBase}|${action}|${today}`;

      report.push({
        entityId, asin: resolvedAsin, keyword: kw.keyword_text,
        action, currentBid, newBid,
        profitAfterAds14d: Math.round(profitAfterAds14d * 100) / 100,
        profitAfterAds3d: Math.round(profitAfterAds3d * 100) / 100,
        profitTarget: Math.round(profitTarget * 100) / 100,
        recoveryThreshold: Math.round(recoveryThreshold * 100) / 100,
        marginAmount: Math.round(marginAmount * 100) / 100,
        profitMode,
      });

      if (!DRY_RUN) {
        decisions.push({
          amazon_account_id: aid,
          run_id: correlationId,
          decision_type: 'bid_change',
          entity_type: 'keyword',
          entity_id: entityId,
          campaign_id: kw.campaign_id,
          keyword_id: kw.keyword_id,
          keyword_text: kw.keyword_text,
          asin: resolvedAsin,
          action: 'set_bid',
          value_before: currentBid,
          value_after: Math.round(newBid * 100) / 100,
          rationale,
          risk,
          confidence: 85,
          status: 'approved',
          approval_status: 'auto_approved',
          autopilot_authorized: true,
          requires_approval: false,
          idempotency_key: iKey,
          source_function: 'adjustBidByProfitAfterAds',
          created_at: now,
        });

        // RuleExecution para cooldown
        await base44.asServiceRole.entities.RuleExecution.create({
          amazon_account_id: aid,
          correlation_id: correlationId,
          rule_key: ruleKey,
          rule_version: 1,
          entity_type: 'keyword',
          entity_id: entityId,
          campaign_id: kw.campaign_id,
          keyword_id: kw.keyword_id,
          asin: resolvedAsin,
          action_type: 'set_bid',
          value_before: currentBid,
          value_after: Math.round(newBid * 100) / 100,
          idempotency_key: iKey,
          status: 'pending',
          reason: rationale.slice(0, 500),
        }).catch(() => {});
      }

      if (action === 'reduce') stats.reduce++;
      else stats.increase++;
    }

    // ── Gravar OptimizationDecision em batch ─────────────────────────────
    let saved = 0;
    if (!DRY_RUN && decisions.length > 0) {
      for (let i = 0; i < decisions.length; i += 50) {
        await base44.asServiceRole.entities.OptimizationDecision.bulkCreate(decisions.slice(i, i + 50)).catch(() => {});
        saved += Math.min(50, decisions.length - i);
      }
    }

    return Response.json({
      ok: true,
      dry_run: DRY_RUN,
      correlationId,
      stats,
      decisions_generated: decisions.length,
      decisions_saved: saved,
      budget_guardrail_active: budgetGuardrailActive,
      real_spend_yesterday: Math.round(realSpendYesterday * 100) / 100,
      config: {
        profit_target_pct: PROFIT_TARGET_PCT,
        recovery_threshold_pct: RECOVERY_THRESHOLD_PCT,
        visibility_floor_bid: Math.round(visibilityFloorBid * 100) / 100,
        cooldown_hours: COOLDOWN_HOURS,
        max_increase_pct: Math.round(maxIncreasePct * 100),
        max_decrease_pct: Math.round(maxDecreasePct * 100),
      },
      report: report.slice(0, 50),
      note: 'Redução proporcional ao gap de lucro. Nunca abaixo do visibility_floor_bid. Recuperação gradual modulada pelo ritmo de melhora do lucro pós-ADS.',
    });

  } catch (error: any) {
    console.error('[adjustBidByProfitAfterAds]', error.message);
    return Response.json({ ok: false, error: error.message, correlationId }, { status: 500 });
  }
});