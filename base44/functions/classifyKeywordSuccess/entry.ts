/**
 * classifyKeywordSuccess — Classifica keywords em 5 níveis: vencedora, promissora, aprendizado, ineficiente, prejudicial
 * Usa fórmula de pontuação 0-100 baseada em rentabilidade, conversão, relevância, volume, eficiência e estabilidade
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, keyword_id, asin, campaign_id } = body;

    if (!amazon_account_id) {
      return Response.json({ error: 'amazon_account_id required' }, { status: 400 });
    }

    // Carregar conta e regras
    const account = await base44.asServiceRole.entities.AmazonAccount.get(amazon_account_id);
    if (!account) {
      return Response.json({ error: 'AmazonAccount não encontrada' }, { status: 404 });
    }

    const budgetRules = await base44.asServiceRole.entities.BudgetRule.filter({ amazon_account_id });
    const rule = budgetRules[0] || {
      target_acos: 25,
      target_roas: 4,
      max_bid: 5.00,
      min_bid: 0.10,
    };

    // Carregar keywords
    let keywords = [];
    if (keyword_id) {
      const kw = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id, keyword_id });
      keywords = kw;
    } else if (asin) {
      keywords = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id, asin });
    } else if (campaign_id) {
      keywords = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id, campaign_id });
    } else {
      keywords = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id }, '-spend', 500);
    }

    const classifications = [];

    for (const kw of keywords) {
      // Métricas
      const impressions = kw.impressions || 0;
      const clicks = kw.clicks || 0;
      const spend = kw.spend || 0;
      const sales = kw.sales || 0;
      const orders = kw.orders || 0;
      const acos = kw.acos || 0;
      const roas = kw.roas || 0;
      const currentBid = kw.current_bid || kw.bid || 0.50;
      const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
      const conversionRate = clicks > 0 ? (orders / clicks) * 100 : 0;

      // Calcular lucro estimado (simplificado: sales - spend)
      const profit = sales - spend;
      const profitMargin = sales > 0 ? (profit / sales) * 100 : 0;

      // === FÓRMULA DE PONTUAÇÃO (0-100) ===
      let score = 0;

      // 1. Rentabilidade (25%)
      let rentabilidadeScore = 0;
      if (profit > 0) {
        if (profitMargin >= 50) rentabilidadeScore = 25;
        else if (profitMargin >= 30) rentabilidadeScore = 20;
        else if (profitMargin >= 15) rentabilidadeScore = 15;
        else if (profitMargin >= 5) rentabilidadeScore = 10;
        else rentabilidadeScore = 5;
      } else if (acos > 0 && acos <= rule.target_acos) {
        rentabilidadeScore = 15; // Dentro da meta mas sem lucro claro
      } else if (acos > rule.target_acos && acos <= rule.target_acos * 1.5) {
        rentabilidadeScore = 5; // Levemente acima
      } else {
        rentabilidadeScore = 0; // Prejuízo
      }
      score += rentabilidadeScore;

      // 2. Conversão (20%)
      let conversaoScore = 0;
      if (orders >= 5 && conversionRate >= 15) conversaoScore = 20;
      else if (orders >= 3 && conversionRate >= 10) conversaoScore = 17;
      else if (orders >= 2 && conversionRate >= 8) conversaoScore = 14;
      else if (orders >= 1 && conversionRate >= 5) conversaoScore = 10;
      else if (orders >= 1) conversaoScore = 7;
      else if (clicks >= 10 && conversionRate > 0) conversaoScore = 5;
      else if (clicks >= 5) conversaoScore = 3;
      else conversaoScore = 1;
      score += conversaoScore;

      // 3. Relevância (15%) - baseada no match entre keyword e produto
      let relevanciaScore = 0;
      const hasName = !!(kw.keyword_text || kw.keyword);
      const hasAsin = !!(kw.asin);
      if (hasName && hasAsin) {
        // Simplificado: assume relevância se está associada a um ASIN
        relevanciaScore = 15;
      } else if (hasName) {
        relevanciaScore = 10;
      } else {
        relevanciaScore = 5;
      }
      score += relevanciaScore;

      // 4. Volume de vendas (15%)
      let volumeScore = 0;
      if (orders >= 10) volumeScore = 15;
      else if (orders >= 5) volumeScore = 12;
      else if (orders >= 3) volumeScore = 10;
      else if (orders >= 2) volumeScore = 8;
      else if (orders >= 1) volumeScore = 5;
      else if (clicks >= 20) volumeScore = 3;
      else if (clicks >= 10) volumeScore = 2;
      else volumeScore = 1;
      score += volumeScore;

      // 5. Eficiência de CPC (10%)
      let cpcScore = 0;
      const cpc = clicks > 0 ? spend / clicks : 0;
      if (cpc > 0 && cpc < 0.30) cpcScore = 10;
      else if (cpc >= 0.30 && cpc < 0.50) cpcScore = 8;
      else if (cpc >= 0.50 && cpc < 0.80) cpcScore = 6;
      else if (cpc >= 0.80 && cpc < 1.20) cpcScore = 4;
      else if (cpc >= 1.20) cpcScore = 2;
      else cpcScore = 5; // Sem dados
      score += cpcScore;

      // 6. Estabilidade histórica (10%)
      let estabilidadeScore = 0;
      const daysRunning = kw.first_seen_at ? 
        Math.floor((Date.now() - new Date(kw.first_seen_at).getTime()) / (1000 * 60 * 60 * 24)) : 0;
      
      if (daysRunning >= 30 && orders >= 5) estabilidadeScore = 10;
      else if (daysRunning >= 14 && orders >= 3) estabilidadeScore = 8;
      else if (daysRunning >= 7 && orders >= 2) estabilidadeScore = 6;
      else if (daysRunning >= 7 && orders >= 1) estabilidadeScore = 5;
      else if (daysRunning >= 3) estabilidadeScore = 3;
      else if (daysRunning >= 1) estabilidadeScore = 2;
      else estabilidadeScore = 1;
      score += estabilidadeScore;

      // 7. Contribuição para vendas totais (5%)
      let contribuicaoScore = 0;
      if (sales >= 100) contribuicaoScore = 5;
      else if (sales >= 50) contribuicaoScore = 4;
      else if (sales >= 20) contribuicaoScore = 3;
      else if (sales >= 10) contribuicaoScore = 2;
      else if (sales >= 5) contribuicaoScore = 1.5;
      else if (sales >= 1) contribuicaoScore = 1;
      else contribuicaoScore = 0.5;
      score += contribuicaoScore;

      // === CLASSIFICAÇÃO ===
      let classification = '';
      let classificationLabel = '';
      let actions = [];

      if (score >= 85) {
        classification = 'vencedora';
        classificationLabel = 'Vencedora';
        actions = [
          'Manter ativa',
          'Priorizar no orçamento',
          'Aumentar bid gradualmente (+R$0.05 a +R$0.10)',
          'Testar maior presença no topo da pesquisa',
          'Proteger em campanha manual exata',
          'Acompanhar por horário e placement',
        ];
      } else if (score >= 70) {
        classification = 'promissora';
        classificationLabel = 'Promissora';
        actions = [
          'Manter em teste',
          'Preservar bid atual',
          'Aguardar maturação dos dados',
          'Evitar aumento agressivo',
          'Monitorar conversão',
        ];
      } else if (score >= 50) {
        classification = 'aprendizado';
        classificationLabel = 'Em Aprendizado';
        actions = [
          'Manter ativa por período controlado',
          'Não pausar prematuramente',
          'Observar bid sugerido',
          'Verificar indexação e elegibilidade',
          'Aguardar mais dados (mínimo 7-14 dias)',
        ];
      } else if (score >= 30) {
        classification = 'ineficiente';
        classificationLabel = 'Ineficiente';
        actions = [
          'Reduzir bid (-R$0.10)',
          'Revisar correspondência (match type)',
          'Analisar search terms relacionados',
          'Limitar horários ruins',
          'Considerar pausa se persistir',
        ];
      } else {
        classification = 'prejudicial';
        classificationLabel = 'Prejudicial';
        actions = [
          'Pausar imediatamente',
          'Adicionar como negativa',
          'Impedir nova inclusão automática',
          'Registrar como termo reprovado',
          'Revisar relevância com o produto',
        ];
      }

      // === CRITÉRIOS MÍNIMOS PARA SUCESSO COMPROVADO ===
      const hasMinimumSuccess = 
        orders >= 1 &&
        acos > 0 && acos <= rule.target_acos &&
        roas >= rule.target_roas &&
        profit >= 0;

      classifications.push({
        keyword_id: kw.keyword_id,
        keyword_text: kw.keyword_text || kw.keyword,
        asin: kw.asin,
        campaign_id: kw.campaign_id,
        ad_group_id: kw.ad_group_id,
        match_type: kw.match_type,
        metrics: {
          impressions,
          clicks,
          spend,
          sales,
          orders,
          acos,
          roas,
          ctr: parseFloat(ctr.toFixed(2)),
          conversion_rate: parseFloat(conversionRate.toFixed(2)),
          cpc: parseFloat(cpc.toFixed(2)),
          profit: parseFloat(profit.toFixed(2)),
          profit_margin: parseFloat(profitMargin.toFixed(2)),
        },
        score: parseFloat(score.toFixed(1)),
        classification,
        classification_label: classificationLabel,
        is_winner: classification === 'vencedora',
        has_minimum_success,
        days_running: daysRunning,
        actions,
        breakdown: {
          rentabilidade: rentabilidadeScore,
          conversao: conversaoScore,
          relevancia: relevanciaScore,
          volume: volumeScore,
          eficiencia_cpc: cpcScore,
          estabilidade: estabilidadeScore,
          contribuicao: contribuicaoScore,
        },
      });
    }

    // Estatísticas
    const stats = {
      total: classifications.length,
      vencedora: classifications.filter(c => c.classification === 'vencedora').length,
      promissora: classifications.filter(c => c.classification === 'promissora').length,
      aprendizado: classifications.filter(c => c.classification === 'aprendizado').length,
      ineficiente: classifications.filter(c => c.classification === 'ineficiente').length,
      prejudicial: classifications.filter(c => c.classification === 'prejudicial').length,
      avg_score: classifications.length > 0 
        ? parseFloat((classifications.reduce((sum, c) => sum + c.score, 0) / classifications.length).toFixed(1))
        : 0,
      total_spend: classifications.reduce((sum, c) => sum + c.metrics.spend, 0),
      total_sales: classifications.reduce((sum, c) => sum + c.metrics.sales, 0),
      total_orders: classifications.reduce((sum, c) => sum + c.metrics.orders, 0),
    };

    return Response.json({
      ok: true,
      account_id: amazon_account_id,
      analyzed_at: new Date().toISOString(),
      target_acos: rule.target_acos,
      target_roas: rule.target_roas,
      classifications,
      stats,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});