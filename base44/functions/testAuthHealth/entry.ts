import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const tokenCache = {};

async function testService(service) {
  const cached = tokenCache[service];
  if (cached && cached.expires_at > Date.now()) {
    return { ok: true, service, status: 'cached', expires_in: Math.floor((cached.expires_at - Date.now()) / 1000) };
  }

  const isAds = service === 'ads';
  const clientId = isAds ? Deno.env.get('ADS_CLIENT_ID') : Deno.env.get('SP_CLIENT_ID');
  const clientSecret = isAds ? Deno.env.get('ADS_CLIENT_SECRET') : Deno.env.get('SP_CLIENT_SECRET');
  const refreshToken = isAds ? Deno.env.get('ADS_REFRESH_TOKEN') : Deno.env.get('SP_REFRESH_TOKEN');

  if (!clientId || !clientSecret || !refreshToken) {
    return { ok: null, service, status: 'not_configured', message: `Credenciais não configuradas para ${service}` };
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const data = await res.json();

  if (!res.ok) {
    return { ok: false, service, status: 'error', error_code: data.error || `http_${res.status}`, message: data.error_description || 'Token fetch failed' };
  }

  tokenCache[service] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };

  return { ok: true, service, status: 'active', expires_in: data.expires_in };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const mode = Deno.env.get('OPERATION_MODE') || 'mock';

    if (mode === 'mock') {
      return Response.json({
        ok: true,
        mode,
        services: {
          ads: { ok: true, service: 'ads', status: 'mock', expires_in: 3600 },
          sp: { ok: true, service: 'sp', status: 'mock', expires_in: 3600 },
        }
      });
    }

    const [adsResult, spResult] = await Promise.allSettled([
      testService('ads'),
      testService('sp'),
    ]);

    return Response.json({
      ok: true,
      mode,
      services: {
        ads: adsResult.status === 'fulfilled' ? adsResult.value : { ok: false, service: 'ads', status: 'error', message: adsResult.reason?.message },
        sp: spResult.status === 'fulfilled' ? spResult.value : { ok: false, service: 'sp', status: 'error', message: spResult.reason?.message },
      }
    });
  } catch (error) {
    return Response.json({ ok: false, message: error.message || 'Health check failed' }, { status: 500 });
  }
});