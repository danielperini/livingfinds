import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { appParams } from '@/lib/app-params';
import { CheckCircle, XCircle, Loader2, Zap } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function AmazonAdsCallback() {
  const [status, setStatus] = useState('loading');
  const [message, setMessage] = useState('');
  const [details, setDetails] = useState(null);
  const [rawError, setRawError] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const error = params.get('error');
    const errorDescription = params.get('error_description');

    // Debug: mostrar URL completo recebido
    console.log('[AmazonCallback] URL completo:', window.location.href);
    console.log('[AmazonCallback] Params:', Object.fromEntries(params.entries()));

    if (error) {
      setStatus('error');
      setMessage(`Erro na autorização Amazon Ads: ${errorDescription || error}`);
      setRawError({ full_url: window.location.href, all_params: Object.fromEntries(params.entries()) });
      return;
    }

    if (!code) {
      setStatus('error');
      setMessage('Parâmetro "code" não encontrado na URL. Tente novamente o fluxo OAuth.');
      setRawError({ full_url: window.location.href, all_params: Object.fromEntries(params.entries()) });
      return;
    }

    (async () => {
      // Recuperar code pendente do sessionStorage (se veio do redirect pós-login)
      const pendingCode = sessionStorage.getItem('amazon_ads_pending_code');
      const finalCode = code || pendingCode;
      if (pendingCode) sessionStorage.removeItem('amazon_ads_pending_code');

      try {
        // APP_ID fixo — confirmado via base44.getConfig() e não depende de localStorage
        const APP_ID = '6a40180bd8d170a6c59c8098';
        const BASE_URL = 'https://base44.app';
        const fnRes = await fetch(`${BASE_URL}/api/apps/${APP_ID}/functions/exchangeAmazonAdsCode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: finalCode }),
        });
        const data = await fnRes.json();

        if (!data?.ok) {
          setStatus('error');
          setMessage(data?.error_description || data?.error || 'Falha ao processar autorização.');
          setRawError(data);
          return;
        }

        setStatus('success');
        setMessage(data.message || 'Amazon Ads conectada com sucesso.');
        setDetails(data);
        // Redireciona para a página de setup após 3 segundos para confirmar o token
        setTimeout(() => {
          window.location.href = '/amazon-oauth-setup';
        }, 3000);
      } catch (e) {
        setStatus('error');
        setMessage(e.message || 'Erro ao conectar com a Amazon Ads.');
        setRawError({ message: e.message });
      }
    })();
  }, []);

  return (
    <div className="min-h-screen bg-[#0A0B0F] flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        {/* Logo */}
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
              <p className="text-sm text-slate-400">Aguarde enquanto conectamos sua conta Amazon Ads.</p>
            </>
          )}

          {status === 'success' && (
            <>
              <CheckCircle className="w-12 h-12 text-emerald-400 mx-auto mb-4" />
              <h1 className="text-lg font-semibold text-white mb-2">Amazon Ads conectada com sucesso.</h1>
              <p className="text-sm text-slate-400 mb-6">{message}</p>

              {details && (
                <div className="text-left bg-[#0A0B0F] border border-[#1A1D26] rounded-xl p-4 mb-6 space-y-3">
                  {details.refresh_token_preview && (
                    <div>
                      <p className="text-xs text-slate-500 mb-0.5">Refresh Token (mascarado)</p>
                      <p className="text-xs font-mono text-slate-300">{details.refresh_token_preview}</p>
                    </div>
                  )}
                  {details.profiles_count > 0 && (
                    <div>
                      <p className="text-xs text-slate-500 mb-1">{details.profiles_count} profile(s) encontrado(s)</p>
                      <div className="space-y-1">
                        {details.profiles?.map((p, i) => (
                          <div key={i} className="flex items-center justify-between text-xs">
                            <span className="text-slate-300">{p.name || `Profile ${i + 1}`}</span>
                            <span className="text-slate-500">{p.marketplace} · {p.type}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {details.account_updated && (
                    <p className="text-xs text-emerald-400">✓ Token salvo na conta Amazon</p>
                  )}
                </div>
              )}

              <Link
                to="/diagnostico"
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-cyan/10 border border-cyan/30 text-cyan rounded-lg text-sm font-medium hover:bg-cyan/20 transition-colors"
              >
                Ir para Diagnóstico
              </Link>
            </>
          )}

          {status === 'error' && (
            <>
              <XCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
              <h1 className="text-lg font-semibold text-white mb-2">Erro na autorização Amazon Ads</h1>
              <p className="text-sm text-red-300 mb-4 break-words">{message}</p>

              {rawError && (
                <div className="text-left bg-[#0A0B0F] border border-red-500/20 rounded-xl p-3 mb-6">
                  <p className="text-xs text-slate-500 mb-1">Detalhe do erro:</p>
                  {rawError.amazon_status && <p className="text-xs text-slate-400">HTTP {rawError.amazon_status}</p>}
                  {rawError.error && <p className="text-xs text-slate-400">error: {rawError.error}</p>}
                  {rawError.error_description && <p className="text-xs text-slate-400">description: {rawError.error_description}</p>}
                  {rawError.message && <p className="text-xs text-slate-400">message: {rawError.message}</p>}
                  {rawError.full_url && <p className="text-xs text-slate-400 break-all mt-1">url: {rawError.full_url}</p>}
                  {rawError.all_params && <p className="text-xs text-slate-400 font-mono mt-1">{JSON.stringify(rawError.all_params)}</p>}
                </div>
              )}

              <p className="text-xs text-slate-500 mb-4">
                O código OAuth da Amazon expira em segundos. Inicie o fluxo novamente na página de Diagnóstico.
              </p>

              <Link
                to="/diagnostico"
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-surface-2 border border-surface-3 text-slate-300 rounded-lg text-sm font-medium hover:text-white transition-colors"
              >
                Voltar ao Diagnóstico
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}