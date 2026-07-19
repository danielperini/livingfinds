/**
 * adjustBidsWithConversion — Ajuste inteligente de lances para keywords com dados de performance
 *
 * Mantém SEMPRE Down Only como estratégia de bidding para proteger orçamento.
 * Opera diretamente no nível de keyword (independente de campanha local estar mapeada).
 *
 * Regras por situação (fórmula econômica):
 *
 * REDUÇÃO: ACoS > target → bid_novo = bid_atual × (target_acos / acos_real)
 *   - Cap: máximo -20% por ciclo, mínimo R$0,25
 *
 * REDUÇÃO SEM CONVERSÃO: spend >= R$10, clicks >= 5, orders = 0
 *   - Redução de 15% como proteção de margem
 *
 * AUMENTO: ACoS < target × 0.7 (20% abaixo da meta), orders >= 1, clicks >= 10
 *          E CPC real < CPC sustentável (AOV × CVR × target_acos)
 *   - Aumento máximo de +8% por ciclo, limitado pelo max_bid configurado
 *
 * MANTER: dados insuficientes ou condições intermediárias
 *
 * Cooldown: 48h por keyword (via AdsBidChangeLog)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MIN_BID        = 0.25;
const MAX_BID        = 5.00;
const MAX_INCREASE   = 0.08;   // +8% máximo por ciclo
const MAX_DECREASE   = 0.20;   // -20% máximo por ciclo
const COOLDOWN_HOURS = 48;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Calcula nova decisão de bid para uma keyword
 * Retorna: { action: 'increase'|'decrease'|'hold', newBid, reason, confidence }
 */
function decideBid(kw, targetAcos, maxBidAllowed) {
  const bid     = Number(kw.current_bid || kw.bid || 0);
  const spend   = Number(kw.spend  || 0);
  const clicks  = Number(kw.clicks || 0);
  const orders  = Number(kw.orders || 0);
  const sales   = Number(kw.sales  || 0);
  const acos    = Number(kw.acos   || 0);
  const state   = (kw.state || kw.status || '').toLowerCase();

  if (bid <= 0) return { action: 'hold', reason: 'bid inválido' };
  if (state === 'paused' || state === 'archived') return { action: 'hold', reason: 'keyword inativa' };

  // ── REDUÇÃO: sem conversão com gasto relevante ────────────────────────
  if (orders === 0 && spend >= 10 && clicks >= 5) {
    const reduction  = 0.15; // -15% para sem conversão
    const newBid     = Math.max(MIN_BID, parseFloat((bid * (1 - reduction)).toFixed(2)));
    if (newBid >= bid - 0.01) return { action: 'hold', reason: 'bid já no mínimo' };
    return {
      action: 'decrease',
      newBid,
      reason: `${clicks} cliques, R$${spend.toFixed(2)} gasto, 0 pedidos → -${(reduction*100).toFixed(0)}% (proteção de margem)`,
      confidence: 80,
    };
  }

  // ── Com ACoS disponível → decisão pela fórmula econômica ─────────────
  if (acos > 0 && orders > 0) {
    // REDUÇÃO: ACoS acima da meta
    if (acos > targetAcos) {
      const rawFactor = targetAcos / acos;                     // ex: 15/40 = 0.375
      const capped    = Math.max(1 - MAX_DECREASE, rawFactor); // não pode cair mais de 20%
      const newBid    = Math.max(MIN_BID, parseFloat((bid * capped).toFixed(2)));
      if (newBid >= bid - 0.01) return { action: 'hold', reason: 'ajuste insignificante' };
      const pct = ((bid - newBid) / bid * 100).toFixed(1);
      return {
        action: 'decrease',
        newBid,
        reason: `ACoS ${acos.toFixed(1)}% > meta ${targetAcos.toFixed(1)}% → bid × ${capped.toFixed(2)} (-${pct}%)`,
        confidence: 88,
      };
    }

    // AUMENTO: ACoS bem abaixo da meta (≤ 70% da meta) com volume suficiente
    const goodAcosThreshold = targetAcos * 0.70;
    if (acos <= goodAcosThreshold && clicks >= 10 && orders >= 1 && bid < maxBidAllowed) {
      const aov = orders > 0 ? sales / orders : 0;
      const cvr = clicks > 0 ? orders / clicks : 0;
      const sustainableCpc = aov * cvr * (targetAcos / 100);
      const currentCpc     = clicks > 0 ? spend / clicks : 0;

      if (sustainableCpc > 0 && currentCpc < sustainableCpc * 0.85) {
        const headroom = (targetAcos - acos) / targetAcos;          // 0-1
        const boostPct = Math.min(MAX_INCREASE, Math.max(0.03, headroom * 0.08));
        const newBid   = Math.min(maxBidAllowed, parseFloat((bid * (1 + boostPct)).toFixed(2)));
        if (newBid <= bid + 0.01) return { action: 'hold', reason: 'bid já no máximo' };
        return {
          action: 'increase',
          newBid,
          reason: `ACoS ${acos.toFixed(1)}% ≤ ${goodAcosThreshold.toFixed(1)}% (70% da meta), CPC R$${currentCpc.toFixed(2)} < sustentável R$${sustainableCpc.toFixed(2)} → +${(boostPct*100).toFixed(0)}%`,
          confidence: 75,
        };
      }

      return { action: 'hold', reason: `ACoS bom mas CPC (R$${(clicks>0?spend/clicks:0).toFixed(2)}) já próximo do sustentável` };
    }
  }

  return { action: 'hold', reason: 'dados insuficientes ou condição intermediária', confidence: 40 };
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body   = await req.json().catch(() => ({}));
    const { amazon_account_id, dry_run = false } = body;

    // ── Resolver conta ─────────────────────────────────────────────────────
    let account;
    if (amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id }, null, 1);
      account = accs[0];
      // Aceitar conta mesmo com status error (token pode estar em cache)
      if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' }, { status: 404 });
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({}, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: true, skipped: true, reason: 'Nenhuma conta configurada' });

    const accountId = account.id;
    const now       = new Date().toISOString();
    const cutoff    = new Date(Date.now() - COOLDOWN_HOURS * 3600 * 1000).toISOString();

    // ── PerformanceSettings ────────────────────────────────────────────────
    const perfList = await base44.asServiceRole.entities.PerformanceSettings.filter(
      { amazon_account_id: accountId }, null, 1
    ).catch(() => []);
    const perfSettings = perfList[0] || {};
    const targetAcos   = Number(perfSettings.target_acos || 15);
    const maxBid       = Number(perfSettings.max_bid || MAX_BID);

    // ── Cooldown: keywords ajustadas nas últimas 48h ─────────────────────
    const recentLogs = await base44.asServiceRole.entities.AdsBidChangeLog.filter(
      { amazon_account_id: accountId }, '-created_date', 1000
    ).catch(() => []);
    const onCooldown = new Set(
      recentLogs
        .filter(l => (l.created_at || l.created_date || '') > cutoff && l.source === 'adjustBidsWithConversion')
        .map(l => l.keyword_id)
    );

    // ── Buscar todas as keywords da conta com dados relevantes ────────────
    const allKeywords = await base44.asServiceRole.entities.Keyword.filter(
      { amazon_account_id: accountId }, '-spend', 2000
    ).catch(() => []);

    // Filtrar: apenas keywords habilitadas com algum spend ou bid configurado
    const candidates = allKeywords.filter(kw => {
      const state = (kw.state || kw.status || '').toLowerCase();
      if (state === 'paused' || state === 'archived') return false;
      const bid = Number(kw.current_bid || kw.bid || 0);
      if (bid <= 0) return false;
      // Precisa ter algum histórico de spend OU ter sido criada recentemente
      return true;
    });

    const results   = [];
    let increased   = 0;
    let decreased   = 0;
    let held        = 0;
    let skipped     = 0;
    let errors      = 0;

    for (const kw of candidates) {
      const kwId = kw.keyword_id || kw.id;

      // Cooldown
      if (onCooldown.has(kwId)) { skipped++; continue; }

      const { action, newBid, reason, confidence } = decideBid(kw, targetAcos, maxBid);

      if (action === 'hold') { held++; continue; }

      const currentBid = Number(kw.current_bid || kw.bid || 0);

      if (dry_run) {
        results.push({
          keyword_id: kwId,
          keyword_text: kw.keyword_text,
          campaign_id: kw.campaign_id,
          asin: kw.asin,
          action,
          current_bid: currentBid,
          new_bid: newBid,
          delta_pct: currentBid > 0 ? ((newBid - currentBid) / currentBid * 100).toFixed(1) + '%' : null,
          acos: kw.acos,
          target_acos: targetAcos,
          clicks: kw.clicks,
          orders: kw.orders,
          spend: kw.spend,
          confidence,
          reason,
        });
        action === 'increase' ? increased++ : decreased++;
        continue;
      }

      // ── Aplicar via PUT /sp/keywords ──────────────────────────────────
      const putRes = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
        _service_role: true,
        amazon_account_id: accountId,
        path: '/sp/keywords',
        method: 'PUT',
        content_type: 'application/vnd.spKeyword.v3+json',
        payload: { keywords: [{ keywordId: String(kwId), bid: newBid }] },
      }).catch(e => ({ ok: false, error: e.message }));

      const apiOk = putRes?.ok === true || putRes?.status === 207;

      if (!apiOk) {
        errors++;
        results.push({ keyword_id: kwId, status: 'error_amazon', error: JSON.stringify(putRes).slice(0, 200) });
        continue;
      }

      // ── Atualizar localmente ──────────────────────────────────────────
      await base44.asServiceRole.entities.Keyword.update(kw.id, {
        current_bid: newBid,
        bid: newBid,
        last_seen_at: now,
      }).catch(() => {});

      // ── Log ───────────────────────────────────────────────────────────
      await base44.asServiceRole.entities.AdsBidChangeLog.create({
        amazon_account_id: accountId,
        campaign_id: kw.campaign_id,
        keyword_id: kwId,
        asin: kw.asin,
        keyword_text: kw.keyword_text,
        match_type: kw.match_type,
        bid_before: currentBid,
        bid_after: newBid,
        change_pct: currentBid > 0 ? (newBid - currentBid) / currentBid * 100 : 0,
        action,
        acos_at_change: kw.acos || 0,
        target_acos_at_change: targetAcos,
        orders_at_change: kw.orders || 0,
        clicks_at_change: kw.clicks || 0,
        spend_at_change: kw.spend || 0,
        reason,
        confidence: confidence || 70,
        source: 'adjustBidsWithConversion',
        bidding_strategy: 'down_only',
        created_at: now,
      }).catch(() => {});

      action === 'increase' ? increased++ : decreased++;
      results.push({
        keyword_id: kwId,
        keyword_text: kw.keyword_text,
        campaign_id: kw.campaign_id,
        action,
        current_bid: currentBid,
        new_bid: newBid,
        acos: kw.acos,
        reason,
        status: 'applied',
      });

      await sleep(150);
    }

    return Response.json({
      ok: true,
      dry_run,
      bidding_strategy: 'down_only',
      target_acos: targetAcos,
      max_bid: maxBid,
      keywords_evaluated: candidates.length,
      keywords_increased: increased,
      keywords_decreased: decreased,
      keywords_held: held,
      keywords_skipped: skipped,
      errors,
      cooldown_hours: COOLDOWN_HOURS,
      results,
      duration_ms: Date.now() - t0,
    });

  } catch (err) {
    return Response.json({ ok: false, error: err.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});