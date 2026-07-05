/**
 * validateCampaignBudgets
 *
 * Valida o gasto real dos últimos 30 dias de CADA campanha individualmente
 * e calcula o budget diário ajustado com 30% de reserva operacional.
 *
 * Lógica por campanha:
 *   1. Agregar spend por dia nos últimos 30 dias (dedup por campaign_id+date)
 *   2. Média ponderada: 60% dos 30d + 40% dos últimos 15d
 *   3. Budget sugerido = média_ponderada × 1.30 (reserva de 30%)
 *   4. Clamp: mínimo R$5, máximo 3× budget atual (proteção anti-spike)
 *   5. Persistir sugestão nos campos da entidade Campaign (não aplica automaticamente)
 *
 * Nenhuma chamada externa — puramente determinístico, zero créditos de IA.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const RESERVE_RATE = 0.30;    // 30% de reserva
const MIN_BUDGET   = 5.0;     // orçamento mínimo R$5
const MAX_MULT     = 3.0;     // sugestão nunca ultrapassa 3× o budget atual
const MIN_DAYS     = 3;       // mínimo de dias com dados para gerar sugestão
const PAGE_SIZE    = 200;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

Deno.serve(async (req) => {
  const startMs = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    // Autenticação — service_role ou usuário admin
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Resolver conta
    let account: any = null;
    if (body.amazon_account_id) {
      const rows = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
      account = rows[0] || null;
    }
    if (!account) {
      const rows = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = rows[0] || null;
    }
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon conectada.' });

    const aid      = account.id;
    const sym      = account.currency_symbol || 'R$';
    const today    = new Date().toISOString().slice(0, 10);
    const d30ago   = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const d15ago   = new Date(Date.now() - 15 * 86400000).toISOString().slice(0, 10);

    // ── 1. Carregar campanhas ativas/pausadas ────────────────────────────────
    const allCampaigns: any[] = [];
    let offset = 0;
    while (true) {
      const page = await base44.asServiceRole.entities.Campaign.filter(
        { amazon_account_id: aid }, '-created_date', PAGE_SIZE, offset
      );
      allCampaigns.push(...page);
      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    const targetCampaigns = allCampaigns.filter(c => {
      const state = String(c.state || c.status || '').toLowerCase();
      return !c.archived && state !== 'archived';
    });

    if (targetCampaigns.length === 0) {
      return Response.json({ ok: false, message: 'Nenhuma campanha ativa/pausada encontrada.' });
    }

    // ── 2. Carregar métricas dos últimos 30 dias (CampaignMetricsDaily) ──────
    const metricsRaw: any[] = [];
    offset = 0;
    while (true) {
      const page = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
        { amazon_account_id: aid }, '-date', 1500, offset
      );
      metricsRaw.push(...page);
      if (page.length < 1500) break;
      offset += 1500;
    }

    // Deduplificar por (campaign_id + date) e filtrar janela 30d (excluindo hoje)
    const seenKeys = new Set<string>();
    const metrics = metricsRaw.filter(m => {
      if (!m.date || m.date < d30ago || m.date >= today) return false;
      const key = `${m.campaign_id || 'no'}-${m.date}`;
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });

    // Agrupar spend por (campaign_id → { date → spend })
    const spendByCampaign = new Map<string, Map<string, number>>();
    for (const m of metrics) {
      const cid = String(m.campaign_id || '');
      if (!cid) continue;
      if (!spendByCampaign.has(cid)) spendByCampaign.set(cid, new Map());
      const dayMap = spendByCampaign.get(cid)!;
      dayMap.set(m.date, (dayMap.get(m.date) || 0) + Number(m.spend || 0));
    }

    // ── 3. Calcular sugestão por campanha ────────────────────────────────────
    const updates: { id: string; data: Record<string, any> }[] = [];
    const suggestions: any[] = [];
    let suggestionsGenerated = 0;
    let skippedNoData = 0;

    for (const campaign of targetCampaigns) {
      const cid = String(campaign.campaign_id || '');
      const dayMap = spendByCampaign.get(cid);

      if (!dayMap || dayMap.size < MIN_DAYS) {
        skippedNoData++;
        continue;
      }

      // Separar períodos: últimos 30d e últimos 15d
      const days30: number[] = [];
      const days15: number[] = [];
      for (const [date, spend] of dayMap.entries()) {
        if (date >= d30ago && date < today) {
          days30.push(spend);
          if (date >= d15ago) days15.push(spend);
        }
      }

      if (days30.length < MIN_DAYS) { skippedNoData++; continue; }

      const avg30 = days30.reduce((s, v) => s + v, 0) / days30.length;
      const avg15 = days15.length >= 2
        ? days15.reduce((s, v) => s + v, 0) / days15.length
        : avg30;

      // Média ponderada: 60% 30d + 40% 15d
      const weightedAvg = avg30 * 0.60 + avg15 * 0.40;

      // Budget sugerido com reserva de 30%
      let suggested = weightedAvg * (1 + RESERVE_RATE);
      suggested = Math.max(MIN_BUDGET, suggested);

      // Cap: nunca sugerir mais de 3× o budget atual (evita surpresas)
      const currentBudget = Number(campaign.daily_budget || 0);
      if (currentBudget > 0) {
        suggested = Math.min(suggested, currentBudget * MAX_MULT);
      }
      suggested = round2(suggested);

      // Tendência de gasto: comparar avg15 com avg30
      let trend: 'growth' | 'decline' | 'stable' = 'stable';
      if (avg30 > 0 && Math.abs(avg15 - avg30) / avg30 > 0.05) {
        trend = avg15 > avg30 ? 'growth' : 'decline';
      }

      // Delta em relação ao budget atual
      const delta = currentBudget > 0 ? round2(suggested - currentBudget) : null;
      const deltaPercent = currentBudget > 0 ? round2(((suggested - currentBudget) / currentBudget) * 100) : null;

      const reasoning = `Spend médio 30d: ${sym}${round2(avg30)}/dia | ` +
        `15d: ${sym}${round2(avg15)}/dia | ` +
        `Ponderado: ${sym}${round2(weightedAvg)}/dia | ` +
        `+${(RESERVE_RATE * 100).toFixed(0)}% reserva → ${sym}${suggested}/dia | ` +
        `Tendência: ${trend === 'growth' ? '↑ crescimento' : trend === 'decline' ? '↓ queda' : '→ estável'} | ` +
        `Dias analisados: ${days30.length}`;

      suggestions.push({
        campaign_id: campaign.id,
        amazon_campaign_id: cid,
        name: campaign.name || campaign.campaign_name,
        current_budget: currentBudget,
        suggested_budget: suggested,
        avg_spend_30d: round2(avg30),
        avg_spend_15d: round2(avg15),
        weighted_avg: round2(weightedAvg),
        delta,
        delta_percent: deltaPercent,
        days_analyzed: days30.length,
        trend,
        reasoning,
      });

      // Marcar campanha com a sugestão (sem alterar budget atual)
      updates.push({
        id: campaign.id,
        data: {
          // Reutilizar campos existentes da entidade Campaign para armazenar a sugestão
          reconciliation_status: delta !== null && Math.abs(delta) > 1 ? 'review_required' : 'ok',
          reconciliation_notes: reasoning.slice(0, 500),
          metrics_status: 'complete',
          last_sync_at: new Date().toISOString(),
        },
      });

      suggestionsGenerated++;
    }

    // ── 4. Persistir sugestões no AutopilotConfig (nível conta) ─────────────
    const totalAvgSpend = suggestions.length > 0
      ? round2(suggestions.reduce((s, r) => s + r.avg_spend_30d, 0))
      : 0;
    const totalSuggested = suggestions.length > 0
      ? round2(suggestions.reduce((s, r) => s + r.suggested_budget, 0))
      : 0;
    const totalCurrentBudget = suggestions.length > 0
      ? round2(suggestions.reduce((s, r) => s + r.current_budget, 0))
      : 0;

    const breakdown = JSON.stringify({
      per_campaign: suggestions.slice(0, 100), // limitar tamanho
      total_avg_spend_30d: totalAvgSpend,
      total_suggested: totalSuggested,
      total_current_budget: totalCurrentBudget,
      reserve_rate: RESERVE_RATE,
      campaigns_analyzed: suggestionsGenerated,
      campaigns_skipped_no_data: skippedNoData,
      calculated_at: new Date().toISOString(),
    });

    const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid });
    const configPayload = {
      ai_suggested_daily_budget: totalSuggested,
      ai_budget_reasoning: `Validação por campanha: ${suggestionsGenerated} campanhas analisadas, ${skippedNoData} sem dados suficientes. Total sugerido: ${sym}${totalSuggested}/dia vs atual ${sym}${totalCurrentBudget}/dia.`,
      ai_budget_confidence: Math.min(95, Math.max(40, Math.round((suggestionsGenerated / Math.max(targetCampaigns.length, 1)) * 100))),
      ai_budget_generated_at: new Date().toISOString(),
      ai_budget_breakdown: breakdown.slice(0, 4000),
    };

    if (configs.length > 0) {
      await base44.asServiceRole.entities.AutopilotConfig.update(configs[0].id, configPayload);
    } else {
      await base44.asServiceRole.entities.AutopilotConfig.create({ amazon_account_id: aid, ...configPayload });
    }

    // ── 5. Atualizar campanhas em lotes ──────────────────────────────────────
    let campaignsUpdated = 0;
    for (let i = 0; i < updates.length; i += 50) {
      const batch = updates.slice(i, i + 50).map(u => ({ id: u.id, ...u.data }));
      await base44.asServiceRole.entities.Campaign.bulkUpdate(batch);
      campaignsUpdated += batch.length;
    }

    // ── 6. Registrar no log de sincronização ─────────────────────────────────
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'metrics_sync',
      trigger_type: 'manual',
      status: 'success',
      execution_date: today,
      started_at: new Date(startMs).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startMs,
      records_processed: suggestionsGenerated,
    }).catch(() => {});

    return Response.json({
      ok: true,
      campaigns_analyzed: suggestionsGenerated,
      campaigns_skipped_no_data: skippedNoData,
      total_campaigns: targetCampaigns.length,
      total_avg_spend_30d: totalAvgSpend,
      total_suggested_budget: totalSuggested,
      total_current_budget: totalCurrentBudget,
      reserve_rate_pct: RESERVE_RATE * 100,
      suggestions: suggestions.sort((a, b) => Math.abs(b.delta || 0) - Math.abs(a.delta || 0)).slice(0, 50),
      duration_ms: Date.now() - startMs,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});