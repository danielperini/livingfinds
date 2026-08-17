/**
 * runDailyConsolidatedAI — Análise IA consolidada diária
 *
 * Executa UMA ÚNICA análise IA por conta por dia, reunindo:
 *  - campanhas com anomalia (ACoS > MAX, spend alto, sem conversão)
 *  - keywords de risco (wasting, high_acos)
 *  - produtos prioritários (alto gasto, prejuízo)
 *  - mudanças relevantes desde o último ciclo
 *
 * Antes de chamar IA:
 *  1. Verifica aiGatekeeper (cache + budget)
 *  2. Calcula métricas localmente via ruleEngine
 *  3. Filtra apenas casos relevantes (redução de tokens)
 *  4. Envia payload compacto à IA
 *  5. Salva no AIAnalysisCache via recordAIResult
 *
 * Retorna decisões estruturadas em JSON para serem consumidas pelo Autopilot.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  try {
    const body = await req.json().catch(() => ({}));
    let amazon_account_id = body.amazon_account_id;

    // Resolver conta
    if (!amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      if (!accs.length) return Response.json({ ok: false, error: 'Nenhuma conta conectada' });
      amazon_account_id = accs[0].id;
    }
    const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id }, null, 1);
    const account = accs[0];
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' });

    const sym = account.currency_symbol || 'R$';

    // ── 1. Verificar se já foi executada hoje ─────────────────────────
    const gateRes = await base44.asServiceRole.functions.invoke('aiGatekeeper', {
      amazon_account_id,
      analysis_type: 'daily_summary',
      entity_type: 'account',
      entity_id: amazon_account_id,
      input_data: { date: today },
      priority_type: 'strategy',
    });
    const gate = gateRes?.data || {};

    if (!gate.allowed && gate.cached) {
      return Response.json({
        ok: true,
        source: 'cache',
        result: gate.result,
        reuse_count: gate.reuse_count,
        expires_at: gate.expires_at,
      });
    }

    if (!gate.allowed) {
      return Response.json({ ok: true, skipped: true, reason: gate.reason });
    }

    // ── 2. Carregar dados do banco (sem chamar API) ───────────────────
    const cutoff14d = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);

    const [campaigns, keywords, products] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id }, '-spend', 200),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id }, '-spend', 300),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id }, null, 100),
    ]);

    const config_arr = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id }, null, 1);
    const cfg = config_arr[0] || {};
    const TARGET_ACOS = cfg.target_acos || 25;
    const MAX_ACOS    = cfg.maximum_acos || 40;
    const TARGET_ROAS = cfg.target_roas || 4;

    // ── 3. Calcular métricas locais e filtrar anomalias ───────────────
    const productMap = new Map(products.map((p: any) => [p.asin, p]));

    // Campanhas com anomalia
    const anomalous_campaigns = campaigns
      .filter((c: any) => {
        if (c.archived || c.state === 'archived') return false;
        const spend = c.spend || 0;
        const acos = c.acos || 0;
        const sales = c.sales || 0;
        if (spend < 5) return false; // sem gasto mínimo
        return acos > MAX_ACOS || (spend > 20 && sales === 0) || (acos > 0 && acos <= TARGET_ACOS && spend >= (c.daily_budget || 0) * 0.90);
      })
      .slice(0, 20)
      .map((c: any) => ({
        id: c.campaign_id, name: c.name || c.campaign_name,
        acos: c.acos, roas: c.roas, spend: c.spend, sales: c.sales,
        state: c.state, budget: c.daily_budget,
      }));

    // Keywords de risco
    const risky_keywords = keywords
      .filter((k: any) => {
        const spend = k.spend || 0;
        const acos = k.acos || 0;
        const orders = k.orders || 0;
        if (spend < 3) return false;
        return (acos > MAX_ACOS && orders >= 1) || (orders === 0 && spend >= 10);
      })
      .slice(0, 15)
      .map((k: any) => ({
        id: k.keyword_id, kw: k.keyword_text || k.keyword,
        acos: k.acos, spend: k.spend, orders: k.orders, clicks: k.clicks,
      }));

    // Produtos prioritários
    const priority_products = products
      .filter((p: any) => {
        const spend = p.total_spend_30d || 0;
        return spend > 30 || p.inventory_status === 'low_stock';
      })
      .slice(0, 10)
      .map((p: any) => ({
        asin: p.asin, name: p.product_name || p.display_name,
        inventory: p.inventory_status, spend: p.total_spend_30d,
        acos: p.acos, roas: p.roas,
      }));

    // Se não houver nada anômalo, não precisa de IA
    if (!anomalous_campaigns.length && !risky_keywords.length) {
      await base44.asServiceRole.entities.AIUsageLog.create({
        amazon_account_id, log_date: today,
        calls_avoided_rules: 1, local_calculations: 1,
      }).catch(() => {});
      return Response.json({
        ok: true, skipped: true,
        reason: 'no_anomalies_detected',
        campaigns_checked: campaigns.length,
        keywords_checked: keywords.length,
      });
    }

    // ── 4. Montar payload compacto para IA ────────────────────────────
    const ai_input = {
      date: today,
      account: { id: amazon_account_id, currency: sym },
      goals: { target_acos: TARGET_ACOS, max_acos: MAX_ACOS, target_roas: TARGET_ROAS },
      anomalous_campaigns,
      risky_keywords,
      priority_products,
    };

    // ── 5. Chamar IA via API direta OpenAI (sem créditos Base44) ──────
    const openaiKey = Deno.env.get('OPENAI_API_KEY');
    if (!openaiKey) {
      return Response.json({ ok: false, error: 'OPENAI_API_KEY não configurada.' }, { status: 500 });
    }

    const aiRaw = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 1024,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'Você é o motor de otimização de Amazon Ads do LivingFinds. Analise os dados fornecidos e retorne APENAS JSON com decisões para campanhas e keywords com anomalia. NÃO repita campanhas sem problema. NÃO inclua explicações longas. Formato: {"decisions":[{"entity_type":"campaign|keyword","entity_id":"...","action":"...","confidence":0.0,"reason":"...","risk_level":"low|medium|high","expected_impact":"...","requires_approval":true,"expires_at":"..."}],"summary":"..."}',
          },
          {
            role: 'user',
            content: JSON.stringify(ai_input),
          },
        ],
      }),
    });

    if (!aiRaw.ok) {
      const err = await aiRaw.json().catch(() => ({}));
      return Response.json({ ok: false, error: `OpenAI ${aiRaw.status}: ${err.error?.message || 'erro desconhecido'}` }, { status: 500 });
    }

    const aiData = await aiRaw.json();
    const rawText = (aiData.choices?.[0]?.message?.content || '').trim();
    let aiRes: any = null;
    try {
      aiRes = JSON.parse(rawText);
    } catch {
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) {
        try { aiRes = JSON.parse(match[0]); } catch {}
      }
    }
    if (!aiRes) {
      return Response.json({ ok: false, error: 'IA retornou JSON inválido', raw: rawText.slice(0, 300) }, { status: 500 });
    }

    const tokens_est = JSON.stringify(ai_input).length / 4;
    const cost_est   = Math.round((tokens_est * 0.000003) * 10000) / 10000;

    // ── 6. Salvar no cache e log ──────────────────────────────────────
    await base44.asServiceRole.functions.invoke('recordAIResult', {
      amazon_account_id,
      analysis_type: 'daily_summary',
      entity_type: 'account',
      entity_id: amazon_account_id,
      input_hash: gate.input_hash,
      result: aiRes,
      decision: 'consolidated_daily',
      reason: `${anomalous_campaigns.length} campanhas + ${risky_keywords.length} keywords analisadas`,
      confidence: 0.80,
      model: 'auto',
      tokens_used: Math.round(tokens_est),
      cost_estimate: cost_est,
    });

    return Response.json({
      ok: true,
      source: 'ai',
      decisions: aiRes?.decisions || [],
      summary: aiRes?.summary || '',
      campaigns_analyzed: anomalous_campaigns.length,
      keywords_analyzed: risky_keywords.length,
      tokens_estimated: Math.round(tokens_est),
      cost_estimated: cost_est,
    });

  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
});