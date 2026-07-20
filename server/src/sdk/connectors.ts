/**
 * Connectors — reimplementa `base44.connectors.getConnection(name)`.
 * Único conector observado: 'googledrive' (backup de listings/relatórios).
 * Retorna um accessToken obtido via OAuth refresh token (service account / OAuth app).
 */
// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

async function googleDriveToken(): Promise<Json> {
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET');
  const refreshToken = Deno.env.get('GOOGLE_DRIVE_REFRESH_TOKEN');
  if (!clientId || !clientSecret || !refreshToken) {
    return { accessToken: null, error: 'Credenciais Google Drive não configuradas' };
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const data = await res.json().catch(() => ({}));
  return { accessToken: data?.access_token ?? null, raw: data };
}

export function makeConnectors() {
  return {
    getConnection: async (name: string): Promise<Json> => {
      if (name === 'googledrive') return await googleDriveToken();
      return { accessToken: null, error: `Conector desconhecido: ${name}` };
    },
  };
}
