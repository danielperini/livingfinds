import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

async function resolveCampaign(base44: any, decision: any) {
  const accountId = decision.amazon_account_id;
  const ids = [decision.campaign_id, decision.entity_id].filter(Boolean).map(String);

  for (const value of ids) {
    const byAmazon = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId, campaign_id: value }, '-updated_at', 1).catch(() => []);
    if (byAmazon[0]) return byAmazon[0];

    const byLocal = await base44.asServiceRole.entities.Campaign.filter({ id: value }, '-updated_at', 1).catch(() => []);
    if (byLocal[0] && byLocal[0].amazon_account_id === accountId) return byLocal[0];
  }

  const name = decision.campaign_name || decision.entity_name;
  if (name) {
    const byName = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId, name }, '-updated_at', 1).catch(() => []);
    if (byName[0]) return byName[0];
    const byCampaignName = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId, campaign_name: name }, '-updated_at', 1).catch(() => []);
    if (byCampaignName[0]) return byCampaignName[0];
  }

  return null;
}

async function closeDuplicates(base44: any, decision: any, campaignId: string) {
  const rows = await base44.asServiceRole.entities.OptimizationDecision.filter({
    amazon_account_id: decision.amazon_account_id,
    action: 'pause_campaign',
  }, '-created_at', 200).catch(() => []);

  for (const row of rows) {
    if (row.id === decision.id || !['approved', 'failed', 'executing'].includes(String(row.status))) continue;
    const campaign = await resolveCampaign(base44, row);
    if (campaign && String(campaign.campaign_id) === String(campaignId)) {
      await base44.asServiceRole.entities.OptimizationDecision.update(row.id, {
        status: 'superseded',
        queue_status: 'completed',
        error_message: null,
        superseded_by: decision.id,
        superseded_at: new Date().toISOString(),
      }).catch(() => {});
    }
  }
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const ids = body.decision_ids || (body.decision_id ? [body.decision_id] : []);
    if (!ids.length) return Response.json({ ok: false, error: 'decision_id obrigatório' }, { status: 400 });

    const results = [];
    for (const id of ids) {
      const rows = await base44.asServiceRole.entities.OptimizationDecision.filter({ id }, null, 1);
      const decision = rows[0];
      if (!decision) { results.push({ id, ok: false, error: 'Decisão não encontrada' }); continue; }
      if (decision.action !== 'pause_campaign') { results.push({ id, ok: false, skipped: true, reason: 'Não é pausa de campanha' }); continue; }

      const campaign = await resolveCampaign(base44, decision);
      if (!campaign?.campaign_id) {
        await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
          status: 'failed',
          queue_status: 'failed',
          error_message: 'campaign_id Amazon não localizado',
        }).catch(() => {});
        results.push({ id, ok: false, error: 'campaign_id Amazon não localizado' });
        continue;
      }

      await closeDuplicates(base44, decision, String(campaign.campaign_id));
      const currentState = String(campaign.state || campaign.status || '').toLowerCase();
      const now = new Date().toISOString();

      let success = currentState === 'paused';
      let response: any = success ? { ok: true, already_applied: true } : null;

      if (!success) {
        const apiResponse = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
          amazon_account_id: decision.amazon_account_id,
          operation: 'pauseCampaignSafe',
          method: 'PUT',
          path: '/v2/sp/campaigns',
          payload: [{ campaignId: String(campaign.campaign_id), state: 'paused' }],
          _service_role: true,
        });
        response = apiResponse?.data || apiResponse || {};
        success = response?.ok === true || response?.status === 200 || response?.status === 207;
      }

      await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
        status: success ? 'executed' : 'failed',
        queue_status: success ? 'completed' : 'failed',
        executed_at: success ? now : null,
        error_message: success ? null : String(response?.errors?.[0]?.message || response?.error || 'Falha ao pausar campanha').slice(0, 500),
        amazon_response: JSON.stringify(response || {}).slice(0, 4000),
      });

      if (success) {
        await base44.asServiceRole.entities.Campaign.update(campaign.id, {
          state: 'paused',
          status: 'paused',
          synced_at: now,
        }).catch(() => {});
      }

      results.push({ id, ok: success, campaign_id: String(campaign.campaign_id), already_paused: currentState === 'paused', error: success ? null : response?.errors?.[0]?.message || response?.error || null });
    }

    return Response.json({ ok: results.every((item) => item.ok || item.skipped), executed: results.filter((item) => item.ok).length, results });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao executar pausa segura' }, { status: 500 });
  }
});
