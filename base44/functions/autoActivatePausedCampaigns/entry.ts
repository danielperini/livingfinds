/**
 * autoActivatePausedCampaigns
 * Verifica produtos com estoque FBA positivo que têm campanha pausada
 * e reativa essas campanhas diretamente na Amazon Ads API.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

async function getAdsToken(refreshToken: string) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: Deno.env.get('ADS_CLIENT_ID') || '',
    client_secret: Deno.env.get('ADS_CLIENT_SECRET') || '',
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Token error: ${data.error_description || data.error}`);
  return data.access_token;
}

function getAdsBase() {
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function enableCampaign(campaignId: string, token: string, profileId: string) {
  const res = await fetch(`${getAdsBase()}/sp/campaigns`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': profileId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([{ campaignId, state: 'enabled' }]),
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const accounts = await base44.asServiceRole.entities.AmazonAccount.list();
    if (!accounts.length) return Response.json({ ok: true, message: 'Nenhuma conta', activated: 0 });

    let totalActivated = 0;
    let totalSkipped = 0;
    const errors: string[] = [];

    for (const account of accounts) {
      const aid = account.id;
      const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
      const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');

      if (!refreshToken || !profileId) {
        errors.push(`Conta ${aid}: sem refresh_token ou profile_id`);
        continue;
      }

      // Produtos com estoque positivo e campanha pausada
      const products = await base44.asServiceRole.entities.Product.filter(
        { amazon_account_id: aid },
        '-created_date',
        2000
      );

      const eligible = products.filter(p =>
        (p.fba_inventory || 0) > 0 &&
        p.campaign_status === 'paused' &&
        p.linked_campaign_id
      );

      if (eligible.length === 0) { totalSkipped++; continue; }

      // Buscar campanhas pausadas correspondentes
      const campaignIds = [...new Set(eligible.map(p => p.linked_campaign_id))];
      const campaigns = await base44.asServiceRole.entities.Campaign.filter(
        { amazon_account_id: aid },
        '-created_date',
        2000
      );
      const pausedCamps = campaigns.filter(c =>
        campaignIds.includes(c.campaign_id) &&
        (c.state === 'paused' || c.status === 'paused')
      );

      if (pausedCamps.length === 0) { totalSkipped++; continue; }

      let token: string;
      try {
        token = await getAdsToken(refreshToken);
      } catch (e) {
        errors.push(`Conta ${aid}: falha no token — ${e.message}`);
        continue;
      }

      for (const camp of pausedCamps) {
        try {
          const result = await enableCampaign(camp.campaign_id, token, String(profileId));

          if (result.ok) {
            // Atualizar entidade local
            await base44.asServiceRole.entities.Campaign.update(camp.id, {
              state: 'enabled',
              status: 'enabled',
              last_sync_at: new Date().toISOString(),
            });

            // Atualizar produtos linkados
            const linkedProducts = eligible.filter(p => p.linked_campaign_id === camp.campaign_id);
            for (const p of linkedProducts) {
              await base44.asServiceRole.entities.Product.update(p.id, {
                campaign_status: 'active',
              });
            }

            // Registar no BidHistory
            await base44.asServiceRole.entities.BidHistory.create({
              amazon_account_id: aid,
              entity_type: 'campaign',
              entity_id: camp.campaign_id,
              entity_name: camp.name || camp.campaign_name,
              reason: `Campanha reativada automaticamente — produto com ${linkedProducts[0]?.fba_inventory || 0} unidades em stock`,
              status: 'executed',
              applied_by: 'autopilot',
              executed_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
            });

            totalActivated++;
          } else {
            errors.push(`Campanha ${camp.campaign_id}: ${JSON.stringify(result.data).slice(0, 100)}`);
          }
        } catch (e) {
          errors.push(`Campanha ${camp.campaign_id}: ${e.message}`);
        }
      }
    }

    return Response.json({
      ok: true,
      activated: totalActivated,
      skipped: totalSkipped,
      errors,
      message: `${totalActivated} campanha(s) reativada(s) automaticamente.`,
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});