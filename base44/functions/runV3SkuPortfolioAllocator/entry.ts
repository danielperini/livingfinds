import {
  createClientFromRequest,
} from 'npm:@base44/sdk@0.8.40';

function n(v:any, fallback=0):number {
  const x=Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function cid(c:any):string {
  return String(
    c.amazon_campaign_id ||
    c.campaign_id ||
    c.id ||
    ''
  );
}

function name(c:any):string {
  return String(
    c.name ||
    c.campaign_name ||
    ''
  );
}

function state(c:any):string {
  return String(
    c.state ||
    c.status ||
    ''
  ).toUpperCase();
}

function enabled(c:any):boolean {
  return [
    'ENABLED',
    'ACTIVE',
    'RUNNING',
    'IN_INSERTION',
  ].includes(
    state(c)
  );
}

function auto(c:any):boolean {
  return (
    String(
      c.targeting_type ||
      ''
    ).toUpperCase() ===
      'AUTO'
    ||
    name(c)
      .toUpperCase()
      .includes('AUTO')
  );
}

function asinOf(c:any):string {
  return String(
    c.asin ||
    c.advertised_asin ||
    ''
  ).toUpperCase();
}

function clamp(
  x:number,
  lo:number,
  hi:number,
):number {
  return Math.min(
    hi,
    Math.max(lo,x)
  );
}

function round2(x:number):number {
  return Math.round(
    (x+1e-9)*100
  )/100;
}

Deno.serve(async req => {

  const started=Date.now();

  try {

    const base44=
      createClientFromRequest(req);

    const body=
      await req.json()
        .catch(() => ({}));

    const dryRun=
      body.dry_run === true;

    const accounts=
      body.amazon_account_id
        ? await base44.asServiceRole
            .entities.AmazonAccount
            .filter(
              {id:body.amazon_account_id},
              undefined,
              1
            )

        : await base44.asServiceRole
            .entities.AmazonAccount
            .filter(
              {status:'connected'},
              '-updated_at',
              20
            );

    const reports:any[]=[];

    for(const account of accounts) {

      const aid=String(account.id);

      const [
        products,
        campaigns,
        metrics,
        settingsRows,
      ]=await Promise.all([

        base44.asServiceRole
          .entities.Product
          .filter(
            {amazon_account_id:aid},
            undefined,
            3000
          )
          .catch(() => []),

        base44.asServiceRole
          .entities.Campaign
          .filter(
            {amazon_account_id:aid},
            '-updated_at',
            6000
          )
          .catch(() => []),

        base44.asServiceRole
          .entities.CampaignMetricsDaily
          .filter(
            {amazon_account_id:aid},
            '-date',
            30000
          )
          .catch(() => []),

        base44.asServiceRole
          .entities.PerformanceSettings
          .filter(
            {amazon_account_id:aid},
            '-updated_at',
            1
          )
          .catch(() => []),
      ]);

      const settings=
        settingsRows[0] || {};

      const targetAcos=
        n(
          settings.target_acos,
          20
        );

      const maxAcos=
        n(
          settings.max_acos ||
          settings.maximum_acos,
          25
        );

      const accountDailyCap=
        n(
          settings.daily_budget_cap ||
          settings.account_budget_cap,
          0
        );

      const minSkuBudget=
        Math.max(
          3,
          n(
            settings.minimum_campaign_budget,
            5
          )
        );

      /*
       * =============================================
       * AGREGAÇÃO 14d POR CAMPANHA
       * =============================================
       */

      const cutoff=
        new Date(
          Date.now() -
          14*86400000
        )
        .toISOString()
        .slice(0,10);

      const perf=
        new Map<string,any>();

      for(const row of metrics) {

        if(
          String(row.date || '') <
          cutoff
        )
          continue;

        const id=
          String(
            row.campaign_id ||
            row.amazon_campaign_id ||
            ''
          );

        if(!id)
          continue;

        if(!perf.has(id)) {
          perf.set(id,{
            impressions:0,
            clicks:0,
            spend:0,
            orders:0,
            sales:0,
          });
        }

        const p=perf.get(id);

        p.impressions +=
          n(row.impressions);

        p.clicks +=
          n(row.clicks);

        p.spend +=
          n(row.spend || row.cost);

        p.orders +=
          n(row.orders || row.purchases);

        p.sales +=
          n(row.sales || row.revenue);
      }

      /*
       * =============================================
       * V3_REMOTE_CAMPAIGN_IDENTITY
       * =============================================
       *
       * A fonte de identidade é o campaign_id Amazon.
       *
       * O banco local pode conter múltiplos registros da
       * mesma campanha após sincronizações/reconciliações.
       * Esses registros NUNCA podem inflar autos_active.
       *
       * Se houver duplicata:
       * - ENABLED prevalece;
       * - depois o registro mais recentemente sincronizado;
       * - uma identidade Amazon entra uma única vez.
       */

      const campaignIdentity = (c:any):string => {
        /*
         * V3_NUMERIC_REMOTE_CAMPAIGN_ID
         *
         * A identidade operacional é o ID remoto Amazon.
         */
        const campaignId=
          String(
            c.campaign_id ||
            ''
          ).trim();

        const amazonCampaignId=
          String(
            c.amazon_campaign_id ||
            ''
          ).trim();

        const numeric=
          /^[0-9]+$/;

        if(numeric.test(campaignId))
          return campaignId;

        if(numeric.test(amazonCampaignId))
          return amazonCampaignId;

        return (
          campaignId ||
          amazonCampaignId
        );
      };

      const campaignFreshness = (c:any):number => {
        const candidates=[
          c.synced_at,
          c.last_sync_at,
          c.updated_at,
          c.updated_date,
          c.created_at,
          c.created_date,
        ];

        for(const value of candidates) {
          if(!value) continue;

          const ts=
            new Date(value)
              .getTime();

          if(Number.isFinite(ts))
            return ts;
        }

        return 0;
      };

      const campaignByRemoteId=
        new Map<string,any>();

      for(const c of campaigns) {

        const remoteId=
          campaignIdentity(c);

        /*
         * Registros sem campaign_id Amazon não participam
         * da contagem operacional.
         */
        if(!remoteId)
          continue;

        const existing=
          campaignByRemoteId
            .get(remoteId);

        if(!existing) {
          campaignByRemoteId.set(
            remoteId,
            c
          );
          continue;
        }

        const currentActive=
          enabled(c);

        const existingActive=
          enabled(existing);

        /*
         * Estado ativo confirmado tem precedência.
         */
        if(
          currentActive &&
          !existingActive
        ) {
          campaignByRemoteId.set(
            remoteId,
            c
          );
          continue;
        }

        /*
         * Se ambos têm o mesmo estado operacional,
         * usar o mais recente.
         */
        if(
          currentActive ===
          existingActive
          &&
          campaignFreshness(c) >
          campaignFreshness(existing)
        ) {
          campaignByRemoteId.set(
            remoteId,
            c
          );
        }
      }

      const canonicalCampaigns=
        [...campaignByRemoteId.values()];

      /*
       * =============================================
       * CAMPANHAS POR ASIN
       * =============================================
       */

      /*
       * V3_EXACT_ASIN_OPERATIONAL_TRUTH
       *
       * Regra:
       *
       * 1. c.asin é vínculo operacional primário.
       * 2. advertised_asin é somente fallback.
       *
       * Isso evita contar campanhas históricas/derivadas
       * duas vezes para o mesmo produto.
       */
      const exactByAsin=
        new Map<string,any[]>();

      const fallbackByAdvertisedAsin=
        new Map<string,any[]>();

      for(const c of canonicalCampaigns) {

        const exact=
          String(
            c.asin ||
            ''
          )
          .trim()
          .toUpperCase();

        const advertised=
          String(
            c.advertised_asin ||
            ''
          )
          .trim()
          .toUpperCase();

        if(exact) {

          if(!exactByAsin.has(exact))
            exactByAsin.set(
              exact,
              []
            );

          exactByAsin
            .get(exact)!
            .push(c);
        }

        if(advertised) {

          if(
            !fallbackByAdvertisedAsin
              .has(advertised)
          )
            fallbackByAdvertisedAsin
              .set(
                advertised,
                []
              );

          fallbackByAdvertisedAsin
            .get(advertised)!
            .push(c);
        }
      }

      const campaignsForAsin = (
        asin:string
      ):any[] => {

        const normalized=
          String(asin || '')
            .trim()
            .toUpperCase();

        const exact=
          exactByAsin.get(
            normalized
          )
          ||
          [];

        /*
         * Se existe vínculo direto, ele é a verdade.
         */
        if(exact.length)
          return exact;

        return (
          fallbackByAdvertisedAsin
            .get(normalized)
          ||
          []
        );
      };

      /*
       * =============================================
       * PRODUTOS ELEGÍVEIS
       * =============================================
       */

      /*
       * ==================================================
       * V3_ELIGIBILITY_RESOLVER
       * ==================================================
       *
       * Campo de estoque AUSENTE não significa estoque zero.
       *
       * Só excluir por estoque quando houver prova explícita
       * de zero.
       *
       * Elegibilidade:
       * - hard false explícito => não elegível
       * - stock explícito = 0 => não elegível
       * - stock desconhecido => mantém elegível para análise
       *   e deixa hard guard canônico validar antes da execução
       */
      const explicitStock = (p:any):number|null => {

        const candidates=[
          p.stock_available,
          p.inventory_available,
          p.quantity,
          p.stock,
          p.available,
          p.available_quantity,
          p.fulfillable_quantity,
          p.inventory_quantity,
        ];

        for(const value of candidates) {

          if(
            value === null ||
            value === undefined ||
            value === ''
          )
            continue;

          const parsed=Number(value);

          if(Number.isFinite(parsed))
            return parsed;
        }

        return null;
      };

      const eligibleProducts=
        products.filter((p:any) => {

          const stock=
            explicitStock(p);

          const explicitlyBlocked=
            p.authorized === false ||
            p.ads_authorized === false ||
            p.is_authorized === false ||
            p.ads_enabled === false ||
            p.listing_active === false ||
            p.buyable === false ||
            p.active === false ||
            String(
              p.status || ''
            )
              .toUpperCase()
              .includes('INACTIVE');

          if(explicitlyBlocked)
            return false;

          /*
           * Zero explícito = hard stock guard.
           */
          if(stock !== null && stock <= 0)
            return false;

          /*
           * Stock desconhecido não pode zerar o portfólio.
           */
          return true;
        });

      const skuRows:any[]=[];

      /*
       * =============================================
       * PONTUAÇÃO DE PORTFÓLIO
       * =============================================
       *
       * Nenhum SKU elegível fica com peso zero.
       *
       * Componentes:
       *
       * 35% rentabilidade
       * 25% vendas
       * 15% conversão
       * 15% oportunidade de exposição
       * 10% estágio/necessidade de aprendizado
       */

      for(const product of eligibleProducts) {

        const asin=
          String(
            product.asin || ''
          ).toUpperCase();

        if(!asin)
          continue;

        const sku=
          String(
            product.sku || ''
          );

        const all=
          campaignsForAsin(
            asin
          );

        const autos=
          all.filter(auto);

        const activeAutos=
          autos.filter(enabled);

        let impressions=0;
        let clicks=0;
        let spend=0;
        let orders=0;
        let sales=0;

        for(const c of all) {

          const m=
            perf.get(cid(c));

          if(!m)
            continue;

          impressions += m.impressions;
          clicks += m.clicks;
          spend += m.spend;
          orders += m.orders;
          sales += m.sales;
        }

        const cpc=
          clicks > 0
            ? spend/clicks
            : 0;

        const cvr=
          clicks > 0
            ? orders/clicks
            : 0;

        const acos=
          sales > 0
            ? spend/sales*100
            : null;

        const roas=
          spend > 0
            ? sales/spend
            : 0;

        /*
         * RENTABILIDADE
         */
        let profitability=0.45;

        if(
          orders > 0 &&
          acos != null
        ) {

          if(acos <= targetAcos)
            profitability=1;

          else if(acos <= maxAcos)
            profitability=0.75;

          else if(
            acos <=
            maxAcos*1.25
          )
            profitability=0.40;

          else
            profitability=0.15;
        }

        /*
         * SALES SCORE
         */
        const salesScore=
          clamp(
            orders/5,
            0.15,
            1
          );

        /*
         * CVR SCORE
         */
        const conversionScore=
          clicks >= 3
            ? clamp(
                cvr/0.10,
                0.15,
                1
              )
            : 0.45;

        /*
         * OPPORTUNITY
         *
         * poucas impressões podem significar
         * oportunidade, não fracasso.
         */
        let opportunity=0.4;

        if(
          impressions < 200
        )
          opportunity=1;

        else if(
          impressions < 800
        )
          opportunity=0.75;

        else if(
          impressions < 2000
        )
          opportunity=0.50;

        else
          opportunity=0.30;

        /*
         * LEARNING NEED
         */
        const learningNeed=
          orders === 0
            ? 1
            : orders === 1
              ? 0.75
              : 0.35;

        let score=
          profitability*0.35 +
          salesScore*0.25 +
          conversionScore*0.15 +
          opportunity*0.15 +
          learningNeed*0.10;

        /*
         * Vencedor comprovado recebe bônus.
         */
        if(
          orders >= 2 &&
          roas >= 4
        ) {
          score *= 1.20;
        }

        /*
         * Waste recebe redução de prioridade,
         * mas NUNCA zero.
         */
        if(
          orders === 0 &&
          clicks >= 8
        ) {
          score *= 0.60;
        }

        score=
          clamp(
            score,
            0.20,
            1.25
          );

        /*
         * =============================================
         * ESCOLHER A MELHOR AUTO
         * =============================================
         */

        /*
         * V3_ACTIVE_KEEPER_PRIORITY
         *
         * Uma campanha pausada com histórico excelente não
         * deve substituir automaticamente uma AUTO que está
         * ativa agora.
         *
         * Primeiro ranquear estado operacional.
         * Depois usar economia/performance.
         */
        const rankedAutos=
          autos
            .map((c:any) => {

              const m=
                perf.get(cid(c)) || {
                  impressions:0,
                  clicks:0,
                  spend:0,
                  orders:0,
                  sales:0,
                };

              const autoAcos=
                m.sales > 0
                  ? m.spend/m.sales*100
                  : null;

              const autoRoas=
                m.spend > 0
                  ? m.sales/m.spend
                  : 0;

              let quality=0;

              quality +=
                m.orders*1000;

              quality +=
                m.sales*10;

              quality +=
                autoRoas*100;

              quality +=
                Math.min(
                  m.impressions,
                  5000
                )/100;

              if(
                autoAcos != null &&
                autoAcos <= targetAcos
              )
                quality += 500;

              /*
               * Grande preferência para estado ativo atual.
               */
              const operationalPriority=
                enabled(c)
                  ? 1
                  : 0;

              return {
                campaign:c,
                quality,
                operationalPriority,
                metrics:m,
              };
            })
            .sort(
              (a:any,b:any) =>
                (
                  b.operationalPriority -
                  a.operationalPriority
                )
                ||
                (
                  b.quality -
                  a.quality
                )
            );

        const bestAuto=
          rankedAutos[0] || null;

        const extraAutos=
          rankedAutos.slice(1);

        skuRows.push({
          asin,
          sku,

          product,

          score,

          impressions,
          clicks,
          spend,
          orders,
          sales,
          cpc,
          cvr,
          acos,
          roas,

          autos_total:
            autos.length,

          autos_active:
            activeAutos.length,

          bestAuto,

          extraAutos,
        });
      }

      /*
       * =============================================
       * DISTRIBUIÇÃO DESIGUAL DE RECURSOS
       * =============================================
       */

      const scoreSum=
        skuRows.reduce(
          (
            sum:number,
            row:any
          ) =>
            sum +
            row.score,
          0
        ) || 1;

      const numberSkus=
        Math.max(
          1,
          skuRows.length
        );

      /*
       * Se não houver account cap configurado,
       * usar soma de budgets existentes como envelope.
       */
      let envelope=
        accountDailyCap;

      if(envelope <= 0) {

        envelope=
          canonicalCampaigns
            .filter(enabled)
            .reduce(
              (
                sum:number,
                c:any
              ) =>
                sum +
                n(
                  c.daily_budget ||
                  c.budget
                ),
              0
            );
      }

      envelope=
        Math.max(
          envelope,
          minSkuBudget *
          numberSkus
        );

      const proposed:any[]=[];

      for(const row of skuRows) {

        /*
         * Todo SKU recebe piso mínimo.
         */
        const floor=
          minSkuBudget;

        const distributable=
          Math.max(
            0,
            envelope -
            floor*numberSkus
          );

        const variable=
          distributable *
          (
            row.score /
            scoreSum
          );

        const skuEnvelope=
          round2(
            floor +
            variable
          );

        /*
         * Sugestão:
         *
         * 40% AUTO discovery
         * 60% MANUAL winner/control
         *
         * Young/sem venda:
         * 55% AUTO / 45% MANUAL
         *
         * Winner:
         * 30% AUTO / 70% MANUAL
         */
        let autoShare=0.40;

        if(row.orders <= 0)
          autoShare=0.55;

        else if(
          row.orders >= 2 &&
          row.roas >= 4
        )
          autoShare=0.30;

        const autoBudget=
          round2(
            skuEnvelope *
            autoShare
          );

        const manualBudget=
          round2(
            skuEnvelope -
            autoBudget
          );

        /*
         * =============================================
         * GARANTIR UMA AUTO
         * =============================================
         */

        if(!row.bestAuto) {

          proposed.push({
            priority:'P1',
            asin:row.asin,
            sku:row.sku,

            action:
              'CREATE_AUTO',

            reason:
              'ELIGIBLE_SKU_WITHOUT_AUTO',

            proposed_budget:
              Math.max(
                minSkuBudget,
                autoBudget
              ),

            score:
              round2(row.score),
          });
        }

        else {

          const best=
            row.bestAuto.campaign;

          if(!enabled(best)) {

            proposed.push({
              priority:'P1',
              asin:row.asin,
              sku:row.sku,

              campaign_id:
                cid(best),

              action:
                'ENABLE_BEST_AUTO',

              reason:
                'BEST_AUTO_NOT_ACTIVE',

              proposed_budget:
                Math.max(
                  minSkuBudget,
                  autoBudget
                ),

              score:
                round2(row.score),
            });
          }

          else {

            proposed.push({
              priority:
                row.orders >= 2
                  ? 'P2'
                  : 'P1',

              asin:row.asin,
              sku:row.sku,

              campaign_id:
                cid(best),

              action:
                'SET_AUTO_BUDGET',

              reason:
                'PORTFOLIO_WEIGHTED_ALLOCATION',

              proposed_budget:
                Math.max(
                  minSkuBudget,
                  autoBudget
                ),

              score:
                round2(row.score),
            });
          }
        }

        /*
         * =============================================
         * MAIS DE UMA AUTO
         * =============================================
         *
         * Somente a melhor permanece.
         *
         * Não pausar antes de provar que existe
         * outra AUTO saudável.
         */
        if(
          row.bestAuto &&
          enabled(
            row.bestAuto.campaign
          )
        ) {

          for(
            const extra
            of row.extraAutos
          ) {

            if(
              !enabled(
                extra.campaign
              )
            )
              continue;

            proposed.push({
              priority:'P2',

              asin:row.asin,
              sku:row.sku,

              campaign_id:
                cid(extra.campaign),

              keep_campaign_id:
                cid(
                  row.bestAuto.campaign
                ),

              action:
                'PAUSE_EXTRA_AUTO',

              reason:
                'ONE_AUTO_PER_SKU_KEEP_BEST',

              quality:
                round2(
                  extra.quality
                ),

              best_quality:
                round2(
                  row.bestAuto.quality
                ),
            });
          }
        }

        /*
         * =============================================
         * MANUALS
         * =============================================
         *
         * Não inventar keywords.
         *
         * Usar harvesting same-SKU.
         */
        proposed.push({
          priority:'P1',

          asin:row.asin,
          sku:row.sku,

          action:
            'RUN_SAME_SKU_HARVEST',

          reason:
            'CONTINUOUS_MANUAL_CAMPAIGN_CREATION',

          manual_budget_envelope:
            Math.max(
              minSkuBudget,
              manualBudget
            ),

          max_terms:
            13,
        });
      }

      /*
       * =============================================
       * EXECUÇÃO CONTROLADA
       * =============================================
       */

      let createdAuto=0;
      let enabledAuto=0;
      let pausedExtra=0;
      let budgetActions=0;
      let harvestRuns=0;

      const execution:any[]=[];

      for(const action of proposed) {

        if(dryRun) {
          execution.push({
            ...action,
            dry_run:true,
          });

          continue;
        }

        /*
         * CREATE / ENABLE / BUDGET
         *
         * Reusar funções existentes.
         */
        if(
          action.action ===
          'CREATE_AUTO'
          ||
          action.action ===
          'ENABLE_BEST_AUTO'
        ) {

          const response=
            await base44.asServiceRole
              .functions.invoke(
                'ensureActiveProductCampaignCoverage',
                {
                  _service_role:true,

                  amazon_account_id:
                    aid,

                  asin:
                    action.asin,

                  sku:
                    action.sku,

                  preferred_budget:
                    action.proposed_budget,

                  force_auto_coverage:
                    true,

                  max_active_auto_per_sku:
                    1,

                  trigger_type:
                    'v3_portfolio_allocator',
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

          execution.push({
            ...action,
            response,
          });

          if(action.action === 'CREATE_AUTO')
            createdAuto++;
          else
            enabledAuto++;

          continue;
        }

        /*
         * BUDGET da melhor AUTO:
         * deixar o V3/gateway canônico aplicar.
         */
        if(
          action.action ===
          'SET_AUTO_BUDGET'
        ) {

          const decision={
            amazon_account_id:
              aid,

            decision_type:
              'portfolio_weighted_budget',

            entity_type:
              'campaign',

            entity_id:
              action.campaign_id,

            campaign_id:
              action.campaign_id,

            asin:
              action.asin,

            action:
              'set_budget',

            value_after:
              action.proposed_budget,

            rationale:
              `V3 SKU Portfolio: distribuição desigual por desempenho/oportunidade. SKU score=${action.score}.`,

            rule_key:
              'V3_SKU_PORTFOLIO_WEIGHTED_ALLOCATION',

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
              'runV3SkuPortfolioAllocator',

            created_at:
              new Date().toISOString(),
          };

          await base44.asServiceRole
            .entities
            .OptimizationDecision
            .create(
              decision
            )
            .catch(() => null);

          budgetActions++;

          continue;
        }

        /*
         * PAUSAR EXTRA AUTO.
         *
         * Somente quando best AUTO está ativa.
         */
        /*
         * V3_TRANSACTIONAL_AUTO_PAUSE_ONLY
         *
         * O allocator pode IDENTIFICAR excesso de AUTO,
         * mas não pode mais enfileirar pause_campaign.
         *
         * A pausa só poderá ser criada pelo reconciliador
         * transacional, depois de:
         *
         * 1. confirmar keeper ativo na Amazon;
         * 2. provar cobertura >=1;
         * 3. pausar lote pequeno;
         * 4. sincronizar Amazon;
         * 5. provar novamente cobertura.
         */
        if(
          action.action ===
          'PAUSE_EXTRA_AUTO'
        ) {

          execution.push({
            ...action,

            execution:
              'PROPOSAL_ONLY',

            pause_created:
              false,

            reason:
              'V3_TRANSACTIONAL_AUTO_PAUSE_ONLY',
          });

          continue;
        }

        /*
         * HARVESTING:
         *
         * AUTO + MANUAL BROAD/PHRASE
         * -> MANUAL EXACT
         * -> confirmar Amazon
         * -> negativa na origem.
         */
        if(
          action.action ===
          'RUN_SAME_SKU_HARVEST'
        ) {

          const response=
            await base44.asServiceRole
              .functions.invoke(
                'runImmediateSameSkuSearchTermHarvest',
                {
                  _service_role:true,

                  amazon_account_id:
                    aid,

                  target_asins:[
                    action.asin
                  ],

                  lookback_days:
                    65,

                  max_promotions:
                    13,

                  include_paused_campaign_history:
                    true,

                  dry_run:false,

                  trigger_type:
                    'v3_portfolio_allocator_harvest',
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

          execution.push({
            ...action,
            response,
          });

          harvestRuns++;
        }
      }

      reports.push({
        amazon_account_id:
          aid,

        eligible_skus:
          skuRows.length,

        account_daily_envelope:
          round2(envelope),

        proposed_actions:
          proposed.length,

        created_auto_requests:
          createdAuto,

        enabled_best_auto:
          enabledAuto,

        pause_extra_auto:
          pausedExtra,

        budget_decisions:
          budgetActions,

        harvest_runs:
          harvestRuns,

        sku_portfolio:
          skuRows.map(
            row => ({
              asin:
                row.asin,

              sku:
                row.sku,

              score:
                round2(
                  row.score
                ),

              orders_14d:
                row.orders,

              sales_14d:
                round2(
                  row.sales
                ),

              spend_14d:
                round2(
                  row.spend
                ),

              acos_14d:
                row.acos != null
                  ? round2(
                      row.acos
                    )
                  : null,

              roas_14d:
                round2(
                  row.roas
                ),

              autos_total:
                row.autos_total,

              autos_active:
                row.autos_active,

              best_auto:
                row.bestAuto
                  ? cid(
                      row.bestAuto
                        .campaign
                    )
                  : null,
            })
          ),

        execution,
      });
    }

    return Response.json({
      ok:true,

      dry_run:
        dryRun,

      policy:
        'equal_attention_unequal_resources_one_active_auto_per_sku_continuous_manual_harvest',

      reports,

      duration_ms:
        Date.now()-started,
    });

  } catch(error:any) {

    return Response.json(
      {
        ok:false,
        error:
          error?.message ||
          String(error),

        duration_ms:
          Date.now()-started,
      },
      {
        status:500
      }
    );
  }
});
