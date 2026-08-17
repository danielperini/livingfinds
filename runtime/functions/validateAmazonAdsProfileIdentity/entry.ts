import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function adsBase(region: any) {
  const value = String(region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (value.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (value.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    if (body._service_role !== true) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });
    const expectedSellerId = String(body.expected_seller_id || '').trim().toUpperCase();
    if (!expectedSellerId) return Response.json({ ok: false, error: 'expected_seller_id obrigatorio' }, { status: 400 });
    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.list('-updated_date', 50);
    const account = accounts.find((a: any) => String(a.seller_id || '').trim().toUpperCase() === expectedSellerId) || accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon nao encontrada' }, { status: 404 });
    const tokenResponse = await base44.asServiceRole.functions.invoke('amazonAdsTokenManager', {
      _service_role: true, amazon_account_id: account.id, force_refresh: false,
    });
    const token = tokenResponse?.data || tokenResponse || {};
    if (!token.ok || !token.access_token) return Response.json({ ok: false, error: token.message || 'Token Ads indisponivel' }, { status: 401 });
    const response = await fetch(`${adsBase(account.region)}/v2/profiles`, {
      headers: { Authorization: `Bearer ${token.access_token}`, 'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '', Accept: 'application/json' },
    });
    const profiles = await response.json().catch(() => []);
    if (!response.ok || !Array.isArray(profiles)) return Response.json({ ok: false, error: `Falha ao listar perfis Ads HTTP ${response.status}` }, { status: 502 });
    const sellerProfiles = profiles.filter((p: any) => String(p.accountInfo?.id || '').trim().toUpperCase() === expectedSellerId);
    const selected = sellerProfiles.find((p: any) => String(p.countryCode || '').toUpperCase() === 'BR') || sellerProfiles[0];
    if (!selected?.profileId) return Response.json({ ok: false, error: 'ADS_PROFILE_MERCHANT_MISMATCH', expected_seller_id: expectedSellerId,
      current_profile_id: account.ads_profile_id || null,
      available_profiles: profiles.map((p: any) => ({ profile_id: String(p.profileId), seller_id: p.accountInfo?.id || null, country: p.countryCode || null, type: p.accountInfo?.type || null })) }, { status: 409 });
    const previousProfileId = String(account.ads_profile_id || '');
    await base44.asServiceRole.entities.AmazonAccount.update(account.id, { seller_id: expectedSellerId,
      ads_profile_id: String(selected.profileId), country_code: selected.countryCode || 'BR',
      profile_validation_status: 'valid', profile_validated_at: new Date().toISOString(), status: 'connected', error_message: null });
    return Response.json({ ok: true, amazon_account_id: account.id, expected_seller_id: expectedSellerId,
      previous_profile_id: previousProfileId || null, selected_profile_id: String(selected.profileId),
      profile_changed: previousProfileId !== String(selected.profileId), country: selected.countryCode || null,
      account_type: selected.accountInfo?.type || null });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
});
