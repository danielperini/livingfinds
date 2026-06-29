/**
 * runLearnerCycle — Motor de aprendizado IA do LivingFinds
 * Usa InvokeLLM para análise contextual e gera decisões precisas.
 * Evita duplicatas verificando decisões pendentes existentes.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id } = body;
    if (!amazon_account_id) return Response.json({ error: 'amazon_account_id required' }, { status: 400 });

    // Carregar dados de campanhas, keywords e histórico de decisões
    const [campaigns, keywords, existingDecisions, learningHistory] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id }, '-spend', 300),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id }, '-spend', 500),
      base44.asServiceRole.entities.Decision.filter({ amazon_account_id, status: 'pending' }, '-created_date', 100),
      base44.asServiceRole.entities.LearningEvent.filter({ amazon_account_id }, '-recorded_at', 20),
    ]);

    // IDs já em análise — evitar duplicatas
    const pendingEntityIds = new Set(existingDecisions.map(d => d.entity_id));

    // Resumo para o LLM
    const campaignSummary = campaigns
      .filter(c => c.state !== 'archived' && (c.spend || 0) > 1)
      .slice(0, 30)
      .map(c => ({
        id: c.campaign_id,
        name: c.name,
        state: c.state,
        type: c.campaign_type || 'SP',
        budget: c.daily_budget,
        spend: Number((c.spend || 0).toFixed(2)),
        sales: Number((c.sales || 0).toFixed(2)),
        acos: Number((c.acos || 0).toFixed(1)),
        roas: Number((c.roas || 0).toFixed(2)),
        clicks: c.clicks || 0,
        orders: c.orders || 0,
        cpc: Number((c.cpc || 0).toFixed(2)),
        has_pending: pendingEntityIds.has(c.campaign_id),
      }));

    const keywordSummary = keywords
      .filter(k => (k.clicks || 0) >= 5 && k.state !== 'archived')
      .slice(0, 30)
      .map(k => ({
        id: k.keyword_id,
        text: k.keyword_text,
        match: k.match_type,
        bid: Number((k.bid || 0).toFixed(2)),
        spend: Number((k.spend || 0).toFixed(2)),
        sales: Number((k.sales || 0).toFixed(2)),
        acos: Number((k.acos || 0).toFixed(1)),
        clicks: k.clicks || 0,
        has_pending: pendingEntityIds.has(k.keyword_id),
      }));

    const learningContext = learningHistory
      .slice(0, 5)
      .map(e => `[${e.event_type}] ${e.observation}`)
      .join('\n');

    // ── Análise IA com InvokeLLM ──
    const prompt = `Você é um especialista em Amazon Ads com foco em e-commerce brasileiro.
Analise os dados abaixo e gere decisões de otimização CONCRETAS e ACIONÁVEIS.

CONTEXTO DO APRENDIZADO ANTERIOR:
${learningContext || 'Nenhum histórico disponível.'}

CAMPANHAS (top 30 por spend):
${JSON.stringify(campaignSummary, null, 2)}

KEYWORDS (top 30 por spend, mínimo 5 cliques):
${JSON.stringify(keywordSummary, null, 2)}

REGRAS DE NEGÓCIO:
- ACoS meta: 25% | ROAS meta: 4x
- Redução máxima de bid: 20% | Aumento máximo: 15%
- Bid mínimo: $0.10 | Bid máximo: $5.00
- Não gerar decisão para entidades com has_pending=true
- Pausas de campanha exigem evidência forte (ACoS > 80% ou spend > $30 sem venda)
- Sugerir negativação para keywords com ≥10 cliques, spend > $3 e zero vendas

Gere 5 a 15 decisões otimizadas priorizando alto impacto e baixo risco.
Para cada decisão, calcule os valores exatos com base nos dados fornecidos.`;

    const aiResult = await base44.asServiceRole.integrations.Core.InvokeLLM({
      prompt,
      response_json_schema: {
        type: 'object',
        properties: {
          analysis_summary: { type: 'string' },
          decisions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                decision_type: {
                  type: 'string',
                  enum: ['bid_adjust', 'budget_change', 'pause_campaign', 'enable_campaign', 'negate_keyword', 'add_keyword'],
                },
                entity_type: { type: 'string', enum: ['campaign', 'keyword', 'product'] },
                entity_id: { type: 'string' },
                entity_name: { type: 'string' },
                rationale: { type: 'string' },
                current_value: { type: 'number' },
                proposed_value: { type: 'number' },
                change_pct: { type: 'number' },
                confidence: { type: 'number' },
                priority: { type: 'string', enum: ['high', 'medium', 'low'] },
              },
              required: ['decision_type', 'entity_type', 'entity_id', 'entity_name', 'rationale', 'priority'],
            },
          },
        },
      },
    });

    const aiDecisions = aiResult?.decisions || [];

    // Filtrar duplicatas e criar decisões
    const newDecisions = [];
    for (const d of aiDecisions) {
      if (!d.entity_id || pendingEntityIds.has(d.entity_id)) continue;
      // Validar limites de bid
      if (d.decision_type === 'bid_adjust' && d.proposed_value != null) {
        if (d.proposed_value < 0.10) d.proposed_value = 0.10;
        if (d.proposed_value > 5.00) d.proposed_value = 5.00;
      }
      const created = await base44.asServiceRole.entities.Decision.create({
        amazon_account_id,
        decision_type: d.decision_type,
        entity_type: d.entity_type,
        entity_id: d.entity_id,
        entity_name: d.entity_name,
        rationale: d.rationale,
        current_value: d.current_value ?? null,
        proposed_value: d.proposed_value ?? null,
        change_pct: d.change_pct ?? null,
        confidence: d.confidence ?? 0.7,
        priority: d.priority,
        status: 'pending',
      });
      newDecisions.push(created);
      pendingEntityIds.add(d.entity_id);
    }

    // Regras simples de segurança para casos não cobertos pelo LLM
    const ruleDecisions = [];
    for (const c of campaigns) {
      if (pendingEntityIds.has(c.campaign_id)) continue;
      if (c.state === 'archived') continue;
      // Campanha com gasto alto, zero vendas, zero cliques → pause urgente
      if ((c.spend || 0) > 30 && (c.sales || 0) === 0 && (c.clicks || 0) === 0) {
        await base44.asServiceRole.entities.Decision.create({
          amazon_account_id,
          decision_type: 'pause_campaign',
          entity_type: 'campaign',
          entity_id: c.campaign_id,
          entity_name: c.name,
          rationale: `Campanha gastou $${c.spend?.toFixed(2)} sem cliques nem vendas. Pausa urgente recomendada.`,
          current_value: c.daily_budget,
          proposed_value: 0,
          change_pct: -100,
          confidence: 0.95,
          priority: 'high',
          status: 'pending',
        });
        ruleDecisions.push(c.campaign_id);
        pendingEntityIds.add(c.campaign_id);
      }
    }

    // Keywords desperdiçando: ≥10 cliques, $3+ spend, 0 vendas → negativar
    for (const k of keywords) {
      if (pendingEntityIds.has(k.keyword_id)) continue;
      if ((k.clicks || 0) >= 10 && (k.spend || 0) > 3 && (k.sales || 0) === 0) {
        await base44.asServiceRole.entities.Decision.create({
          amazon_account_id,
          decision_type: 'negate_keyword',
          entity_type: 'keyword',
          entity_id: k.keyword_id,
          entity_name: `${k.keyword_text} (${k.match_type})`,
          rationale: `${k.clicks} cliques e $${k.spend?.toFixed(2)} gastos sem nenhuma venda. Negativação recomendada.`,
          current_value: k.bid,
          proposed_value: null,
          change_pct: null,
          confidence: 0.88,
          priority: 'high',
          status: 'pending',
        });
        ruleDecisions.push(k.keyword_id);
        pendingEntityIds.add(k.keyword_id);
      }
    }

    const totalGenerated = newDecisions.length + ruleDecisions.length;

    // Registrar evento de aprendizado
    await base44.asServiceRole.entities.LearningEvent.create({
      amazon_account_id,
      event_type: 'learner_cycle',
      entity_type: 'account',
      entity_id: amazon_account_id,
      observation: `Ciclo IA concluído. ${campaigns.length} campanhas · ${keywords.length} keywords · ${totalGenerated} decisões geradas. Resumo: ${aiResult?.analysis_summary || 'N/A'}`,
      recorded_at: new Date().toISOString(),
    });

    return Response.json({
      ok: true,
      decisions_generated: totalGenerated,
      ai_decisions: newDecisions.length,
      rule_decisions: ruleDecisions.length,
      campaigns_analyzed: campaigns.length,
      keywords_analyzed: keywords.length,
      analysis_summary: aiResult?.analysis_summary || null,
    });

  } catch (error) {
    return Response.json({ ok: false, message: error.message }, { status: 500 });
  }
});