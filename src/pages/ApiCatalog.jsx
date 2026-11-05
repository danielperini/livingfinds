import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Check, CircleHelp, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';

async function readEnvironmentStatus() {
  const token = localStorage.getItem('base44_access_token');
  const response = await fetch('/api/admin/environment-status', {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok !== true) {
    throw Object.assign(new Error(payload?.error || `Consulta indisponível (${response.status})`), { status: response.status });
  }
  return payload;
}

function variableHelp(name, integrationKey) {
  const help = {
    ADS_ACCOUNT_ID: 'Identificador interno da conta Amazon Ads. No Amazon Ads Console, abra a conta de anúncios e copie o Account ID. É diferente do Seller ID e do ADS_PROFILE_ID.',
    ADS_PROFILE_ID: 'No Amazon Ads Console, abra o perfil/marketplace Brasil e copie o Profile ID. A API usa este valor no header de escopo.',
    ADS_CLIENT_ID: 'No Amazon Ads Console, abra a aplicação/API criada para Sponsored Products e copie o Client ID. Nunca cole o Client Secret na interface.',
    ADS_CLIENT_SECRET: 'É o segredo da aplicação Amazon Ads. Cadastre somente como secret no VPS/Hostinger; a tela mostra apenas se está presente.',
    ADS_REFRESH_TOKEN: 'É o refresh token OAuth da Amazon Ads. Gere/reautorize a integração e salve somente no secret do VPS/Hostinger.',
    OPENAI_API_KEY: 'Crie ou copie a chave no painel da OpenAI e salve somente como secret no backend. Nunca exponha no frontend.',
    AMAZON_SP_REFRESH_TOKEN: 'Token de self-authorization da SP-API. Gere no Seller Central e salve somente como secret no backend.',
  };
  if (help[name]) return help[name];
  if (integrationKey?.toLowerCase().includes('amazon')) return 'Abra a integração Amazon correspondente, confirme o marketplace Brasil e salve credenciais somente no backend. Nunca compartilhe tokens.';
  return 'Consulte o painel do provedor, copie o identificador solicitado e salve o segredo somente no backend. Esta tela não aceita nem exibe valores secretos.';
}

function IntegrationCard({ integration }) {
  const requiredVariables = integration.variables.filter((variable) => variable.required !== false);
  const configuredRequired = requiredVariables.filter((variable) => variable.configured).length;
  const complete = requiredVariables.length > 0 && configuredRequired === requiredVariables.length;
  const partial = configuredRequired > 0 && !complete;
  return (
    <article className="api-catalog-card">
      <div className="api-catalog-card-heading">
        <div>
          <h2>{integration.label}</h2>
          <p>{complete ? 'Credenciais obrigatórias presentes' : partial ? 'Credenciais obrigatórias parciais' : 'Configuração obrigatória ausente'}</p>
        </div>
        <span className={`api-status-badge ${complete ? 'is-complete' : partial ? 'is-partial' : 'is-missing'}`}>
          {complete ? <Check size={14} /> : <CircleHelp size={14} />}
          {complete ? 'Configurada' : partial ? 'Parcial' : 'Ausente'}
        </span>
      </div>
      <ul className="api-variable-list">
        {integration.variables.map((variable) => (
          <li key={variable.name}>
            <div className="api-variable-main">
              <code>{variable.name}</code>
              <span className={variable.configured ? 'api-variable-state is-present' : 'api-variable-state'}>
                <span className="api-variable-dot" aria-hidden="true" />
                {variable.configured ? 'Presente' : variable.defaultValue ? `Padrão: ${variable.defaultValue}` : variable.required === false ? 'Opcional' : 'Ausente'}
              </span>
            </div>
            <details className="api-variable-help">
              <summary>Como configurar</summary>
              <p>{variableHelp(variable.name, integration.key)}</p>
            </details>
          </li>
        ))}
      </ul>
    </article>
  );
}

export default function ApiCatalog() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try { setStatus(await readEnvironmentStatus()); }
    catch (caught) { setStatus(null); setError(caught); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="api-catalog-page">
      <section className="api-catalog-intro">
        <div className="api-catalog-intro-icon"><ShieldCheck size={21} /></div>
        <div>
          <h2>Catálogo de integrações</h2>
          <p>Estado de configuração consultado no servidor. O Living Finds nunca mostra valores de credenciais nesta tela.</p>
          <p className="api-catalog-hint">Para Ads: <code>ADS_ACCOUNT_ID</code> identifica a conta; <code>ADS_PROFILE_ID</code> identifica o perfil/marketplace. Use “Como configurar” ao lado de cada item.</p>
        </div>
        <button type="button" onClick={refresh} disabled={loading} className="api-refresh-button">
          {loading ? <Loader2 size={16} className="api-spin" /> : <RefreshCw size={16} />}
          <span>Atualizar</span>
        </button>
      </section>

      {loading && !status ? (
        <div className="api-catalog-state" role="status"><Loader2 size={20} className="api-spin" /> Consultando configuração do servidor…</div>
      ) : error ? (
        <div className="api-catalog-error" role="alert">
          <AlertCircle size={19} />
          <div>
            <strong>{error.status === 403 ? 'Acesso administrativo necessário' : 'Estado não confirmado'}</strong>
            <p>{error.status === 403 ? 'Esta consulta está disponível apenas para uma sessão administrativa.' : 'O servidor não confirmou os dados. Verifique a conexão e tente novamente.'}</p>
          </div>
          <button type="button" onClick={refresh}>Tentar novamente</button>
        </div>
      ) : status ? (
        <>
          <p className="api-catalog-updated">Última consulta: <time dateTime={status.checkedAt}>{new Date(status.checkedAt).toLocaleString('pt-BR')}</time></p>
          <div className="api-catalog-grid">
            {status.integrations.map((integration) => <IntegrationCard key={integration.key} integration={integration} />)}
          </div>
        </>
      ) : null}
    </div>
  );
}
