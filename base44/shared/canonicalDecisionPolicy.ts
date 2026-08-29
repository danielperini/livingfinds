import { estimateBayesianConversion, probabilityAtLeastOneSale } from './marketplaceDecisionMath.ts';


/*
 * V3_STOCK_COVERAGE_SALES_PRESERVATION
 *
 * Estoque é guardrail, não objetivo de redução de vendas.
 *
 * >10 dias cobertura:
 *   NÃO reduzir bid por estoque.
 *
 * 7-10 dias:
 *   monitorar; decisão continua econômica.
 *
 * 4-6 dias:
 *   redução somente se houver risco concreto de ruptura.
 *
 * 1-3 dias:
 *   desaceleração defensiva permitida.
 *
 * 0:
 *   hard guard / pause.
 */

/*
 * V3_MIN_SAMPLE_SALES_PRESERVATION
 *
 * Não reduzir winner ou campanha promissora por amostra curta.
 *
 * Exemplos:
 * - 1 venda / 1 clique:
 *   winner early signal -> HOLD / possível scale posterior.
 *
 * - CPC alto isolado:
 *   não reduzir sem contexto de conversão e lucro.
 *
 * - ACoS ruim em amostra mínima:
 *   aguardar evidência suficiente salvo gasto destrutivo.
 */

/*
 * V3_BID_BIDIRECTIONAL_CONTRACT
 *
 * O motor NÃO é um motor de redução.
 *
 * Deve haver decisões nos dois sentidos:
 *
 * AUMENTAR BID:
 * - winner com lucro esperado positivo;
 * - ACoS confortavelmente abaixo do teto;
 * - ROAS/CVR saudáveis;
 * - baixa exposição;
 * - estoque suficiente;
 * - safe CPC permite.
 *
 * REDUZIR BID:
 * - waste comprovado;
 * - ACoS/CPC economicamente destrutivo;
 * - gasto alto sem conversão;
 * - risco real de ruptura 1-3 dias.
 *
 * HOLD:
 * - amostra insuficiente;
 * - estoque >10 dias sem outro problema econômico;
 * - early winner ainda sem amostra de scale.
 */
export type CanonicalBidAction =
  | 'HOLD'
  | 'INCREASE'
  | 'DECREASE_SOFT'
  | 'DECREASE_STRONG'
  | 'RECOVER_ZERO_DELIVERY'
  | 'BLOCK'
  | 'REPLACE_TERM'
  | 'PAUSE_CANDIDATE';

export type CanonicalBidInput = {
  currentBid: number;
  safeMaxCpc: number;
  impressions: number;
  clicks: number;
  sameSkuOrders: number;
  haloOrders?: number;
  spend: number;
  maxSpendWithoutSale: number;
  spendShare: number;
  ageHours: number;
  inStock: boolean;
  structurallyComplete: boolean;
  dataFresh: boolean;
  economicsComplete: boolean;
  cooldownActive: boolean;
  pendingInsertion: boolean;
  winnerProtected: boolean;
  lowVolumeGuarded: boolean;
  defensive: boolean;
  isManualExact: boolean;
  adGroupConfirmed: boolean;
  productAdConfirmed: boolean;
  priorReductionCount: number;
  attributionComplete: boolean;
  acos: number | null;
  targetAcos: number | null;
  breakEvenAcos: number | null;
  profitAfterAds: number;
  priorAlpha?: number;
  priorBeta?: number;
};

export type CanonicalBidDecision = {
  action: CanonicalBidAction;
  proposedBid: number | null;
  changePct: number;
  reasonCode: string;
  reason: string;
  confidence: number;
  nextEvaluationHours: number;
  requiresPairedAdGroup: boolean;
  posterior: ReturnType<typeof estimateBayesianConversion>;
  probabilityOfSaleNextExpectedWindow: number;
};

export type GovernanceInput = {
  actionType: string;
  entityType: string;
  currentValue?: number | null;
  proposedValue?: number | null;
  snapshotId?: string | null;
  verifiedEvidenceId?: string | null;
  reasonCode?: string | null;
  reason?: string | null;
  confidence: number;
  predictionConfidence?: number | null;
  economicConfidence?: number | null;
  dataFresh: boolean;
  adsDataFresh?: boolean;
  spApiDataFresh?: boolean;
  economicsDataFresh?: boolean;
  productEligible: boolean;
  listingActive: boolean;
  offerActive: boolean;
  buyable: boolean;
  inStock: boolean;
  stockCoverageDays?: number | null;
  economicsComplete: boolean;
  profitAfterAds?: number | null;
  marginRate?: number | null;
  currentAcos?: number | null;
  targetAcos?: number | null;
  safeMaxCpc?: number | null;
  economicFloor?: number | null;
  competitionFresh?: boolean;
  winnerProtected?: boolean;
  sameSkuOrders?: number;
  haloOrders?: number;
  cooldownActive?: boolean;
  accountKillSwitch?: boolean;
  accountDailyCap?: number | null;
  accountSpend?: number | null;
  reservedPendingSpend?: number | null;
  proposedSpendImpact?: number | null;
  campaignPauseShare?: number | null;
  explicitBatchAuthorization?: boolean;
  defensive?: boolean;
  parentAsin?: boolean;
  rollbackPlan?: string | null;
  maxBidIncreasePct?: number;
  absoluteBidIncreasePct?: number;
  maxBidReductionPct?: number;
  minPredictionConfidence?: number;
  minEconomicConfidence?: number;
};

export type GovernanceResult = {
  allowed: boolean;
  blockers: Array<{ priority: string; code: string; reason: string }>;
  priority: string;
  rollbackRequired: boolean;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const lower = (value: unknown) => String(value || '').trim().toLowerCase();

function bidResult(
  input: CanonicalBidInput,
  posterior: ReturnType<typeof estimateBayesianConversion>,
  action: CanonicalBidAction,
  changePct: number,
  reasonCode: string,
  reason: string,
  confidence: number,
  nextEvaluationHours: number,
): CanonicalBidDecision {
  const bounded = action === 'INCREASE' || action === 'RECOVER_ZERO_DELIVERY'
    ? Math.min(0.15, Math.max(0, changePct))
    : action.startsWith('DECREASE') ? -Math.min(0.20, Math.abs(changePct)) : 0;
  let proposedBid: number | null = null;
  if (bounded !== 0) {
    const raw = input.currentBid * (1 + bounded);

    /*
     * V3_SAFE_CPC_NO_ROUNDING_OVERSHOOT
     *
     * Exemplo:
     * safeMaxCpc real = 0.805
     *
     * roundMoney(0.805) poderia produzir 0.81.
     *
     * Para aumento, o teto monetário precisa ser truncado
     * para baixo em centavos. O motor nunca pode ultrapassar
     * o safe CPC devido apenas a arredondamento.
     */
    const safeMoneyCeiling =
      Math.floor(
        (
          Number(input.safeMaxCpc) +
          1e-9
        ) *
        100
      ) /
      100;

    proposedBid =
      bounded > 0
        ? Math.min(
            roundMoney(raw),
            safeMoneyCeiling
          )
        : Math.max(
            0.02,
            roundMoney(raw)
          );
    const actual = input.currentBid > 0 ? (proposedBid - input.currentBid) / input.currentBid : 0;
    if (bounded > 0 && actual > 0.15) proposedBid = Math.floor(input.currentBid * 1.15 * 100) / 100;
    if (bounded < 0 && -actual > 0.20) proposedBid = Math.ceil(input.currentBid * 0.80 * 100) / 100;
    if (Math.abs(proposedBid - input.currentBid) < 0.005) proposedBid = null;
  }
  const expectedClicks = posterior.mean > 0 ? Math.max(1, Math.ceil(1 / posterior.mean)) : 20;
  return {
    action: proposedBid === null && bounded !== 0 ? 'HOLD' : action,
    proposedBid,
    changePct: proposedBid === null || input.currentBid <= 0 ? 0 : (proposedBid - input.currentBid) / input.currentBid,
    reasonCode: proposedBid === null && bounded !== 0 ? `${reasonCode}_ROUNDING_HOLD` : reasonCode,
    reason,
    confidence,
    nextEvaluationHours,
    requiresPairedAdGroup: input.isManualExact && ['INCREASE', 'DECREASE_SOFT', 'DECREASE_STRONG', 'RECOVER_ZERO_DELIVERY'].includes(action),
    posterior,
    probabilityOfSaleNextExpectedWindow: probabilityAtLeastOneSale(posterior.lower, expectedClicks),
  };
}

export function buildCanonicalBidDecision(
  input: CanonicalBidInput
): CanonicalBidDecision {

  const posterior =
    estimateBayesianConversion({
      clicks: input.clicks,
      orders: input.sameSkuOrders,
      priorAlpha: input.priorAlpha ?? 1,
      priorBeta: input.priorBeta ?? 19,
      sustainableThreshold: 0.05,
    });

  const expectedClicks =
    posterior.mean > 0
      ? Math.max(
          1,
          Math.ceil(1 / posterior.mean)
        )
      : 20;

  const probability =
    probabilityAtLeastOneSale(
      posterior.lower,
      expectedClicks
    );

  const result = (
    action: CanonicalBidAction,
    proposedBid: number | null,
    reasonCode: string,
    reason: string,
    confidence: number,
    nextEvaluationHours: number,
  ): CanonicalBidDecision => {

    const normalized =
      proposedBid === null
        ? null
        : roundMoney(
            Math.max(
              0.02,
              proposedBid
            )
          );

    const actualChange =
      normalized !== null &&
      input.currentBid > 0
        ? (
            normalized -
            input.currentBid
          ) / input.currentBid
        : 0;

    return {
      action:
        normalized !== null &&
        Math.abs(
          normalized-input.currentBid
        ) < 0.005
          ? 'HOLD'
          : action,

      proposedBid:
        normalized !== null &&
        Math.abs(
          normalized-input.currentBid
        ) < 0.005
          ? null
          : normalized,

      changePct:
        normalized !== null
          ? actualChange
          : 0,

      reasonCode,

      reason,

      confidence,

      nextEvaluationHours,

      requiresPairedAdGroup:
        input.isManualExact &&
        [
          'INCREASE',
          'DECREASE_SOFT',
          'DECREASE_STRONG'
        ].includes(action),

      posterior,

      probabilityOfSaleNextExpectedWindow:
        probability,
    };
  };

  const hold = (
    code:string,
    reason:string,
    confidence=95,
    hours=12,
  ) =>
    result(
      'HOLD',
      null,
      code,
      reason,
      confidence,
      hours
    );

  const block = (
    code:string,
    reason:string
  ) =>
    result(
      'BLOCK',
      null,
      code,
      reason,
      99,
      12
    );

  const pctBid = (
    pct:number
  ) =>
    roundMoney(
      Math.max(
        0.02,
        input.currentBid *
        (1+pct)
      )
    );

  const boundedIncrease = (
    pct:number
  ) =>
    roundMoney(
      Math.min(
        input.safeMaxCpc,
        pctBid(pct)
      )
    );

  /*
   * =================================================
   * IDENTIDADE / ESTRUTURA
   * =================================================
   */

  if(input.currentBid<=0)
    return block(
      'CURRENT_BID_MISSING',
      'Bid atual não confirmado.'
    );

  if(input.pendingInsertion)
    return block(
      'PENDING_INSERTION',
      'Entidade ainda está em inserção na Amazon.'
    );

  if(!input.dataFresh)
    return block(
      'STALE_DATA',
      'Métricas Ads atuais são necessárias para decidir.'
    );

  if(
    !input.structurallyComplete ||
    !input.adGroupConfirmed ||
    !input.productAdConfirmed
  )
    return block(
      'STRUCTURE_INCOMPLETE',
      'Estrutura Amazon incompleta.'
    );

  /*
   * ====================================================
   * V3_YOUNG_SPEND_GUARD_ROBUST
   * ====================================================
   *
   * Campanha jovem pode buscar mais impressões.
   * Porém aprendizado não significa gasto sem limite.
   *
   * REGRA A
   * zero venda same-SKU
   * >=2 cliques
   * gasto >=100% maxSpendWithoutSale
   * => BID -15%
   *
   * REGRA B
   * zero venda same-SKU
   * >=2 cliques
   * spendShare >=45%
   * gasto >=75% maxSpendWithoutSale
   * => BID -20%
   *
   * Não pausa.
   */
  const v3YoungSpendLimit =
    input.sameSkuOrders <= 0 &&
    input.clicks >= 2 &&
    input.maxSpendWithoutSale > 0 &&
    input.spend >=
      input.maxSpendWithoutSale;

  const v3YoungSpendConcentration =
    input.sameSkuOrders <= 0 &&
    input.clicks >= 2 &&
    input.maxSpendWithoutSale > 0 &&
    input.spendShare >= 0.45 &&
    input.spend >=
      input.maxSpendWithoutSale * 0.75;

  if (
    v3YoungSpendLimit ||
    v3YoungSpendConcentration
  ) {
    return bidResult(
      input,
      posterior,
      'DECREASE_STRONG',
      v3YoungSpendConcentration
        ? -0.20
        : -0.15,
      'YOUNG_SPEND_VELOCITY_REDUCTION',
      v3YoungSpendConcentration
        ? 'Gasto concentrado sem venda same-SKU: reduzir bid imediatamente em 20%.'
        : 'Gasto atingiu o limite econômico sem venda same-SKU: reduzir bid imediatamente em 15%.',
      97,
      3
    );
  }



  /*
   * =================================================
   * ZERO DELIVERY
   * =================================================
   *
   * OWNER EXCLUSIVO:
   * Campaign Lifecycle Engine.
   *
   * Este policy econômico NÃO cria um segundo
   * recovery concorrente.
   */

  if(
    input.impressions<=0 &&
    input.clicks<=0 &&
    input.spend<=0 &&
    input.sameSkuOrders<=0
  ){
    return hold(
      'DELEGATE_ZERO_DELIVERY_TO_LIFECYCLE',
      'Zero delivery é responsabilidade exclusiva do lifecycle: 72h -> +R$0,10 x3 -> rebuild.',
      99,
      Math.max(
        1,
        input.ageHours < 72
          ? 72-input.ageHours
          : 1
      )
    );
  }

  /*
   * =================================================
   * WASTE FINANCEIRO
   * =================================================
   *
   * Waste tem precedência sobre ACoS quando
   * não há pedidos.
   *
   * Nunca usa spendShare/concentração.
   */

  const provenWaste =
    input.sameSkuOrders<=0 &&
    input.clicks>=12 &&
    input.spend>=5;

  if(provenWaste){

    if(
      input.priorReductionCount>=2 &&
      input.clicks>=20 &&
      input.spend>=15
    ){
      return result(
        'PAUSE_CANDIDATE',
        null,
        'PERSISTENT_WASTE_AFTER_TWO_REDUCTIONS',
        'Desperdício persistente após duas reduções e amostra suficiente.',
        96,
        24
      );
    }

    const reduction =
      input.priorReductionCount>=1
        ? -0.10
        : -0.05;

    return result(
      reduction<=-0.10
        ? 'DECREASE_STRONG'
        : 'DECREASE_SOFT',

      pctBid(reduction),

      input.priorReductionCount>=1
        ? 'ZERO_ORDER_WASTE_SECOND_REDUCTION'
        : 'ZERO_ORDER_WASTE_FIRST_REDUCTION',

      input.priorReductionCount>=1
        ? 'Gasto e cliques persistem sem pedido: segunda redução controlada.'
        : 'Gasto e cliques sem pedido atingiram evidência mínima: primeira redução controlada.',

      input.priorReductionCount>=1
        ? 95
        : 91,

      24
    );
  }

  /*
   * =================================================
   * LEARNING
   * =================================================
   */

  if(
    input.ageHours<72 &&
    input.sameSkuOrders<=0
  ){
    return hold(
      'INITIAL_LEARNING_72H',
      'Campanha ainda está na janela inicial de aprendizado.',
      97,
      Math.max(
        1,
        72-input.ageHours
      )
    );
  }

  /*
   * =================================================
   * IMPRESSÕES SEM CLIQUE
   * =================================================
   */

  if(
    input.impressions>0 &&
    input.clicks<=0
  ){

    if(input.impressions>=500){
      return result(
        'DECREASE_SOFT',
        pctBid(-0.05),
        'MATURE_IMPRESSIONS_NO_CLICK',
        'Amostra madura de impressões sem clique: reduzir 5%.',
        88,
        24
      );
    }

    return hold(
      'IMPRESSIONS_NO_CLICK_LEARNING',
      'Há entrega, mas CTR ainda não tem amostra suficiente.',
      85,
      12
    );
  }

  /*
   * =================================================
   * COM VENDAS: ECONOMIA
   * =================================================
   */

  if(input.sameSkuOrders>0){

    const target =
      Number(
        input.targetAcos || 0
      );

    const current =
      input.acos===null
        ? null
        : Number(input.acos);

    const ratio =
      target>0 &&
      current!==null
        ? current/target
        : null;

    /*
     * Perda acima do break-even sempre vence
     * direction/cooldown.
     */
    if(
      input.profitAfterAds<0 ||
      (
        current!==null &&
        input.breakEvenAcos!==null &&
        current>
          Number(input.breakEvenAcos)
      )
    ){
      return result(
        'DECREASE_STRONG',
        pctBid(-0.15),
        'CONFIRMED_ECONOMIC_LOSS',
        'Venda existe, mas a economia está abaixo do break-even: reduzir 15%.',
        98,
        12
      );
    }

    /*
     * Cooldown só bloqueia oscilação genérica.
     */
    if(input.cooldownActive){
      return hold(
        'DIRECTION_LOCK',
        'Alteração recente ainda está dentro da janela de direção.',
        98,
        6
      );
    }

    if(input.defensive){
      return hold(
        'DEFENSIVE_HOLD',
        'Estado defensivo impede crescimento.',
        98,
        24
      );
    }

    /*
     * ACoS relativo ao alvo.
     */

    if(ratio!==null){

      if(ratio<=0.70){

        if(
          !input.inStock ||
          !input.economicsComplete ||
          input.safeMaxCpc<=input.currentBid
        ){
          return hold(
            'STRONG_WINNER_NO_SAFE_HEADROOM',
            'Vencedor forte, porém sem headroom econômico/estoque para aumentar bid.',
            98,
            6
          );
        }

        return result(
          'INCREASE',
          boundedIncrease(0.15),
          'ACOS_STRONG_SCALE',
          'ACoS <=70% do alvo: escala de até 15% limitada pelo safe CPC e break-even.',
          97,
          3
        );
      }

      if(ratio<=0.90){

        if(
          !input.inStock ||
          !input.economicsComplete ||
          input.safeMaxCpc<=input.currentBid
        ){
          return hold(
            'WINNER_NO_SAFE_HEADROOM',
            'Campanha eficiente, mas sem headroom seguro para crescer.',
            97,
            6
          );
        }

        return result(
          'INCREASE',
          boundedIncrease(0.10),
          'ACOS_SCALE',
          'ACoS entre 70% e 90% do alvo: escala de até 10% limitada pelo safe CPC e break-even.',
          94,
          4
        );
      }

      if(ratio<=1.10){
        return hold(
          'ACOS_HEALTHY_BAND',
          'ACoS dentro da faixa saudável de 90%-110% do alvo.',
          96,
          12
        );
      }

      if(ratio<=1.30){
        return result(
          'DECREASE_SOFT',
          pctBid(-0.05),
          'ACOS_MODERATE_CONTROL',
          'ACoS entre 110% e 130% do alvo: redução de 5%.',
          92,
          24
        );
      }

      if(ratio<=1.60){
        return result(
          'DECREASE_STRONG',
          pctBid(-0.10),
          'ACOS_STRONG_CONTROL',
          'ACoS entre 130% e 160% do alvo: redução de 10%.',
          95,
          24
        );
      }

      return result(
        'DECREASE_STRONG',
        pctBid(-0.15),
        'ACOS_SEVERE_CONTROL',
        'ACoS acima de 160% do alvo: redução de 15%.',
        97,
        12
      );
    }

    /*
     * Sem ACoS calculável, mas com lucro confirmado.
     */
    if(
      input.profitAfterAds>=0 &&
      input.inStock &&
      input.economicsComplete &&
      input.safeMaxCpc>input.currentBid
    ){
      return result(
        'INCREASE',
        boundedIncrease(0.10),
        'PROFITABLE_GROWTH_TEST',
        'Venda lucrativa com headroom econômico: crescimento de até 10% limitado pelo safe CPC e break-even.',
        90,
        6
      );
    }

    return hold(
      'PROFITABILITY_HOLD',
      'Venda existe, mas ainda falta evidência para alterar bid.',
      90,
      12
    );
  }

  /*
   * =================================================
   * ENTREGA COM AMOSTRA AINDA INSUFICIENTE
   * =================================================
   */

  return hold(
    'CONTINUE_LEARNING',
    'Há entrega, mas ainda não existe evidência suficiente para intervenção.',
    88,
    12
  );
}

export function evaluateDecisionGovernance(
  input: GovernanceInput
): GovernanceResult {

  const blockers:
    GovernanceResult['blockers'] = [];

  const add = (
    priority:string,
    code:string,
    reason:string
  ) =>
    blockers.push({
      priority,
      code,
      reason
    });

  const action =
    lower(input.actionType);

  const entity =
    lower(input.entityType);

  const isBid =
    action.includes('bid');

  const isBudget =
    action.includes('budget');

  const isPause =
    action.includes('pause');

  const isCreate =
    action === 'create_campaign' ||
    action === 'create_keyword' ||
    action === 'create_target' ||
    action.startsWith('create_');

  const current =
    Number(
      input.currentValue
    );

  const proposed =
    Number(
      input.proposedValue
    );

  const isIncrease =
    action.includes('increase') ||
    (
      Number.isFinite(current) &&
      Number.isFinite(proposed) &&
      proposed>current
    );

  const isDecrease =
    action.includes('decrease') ||
    action.includes('reduce') ||
    (
      Number.isFinite(current) &&
      Number.isFinite(proposed) &&
      proposed<current
    );

  /*
   * PAUSA DEFENSIVA V3
   *
   * Pausa motivada por waste/perda comprovada NÃO é crescimento.
   *
   * Portanto:
   * - stale de SP-API/economia complementar não bloqueia;
   * - PRODUCT_NOT_ELIGIBLE não bloqueia;
   * - winner protection continua bloqueando;
   * - kill switch continua válido;
   * - rollback continua obrigatório;
   * - proveniência/evidência continua necessária.
   */
  const defensivePause =
    isPause &&
    /(persistent_waste|waste|zero_order|no_order|economic_loss|loss_confirmed|not_buyable|out_of_stock)/.test(
      lower(`${input.reasonCode || ''} ${input.reason || ''}`)
    );

  /*
   * Crescimento significa SOMENTE aumentar exposição.
   *
   * pause_campaign NÃO é growth.
   * reduce_bid NÃO é growth.
   */
  const isGrowth =
    isIncrease ||
    isCreate;

  const reason =
    lower(
      `${input.reasonCode || ''} ${input.reason || ''}`
    );

  const hasEvidence =
    Boolean(
      input.snapshotId ||
      input.verifiedEvidenceId
    );

  const verifiedAdsEvidence =
    Boolean(
      input.verifiedEvidenceId
    ) &&
    input.dataFresh===true &&
    input.adsDataFresh!==false;

  const defensiveReduction =
    (isBid || isBudget) &&
    isDecrease &&
    /(zero_order|waste|economic_loss|margin|safe_cpc|acos|above_target|no_sale|no_order)/.test(reason);

  /*
   * =================================================
   * P0 — CONTA
   * =================================================
   */

  if(input.accountKillSwitch){
    add(
      'P0',
      'ACCOUNT_KILL_SWITCH',
      'Kill switch da conta ativo.'
    );
  }

  if(
    isIncrease &&
    input.accountDailyCap!==null &&
    input.accountDailyCap!==undefined
  ){

    const cap =
      Number(input.accountDailyCap);

    const spend =
      Number(input.accountSpend || 0) +
      Number(input.reservedPendingSpend || 0) +
      Number(input.proposedSpendImpact || 0);

    if(
      Number.isFinite(cap) &&
      cap>0 &&
      spend>cap
    ){
      add(
        'P1',
        'ACCOUNT_DAILY_CAP',
        'A ação excederia o limite diário da conta.'
      );
    }
  }

  /*
   * =================================================
   * P2 — PROVENIÊNCIA / FRESHNESS
   * =================================================
   */

  if(!hasEvidence){
    add(
      'P2',
      'SNAPSHOT_REQUIRED',
      'A decisão precisa referenciar snapshot canônico ou evidência intradiária verificada.'
    );
  }

  /*
   * Redução defensiva:
   * Ads fresco basta.
   *
   * Crescimento:
   * exige todas as fontes necessárias.
   */
  /*
   * =================================================
   * P2 — FRESHNESS POR TIPO DE AÇÃO
   * =================================================
   *
   * GROWTH:
   * Ads + SP-API + economia precisam estar atuais.
   *
   * REDUÇÃO / PAUSA:
   * dados Ads atuais são suficientes para defender
   * exposição; stale de SP-API/economia não transforma
   * ação defensiva em bloqueio.
   */

  if (isGrowth) {

    if (
      !input.dataFresh ||
      input.adsDataFresh === false ||
      input.spApiDataFresh === false ||
      input.economicsDataFresh === false
    ) {
      add(
        'P2',
        'STALE_DATA',
        'Uma ou mais fontes obrigatórias para crescimento estão vencidas.'
      );
    }

  } else if (
    isDecrease ||
    isPause
  ) {

    if (
      !input.dataFresh ||
      input.adsDataFresh === false
    ) {
      add(
        'P2',
        'STALE_ADS_DATA',
        'Ação defensiva exige métricas Ads recentes.'
      );
    }

  }

  /*
   * =================================================
   * P3 — HARD PRODUCT GUARDS
   * =================================================
   *
   * Impedem crescimento.
   *
   * Não impedem automaticamente uma redução que
   * diminui exposição financeira.
   */

  if(isGrowth){
    if(!input.productEligible) add('P3', 'PRODUCT_NOT_ELIGIBLE', 'Produto não elegível para crescimento.');
    if(!input.listingActive) add('P3', 'LISTING_INACTIVE', 'Listing inativo não permite crescimento.');
    if(!input.offerActive) add('P3', 'OFFER_INACTIVE', 'Oferta inativa não permite crescimento.');
    if(!input.buyable) add('P3', 'NOT_BUYABLE', 'Oferta não comprável não permite crescimento.');
    if(!input.inStock) add('P3', 'OUT_OF_STOCK', 'Sem estoque não permite crescimento.');
  }

  /*
   * =================================================
   * P4 — ECONOMIA
   * =================================================
   */

  if(isIncrease){

    if(!input.economicsComplete){
      add(
        'P4',
        'ECONOMICS_INCOMPLETE',
        'Crescimento exige economia completa.'
      );
    }

    const econConfidence =
      Number(
        input.economicConfidence || 0
      );

    const minimum =
      Number(
        input.minEconomicConfidence ??
        0.90
      );

    if(econConfidence<minimum){
      add(
        'P4',
        'LOW_ECONOMIC_CONFIDENCE',
        `Confiança econômica abaixo de ${Math.round(minimum*100)}%.`
      );
    }

    if(
      isBid &&
      input.safeMaxCpc!==null &&
      input.safeMaxCpc!==undefined &&
      Number.isFinite(proposed) &&
      proposed>
        Number(input.safeMaxCpc)+0.005
    ){
      add(
        'P4',
        'SAFE_CPC_CEILING',
        'Novo bid ultrapassa o safe_max_cpc.'
      );
    }
  }

  /*
   * =================================================
   * P5 — WINNER PROTECTION
   * =================================================
   */

  if(
    input.winnerProtected &&
    isPause
  ){
    add(
      'P5',
      'WINNER_PROTECTION',
      'Campanha vencedora não pode ser pausada automaticamente.'
    );
  }

  /*
   * =================================================
   * P6 — DIRECTION LOCK
   * =================================================
   */

  if(
    input.cooldownActive &&
    !defensiveReduction
  ){
    add(
      'P6',
      'DIRECTION_LOCK',
      'Alteração recente ainda está protegida contra oscilação.'
    );
  }

  /*
   * =================================================
   * P10 — ROLLBACK
   * =================================================
   */

  const executableMutation =
    isBid ||
    isBudget ||
    isPause ||
    isCreate ||
    entity==='product_price';

  if(
    executableMutation &&
    !input.rollbackPlan
  ){
    add(
      'P10',
      'ROLLBACK_PLAN_REQUIRED',
      'Toda ação executável precisa de rollback derivável ou explícito.'
    );
  }


  blockers.sort(
    (a,b)=>
      Number(
        a.priority.replace('P','')
      ) -
      Number(
        b.priority.replace('P','')
      )
  );

  return {
    allowed:
      blockers.length===0,

    blockers,

    priority:
      blockers[0]?.priority ||
      'ALLOW',

    rollbackRequired:
      executableMutation
  };
}

export function canonicalDecisionIdempotencyKey(input: {
  accountId: string;
  profileId: string;
  marketplaceId: string;
  entityType: string;
  entityId: string;
  actionType: string;
  decisionWindow: string;
}) {
  return [input.accountId, input.profileId, input.marketplaceId, input.entityType, input.entityId, input.actionType, input.decisionWindow]
    .map((value) => String(value || 'unknown').trim().toLowerCase()).join('|');
}

export function canonicalEntityLockKey(input: {
  accountId: string;
  sku?: string | null;
  campaignId?: string | null;
  entityId?: string | null;
  decisionWindow: string;
}) {
  return ['marketplace-decision', input.accountId, input.sku || '-', input.campaignId || '-', input.entityId || '-', input.decisionWindow]
    .map((value) => String(value).trim().toLowerCase()).join('|');
}


/*
 * =========================================================
 * V3_PREFLIGHT_NO_INVALID_OPERATIONAL_DECISION
 * =========================================================
 *
 * CONTRATO DO CANONICAL_PROFIT_ENGINE_V4
 *
 * A governance deve ser consultada ANTES de persistir uma
 * decisão como executável.
 *
 * Uma ação que falharia por:
 *
 * - WINNER_PROTECTION
 * - ZERO_DELIVERY_NO_FINANCIAL_LOSS
 * - PRODUCT_NOT_ELIGIBLE
 * - OUT_OF_STOCK
 * - NOT_BUYABLE
 * - LISTING_INACTIVE
 * - OFFER_INACTIVE
 * - SAFE_CPC_CEILING
 * - PAUSE_REQUIRES_REDUCTION_SEQUENCE
 * - DIRECTION_LOCK
 * - UNRESOLVED_PRODUCT
 *
 * não deve virar uma ação operacional para depois aparecer
 * como "Cancelado pelo motor".
 *
 * O resultado lógico do pre-flight é:
 *
 * 1. ação alternativa permitida; OU
 * 2. HOLD / NO_DECISION; OU
 * 3. REPLACE/REBUILD; OU
 * 4. investigação autônoma da contradição.
 *
 * Apenas ações admissíveis chegam ao executor Amazon.
 */
export const V3_PREFLIGHT_NO_INVALID_OPERATIONAL_DECISION = true;


/*
 * ============================================================
 * V3_CONTROLLED_IMPRESSION_RECOVERY
 * ============================================================
 *
 * Recuperação de entrega não é SCALE pleno.
 *
 * Uma keyword MANUAL EXACT subexposta pode receber pequeno
 * aumento de bid mesmo quando a economia ainda não alcançou
 * confiança suficiente para scale agressivo.
 *
 * HARD GUARDS reais continuam soberanos.
 */

export type ImpressionRecoveryGovernanceInput = {
  action?: string;
  decision_type?: string;
  rule_key?: string;

  phase?: string;

  impressions?: number;
  clicks?: number;
  spend?: number;
  orders?: number;

  old_bid?: number;
  new_bid?: number;

  safe_cpc?: number;
  effective_ceiling?: number;

  snapshot_verified?: boolean;
  intraday_verified?: boolean;

  product_eligible?: boolean;

  stock_available?: number | null;

  listing_buyable?: boolean | null;

  economic_confidence?: number | null;

  economics_complete?: boolean | null;
};

export function evaluateControlledImpressionRecovery(
  input: ImpressionRecoveryGovernanceInput
) {

  const action=
    String(
      input.action ||
      ''
    );

  const decisionType=
    String(
      input.decision_type ||
      ''
    );

  const ruleKey=
    String(
      input.rule_key ||
      ''
    );

  const isRecovery=
    action === 'set_bid'
    &&
    (
      decisionType ===
        'increase_bid_impression_recovery'
      ||
      ruleKey ===
        'V3_MANUAL_EXACT_IMPRESSION_RECOVERY'
    );

  if(!isRecovery) {
    return {
      applicable:false,
      allowed:false,
      reason:null
    };
  }

  const phase=
    String(
      input.phase ||
      ''
    ).toUpperCase();

  const oldBid=
    Number(
      input.old_bid ||
      0
    );

  const newBid=
    Number(
      input.new_bid ||
      0
    );

  const safeCpc=
    Number(
      input.safe_cpc ||
      0
    );

  const ceiling=
    Number(
      input.effective_ceiling ||
      0
    );

  const spend=
    Number(
      input.spend ||
      0
    );

  const orders=
    Number(
      input.orders ||
      0
    );

  /*
   * HARD GUARDS
   */
  if(
    input.product_eligible === false
  ) {
    return {
      applicable:true,
      allowed:false,
      hard_block:true,
      reason:'PRODUCT_NOT_ELIGIBLE'
    };
  }

  if(
    input.stock_available != null
    &&
    Number(input.stock_available) <= 0
  ) {
    return {
      applicable:true,
      allowed:false,
      hard_block:true,
      reason:'OUT_OF_STOCK'
    };
  }

  if(
    input.listing_buyable === false
  ) {
    return {
      applicable:true,
      allowed:false,
      hard_block:true,
      reason:'LISTING_NOT_BUYABLE'
    };
  }

  /*
   * Não permitir aumento acima dos limites técnicos.
   */
  if(
    safeCpc > 0
    &&
    newBid > safeCpc + 0.0001
  ) {
    return {
      applicable:true,
      allowed:false,
      hard_block:true,
      reason:'SAFE_CPC_EXCEEDED'
    };
  }

  if(
    ceiling > 0
    &&
    newBid > ceiling + 0.0001
  ) {
    return {
      applicable:true,
      allowed:false,
      hard_block:true,
      reason:'EFFECTIVE_CEILING_EXCEEDED'
    };
  }

  const increasePct=
    oldBid > 0
      ? (
          newBid / oldBid -
          1
        ) * 100
      : 999;

  /*
   * Recovery nunca pode ser aumento grande.
   */
  const maxRecoveryPct=
    ['NEW','YOUNG'].includes(phase)
      ? 15
      : 10;

  if(
    increasePct >
      maxRecoveryPct + 0.01
  ) {
    return {
      applicable:true,
      allowed:false,
      hard_block:true,
      reason:'RECOVERY_INCREMENT_TOO_LARGE'
    };
  }

  /*
   * Para recovery, snapshot intradiário verificado
   * pode substituir snapshot canônico completo.
   */
  const evidenceReady=
    input.snapshot_verified === true
    ||
    input.intraday_verified === true;

  if(!evidenceReady) {
    return {
      applicable:true,
      allowed:false,
      hard_block:false,
      recoverable:true,
      reason:'WAIT_FOR_VERIFIED_INTRADAY_SNAPSHOT'
    };
  }

  /*
   * Economia incompleta/confiança <90%:
   *
   * impede scale pleno,
   * mas NÃO impede recovery pequeno.
   */
  const economicsComplete=
    input.economics_complete === true;

  const confidence=
    Number(
      input.economic_confidence ||
      0
    );

  return {
    applicable:true,

    allowed:true,

    hard_block:false,

    recovery_mode:true,

    limited_scale:
      !economicsComplete
      ||
      confidence < 0.90,

    max_increase_pct:
      maxRecoveryPct,

    reason:
      (
        !economicsComplete
        ||
        confidence < 0.90
      )
        ? 'CONTROLLED_DELIVERY_RECOVERY_WITH_LIMITED_ECONOMIC_EVIDENCE'
        : 'CONTROLLED_DELIVERY_RECOVERY',

    rollback_required:true,

    reevaluate_hours:
      ['NEW','YOUNG'].includes(phase)
        ? 3
        : 6,

    spend_guard_required:
      orders <= 0
      &&
      spend > 0
  };
}

