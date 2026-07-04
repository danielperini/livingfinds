import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Link } from 'react-router-dom';
import {
  Link2, CheckCircle, XCircle, Loader2, AlertCircle,
  ShieldCheck, RefreshCw, Activity, BookOpen, ExternalLink, KeyRound,
  Zap, ShieldAlert
} from 'lucide-react';

function statusIcon(s) {
  if (s === 'PASSED') return <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />;
  if (s === 'FAILED') return <XCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />;
  if (s === 'SKIPPED') return <AlertCircle className="w-4 h-4 text-slate-500 flex-shrink-0 mt-0.5" />;
  return <div className="w-4 h-4 rounded-full border border-slate-600 flex-shrink-0 mt-0.5" />;
}

const TEST_LABELS = {
  lwa_authentication: 'Autenticação LWA (Token de Acesso)',
  sp_api_authorization: 'Autorização SP-API',
  marketplace_configuration: 'Configuração de Marketplace',
  endpoint_access: 'Acesso ao Endpoint (Catalog API)',
};

export default function AmazonIntegracao() {
  const [account, setAccount] = useState(null);
  const [loadingAccount, setLoadingAccount] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [adsStatus, setAdsStatus] = useState(null);
  const [checkingAds, setCheckingAds] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const me = await base44.auth.me();
        const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
        setAccount(accounts[0] || null);
      } catch {
        setAccount(null);
      } finally {
        setLoadingAccount(false);
      }
    })();

    // Verifica status do token Ads silenciosamente
    (async () => {
      setCheckingAds(true);
      try {
        const res = await base44.functions.invoke('getOAuthSetupInfo', {});
        setAdsStatus(res.data);
      } catch {
        setAdsStatus(null);
      } finally {
        setCheckingAds(false);
      }
    })();
  }, []);

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await base44.functions.invoke('testSpApiAuth', {});
      setTestResult(res.data);
    } catch (e) {
      setTestResult({ error: e.message });
    } finally {
      setTesting(false);
    }
  };

  const runSync = async () => {
    if (!account) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await base44.functions.invoke('syncProductCatalog', { amazon_account_id: account.id });
      const d = res.data;
      setSyncResult({ ok: d?.ok, message: d?.ok ? `✓ ${d.records_upserted || 0} produtos sincronizados` : (d?.error || 'Erro na sincronização') });
    } catch (e) {
      setSyncResult({ ok: false, message: e.message });
    } finally {
      setSyncing(false);
    }
  };

  const spApiOk = testResult?.tests?.sp_api_authorization?.status === 'PASSED';
  const lwaOk = testResult?.tests?.lwa_authentication?.status === 'PASSED';
  const isConnected = account?.status === 'connected';

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6 animate-fade-in">
      {/* Banner de alerta Amazon Ads */}
      {!checkingAds && adsStatus && adsStatus.token_status !== 'valid' && (
        <div className="flex items-start gap-3 p-4 bg-red-500/10 border border-red-500/30 rounded-2xl">
          <ShieldAlert className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-red-300">Token Amazon Ads inválido ou expirado</p>
            <p className="text-xs text-red-400/80 mt-0.5">
              {adsStatus.token_error || 'O refresh token da Amazon Ads foi revogado — todas as operações de campanhas estão a falhar com 403.'}
            </p>
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <Link
                to="/amazon-oauth-setup"
                className="flex items-center gap-1.5 px-4 py-2 bg-red-500 hover:bg-red-400 text-white text-xs font-bold rounded-lg transition-colors"
              >
                <Zap className="w-3.5 h-3.5" />
                Reautorizar Amazon Ads agora →
              </Link>
              <span className="text-[10px] text-red-400/60">Clique para iniciar o fluxo OAuth e renovar o token</span>
            </div>
          </div>
        </div>
      )}

      {!checkingAds && adsStatus && adsStatus.token_status === 'valid' && (
        <div className="flex items-center gap-3 p-3 bg-emerald-500/8 border border-emerald-500/20 rounded-xl">
          <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0" />
          <p className="text-xs text-emerald-300 font-semibold">Token Amazon Ads válido — {adsStatus.profiles?.length || 0} profile(s) encontrado(s)</p>
          <Link to="/amazon-oauth-setup" className="ml-auto text-[10px] text-slate-500 hover:text-cyan transition-colors flex items-center gap-1">
            <ExternalLink className="w-3 h-3" /> Detalhes
          </Link>
        </div>
      )}

      {checkingAds && (
        <div className="flex items-center gap-2 p-3 bg-surface-1 border border-surface-2 rounded-xl">
          <Loader2 className="w-3.5 h-3.5 text-slate-500 animate-spin" />
          <p className="text-xs text-slate-500">A verificar token Amazon Ads...</p>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/20 flex items-center justify-center">
          <Link2 className="w-5 h-5 text-amber-400" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-white">Integração Amazon SP-API</h1>
          <p className="text-xs text-slate-400">Aplicação privada — usa self-authorization via Seller Central</p>
        </div>
      </div>

      {/* Estado da conta */}
      <div className="bg-surface-1 border border-surface-2 rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-white">Estado da Ligação SP-API</p>
          {loadingAccount ? (
            <Loader2 className="w-4 h-4 text-slate-500 animate-spin" />
          ) : isConnected ? (
            <span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 px-2.5 py-1 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Conectado
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-xs font-semibold text-amber-400 bg-amber-400/10 border border-amber-400/20 px-2.5 py-1 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" /> Não verificado
            </span>
          )}
        </div>

        {account && (
          <div className="grid grid-cols-2 gap-3 text-xs">
            {[
              { label: 'Seller Name', value: account.seller_name },
              { label: 'Seller ID', value: account.seller_id },
              { label: 'Marketplace ID', value: account.marketplace_id },
              { label: 'Última sincronização', value: account.last_sync_at ? new Date(account.last_sync_at).toLocaleString('pt-BR') : null },
            ].filter(i => i.value).map(({ label, value }) => (
              <div key={label}>
                <p className="text-slate-500 mb-0.5">{label}</p>
                <p className="text-slate-200 font-mono">{value}</p>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={testConnection}
            disabled={testing}
            className="flex items-center gap-2 px-4 py-2.5 bg-cyan/15 border border-cyan/30 text-cyan hover:bg-cyan/25 text-sm font-semibold rounded-lg transition-colors disabled:opacity-60"
          >
            {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Activity className="w-4 h-4" />}
            {testing ? 'A testar...' : 'Testar ligação'}
          </button>

          <button
            onClick={runSync}
            disabled={syncing || !spApiOk}
            title={!spApiOk ? 'Teste a ligação primeiro' : ''}
            className="flex items-center gap-2 px-4 py-2.5 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-50"
          >
            {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {syncing ? 'Sincronizando...' : 'Sincronizar dados'}
          </button>
        </div>

        {syncResult && (
          <div className={`px-3 py-2 rounded-lg border text-xs ${syncResult.ok ? 'bg-emerald-400/5 border-emerald-400/20 text-emerald-300' : 'bg-red-400/5 border-red-400/20 text-red-400'}`}>
            {syncResult.message}
          </div>
        )}
      </div>

      {/* Resultados do teste */}
      {testResult && (
        <div className="bg-surface-1 border border-surface-2 rounded-2xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-cyan" />
            <p className="text-sm font-semibold text-white">Resultado do Diagnóstico</p>
            {testResult.timestamp && (
              <span className="text-xs text-slate-500 ml-auto">{new Date(testResult.timestamp).toLocaleString('pt-BR')}</span>
            )}
          </div>

          {testResult.error && (
            <p className="text-xs text-red-400">{testResult.error}</p>
          )}

          {testResult.credentials && (
            <div className="grid grid-cols-2 gap-2 text-xs">
              {[
                { label: 'LWA Client ID', value: testResult.credentials.lwa_client_id },
                { label: 'LWA Client Secret', value: testResult.credentials.lwa_client_secret },
                { label: 'SP Refresh Token', value: testResult.credentials.sp_refresh_token },
                { label: 'Marketplace', value: testResult.credentials.marketplace_id },
              ].map(({ label, value }) => (
                <div key={label} className="bg-surface-2 rounded-lg px-3 py-2">
                  <p className="text-slate-500">{label}</p>
                  <p className={`font-mono truncate ${value === 'ausente' || value === 'NÃO CONFIGURADO' ? 'text-red-400' : 'text-slate-200'}`}>{value || '—'}</p>
                </div>
              ))}
            </div>
          )}

          {testResult.tests && (
            <div className="space-y-2">
              {Object.entries(testResult.tests).map(([key, t]) => (
                <div key={key} className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border ${
                  t.status === 'PASSED' ? 'bg-emerald-400/5 border-emerald-400/20' :
                  t.status === 'FAILED' ? 'bg-red-400/5 border-red-400/20' :
                  'bg-surface-2 border-surface-3'
                }`}>
                  {statusIcon(t.status)}
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-slate-300">{TEST_LABELS[key] || key}</p>
                    {t.message && <p className="text-xs text-slate-400 mt-0.5">{t.message}</p>}
                    {t.detail?.error && (
                      <p className="text-xs text-red-400 mt-0.5 font-mono">{t.detail.error}: {t.detail.description}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Alerta se token inválido */}
          {testResult.error_detail?.amazonError === 'invalid_grant' && (
            <div className="flex items-start gap-2 px-3 py-2.5 bg-amber-500/10 border border-amber-500/20 rounded-lg">
              <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
              <div className="text-xs text-amber-300 space-y-1">
                <p className="font-semibold">Refresh token inválido ou revogado</p>
                <p>Faça a self-authorization novamente no Seller Central para gerar um novo token <code className="font-mono">Atzr|</code> e atualize o secret <code className="font-mono">AMAZON_SP_REFRESH_TOKEN</code>.</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Instruções self-authorization */}
      <div className="bg-surface-1 border border-surface-2 rounded-2xl p-5 space-y-4">
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-cyan" />
          <p className="text-sm font-semibold text-white">Como configurar as credenciais SP-API</p>
        </div>
        <p className="text-xs text-slate-400">
          Esta aplicação é <strong className="text-white">privada</strong> — não usa o fluxo OAuth público.
          O refresh token é gerado manualmente no Seller Central.
        </p>

        <ol className="space-y-3 text-xs text-slate-300">
          {[
            { n: 1, text: 'Acede ao Seller Central com o utilizador principal da conta.' },
            { n: 2, text: 'Vai a Apps e Serviços → Desenvolver Aplicações.' },
            { n: 3, text: <>Localiza a aplicação <code className="font-mono text-cyan">amzn1.sp.solution.7c15f6b8...</code></> },
            { n: 4, text: 'Clica na seta ao lado de "Alterar" e seleciona "Autorizar".' },
            { n: 5, text: <>Clica em "Autorizar aplicativo". A Amazon gera um token iniciado por <code className="font-mono text-cyan">Atzr|</code></> },
            { n: 6, text: <>Guarda esse token no secret <code className="font-mono text-cyan">AMAZON_SP_REFRESH_TOKEN</code> no painel do Base44.</> },
            { n: 7, text: 'Volta aqui e clica em "Testar ligação" para validar.' },
          ].map(({ n, text }) => (
            <li key={n} className="flex items-start gap-3">
              <span className="w-5 h-5 rounded-full bg-surface-3 border border-surface-3 flex items-center justify-center text-xs font-bold text-slate-400 flex-shrink-0 mt-0.5">{n}</span>
              <span>{text}</span>
            </li>
          ))}
        </ol>

        <a
          href="https://developer-docs.amazon.com/sp-api/docs/self-authorization"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-cyan hover:text-cyan/80 transition-colors"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          Documentação oficial: Self-Authorization
        </a>
      </div>

      {/* Atalho self-auth */}
      <Link
        to="/sp-api-self-auth"
        className="flex items-center justify-between px-4 py-3 bg-surface-1 border border-cyan/20 rounded-xl hover:bg-surface-2 transition-colors group"
      >
        <div className="flex items-center gap-3">
          <KeyRound className="w-4 h-4 text-cyan" />
          <div>
            <p className="text-sm font-semibold text-white">Gerar token via Self-Authorization</p>
            <p className="text-xs text-slate-400">Cola o token do Seller Central e valida aqui sem OAuth público</p>
          </div>
        </div>
        <ExternalLink className="w-4 h-4 text-slate-500 group-hover:text-cyan transition-colors" />
      </Link>

      {/* Referência rápida SP-API */}
      <div className="bg-surface-1 border border-surface-2 rounded-2xl p-5 space-y-3">
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-cyan" />
          <p className="text-sm font-semibold text-white">APIs SP-API disponíveis</p>
          <a
            href="https://developer-docs.amazon.com/sp-api/docs"
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto flex items-center gap-1 text-xs text-slate-500 hover:text-cyan transition-colors"
          >
            <ExternalLink className="w-3 h-3" /> Docs oficiais
          </a>
        </div>
        <p className="text-xs text-slate-500">APIs usadas ou disponíveis nesta integração. Clique para ver a especificação.</p>
        <div className="grid grid-cols-1 gap-1">
          {[
            { name: 'Catalog Items',        version: 'v2022-04-01', path: 'catalog-items-api-v2022-04-01-reference', used: true,  desc: 'Títulos, imagens, categorias e atributos de produtos' },
            { name: 'FBA Inventory',        version: 'v1',          path: 'fba-inventory-api-v1-reference',          used: true,  desc: 'Estoque FBA, reservas e inventário inbound' },
            { name: 'Orders',               version: 'v0',          path: 'orders-api-v0-reference',                 used: true,  desc: 'Pedidos, status e detalhes de compra' },
            { name: 'Reports',              version: 'v2021-06-30', path: 'reports-api-v2021-06-30-reference',       used: true,  desc: 'Relatórios assíncronos de vendas, inventário e anúncios' },
            { name: 'Product Fees',         version: 'v0',          path: 'product-fees-api-v0-reference',           used: false, desc: 'Estimativa de taxas FBA por produto' },
            { name: 'Product Pricing',      version: 'v2022-05-01', path: 'product-price-api-v2022-05-01-reference', used: false, desc: 'Buy Box, preços competitivos e ofertas' },
            { name: 'Finances',             version: 'v0',          path: 'finances-api-v0-reference',               used: false, desc: 'Eventos financeiros, reembolsos e pagamentos' },
            { name: 'Listings Items',       version: 'v2021-08-01', path: 'listings-items-api-v2021-08-01-reference',used: false, desc: 'Criar e atualizar listings de produtos' },
            { name: 'Notifications',        version: 'v1',          path: 'notifications-api-v1-reference',          used: false, desc: 'Webhooks para eventos de estoque, pedidos e preços' },
            { name: 'Sales',                version: 'v1',          path: 'sales-api-v1-reference',                  used: true,  desc: 'Métricas de vendas agregadas por período' },
          ].map(api => (
            <a
              key={api.name}
              href={`https://developer-docs.amazon.com/sp-api/docs/${api.path}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 px-3 py-2 rounded-lg bg-surface-2 hover:bg-surface-3 transition-colors group"
            >
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${api.used ? 'bg-emerald-400' : 'bg-slate-600'}`} />
              <span className="text-xs font-semibold text-slate-200 min-w-[130px]">{api.name}</span>
              <span className="text-xs font-mono text-slate-500">{api.version}</span>
              <span className="text-xs text-slate-500 flex-1 truncate hidden sm:block">{api.desc}</span>
              {api.used && <span className="text-xs text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 px-1.5 py-0.5 rounded-full flex-shrink-0">em uso</span>}
              <ExternalLink className="w-3 h-3 text-slate-600 group-hover:text-cyan transition-colors flex-shrink-0" />
            </a>
          ))}
        </div>
        <p className="text-xs text-slate-600">● verde = integrado na plataforma · ● cinza = disponível para implementação futura</p>
      </div>

      {/* Nota separação SP-API vs Ads */}
      <div className="flex items-start gap-3 px-4 py-3 bg-surface-1 border border-amber-500/20 rounded-xl">
        <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-slate-400">
          <strong className="text-amber-300">SP-API ≠ Amazon Ads.</strong>{' '}
          O token <code className="text-slate-300 font-mono">AMAZON_SP_REFRESH_TOKEN</code> serve para catálogo, inventário e pedidos.
          Para anúncios, as credenciais <code className="text-slate-300 font-mono">ADS_*</code> são separadas e geridas na página de Configurações.
        </p>
      </div>
    </div>
  );
}