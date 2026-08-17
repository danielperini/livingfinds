/**
 * chatAssistant — Assistente GPT-4o com contexto real do banco
 * Recebe: { messages, amazon_account_id }
 * Retorna: { message, action? }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import OpenAI from 'npm:openai';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { messages = [], amazon_account_id } = body;

    // ── 1. Resolver conta ───────────────────────────────────────────
    let account;
    if (amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id }, null, 1);
      account = accs[0];
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ user_id: user.id }, null, 1);
      account = accs[0];
      if (!account) {
        const accs2 = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, null, 1);
        account = accs2[0];
      }
    }

    if (!account) {
      return Response.json({ message: 'Nenhuma conta Amazon encontrada. Configure sua conta nas Configurações.', action: null });
    }

    const aid = account.id;
    const todayBRT = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
    const sevenDaysAgo = new Date(Date.now() - 3 * 3600000 - 7 * 86400000).toISOString().slice(0, 10);

    // ── 2. Coletar contexto em paralelo ────────────────────────────
    const [metricsRaw, alerts, spendCtrl, perfSettings, syncLogs, kwBankCount, transfers] = await Promise.all([
      base44.asServiceRole.entities.CampaignMetricsDaily.filter(
        { amazon_account_id: aid }, '-date', 100
      ).catch(() => []),
      base44.asServiceRole.entities.Alert.filter(
        { amazon_account_id: aid, status: 'active' }, '-created_date', 10
      ).catch(() => []),
      base44.asServiceRole.entities.AccountDailySpendController.filter(
        { amazon_account_id: aid, spend_date: todayBRT }, null, 1
      ).catch(() => []),
      base44.asServiceRole.entities.PerformanceSettings.filter(
        { amazon_account_id: aid }, null, 1
      ).catch(() => []),
      base44.asServiceRole.entities.SyncExecutionLog.filter(
        { amazon_account_id: aid }, '-created_date', 5
      ).catch(() => []),
      base44.asServiceRole.entities.KeywordBank.filter(
        { amazon_account_id: aid }, null, 1
      ).catch(() => []),
      base44.asServiceRole.entities.CrossAsinTransfer.filter(
        { amazon_account_id: aid }, '-created_at', 10
      ).catch(() => []),
    ]);

    // Agregar métricas dos últimos 7 dias
    const recentMetrics = metricsRaw.filter(m => m.date >= sevenDaysAgo);
    const totals = recentMetrics.reduce((acc, m) => {
      acc.spend += Number(m.spend || 0);
      acc.sales += Number(m.sales || 0);
      acc.orders += Number(m.orders || 0);
      acc.clicks += Number(m.clicks || 0);
      acc.impressions += Number(m.impressions || 0);
      return acc;
    }, { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0 });
    const acos7d = totals.sales > 0 ? (totals.spend / totals.sales * 100).toFixed(1) : null;
    const roas7d = totals.spend > 0 ? (totals.sales / totals.spend).toFixed(2) : null;

    // Top campanhas por ACoS alto (últimos 7 dias)
    const campaignAgg = {};
    for (const m of recentMetrics) {
      const cid = m.campaign_id;
      if (!cid) continue;
      if (!campaignAgg[cid]) campaignAgg[cid] = { spend: 0, sales: 0, orders: 0 };
      campaignAgg[cid].spend += Number(m.spend || 0);
      campaignAgg[cid].sales += Number(m.sales || 0);
      campaignAgg[cid].orders += Number(m.orders || 0);
    }
    const highAcosCampaigns = Object.entries(campaignAgg)
      .filter(([, v]) => v.sales > 0 && (v.spend / v.sales) > 0.2)
      .map(([cid, v]) => ({ campaign_id: cid, acos: (v.spend / v.sales * 100).toFixed(1), spend: v.spend.toFixed(2) }))
      .sort((a, b) => parseFloat(b.acos) - parseFloat(a.acos))
      .slice(0, 5);

    // Hoje
    const todayMetrics = metricsRaw.filter(m => m.date === todayBRT);
    const todayTotals = todayMetrics.reduce((acc, m) => {
      acc.spend += Number(m.spend || 0);
      acc.sales += Number(m.sales || 0);
      acc.orders += Number(m.orders || 0);
      return acc;
    }, { spend: 0, sales: 0, orders: 0 });

    const ps = perfSettings[0] || {};
    const ctrl = spendCtrl[0] || {};

    // Contagem de keywords
    const kwTotal = kwBankCount.length > 0 ? '(contagem parcial, ver banco completo)' : '0';

    // ── 3. Montar contexto JSON compacto ──────────────────────────
    const context = {
      data_hora_brt: new Date(Date.now() - 3 * 3600000).toISOString().replace('T', ' ').slice(0, 16),
      conta: {
        nome: account.seller_name || account.id,
        marketplace: account.marketplace_id,
        status: account.status,
        ads_token_status: account.ads_token_status,
        moeda: account.currency_symbol || 'R$',
      },
      metas: {
        target_acos: ps.target_acos,
        max_acos: ps.max_acos,
        target_roas: ps.target_roas,
        daily_budget_limit: ps.daily_budget_limit,
        objective: ps.objective,
      },
      hoje: {
        data: todayBRT,
        gasto: todayTotals.spend.toFixed(2),
        vendas: todayTotals.sales.toFixed(2),
        pedidos: todayTotals.orders,
        cap_diario: ctrl.user_daily_spend_cap || ps.daily_budget_limit,
        gasto_confirmado: ctrl.confirmed_spend || 0,
        cap_status: ctrl.cap_status || 'unknown',
      },
      ultimos_7_dias: {
        gasto_total: totals.spend.toFixed(2),
        vendas_total: totals.sales.toFixed(2),
        pedidos: totals.orders,
        cliques: totals.clicks,
        impressoes: totals.impressions,
        acos: acos7d,
        roas: roas7d,
      },
      campanhas_alto_acos_7d: highAcosCampaigns,
      alertas_ativos: alerts.map(a => ({ tipo: a.alert_type, severidade: a.severity, titulo: a.title, mensagem: a.message })).slice(0, 10),
      sync_recente: syncLogs.map(l => ({ operacao: l.operation, status: l.status, resumo: l.result_summary?.slice(0, 100) })),
      keywords_banco: `${kwBankCount.length >= 1 ? 'ao menos 1 encontrada' : '0'} ${kwTotal}`,
      cross_asin_transfers: transfers.slice(0, 5).map(t => ({ keyword: t.keyword, source: t.source_asin, dest: t.destination_asin, status: t.status, score: t.conversion_score })),
    };

    // ── 4. Construir messages para OpenAI ─────────────────────────
    const systemPrompt = `Você é o assistente de gestão Amazon da plataforma Living Finds. Responde sempre em Português do Brasil.
Você tem acesso aos dados reais da conta do usuário listados abaixo e deve usá-los para responder perguntas e sugerir ações.

CONTEXTO ATUAL (dados reais do banco):
${JSON.stringify(context, null, 2)}

INSTRUÇÕES:
1. Responda de forma clara, direta e objetiva em PT-BR.
2. Use os dados do contexto para responder perguntas sobre métricas, campanhas, keywords, alertas e status.
3. Quando sugerir uma ação executável (ex: ajustar meta de ACoS, renovar token, rodar o motor de bids, otimizar bids conservador), inclua o campo "action" no JSON de resposta.
4. Ações disponíveis e seus function_name:
   - Rodar motor de bids conservador: "runConservativeBidOptimizer"
   - Renovar token Amazon Ads: "refreshAmazonAdsTokenDailyOrHourly"
   - Rodar orquestrador diário: "runSmartDailyOrchestrator"
   - Rodar motor de decisão unificado: "runUnifiedDecisionEngine"
   - Verificar e criar alertas: "checkAndCreateAlerts"
   - Rodar coleta de search terms: "harvestConvertedSearchTerms"
   - Sincronizar campanhas: "syncAdsCampaignStatesV2"
5. Formato de resposta OBRIGATÓRIO (JSON válido):
{
  "message": "texto da resposta em PT-BR",
  "action": {
    "label": "descrição curta da ação",
    "function_name": "nomeDaFuncaoBackend",
    "payload": {},
    "schedule_label": "ex: Otimizar bids agora"
  }
}
Se não houver ação sugerida, omita o campo "action" ou retorne null.
SEMPRE retorne JSON válido no formato acima.`;

    const openaiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role, content: m.content })),
    ];

    // ── 5. Chamar GPT-4o ──────────────────────────────────────────
    const openai = new OpenAI({ apiKey: Deno.env.get('OPENAI_API_KEY') });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: openaiMessages,
      response_format: { type: 'json_object' },
      max_tokens: 800,
      temperature: 0.3,
    });

    const raw = completion.choices[0]?.message?.content || '{}';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { message: raw, action: null };
    }

    return Response.json({
      message: parsed.message || 'Não consegui processar sua pergunta. Tente novamente.',
      action: parsed.action || null,
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});