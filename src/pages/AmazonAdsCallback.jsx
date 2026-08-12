import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { CheckCircle, XCircle, Loader2, Zap } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function AmazonAdsCallback() {
  const [status, setStatus] = useState('loading');
  const [message, setMessage] = useState('');
  const [details, setDetails] = useState(null);
  const [safeError, setSafeError] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const error = params.get('error');
    const errorDescription = params.get('error_description');

    if (error) {
      setStatus('error');
      setMessage(`Erro na autorização Amazon Ads: ${errorDescription || error}`);
      setSafeError({ error, error_description: errorDescription || null });
      return;
    }

    if (!code) {
      setStatus('error');
      setMessage('Parâmetro "code" não encontrado. Inicie novamente o fluxo OAuth.');
      setSafeError({ error: 'missing_authorization_code' });
      return;
    }

    (async () => {
      try {
        // O authorization code fica somente em memória durante a troca e nunca é logado.
        const res = await base44.functions.invoke('exchangeAmazonAdsCode', { code });
        const data = res?.data ?? res;
        if (!data?.ok) {
          setStatus('error');
          setMessage(data?.error_description || data?.message || data?.error || 'Falha ao processar autorização.');
          setSafeError({
            error: data?.error || null,
            amazon_error_code: data?.amazon_error_code || null,
            amazon_status: data?.amazon_status || null,
            token_persisted: data?.token_persisted,
          });
          return;
        }

        setStatus('success');
        setMessage(data.message || 'Amazon Ads conectada com sucesso.');
        setDetails({
          profiles_count: data.profiles_count || 0,
          profile: data.profile || null,
          account_updated: data.account_updated === true,
          environment_update_required: data.environment_update_required === true,
          environment_warning: data.environment_warning || null,
        });
        setTimeout(() => {
          window.location.href = '/amazon-oauth-setup?reconnected=1';
        }, 3000);
      } catch (e) {
        setStatus('error');
        setMessage(e?.message || 'Erro ao conectar com a Amazon Ads.');
        setSafeError({ error: 'callback_exchange_failed' });
      }
    })();
  }, []);

  return (
    <div className="min-h-screen bg-[#0A0B0F] flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="flex items-center justify-center gap-2 mb-8">
          <div className="w-8 h-8 rounded-lg bg-cyan flex items-center justify-center">
            <Zap className="w-4 h-4 text-white" />
          </div>
          <span className="font-bold text-white text-lg">LivingFinds</span>
        </div>

        <div className="bg-[#111318] border border-[#1A1D26] rounded-2xl p-8 text-center">
          {status === 'loading' && (
            <>
              <Loader2 className="w-12 h-12 text-cyan animate-spin mx-auto mb-4" />
              <h1 className="text-lg font-semibold text-white mb-2">Processando autorização...</h1>
              <p className="text-sm text-slate-400">Validando token e profile Amazon Ads.</p>
            </>
          )}

          {status === 'success' && (
            <>
              <CheckCircle className="w-12 h-12 text-emerald-400 mx-auto mb-4" />
              <h1 className="text-lg font-semibold text-white mb-2">Amazon Ads conectada com sucesso.</h1>
              <p className="text-sm text-slate-400 mb-6">{message}</p>
              {details && (
                <div className="text-left bg-[#0A0B0F] border border-[#1A1D26] rounded-xl p-4 mb-6 space-y-2">
                  <p className="text-xs text-slate-400">Profiles encontrados: <span className="text-slate-200">{details.profiles_count}</span></p>
                  {details.profile?.profileId && <p className="text-xs text-slate-400">Profile validado: <span className="text-slate-200 font-mono">{details.profile.profileId}</span></p>}
                  {details.account_updated && <p className="text-xs text-emerald-400">✓ Token salvo no banco após validação real</p>}
                  {details.environment_update_required && (
                    <p className="text-xs text-amber-300">⚠ {details.environment_warning || 'Atualize ADS_REFRESH_TOKEN no ambiente da VPS.'}</p>
                  )}
                </div>
              )}
              <Link to="/amazon-oauth-setup" className="inline-flex items-center gap-2 px-5 py-2.5 bg-cyan/10 border border-cyan/30 text-cyan rounded-lg text-sm font-medium hover:bg-cyan/20 transition-colors">
                Verificar estado da conexão
              </Link>
            </>
          )}

          {status === 'error' && (
            <>
              <XCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
              <h1 className="text-lg font-semibold text-white mb-2">Erro na autorização Amazon Ads</h1>
              <p className="text-sm text-red-300 mb-4 break-words">{message}</p>
              {safeError && (
                <div className="text-left bg-[#0A0B0F] border border-red-500/20 rounded-xl p-3 mb-6">
                  {safeError.amazon_status && <p className="text-xs text-slate-400">HTTP {safeError.amazon_status}</p>}
                  {safeError.error && <p className="text-xs text-slate-400">erro: {safeError.error}</p>}
                  {safeError.amazon_error_code && <p className="text-xs text-slate-400">Amazon: {safeError.amazon_error_code}</p>}
                  {safeError.token_persisted === false && <p className="text-xs text-emerald-400 mt-1">O token anterior foi preservado.</p>}
                </div>
              )}
              <p className="text-xs text-amber-400/80 mb-4 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                O código OAuth é de uso único. Inicie um novo fluxo para tentar novamente.
              </p>
              <Link to="/amazon-oauth-setup" className="inline-flex items-center gap-2 px-5 py-2.5 bg-cyan/10 border border-cyan/30 text-cyan rounded-lg text-sm font-medium hover:bg-cyan/20 transition-colors">
                Tentar novamente →
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
