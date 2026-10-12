export const environmentIntegrations = [
  { key: 'amazon_ads', label: 'Amazon Ads', variables: ['ADS_CLIENT_ID', 'ADS_CLIENT_SECRET', 'ADS_REFRESH_TOKEN', 'ADS_PROFILE_ID', 'ADS_ACCOUNT_ID'] },
  { key: 'amazon_sp_api', label: 'Amazon Selling Partner API', variables: ['AMAZON_LWA_CLIENT_ID', 'AMAZON_LWA_CLIENT_SECRET', 'AMAZON_SP_REFRESH_TOKEN', 'AMAZON_MARKETPLACE_ID', 'AMAZON_SELLER_ID'] },
  { key: 'openai', label: 'OpenAI', variables: ['OPENAI_API_KEY', 'OPENAI_MODEL'] },
  { key: 'anthropic', label: 'Anthropic', variables: ['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL'] },
  { key: 'database', label: 'Banco de dados', variables: ['DATABASE_URL'] },
  { key: 'livingfinds_api', label: 'API do Living Finds', variables: ['API_TOKEN', 'ADMIN_PASSWORD'] },
] as const;

export type EnvironmentStatusReader = (name: string) => string | undefined;

/** Return a strict allowlist of environment names and presence flags, never values. */
export function getEnvironmentStatus(read: EnvironmentStatusReader) {
  return environmentIntegrations.map(({ key, label, variables }) => ({
    key,
    label,
    variables: variables.map((name) => ({ name, configured: Boolean(read(name)?.trim()) })),
  }));
}

export function makeEnvironmentStatusResponse(
  method: string,
  user: { role: string } | null,
  read: EnvironmentStatusReader,
  checkedAt = new Date().toISOString(),
): Response {
  if (method !== 'GET') {
    return Response.json({ ok: false, error: 'Método não permitido' }, { status: 405 });
  }
  if (!user || user.role !== 'admin') {
    return Response.json({ ok: false, error: 'Acesso administrativo obrigatório' }, { status: 403 });
  }
  try {
    return new Response(JSON.stringify({ ok: true, checkedAt, integrations: getEnvironmentStatus(read) }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', pragma: 'no-cache' },
    });
  } catch {
    return Response.json({ ok: false, error: 'Não foi possível consultar a configuração do servidor.' }, { status: 503 });
  }
}
