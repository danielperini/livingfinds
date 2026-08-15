import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const n = (value: unknown) => Number(value || 0);
const enabled = (row: any) => ['enabled', 'active'].includes(String(row?.state || row?.status || '').toLowerCase());
const manual = (row: any) => String(row?.targeting_type || row?.amazon_targeting_type || '').toUpperCase() === 'MANUAL' || /^SP\s*\|\s*MANUAL\s*\|/i.test(String(row?.name || row?.campaign_name || ''));

Deno.serve(async (request) => {
  const base44 = createClientFromRequest(request);
  const body = await request.json().catch(() => ({}));
  const authenticated = await base44.auth.isAuthenticated().catch(() => false);
  if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
  const accounts = body.amazon_account_id
    ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
    : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, null, 20);
  const reports: any[] = [];
  for (const account of accounts) {
    const aid = account.id;
    const [campaigns, economics, prior] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, '-updated_at', 5000).catch(() => []),
      base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: aid }, '-updated_at', 5000).catch(() => []),
      base44.asServiceRole.entities.ManualGrowthObjectiveSnapshot.filter({ amazon_account_id: aid }, 'baseline_at', 20).catch(() => []),
    ]);
    const economicsByAsin = new Map(economics.map((row: any) => [String(row.asin || '').toUpperCase(), row]));
    const productive = campaigns.filter((campaign: any) => {
      const econ: any = economicsByAsin.get(String(campaign.asin || '').toUpperCase());
      const acos = n(campaign.acos);
      return manual(campaign) && enabled(campaign) && n(campaign.clicks) > 0 && n(campaign.sales) > n(campaign.spend)
        && acos > 0 && acos <= n(econ?.target_acos || 15) && n(econ?.profit_after_ads) > 0;
    });
    const baseline = prior[0] || null;
    const baselineCount = baseline ? n(baseline.baseline_productive_manuals) : productive.length;
    const baselineAt = baseline?.baseline_at || new Date().toISOString();
    const elapsedHours = Math.max(0, (Date.now() - new Date(baselineAt).getTime()) / 3_600_000);
    const multiplier = elapsedHours >= 96 ? 2 : elapsedHours >= 48 ? 1.4 : elapsedHours >= 12 ? 1.2 : 1;
    // Bootstrap: uma base zerada não pode tornar a meta zerada. Sem este piso,
    // o motor não procurava a primeira manual rentável e só reagia depois de
    // uma campanha já existir. O piso continua seguro: apenas enfileira quando
    // TermBank/harvest/Campaign Factory encontrarem termo com evidência real.
    const bootstrapRequired = baselineCount === 0 && productive.length === 0;
    const target = baselineCount > 0 ? Math.ceil(baselineCount * multiplier) : 1;
    const gap = Math.max(0, target - productive.length);
    let queued = 0;
    if (gap > 0 && body.dry_run !== true) {
      // Alimenta o banco com evidência da Amazon antes de criar qualquer manual:
      // AUTO descobre demanda; AUTO e MANUAL podem fornecer termos same-SKU.
      await base44.asServiceRole.functions.invoke('updateTermBankFromAutomaticCampaigns', {
        amazon_account_id: aid, _service_role: true, trigger_type: 'manual_profitable_growth_objective',
      }).catch(() => null);
      await base44.asServiceRole.functions.invoke('runImmediateSameSkuSearchTermHarvest', {
        amazon_account_id: aid, _service_role: true, dry_run: false, trigger_type: 'manual_profitable_growth_objective',
      }).catch(() => null);
      await base44.asServiceRole.functions.invoke('runCampaignFactory', { amazon_account_id: aid, _service_role: true, dry_run: false }).catch(() => null);
      const result: any = await base44.asServiceRole.functions.invoke('scheduleWeeklyCampaignFactoryLaunches', {
        amazon_account_id: aid, _service_role: true, dry_run: false, max_campaigns: Math.min(10, gap), trigger_type: 'manual_profitable_growth_objective',
      }).catch(() => null);
      queued = n(result?.data?.reports?.[0]?.scheduled || result?.reports?.[0]?.scheduled);
    }
    const snapshot = { amazon_account_id: aid, baseline_productive_manuals: baselineCount, current_productive_manuals: productive.length, target_productive_manuals: target, target_multiplier: multiplier, elapsed_hours: Number(elapsedHours.toFixed(2)), growth_gap: gap, safe_campaigns_queued: queued, status: gap === 0 ? 'on_track' : queued ? 'safe_candidates_queued' : bootstrapRequired ? 'bootstrap_awaiting_proven_candidates' : 'awaiting_proven_candidates', baseline_at: baselineAt, checked_at: new Date().toISOString(), details: { sources: ['Amazon Ads search terms from AUTO', 'Amazon Ads search terms from MANUAL', 'TermBank', 'KeywordBank / Campaign Factory'], policy: 'bootstrap_floor_1; 20pct_12h_40pct_48h_100pct_96h; only profitable manual campaigns count; Campaign Factory safety limits prevail', bootstrap_required: bootstrapRequired } };
    await base44.asServiceRole.entities.ManualGrowthObjectiveSnapshot.create(snapshot);
    reports.push(snapshot);
  }
  return Response.json({ ok: true, reports });
});
