import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

/**
 * updateDailySpendCap
 * Persiste o novo teto diário e recalcula cap_status/remaining_spend
 * na mesma execução, garantindo consistência imediata.
 *
 * Payload: { amazon_account_id: string, new_cap: number }
 * Retorna: { ok, new_cap, confirmed_spend, projected_total_spend, remaining_spend, cap_status }
 */
export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, new_cap } = body as any;

    if (!amazon_account_id) return Response.json({ error: 'amazon_account_id obrigatório' }, { status: 400 });

    const cap = Number(new_cap);
    if (isNaN(cap) || cap < 10 || cap > 5000) {
      return Response.json({ error: 'new_cap deve ser entre R$10 e R$5000' }, { status: 400 });
    }

    const now = new Date().toISOString();
    // Data de hoje em BRT (UTC-3)
    const todayBRT = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);

    // ── 1. Atualizar PerformanceSettings ────────────────────────────────
    const psList = await base44.asServiceRole.entities.PerformanceSettings.filter(
      { amazon_account_id }, '-updated_at', 1
    ).catch(() => []);
    if (psList[0]) {
      await base44.asServiceRole.entities.PerformanceSettings.update(psList[0].id, {
        daily_budget_limit: cap,
        updated_at: now,
      });
    }

    // ── 2. Atualizar AutopilotConfig ─────────────────────────────────────
    const acList = await base44.asServiceRole.entities.AutopilotConfig.filter(
      { amazon_account_id }, '-updated_at', 1
    ).catch(() => []);
    if (acList[0]) {
      await base44.asServiceRole.entities.AutopilotConfig.update(acList[0].id, {
        daily_budget_limit: cap,
      });
    }

    // ── 3. Ler CampaignMetricsDaily de hoje para confirmed_spend ─────────
    const metrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id, date: todayBRT }, null, 200
    ).catch(() => []);

    const confirmed_spend = metrics.reduce((sum: number, m: any) => sum + (Number(m.spend) || 0), 0);

    // Lê controller atual para preservar estimated_pending_spend
    const ctrlList = await base44.asServiceRole.entities.AccountDailySpendController.filter(
      { amazon_account_id, spend_date: todayBRT }, null, 1
    ).catch(() => []);
    const existing = ctrlList[0] || null;

    const estimated_pending = Number(existing?.estimated_pending_spend) || 0;
    const projected_total_spend = confirmed_spend + estimated_pending;
    const remaining_spend = Math.max(0, cap - projected_total_spend);

    // Calcular cap_status com o novo teto
    const pct = cap > 0 ? projected_total_spend / cap : 0;
    let cap_status = 'safe';
    if (pct >= 1.0)       cap_status = 'cap_reached';
    else if (pct >= 0.95) cap_status = 'cap_imminent';
    else if (pct >= 0.85) cap_status = 'critical';
    else if (pct >= 0.70) cap_status = 'attention';

    // ── 4. Upsert AccountDailySpendController ────────────────────────────
    const patch = {
      amazon_account_id,
      spend_date: todayBRT,
      user_daily_spend_cap: cap,
      effective_daily_spend_cap: cap,
      confirmed_spend,
      projected_total_spend,
      remaining_spend,
      cap_status,
      cap_updated_at: now,
      updated_by: user.id,
      updated_at: now,
    };

    if (existing) {
      await base44.asServiceRole.entities.AccountDailySpendController.update(existing.id, patch);
    } else {
      await base44.asServiceRole.entities.AccountDailySpendController.create({
        ...patch,
        created_at: now,
      });
    }

    return Response.json({
      ok: true,
      new_cap: cap,
      confirmed_spend,
      estimated_pending_spend: estimated_pending,
      projected_total_spend,
      remaining_spend,
      cap_status,
    });

  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}