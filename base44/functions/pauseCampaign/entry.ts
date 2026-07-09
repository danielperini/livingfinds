/**
 * pauseCampaign — Pausa campanhas SP via Amazon Ads API v3
 * Usa PATCH /sp/campaigns (v3) que é o endpoint correto para atualizar state.
 * Centraliza autenticação via secret ADS_REFRESH_TOKEN (fonte primária).
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

async function getAdsToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
  const clientSecret = Deno.env.get('ADS_CLIENT_SECRET') || '';
  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error('Credenciais Amazon Ads incompletas (ADS_CLIENT_ID, ADS_CLIENT_SECRET, refresh_token).');
  }
  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `Token falhou: HTTP ${response.status}`);
  }
  return data.access_token;
}

function getAdsBaseUrl(region?: string): string {
  const r = String(region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

function unique(arr: string[]): string[] {
  return [...new Set(arr.filter(Boolean))];
}

function chunks<T>(arr: T[], size = 100): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, campaign_id, asin, sku } = body;

    if (!amazon_account_id || (!campaign_id && !asin && !sku)) {
      return Response.json({ ok: false, error: 'amazon_account_id + (campaign_id | asin | sku) obrigatórios' }, { status: 400 });
    }

    // ── Resolver conta ──────────────────────────────────────────────────────
    const account = await base44.asServiceRole.entities.AmazonAccount.get(amazon_account_id);
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon não encontrada' }, { status: 404 });

    // Fonte primária: secret ADS_REFRESH_TOKEN; fallback: entidade
    const refreshToken = Deno.env.get('ADS_REFRESH_TOKEN') || account.ads_refresh_token;
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    if (!refreshToken) return Response.json({ ok: false, error: 'ADS_REFRESH_TOKEN não configurado' }, { status: 400 });
    if (!profileId) return Response.json({ ok: false, error: 'ADS_PROFILE_ID não configurado' }, { status: 400 });

    // Sincronizar token na entidade se divergente (mantém conectado permanentemente)
    if (refreshToken !== account.ads_refresh_token) {
      await base44.asServiceRole.entities.AmazonAccount.update(account.id, {
        ads_refresh_token: refreshToken,
        status: 'connected',
        error_message: null,
      }).catch(() => {});
    }

    // ── Resolver campanhas relacionadas ────────────────────────────────────
    const allCampaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id });
    // Tentar casar pelo campaign_id (ID Amazon) OU pelo id interno do Base44
    const seedCampaign = campaign_id
      ? allCampaigns.find(c => String(c.campaign_id) === String(campaign_id) || String(c.id) === String(campaign_id))
      : null;
    const targetAsin = asin || seedCampaign?.asin || null;
    const targetSku  = sku  || seedCampaign?.sku  || null;

    const related = allCampaigns.filter(c => {
      if (c.archived || c.state === 'archived') return false;
      // Casar por campaign_id (ID Amazon) OU id interno Base44
      if (campaign_id && (String(c.campaign_id) === String(campaign_id) || String(c.id) === String(campaign_id))) return true;
      if (targetAsin && String(c.asin || '') === String(targetAsin)) return true;
      if (targetSku && String(c.sku || '') === String(targetSku)) return true;
      return false;
    });

    const campaignIds = unique(related.map(c => c.campaign_id));
    if (!campaignIds.length) {
      return Response.json({ ok: false, error: 'Nenhuma campanha encontrada para pausar' }, { status: 404 });
    }

    // ── Chamar Amazon Ads API v3 — PATCH /sp/campaigns ─────────────────────
    const pausedIds: string[] = [];
    const failedItems: any[] = [];
    let apiAuthError = false;
    let apiErrorMsg = '';

    try {
      const token = await getAdsToken(refreshToken);
      const baseUrl = getAdsBaseUrl(account.region);
      const CT = 'application/vnd.spCampaign.v3+json';

      for (const batch of chunks(campaignIds, 100)) {
        const response = await fetch(`${baseUrl}/sp/campaigns`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
            'Amazon-Advertising-API-Scope': String(profileId),
            'Content-Type': CT,
            'Accept': CT,
          },
          body: JSON.stringify({
            campaigns: batch.map(id => ({ campaignId: id, state: 'PAUSED' })),
          }),
        });

        const data = await response.json().catch(() => ({}));
        const successes = data?.campaigns?.success || data?.success || [];
        const errors    = data?.campaigns?.error   || data?.error   || [];

        for (const s of successes) {
          const id = s?.campaignId || s?.campaign?.campaignId;
          if (id) pausedIds.push(String(id));
        }
        for (const e of errors) failedItems.push(e);

        if (!response.ok && !successes.length) {
          if (response.status === 401 || response.status === 403) {
            apiAuthError = true;
            apiErrorMsg = `Token sem permissão para pausar (HTTP ${response.status}): ${data?.message || data?.error || 'Not authorized'}`;
          } else {
            apiErrorMsg = `Amazon HTTP ${response.status}: ${data?.message || data?.error || ''}`;
          }
        }
      }
    } catch (apiErr: any) {
      apiErrorMsg = `Erro ao chamar Amazon API: ${apiErr?.message}`;
    }

    // ── Atualizar banco local sempre (pausar localmente independente da API) ─
    // Se a API falhou, a pausa local garante consistência visual e enfileira retry.
    const confirmedIds = pausedIds.length ? unique(pausedIds) : campaignIds;
    const now = new Date().toISOString();

    for (const campaign of related) {
      if (!confirmedIds.includes(String(campaign.campaign_id))) continue;
      await base44.asServiceRole.entities.Campaign.update(campaign.id, {
        state: 'paused', status: 'paused',
        original_state: campaign.state,
        last_activity_at: now, synced_at: now, last_sync_at: now,
      });
    }

    // Resetar produtos para estado de kick-off
    let relatedProducts: any[] = [];
    if (targetAsin) {
      relatedProducts = await base44.asServiceRole.entities.Product.filter({ amazon_account_id, asin: targetAsin });
    } else if (targetSku) {
      relatedProducts = await base44.asServiceRole.entities.Product.filter({ amazon_account_id, sku: targetSku });
    } else if (campaign_id) {
      relatedProducts = await base44.asServiceRole.entities.Product.filter({ amazon_account_id, linked_campaign_id: String(campaign_id) });
    }

    for (const product of relatedProducts) {
      await base44.asServiceRole.entities.Product.update(product.id, {
        has_campaign: true, campaign_status: 'paused',
        ads_paused_at: now,
      });
    }

    // Garantir conta como connected após operação bem-sucedida
    await base44.asServiceRole.entities.AmazonAccount.update(account.id, {
      status: 'connected', error_message: null, last_sync_at: now,
    }).catch(() => {});

    await base44.asServiceRole.entities.LearningEvent.create({
      amazon_account_id,
      event_type: 'product_campaigns_paused',
      entity_type: 'product',
      entity_id: String(targetAsin || targetSku || campaign_id),
      observation: `${confirmedIds.length} campanhas pausadas localmente. API Amazon: ${apiErrorMsg || 'ok'}.`,
      recorded_at: now,
    }).catch(() => {});

    // Se houve erro de autenticação, marcar conta para diagnóstico mas ainda retornar ok
    if (apiAuthError) {
      await base44.asServiceRole.entities.AmazonAccount.update(account.id, {
        error_message: apiErrorMsg,
      }).catch(() => {});
    }

    // Enfileirar ação de pausa para retry via API quando o token for renovado
    if (apiErrorMsg && !pausedIds.length) {
      for (const cid of campaignIds) {
        await base44.asServiceRole.entities.AmazonActionQueue.create({
          amazon_account_id,
          action_type: 'pause_campaign',
          entity_type: 'campaign',
          entity_id: cid,
          payload: JSON.stringify({ campaign_id: cid, state: 'PAUSED' }),
          status: 'pending',
          priority: 'high',
          reason: 'Pausa solicitada pelo usuário — API Amazon indisponível no momento',
          created_at: now,
          scheduled_for: now,
        }).catch(() => {});
      }
    }

    return Response.json({
      ok: true,
      asin: targetAsin,
      sku: targetSku,
      requested: campaignIds.length,
      paused: confirmedIds.length,
      paused_campaign_ids: confirmedIds,
      failed: failedItems,
      product_reset_to_kickoff: true,
      api_synced: pausedIds.length > 0,
      api_warning: apiErrorMsg || null,
      message: pausedIds.length > 0
        ? `${confirmedIds.length} campanhas pausadas com sucesso.`
        : `${confirmedIds.length} campanhas pausadas localmente. A sincronização com a Amazon ocorrerá automaticamente.`,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao pausar campanhas' }, { status: 500 });
  }
});