/**
 * smartBidFromCpc — Ajuste de bid baseado no CPC real
 *
 * REGRAS DE SEGURANÇA (2026-07-09 — revisão pós-auditoria):
 *
 * Para REDUZIR bid:
 *   - Keyword deve ter >= 10 cliques (evidência estatística mínima)
 *   - ACoS da keyword deve estar > target_acos * 1.2 (só reduz se realmente acima da meta)
 *   - Sem vendas E gasto > R$8 → reduz para 50% do CPC
 *   - Cooldown de 72h entre ajustes (verificado via last_bid_adjusted_at)
 *   - Diferença mínima de R$0.10 para evitar micro-oscilações
 *
 * Para AUMENTAR bid:
 *   - Keyword deve ter >= 1 venda (conversão confirmada)
 *   - ACoS deve estar < target_acos * 0.8 (abaixo da meta = espaço para escalar)
 *   - Cooldown de 96h
 *
 * NUNCA ajusta:
 *   - Keywords sem histórico de gasto (spend = 0)
 *   - Campanhas arquivadas ou pausadas
 *   - Produtos sem estoque
 *   - Keywords com ACoS dentro da meta (±20%) — já está funcionando
 *   - Se o bid calculado for MAIOR que o atual durante modo de redução
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MAX_BID = 5.00;
const MIN_BID = 0.40;          // floor absoluto — nunca abaixo de R$0,40
const MIN_DELTA = 0.10;        // só ajusta se diferença > R$0.10
const MIN_CLICKS = 10;         // evidência estatística mínima
const MIN_SPEND_NO_SALES = 8;  // gasto mínimo sem venda para justificar redução
const COOLDOWN_REDUCE_H = 72;  // horas entre reduções
const COOLDOWN_INCREASE_H = 96;

async function getAdsToken(refreshToken) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: Deno.env.get('ADS_CLIENT_ID') || '',
    client_secret: Deno.env.get('ADS_CLIENT_SECRET') || '',
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Token failed');
  return data.access_token;
}

function getAdsBaseUrl() {
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsRequest(method, path, body, token, profileId) {
  const res = await fetch(`${getAdsBaseUrl()}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': 'application/vnd.spKeyword.v3+json',
      'Accept': 'application/vnd.spKeyword.v3+json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const now = new Date();
    const payload = await req.json().catch(() => ({}));

    const accounts = payload.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: payload.amazon_account_id })
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' });

    const summary = {
      accounts_processed: 0,
      keywords_analyzed: 0,
      keywords_adjusted: 0,
      keywords_skipped_cooldown: 0,
      keywords_skipped_within_target: 0,
      keywords_skipped_insufficient_data: 0,
      keywords_skipped_no_acos_context: 0,
      errors: [],
      adjustments: [],
    };

    for (const account of accounts) {
      try {
        const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
        const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
        if (!refreshToken || !profileId) continue;

        const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: account.id }, null, 1);
        const cfg = configs[0] || {};
        const targetAcos = cfg.target_acos || cfg.acos_target || 10;
        const effectiveMinBid = Math.max(MIN_BID, cfg.min_bid || MIN_BID);
        const effectiveMaxBid = Math.min(MAX_BID, cfg.max_bid || MAX_BID);

        // Carregar keywords com gasto
        const keywords = await base44.asServiceRole.entities.Keyword.filter(
          { amazon_account_id: account.id, state: 'enabled' },
          '-spend',
          500
        );

        // Carregar campanhas para verificar estado
        const campaigns = await base44.asServiceRole.entities.Campaign.filter(
          { amazon_account_id: account.id }, null, 300
        );
        const campaignStateMap = new Map();
        for (const c of campaigns) {
          const st = String(c.state || c.status || '').toLowerCase();
          if (c.campaign_id) campaignStateMap.set(c.campaign_id, st);
          if (c.amazon_campaign_id) campaignStateMap.set(c.amazon_campaign_id, st);
        }

        // Carregar produtos para verificar estoque
        const products = await base44.asServiceRole.entities.Product.filter(
          { amazon_account_id: account.id }, null, 200
        );
        const productMap = new Map(products.map(p => [p.asin, p]));

        // Carregar last executions para cooldown
        const recentExecs = await base44.asServiceRole.entities.AdsBidChangeLog.filter(
          { amazon_account_id: account.id }, '-created_at', 2000
        ).catch(() => []);
        // Mapa keyword_id → timestamp da última alteração
        const lastChangedAt = new Map();
        for (const ex of recentExecs) {
          if (!ex.keyword_id) continue;
          const ts = ex.created_at || ex.created_date;
          if (!ts) continue;
          const existing = lastChangedAt.get(ex.keyword_id);
          if (!existing || ts > existing) lastChangedAt.set(ex.keyword_id, ts);
        }

        const token = await getAdsToken(refreshToken);
        summary.keywords_analyzed += keywords.length;

        for (const kw of keywords) {
          const cpc = kw.cpc || 0;
          const spend = kw.spend || 0;
          const clicks = kw.clicks || 0;
          const orders = kw.orders || 0;
          const sales = kw.sales || 0;
          const acos = kw.acos || (sales > 0 ? spend / sales * 100 : 0);
          const currentBid = kw.current_bid || kw.bid || 0.25;

          // Sem CPC real → pular
          if (cpc <= 0 || spend <= 0) {
            summary.keywords_skipped_insufficient_data++;
            continue;
          }

          // Evidência mínima
          if (clicks < MIN_CLICKS) {
            summary.keywords_skipped_insufficient_data++;
            continue;
          }

          // Campanha não ativa → pular
          const campState = campaignStateMap.get(kw.campaign_id) || '';
          if (campState && !['enabled', 'active'].includes(campState)) {
            summary.keywords_skipped_insufficient_data++;
            continue;
          }

          // Produto sem estoque → pular
          const product = kw.asin ? productMap.get(kw.asin) : null;
          if (product?.inventory_status === 'out_of_stock' || (product && (product.fba_inventory || 0) === 0)) {
            summary.keywords_skipped_insufficient_data++;
            continue;
          }

          // ACoS dentro da meta (±20%) → NÃO mexer
          const acosLower = targetAcos * 0.8;
          const acosUpper = targetAcos * 1.2;
          if (orders > 0 && acos >= acosLower && acos <= acosUpper) {
            summary.keywords_skipped_within_target++;
            continue;
          }

          // Determinar direção
          let direction = 'hold';

          // REDUÇÃO: ACoS muito acima da meta OU sem conversão com alto gasto
          const shouldReduce =
            (orders > 0 && acos > acosUpper) ||  // com vendas mas ACoS ruim
            (orders === 0 && spend >= MIN_SPEND_NO_SALES);  // sem venda e gastou muito

          // AUMENTO: ACoS bom + conversão confirmada
          const shouldIncrease =
            orders >= 1 &&
            acos > 0 &&
            acos < acosLower &&
            currentBid < effectiveMaxBid * 0.8;  // ainda há espaço para crescer

          if (shouldReduce) direction = 'decrease';
          else if (shouldIncrease) direction = 'increase';
          else { summary.keywords_skipped_within_target++; continue; }

          // Cooldown
          const kwId = kw.keyword_id;
          const lastTs = kwId ? lastChangedAt.get(kwId) : null;
          if (lastTs) {
            const hoursAgo = (Date.now() - new Date(lastTs).getTime()) / 3600000;
            const cooldown = direction === 'increase' ? COOLDOWN_INCREASE_H : COOLDOWN_REDUCE_H;
            if (hoursAgo < cooldown) {
              summary.keywords_skipped_cooldown++;
              continue;
            }
          }

          // Calcular bid alvo
          let targetBid;
          if (direction === 'decrease') {
            // Redução proporcional ao desvio do ACoS
            // Ex: ACoS=20%, meta=10% → ratio = 10/20 = 0.50 → bid = 50% do CPC
            const acosRatio = orders > 0 ? Math.min(0.55, Math.max(0.35, targetAcos / acos)) : 0.45;
            targetBid = parseFloat(Math.max(effectiveMinBid, Math.min(cpc * acosRatio, currentBid - MIN_DELTA)).toFixed(2));
          } else {
            // Aumento conservador: +10% do bid atual, sem ultrapassar 60% do CPC
            const maxFromCpc = Math.min(cpc * 0.60, effectiveMaxBid);
            targetBid = parseFloat(Math.min(currentBid * 1.10, maxFromCpc).toFixed(2));
          }

          // Não ajustar se não há diferença real
          if (Math.abs(targetBid - currentBid) < MIN_DELTA) {
            summary.keywords_skipped_within_target++;
            continue;
          }

          // Garantir que redução não vira aumento por arredondamento
          if (direction === 'decrease' && targetBid >= currentBid) {
            summary.keywords_skipped_within_target++;
            continue;
          }

          const acosRatioPct = orders > 0 ? Math.round(targetAcos / acos * 100) : 45;
          const reason = direction === 'decrease'
            ? `CPC R$${cpc.toFixed(2)} | ACoS ${acos.toFixed(1)}% vs meta ${targetAcos}% → bid ${acosRatioPct}% do CPC = R$${targetBid.toFixed(2)} (era R$${currentBid.toFixed(2)})`
            : `CPC R$${cpc.toFixed(2)} | ACoS ${acos.toFixed(1)}% abaixo da meta ${targetAcos}% → escalar bid +10% = R$${targetBid.toFixed(2)} (era R$${currentBid.toFixed(2)})`;

          // Enviar para Amazon
          const resp = await adsRequest(
            'PUT', '/sp/keywords',
            { keywords: [{ keywordId: kw.keyword_id, bid: targetBid }] },
            token, profileId
          );

          if ([200, 207].includes(resp.status)) {
            await base44.asServiceRole.entities.Keyword.update(kw.id, {
              current_bid: targetBid,
              bid: targetBid,
              last_seen_at: now.toISOString(),
            });

            await base44.asServiceRole.entities.AdsBidChangeLog.create({
              amazon_account_id: account.id,
              keyword_id: kw.keyword_id,
              keyword: kw.keyword_text || kw.keyword || '',
              campaign_id: kw.campaign_id || '',
              old_bid: currentBid,
              new_bid: targetBid,
              change_amount: parseFloat((targetBid - currentBid).toFixed(2)),
              change_percent: parseFloat((((targetBid - currentBid) / Math.max(currentBid, 0.01)) * 100).toFixed(1)),
              direction,
              reason,
              evidence: `clicks=${clicks} orders=${orders} spend=${spend.toFixed(2)} cpc=${cpc.toFixed(2)} acos=${acos.toFixed(1)}% target_acos=${targetAcos}%`,
              ai_confidence: 80,
              risk_level: 'low',
              status: 'executed',
              created_at: now.toISOString(),
            });

            summary.keywords_adjusted++;
            summary.adjustments.push({
              keyword: kw.keyword_text || kw.keyword,
              direction,
              old_bid: currentBid,
              new_bid: targetBid,
              acos: parseFloat(acos.toFixed(1)),
              target_acos: targetAcos,
              orders,
            });
          } else {
            summary.errors.push(`kw ${kw.keyword_id}: HTTP ${resp.status}`);
          }

          // Rate limit
          await new Promise(r => setTimeout(r, 300));
        }

        summary.accounts_processed++;
      } catch (accError) {
        summary.errors.push(`Conta ${account.id}: ${accError.message}`);
      }
    }

    return Response.json({
      ok: true,
      rule: 'smart_bid_acos_aware',
      min_bid_floor: MIN_BID,
      min_clicks_required: MIN_CLICKS,
      cooldown_reduce_h: COOLDOWN_REDUCE_H,
      cooldown_increase_h: COOLDOWN_INCREASE_H,
      summary,
      executed_at: now.toISOString(),
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});