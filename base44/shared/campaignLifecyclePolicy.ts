// CAMPAIGN_LIFECYCLE_VERSION_EXPORT_V2
// Versão canônica da política de ciclo de vida de campanhas.
export const CAMPAIGN_LIFECYCLE_VERSION = 'campaign-lifecycle-v3';

export type CampaignKind =
  | 'AUTO'
  | 'MANUAL_EXACT'
  | 'MANUAL_OTHER'
  | 'UNKNOWN';

export type CampaignLifecyclePhase =
  | 'NEW'
  | 'INITIAL_LEARNING'

  | 'AUTO_DISCOVERY'
  | 'AUTO_HARVEST_READY'

  | 'MANUAL_EXACT_NEW'
  | 'MANUAL_EXACT_LEARNING'

  | 'ZERO_DELIVERY_RECOVERY'
  | 'DELIVERY_LEARNING'

  | 'HEALTHY'
  | 'WINNER'
  | 'SCALE'

  | 'DETERIORATING'
  | 'WASTE_CONTROL'
  | 'PAUSE_CANDIDATE'

  | 'REPLACE_REBUILD'
  | 'HARD_BLOCK';

export type CampaignLifecycleInput = {
  kind: CampaignKind;

  ageHours: number;

  impressions7d: number;
  clicks7d: number;
  spend7d: number;
  orders7d: number;
  sales7d: number;

  impressions30d: number;
  clicks30d: number;
  spend30d: number;
  orders30d: number;
  sales30d: number;

  /*
   * Search terms compradores que já passaram
   * pela elegibilidade econômica/same-SKU.
   */
  harvestableTerms: number;

  /*
   * MANUAL EXACT derivadas desta estrutura/origem.
   */
  derivedExactCampaigns: number;

  priorZeroDeliveryEscalations: number;

  priorWasteBidReductions: number;

  targetAcos: number;
  maxAcos: number;

  inStock: boolean;
  buyable: boolean;
  listingActive: boolean;
  offerActive: boolean;

  protectedWinner: boolean;

  accountHardStop: boolean;
};

export type LifecycleBehavior =
  | 'WAIT'
  | 'AUTO_DISCOVER'
  | 'HARVEST_TO_MANUAL_EXACT'
  | 'ZERO_DELIVERY_RECOVERY'
  | 'OBSERVE_LEARNING'
  | 'PROTECT'
  | 'GROW'
  | 'REDUCE_BID'
  | 'PAUSE'
  | 'REPLACE_REBUILD'
  | 'NO_DECISION';

export type CampaignLifecycleDecision = {
  phase: CampaignLifecyclePhase;

  behavior: LifecycleBehavior;

  reason: string;

  strong_action_allowed: boolean;

  maturity_score: number;

  acos7d: number | null;
  acos30d: number | null;

  roas7d: number;
  roas30d: number;
};

const num=(v:unknown,f=0)=>{
  const n=Number(v);
  return Number.isFinite(n)
    ? n
    : f;
};

const pos=(v:unknown)=>
  Math.max(
    0,
    num(v)
  );

const acos=(
  spend:number,
  sales:number
):number|null =>
  sales>0
    ? spend/sales*100
    : null;

const roas=(
  spend:number,
  sales:number
):number =>
  spend>0
    ? sales/spend
    : 0;

export function classifyCampaignLifecycle(
  raw:CampaignLifecycleInput
):CampaignLifecycleDecision {

  const age=
    pos(raw.ageHours);

  const clicks7=
    pos(raw.clicks7d);

  const spend7=
    pos(raw.spend7d);

  const orders7=
    pos(raw.orders7d);

  const sales7=
    pos(raw.sales7d);

  const clicks30=
    pos(raw.clicks30d);

  const spend30=
    pos(raw.spend30d);

  const orders30=
    pos(raw.orders30d);

  const sales30=
    pos(raw.sales30d);

  const targetAcos=
    Math.max(
      1,
      pos(raw.targetAcos)
      || 25
    );

  const maxAcos=
    Math.max(
      targetAcos,
      pos(raw.maxAcos)
      ||
      targetAcos*1.5
    );

  const a7=
    acos(
      spend7,
      sales7
    );

  const a30=
    acos(
      spend30,
      sales30
    );

  const r7=
    roas(
      spend7,
      sales7
    );

  const r30=
    roas(
      spend30,
      sales30
    );

  /*
   * MATURIDADE POR EVIDÊNCIA.
   */
  let maturity=0;

  if(age>=72)
    maturity+=15;

  if(age>=7*24)
    maturity+=10;

  if(clicks30>=10)
    maturity+=15;

  if(clicks30>=20)
    maturity+=15;

  if(spend30>=10)
    maturity+=10;

  if(orders30>=1)
    maturity+=15;

  if(orders30>=2)
    maturity+=20;

  maturity=
    Math.min(
      100,
      maturity
    );

  const result=(
    phase:CampaignLifecyclePhase,
    behavior:LifecycleBehavior,
    reason:string,
    strong=false,
  ):CampaignLifecycleDecision=>({
    phase,
    behavior,
    reason,

    strong_action_allowed:
      strong,

    maturity_score:
      maturity,

    acos7d:a7,
    acos30d:a30,

    roas7d:r7,
    roas30d:r30,
  });

  /*
   * ==================================================
   * HARD GUARDS
   * ==================================================
   */

  if(
    raw.accountHardStop
    ||
    !raw.inStock
    ||
    !raw.buyable
    ||
    !raw.listingActive
    ||
    !raw.offerActive
  ){
    return result(
      'HARD_BLOCK',
      'NO_DECISION',
      'HARD_PRODUCT_OR_ACCOUNT_GUARD'
    );
  }

  /*
   * ==================================================
   * VENCEDORES
   * ==================================================
   */

  if(
    raw.protectedWinner
    &&
    (
      orders30>0
      ||
      sales30>0
    )
  ){
    return result(
      'WINNER',
      'PROTECT',
      'WINNER_PROTECTION'
    );
  }

  /*
   * ==================================================
   * CAMPANHA NOVA
   * ==================================================
   */

  if(
    age<24
    &&
    spend7===0
    &&
    clicks7===0
  ){
    return result(
      'NEW',
      'WAIT',
      'NEW_CAMPAIGN'
    );
  }

  /*
   * ==================================================
   * PRIMEIRAS 72H
   * ==================================================
   */

  if(
    age<72
    &&
    spend7===0
    &&
    clicks7===0
  ){
    return result(
      'INITIAL_LEARNING',
      'WAIT',
      'INITIAL_72H'
    );
  }

  /*
   * ==================================================
   * ZERO DELIVERY
   * ==================================================
   */

  if(
    spend7===0
    &&
    clicks7===0
    &&
    orders7===0
  ){

    if(
      raw.priorZeroDeliveryEscalations
      < 3
    ){
      return result(
        'ZERO_DELIVERY_RECOVERY',
        'ZERO_DELIVERY_RECOVERY',
        'ZERO_DELIVERY_PLUS_010',
        true
      );
    }

    return result(
      'REPLACE_REBUILD',
      'REPLACE_REBUILD',
      'ZERO_DELIVERY_AFTER_THREE_ESCALATIONS',
      true
    );
  }

  /*
   * ==================================================
   * JORNADA AUTO
   * ==================================================
   *
   * AUTO existe para descobrir demanda.
   *
   * Ela não deve ser tratada como destino final
   * de todo termo vencedor.
   */

  if(raw.kind==='AUTO'){

    /*
     * Já há termo comprador elegível.
     *
     * O próximo passo é HARVEST,
     * não simplesmente aumentar AUTO.
     */
    if(
      raw.harvestableTerms>0
    ){
      return result(
        'AUTO_HARVEST_READY',
        'HARVEST_TO_MANUAL_EXACT',
        'AUTO_BUYER_TERM_READY_FOR_EXACT',
        true
      );
    }

    /*
     * AUTO começou a gastar e ainda está
     * adquirindo conhecimento.
     */
    const autoLowSample=
      clicks30<20
      &&
      orders30<2
      &&
      maturity<60;

    if(autoLowSample){
      return result(
        'AUTO_DISCOVERY',
        'AUTO_DISCOVER',
        'AUTO_DISCOVERY_LEARNING'
      );
    }
  }

  /*
   * ==================================================
   * MANUAL EXACT RECÉM-CRIADA PELO HARVEST
   * ==================================================
   */

  if(
    raw.kind==='MANUAL_EXACT'
    &&
    age<72
  ){
    return result(
      'MANUAL_EXACT_NEW',
      'WAIT',
      'HARVESTED_EXACT_INITIAL_LEARNING'
    );
  }

  /*
   * Começou a gastar:
   *
   * ZERO DELIVERY acabou.
   */
  /*
   * Waste comprovado tem precedência sobre LEARNING.
   *
   * Uma campanha com:
   * - zero pedidos;
   * - zero vendas;
   * - >=12 cliques;
   * - >=R$5 de gasto
   *
   * já possui evidência financeira suficiente para
   * redução defensiva de bid, mesmo que ainda não tenha
   * atingido o maturity_score geral.
   */
  const earlyProvenWaste =
    orders30===0
    &&
    sales30===0
    &&
    clicks30>=12
    &&
    spend30>=5;

  const lowSample=
    clicks30<20
    &&
    orders30<2
    &&
    maturity<60
    &&
    !earlyProvenWaste;

  if(lowSample){

    if(
      raw.kind==='MANUAL_EXACT'
    ){
      return result(
        'MANUAL_EXACT_LEARNING',
        'OBSERVE_LEARNING',
        'MANUAL_EXACT_INSUFFICIENT_SAMPLE'
      );
    }

    return result(
      'DELIVERY_LEARNING',
      'OBSERVE_LEARNING',
      'INSUFFICIENT_ECONOMIC_SAMPLE'
    );
  }

  /*
   * ==================================================
   * WINNER
   * ==================================================
   */

  const winner=
    orders30>=2
    &&
    (
      (
        a30!==null
        &&
        a30<=targetAcos*0.8
      )
      ||
      r30>=4
    );

  if(winner){
    return result(
      'WINNER',
      'GROW',
      'STRONG_PROFIT_WINNER',
      true
    );
  }

  /*
   * ==================================================
   * HEALTHY
   * ==================================================
   */

  const healthy=
    orders30>=1
    &&
    (
      (
        a30!==null
        &&
        a30<=targetAcos
      )
      ||
      r30>=3
    );

  if(healthy){
    return result(
      'HEALTHY',
      'GROW',
      'PROFITABLE_CAMPAIGN',
      true
    );
  }

  /*
   * ==================================================
   * DETERIORAÇÃO COM VENDAS
   * ==================================================
   */

  if(
    orders30>0
    &&
    a30!==null
    &&
    a30>maxAcos
  ){
    return result(
      'DETERIORATING',
      'REDUCE_BID',
      'PROFITABILITY_DETERIORATION',
      true
    );
  }

  /*
   * ==================================================
   * WASTE
   * ==================================================
   */

  const waste=
    orders30===0
    &&
    sales30===0
    &&
    clicks30>=12
    &&
    spend30>=5;

  if(waste){

    if(
      raw.priorWasteBidReductions
      < 2
    ){
      return result(
        'WASTE_CONTROL',
        'REDUCE_BID',
        'ZERO_ORDER_FINANCIAL_WASTE',
        true
      );
    }

    if(
      clicks30>=20
      &&
      spend30>=15
    ){
      return result(
        'PAUSE_CANDIDATE',
        'PAUSE',
        'PERSISTENT_WASTE_AFTER_TWO_REDUCTIONS',
        true
      );
    }

    return result(
      'WASTE_CONTROL',
      'OBSERVE_LEARNING',
      'WAIT_FOR_PERSISTENT_WASTE_SAMPLE'
    );
  }

  return result(
    'DELIVERY_LEARNING',
    'OBSERVE_LEARNING',
    'CONTINUE_LEARNING'
  );
}


// CAMPAIGN_LIFECYCLE_RETIRE_COMPAT_V3
// Compatibilidade para runCanonicalCampaignLifecycleLayer.
// AUTO só pode ser aposentada quando:
// - tem pelo menos 30 dias;
// - ficou pelo menos 3 dias sem vendas;
// - não é winner protegido;
// - produto está em estoque;
// - campanha está estruturalmente completa.
export type AutoRetirementInput = {
  ageDays: number;
  consecutiveDaysWithoutSales: number;
  protectedWinner: boolean;
  inStock: boolean;
  structurallyComplete: boolean;
};

export function shouldRetireAutoCampaign(
  input: AutoRetirementInput
): boolean {
  return (
    Number(input.ageDays || 0) >= 30 &&
    Number(input.consecutiveDaysWithoutSales || 0) >= 3 &&
    input.protectedWinner !== true &&
    input.inStock === true &&
    input.structurallyComplete === true
  );
}
