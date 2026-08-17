/**
 * runKillSwitchRecoveryWithAI
 * Acionado pelo runSmartDailyOrchestrator quando global_kill_switch=true.
 * 1. Lê o estado do kill switch do dia atual
 * 2. Consulta HourlySalesPattern para padrão de pico/fraco
 * 3. Chama GPT-4o para recomendar redistribuição de lances
 * 4. Cria OptimizationDecision para cada ajuste
 * 5. Reativa campanhas pausadas via Amazon Ads API
 * 6. Reseta global_kill_switch=false
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import OpenAI from 'npm:openai';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id } = body;

    // ── 1. Resolver conta ────────────────────────────────────────
    let account;
    if (amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id }, null, 1);
      account = accs[0];
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ user_id: user.id }, null, 1);
      account = accs[0];
    }
    if (!account) return Response.json({ error: 'Conta Amazon não encontrada.' }, { status: 404 });

    const aid = account.id;
    const profileId = account.ads_profile_id;
    const todayBRT = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);

    // ── 2. Ler o controlador do dia ──────────────────────────────
    const ctrlList = await base44.asServiceRole.entities.AccountDailySpendController.filter(
      { amazon_account_id: aid, spend_date: todayBRT }, null, 1
    );
    const ctrl = ctrlList[0];

    if (!ctrl) {
      return Response.json({ ok: false, message: 'Nenhum controlador encontrado para hoje.' });
    }
    if (!ctrl.global_kill_switch) {
      return Response.json({ ok: false, message: 'Kill switch não está ativo. Nada a fazer.' });
    }

    const cap = ctrl.effective_daily_spend_cap || ctrl.user_daily_spend_cap || 70;
    const confirmed = ctrl.confirmed_spend || 0;
    const pausedAt = ctrl.kill_switch_activated_at ? new Date(ctrl.kill_switch_activated_at) : null;
    const pausedHourBRT = pausedAt
      ? (pausedAt.getUTCHours() - 3 + 24) % 24
      : new Date(Date.now() - 3 * 3600000).getUTCHours();
    const horasRestantes = Math.max(0, 23 - pausedHourBRT);

    // ── 3. Ler HourlySalesPattern ────────────────────────────────
    const hourlyPatterns = await base44.asServiceRole.entities.HourlySalesPattern.filter(
      { amazon_account_id: aid }, null, 168 // 7 dias × 24 horas
    ).catch(() => []);

    // Agrupar por hora (média entre dias da semana)
    const hourlyMap = {};
    for (const p of hourlyPatterns) {
      const h = p.hour;
      if (!hourlyMap[h]) hourlyMap[h] = [];
      hourlyMap[h].push(p);
    }
    const hourlyAvg = Object.entries(hourlyMap).map(([h, rows]) => {
      const avg = (field) => rows.reduce((s, r) => s + (Number(r[field]) || 0), 0) / rows.length;
      return {
        hour: Number(h),
        classification: rows[0]?.classification || 'INSUFFICIENT_DATA',
        peak_score: avg('peak_score'),
        orders_share_pct: avg('orders_share_pct'),
        acos: avg('acos'),
        cvr: avg('cvr'),
        bid_multiplier: avg('bid_multiplier'),
      };
    }).sort((a, b) => a.hour - b.hour);

    const peakSlots = hourlyAvg.filter(h => ['PEAK_ELITE', 'PEAK_STRONG'].includes(h.classification));
    const weakSlots = hourlyAvg.filter(h => ['WEAK', 'LOSS'].includes(h.classification));

    // ── 4. Ler métricas das campanhas de hoje ────────────────────
    const todayMetrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: aid, date: todayBRT }, null, 100
    ).catch(() => []);

    const campaignSpend = {};
    for (const m of todayMetrics) {
      if (!m.campaign_id) continue;
      if (!campaignSpend[m.campaign_id]) {
        campaignSpend[m.campaign_id] = { spend: 0, sales: 0, orders: 0, clicks: 0 };
      }
      campaignSpend[m.campaign_id].spend += Number(m.spend || 0);
      campaignSpend[m.campaign_id].sales += Number(m.sales || 0);
      campaignSpend[m.campaign_id].orders += Number(m.orders || 0);
      campaignSpend[m.campaign_id].clicks += Number(m.clicks || 0);
    }

    const topCampaigns = Object.entries(campaignSpend)
      .map(([cid, d]) => ({
        campaign_id: cid,
        spend: Number(d.spend.toFixed(2)),
        sales: Number(d.sales.toFixed(2)),
        orders: d.orders,
        acos: d.sales > 0 ? Number((d.spend / d.sales * 100).toFixed(1)) : null,
      }))
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 10);

    // ── 5. Montar prompt para GPT-4o ─────────────────────────────
    const context = {
      teto_diario_brl: cap,
      gasto_confirmado_brl: Number(confirmed.toFixed(2)),
      hora_pausa_brt: pausedHourBRT,
      horas_restantes: horasRestantes,
      campanhas_pausadas: ctrl.campaigns_paused_today || [],
      slots_pico: peakSlots.map(h => ({ hora: h.hour, score: h.peak_score.toFixed(1), acos: h.acos?.toFixed(1), cvr: h.cvr?.toFixed(2) })),
      slots_fracos: weakSlots.map(h => ({ hora: h.hour, score: h.peak_score.toFixed(1), acos: h.acos?.toFixed(1) })),
      top_10_campanhas_hoje: topCampaigns,
    };

    const prompt = `Você é especialista em gestão de Amazon Ads. O orçamento diário da conta foi esgotado e as campanhas foram pausadas às ${pausedHourBRT}h BRT.

CONTEXTO:
${JSON.stringify(context, null, 2)}

OBJETIVO:
Com ${horasRestantes}h restantes no dia, as campanhas serão reativadas. Você deve redistribuir os lances para que o teto de R$${cap} seja utilizado de forma eficiente ao longo do dia todo, priorizando horários de pico.

RETORNE UM JSON VÁLIDO com este formato EXATO:
{
  "ajustes": [
    {
      "campaign_id": "ID_DA_CAMPANHA",
      "acao": "REDUZIR_LANCE" | "AUMENTAR_LANCE" | "MANTER",
      "percentual_ajuste": 15,
      "motivo": "Texto em PT-BR explicando o porquê",
      "risco": "low" | "medium",
      "prioridade": 1
    }
  ],
  "previsao_duracao_horas": 8.5,
  "resumo": "Texto em PT-BR com resumo da estratégia",
  "campanhas_reativar": ["campaign_id_1", "campaign_id_2"]
}

Regras:
- Reduza lances de campanhas com ACoS > 30% que gastaram em horários fracos
- Mantenha ou aumente lances de campanhas com ACoS < 15% e pedidos hoje
- Campanhas sem pedidos hoje com gasto alto: REDUZIR_LANCE em 20%
- Máximo de 15% de ajuste para AUMENTAR, máximo de 25% para REDUZIR
- Inclua em "campanhas_reativar" TODAS as campanhas pausadas hoje (da lista campanhas_pausadas)
- Máximo 10 ajustes`;

    const openai = new OpenAI({ apiKey: Deno.env.get('OPENAI_API_KEY') });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 1500,
      temperature: 0.2,
    });

    let aiResult;
    try {
      aiResult = JSON.parse(completion.choices[0]?.message?.content || '{}');
    } catch {
      aiResult = { ajustes: [], previsao_duracao_horas: horasRestantes, resumo: 'Falha ao parsear resposta da IA', campanhas_reativar: ctrl.campaigns_paused_today || [] };
    }

    const ajustes = Array.isArray(aiResult.ajustes) ? aiResult.ajustes : [];
    const now = new Date().toISOString();

    // ── 6. Criar OptimizationDecision para cada ajuste ──────────
    const decisions = [];
    for (const adj of ajustes) {
      if (!adj.campaign_id || adj.acao === 'MANTER') continue;
      const ikey = `ks_recovery:${aid}:${adj.campaign_id}:${todayBRT}`;
      // Evitar duplicatas
      const existing = await base44.asServiceRole.entities.OptimizationDecision.filter(
        { amazon_account_id: aid, idempotency_key: ikey }, null, 1
      ).catch(() => []);
      if (existing[0]) continue;

      const direction = adj.acao === 'AUMENTAR_LANCE' ? 1 : -1;
      const pct = Math.min(25, Math.abs(Number(adj.percentual_ajuste) || 15));

      decisions.push(await base44.asServiceRole.entities.OptimizationDecision.create({
        amazon_account_id: aid,
        decision_type: 'bid_adjustment',
        entity_type: 'campaign',
        campaign_id: adj.campaign_id,
        entity_id: adj.campaign_id,
        action: adj.acao,
        rationale: `[Kill Switch Recovery IA] ${adj.motivo || ''}. Pausa às ${pausedHourBRT}h BRT, ${horasRestantes}h restantes. Previsão: ${aiResult.previsao_duracao_horas}h de cobertura.`,
        expected_impact_pct: direction * pct,
        risk: adj.risco || 'medium',
        requires_approval: (adj.risco || 'medium') !== 'low',
        status: (adj.risco || 'medium') === 'low' ? 'approved' : 'proposed',
        source_function: 'runKillSwitchRecoveryWithAI',
        idempotency_key: ikey,
        evaluated_at: now,
        created_at: now,
        run_id: `ks_recovery_${todayBRT}`,
        amazon_account_id: aid,
      }).catch(() => null));
    }

    // ── 7. Reativar campanhas pausadas via Amazon Ads API ────────
    const campanhasParaReativar = Array.isArray(aiResult.campanhas_reativar) && aiResult.campanhas_reativar.length > 0
      ? aiResult.campanhas_reativar
      : (ctrl.campaigns_paused_today || []);

    let reactivatedCount = 0;
    const reactivationErrors = [];

    if (profileId && campanhasParaReativar.length > 0) {
      // Reativar em lotes de 10
      const batches = [];
      for (let i = 0; i < campanhasParaReativar.length; i += 10) {
        batches.push(campanhasParaReativar.slice(i, i + 10));
      }

      for (const batch of batches) {
        try {
          const payload = batch.map(cid => ({ campaignId: cid, state: 'ENABLED' }));
          const res = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
            amazon_account_id: aid,
            profile_id: profileId,
            action: 'updateCampaigns',
            payload,
          }).catch(() => null);

          if (res?.ok !== false) {
            reactivatedCount += batch.length;
            // Atualizar estado local
            for (const cid of batch) {
              await base44.asServiceRole.entities.Campaign.updateMany(
                { amazon_account_id: aid, campaign_id: cid },
                { $set: { status: 'enabled', state: 'enabled', last_sync_at: now } }
              ).catch(() => null);
            }
          }
        } catch (e) {
          reactivationErrors.push(e.message);
        }
      }
    }

    // ── 8. Resetar kill switch no controlador ────────────────────
    const recoveryNote = `IA redistribuiu lances às ${new Date(now).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} BRT. ${reactivatedCount} campanhas reativadas. ${aiResult.resumo || ''}`;

    await base44.asServiceRole.entities.AccountDailySpendController.update(ctrl.id, {
      global_kill_switch: false,
      cap_status: 'safe',
      campaigns_paused_count: 0,
      last_action_at: now,
      updated_at: now,
      kill_switch_reason: recoveryNote,
      // Guardar nota de recuperação no snapshot
      global_stop_snapshot: JSON.stringify({
        ...JSON.parse(ctrl.global_stop_snapshot || '{}'),
        recovery_at: now,
        recovery_summary: aiResult.resumo,
        reactivated_count: reactivatedCount,
        decisions_created: decisions.filter(Boolean).length,
      }),
    }).catch(() => null);

    // ── 9. Log de execução ───────────────────────────────────────
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'runKillSwitchRecoveryWithAI',
      trigger_type: 'automatic',
      status: 'success',
      execution_date: todayBRT,
      started_at: now,
      completed_at: new Date().toISOString(),
      records_processed: reactivatedCount + decisions.filter(Boolean).length,
      result_summary: `Kill switch resetado. ${reactivatedCount} campanhas reativadas. ${decisions.filter(Boolean).length} decisões criadas. ${aiResult.resumo?.slice(0, 100) || ''}`,
    }).catch(() => null);

    return Response.json({
      ok: true,
      decisions_created: decisions.filter(Boolean).length,
      campaigns_reactivated: reactivatedCount,
      reactivation_errors: reactivationErrors,
      ai_summary: aiResult.resumo,
      ai_forecast_hours: aiResult.previsao_duracao_horas,
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});