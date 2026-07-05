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

    const read = (key: string) => Deno.env.get(key) || null;

    const secrets: Record<string, string | null> = {
      ADS_CLIENT_ID:              read('ADS_CLIENT_ID'),
      ADS_CLIENT_SECRET:          read('ADS_CLIENT_SECRET'),
      ADS_REFRESH_TOKEN:          read('ADS_REFRESH_TOKEN'),
      ADS_PROFILE_ID:             read('ADS_PROFILE_ID'),
      ADS_REGION:                 read('ADS_REGION'),
      AMAZON_SP_REFRESH_TOKEN:    read('AMAZON_SP_REFRESH_TOKEN'),
      AMAZON_LWA_CLIENT_ID:       read('AMAZON_LWA_CLIENT_ID'),
      AMAZON_LWA_CLIENT_SECRET:   read('AMAZON_LWA_CLIENT_SECRET'),
      ANTHROPIC_API_KEY:          read('ANTHROPIC_API_KEY'),
    };

    // Campos não-sensíveis: mostrar valor completo
    const nonSensitive = new Set(['ADS_PROFILE_ID', 'ADS_REGION']);

    const values: Record<string, string | null> = {};
    const set: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(secrets)) {
      set[k] = !!v;
      values[k] = v ? (nonSensitive.has(k) ? v : mask(v)) : null;
    }

    return Response.json({ ok: true, values, set });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});