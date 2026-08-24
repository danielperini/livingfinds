import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const n = (v: unknown) => Number.isFinite(Number(v)) ? Number(v) : 0;
const active = (v: unknown) => ['enabled', 'active'].includes(String(v || '').toLowerCase());
const cid = (c: any) => String(c.amazon_campaign_id || c.campaign_id || c.id || '');

function brDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, undefined, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 50);

    const maxPauses = Math.max(0, Math.min(100, Number(body.max_campaign_pauses ?? 100)));
    const lookbackDays = Math.max(3, Math.min(30, Number(body.lookback_days ?? 7)));
    const minAgeDays = Math.max(3, Math.min(30, Number(body.min_age_days ?? 7)));
    const dryRun = body.dry_run === true;
    const today = brDate();
    const cutoff = new Date(Date.now() - lookbackDays * 86400000).toISOString().slice(0, 10);
    const results: any[] = [];

    for (const account of accounts) {
      const aid = String(account.id);
      const [campaigns, metrics, settingsRows, existingDecisions] = await Promise.all([
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, '-created_at', 10000).catch(() => []),
        base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 30000).catch(() => []),
        base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, '-updated_at', 1).catch(() => []),
        base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: aid }, '-created_at', 30000).catch(() => []),
      ]);
      const settings = settingsRows[0] || {};
      const targetAcos = n(settings.target_acos || settings.acos_target || 15);
      const maxAcos = n(settings.maximum_acos || Math.max(35, targetAcos * 2));
      const minSpend = n(settings.min_spend_for_decision || 5);

      const agg = new Map<string, any>();
      for (const m of metrics) {
        if (String(m.date || '') < cutoff) continue;
        const id = String(m.campaign_id || '');
        if (!id) continue;
        const a = agg.get(id) || { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0, days: new Set<string>() };
        a.spend += n(m.spend); a.sales += n(m.sales); a.orders += n(m.orders);
        a.clicks += n(m.clicks); a.impressions += n(m.impressions); a.days.add(String(m.date || ''));
        agg.set(id, a);
      }

      const candidates: any[] = [];
      for (const campaign of campaigns) {
        if (!active(campaign.state || campaign.status)) continue;
        if (campaign.protected_high_performance === true) continue;
        const id = cid(campaign);
        if (!id) continue;
        const created = new Date(String(campaign.created_at || campaign.created_date || '')).getTime();
        const ageDays = Number.isFinite(created) ? (Date.now() - created) / 86400000 : 999;
        if (ageDays < minAgeDays) continue;
        const a = agg.get(id);
        if (!a || a.spend < minSpend) continue;
        const acos = a.sales > 0 ? a.spend / a.sales * 100 : 999;
        const zeroSale = a.orders === 0 && a.sales <= 0;
        const wasteSpend = zeroSale && a.spend >= Math.max(minSpend * 2, 8);
        const destructiveAcos = a.orders > 0 && acos >= maxAcos && a.spend >= Math.max(minSpend * 2, 8);
        if (!wasteSpend && !destructiveAcos) continue;

        const score = zeroSale
          ? 1000 + a.spend + Math.min(a.clicks, 100) * 0.5
          : 500 + Math.max(0, acos - targetAcos) * 3 + a.spend * 0.25;
        candidates.push({ campaign, id, ageDays, ...a, acos, zeroSale, score });
      }

      candidates.sort((a, b) => b.score - a.score);
      const alreadyToday = existingDecisions.filter((d: any) =>
        d.source_function === 'runSalesModeWasteRotation' &&
        String(d.created_at || '').slice(0, 10) === today &&
        !['failed', 'rejected', 'cancelled', 'expired'].includes(String(d.status || '').toLowerCase())
      ).length;
      const quota = Math.max(0, maxPauses - alreadyToday);
      const selected = candidates.slice(0, quota);
      const created: any[] = [];

      for (const c of selected) {
        const key = `SALES_MODE_WASTE_PAUSE|${aid}|${c.id}|${today}`;
        if (existingDecisions.some((d: any) => d.idempotency_key === key && !['failed', 'rejected', 'cancelled', 'expired'].includes(String(d.status || '').toLowerCase()))) continue;
        const rationale = c.zeroSale
          ? `${lookbackDays}d: zero vendas, gasto R$${c.spend.toFixed(2)}, ${c.clicks} cliques. Capital será redirecionado a vencedores.`
          : `${lookbackDays}d: ACoS ${c.acos.toFixed(1)}% acima do teto ${maxAcos.toFixed(1)}%, com gasto R$${c.spend.toFixed(2)}.`;
        if (dryRun) {
          created.push({ campaign_id: c.id, campaign_name: c.campaign.name || c.campaign.campaign_name, rationale, dry_run: true });
          continue;
        }
        const decision = await base44.asServiceRole.entities.OptimizationDecision.create({
          amazon_account_id: aid,
          decision_type: 'sales_mode_waste_rotation',
          entity_type: 'campaign',
          entity_id: c.id,
          campaign_id: c.id,
          campaign_name: c.campaign.name || c.campaign.campaign_name || null,
          asin: c.campaign.asin || c.campaign.advertised_asin || null,
          action: 'pause_campaign',
          canonical_action_type: 'CAMPAIGN_STATE_CHANGE',
          rationale,
          rule_key: c.zeroSale ? 'SALES_MODE_ZERO_SALE_WASTE' : 'SALES_MODE_DESTRUCTIVE_ACOS',
          reason_code: c.zeroSale ? 'SALES_MODE_ZERO_SALE_WASTE' : 'SALES_MODE_DESTRUCTIVE_ACOS',
          value_before: 'ENABLED', value_after: 'PAUSED',
          confidence: c.zeroSale ? 0.94 : 0.90,
          risk: 'medium', requires_approval: false,
          approval_status: 'auto_approved_deterministic', status: 'approved', queue_status: 'pending',
          priority_class: 'P1', execution_mode: 'EXPEDITED_QUEUE',
          confirmation_required: true, confirmation_status: 'pending',
          idempotency_key: key, conflict_group: `${aid}|campaign|${c.id}`,
          source_function: 'runSalesModeWasteRotation',
          model_version: 'sales-mode-v1.1',
          target_acos: targetAcos,
          current_acos: c.acos >= 999 ? null : c.acos,
          data_used: JSON.stringify({ lookback_days: lookbackDays, age_days: c.ageDays, spend: c.spend, sales: c.sales, orders: c.orders, clicks: c.clicks, impressions: c.impressions, target_acos: targetAcos, maximum_acos: maxAcos, winner_protected: false }),
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        });
        created.push({ decision_id: decision.id, campaign_id: c.id, campaign_name: c.campaign.name || c.campaign.campaign_name, rationale });
      }

      results.push({ amazon_account_id: aid, max_daily_pauses: maxPauses, already_queued_today: alreadyToday, remaining_quota_before_run: quota, candidates: candidates.length, selected: selected.length, decisions_created: created.length, decisions: created });
    }

    return Response.json({ ok: true, engine: 'sales-mode-waste-rotation-v1.1', dry_run: dryRun, lookback_days: lookbackDays, results });
  } catch (error: any) {
    return Response.json({ ok: false, engine: 'sales-mode-waste-rotation-v1.1', error: error?.message || 'Falha na rotação de desperdício' }, { status: 500 });
  }
});
