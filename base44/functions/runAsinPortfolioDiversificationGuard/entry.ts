import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { productAdsEligibility } from '../../shared/productAdsEligibility.ts';

const SOURCE = 'runAsinPortfolioDiversificationGuard';
const finite = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const upper = (value: unknown) => String(value || '').trim().toUpperCase();
const lower = (value: unknown) => String(value || '').trim().toLowerCase();
const active = (value: unknown) => ['enabled', 'active'].includes(lower(value));
const campaignIdOf = (row: any) => String(row.amazon_campaign_id || row.campaign_id || row.id || '');
const roundMoney = (value: number) => Math.round(value * 100) / 100;
const snapshotIsActive = (value: unknown) => !['inactive', 'closed', 'not_found', 'error', 'suppressed'].includes(lower(value));

function brtDate(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

function asinOf(campaign: any, productAds: any[]): string {
  const direct = upper(campaign.asin || campaign.advertised_asin);
  if (direct) return direct;
  const campaignId = campaignIdOf(campaign);
  const ad = productAds.find((row: any) => String(row.campaign_id || '') === campaignId);
  return upper(ad?.asin);
}

function latestByCampaign(rows: any[]): Map<string, any> {
  const sorted = [...rows].sort((a, b) => new Date(String(b.observed_at || b.created_at || 0)).getTime() - new Date(String(a.observed_at || a.created_at || 0)).getTime());
  const map = new Map<string, any>();
  for (const row of sorted) {
    const id = String(row.campaign_id || '');
    if (id && !map.has(id)) map.set(id, row);
  }
  return map;
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    if (![
        'runUnifiedDecisionEngine',
        'runCanonicalProfitEngineV3'
      ].includes(String(body._canonical_orchestrator || ''))) {
      return Response.json({ ok: false, error: 'Uso exclusivo pelo motor canônico' }, { status: 403 });
    }

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, undefined, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 50);
    const results: any[] = [];
    const today = brtDate();

    for (const account of accounts) {
      const accountId = String(account.id);
      const [settingsRows, campaigns, productAds, products, intradayRows, priorDecisions, canonicalSnapshots] = await Promise.all([
        base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: accountId }, '-updated_at', 1).catch(() => []),
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-updated_at', 5000).catch(() => []),
        base44.asServiceRole.entities.ProductAd.filter({ amazon_account_id: accountId }, '-updated_at', 10000).catch(() => []),
        base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, '-updated_at', 5000).catch(() => []),
        base44.asServiceRole.entities.IntradaySpendSnapshot.filter({ amazon_account_id: accountId, spend_date: today }, '-observed_at', 10000).catch(() => []),
        base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: accountId }, '-created_at', 10000).catch(() => []),
        body.snapshot_run_id
          ? base44.asServiceRole.entities.RepricingSnapshot.filter({ amazon_account_id: accountId, run_id: body.snapshot_run_id }, '-created_at', 10000).catch(() => [])
          : base44.asServiceRole.entities.RepricingSnapshot.filter({ amazon_account_id: accountId }, '-created_at', 10000).catch(() => []),
      ]);

      const settings = settingsRows[0] || {};
      const targetAcos = finite(settings.target_acos || settings.acos_target, 15);
      const accountBudget = Math.max(1, finite(settings.account_daily_budget_limit || settings.daily_budget_global || settings.daily_budget, 80));
      const explorationPoolShare = Math.min(0.30, Math.max(0.15, finite(settings.asin_exploration_pool_share, 0.25)));
      const maxAsinShare = Math.min(0.40, Math.max(0.20, finite(settings.max_asin_spend_share, 0.30)));
      const maxWinnerShare = Math.min(0.45, Math.max(maxAsinShare, finite(settings.max_winner_asin_spend_share, 0.35)));
      const minCampaignBudget = Math.max(5, finite(settings.minimum_campaign_budget, 5));
      const maxCampaignBudget = Math.max(minCampaignBudget, finite(settings.maximum_campaign_budget, 100));
      const minEconomicConfidence = Math.min(1, Math.max(0.5, finite(settings.unified_min_economic_confidence, 90) / 100));
      const latest = latestByCampaign(intradayRows);
      const productByAsin = new Map(products.filter((p: any) => p.asin).map((p: any) => [upper(p.asin), p]));
      const snapshotFor = (product: any, asin: string) => canonicalSnapshots.find((snapshot: any) =>
        (product?.sku && upper(snapshot.sku) === upper(product.sku)) || upper(snapshot.asin) === asin
      ) || null;
      /*
       * PRODUCT ELIGIBILITY V3
       *
       * Separamos três dimensões:
       *
       * 1. estoque;
       * 2. listing/offer ativo;
       * 3. buyability.
       *
       * Snapshot Amazon recente prevalece sobre status local antigo.
       * Portanto um produto com estoque 72 não será automaticamente
       * tratado como PRODUCT_INACTIVE se Amazon comprovar listing/offer
       * ativos e buyable.
       */
      const effectiveEligibility = (product: any, asin: string) => {
        const local = productAdsEligibility(product);
        const snapshot = snapshotFor(product, asin);

        const localStock = Math.max(
          0,
          finite(local.stock),
          finite(product?.fulfillable_quantity),
          finite(product?.available_quantity),
          finite(product?.inventory_quantity),
          finite(product?.stock),
          finite(product?.fba_inventory)
        );

        const snapshotStock = Math.max(
          0,
          finite(snapshot?.inventory_available)
        );

        const effectiveStock = Math.max(
          localStock,
          snapshotStock
        );

        const snapshotHasStatus =
          Boolean(snapshot?.listing_status) ||
          Boolean(snapshot?.offer_status);

        const snapshotListingActive =
          snapshotHasStatus
            ? snapshotIsActive(snapshot?.listing_status)
            : null;

        const snapshotOfferActive =
          snapshotHasStatus
            ? snapshotIsActive(snapshot?.offer_status)
            : null;

        const snapshotActive =
          snapshotHasStatus
            ? snapshotListingActive === true &&
              snapshotOfferActive === true
            : null;

        const buyable =
          typeof snapshot?.buyable === 'boolean'
            ? snapshot.buyable
            : product?.listing_buyable !== false;

        const suppressed =
          product?.listing_suppressed === true ||
          lower(snapshot?.listing_status) === 'suppressed';

        /*
         * Snapshot remoto válido tem precedência.
         * Caso contrário usamos a classificação local.
         */
        const effectiveActive =
          snapshotActive !== null
            ? snapshotActive
            : local.active;

        const inStock =
          effectiveStock > 0;

        let reason = 'ELIGIBLE';

        if (!effectiveActive) {
          reason = 'PRODUCT_INACTIVE';
        } else if (!inStock) {
          reason = 'PRODUCT_OUT_OF_STOCK';
        } else if (suppressed) {
          reason = 'LISTING_SUPPRESSED';
        } else if (!buyable) {
          reason = 'LISTING_NOT_BUYABLE';
        }

        return {
          eligible:
            effectiveActive &&
            inStock &&
            !suppressed &&
            buyable,

          active: effectiveActive,
          inStock,
          buyable,
          suppressed,

          stock: effectiveStock,

          reason,

          local_reason: local.reason,

          source:
            snapshotHasStatus
              ? 'CANONICAL_AMAZON_SNAPSHOT'
              : 'LOCAL_PRODUCT',

          snapshot,
        };
      };

      const snapshotBlockers = (snapshot: any, increase: boolean): string[] => {
        if (!snapshot?.id) return ['SNAPSHOT_REQUIRED'];
        const blockers: string[] = [];
        if (snapshot.data_fresh !== true || !snapshot.ads_data_fresh_at || !snapshot.sp_api_data_fresh_at || !snapshot.economics_data_fresh_at) blockers.push('STALE_DATA');
        if (!snapshotIsActive(snapshot.listing_status) || !snapshotIsActive(snapshot.offer_status) || snapshot.buyable !== true || finite(snapshot.inventory_available) <= 0) blockers.push('PRODUCT_NOT_ELIGIBLE');
        if (upper(snapshot.economic_state) === 'ECONOMICS_PENDING') blockers.push('ECONOMICS_INCOMPLETE');
        if (finite(snapshot.economic_confidence) < minEconomicConfidence) blockers.push('LOW_ECONOMIC_CONFIDENCE');
        if (increase && finite(snapshot.stock_coverage_days, 999) < 14) blockers.push('LOW_STOCK_BUDGET_INCREASE');
        return blockers;
      };

      const campaignRows = campaigns.filter((campaign: any) => active(campaign.state || campaign.status) && upper(campaign.campaign_type || 'SP') === 'SP');
      const portfolio = new Map<string, any>();
      const excludedProducts: any[] = [];
      for (const campaign of campaignRows) {
        const asin = asinOf(campaign, productAds);
        if (!asin) continue;
        const product = productByAsin.get(asin);

        const eligibility =
          effectiveEligibility(
            product,
            asin
          );

        if (!eligibility.eligible) {
          excludedProducts.push({
            asin,
            campaign_id: campaignIdOf(campaign),

            reason: eligibility.reason,

            stock: eligibility.stock,

            active: eligibility.active,
            buyable: eligibility.buyable,

            local_reason:
              eligibility.local_reason,

            eligibility_source:
              eligibility.source,
          });

          continue;
        }
        const id = campaignIdOf(campaign);
        const metrics = latest.get(id) || campaign;
        const row = portfolio.get(asin) || { asin, product, campaigns: [], spend: 0, sales: 0, orders: 0, clicks: 0 };
        row.campaigns.push(campaign);
        row.spend += finite(metrics.spend ?? campaign.current_spend ?? campaign.spend);
        row.sales += finite(metrics.sales ?? campaign.sales);
        row.orders += finite(metrics.orders ?? campaign.orders);
        row.clicks += finite(metrics.clicks ?? campaign.clicks);
        portfolio.set(asin, row);
      }

      const rows = [...portfolio.values()];
      const totalSpend = rows.reduce((sum, row) => sum + row.spend, 0);
      /*
       * O pool agora significa:
       * produto realmente elegível para Ads.
       *
       * NÃO significa que o budget deva ser distribuído
       * igualmente entre ASINs.
       */
      const eligibleForExploration = rows.filter((row) => {
        const eligibility =
          effectiveEligibility(
            row.product,
            row.asin
          );

        return eligibility.eligible;
      });

      // Mantido somente no payload legado.
      const floorShare = 0;

      const decisions: any[] = [];
      const observations: any[] = [];
      for (const row of rows) {

        const currentShare =
          totalSpend > 0
            ? row.spend / totalSpend
            : 0;

        const asinAcos =
          row.sales > 0
            ? row.spend / row.sales * 100
            : null;

        const eligibility =
          effectiveEligibility(
            row.product,
            row.asin
          );

        observations.push({
          asin: row.asin,

          spend:
            roundMoney(row.spend),

          sales:
            roundMoney(row.sales),

          orders:
            row.orders,

          acos:
            asinAcos,

          current_share:
            currentShare,

          reference_share:
            maxAsinShare,

          over_concentrated:
            false,

          stock:
            eligibility.stock,

          active:
            eligibility.active,

          buyable:
            eligibility.buyable,

          eligibility_source:
            eligibility.source,

          note:
            'ASIN share is informational only; campaign growth is based on campaign performance.',
        });

        if (!eligibility.eligible) {
          continue;
        }

        /*
         * =====================================================
         * CAMPANHA POR CAMPANHA
         * =====================================================
         *
         * Cada campanha é avaliada pela SUA performance.
         */
        const campaignCandidates:any[] = [];

        for (const campaign of row.campaigns) {

          const campaignId =
            campaignIdOf(campaign);

          if (!campaignId)
            continue;

          const metrics =
            latest.get(campaignId) ||
            campaign;

          const spend =
            finite(
              metrics.spend ??
              campaign.current_spend ??
              campaign.spend
            );

          const sales =
            finite(
              metrics.sales ??
              campaign.sales
            );

          const orders =
            finite(
              metrics.orders ??
              campaign.orders
            );

          const clicks =
            finite(
              metrics.clicks ??
              campaign.clicks
            );

          const impressions =
            finite(
              metrics.impressions ??
              campaign.impressions
            );

          const acos =
            sales > 0
              ? spend / sales * 100
              : null;

          const roas =
            spend > 0
              ? sales / spend
              : 0;

          const cvr =
            clicks > 0
              ? orders / clicks
              : 0;

          const currentBudget =
            finite(
              campaign.daily_budget ||
              campaign.budget
            );

          if (currentBudget <= 0)
            continue;

          const snapshot =
            snapshotFor(
              row.product,
              row.asin
            );

          if (!snapshot?.id) {
            observations.push({
              asin: row.asin,
              campaign_id: campaignId,
              status:
                'DEFERRED_UNTIL_CANONICAL_SNAPSHOT',
              reason:
                'SNAPSHOT_REQUIRED_FOR_PORTFOLIO_BUDGET',
            });

            continue;
          }

          const blockers =
            snapshotBlockers(
              snapshot,
              true
            );

          if (blockers.length > 0) {
            observations.push({
              asin: row.asin,
              campaign_id: campaignId,
              action: 'HOLD',
              blockers,
            });

            continue;
          }

          const breakEvenAcos =
            finite(
              row.product?.break_even_acos_pct,
              0
            );

          /*
           * ECONOMIC CEILING
           *
           * Se temos break-even confirmado, ele é o teto principal.
           * Caso contrário usamos uma tolerância de aprendizado
           * sobre target ACoS.
           */
          const economicAcosCeiling =
            breakEvenAcos > 0
              ? breakEvenAcos * 0.90
              : Math.max(
                  targetAcos * 1.50,
                  targetAcos + 8
                );

          /*
           * Só cresce campanha que já mostrou capacidade de venda.
           *
           * Uma venda já é suficiente para entrar no estágio de
           * crescimento leve.
           */
          const hasSalesProof =
            orders >= 1 &&
            sales > 0;

          if (!hasSalesProof) {
            observations.push({
              asin: row.asin,
              campaign_id: campaignId,
              action: 'HOLD',
              reason:
                'NO_CAMPAIGN_SALES_PROOF_YET',
              spend:
                roundMoney(spend),
              orders,
            });

            continue;
          }

          const economicallyAcceptable =
            (
              acos !== null &&
              acos <= economicAcosCeiling
            )
            ||
            roas >= 2.5;

          if (!economicallyAcceptable) {
            observations.push({
              asin: row.asin,
              campaign_id: campaignId,
              action: 'HOLD',
              reason:
                'CAMPAIGN_ECONOMICS_NOT_READY_FOR_GROWTH',
              acos,
              roas,
              economic_acos_ceiling:
                economicAcosCeiling,
            });

            continue;
          }

          /*
           * =================================================
           * STEP DE CRESCIMENTO
           * =================================================
           *
           * forte       +10%
           * saudável     +8%
           * aprendizado  +5%
           */
          let growthPct = 0.05;
          let reasonCode =
            'CAMPAIGN_PROFITABLE_GROWTH_5';

          const strongWinner =
            (
              acos !== null &&
              acos <= targetAcos * 0.80
            )
            ||
            roas >= 4;

          const healthyWinner =
            (
              acos !== null &&
              acos <= targetAcos * 1.25
            )
            ||
            roas >= 3;

          if (strongWinner) {
            growthPct = 0.10;
            reasonCode =
              'CAMPAIGN_STRONG_WINNER_GROWTH_10';
          } else if (healthyWinner) {
            growthPct = 0.08;
            reasonCode =
              'CAMPAIGN_HEALTHY_WINNER_GROWTH_8';
          }

          /*
           * Score para escolher a melhor campanha do ASIN
           * nesta passagem.
           */
          const score =
            orders * 100 +
            sales +
            roas * 20 +
            cvr * 100 -
            (acos || 0);

          campaignCandidates.push({
            campaign,
            campaignId,
            snapshot,

            spend,
            sales,
            orders,
            clicks,
            impressions,

            acos,
            roas,
            cvr,

            currentBudget,

            growthPct,
            reasonCode,

            score,
          });
        }

        /*
         * Uma campanha por ASIN por passagem.
         *
         * Evita multiplicar simultaneamente todo o compromisso
         * daquele produto.
         */
        campaignCandidates.sort(
          (a,b)=>b.score-a.score
        );

        const best =
          campaignCandidates[0];

        if (!best)
          continue;

        const accountHeadroom =
          roundMoney(
            Math.max(
              0,
              accountBudget - totalSpend
            )
          );

        if (accountHeadroom <= 0.01) {
          observations.push({
            asin: row.asin,
            campaign_id: best.campaignId,
            action: 'HOLD',
            reason:
              'ACCOUNT_BUDGET_HEADROOM_EXHAUSTED',
          });

          continue;
        }

        const action =
          'increase_budget';

        const targetByPerformance =
          roundMoney(
            best.currentBudget *
            (1 + best.growthPct)
          );

        const targetBudget =
          roundMoney(
            Math.min(
              maxCampaignBudget,
              targetByPerformance,
              best.currentBudget +
              accountHeadroom
            )
          );

        if (
          targetBudget <=
          best.currentBudget + 0.01
        ) {
          continue;
        }

        const key =
          `PERFORMANCE_BUDGET|${accountId}|${row.asin}|${best.campaignId}|${today}|${targetBudget.toFixed(2)}`;

        if (
          priorDecisions.some(
            (decision:any)=>
              decision.idempotency_key === key &&
              ![
                'failed',
                'cancelled',
                'rejected',
                'skipped'
              ].includes(
                String(
                  decision.status || ''
                )
              )
          )
        ) {
          continue;
        }

        if (body.dry_run === true) {
          decisions.push({
            asin: row.asin,
            campaign_id:
              best.campaignId,

            action,

            current_budget:
              best.currentBudget,

            target_budget:
              targetBudget,

            growth_pct:
              Math.round(
                best.growthPct * 100
              ),

            orders:
              best.orders,

            sales:
              roundMoney(best.sales),

            spend:
              roundMoney(best.spend),

            acos:
              best.acos,

            roas:
              best.roas,

            stock:
              eligibility.stock,

            reason_code:
              best.reasonCode,

            snapshot_id:
              best.snapshot.id,

            dry_run:true,
          });

          continue;
        }

        const decision =
          await base44.asServiceRole.entities.OptimizationDecision.create({

            amazon_account_id:
              accountId,

            decision_type:
              'budget_optimization',

            entity_type:
              'campaign',

            entity_id:
              best.campaignId,

            campaign_id:
              best.campaignId,

            campaign_name:
              best.campaign.name ||
              best.campaign.campaign_name ||
              null,

            asin:
              row.asin,

            sku:
              row.product?.sku ||
              best.snapshot.sku ||
              null,

            action:
              'increase_budget',

            canonical_action_type:
              'BUDGET_CHANGE',

            snapshot_id:
              best.snapshot.id,

            snapshot_key:
              best.snapshot.snapshot_key ||
              null,

            marketplace_id:
              account.marketplace_id ||
              null,

            profile_id:
              account.ads_profile_id ||
              null,

            rationale:
              `Campanha ${best.campaignId} do ASIN ${row.asin} cresce pela própria performance: ` +
              `${best.orders} pedido(s), vendas R$ ${roundMoney(best.sales)}, gasto R$ ${roundMoney(best.spend)}, ` +
              `ACoS ${best.acos === null ? 'n/a' : best.acos.toFixed(1) + '%'}, ROAS ${best.roas.toFixed(2)}. ` +
              `Budget +${Math.round(best.growthPct * 100)}%. ` +
              `Participação do ASIN no gasto total (${(currentShare * 100).toFixed(1)}%) é apenas informativa.`,

            rule_key:
              best.reasonCode,

            reason_code:
              best.reasonCode,

            value_before:
              best.currentBudget,

            value_after:
              targetBudget,

            current_value:
              best.currentBudget,

            proposed_value:
              targetBudget,

            change_pct:
              roundMoney(
                best.growthPct * 100
              ),

            account_daily_budget_limit:
              accountBudget,

            account_daily_spend:
              roundMoney(totalSpend),

            remaining_account_budget:
              accountHeadroom,

            expected_impact_value:
              roundMoney(
                targetBudget -
                best.currentBudget
              ),

            confidence:
              best.orders >= 2
                ? 0.92
                : 0.82,

            risk:
              best.growthPct >= 0.10
                ? 'medium'
                : 'low',

            requires_approval:false,

            approval_status:
              'auto_approved_performance_growth',

            status:'approved',
            queue_status:'pending',

            priority_class:
              best.orders >= 2
                ? 'P1'
                : 'P2',

            execution_mode:
              'EXPEDITED_QUEUE',

            confirmation_required:true,
            confirmation_status:'pending',

            data_scope_validated:true,
            data_scope_status:'VALID',

            requires_fresh_data:true,
            maximum_data_age_minutes:45,

            metric_window:today,

            decision_window:
              String(
                best.snapshot.decision_window ||
                `performance_budget_${today}`
              ),

            data_window_start:today,
            data_window_end:today,

            precondition_snapshot:
              JSON.stringify({
                snapshot_id:
                  best.snapshot.id,

                snapshot_key:
                  best.snapshot.snapshot_key,

                data_fresh:
                  best.snapshot.data_fresh,

                listing_status:
                  best.snapshot.listing_status,

                offer_status:
                  best.snapshot.offer_status,

                buyable:
                  best.snapshot.buyable,

                inventory_available:
                  best.snapshot.inventory_available,

                economic_confidence:
                  best.snapshot.economic_confidence,
              }),

            rollback_plan:
              JSON.stringify({
                action:'set_budget',
                campaign_id:
                  best.campaignId,

                value:
                  best.currentBudget,

                reason:
                  'performance_budget_rollback',
              }),

            lock_key:
              `performance_budget|${accountId}|${best.campaignId}|${today}`,

            max_attempts:3,

            idempotency_key:key,

            conflict_group:
              `${accountId}|campaign|${best.campaignId}`,

            source_function:
              SOURCE,

            data_used:
              JSON.stringify({
                asin:row.asin,

                campaign_id:
                  best.campaignId,

                orders:
                  best.orders,

                sales:
                  best.sales,

                spend:
                  best.spend,

                acos:
                  best.acos,

                roas:
                  best.roas,

                cvr:
                  best.cvr,

                stock:
                  eligibility.stock,

                eligibility_source:
                  eligibility.source,

                current_share:
                  currentShare,

                share_policy:
                  'INFORMATIONAL_ONLY',

                target_acos:
                  targetAcos,

                growth_pct:
                  best.growthPct,

                snapshot_id:
                  best.snapshot.id,

                snapshot_key:
                  best.snapshot.snapshot_key,
              }),

            created_at:
              new Date().toISOString(),

            updated_at:
              new Date().toISOString(),
          });

        decisions.push({
          asin:row.asin,

          campaign_id:
            best.campaignId,

          action:
            'increase_budget',

          current_budget:
            best.currentBudget,

          target_budget:
            targetBudget,

          growth_pct:
            Math.round(
              best.growthPct * 100
            ),

          reason_code:
            best.reasonCode,

          decision_id:
            decision.id,
        });
      }

      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: accountId,
        sync_type: 'asin_portfolio_diversification',
        status: 'completed',
        source_function: SOURCE,
        records_processed: rows.length,
        records_imported: decisions.length,
        message: `Diversificação automática somente em produtos ativos com estoque: ${eligibleForExploration.length} ASIN(s) elegíveis, ${excludedProducts.length} campanha(s) excluída(s) do esforço por produto inativo/sem estoque/não comprável, piso ${(floorShare * 100).toFixed(1)}% e ${decisions.length} decisão(ões).`,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      }).catch(() => null);

      results.push({ amazon_account_id: accountId, total_spend: roundMoney(totalSpend), eligible_asins: eligibleForExploration.length, excluded_campaigns: excludedProducts, exploration_pool_share: explorationPoolShare, floor_share_per_asin: floorShare, max_asin_share: maxAsinShare, max_winner_share: maxWinnerShare, observations, decisions });
    }

    return Response.json({ ok: true, engine: 'CAMPAIGN_PERFORMANCE_BUDGET_GROWTH_V3', automatic: true, ui_required: false, product_eligibility_policy: 'active_and_in_stock_only', results });
  } catch (error: any) {
    return Response.json({ ok: false, engine: 'CAMPAIGN_PERFORMANCE_BUDGET_GROWTH_V3', error: error?.message || String(error) }, { status: 500 });
  }
});
