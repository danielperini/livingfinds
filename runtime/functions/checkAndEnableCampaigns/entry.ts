/**
 * checkAndEnableCampaigns — Verifica o estado real das campanhas na Amazon
 * e ativa as que estiverem PAUSED mas deveriam estar ENABLED.
 * Payload: { amazon_account_id, dry_run?: boolean }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

async function getToken(base44: any) {
  const accounts = await base44.asServiceRole.entities.AmazonAccount.list();
  const refreshToken = accounts[0]?.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: Deno.env.get('ADS_CLIENT_ID'),
      client_secret: Deno.env.get('ADS_CLIENT_SECRET'),
    }).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token failed');
  return data.access_token;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, dry_run = false } = body;

    const baseUrl = 'https://advertising-api.amazon.com';
    const clientId = Deno.env.get('ADS_CLIENT_ID');
    const profileId = Deno.env.get('ADS_PROFILE_ID');
    const token = await getToken(base44);

    const headers = {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': clientId,
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': 'application/vnd.spCampaign.v3+json',
      'Accept': 'application/vnd.spCampaign.v3+json',
    };

    // Buscar todas as campanhas (ENABLED + PAUSED) da Amazon — paginado
    let allCampaigns: any[] = [];
    let nextToken: string | null = null;
    do {
      const body_req: any = { stateFilter: { include: ['ENABLED', 'PAUSED'] }, maxResults: 100 };
      if (nextToken) body_req.nextToken = nextToken;
      const res = await fetch(`${baseUrl}/sp/campaigns/list`, {
        method: 'POST', headers,
        body: JSON.stringify(body_req),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.details || data.message || `API ${res.status}`);
      allCampaigns = allCampaigns.concat(data.campaigns || []);
      nextToken = data.nextToken || null;
    } while (nextToken);

    // Classificar
    const enabled = allCampaigns.filter((c: any) => c.state === 'ENABLED');
    const paused = allCampaigns.filter((c: any) => c.state === 'PAUSED');

    // Campanhas novas (criadas pelo app — nome contém AUTO | ou SP | MANUAL ou SP-AUTO ou SP-EXATA)
    const isNewStyle = (name: string) =>
      name.includes('AUTO |') || name.includes('SP | MANUAL') ||
      name.startsWith('SP-AUTO') || name.startsWith('SP-EXATA');

    const newStylePaused = paused.filter((c: any) => isNewStyle(c.name || ''));
    const newStyleEnabled = enabled.filter((c: any) => isNewStyle(c.name || ''));

    if (dry_run) {
      return Response.json({
        ok: true,
        dry_run: true,
        total_amazon: allCampaigns.length,
        enabled_count: enabled.length,
        paused_count: paused.length,
        new_style_enabled: newStyleEnabled.length,
        new_style_paused: newStylePaused.length,
        would_activate: newStylePaused.map((c: any) => ({ id: c.campaignId, name: c.name, budget: c.budget?.budget })),
      });
    }

    // Ativar as campanhas novas que estão pausadas
    const activated: any[] = [];
    const failed: any[] = [];

    // Processar em batches de 10
    const BATCH = 10;
    for (let i = 0; i < newStylePaused.length; i += BATCH) {
      const batch = newStylePaused.slice(i, i + BATCH);
      // API v3: update via /sp/campaigns endpoint com content-type correto
      const updatePayload = { campaigns: batch.map((c: any) => ({ campaignId: c.campaignId, state: 'ENABLED' })) };
      const updateRes = await fetch(`${baseUrl}/sp/campaigns`, {
        method: 'PUT',
        headers: {
          ...headers,
          'Content-Type': 'application/vnd.spCampaign.v3+json',
          'Accept': 'application/vnd.spCampaign.v3+json',
        },
        body: JSON.stringify(updatePayload),
      });
      const updateText = await updateRes.text();
      let updateData: any = {};
      try { updateData = JSON.parse(updateText); } catch { updateData = { raw: updateText }; }

      // v3 retorna { campaigns: { success: [...], error: [...] } }
      const successList = updateData?.campaigns?.success || [];
      const successIds = new Set(successList.map((r: any) => String(r.campaignId || r.campaignId)));

      batch.forEach((c: any) => {
        if (successIds.has(String(c.campaignId))) {
          activated.push({ id: c.campaignId, name: c.name });
        } else {
          const errEntry = (updateData?.campaigns?.error || []).find((e: any) => String(e.campaignId) === String(c.campaignId));
          failed.push({ id: c.campaignId, name: c.name, error: errEntry?.detail || updateData?.error || `HTTP ${updateRes.status}: ${updateText.slice(0, 100)}` });
        }
      });

      // Atualizar banco local
      if (amazon_account_id) {
        const activatedIds = batch.map((c: any) => String(c.campaignId));
        const localCamps = await base44.asServiceRole.entities.Campaign.filter({
          amazon_account_id,
          campaign_id: { $in: activatedIds },
        }, null, BATCH + 5);
        await Promise.all(
          localCamps.map((lc: any) =>
            base44.asServiceRole.entities.Campaign.update(lc.id, { state: 'enabled', status: 'enabled' }).catch(() => {})
          )
        );
      }
      if (i + BATCH < newStylePaused.length) await new Promise(r => setTimeout(r, 500));
    }

    return Response.json({
      ok: true,
      total_amazon: allCampaigns.length,
      enabled_count: enabled.length,
      paused_count: paused.length,
      new_style_enabled: newStyleEnabled.length,
      new_style_paused: newStylePaused.length,
      activated: activated.length,
      failed: failed.length,
      activated_list: activated,
      failed_list: failed,
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err?.message || 'Erro inesperado' }, { status: 500 });
  }
});