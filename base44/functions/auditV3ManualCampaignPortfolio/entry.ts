import {
  createClientFromRequest,
} from 'npm:@base44/sdk@0.8.40';

const DAY =
  24 * 60 * 60 * 1000;

function n(v:any):number {
  const x=Number(v);
  return Number.isFinite(x)
    ? x
    : 0;
}

function isoMs(v:any):number {
  if(!v)
    return 0;

  const ms=
    new Date(v).getTime();

  return Number.isFinite(ms)
    ? ms
    : 0;
}

function campaignId(c:any):string {
  return String(
    c.amazon_campaign_id ||
    c.campaign_id ||
    c.id ||
    ''
  );
}

function campaignName(c:any):string {
  return String(
    c.name ||
    c.campaign_name ||
    ''
  );
}

function isManual(c:any):boolean {
  const targeting=
    String(
      c.targeting_type ||
      ''
    ).toUpperCase();

  const name=
    campaignName(c)
      .toUpperCase();

  return (
    targeting === 'MANUAL'
    ||
    name.includes(
      'MANUAL'
    )
  );
}

function enabled(c:any):boolean {
  const state=
    String(
      c.state ||
      c.status ||
      ''
    )
      .toUpperCase();

  return (
    state === 'ENABLED'
    ||
    state === 'ACTIVE'
    ||
    state === 'RUNNING'
    ||
    state === 'IN_INSERTION'
  );
}

function createdMs(c:any):number {
  return Math.max(
    isoMs(c.created_at),
    isoMs(c.created_date),
    isoMs(c.start_date),
    isoMs(c.creation_date)
  );
}

type Window = {
  impressions:number;
  clicks:number;
  spend:number;
  orders:number;
  sales:number;
};

function emptyWindow():Window {
  return {
    impressions:0,
    clicks:0,
    spend:0,
    orders:0,
    sales:0,
  };
}

function derive(w:Window) {
  return {
    ...w,

    cpc:
      w.clicks > 0
        ? w.spend /
          w.clicks
        : 0,

    ctr:
      w.impressions > 0
        ? w.clicks /
          w.impressions
        : 0,

    cvr:
      w.clicks > 0
        ? w.orders /
          w.clicks
        : 0,

    acos:
      w.sales > 0
        ? w.spend /
          w.sales *
          100
        : null,

    roas:
      w.spend > 0
        ? w.sales /
          w.spend
        : 0,
  };
}

Deno.serve(
  async(req) => {

    const started=
      Date.now();

    try {

      const base44=
        createClientFromRequest(
          req
        );

      const body=
        await req
          .json()
          .catch(
            () => ({})
          );

      const accounts=
        body.amazon_account_id
          ? await base44
              .asServiceRole
              .entities
              .AmazonAccount
              .filter(
                {
                  id:
                    body.amazon_account_id
                },
                undefined,
                1
              )

          : await base44
              .asServiceRole
              .entities
              .AmazonAccount
              .list(
                '-created_date',
                20
              );

      const now=
        Date.now();

      const cutoff48h=
        now -
        48 * 60 * 60 * 1000;

      const cutoff3=
        new Date(
          now -
          3 * DAY
        )
          .toISOString()
          .slice(0,10);

      const cutoff7=
        new Date(
          now -
          7 * DAY
        )
          .toISOString()
          .slice(0,10);

      const cutoff14=
        new Date(
          now -
          14 * DAY
        )
          .toISOString()
          .slice(0,10);

      const cutoff30=
        new Date(
          now -
          30 * DAY
        )
          .toISOString()
          .slice(0,10);

      const reports:any[]=[];

      for(
        const account
        of accounts
      ) {

        const aid=
          String(
            account.id
          );

        const [
          campaigns,
          keywords,
          metrics,
          products,
          performance,
          autopilot,
          decisions,
          executions,
        ]=
          await Promise.all([

            base44
              .asServiceRole
              .entities
              .Campaign
              .filter(
                {
                  amazon_account_id:
                    aid
                },
                undefined,
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
                undefined,
                15000
              )
              .catch(
                () => []
              ),

            base44
              .asServiceRole
              .entities
              .CampaignMetricsDaily
              .filter(
                {
                  amazon_account_id:
                    aid
                },
                '-date',
                30000
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
                undefined,
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
              .AutopilotConfig
              .filter(
                {
                  amazon_account_id:
                    aid
                },
                undefined,
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
                10000
              )
              .catch(
                () => []
              ),

            base44
              .asServiceRole
              .entities
              .RuleExecution
              .filter(
                {
                  amazon_account_id:
                    aid
                },
                '-created_date',
                10000
              )
              .catch(
                () => []
              ),
          ]);

        const cfg=
          performance[0] ||
          autopilot[0] ||
          {};

        const targetCpc=
          n(
            cfg.target_cpc
          );

        const maxCpc=
          n(
            cfg.max_cpc ||
            cfg.maximum_cpc
          );

        const configuredMaxBid=
          n(
            cfg.max_bid
          );

        const targetAcos=
          n(
            cfg.target_acos
          );

        const maxAcos=
          n(
            cfg.max_acos ||
            cfg.maximum_acos
          );

        const maxIncrease=
          Math.max(
            0.05,
            Math.min(
              0.20,
              n(
                cfg.max_bid_increase_pct
              ) > 1
                ? n(
                    cfg.max_bid_increase_pct
                  ) / 100
                : n(
                    cfg.max_bid_increase_pct
                  )
                  || 0.10
            )
          );

        const maxDecrease=
          Math.max(
            0.10,
            Math.min(
              0.25,
              n(
                cfg.max_bid_decrease_pct
              ) > 1
                ? n(
                    cfg.max_bid_decrease_pct
                  ) / 100
                : n(
                    cfg.max_bid_decrease_pct
                  )
                  || 0.15
            )
          );

        const productByAsin=
          new Map(
            products
              .filter(
                (p:any) =>
                  p.asin
              )
              .map(
                (p:any) => [
                  String(
                    p.asin
                  ),
                  p
                ]
              )
          );

        const windowByCampaign=
          new Map<
            string,
            {
              d3:Window;
              d7:Window;
              d14:Window;
              d30:Window;
            }
          >();

        for(
          const row
          of metrics
        ) {

          const cid=
            String(
              row.campaign_id ||
              row.amazon_campaign_id ||
              ''
            );

          if(!cid)
            continue;

          if(
            !windowByCampaign
              .has(cid)
          ) {
            windowByCampaign
              .set(
                cid,
                {
                  d3:
                    emptyWindow(),
                  d7:
                    emptyWindow(),
                  d14:
                    emptyWindow(),
                  d30:
                    emptyWindow(),
                }
              );
          }

          const entry=
            windowByCampaign
              .get(cid)!;

          const date=
            String(
              row.date ||
              ''
            );

          const add=(
            w:Window
          ) => {
            w.impressions +=
              n(
                row.impressions
              );

            w.clicks +=
              n(
                row.clicks
              );

            w.spend +=
              n(
                row.spend ||
                row.cost
              );

            w.orders +=
              n(
                row.orders ||
                row.purchases
              );

            w.sales +=
              n(
                row.sales ||
                row.revenue
              );
          };

          if(
            date >= cutoff30
          )
            add(entry.d30);

          if(
            date >= cutoff14
          )
            add(entry.d14);

          if(
            date >= cutoff7
          )
            add(entry.d7);

          if(
            date >= cutoff3
          )
            add(entry.d3);
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

        const recentActionByCampaign=
          new Map<
            string,
            number
          >();

        for(
          const item
          of [
            ...decisions,
            ...executions,
          ]
        ) {

          const cid=
            String(
              item.campaign_id ||
              ''
            );

          if(!cid)
            continue;

          const t=
            Math.max(
              isoMs(
                item.created_at
              ),
              isoMs(
                item.created_date
              ),
              isoMs(
                item.executed_at
              ),
              isoMs(
                item.updated_at
              )
            );

          if(
            t >
            (
              recentActionByCampaign
                .get(cid) ||
              0
            )
          ) {
            recentActionByCampaign
              .set(
                cid,
                t
              );
          }
        }

        const manual=
          campaigns
            .filter(
              (c:any) =>
                isManual(c)
            );

        const rows:any[]=[];

        for(
          const campaign
          of manual
        ) {

          const cid=
            campaignId(
              campaign
            );

          const asin=
            String(
              campaign.asin ||
              campaign.advertised_asin ||
              ''
            );

          const product=
            productByAsin
              .get(asin);

          const w=
            windowByCampaign
              .get(cid)
            ||
            {
              d3:
                emptyWindow(),

              d7:
                emptyWindow(),

              d14:
                emptyWindow(),

              d30:
                emptyWindow(),
            };

          const d3=
            derive(w.d3);

          const d7=
            derive(w.d7);

          const d14=
            derive(w.d14);

          const d30=
            derive(w.d30);

          const created=
            createdMs(
              campaign
            );

          const ageHours=
            created > 0
              ? (
                  now -
                  created
                )
                /
                3600000
              : null;

          const ageDays=
            ageHours != null
              ? ageHours /
                24
              : null;

          const created48h=
            created >=
            cutoff48h;

          const kws=
            keywordsByCampaign
              .get(cid)
            ||
            [];

          const activeKws=
            kws
              .filter(
                (kw:any) => {

                  const mt=
                    String(
                      kw.match_type ||
                      ''
                    )
                      .toLowerCase();

                  const state=
                    String(
                      kw.state ||
                      kw.status ||
                      ''
                    )
                      .toUpperCase();

                  return (
                    !mt.startsWith(
                      'negative'
                    )
                    &&
                    state !==
                      'PAUSED'
                    &&
                    state !==
                      'ARCHIVED'
                  );
                }
              );

          const avgBid=
            activeKws.length
              ? (
                  activeKws
                    .reduce(
                      (
                        sum:number,
                        kw:any
                      ) =>
                        sum +
                        n(
                          kw.bid ||
                          kw.current_bid
                        ),
                      0
                    )
                  /
                  activeKws.length
                )
              : 0;

          const safeEconomic=
            n(
              product?.safe_max_cpc ||
              product?.safe_cpc ||
              product?.break_even_cpc
            );

          const normalConfiguredCeiling=
            Math.min(
              ...[
                configuredMaxBid,
                maxCpc,
              ]
                .filter(
                  x =>
                    x > 0
                )
            );

          const configuredCeiling=
            Number.isFinite(
              normalConfiguredCeiling
            )
              ? normalConfiguredCeiling
              : (
                  configuredMaxBid ||
                  maxCpc ||
                  0
                );

          /*
           * Para a auditoria:
           *
           * YOUNG pode ultrapassar teto-base configurado
           * em até 15%, mas nunca safe econômico.
           */
          const ageYoung=
            ageDays != null &&
            ageDays <= 10;

          const learningCeiling=
            ageYoung &&
            configuredCeiling > 0
              ? configuredCeiling *
                1.15
              : configuredCeiling;

          const effectiveCeiling=
            Math.min(
              ...[
                learningCeiling,
                safeEconomic,
              ]
                .filter(
                  x =>
                    x > 0
                )
            );

          const ceiling=
            Number.isFinite(
              effectiveCeiling
            )
              ? effectiveCeiling
              : (
                  learningCeiling ||
                  safeEconomic ||
                  0
                );

          /*
           * 1. PRECISA MAIS IMPRESSÕES
           */
          const lowExposure=
            enabled(
              campaign
            )
            &&
            d7.impressions <
              200
            &&
            d7.spend <
              Math.max(
                10,
                n(
                  cfg.minimum_campaign_budget
                )
              )
            &&
            (
              d7.orders > 0
              ||
              d7.clicks <= 3
            );

          const canIncrease=
            lowExposure
            &&
            avgBid > 0
            &&
            ceiling > 0
            &&
            avgBid <
              ceiling -
              0.005;

          const proposedIncreaseBid=
            canIncrease
              ? Math.min(
                  ceiling,
                  avgBid *
                  (
                    1 +
                    maxIncrease
                  )
                )
              : null;

          /*
           * 2. GASTO EXCESSIVO
           */
          const cpcAboveSafe=
            safeEconomic > 0
            &&
            d7.cpc >
              safeEconomic *
              1.05
            &&
            d7.clicks >= 2;

          const noSaleWaste=
            d7.orders <= 0
            &&
            d7.clicks >= 4
            &&
            d7.spend >=
              Math.max(
                8,
                targetCpc > 0
                  ? targetCpc *
                    8
                  : 8
              );

          const acosExcess=
            d7.orders > 0
            &&
            d7.acos != null
            &&
            maxAcos > 0
            &&
            d7.acos >
              maxAcos *
              1.15;

          const spendTooHigh=
            cpcAboveSafe
            ||
            noSaleWaste
            ||
            acosExcess;

          const proposedReduceBid=
            spendTooHigh &&
            avgBid > 0
              ? Math.max(
                  0.02,
                  avgBid *
                  (
                    1 -
                    maxDecrease
                  )
                )
              : null;

          /*
           * 4. AUSÊNCIA DE AÇÕES => YOUNG
           *
           * Não é simplesmente "idade".
           *
           * Se a campanha não recebeu ação significativa
           * e ainda possui evidência fraca, ela continua
           * em aprendizado.
           */
          const lastAction=
            recentActionByCampaign
              .get(cid)
            ||
            0;

          const hoursSinceAction=
            lastAction > 0
              ? (
                  now -
                  lastAction
                )
                /
                3600000
              : null;

          const noRecentAction=
            !lastAction
            ||
            hoursSinceAction! >=
              48;

          const evidenceInsufficient=
            d14.orders < 2
            &&
            (
              d14.clicks < 10
              ||
              d14.impressions <
                1000
            );

          const youngByInactivity=
            !created48h
            &&
            noRecentAction
            &&
            evidenceInsufficient
            &&
            enabled(
              campaign
            );

          let priority=
            'P3';

          if(
            spendTooHigh
          )
            priority='P0';

          else if(
            canIncrease
          )
            priority='P1';

          else if(
            created48h
            ||
            youngByInactivity
          )
            priority='P2';

          const recommendation=
            spendTooHigh
              ? 'REDUCE_BID'

              : canIncrease
                ? 'INCREASE_BID_FOR_IMPRESSIONS'

                : created48h
                  ? 'NEW_48H_OBSERVATION'

                  : youngByInactivity
                    ? 'CLASSIFY_YOUNG_BY_INACTIVITY'

                    : 'HOLD';

          rows.push({
            priority,

            campaign_id:
              cid,

            campaign_name:
              campaignName(
                campaign
              ),

            asin,

            sku:
              product?.sku ||
              null,

            enabled:
              enabled(
                campaign
              ),

            age_hours:
              ageHours != null
                ? Number(
                    ageHours
                      .toFixed(1)
                  )
                : null,

            age_days:
              ageDays != null
                ? Number(
                    ageDays
                      .toFixed(1)
                  )
                : null,

            created_last_48h:
              created48h,

            young_by_inactivity:
              youngByInactivity,

            hours_since_last_action:
              hoursSinceAction != null
                ? Number(
                    hoursSinceAction
                      .toFixed(1)
                  )
                : null,

            recommendation,

            d7:{
              impressions:
                d7.impressions,

              clicks:
                d7.clicks,

              spend:
                Number(
                  d7.spend
                    .toFixed(2)
                ),

              orders:
                d7.orders,

              sales:
                Number(
                  d7.sales
                    .toFixed(2)
                ),

              cpc:
                Number(
                  d7.cpc
                    .toFixed(2)
                ),

              ctr_pct:
                Number(
                  (
                    d7.ctr *
                    100
                  )
                    .toFixed(2)
                ),

              cvr_pct:
                Number(
                  (
                    d7.cvr *
                    100
                  )
                    .toFixed(2)
                ),

              acos_pct:
                d7.acos != null
                  ? Number(
                      d7.acos
                        .toFixed(1)
                    )
                  : null,

              roas:
                Number(
                  d7.roas
                    .toFixed(2)
                ),
            },

            d14:{
              impressions:
                d14.impressions,

              clicks:
                d14.clicks,

              spend:
                Number(
                  d14.spend
                    .toFixed(2)
                ),

              orders:
                d14.orders,

              sales:
                Number(
                  d14.sales
                    .toFixed(2)
                ),
            },

            keywords:
              activeKws.length,

            average_bid:
              Number(
                avgBid
                  .toFixed(2)
              ),

            configured_base_ceiling:
              configuredCeiling > 0
                ? Number(
                    configuredCeiling
                      .toFixed(2)
                  )
                : null,

            economic_safe_cpc:
              safeEconomic > 0
                ? Number(
                    safeEconomic
                      .toFixed(2)
                  )
                : null,

            effective_phase_ceiling:
              ceiling > 0
                ? Number(
                    ceiling
                      .toFixed(2)
                  )
                : null,

            proposed_average_bid:
              proposedIncreaseBid != null
                ? Number(
                    proposedIncreaseBid
                      .toFixed(2)
                  )

                : proposedReduceBid != null
                  ? Number(
                      proposedReduceBid
                        .toFixed(2)
                    )

                  : null,

            reasons:{
              low_exposure:
                lowExposure,

              cpc_above_safe:
                cpcAboveSafe,

              no_sale_waste:
                noSaleWaste,

              acos_excess:
                acosExcess,

              no_recent_action:
                noRecentAction,

              insufficient_evidence:
                evidenceInsufficient,
            },
          });
        }

        const sortPriority:any={
          P0:0,
          P1:1,
          P2:2,
          P3:3,
        };

        rows.sort(
          (
            a:any,
            b:any
          ) =>
            sortPriority[
              a.priority
            ]
            -
            sortPriority[
              b.priority
            ]
            ||
            b.d7.spend -
            a.d7.spend
        );

        reports.push({
          amazon_account_id:
            aid,

          manual_campaigns:
            rows.length,

          increase_bid_for_impressions:
            rows.filter(
              r =>
                r.recommendation ===
                'INCREASE_BID_FOR_IMPRESSIONS'
            ),

          reduce_bid_for_spend:
            rows.filter(
              r =>
                r.recommendation ===
                'REDUCE_BID'
            ),

          created_last_48h:
            rows.filter(
              r =>
                r.created_last_48h
            ),

          classify_young_by_inactivity:
            rows.filter(
              r =>
                r.young_by_inactivity
            ),

          all_manual_campaigns:
            rows,

          settings:{
            source:
              performance[0]
                ? 'PerformanceSettings'
                : autopilot[0]
                  ? 'AutopilotConfig'
                  : 'defaults',

            target_cpc:
              targetCpc,

            configured_max_bid:
              configuredMaxBid,

            max_cpc:
              maxCpc,

            target_acos:
              targetAcos,

            maximum_acos:
              maxAcos,

            max_bid_increase_pct:
              maxIncrease,

            max_bid_decrease_pct:
              maxDecrease,
          },
        });
      }

      return Response.json({
        ok:true,

        audit_only:true,

        generated_at:
          new Date()
            .toISOString(),

        definitions:{
          increase_bid:
            'Manual ativa, baixa exposição em 7d, baixo gasto, sem sinal claro de waste e ainda abaixo do teto de fase/safe CPC.',

          reduce_bid:
            'CPC acima do safe CPC, gasto relevante sem venda ou ACoS materialmente acima do máximo.',

          new_48h:
            'Campanha criada nas últimas 48 horas.',

          young_by_inactivity:
            'Campanha fora das primeiras 48h, sem ação relevante recente e ainda sem evidência estatística suficiente.',
        },

        reports,

        duration_ms:
          Date.now() -
          started,
      });

    } catch(error:any) {

      return Response.json(
        {
          ok:false,
          error:
            error?.message ||
            String(error),
        },
        {
          status:500
        }
      );
    }
  }
);
