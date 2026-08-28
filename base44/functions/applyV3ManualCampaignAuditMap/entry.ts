import {
  createClientFromRequest,
} from 'npm:@base44/sdk@0.8.40';

function n(
  value:any,
  fallback=0,
):number {
  const parsed=
    Number(value);

  return Number.isFinite(
    parsed
  )
    ? parsed
    : fallback;
}

function money(
  value:number,
):number {
  return (
    Math.round(
      (
        value +
        1e-9
      )
      *
      100
    )
    /
    100
  );
}

function campaignId(
  campaign:any,
):string {
  return String(
    campaign?.campaign_id ||
    campaign?.amazon_campaign_id ||
    campaign?.id ||
    ''
  );
}

function keywordId(
  keyword:any,
):string {
  return String(
    keyword?.keyword_id ||
    keyword?.id ||
    ''
  );
}

function keywordText(
  keyword:any,
):string {
  return String(
    keyword?.keyword_text ||
    keyword?.keyword ||
    ''
  );
}

function isActiveCampaign(
  campaign:any,
):boolean {
  const state=
    String(
      campaign?.state ||
      campaign?.status ||
      ''
    )
      .trim()
      .toUpperCase();

  return (
    state === 'ENABLED' ||
    state === 'ACTIVE' ||
    state === 'RUNNING' ||
    state === 'IN_INSERTION'
  );
}

function isActiveKeyword(
  keyword:any,
):boolean {
  const state=
    String(
      keyword?.state ||
      keyword?.status ||
      ''
    )
      .trim()
      .toUpperCase();

  const match=
    String(
      keyword?.match_type ||
      ''
    )
      .trim()
      .toLowerCase();

  return (
    state !== 'ARCHIVED' &&
    state !== 'PAUSED' &&
    !match.startsWith(
      'negative'
    )
  );
}

function unwrap(
  response:any,
):any {
  return (
    response?.data ||
    response ||
    {}
  );
}

function harvestPromotedCount(
  response:any,
):number {
  const data=
    unwrap(response);

  const reports=
    data?.reports ||
    data?.payload?.reports ||
    [];

  return reports.reduce(
    (
      sum:number,
      row:any
    ) =>
      sum +
      n(
        row?.promoted,
        0
      ),
    0
  );
}

Deno.serve(
  async(request) => {

    const started=
      Date.now();

    try {

      const base44=
        createClientFromRequest(
          request
        );

      const body=
        await request
          .json()
          .catch(
            () => ({})
          );

      if(
        !body._service_role
      ) {

        const authenticated=
          await base44.auth
            .isAuthenticated()
            .catch(
              () => false
            );

        if(
          !authenticated
        ) {
          return Response.json(
            {
              ok:false,
              error:
                'Não autorizado',
            },
            {
              status:401
            }
          );
        }
      }

      const rows=
        Array.isArray(
          body.rows
        )
          ? body.rows
          : [];

      if(
        !rows.length
      ) {
        return Response.json({
          ok:false,
          error:
            'Mapa sem linhas',
        },{
          status:400
        });
      }

      const maxBidDecisions=
        Math.max(
          1,
          Math.min(
            500,
            n(
              body.max_bid_decisions,
              250
            )
          )
        );

      const maxRebuilds=
        Math.max(
          1,
          Math.min(
            50,
            n(
              body.max_rebuilds,
              20
            )
          )
        );

      const grouped=
        new Map<
          string,
          any[]
        >();

      for(
        const row
        of rows
      ) {

        const aid=
          String(
            row.amazon_account_id ||
            ''
          );

        if(!aid)
          continue;

        if(
          !grouped.has(aid)
        ) {
          grouped.set(
            aid,
            []
          );
        }

        grouped
          .get(aid)!
          .push(row);
      }

      const reports:any[]=[];

      for(
        const [
          aid,
          accountRows
        ]
        of grouped
      ) {

        const [
          accounts,
          campaigns,
          keywords,
          products,
          settingsRows,
          existingDecisions,
        ]=
          await Promise.all([

            base44
              .asServiceRole
              .entities
              .AmazonAccount
              .filter(
                {
                  id:aid
                },
                undefined,
                1
              ),

            base44
              .asServiceRole
              .entities
              .Campaign
              .filter(
                {
                  amazon_account_id:
                    aid
                },
                '-updated_at',
                5000
              )
              .catch(
                () => []
              ),

            base44
              .asServiceRole
              .entities
              .Keyword
              .filter(
                {
                  amazon_account_id:
                    aid
                },
                '-updated_at',
                15000
              )
              .catch(
                () => []
              ),

            base44
              .asServiceRole
              .entities
              .Product
              .filter(
                {
                  amazon_account_id:
                    aid
                },
                '-updated_at',
                3000
              )
              .catch(
                () => []
              ),

            base44
              .asServiceRole
              .entities
              .PerformanceSettings
              .filter(
                {
                  amazon_account_id:
                    aid
                },
                '-updated_at',
                1
              )
              .catch(
                () => []
              ),

            base44
              .asServiceRole
              .entities
              .OptimizationDecision
              .filter(
                {
                  amazon_account_id:
                    aid
                },
                '-created_at',
                5000
              )
              .catch(
                () => []
              ),
          ]);

        if(
          !accounts.length
        ) {
          reports.push({
            amazon_account_id:
              aid,
            ok:false,
            error:
              'Conta não encontrada',
          });

          continue;
        }

        const settings=
          settingsRows[0] ||
          {};

        const minBid=
          Math.max(
            0.02,
            n(
              settings.min_bid,
              0.20
            )
          );

        const maxIncrease=
          Math.max(
            0.01,
            Math.min(
              0.30,
              n(
                settings
                  .max_bid_increase_pct,
                20
              ) > 1
                ? n(
                    settings
                      .max_bid_increase_pct,
                    20
                  )
                  /
                  100
                : n(
                    settings
                      .max_bid_increase_pct,
                    0.20
                  )
            )
          );

        const maxDecrease=
          Math.max(
            0.05,
            Math.min(
              0.40,
              n(
                settings
                  .max_bid_decrease_pct,
                15
              ) > 1
                ? n(
                    settings
                      .max_bid_decrease_pct,
                    15
                  )
                  /
                  100
                : n(
                    settings
                      .max_bid_decrease_pct,
                    0.15
                  )
            )
          );

        const campaignById=
          new Map<
            string,
            any
          >();

        for(
          const campaign
          of campaigns
        ) {

          for(
            const id
            of [
              campaign.id,
              campaign.campaign_id,
              campaign.amazon_campaign_id,
            ]
          ) {

            if(id) {
              campaignById.set(
                String(id),
                campaign
              );
            }
          }
        }

        const productByAsin=
          new Map<
            string,
            any
          >();

        for(
          const product
          of products
        ) {

          const asin=
            String(
              product.asin ||
              ''
            )
              .trim()
              .toUpperCase();

          if(asin) {
            productByAsin.set(
              asin,
              product
            );
          }
        }

        const keywordsByCampaign=
          new Map<
            string,
            any[]
          >();

        for(
          const kw
          of keywords
        ) {

          const cid=
            String(
              kw.campaign_id ||
              ''
            );

          if(!cid)
            continue;

          if(
            !keywordsByCampaign
              .has(cid)
          ) {
            keywordsByCampaign
              .set(
                cid,
                []
              );
          }

          keywordsByCampaign
            .get(cid)!
            .push(kw);
        }

        /*
         * Não criar segunda decisão aberta para
         * a mesma keyword.
         */
        const openKeywordIds=
          new Set(
            existingDecisions
              .filter(
                (d:any) => {

                  const status=
                    String(
                      d.status ||
                      ''
                    )
                      .toLowerCase();

                  return [
                    'approved',
                    'scheduled',
                    'processing',
                    'pending',
                    'retry',
                  ].includes(
                    status
                  );
                }
              )
              .map(
                (d:any) =>
                  String(
                    d.keyword_id ||
                    d.entity_id ||
                    ''
                  )
              )
              .filter(Boolean)
          );

        const bidDecisions:any[]=[];

        const skipped:any[]=[];

        const rebuildResults:any[]=[];

        let rebuildCount=0;

        for(
          const row
          of accountRows
        ) {

          const recommendation=
            String(
              row.recommendation ||
              ''
            );

          const cid=
            String(
              row.campaign_id ||
              ''
            );

          const asin=
            String(
              row.asin ||
              ''
            )
              .trim()
              .toUpperCase();

          const campaign=
            campaignById.get(
              cid
            );

          /*
           * ============================================
           * BID ADJUSTMENT
           * ============================================
           */
          if(
            recommendation ===
              'INCREASE_BID_FOR_IMPRESSIONS'
            ||
            recommendation ===
              'REDUCE_BID'
          ) {

            if(
              !campaign
            ) {

              skipped.push({
                campaign_id:cid,
                asin,
                reason:
                  'CAMPAIGN_NOT_FOUND',
              });

              continue;
            }

            if(
              !isActiveCampaign(
                campaign
              )
            ) {

              skipped.push({
                campaign_id:cid,
                asin,
                reason:
                  'CAMPAIGN_NOT_ACTIVE',
              });

              continue;
            }

            const activeKeywords=
              (
                keywordsByCampaign
                  .get(cid)
                ||
                []
              )
                .filter(
                  isActiveKeyword
                );

            if(
              !activeKeywords.length
            ) {

              skipped.push({
                campaign_id:cid,
                asin,
                reason:
                  'NO_ACTIVE_KEYWORDS_REBUILD_REQUIRED',
              });

              continue;
            }

            const currentBids=
              activeKeywords
                .map(
                  (kw:any) =>
                    n(
                      kw.bid ||
                      kw.current_bid,
                      0
                    )
                )
                .filter(
                  (bid:number) =>
                    bid > 0
                );

            if(
              !currentBids.length
            ) {

              skipped.push({
                campaign_id:cid,
                asin,
                reason:
                  'CURRENT_BIDS_MISSING',
              });

              continue;
            }

            const currentAverage=
              currentBids.reduce(
                (
                  sum:number,
                  bid:number
                ) =>
                  sum +
                  bid,
                0
              )
              /
              currentBids.length;

            const desiredAverage=
              n(
                row.proposed_bid,
                0
              );

            if(
              desiredAverage <= 0
            ) {

              skipped.push({
                campaign_id:cid,
                asin,
                reason:
                  'PROPOSED_AVERAGE_BID_MISSING',
              });

              continue;
            }

            let ratio=
              desiredAverage /
              currentAverage;

            /*
             * Segunda barreira:
             * respeitar máximo de movimento configurado.
             */
            if(
              recommendation ===
                'INCREASE_BID_FOR_IMPRESSIONS'
            ) {

              ratio=
                Math.min(
                  ratio,
                  1 +
                  maxIncrease
                );

              if(
                ratio <=
                1.001
              ) {
                continue;
              }
            }

            else {

              ratio=
                Math.max(
                  ratio,
                  1 -
                  maxDecrease
                );

              if(
                ratio >=
                0.999
              ) {
                continue;
              }
            }

            /*
             * O mapa já calculou o teto da fase.
             *
             * YOUNG pode ficar acima do teto-base,
             * mas nunca acima do effective_phase_ceiling.
             */
            const phaseCeiling=
              n(
                row.effective_phase_ceiling,
                0
              );

            for(
              const kw
              of activeKeywords
            ) {

              if(
                bidDecisions.length >=
                maxBidDecisions
              )
                break;

              const kid=
                keywordId(
                  kw
                );

              if(!kid)
                continue;

              if(
                openKeywordIds.has(
                  kid
                )
              ) {

                skipped.push({
                  campaign_id:cid,
                  keyword_id:kid,
                  reason:
                    'OPEN_DECISION_ALREADY_EXISTS',
                });

                continue;
              }

              const before=
                n(
                  kw.bid ||
                  kw.current_bid,
                  0
                );

              if(
                before <= 0
              )
                continue;

              let after=
                before *
                ratio;

              if(
                recommendation ===
                  'INCREASE_BID_FOR_IMPRESSIONS'
                &&
                phaseCeiling > 0
              ) {

                after=
                  Math.min(
                    after,
                    phaseCeiling
                  );
              }

              after=
                Math.max(
                  minBid,
                  after
                );

              after=
                money(
                  after
                );

              if(
                Math.abs(
                  after -
                  before
                ) <
                0.01
              )
                continue;

              const now=
                new Date()
                  .toISOString();

              const direction=
                after >
                before
                  ? 'UP'
                  : 'DOWN';

              const rule=
                recommendation ===
                  'REDUCE_BID'
                  ? 'MANUAL_PORTFOLIO_SPEND_CONTROL_V3'
                  : 'MANUAL_PORTFOLIO_VISIBILITY_RECOVERY_V3';

              const key=
                [
                  rule,
                  aid,
                  cid,
                  kid,
                  money(before),
                  after,
                  row.recommendation,
                ].join('|');

              bidDecisions.push({
                amazon_account_id:
                  aid,

                run_id:
                  `MANUAL_MAP_${Date.now()}`,

                decision_type:
                  direction === 'UP'
                    ? 'increase_bid_profitable_growth'
                    : 'reduce_bid_spend_control',

                entity_type:
                  'keyword',

                entity_id:
                  kid,

                campaign_id:
                  cid,

                keyword_id:
                  kid,

                keyword_text:
                  keywordText(
                    kw
                  ),

                asin,

                action:
                  'set_bid',

                value_before:
                  money(
                    before
                  ),

                value_after:
                  after,

                rationale:
                  direction === 'UP'
                    ? (
                        `Auditoria V3 MANUAL: baixa exposição. ` +
                        `Keyword ${keywordText(kw)} ajustada de ` +
                        `R$${money(before).toFixed(2)} para ` +
                        `R$${after.toFixed(2)} para buscar mais impressões, ` +
                        `respeitando o teto da fase ` +
                        `${phaseCeiling > 0 ? `R$${phaseCeiling.toFixed(2)}` : 'calculado pelo motor'}.`
                      )
                    : (
                        `Auditoria V3 MANUAL: gasto excessivo. ` +
                        `Keyword ${keywordText(kw)} ajustada de ` +
                        `R$${money(before).toFixed(2)} para ` +
                        `R$${after.toFixed(2)} para reduzir velocidade de gasto.`
                      ),

                rule_key:
                  rule,

                risk:
                  direction === 'UP'
                    ? 'medium'
                    : 'low',

                confidence:
                  92,

                status:
                  'approved',

                approval_status:
                  'auto_approved',

                autopilot_authorized:
                  true,

                requires_approval:
                  false,

                execution_mode:
                  'STANDARD_QUEUE',

                confirmation_required:
                  true,

                source_function:
                  'applyV3ManualCampaignAuditMap',

                idempotency_key:
                  key,

                created_at:
                  now,

                next_review_days:
                  direction === 'UP'
                    ? 1
                    : 0.125,

                model_version:
                  'CANONICAL_PROFIT_ENGINE_V3',

                intervention_state:
                  direction === 'UP'
                    ? 'VISIBILITY_RECOVERY'
                    : 'SPEND_CONTROL',

                current_cpc:
                  n(
                    row.cpc_7d,
                    0
                  ),

                current_acos:
                  n(
                    row.acos_7d,
                    0
                  ),
              });

              openKeywordIds.add(
                kid
              );
            }

            continue;
          }

          /*
           * ============================================
           * REBUILD / STRUCTURE RECOVERY
           * ============================================
           */
          if(
            recommendation ===
              'REBUILD_MANUAL_CAMPAIGN'
            ||
            recommendation ===
              'YOUNG_STRUCTURE_RECOVERY'
          ) {

            if(
              rebuildCount >=
              maxRebuilds
            ) {

              skipped.push({
                campaign_id:cid,
                asin,
                reason:
                  'MAX_REBUILDS_PER_RUN',
              });

              continue;
            }

            if(!asin) {

              skipped.push({
                campaign_id:cid,
                reason:
                  'ASIN_REQUIRED_FOR_REBUILD',
              });

              continue;
            }

            const product=
              productByAsin.get(
                asin
              );

            if(!product) {

              skipped.push({
                campaign_id:cid,
                asin,
                reason:
                  'PRODUCT_NOT_FOUND',
              });

              continue;
            }

            /*
             * Nunca inventar keyword.
             *
             * Pedir ao harvesting os melhores Search Terms
             * históricos daquele mesmo ASIN.
             *
             * A própria função:
             * - verifica same-SKU
             * - evita EXACT duplicada
             * - calcula safe bid
             * - cria MANUAL EXACT
             * - só depois cria negativa na origem.
             */
            const harvestResponse=
              await base44
                .asServiceRole
                .functions
                .invoke(
                  'runImmediateSameSkuSearchTermHarvest',
                  {
                    _service_role:true,

                    amazon_account_id:
                      aid,

                    dry_run:false,

                    lookback_days:65,

                    max_promotions:13,

                    target_asins:[
                      asin
                    ],

                    include_paused_campaign_history:
                      true,

                    trigger_type:
                      recommendation ===
                        'YOUNG_STRUCTURE_RECOVERY'
                        ? 'manual_young_structure_recovery'
                        : 'manual_campaign_rebuild',
                  }
                )
                .catch(
                  (error:any) => ({
                    ok:false,
                    error:
                      error?.message ||
                      String(error),
                  })
                );

            const promoted=
              harvestPromotedCount(
                harvestResponse
              );

            rebuildResults.push({
              campaign_id:
                cid,

              asin,

              recommendation,

              promoted,

              status:
                promoted > 0
                  ? 'DESTINATION_CREATED'
                  : 'WAITING_FOR_VALID_HARVEST_TERM',

              /*
               * Muito importante:
               * campanha antiga NÃO é pausada aqui.
               *
               * Primeiro o destino novo precisa existir.
               */
              old_campaign_paused:
                false,

              harvest_response:
                unwrap(
                  harvestResponse
                ),
            });

            rebuildCount++;

            continue;
          }

          /*
           * ============================================
           * YOUNG/HOLD
           * ============================================
           *
           * Não gerar uma alteração artificial.
           * O ciclo diário V3 continuará reavaliando.
           */
          skipped.push({
            campaign_id:cid,
            asin,
            recommendation,
            reason:
              'OBSERVATION_ONLY',
          });
        }

        /*
         * Persistir decisões de BID na fila canônica.
         */
        let saved=0;

        for(
          let i=0;
          i<bidDecisions.length;
          i+=50
        ) {

          const batch=
            bidDecisions.slice(
              i,
              i+50
            );

          if(
            !batch.length
          )
            continue;

          await base44
            .asServiceRole
            .entities
            .OptimizationDecision
            .bulkCreate(
              batch
            );

          saved+=
            batch.length;
        }

        reports.push({
          amazon_account_id:
            aid,

          ok:true,

          rows_received:
            accountRows.length,

          bid_decisions_created:
            saved,

          bid_increases:
            bidDecisions.filter(
              d =>
                n(
                  d.value_after
                ) >
                n(
                  d.value_before
                )
            ).length,

          bid_reductions:
            bidDecisions.filter(
              d =>
                n(
                  d.value_after
                ) <
                n(
                  d.value_before
                )
            ).length,

          rebuilds_attempted:
            rebuildCount,

          rebuilds_with_destination:
            rebuildResults.filter(
              r =>
                r.promoted >
                0
            ).length,

          rebuilds_waiting_term:
            rebuildResults.filter(
              r =>
                r.promoted <=
                0
            ).length,

          rebuild_results:
            rebuildResults,

          skipped,
        });
      }

      return Response.json({
        ok:true,

        engine:
          'CANONICAL_PROFIT_ENGINE_V3',

        policy:
          'manual_portfolio_map_executor_v1',

        reports,

        duration_ms:
          Date.now() -
          started,
      });

    }

    catch(error:any) {

      return Response.json(
        {
          ok:false,

          error:
            error?.message ||
            String(error),

          duration_ms:
            Date.now() -
            started,
        },
        {
          status:500
        }
      );
    }
  }
);
