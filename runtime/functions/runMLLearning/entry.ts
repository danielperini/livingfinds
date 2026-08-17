/**
 * runMLLearning — Motor de Machine Learning sem frontend
 *
 * O que faz:
 *  1. Lê todas as OptimizationDecisions executadas com outcome registrado
 *  2. Calcula métricas reais de sucesso por tipo de decisão (bid_up, bid_down, harvest, negative, budget)
 *  3. Aprende quais parâmetros levaram a resultados melhores (feature importance)
 *  4. Se confiança >= 95% → atualiza AutopilotConfig E MLModel automaticamente (sem aprovação humana)
 *  5. Identifica e promove termos de cauda média (2-3 palavras) e longa (4+ palavras) do SearchTerm
 *     com >= 1 pedido para o TermBank e gera KeywordSuggestions
 *  6. Registra tudo em LearningEvent para rastreabilidade
 *
 * Rodado diariamente às 04:00 pelo scheduler (janela pós-atribuição, pré-otimização)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ── Defaults ─────────────────────────────────────────────────────────────────
const CONFIDENCE_THRESHOLD = 0.95; // threshold para aplicar mudanças automáticas
const MIN_SAMPLES = 10;            // mínimo de amostras para treinar

function norm(s: string): string {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ');
}

function wordCount(s: string): number {
  return (s || '').trim().split(/\s+/).filter(Boolean).length;
}

// Média ponderada — amostras mais recentes têm peso maior
function weightedAvg(values: number[], decayFactor = 0.9): number {
  if (!values.length) return 0;
  let total = 0, weight = 0;
  for (let i = 0; i < values.length; i++) {
    const w = Math.pow(decayFactor, values.length - 1 - i);
    total += values[i] * w;
    weight += w;
  }
  return total / weight;
}

// Confiança estatística baseada no tamanho da amostra (Wilson score simplificado)
function calcStatConfidence(positives: number, total: number): number {
  if (total === 0) return 0;
  const p = positives / total;
  // Intervalo de Wilson lower bound simplificado
  const z = 1.96;
  const lower = (p + z * z / (2 * total) - z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total))
    / (1 + z * z / total);
  return Math.min(0.99, Math.max(0, lower));
}

// Clamp com guardrails de segurança
function clampParam(name: string, newVal: number, current: number, maxChange: number, min: number, max: number): { value: number; clamped: boolean } {
  const maxDelta = current * maxChange;
  const clamped = Math.min(Math.max(newVal, current - maxDelta, min), current + maxDelta, max);
  return { value: Math.round(clamped * 100) / 100, clamped: Math.abs(clamped - newVal) > 0.001 };
}

// ── Handler principal ─────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  try {
    const body = await req.json().catch(() => ({}));

    // Resolver conta
    let account: any = null;
    const aid = body.amazon_account_id;
    if (aid) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: aid });
      account = accs[0] || null;
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0] || null;
    }
    if (!account) return Response.json({ ok: false, message: 'Nenhuma conta conectada.' });

    const accountId = account.id;
    const sym = account.currency_symbol || 'R$';
    const log: string[] = [];

    // ── 1. Carregar modelo atual (ou criar) ──────────────────────────────────
    const existingModels = await base44.asServiceRole.entities.MLModel.filter({ amazon_account_id: accountId });
    let model = existingModels[0] || null;

    // ── 2. Carregar decisões executadas com outcome ───────────────────────────
    // Janela: últimos 60 dias para ter volume
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
    const decisions = await base44.asServiceRole.entities.OptimizationDecision.filter(
      { amazon_account_id: accountId }, '-created_at', 2000
    );

    const evaluated = decisions.filter((d: any) =>
      d.status === 'executed' &&
      d.outcome &&
      d.outcome !== 'insufficient_data' &&
      d.created_at >= sixtyDaysAgo
    );

    log.push(`Decisões avaliadas (60d): ${evaluated.length}`);

    if (evaluated.length < MIN_SAMPLES) {
      log.push(`Amostras insuficientes (${evaluated.length} < ${MIN_SAMPLES}). ML aguardando dados.`);
      await base44.asServiceRole.entities.LearningEvent.create({
        amazon_account_id: accountId,
        event_type: 'ml_learning_skipped',
        entity_type: 'account', entity_id: accountId,
        observation: `ML: amostras insuficientes (${evaluated.length}/${MIN_SAMPLES}). Aguardando execuções avaliadas.`,
        recorded_at: now,
      }).catch(() => {});
      return Response.json({ ok: true, skipped: true, reason: `Menos de ${MIN_SAMPLES} amostras avaliadas.`, samples: evaluated.length });
    }

    // ── 3. Análise por tipo de decisão ───────────────────────────────────────
    type DecisionGroup = { positive: number; total: number; valuesBefore: number[]; valuesAfter: number[]; changePcts: number[] };
    const groups: Record<string, DecisionGroup> = {
      bid_increase:   { positive: 0, total: 0, valuesBefore: [], valuesAfter: [], changePcts: [] },
      bid_decrease:   { positive: 0, total: 0, valuesBefore: [], valuesAfter: [], changePcts: [] },
      budget_increase:{ positive: 0, total: 0, valuesBefore: [], valuesAfter: [], changePcts: [] },
      budget_decrease:{ positive: 0, total: 0, valuesBefore: [], valuesAfter: [], changePcts: [] },
      harvest:        { positive: 0, total: 0, valuesBefore: [], valuesAfter: [], changePcts: [] },
      negative:       { positive: 0, total: 0, valuesBefore: [], valuesAfter: [], changePcts: [] },
    };

    for (const d of evaluated) {
      const isPositive = d.outcome === 'positive';
      const action = (d.action || '').toLowerCase();
      const decType = (d.decision_type || '').toLowerCase();
      const chPct = d.change_pct || 0;

      let groupKey = '';
      if (decType === 'bid_change' && (action.includes('increase') || chPct > 0)) groupKey = 'bid_increase';
      else if (decType === 'bid_change' && (action.includes('reduce') || chPct < 0)) groupKey = 'bid_decrease';
      else if (decType === 'budget_change' && (action.includes('increase') || chPct > 0)) groupKey = 'budget_increase';
      else if (decType === 'budget_change' && (action.includes('reduce') || chPct < 0)) groupKey = 'budget_decrease';
      else if (decType === 'harvest_search_term' || decType === 'create_keyword') groupKey = 'harvest';
      else if (decType === 'negative_keyword') groupKey = 'negative';
      else continue;

      const g = groups[groupKey];
      g.total++;
      if (isPositive) g.positive++;
      if (d.value_before != null) g.valuesBefore.push(d.value_before);
      if (d.value_after != null) g.valuesAfter.push(d.value_after);
      if (chPct) g.changePcts.push(Math.abs(chPct));
    }

    // ── 4. Calcular novas recomendações de parâmetros ────────────────────────
    const paramUpdates: Record<string, number> = {};
    const paramReasons: string[] = [];
    let totalParamConfidence = 0;
    let paramConfidenceCount = 0;

    // 4a. Bid increase: se taxa de sucesso alta → pode aumentar max_bid_increase_pct
    const biG = groups.bid_increase;
    if (biG.total >= 5) {
      const successRate = biG.positive / biG.total;
      const conf = calcStatConfidence(biG.positive, biG.total);
      const avgChangePct = weightedAvg(biG.changePcts);
      log.push(`bid_increase: ${biG.positive}/${biG.total} positivos (${(successRate*100).toFixed(1)}%), conf=${(conf*100).toFixed(1)}%, avgChg=${avgChangePct.toFixed(1)}%`);

      if (conf >= CONFIDENCE_THRESHOLD && successRate >= 0.75) {
        // Se alta taxa de sucesso → pequeno aumento no limite de incremento (mais agressivo)
        const newPct = Math.min(25, (model?.max_bid_increase_pct || 15) * 1.10);
        paramUpdates['max_bid_increase_pct'] = Math.round(newPct * 10) / 10;
        paramReasons.push(`bid_increase: sucesso ${(successRate*100).toFixed(0)}% (${biG.total} amostras) → max_bid_increase_pct aumentado para ${newPct.toFixed(1)}%`);
      } else if (conf >= CONFIDENCE_THRESHOLD && successRate < 0.45) {
        // Baixa taxa de sucesso → reduzir incremento máximo
        const newPct = Math.max(5, (model?.max_bid_increase_pct || 15) * 0.85);
        paramUpdates['max_bid_increase_pct'] = Math.round(newPct * 10) / 10;
        paramReasons.push(`bid_increase: sucesso baixo ${(successRate*100).toFixed(0)}% (${biG.total} amostras) → max_bid_increase_pct reduzido para ${newPct.toFixed(1)}%`);
      }
      if (conf >= CONFIDENCE_THRESHOLD) { totalParamConfidence += conf; paramConfidenceCount++; }

      // Aprender bid_winner_increase_pct: média dos changePcts positivos
      const positiveChanges = biG.changePcts.filter((_, i) => evaluated.filter(d => d.decision_type === 'bid_change' && (d.change_pct || 0) > 0)[i]?.outcome === 'positive');
      if (positiveChanges.length >= 3) {
        const idealIncrease = weightedAvg(positiveChanges);
        const winnerPct = Math.min(15, Math.max(3, idealIncrease * 0.7));
        paramUpdates['bid_winner_increase_pct'] = Math.round(winnerPct * 10) / 10;
      }
    }

    // 4b. Bid decrease: se taxa de sucesso alta → pode ser mais agressivo na redução
    const bdG = groups.bid_decrease;
    if (bdG.total >= 5) {
      const successRate = bdG.positive / bdG.total;
      const conf = calcStatConfidence(bdG.positive, bdG.total);
      const avgChangePct = weightedAvg(bdG.changePcts);
      log.push(`bid_decrease: ${bdG.positive}/${bdG.total} positivos (${(successRate*100).toFixed(1)}%), conf=${(conf*100).toFixed(1)}%`);

      if (conf >= CONFIDENCE_THRESHOLD && successRate >= 0.75) {
        const newPct = Math.min(35, (model?.max_bid_decrease_pct || 20) * 1.05);
        paramUpdates['max_bid_decrease_pct'] = Math.round(newPct * 10) / 10;
        paramReasons.push(`bid_decrease: sucesso ${(successRate*100).toFixed(0)}% → max_bid_decrease_pct para ${newPct.toFixed(1)}%`);
      }
      if (conf >= CONFIDENCE_THRESHOLD) { totalParamConfidence += conf; paramConfidenceCount++; }

      // Aprender target_acos: se reduções de bid estão convergindo, o ACoS real médio pode virar o novo target
      if (avgChangePct > 0 && bdG.total >= 8) {
        const currentTargetAcos = model?.target_acos || 25;
        // Se muitas reduções positivas → mercado está suportando um target mais agressivo
        const adjustment = successRate >= 0.70 ? -1.5 : successRate < 0.40 ? +2 : 0;
        if (Math.abs(adjustment) > 0) {
          const newTarget = Math.min(40, Math.max(10, currentTargetAcos + adjustment));
          paramUpdates['target_acos'] = Math.round(newTarget * 10) / 10;
          paramReasons.push(`target_acos ajustado para ${newTarget.toFixed(1)}% baseado em ${bdG.total} reduções (${(successRate*100).toFixed(0)}% sucesso)`);
        }
      }
    }

    // 4c. Harvest: se alta taxa → reduzir threshold de pedidos necessários
    const hvG = groups.harvest;
    if (hvG.total >= 5) {
      const successRate = hvG.positive / hvG.total;
      const conf = calcStatConfidence(hvG.positive, hvG.total);
      log.push(`harvest: ${hvG.positive}/${hvG.total} positivos (${(successRate*100).toFixed(1)}%), conf=${(conf*100).toFixed(1)}%`);

      if (conf >= CONFIDENCE_THRESHOLD) {
        if (successRate >= 0.80) {
          paramUpdates['harvest_after_orders'] = 1; // já é 1, manter
          paramReasons.push(`harvest: alta taxa de sucesso ${(successRate*100).toFixed(0)}% — harvest com 1 pedido confirmado.`);
        }
        totalParamConfidence += conf; paramConfidenceCount++;
      }

      // Aprender min_clicks_for_decision baseado em amostras de harvest
      const avgBidAfter = weightedAvg(hvG.valuesAfter);
      if (avgBidAfter > 0) {
        paramUpdates['avg_harvest_conversion_rate'] = successRate;
      }
    }

    // 4d. Negative: se alta taxa → pode relaxar o min_clicks para negativação
    const ngG = groups.negative;
    if (ngG.total >= 5) {
      const successRate = ngG.positive / ngG.total;
      const conf = calcStatConfidence(ngG.positive, ngG.total);
      log.push(`negative: ${ngG.positive}/${ngG.total} positivos (${(successRate*100).toFixed(1)}%), conf=${(conf*100).toFixed(1)}%`);

      if (conf >= CONFIDENCE_THRESHOLD && successRate >= 0.75) {
        // Alta taxa de sucesso → pode negativar com menos cliques
        const currentMin = model?.min_clicks_for_decision || 8;
        const newMin = Math.max(5, Math.round(currentMin * 0.90));
        paramUpdates['min_clicks_for_decision'] = newMin;
        paramReasons.push(`negative: sucesso ${(successRate*100).toFixed(0)}% → min_clicks_for_decision reduzido para ${newMin}`);
        totalParamConfidence += conf; paramConfidenceCount++;
      }
    }

    // 4e. Budget changes
    const buiG = groups.budget_increase;
    if (buiG.total >= 3) {
      const successRate = buiG.positive / buiG.total;
      const conf = calcStatConfidence(buiG.positive, buiG.total);
      if (conf >= CONFIDENCE_THRESHOLD && successRate >= 0.75) {
        const newPct = Math.min(35, (model?.max_budget_increase_pct || 20) * 1.10);
        paramUpdates['max_budget_increase_pct'] = Math.round(newPct * 10) / 10;
        paramReasons.push(`budget_increase: sucesso ${(successRate*100).toFixed(0)}% → max_budget_increase_pct para ${newPct.toFixed(1)}%`);
      }
    }

    // ── 5. Feature importances (análise de quais fatores mais correlacionam com sucesso) ──
    const featureImportances: Record<string, number> = {};
    for (const d of evaluated) {
      if (d.outcome !== 'positive') continue;
      const data = (() => { try { return JSON.parse(d.data_used || '{}'); } catch { return {}; } })();
      // Verificar quais features estavam presentes em decisões positivas
      if (data.confidence >= 0.85) featureImportances['high_confidence'] = (featureImportances['high_confidence'] || 0) + 1;
      if (data.maturity === 'MATURE') featureImportances['mature_data'] = (featureImportances['mature_data'] || 0) + 1;
      if (data.orders >= 2) featureImportances['multi_order'] = (featureImportances['multi_order'] || 0) + 1;
      if (data.strong_winner) featureImportances['strong_winner'] = (featureImportances['strong_winner'] || 0) + 1;
    }

    // ── 6. Média global de confiança das mudanças ────────────────────────────
    const avgParamConfidence = paramConfidenceCount > 0
      ? totalParamConfidence / paramConfidenceCount
      : 0;

    const canAutoApply = avgParamConfidence >= CONFIDENCE_THRESHOLD && Object.keys(paramUpdates).length > 0;

    // ── 7. Descoberta de termos de cauda média e longa ───────────────────────
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const searchTerms = await base44.asServiceRole.entities.SearchTerm.filter(
      { amazon_account_id: accountId }, '-orders_14d', 2000
    );

    const termBankExisting = await base44.asServiceRole.entities.TermBank.filter(
      { amazon_account_id: accountId }, null, 2000
    );
    const tbNorms = new Set(termBankExisting.map((t: any) => `${norm(t.term)}|${t.asin}`));

    const kwSuggExisting = await base44.asServiceRole.entities.KeywordSuggestion.filter(
      { amazon_account_id: accountId }, null, 2000
    );
    const suggNorms = new Set(kwSuggExisting.map((s: any) => `${norm(s.keyword)}|${s.asin}`));

    type TailTerm = { term: string; asin: string; sku: string; product_name: string; orders: number; spend: number; sales: number; acos: number; cpc: number; clicks: number; campaign_id: string; tail: string };
    const mediumTailTerms: TailTerm[] = [];
    const longTailTerms: TailTerm[] = [];

    const seenTerms = new Set<string>();
    for (const st of searchTerms) {
      const term = norm(st.search_term || st.keyword_text || '');
      if (!term || !st.advertised_asin) continue;
      const words = wordCount(term);
      const orders = (st.orders_14d || 0) + (st.orders_7d || 0);
      if (orders < 1) continue; // só termos que já converteram

      const termKey = `${term}|${st.advertised_asin}`;
      if (seenTerms.has(termKey)) continue;
      seenTerms.add(termKey);

      const spend = st.spend || 0;
      const sales = (st.sales_14d || 0) + (st.sales_7d || 0);
      const acos = sales > 0 ? (spend / sales) * 100 : 0;
      const cpc = st.cpc || 0;
      const clicks = st.clicks || 0;

      const entry: TailTerm = {
        term,
        asin: st.advertised_asin,
        sku: st.advertised_sku || '',
        product_name: '',
        orders, spend, sales, acos, cpc, clicks,
        campaign_id: st.campaign_id || '',
        tail: words >= 4 ? 'long' : 'medium',
      };

      if (words >= 4) longTailTerms.push(entry);
      else if (words >= 2) mediumTailTerms.push(entry);
    }

    // Ordenar por pedidos DESC
    const allTailTerms = [...longTailTerms, ...mediumTailTerms]
      .sort((a, b) => b.orders - a.orders)
      .slice(0, 200); // processar top 200

    let termBankAdded = 0;
    let suggestionsAdded = 0;

    for (const t of allTailTerms) {
      const termKey = `${t.term}|${t.asin}`;
      const isMedium = wordCount(t.term) >= 2 && wordCount(t.term) <= 3;
      const isLong = wordCount(t.term) >= 4;

      // Adicionar ao TermBank se >= 4 pedidos e não existe ainda
      if (t.orders >= 4 && !tbNorms.has(termKey)) {
        const perfScore = Math.min(100, Math.round(
          t.orders * 8 +
          (t.acos > 0 ? Math.max(0, 30 - t.acos * 0.6) : 0) +
          Math.min(10, Math.log10(t.clicks + 1) * 5)
        ));
        const cls = t.orders >= 4 && perfScore >= 60 ? 'winner' : t.orders >= 1 ? 'learning' : 'new';
        const bid = t.cpc > 0 ? Math.min(5.0, Math.max(0.10, t.cpc * 1.10)) : 0.50;
        const confBoost = isLong ? (model?.long_tail_confidence_boost || 0.05) : 0;

        await base44.asServiceRole.entities.TermBank.create({
          amazon_account_id: accountId,
          term: t.term,
          term_normalized: t.term,
          asin: t.asin,
          match_type: 'exact',
          source: 'search_term_auto',
          status: 'active',
          campaign_id: t.campaign_id,
          impressions: 0, clicks: t.clicks,
          spend: t.spend, sales: t.sales, orders: t.orders,
          acos: t.acos, roas: t.sales > 0 ? t.sales / t.spend : 0,
          cpc: t.cpc, ctr: 0, conversion_rate: t.clicks > 0 ? t.orders / t.clicks : 0,
          bid_initial: bid, bid_current: bid,
          performance_score: perfScore,
          classification: cls,
          first_seen_at: now, last_seen_at: now,
          last_performance_update: now, created_at: now,
        }).catch(() => {});
        tbNorms.add(termKey);
        termBankAdded++;
      }

      // Gerar KeywordSuggestion para os top termos ainda não sugeridos
      if (!suggNorms.has(termKey) && (t.orders >= 1)) {
        const confidence = Math.min(0.98, 0.65 + t.orders * 0.07 + (isLong ? 0.05 : 0));
        const bid = t.cpc > 0 ? Math.min(5.0, Math.max(0.10, t.cpc * 1.10)) : 0.50;
        const tail_type = isLong ? 'long' : 'medium';

        await base44.asServiceRole.entities.KeywordSuggestion.create({
          amazon_account_id: accountId,
          asin: t.asin,
          sku: t.sku || null,
          keyword: t.term,
          normalized_keyword: t.term,
          tail_type,
          match_type: 'exact',
          intent: 'high_purchase_intent',
          relevance_score: confidence,
          confidence,
          reason: `${tail_type === 'long' ? 'Cauda longa' : 'Cauda média'} com ${t.orders} pedido(s). CPC R$${t.cpc.toFixed(2)}. Descoberto pelo ML.`,
          source: 'AUTOMATIC_SEARCH_TERM',
          status: 'suggested',
          recommended_bid: bid,
          recommended_budget: 5,
          bid_confidence: confidence >= 0.85 ? 'high' : confidence >= 0.70 ? 'medium' : 'low',
          created_at: now,
        }).catch(() => {});
        suggNorms.add(termKey);
        suggestionsAdded++;
      }
    }

    log.push(`Termos cauda média: ${mediumTailTerms.length} | longa: ${longTailTerms.length} | TermBank +${termBankAdded} | Sugestões +${suggestionsAdded}`);

    // ── 8. Aplicar parâmetros aprendidos se confiança >= 95% ─────────────────
    let paramsApplied = 0;
    const autopilotUpdates: Record<string, number> = {};

    if (canAutoApply) {
      // Aplicar com guardrails de segurança (max ±20% do valor atual por ciclo de aprendizado)
      const safeCfgs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: accountId });
      const cfg = safeCfgs[0];

      if (cfg) {
        const safe = (key: string, newVal: number, curr: number, minV: number, maxV: number) => {
          const r = clampParam(key, newVal, curr, 0.20, minV, maxV);
          return r.value;
        };

        if (paramUpdates['target_acos'] !== undefined)
          autopilotUpdates['target_acos'] = safe('target_acos', paramUpdates['target_acos'], cfg.target_acos || 25, 10, 50);
        if (paramUpdates['max_bid_increase_pct'] !== undefined)
          autopilotUpdates['max_bid_increase_pct'] = safe('max_bid_increase_pct', paramUpdates['max_bid_increase_pct'], cfg.max_bid_increase_pct || 15, 5, 30);
        if (paramUpdates['max_bid_decrease_pct'] !== undefined)
          autopilotUpdates['max_bid_decrease_pct'] = safe('max_bid_decrease_pct', paramUpdates['max_bid_decrease_pct'], cfg.max_bid_decrease_pct || 20, 5, 40);
        if (paramUpdates['max_budget_increase_pct'] !== undefined)
          autopilotUpdates['max_budget_increase_pct'] = safe('max_budget_increase_pct', paramUpdates['max_budget_increase_pct'], cfg.max_budget_increase_pct || 20, 5, 40);
        if (paramUpdates['min_clicks_for_decision'] !== undefined)
          autopilotUpdates['min_clicks_for_decision'] = safe('min_clicks_for_decision', paramUpdates['min_clicks_for_decision'], cfg.min_clicks_for_decision || 8, 3, 20);

        if (Object.keys(autopilotUpdates).length > 0) {
          await base44.asServiceRole.entities.AutopilotConfig.update(cfg.id, autopilotUpdates);
          paramsApplied = Object.keys(autopilotUpdates).length;
          log.push(`AutopilotConfig atualizado automaticamente (conf=${(avgParamConfidence*100).toFixed(1)}%): ${JSON.stringify(autopilotUpdates)}`);
        }
      }
    }

    // ── 9. Salvar / atualizar MLModel ────────────────────────────────────────
    const mlModelData = {
      amazon_account_id: accountId,
      model_version: (model?.model_version || 0) + 1,
      trained_at: now,
      training_samples: evaluated.length,
      confidence_score: Math.round(avgParamConfidence * 100) / 100,

      // Parâmetros aprendidos (ou mantém os anteriores se não houve update)
      target_acos: autopilotUpdates['target_acos'] || model?.target_acos || 25,
      max_bid_increase_pct: autopilotUpdates['max_bid_increase_pct'] || model?.max_bid_increase_pct || 15,
      max_bid_decrease_pct: autopilotUpdates['max_bid_decrease_pct'] || model?.max_bid_decrease_pct || 20,
      max_budget_increase_pct: autopilotUpdates['max_budget_increase_pct'] || model?.max_budget_increase_pct || 20,
      min_clicks_for_decision: autopilotUpdates['min_clicks_for_decision'] || model?.min_clicks_for_decision || 8,
      bid_winner_increase_pct: paramUpdates['bid_winner_increase_pct'] || model?.bid_winner_increase_pct || 5,
      harvest_after_orders: paramUpdates['harvest_after_orders'] || model?.harvest_after_orders || 1,

      // Métricas de performance histórica
      avg_positive_outcome_rate: evaluated.filter((d: any) => d.outcome === 'positive').length / evaluated.length,
      avg_bid_increase_roi: biG.total > 0 ? biG.positive / biG.total : 0,
      avg_bid_decrease_roi: bdG.total > 0 ? bdG.positive / bdG.total : 0,
      avg_harvest_conversion_rate: hvG.total > 0 ? hvG.positive / hvG.total : 0,
      avg_negative_keyword_savings: ngG.total > 0 ? ngG.positive / ngG.total : 0,

      param_changes_applied: (model?.param_changes_applied || 0) + paramsApplied,
      last_param_update_at: paramsApplied > 0 ? now : (model?.last_param_update_at || null),
      last_param_update_reason: paramReasons.join(' | ') || model?.last_param_update_reason || null,

      medium_tail_min_words: 2,
      medium_tail_max_words: 3,
      long_tail_min_words: 4,
      long_tail_confidence_boost: 0.05,

      feature_importances: JSON.stringify(featureImportances),
      training_log: log.slice(-20).join('\n'),
    };

    if (model) {
      await base44.asServiceRole.entities.MLModel.update(model.id, mlModelData);
    } else {
      await base44.asServiceRole.entities.MLModel.create(mlModelData);
    }

    // ── 10. Registrar evento de aprendizado ──────────────────────────────────
    await base44.asServiceRole.entities.LearningEvent.create({
      amazon_account_id: accountId,
      event_type: 'ml_learning_cycle',
      entity_type: 'account', entity_id: accountId,
      observation: [
        `ML v${mlModelData.model_version} — ${evaluated.length} amostras`,
        `Conf. global: ${(avgParamConfidence*100).toFixed(1)}%`,
        canAutoApply ? `AUTO-APLICADO: ${paramsApplied} params` : 'Confiança insuficiente para auto-apply',
        `Cauda: +${termBankAdded} TermBank, +${suggestionsAdded} sugestões`,
        paramReasons.length > 0 ? `Razões: ${paramReasons.join(' | ')}` : '',
      ].filter(Boolean).join(' · '),
      recorded_at: now,
    }).catch(() => {});

    return Response.json({
      ok: true,
      model_version: mlModelData.model_version,
      training_samples: evaluated.length,
      confidence: avgParamConfidence,
      auto_applied: canAutoApply,
      params_updated: paramsApplied,
      params_changed: autopilotUpdates,
      param_reasons: paramReasons,
      tail_terms: {
        medium: mediumTailTerms.length,
        long: longTailTerms.length,
        term_bank_added: termBankAdded,
        suggestions_added: suggestionsAdded,
      },
      group_stats: Object.fromEntries(
        Object.entries(groups).map(([k, g]) => [k, {
          total: g.total,
          positive: g.positive,
          rate: g.total > 0 ? Number((g.positive / g.total * 100).toFixed(1)) : 0,
        }])
      ),
      log,
    });

  } catch (error: any) {
    console.error('[runMLLearning]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});