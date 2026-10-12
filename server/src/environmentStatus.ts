type EnvironmentVariable = {
  name: string;
  names?: readonly string[];
  required: boolean;
  defaultValue?: string;
};

type EnvironmentIntegration = {
  key: string;
  label: string;
  variables: readonly EnvironmentVariable[];
};

const variable = (name: string, options: Omit<EnvironmentVariable, 'name'> = {}): EnvironmentVariable => ({ name, ...options });

export const environmentIntegrations: readonly EnvironmentIntegration[] = [
  {
    key: 'amazon_ads', label: 'Amazon Ads', variables: [
      variable('ADS_CLIENT_ID', { required: true }),
      variable('ADS_CLIENT_SECRET', { required: true }),
      variable('ADS_REFRESH_TOKEN', { required: true }),
      variable('ADS_PROFILE_ID', { required: true }),
      variable('ADS_ACCOUNT_ID', { required: true }),
    ],
  },
  {
    key: 'amazon_sp_api', label: 'Amazon Selling Partner API', variables: [
      variable('AMAZON_LWA_CLIENT_ID / SP_CLIENT_ID', { names: ['AMAZON_LWA_CLIENT_ID', 'SP_CLIENT_ID'], required: true }),
      variable('AMAZON_LWA_CLIENT_SECRET / SP_CLIENT_SECRET', { names: ['AMAZON_LWA_CLIENT_SECRET', 'SP_CLIENT_SECRET'], required: true }),
      variable('AMAZON_SP_REFRESH_TOKEN / SP_REFRESH_TOKEN', { names: ['AMAZON_SP_REFRESH_TOKEN', 'SP_REFRESH_TOKEN'], required: true }),
    ],
  },
  {
    key: 'openai', label: 'OpenAI', variables: [
      variable('OPENAI_API_KEY', { required: true }),
      variable('OPENAI_MODEL', { required: false, defaultValue: 'gpt-4o' }),
    ],
  },
  {
    key: 'anthropic', label: 'Anthropic', variables: [
      variable('ANTHROPIC_API_KEY', { required: true }),
      variable('ANTHROPIC_MODEL_FAST / ANTHROPIC_MODEL', {
        names: ['ANTHROPIC_MODEL_FAST', 'ANTHROPIC_MODEL'], required: false, defaultValue: 'claude-3-5-sonnet-20241022',
      }),
    ],
  },
  { key: 'database', label: 'Banco de dados', variables: [variable('DATABASE_URL', { required: true })] },
  {
    key: 'livingfinds_api', label: 'API do Living Finds', variables: [
      variable('API_TOKEN / ADMIN_PASSWORD', { names: ['API_TOKEN', 'ADMIN_PASSWORD'], required: true }),
    ],
  },
];

export type EnvironmentStatusReader = (name: string) => string | undefined;

/** Resolve only allowlisted names and report presence/effective defaults, never secret values. */
export function getEnvironmentStatus(read: EnvironmentStatusReader) {
  return environmentIntegrations.map(({ key, label, variables }) => ({
    key,
    label,
    variables: variables.map(({ name, names = [name], required, defaultValue }) => ({
      name,
      configured: names.some((candidate) => Boolean(read(candidate)?.trim())),
      required,
      ...(defaultValue ? { defaultValue } : {}),
    })),
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
    return Response.json({ ok: false, error: 'Não foi possível consultar o estado do ambiente' }, { status: 500 });
  }
}
