/**
 * saveAdsRefreshToken — Valida e salva um refresh token Amazon Ads na entidade AmazonAccount
 * Payload: { amazon_account_id, refresh_token }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, refresh_token } = body;

    if (!refresh_token || !String(refresh_token).startsWith('Atzr|')) {
      return Response.json({ ok: false, error: 'Token inválido: deve começar com Atzr|' }, { status: 400 });
    }

    // Buscar a conta
    let account = null;
    if (amazon_account_id) {
      const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id }, null, 1);
      account = accounts[0] || null;
    }
    if (!account) {
      const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ user_id: user.id }, '-updated_date', 1);
      account = accounts[0] || null;
    }
    if (!account) {
      const all = await base44.asServiceRole.entities.AmazonAccount.list('-updated_date', 1);
      account = all[0] || null;
    }
    if (!account) {
      return Response.json({ ok: false, error: 'Nenhuma conta Amazon encontrada. Crie a conta nas Configurações primeiro.' }, { status: 404 });
    }

    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
    const clientSecret = Deno.env.get('ADS_CLIENT_SECRET') || '';

    if (!clientId || !clientSecret) {
      return Response.json({ ok: false, error: 'ADS_CLIENT_ID ou ADS_CLIENT_SECRET não configurados nos secrets.' }, { status: 500 });
    }

    // Validar o token trocando por access token
    const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: String(refresh_token).trim(),
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });

    const tokenData = await tokenRes.json().catch(() => ({}));

    if (!tokenRes.ok || !tokenData.access_token) {
      const errMsg = tokenData.error_description || tokenData.error || `HTTP ${tokenRes.status}`;
      return Response.json({ ok: false, error: `Token inválido: ${errMsg}` }, { status: 400 });
    }

    // Tentar listar profiles para confirmar que funciona
    const region = (account.region || 'NA').toUpperCase();
    let baseUrl = 'https://advertising-api.amazon.com';
    if (region.includes('EU')) baseUrl = 'https://advertising-api-eu.amazon.com';
    if (region.includes('FE')) baseUrl = 'https://advertising-api-fe.amazon.com';

    const profilesRes = await fetch(`${baseUrl}/profiles`, {
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
        'Amazon-Advertising-API-ClientId': clientId,
        'Accept': 'application/json',
      },
    });

    let profiles = [];
    if (profilesRes.ok) {
      const data = await profilesRes.json().catch(() => []);
      profiles = Array.isArray(data) ? data : [];
    }

    // Salvar token na entidade
    await base44.asServiceRole.entities.AmazonAccount.update(account.id, {
      ads_refresh_token: String(refresh_token).trim(),
      status: 'connected',
      error_message: null,
      profile_validation_status: 'valid',
      profile_validated_at: new Date().toISOString(),
      last_sync_at: new Date().toISOString(),
    });

    return Response.json({
      ok: true,
      message: 'Token validado e salvo com sucesso.',
      account_id: account.id,
      profiles_found: profiles.length,
      profiles: profiles.slice(0, 5).map((p: any) => ({
        profileId: p.profileId,
        name: p.name,
        countryCode: p.countryCode,
        currencyCode: p.currencyCode,
      })),
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err?.message || 'Erro inesperado' }, { status: 500 });
  }
});