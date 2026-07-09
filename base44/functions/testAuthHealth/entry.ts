import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const tokenCache: Record<string, { access_token: string; expires_at: number }> = {};

// Resolve credentials com fallback para variáveis legadas
function resolveCredentials(service: string) {
  if (service === 'ads') {
    return {
      clientId:     Deno.env.get('ADS_CLIENT_ID')     || Deno.env.get('AMAZON_LWA_CLIENT_ID')     || '',
      clientSecret: Deno.env.get('ADS_CLIENT_SECRET') || Deno.env.get('AMAZON_LWA_CLIENT_SECRET') || '',
      refreshToken: Deno.env.get('ADS_REFRESH_TOKEN') || '',
    };
  } else {
    return {
      clientId:     Deno.env.get('SP_CLIENT_ID')     || Deno.env.get('AMAZON_LWA_CLIENT_ID')     || '',
      clientSecret: Deno.env.get('SP_CLIENT_SECRET') || Deno.env.get('AMAZON_LWA_CLIENT_SECRET') || '',
      refreshToken: Deno.env.get('SP_REFRESH_TOKEN') || Deno.env.get('AMAZON_SP_REFRESH_TOKEN')  || '',
    };
  }
}

function credentialsDiag(service: string) {
  if (service === 'ads') {
    return {
      ADS_CLIENT_ID:     !!Deno.env.get('ADS_CLIENT_ID'),
      ADS_CLIENT_SECRET: !!Deno.env.get('ADS_CLIENT_SECRET'),
      ADS_REFRESH_TOKEN: !!Deno.env.get('ADS_REFRESH_TOKEN'),
      fallback_LWA_CLIENT_ID: !Deno.env.get('ADS_CLIENT_ID') && !!Deno.env.get('AMAZON_LWA_CLIENT_ID'),
    };
  } else {
    return {
      SP_CLIENT_ID:     !!Deno.env.get('SP_CLIENT_ID'),
      SP_CLIENT_SECRET: !!Deno.env.get('SP_CLIENT_SECRET'),
      SP_REFRESH_TOKEN: !!Deno.env.get('SP_REFRESH_TOKEN'),
      fallback_AMAZON_SP_REFRESH_TOKEN: !Deno.env.get('SP_REFRESH_TOKEN') && !!Deno.env.get('AMAZON_SP_REFRESH_TOKEN'),
      fallback_LWA_CLIENT_ID: !Deno.env.get('SP_CLIENT_ID') && !!Deno.env.get('AMAZON_LWA_CLIENT_ID'),
    };
  }
}

async function testService(service: string) {
  const cached = tokenCache[service];
  if (cached && cached.expires_at > Date.now()) {
    return { ok: true, service, status: 'cached', expires_in: Math.floor((cached.expires_at - Date.now()) / 1000) };
  }

  const { clientId, clientSecret, refreshToken } = resolveCredentials(service);
  const diag = credentialsDiag(service);

  if (!clientId || !clientSecret || !refreshToken) {
    return {
      ok: null,
      service,
      status: 'not_configured',
      message: `Credenciais não configuradas para ${service}`,
      credentials_diag: diag,
    };
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
    const code = data.error || `http_${res.status}`;
    let hint = data.error_description || 'Token fetch failed';
    if (code === 'unauthorized_client') hint = 'Refresh token revogado — reautorize em /amazon-oauth-setup';
    if (code === 'invalid_client')      hint = 'Client ID ou Client Secret incorretos — verifique as variáveis de ambiente';
    if (code === 'invalid_grant')       hint = 'Refresh token expirado ou inválido — gere um novo token';
    return { ok: false, service, status: 'error', error_code: code, message: hint, credentials_diag: diag };
  }

  tokenCache[service] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return { ok: true, service, status: 'active', expires_in: data.expires_in, credentials_diag: diag };
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
          sp:  { ok: true, service: 'sp',  status: 'mock', expires_in: 3600 },
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
        ads: adsResult.status === 'fulfilled' ? adsResult.value : { ok: false, service: 'ads', status: 'error', message: (adsResult as PromiseRejectedResult).reason?.message },
        sp:  spResult.status  === 'fulfilled' ? spResult.value  : { ok: false, service: 'sp',  status: 'error', message: (spResult as PromiseRejectedResult).reason?.message },
      }
    });
  } catch (error: any) {
    return Response.json({ ok: false, message: error.message || 'Health check failed' }, { status: 500 });
  }
});