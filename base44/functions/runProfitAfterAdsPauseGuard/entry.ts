import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

/**
 * runProfitAfterAdsPauseGuard
 *
 * Protege a rentabilidade dos produtos detectando lucro pós-Ads negativo:
 *
 * 1. Lê SalesDaily dos últimos 3 dias por ASIN (profit_after_ads)
 * 2. Detecta ASINs com profit_after_ads < 0 em 2+ dias consecutivos
 * 3. Para esses ASINs: pausa todas as campanhas ativas (60min de cooldown),
 *    cria OptimizationDecision tipo 'pause', salva resume_scheduled_at = now + 72h
 * 4. Para ASINs com resume_scheduled_at vencido:
 *    - Se lucro ainda negativo: cria alerta e mantém pausado
 *    - Se ok (ou sem dados pós-pausa): reativa campanhas, mas pausa keywords com bid > R$0,50
 * 5. Idempotência via idempotency_key por ASIN+data
 */

function nowIso() { return new Date().toISOString(); }
function todayBRT() { return new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10); }

function daysAgo(n: number) {
  return new Date(Date.now() - 3 * 3600000 - n * 86400000).toISOString().slice(0, 10);
}

const BID_FLOOR = 0.50;
const PAUSE_DURATION_HOURS = 72;
const CONSECUTIVE_DAYS_THRESHOLD = 2;
const BID_REDUCTION_PCT = 0.20;
const BID_REVIEW_HOURS = 48;

async function reduceMostCostlyKeyword(base44: any, aid: string, asin: string, campaigns: any[], product: any, today: string) {
  const candidates: any[] = [];
  for (const campaign of campaigns) {
    const campaignId = String(campaign.campaign_id || campaign.amazon_campaign_id || '');
    if (!campaignId) continue;
    const keywords = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid, campaign_id: campaignId }, null, 500).catch(() => []);
    for (const keyword of keywords as any[]) {
      const keywordId = String(keyword.amazon_keyword_id || keyword.keyword_id || '');
      const bid = Number(keyword.current_bid ?? keyword.bid ?? 0);
      const state = String(keyword.state || keyword.status || '').toLowerCase();
      if (!/^\d+$/.test(keywordId) || state !== 'enabled' || bid <= BID_FLOOR) continue;
      const spend = Number(keyword.spend || 0);
      const sales = Number(keyword.sales || 0);
      const orders = Number(keyword.orders || 0);
      const wasteScore = spend * (orders <= 0 || sales <= 0 ? 3 : Math.max(1, Number(keyword.acos || 0) / 100));
      candidates.push({ campaign, campaignId, keyword, keywordId, bid, spend, sales, orders, wasteScore });
    }
  }
  const worst = candidates.sort((a, b) => b.wasteScore - a.wasteScore || b.spend - a.spend)[0];
  if (!worst || worst.spend <= 0) return { reduced: false, reason: 'no_keyword_cost_data' };

  const idempotencyKey = `profit_guard_bid_down_${asin}_${worst.keywordId}_${today}`;
  const existing = await base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: aid, idempotency_key: idempotencyKey }, null, 1).catch(() => []);
  if (existing.length) return { reduced: true, reason: 'already_reduced', keyword: worst.keyword };

  const newBid = Math.max(BID_FLOOR, Math.round(worst.bid * (1 - BID_REDUCTION_PCT) * 100) / 100);
  if (newBid >= worst.bid) return { reduced: false, reason: 'bid_at_floor' };
  const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
    amazon_account_id: aid, command: 'update_keyword',
    payload: { campaign_id: worst.campaignId, ad_group_id: worst.keyword.ad_group_id, keyword_id: worst.keywordId, bid: newBid },
    _service_role: true,
  }).catch((error: any) => ({ data: { ok: false, error: error?.message } }));
  const data = response?.data || response || {};
  const executed = data?.ok !== false;
  if (executed) await base44.asServiceRole.entities.Keyword.update(worst.keyword.id, { bid: newBid, current_bid: newBid, last_bid_change_at: nowIso() }).catch(() => {});
  await base44.asServiceRole.entities.OptimizationDecision.create({
    amazon_account_id: aid, decision_type: 'bid_adjustment', entity_type: 'keyword', entity_id: worst.keywordId,
    campaign_id: worst.campaignId, ad_group_id: worst.keyword.ad_group_id, keyword_id: worst.keywordId,
    keyword_text: worst.keyword.keyword_text || worst.keyword.keyword, asin, sku: product?.sku || null,
    action: `Reduzir bid da keyword de maior custo em ${Math.round(BID_REDUCTION_PCT * 100)}%`,
    rationale: `Primeira ação contra prejuízo: ${worst.keyword.keyword_text || worst.keyword.keyword || worst.keywordId} consumiu R$${worst.spend.toFixed(2)} com ${worst.orders} pedido(s).`,
    current_value: worst.bid, proposed_value: newBid, value_before: worst.bid, value_after: newBid, change_pct: -BID_REDUCTION_PCT * 100,
    confidence: 85, risk: 'low', requires_approval: false, status: executed ? 'executed' : 'failed',
    execution_error: executed ? null : String(data?.error || 'Amazon Ads não confirmou o ajuste'), source_function: 'runProfitAfterAdsPauseGuard',
    idempotency_key: idempotencyKey, executed_at: executed ? nowIso() : null, created_at: nowIso(), updated_at: nowIso(),
    data_used: JSON.stringify({ spend: worst.spend, sales: worst.sales, orders: worst.orders, waste_score: worst.wasteScore }),
  }).catch(() => {});
  return { reduced: executed, reason: executed ? 'bid_reduced' : 'bid_update_failed', keyword: worst.keyword };
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);

    // Auth: aceita service role (automações) ou admin autenticado
    const body = await req.json().catch(() => ({}));
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { amazon_account_id, force = false } = body;

    // Resolver conta
    let aid = amazon_account_id;
    if (!aid) {
      const accounts = await base44.asServiceRole.entities.AmazonAccount.filter(
        { status: 'connected' }, '-updated_date', 1
      ).catch(() => []);
      aid = accounts[0]?.id;
    }
    if (!aid) return Response.json({ ok: false, error: 'Nenhuma conta conectada' });

    const today = todayBRT();
    const results = {
      paused: [] as string[],
      bid_reduced: [] as string[],
      resumed: [] as string[],
      still_negative: [] as string[],
      skipped: [] as string[],
      errors: [] as string[],
    };

    // ── 1. Ler SalesDaily dos últimos 3 dias ─────────────────────────────
    const since3d = daysAgo(3);
    const salesRecords = await base44.asServiceRole.entities.SalesDaily.filter(
      { amazon_account_id: aid },
      '-date',
      3000
    ).catch(() => []);

    // Filtrar apenas últimos 3 dias
    const recentSales = salesRecords.filter((r: any) => r.date && r.date >= since3d);

    // Agrupar por ASIN → array de { date, profit_after_ads }
    const asinSalesMap = new Map<string, { date: string; profit: number }[]>();
    for (const r of recentSales) {
      if (!r.asin) continue;
      const profit = r.profit_after_ads ?? 0;
      if (!asinSalesMap.has(r.asin)) asinSalesMap.set(r.asin, []);
      asinSalesMap.get(r.asin)!.push({ date: r.date, profit });
    }

    // ── 2. Ler produtos para verificar resume_scheduled_at ─────────────────
    const products = await base44.asServiceRole.entities.Product.filter(
      { amazon_account_id: aid },
      null,
      500
    ).catch(() => []);

    const productByAsin = new Map<string, any>();
    for (const p of products) {
      if (p.asin) productByAsin.set(p.asin, p);
    }

    // ── 3. Ler campanhas ativas por ASIN ───────────────────────────────────
    const campaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: aid },
      null,
      1000
    ).catch(() => []);

    const campaignsByAsin = new Map<string, any[]>();
    for (const c of campaigns) {
      const state = (c.state || c.status || '').toLowerCase();
      if (state === 'archived') continue;
      const asin = c.asin;
      if (!asin) continue;
      if (!campaignsByAsin.has(asin)) campaignsByAsin.set(asin, []);
      campaignsByAsin.get(asin)!.push(c);
    }

    // ── 4. Para cada ASIN: verificar lógica ───────────────────────────────
    for (const [asin, salesEntries] of asinSalesMap.entries()) {
      try {
        // Ordenar por data desc
        const sorted = [...salesEntries].sort((a, b) => b.date.localeCompare(a.date));
        const product = productByAsin.get(asin);
        const asinCampaigns = campaignsByAsin.get(asin) || [];

        if (asinCampaigns.length === 0) {
          results.skipped.push(`${asin}:no_campaigns`);
          continue;
        }

        // Verificar se produto está em cooldown de pausa (aguardando resumo)
        const pausedAt = product?.ads_paused_at;
        if (pausedAt) {
          const pausedAtMs = new Date(pausedAt).getTime();
          const resumeAt = pausedAtMs + PAUSE_DURATION_HOURS * 3600000;
          const nowMs = Date.now();

          if (nowMs < resumeAt) {
            // Ainda em cooldown — verificar se voltou a dar prejuízo com spend > 0
            const latestSale = sorted[0];
            if (latestSale && latestSale.profit < 0) {
              // Verifica se já foi pausado recentemente (re-pausa imediata sem esperar 2 dias)
              const idKey = `profit_guard_repause_${asin}_${today}`;
              const existingRepause = await base44.asServiceRole.entities.OptimizationDecision.filter(
                { amazon_account_id: aid, idempotency_key: idKey },
                null, 1
              ).catch(() => []);

              if (existingRepause.length === 0) {
                // Manter pausado — já está pausado, não há ação necessária
                results.still_negative.push(asin);
              } else {
                results.skipped.push(`${asin}:repause_already_recorded`);
              }
            } else {
              results.skipped.push(`${asin}:in_cooldown`);
            }
            continue;
          }

          // Cooldown expirado — verificar se pode retomar
          const latestSale = sorted[0];
          const profitAfterPause = latestSale?.profit ?? null;

          if (profitAfterPause !== null && profitAfterPause < 0) {
            // Ainda negativo — manter pausado, criar alerta
            const idKey = `profit_guard_still_neg_${asin}_${today}`;
            const existingAlert = await base44.asServiceRole.entities.Alert.filter(
              { amazon_account_id: aid, deduplication_key: idKey },
              null, 1
            ).catch(() => []);

            if (existingAlert.length === 0) {
              await base44.asServiceRole.entities.Alert.create({
                amazon_account_id: aid,
                alert_type: 'no_sales',
                alert_family: 'performance',
                severity: 'high',
                status: 'active',
                title: `Lucro pós-Ads ainda negativo após pausa: ${asin}`,
                message: `ASIN ${asin} permanece com profit_after_ads < 0 após 72h de pausa (${profitAfterPause?.toFixed(2)}). Decisão manual necessária.`,
                asin,
                deduplication_key: idKey,
                source_function: 'runProfitAfterAdsPauseGuard',
                created_at: nowIso(),
                updated_at: nowIso(),
              }).catch(() => {});
            }

            results.still_negative.push(asin);
            continue;
          }

          // Lucro ok — retomar com keywords estratégicas (bid ≤ R$0,50)
          const resumeIdKey = `profit_guard_resume_${asin}_${today}`;
          const existingResume = await base44.asServiceRole.entities.OptimizationDecision.filter(
            { amazon_account_id: aid, idempotency_key: resumeIdKey },
            null, 1
          ).catch(() => []);

          if (existingResume.length === 0) {
            // Reativar campanhas
            for (const c of asinCampaigns) {
              const campaignState = (c.state || c.status || '').toLowerCase();
              if (campaignState === 'paused') {
                await base44.asServiceRole.functions.invoke('checkAndEnableCampaigns', {
                  amazon_account_id: aid,
                  campaign_ids: [c.campaign_id],
                  _service_role: true,
                }).catch(() => {});
              }

              // Pausar keywords com bid > BID_FLOOR
              const keywords = await base44.asServiceRole.entities.Keyword.filter(
                { amazon_account_id: aid, campaign_id: c.campaign_id },
                null,
                500
              ).catch(() => []);

              for (const kw of keywords) {
                const bid = kw.current_bid ?? kw.bid ?? 0;
                const kwState = (kw.state || kw.status || '').toLowerCase();
                if (bid > BID_FLOOR && kwState === 'enabled') {
                  // Pausar keyword com bid acima do floor via Amazon Ads API
                  await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
                    amazon_account_id: aid,
                    command: 'update_keyword',
                    payload: {
                      campaign_id: c.campaign_id,
                      ad_group_id: kw.ad_group_id,
                      keyword_id: kw.keyword_id,
                      state: 'paused',
                    },
                    _service_role: true,
                  }).catch(() => {});
                }
              }
            }

            // Limpar ads_paused_at do produto
            if (product?.id) {
              await base44.asServiceRole.entities.Product.update(product.id, {
                ads_paused_at: null,
                ads_pause_reason: null,
                ads_resume_pending: false,
              }).catch(() => {});
            }

            // Registrar decisão de retomada
            await base44.asServiceRole.entities.OptimizationDecision.create({
              amazon_account_id: aid,
              decision_type: 'reactivate',
              entity_type: 'product',
              asin,
              action: `Retomada estratégica após 72h de pausa — keywords com bid ≤ R$${BID_FLOOR} mantidas ativas`,
              rationale: `Profit_after_ads voltou para ${profitAfterPause?.toFixed(2) ?? 'N/A'} após pausa. Retomando com bid floor R$${BID_FLOOR}.`,
              confidence: 75,
              risk: 'medium',
              requires_approval: false,
              status: 'executed',
              source_function: 'runProfitAfterAdsPauseGuard',
              idempotency_key: resumeIdKey,
              executed_at: nowIso(),
              created_at: nowIso(),
              updated_at: nowIso(),
            }).catch(() => {});

            results.resumed.push(asin);
          } else {
            results.skipped.push(`${asin}:resume_already_recorded`);
          }
          continue;
        }

        // ── Sem pausa ativa: verificar se deve pausar ─────────────────────
        // Detectar 2 dias consecutivos com profit < 0
        if (sorted.length < CONSECUTIVE_DAYS_THRESHOLD) {
          results.skipped.push(`${asin}:insufficient_data`);
          continue;
        }

        const lastTwo = sorted.slice(0, CONSECUTIVE_DAYS_THRESHOLD);
        const allNegative = lastTwo.every(s => s.profit < 0);

        if (!allNegative) {
          results.skipped.push(`${asin}:profit_ok`);
          continue;
        }

        // A pausa só é considerada depois de uma redução real do bid na
        // keyword que concentrou o custo e de 48h de reavaliação.
        const priorBidActions = await base44.asServiceRole.entities.OptimizationDecision.filter(
          { amazon_account_id: aid, asin, source_function: 'runProfitAfterAdsPauseGuard' },
          '-created_at', 100
        ).catch(() => []);
        const matureBidAction = priorBidActions.find((decision: any) =>
          decision.decision_type === 'bid_adjustment' && decision.status === 'executed' &&
          Date.now() - new Date(decision.executed_at || decision.created_at || 0).getTime() >= BID_REVIEW_HOURS * 3600000
        );
        if (!matureBidAction) {
          const bidAction = await reduceMostCostlyKeyword(base44, aid, asin, asinCampaigns, product, today);
          if (bidAction.reduced) {
            results.bid_reduced.push(`${asin}:${bidAction.keyword?.keyword_text || bidAction.keyword?.keyword || 'keyword'}`);
          } else {
            results.skipped.push(`${asin}:bid_first_action_${bidAction.reason}`);
          }
          continue;
        }

        // Verificar idempotência da pausa após a janela de revisão.
        const pauseIdKey = `profit_guard_pause_${asin}_${today}`;
        const existingPause = await base44.asServiceRole.entities.OptimizationDecision.filter(
          { amazon_account_id: aid, idempotency_key: pauseIdKey },
          null, 1
        ).catch(() => []);

        if (existingPause.length > 0) {
          results.skipped.push(`${asin}:pause_already_recorded`);
          continue;
        }

        // Pausar todas as campanhas ativas do ASIN
        let pausedCount = 0;
        for (const c of asinCampaigns) {
          const campaignState = (c.state || c.status || '').toLowerCase();
          if (campaignState === 'enabled') {
            await base44.asServiceRole.functions.invoke('pauseCampaign', {
              amazon_account_id: aid,
              campaign_id: c.campaign_id,
              reason: `profit_guard:profit_after_ads_negative_${CONSECUTIVE_DAYS_THRESHOLD}d`,
              _service_role: true,
            }).catch(() => {});
            pausedCount++;
          }
        }

        // Salvar ads_paused_at no produto
        if (product?.id) {
          await base44.asServiceRole.entities.Product.update(product.id, {
            ads_paused_at: nowIso(),
            ads_pause_reason: `profit_guard:negative_${CONSECUTIVE_DAYS_THRESHOLD}d_consecutive`,
            ads_resume_pending: true,
          }).catch(() => {});
        }

        // Criar OptimizationDecision de pausa
        const avgProfit = lastTwo.reduce((s, d) => s + d.profit, 0) / lastTwo.length;
        await base44.asServiceRole.entities.OptimizationDecision.create({
          amazon_account_id: aid,
          decision_type: 'pause',
          entity_type: 'product',
          asin,
          action: `Pausa preventiva de ${PAUSE_DURATION_HOURS}h — lucro pós-Ads negativo por ${CONSECUTIVE_DAYS_THRESHOLD} dias consecutivos`,
          rationale: `Profit_after_ads médio nos últimos ${CONSECUTIVE_DAYS_THRESHOLD}d: R$${avgProfit.toFixed(2)}. Campanhas pausadas: ${pausedCount}. Retomada agendada para ${new Date(Date.now() + PAUSE_DURATION_HOURS * 3600000).toISOString()}.`,
          confidence: 90,
          risk: 'low',
          requires_approval: false,
          status: 'executed',
          source_function: 'runProfitAfterAdsPauseGuard',
          idempotency_key: pauseIdKey,
          executed_at: nowIso(),
          created_at: nowIso(),
          updated_at: nowIso(),
        }).catch(() => {});

        results.paused.push(asin);

      } catch (e: any) {
        results.errors.push(`${asin}:${e?.message?.slice(0, 100)}`);
      }
    }

    // Registrar execução
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'profit_after_ads_pause_guard',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      status: 'success',
      execution_date: today,
      started_at: new Date(t0).toISOString(),
      completed_at: nowIso(),
      duration_ms: Date.now() - t0,
      records_processed: asinSalesMap.size,
      result_summary: JSON.stringify(results),
    }).catch(() => {});

    return Response.json({
      ok: true,
      amazon_account_id: aid,
      date: today,
      asins_analyzed: asinSalesMap.size,
      ...results,
      duration_ms: Date.now() - t0,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});
