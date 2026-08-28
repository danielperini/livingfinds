import {
  createClientFromRequest,
} from 'npm:@base44/sdk@0.8.40';

function id(c:any):string {
  return String(
    c.campaign_id ||
    c.amazon_campaign_id ||
    c.id ||
    ''
  );
}

function isAuto(c:any):boolean {
  const targeting=
    String(c.targeting_type || '').toUpperCase();

  const name=
    String(
      c.name ||
      c.campaign_name ||
      ''
    ).toUpperCase();

  return (
    c.archived !== true &&
    !name.includes('MANUAL') &&
    (
      targeting === 'AUTO' ||
      name.includes('AUTO')
    )
  );
}

function active(c:any):boolean {
  const state=
    String(
      c.state ||
      c.status ||
      c.amazon_status ||
      ''
    ).toUpperCase();

  return [
    'ENABLED',
    'ACTIVE',
    'RUNNING',
    'IN_INSERTION',
  ].includes(state);
}

Deno.serve(async req => {

  const base44=
    createClientFromRequest(req);

  const body=
    await req.json()
      .catch(() => ({}));

  if(body._service_role !== true) {
    return Response.json(
      {ok:false,error:'service role required'},
      {status:403}
    );
  }

  const aid=
    String(body.amazon_account_id || '');

  const asin=
    String(body.asin || '').toUpperCase();

  const sku=
    String(body.sku || '');

  const keeper=
    String(body.best_auto || '');

  if(!aid || !asin || !keeper) {
    return Response.json(
      {
        ok:false,
        error:'aid/asin/best_auto obrigatórios'
      },
      {status:400}
    );
  }

  await base44
    .asServiceRole
    .functions
    .invoke(
      'syncAdsCampaignStatesV2',
      {
        _service_role:true,
        amazon_account_id:aid,
        trigger_type:'v3_one_auto_precheck'
      }
    )
    .catch(() => null);

  const campaigns=
    await base44
      .asServiceRole
      .entities
      .Campaign
      .filter(
        {
          amazon_account_id:aid,
          asin,
        },
        '-updated_at',
        500
      )
      .catch(() => []);

  /*
   * V3_DYNAMIC_KEEPER_RESOLUTION
   *
   * O mesmo campaign_id pode existir duplicado localmente.
   * Deduplicar pela identidade Amazon antes de avaliar cobertura.
   */
  const autosRaw=
    campaigns.filter(
      (c:any) => isAuto(c)
    );

  const autoByAmazonId=
    new Map<string, any>();

  for(const campaign of autosRaw) {

    const campaignId=
      id(campaign);

    if(!campaignId)
      continue;

    const existing=
      autoByAmazonId.get(
        campaignId
      );

    /*
     * Preferir o registro que está ativo.
     */
    if(
      !existing
      ||
      (
        active(campaign)
        &&
        !active(existing)
      )
    ) {
      autoByAmazonId.set(
        campaignId,
        campaign
      );
    }
  }

  const autos=
    [...autoByAmazonId.values()];

  const activeAutos=
    autos.filter(
      (c:any) => active(c)
    );

  /*
   * Keeper do dry-run pode ficar obsoleto.
   *
   * Ordem:
   * 1. keeper originalmente escolhido, se continua ativo;
   * 2. melhor AUTO ativa atual segundo evidência local;
   * 3. qualquer AUTO ativa atual.
   */
  const requestedKeeper=
    activeAutos.find(
      (c:any) =>
        id(c) === keeper
    );

  const metricScore = (c:any):number => {

    const orders=
      Number(
        c.orders_14d ??
        c.orders ??
        c.purchases ??
        0
      ) || 0;

    const sales=
      Number(
        c.sales_14d ??
        c.sales ??
        c.revenue ??
        0
      ) || 0;

    const spend=
      Number(
        c.spend_14d ??
        c.spend ??
        c.cost ??
        0
      ) || 0;

    const impressions=
      Number(
        c.impressions_14d ??
        c.impressions ??
        0
      ) || 0;

    const roas=
      spend > 0
        ? sales / spend
        : 0;

    return (
      orders * 100000
      +
      sales * 100
      +
      roas * 1000
      +
      Math.min(
        impressions,
        10000
      )
    );
  };

  const rankedActive=
    [...activeAutos]
      .sort(
        (a:any,b:any) =>
          metricScore(b)
          -
          metricScore(a)
      );

  const keeperCampaign=
    requestedKeeper
    ||
    rankedActive[0]
    ||
    null;

  if(!keeperCampaign) {

    return Response.json({
      ok:false,

      reason:
        'NO_ACTIVE_AUTO_TO_KEEP',

      sku,
      asin,

      requested_keeper:
        keeper,

      active_ids:[],
    });
  }

  const effectiveKeeper=
    id(
      keeperCampaign
    );

  if(activeAutos.length <= 1) {
    return Response.json({
      ok:true,
      sku,
      asin,
      requested_keeper: keeper,
      keeper: effectiveKeeper,
      active_before:
        activeAutos.length,
      nothing_to_do:true
    });
  }

  const extra=
    activeAutos.find(
      (c:any) =>
        id(c) !== effectiveKeeper
    );

  if(!extra) {
    return Response.json({
      ok:true,
      sku,
      asin,
      requested_keeper: keeper,
      keeper: effectiveKeeper,
      active_before:
        activeAutos.length,
      nothing_to_do:true
    });
  }

  const extraId=
    id(extra);

  const duplicate=
    await base44
      .asServiceRole
      .entities
      .OptimizationDecision
      .filter(
        {
          amazon_account_id:aid,
          campaign_id:extraId,
          action:'pause_campaign',
          status:'approved',
        },
        '-created_at',
        5
      )
      .catch(() => []);

  if(duplicate.length) {
    return Response.json({
      ok:true,
      sku,
      asin,
      keeper,
      extra_campaign:
        extraId,
      existing_decision:true
    });
  }

  const decision=
    await base44
      .asServiceRole
      .entities
      .OptimizationDecision
      .create({
        amazon_account_id:
          aid,

        decision_type:
          'portfolio_remove_duplicate_auto',

        entity_type:
          'campaign',

        entity_id:
          extraId,

        campaign_id:
          extraId,

        asin,

        action:
          'pause_campaign',

        rationale:
          `Consolidação transacional SKU ${sku}/${asin}: keeper ${effectiveKeeper} confirmado ativo. Pausar somente excedente ${extraId}.`,

        rule_key:
          'ONE_ACTIVE_AUTO_PER_SKU_ONE_BY_ONE',

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
          'consolidateOneV3AutoCampaign',

        idempotency_key:
          [
            'ONE_AUTO',
            aid,
            asin,
            effectiveKeeper,
            extraId
          ].join('|'),

        created_at:
          new Date()
            .toISOString(),
      });

  return Response.json({
    ok:true,
    sku,
    asin,
    requested_keeper: keeper,
    keeper: effectiveKeeper,
    keeper_changed: effectiveKeeper !== keeper,
    active_before:
      activeAutos.length,
    pause_campaign:
      extraId,
    decision_id:
      decision?.id || null
  });
});
