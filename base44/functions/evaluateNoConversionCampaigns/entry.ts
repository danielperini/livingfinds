/**
 * Avalia campanhas ativas sem conversões e adiciona pausas automáticas à fila Amazon.
 * A execução efetiva ocorre no runDailyAmazonActionQueue, preservando histórico e idempotência.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function daysSince(startDate) {
  if (!startDate) return 0;
  const timestamp = new Date(startDate).getTime();
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 86400000));
}

Deno.serve(async (req) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, dry_run = false } = body;

    let accountId = amazon_account_id;
    if (!accountId) {
      const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      if (!accounts.length) return Response.json({ ok: true, message: 'Nenhuma conta Amazon conectada.', evaluated: 0, queued: 0 });
      accountId = accounts[0].id;
    }

    const rules = await base44.asServiceRole.entities.BudgetRule.filter({ amazon_account_id: accountId });
    const rule = rules[0] || {};
    const enabled = rule.auto_pause_no_conversion_enabled !== false;
    const minDays = Math.max(3, Number(rule.auto_pause_no_conversion_days || 14));
    const minClicks = Math.max(1, Number(rule.auto_pause_no_conversion_min_clicks || 20));
    const minSpend = Math.max(0, Number(rule.auto_pause_no_conversion_min_spend || 30));

    if (!enabled) {
      return Response.json({ ok: true, enabled: false, message: 'Pausa automática sem conversão desativada.', evaluated: 0, queued: 0 });
    }

    const campaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-spend', 1000);
    const activeCampaigns = campaigns.filter(c => (c.state || c.status) === 'enabled' && c.archived !== true);
    const results = [];
    let queued = 0;
    let duplicateSkipped = 0;

    for (const campaign of activeCampaigns) {
      const daysRunning = Number(campaign.days_running || daysSince(campaign.start_date));
      const clicks = Number(campaign.clicks || 0);
      const spend = Number(campaign.spend || campaign.current_spend || 0);
      const orders = Number(campaign.orders || 0);
      const sales = Number(campaign.sales || 0);
      const protectedPhase = ['new', 'learning'].includes(campaign.launch_phase);

      const eligible = !protectedPhase && daysRunning >= minDays && clicks >= minClicks && spend >= minSpend && orders === 0 && sales === 0;
      if (!eligible) continue;

      const reason = `Pausa automática: zero conversões após ${daysRunning} dias, ${clicks} cliques e R$ ${spend.toFixed(2).replace('.', ',')} de gasto.`;
      if (dry_run) {
        results.push({ campaign_id: campaign.campaign_id, status: 'candidate', reason });
        continue;
      }

      const existing = await base44.asServiceRole.entities.AgentAction.filter({
        amazon_account_id: accountId,
        action: 'pause_campaign',
        campaign_id: campaign.campaign_id,
        status: { $in: ['pending', 'approved', 'scheduled'] },
      });

      if (existing.length) {
        duplicateSkipped++;
        results.push({ campaign_id: campaign.campaign_id, status: 'duplicate_skipped', reason });
        continue;
      }

      await base44.asServiceRole.entities.AgentAction.create({
        amazon_account_id: accountId,
        action: 'pause_campaign',
        asin: campaign.asin,
        campaign_id: campaign.campaign_id,
        reason,
        evidence: `Limites configurados: ${minDays} dias, ${minClicks} cliques e R$ ${minSpend.toFixed(2).replace('.', ',')} de gasto mínimo; pedidos=0; vendas=0.`,
        risk_level: 'high',
        requires_approval: false,
        status: 'approved',
      });

      await base44.asServiceRole.entities.LearningEvent.create({
        amazon_account_id: accountId,
        event_type: 'daily_optimization',
        entity_type: 'campaign',
        entity_id: campaign.campaign_id,
        observation: `${reason} Ação aprovada automaticamente e adicionada à fila Amazon.`,
        recorded_at: new Date().toISOString(),
      }).catch(() => {});

      queued++;
      results.push({ campaign_id: campaign.campaign_id, status: 'queued', reason });
    }

    return Response.json({
      ok: true,
      enabled: true,
      dry_run,
      thresholds: { min_days: minDays, min_clicks: minClicks, min_spend_brl: minSpend },
      evaluated: activeCampaigns.length,
      queued,
      duplicate_skipped: duplicateSkipped,
      results,
      duration_ms: Date.now() - startedAt,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error.message, duration_ms: Date.now() - startedAt }, { status: 500 });
  }
});
