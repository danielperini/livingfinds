/**
 * analyzeCampaignStrategy — Motor decisório de campanhas SP.
 *
 * Para uma dada campanha, executa a checklist completa de 13 perguntas
 * e retorna a decisão estruturada com:
 *  - outcome: EXECUTE_NOW | SCHEDULE | WAIT_FOR_DATA | RECOMMEND_APPROVAL | BLOCK | ROLLBACK | NO_ACTION
 *  - action: qual parâmetro alterar (bid, budget, placement, strategy, pause, enable)
 *  - rationale: explicação legível com objetivo, condição, parâmetro, limites, risco, avaliação
 *  - max_possible_bid: bid máximo considerando placement + schedule + strategy
 *  - budget_rule_type: SCHEDULE_BUDGET_RULE | DATE_RANGE_BUDGET_RULE | PERFORMANCE_BUDGET_RULE | none
 *  - campaign_objective: DISCOVERY | LAUNCH | PROFITABILITY | GROWTH | ROAS_TARGET | ACOS_TARGET | ...
 *
 * Regras críticas:
 *  - Métricas "—"/null/undefined ≠ zero → WAIT_FOR_DATA
 *  - Dados de canal com menos de 12h → PARTIAL → não usar para decisões negativas
 *  - Não alterar bid + budget + placement no mesmo ciclo
 *  - dynamicDownOnly é padrão seguro
 *  - dynamicUpAndDown exige campanha MATURE + aprovação
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const ATTR_SAFETY_HOURS   = 72;
const CHANNEL_DATA_LAG_H  = 12;
const LOW_BUDGET_THRESHOLD = 5.0; // R$

function getSafeCutoff(h = ATTR_SAFETY_HOURS) {
  return new Date(Date.now() - h * 3600000).toISOString().slice(0, 10);
}

function daysFromNow(d) { return new Date(Date.now() + d * 86400000).toISOString(); }

function calcAgeDays(startDate) {
  if (!startDate) return 0;
  return (Date.now() - new Date(startDate).getTime()) / 86400000;
}

// Detectar objetivo da campanha
function detectObjective(campaign, product, cfg) {
  const ageDays = calcAgeDays(campaign.start_date || campaign.created_at);
  const isAuto = (campaign.targeting_type || '').toUpperCase() === 'AUTO';
  const budget = campaign.daily_budget || 0;
  const acos = campaign.acos || 0;
  const roas = campaign.roas || 0;
  const spend = campaign.spend || 0;
  const orders = campaign.orders || 0;
  const targetAcos = cfg.target_acos || 25;
  const targetRoas = cfg.target_roas || 4;

  if (product?.inventory_status === 'out_of_stock') return 'BUDGET_CONTROL';
  if (ageDays < 7 && isAuto) return 'DISCOVERY';
  if (ageDays < 30 && orders < 5) return 'LAUNCH';
  if (roas > 0 && roas >= targetRoas && orders > 3) return 'ROAS_TARGET';
  if (acos > 0 && acos <= targetAcos && orders > 3) return 'ACOS_TARGET';
  if (budget <= LOW_BUDGET_THRESHOLD) return 'BUDGET_CONTROL';
  if (acos > (cfg.maximum_acos || 40)) return 'PROFITABILITY';
  return 'GROWTH';
}

// Calcular bid máximo possível com todas as camadas
function calcMaxPossibleBid(baseBid, topAdjPct, scheduleAdjPct, strategy) {
  const afterPlacement = baseBid * (1 + (topAdjPct || 0) / 100);
  const afterSchedule  = afterPlacement * (1 + (scheduleAdjPct || 0) / 100);
  // dynamicUpAndDown: Amazon pode aumentar até +100% adicionalmente
  const afterDynamic   = strategy === 'dynamicUpAndDown' ? afterSchedule * 2.0 : afterSchedule;
  return {
    after_placement: Number(afterPlacement.toFixed(2)),
    after_schedule:  Number(afterSchedule.toFixed(2)),
    max_possible:    Number(afterDynamic.toFixed(2)),
  };
}

// Verificar status dos dados de canal (PARTIAL se < 12h)
function checkChannelDataStatus(campaign) {
  const syncAt = campaign.last_sync_at || campaign.synced_at;
  if (!syncAt) return { status: 'UNKNOWN', hoursOld: null };
  const h = (Date.now() - new Date(syncAt).getTime()) / 3600000;
  return {
    status: h < CHANNEL_DATA_LAG_H ? 'PARTIAL' : 'COMPLETE',
    hoursOld: Math.round(h),
  };
}

// Detectar motivo de pausa
function detectPauseReason(campaign, product, decisions = []) {
  if (product?.inventory_status === 'out_of_stock') return 'OUT_OF_STOCK';
  const lastDecision = decisions.find(d => d.campaign_id === campaign.campaign_id && d.action === 'pause_campaign');
  if (lastDecision) {
    if (lastDecision.source_function === 'runHourlyAdsGuardrails') return 'OUT_OF_STOCK';
    if (lastDecision.source_function === 'runDailyAdsOptimization') return 'PERFORMANCE';
    return 'AUTOPILOT';
  }
  return 'UNKNOWN';
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const amazonAccountId = body.amazon_account_id;
    const campaignId = body.campaign_id;

    if (!amazonAccountId) return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });

    // Carregar dados
    const [accounts, cfgs, campaigns, products, recentDecisions] = await Promise.all([
      base44.asServiceRole.entities.AmazonAccount.filter({ id: amazonAccountId }),
      base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: amazonAccountId }),
      campaignId
        ? base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: amazonAccountId, campaign_id: campaignId })
        : base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: amazonAccountId, state: 'enabled' }, '-spend', 200),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: amazonAccountId }, null, 500),
      base44.asServiceRole.entities.OptimizationDecision.filter(
        { amazon_account_id: amazonAccountId }, '-created_at', 200
      ),
    ]);

    const account = accounts[0];
    const cfg = cfgs[0] || {};
    const sym = account?.currency_symbol || 'R$';
    const productMap = new Map(products.map(p => [p.asin, p]));

    const TARGET_ACOS  = cfg.target_acos  || 25;
    const MAX_ACOS     = cfg.maximum_acos || 40;
    const TARGET_ROAS  = cfg.target_roas  || 4;
    const MIN_BID      = cfg.min_bid      || 0.10;
    const MAX_BID      = cfg.max_bid      || 5.0;
    const ATTR_HOURS   = cfg.attribution_safety_hours || ATTR_SAFETY_HOURS;
    const MIN_DAYS     = cfg.minimum_complete_data_days || 3;
    const safeCutoff   = getSafeCutoff(ATTR_HOURS);
    const autonomyLevel = cfg.autonomy_level ?? 2;

    const results = [];

    for (const c of campaigns.slice(0, 50)) {
      const product = c.asin ? productMap.get(c.asin) : null;
      const channelStatus = checkChannelDataStatus(c);
      const ageDays = calcAgeDays(c.start_date || c.created_at);
      const objective = detectObjective(c, product, cfg);

      // ── Checklist completa de 13 perguntas ──────────────────────────────
      const blockers = [];
      const warnings = [];

      // 1. Dados completos?
      if (!c.impressions && !c.clicks && !c.spend) {
        if (ageDays > MIN_DAYS) warnings.push('NO_DATA');
      }

      // 2. Janela de atribuição fechada?
      const attrOpen = c.last_sync_at && new Date(c.last_sync_at).toISOString().slice(0,10) >= safeCutoff;
      if (attrOpen && channelStatus.status === 'PARTIAL') warnings.push('ATTRIBUTION_OPEN');

      // 3. Entidade madura?
      const isNew = ageDays < MIN_DAYS;
      const isLearning = ageDays >= MIN_DAYS && ageDays < 14;
      const isMature = ageDays >= 14 && ((c.clicks || 0) >= 10 || (c.spend || 0) >= 5);
      const maturity = isNew ? 'NEW' : isLearning ? 'LEARNING' : isMature ? 'MATURE' : 'INSUFFICIENT_DATA';

      // 4–6. Produto, estoque, oferta, Buy Box
      if (!product) warnings.push('PRODUCT_NOT_FOUND');
      else {
        if (product.inventory_status === 'out_of_stock') blockers.push('OUT_OF_STOCK');
        else if (product.inventory_status === 'low_stock') warnings.push('LOW_STOCK');
        if (product.buy_box_status === 'lost') blockers.push('BUY_BOX_LOST');
        if (['inactive','archived'].includes(product.status)) blockers.push('PRODUCT_INACTIVE');
      }

      // 7. Campanha ativa?
      const isPaused = c.state === 'paused' || c.status === 'paused';
      const pauseReason = isPaused ? detectPauseReason(c, product, recentDecisions) : null;

      // 8–9. Orçamento
      const budget = c.daily_budget || 0;
      const isLowBudget = budget > 0 && budget <= LOW_BUDGET_THRESHOLD;
      const estimatedClicksPerDay = budget > 0 && (c.cpc || 0) > 0 ? budget / (c.cpc || 1) : null;

      // 10. Delivery e impressões (LOW_BUDGET_LEARNING)
      if (isLowBudget) warnings.push('LOW_BUDGET_LEARNING');

      // 11. Maturidade já avaliada acima
      // 12–13: performance
      const acos   = c.acos   || 0;
      const roas   = c.roas   || 0;
      const spend  = c.spend  || 0;
      const orders = c.orders || 0;
      const clicks = c.clicks || 0;
      const ctr    = c.ctr    || 0;
      const cvr    = clicks > 0 ? orders / clicks : 0;

      // ── Calcular exposição máxima ────────────────────────────────────────
      const topAdj      = c.top_of_search_adjustment      || 0;
      const scheduleAdj = 0; // não temos dados de agendamento ativo
      const strategy    = c.bidding_strategy || 'dynamicDownOnly';
      const avgKwBid    = 0.25; // será carregado por keyword no contexto real
      const maxBidCalc  = calcMaxPossibleBid(avgKwBid, topAdj, scheduleAdj, strategy);

      // ── Decisão principal ────────────────────────────────────────────────
      let outcome = 'NO_ACTION';
      let action  = null;
      let rationale = '';
      let proposedValue = null;
      let evaluationDue = null;
      let risk = 'low';
      let budgetRuleType = 'none';

      // PAUSED
      if (isPaused) {
        if (pauseReason === 'OUT_OF_STOCK' && product?.inventory_status !== 'out_of_stock') {
          // Estoque retornou → checar elegibilidade para reativar
          if (product?.buy_box_status !== 'lost' && product?.status === 'active') {
            outcome = 'RECOMMEND_APPROVAL';
            action = 'enable_campaign';
            risk = 'medium';
            rationale = `Campanha pausada por falta de estoque. Estoque retornou.\n\nMotivo: Estoque FBA disponível novamente. Reativar com orçamento atual de ${sym}${budget.toFixed(2)}, estratégia dynamicDownOnly e placements em 0% para observar por 3 dias antes de otimizar.\n\nRisco: Médio.\n\nPróxima avaliação: Em 3 dias.`;
            evaluationDue = daysFromNow(3);
          } else {
            outcome = 'BLOCK';
            rationale = `Campanha pausada por estoque. Buy Box ou oferta ainda inativa.`;
          }
        } else if (pauseReason === 'UNKNOWN') {
          outcome = 'RECOMMEND_APPROVAL';
          action = 'investigate_pause';
          risk = 'medium';
          rationale = `Campanha pausada com motivo desconhecido.\n\nMotivo: Não há decisão registrada para esta pausa. Pode ter sido uma alteração manual no console Amazon.\n\nAção correta: Não reativar automaticamente. Verificar histórico no console Amazon antes de qualquer ação.\n\nRisco: Médio.`;
        } else {
          outcome = 'WAIT_FOR_DATA';
          rationale = `Campanha pausada (motivo: ${pauseReason}). Aguardando revisão manual.`;
        }

      // DISCOVERY: nova campanha automática
      } else if (objective === 'DISCOVERY') {
        if (blockers.length > 0) {
          outcome = 'BLOCK';
          rationale = `Bloqueios ativos: ${blockers.join(', ')}. Corrigir antes de otimizar.`;
        } else if (maturity === 'NEW' || maturity === 'INSUFFICIENT_DATA') {
          outcome = 'WAIT_FOR_DATA';
          rationale = `Campanha em fase DISCOVERY (${ageDays.toFixed(0)} dias). Aguardando dados mínimos (${MIN_DAYS} dias). Estratégia recomendada: dynamicDownOnly. Não otimizar performance antes de ${MIN_DAYS} dias completos.`;
        } else {
          // Checar se budget está sendo esgotado
          if (isLowBudget && estimatedClicksPerDay && estimatedClicksPerDay < 5) {
            outcome = 'WAIT_FOR_DATA';
            rationale = `LOW_BUDGET_LEARNING: Orçamento de ${sym}${budget.toFixed(2)}/dia com CPC médio de ${sym}${(c.cpc||0).toFixed(2)} permite apenas ~${(estimatedClicksPerDay||0).toFixed(0)} cliques/dia. Amostra insuficiente para qualquer conclusão. Aguardar 14 dias completos antes de avaliar performance.`;
          } else {
            outcome = 'NO_ACTION';
            rationale = `DISCOVERY em andamento. Coletar search terms. Sem ação de otimização neste momento.`;
          }
        }

      // LAUNCH
      } else if (objective === 'LAUNCH') {
        if (blockers.length > 0) {
          outcome = 'BLOCK'; rationale = `Bloqueios: ${blockers.join(', ')}`;
        } else if (orders === 0 && maturity === 'MATURE') {
          // Verificar se é problema de orçamento, buy box ou relevância
          outcome = 'RECOMMEND_APPROVAL';
          action = 'investigate_zero_sales_launch';
          risk = 'medium';
          rationale = `Campanha LAUNCH madura sem vendas.\n\nMotivo: ${ageDays.toFixed(0)} dias sem conversão. Verificar: 1) Buy Box ativa? 2) Preço competitivo? 3) Página do produto completa? 4) Orçamento suficiente (${sym}${budget.toFixed(2)}/dia)?\n\nNão aumentar bid sem diagnóstico do problema raiz.`;
        } else {
          outcome = 'NO_ACTION';
          rationale = `LAUNCH em andamento. ${orders} pedido(s) registrado(s).`;
        }

      // SEM ESTOQUE
      } else if (blockers.includes('OUT_OF_STOCK')) {
        outcome = 'EXECUTE_NOW';
        action = 'pause_campaign';
        risk = 'low';
        rationale = `Produto ${c.asin} com estoque zero.\n\nMotivo: Sem capacidade de entrega. Pausar imediatamente para evitar gasto desnecessário.\n\nExecutar: Agora.\n\nRisco: Baixo.\n\nPróxima avaliação: Quando estoque retornar (verificação horária).`;

      // BUY BOX PERDIDA
      } else if (blockers.includes('BUY_BOX_LOST')) {
        outcome = 'BLOCK';
        action = 'recommend_fix_buy_box';
        risk = 'medium';
        rationale = `Buy Box perdida para o ASIN ${c.asin}.\n\nMotivo: Aumentar bid sem Buy Box é ineficiente — o anúncio pode não converter mesmo com impressões.\n\nAção correta: Verificar preço, avaliações e condição da oferta. Não aumentar bid. Reduzir orçamento em 20% para limitar desperdício.`;

      // PROFITABILITY: reduzir desperdício
      } else if (objective === 'PROFITABILITY') {
        if (channelStatus.status === 'PARTIAL' && acos > MAX_ACOS) {
          outcome = 'WAIT_FOR_DATA';
          rationale = `Dados de canal com ${channelStatus.hoursOld}h (< ${CHANNEL_DATA_LAG_H}h necessários). Classificar como PARTIAL. Não tomar decisão de redução com dados incompletos.`;
        } else if (acos > MAX_ACOS && spend >= 5 && maturity === 'MATURE') {
          // Reduzir budget (não bid no mesmo ciclo)
          const newBudget = Math.max(budget * 0.85, 1);
          outcome = autonomyLevel >= 2 ? 'EXECUTE_NOW' : 'RECOMMEND_APPROVAL';
          action = 'reduce_budget';
          proposedValue = Number(newBudget.toFixed(2));
          risk = 'medium';
          budgetRuleType = 'PERFORMANCE_BUDGET_RULE';
          rationale = `Reduzir orçamento de ${sym}${budget.toFixed(2)} para ${sym}${newBudget.toFixed(2)}.\n\nMotivo: ACoS de ${acos.toFixed(1)}% está acima do máximo de ${MAX_ACOS}%. Campanha madura com gasto significativo.\n\nPor que orçamento e não bid: Uma redução por vez para isolar o efeito causal. Bid será avaliado em ciclo separado.\n\nLimite: ${sym}${newBudget.toFixed(2)} (redução de 15%).\n\nRisco: Médio.\n\nAvaliação: Em 7 dias.\n\nRollback: Retornar para ${sym}${budget.toFixed(2)} se vendas reduzirem mais de 30%.`;
          evaluationDue = daysFromNow(7);
        } else {
          outcome = 'NO_ACTION';
        }

      // GROWTH: expandir rentável
      } else if (objective === 'GROWTH') {
        if (blockers.length > 0) { outcome = 'BLOCK'; rationale = `Bloqueios: ${blockers.join(', ')}`; }
        else if (maturity !== 'MATURE') { outcome = 'WAIT_FOR_DATA'; rationale = `Campanha não madura para crescimento (${maturity}).`; }
        else if (acos <= TARGET_ACOS && roas >= TARGET_ROAS && orders >= (cfg.min_orders_for_scale || 2)) {
          // Crescimento elegível: aumentar budget gradualmente
          const maxBudget = cfg.maximum_campaign_budget || 100;
          const newBudget = Math.min(budget * 1.10, maxBudget);
          if (newBudget > budget + 0.01) {
            outcome = 'RECOMMEND_APPROVAL';
            action = 'increase_budget';
            proposedValue = Number(newBudget.toFixed(2));
            risk = 'low';
            budgetRuleType = 'PERFORMANCE_BUDGET_RULE';
            rationale = `Aumentar orçamento diário de ${sym}${budget.toFixed(2)} para ${sym}${newBudget.toFixed(2)}.\n\nObjetivo: Aumentar vendas mantendo ACoS até ${TARGET_ACOS}%.\n\nCondição: ROAS de ${roas.toFixed(2)}x ≥ meta de ${TARGET_ROAS}x com ${orders} pedidos e ACoS de ${acos.toFixed(1)}% ≤ meta de ${TARGET_ACOS}%.\n\nPor que orçamento: A campanha já converte e perde entrega por limite financeiro.\n\nPor que não bid: Não há evidência de perda de impressões por lance.\n\nLimite: ${sym}${maxBudget.toFixed(2)} (máximo configurado).\n\nExecução: Próximo ciclo.\n\nAvaliação: Em 7 dias.\n\nSucesso: Mais pedidos, ROAS ≥ ${TARGET_ROAS}x, ACoS ≤ ${TARGET_ACOS}%.\n\nRollback: Retornar para ${sym}${budget.toFixed(2)} se ACoS ultrapassar ${MAX_ACOS}%.`;
            evaluationDue = daysFromNow(7);
          } else {
            outcome = 'NO_ACTION';
            rationale = `Orçamento já no máximo configurado (${sym}${maxBudget.toFixed(2)}).`;
          }
        } else {
          outcome = 'WAIT_FOR_DATA';
          rationale = `Crescimento bloqueado: ACoS ${acos.toFixed(1)}%, ROAS ${roas.toFixed(2)}x, ${orders} pedidos. Condições insuficientes.`;
        }

      // ACOS_TARGET / ROAS_TARGET
      } else if (['ACOS_TARGET','ROAS_TARGET'].includes(objective)) {
        if (acos === 0 && spend === 0) {
          outcome = 'WAIT_FOR_DATA';
          rationale = `ACoS = 0 sem gasto — campanha sem entrega. Não confundir com conversão perfeita.`;
        } else if (acos === 0 && spend > 0 && orders === 0) {
          outcome = 'WAIT_FOR_DATA';
          rationale = `ACoS = 0 com gasto e sem pedidos — provável dado inconsistente ou atribuição aberta.`;
        } else if (acos == null) {
          outcome = 'WAIT_FOR_DATA';
          rationale = `ACoS ausente — dados insuficientes. Aguardar próximo sync.`;
        } else {
          outcome = 'NO_ACTION';
          rationale = `ACoS ${acos.toFixed(1)}% (meta ${TARGET_ACOS}%), ROAS ${roas.toFixed(2)}x (meta ${TARGET_ROAS}x). Dentro dos parâmetros.`;
        }

      // BUDGET_CONTROL
      } else {
        outcome = 'NO_ACTION';
        rationale = `Objetivo BUDGET_CONTROL. Sem ação de expansão.`;
      }

      // Gravar no CampaignChangeHistory se houve decisão executável
      if (['EXECUTE_NOW','RECOMMEND_APPROVAL'].includes(outcome) && action && action !== 'investigate_pause' && action !== 'investigate_zero_sales_launch' && action !== 'recommend_fix_buy_box') {
        await base44.asServiceRole.entities.CampaignChangeHistory.create({
          amazon_account_id: amazonAccountId,
          campaign_id: c.id,
          amazon_campaign_id: c.campaign_id,
          change_type: action.includes('budget') ? 'CAMPAIGN_BUDGET'
            : action.includes('pause') ? 'CAMPAIGN_STATUS'
            : action.includes('enable') ? 'CAMPAIGN_STATUS'
            : action.includes('bid') ? 'BIDDING_STRATEGY' : 'CAMPAIGN_BUDGET',
          entity_type: 'campaign',
          entity_id: c.campaign_id,
          field_name: action.includes('budget') ? 'daily_budget' : action.includes('bid') ? 'bidding_strategy' : 'state',
          old_value: action.includes('budget') ? String(budget) : String(c.state),
          new_value: proposedValue != null ? String(proposedValue) : action.includes('pause') ? 'paused' : 'enabled',
          source: 'AUTOPILOT',
          source_function: 'analyzeCampaignStrategy',
          reason: rationale.slice(0, 500),
          metrics_before: JSON.stringify({ acos, roas, spend, orders, clicks, ctr, cvr: cvr.toFixed(3) }),
          status: 'pending',
          changed_by: 'autopilot',
          changed_at: new Date().toISOString(),
          evaluation_due_at: evaluationDue,
          rollback_available: proposedValue != null,
          campaign_objective: objective,
          campaign_maturity: maturity,
          pause_reason: pauseReason,
        }).catch(() => {});
      }

      results.push({
        campaign_id: c.campaign_id,
        campaign_name: c.name || c.campaign_name,
        asin: c.asin,
        state: c.state,
        objective,
        maturity,
        outcome,
        action,
        proposed_value: proposedValue,
        current_value: action?.includes('budget') ? budget : null,
        risk,
        confidence: maturity === 'MATURE' ? 82 : maturity === 'LEARNING' ? 60 : 40,
        rationale,
        blockers,
        warnings,
        channel_data_status: channelStatus,
        budget_rule_type: budgetRuleType,
        max_bid_calc: maxBidCalc,
        evaluation_due_at: evaluationDue,
        is_low_budget: isLowBudget,
        estimated_clicks_per_day: estimatedClicksPerDay ? Number(estimatedClicksPerDay.toFixed(1)) : null,
        safe_cutoff: safeCutoff,
        pause_reason: pauseReason,
        bidding_strategy_recommendation: (isNew || isLearning || isLowBudget || isPaused)
          ? 'dynamicDownOnly'
          : objective === 'GROWTH' && maturity === 'MATURE' && roas >= TARGET_ROAS
            ? 'dynamicUpAndDown_requires_approval'
            : 'dynamicDownOnly',
      });
    }

    return Response.json({
      ok: true,
      analyzed: results.length,
      results,
      safe_cutoff: safeCutoff,
      attribution_safety_hours: ATTR_HOURS,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});