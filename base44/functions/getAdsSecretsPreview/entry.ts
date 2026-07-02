import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const mask = (val) => {
      if (!val) return null;
      if (val.length <= 8) return '****';
      return val.slice(0, 4) + '****' + val.slice(-4);
    };

    const secrets = {
      ADS_CLIENT_ID:     Deno.env.get('ADS_CLIENT_ID')     || null,
      ADS_CLIENT_SECRET: Deno.env.get('ADS_CLIENT_SECRET') || null,
      ADS_REFRESH_TOKEN: Deno.env.get('ADS_REFRESH_TOKEN') || null,
      ADS_PROFILE_ID:    Deno.env.get('ADS_PROFILE_ID')    || null,
      ADS_REGION:        Deno.env.get('ADS_REGION')        || null,
    };

    return Response.json({
      ok: true,
      values: {
        ADS_CLIENT_ID:     secrets.ADS_CLIENT_ID     ? mask(secrets.ADS_CLIENT_ID)     : null,
        ADS_CLIENT_SECRET: secrets.ADS_CLIENT_SECRET ? mask(secrets.ADS_CLIENT_SECRET) : null,
        ADS_REFRESH_TOKEN: secrets.ADS_REFRESH_TOKEN ? mask(secrets.ADS_REFRESH_TOKEN) : null,
        ADS_PROFILE_ID:    secrets.ADS_PROFILE_ID,   // não sensível, mostrar completo
        ADS_REGION:        secrets.ADS_REGION,        // não sensível, mostrar completo
      },
      set: {
        ADS_CLIENT_ID:     !!secrets.ADS_CLIENT_ID,
        ADS_CLIENT_SECRET: !!secrets.ADS_CLIENT_SECRET,
        ADS_REFRESH_TOKEN: !!secrets.ADS_REFRESH_TOKEN,
        ADS_PROFILE_ID:    !!secrets.ADS_PROFILE_ID,
        ADS_REGION:        !!secrets.ADS_REGION,
      },
    });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});