import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Key, ExternalLink, CheckCircle, Loader2, Copy, AlertCircle } from 'lucide-react';

const SP_CLIENT_ID = 'amzn1.application-oa2-client.a911098372f94b8a8ae0f5f5df3a18c2';
const REDIRECT_URI = window.location.origin + '/sp-api-setup';

export default function SpApiSetup() {
  const [step, setStep] = useState('start'); // start | callback | done | error
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  // Detecta se voltou do OAuth com código na URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const spCode = params.get('spapi_oauth_code');
    const authCode = params.get('code');
    const c = spCode || authCode;
    if (c) {
      setCode(c);
      setStep('callback');
      // Limpa URL sem recarregar
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const authorizeUrl =
    `https://sellercentral.amazon.com.br/apps/authorize/consent` +
    `?application_id=${SP_CLIENT_ID}` +
    `&state=livingfinds` +
    `&version=beta`;

  const exchangeCode = async () => {
    if (!code.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await base44.functions.invoke('spApiOAuthCallback', {
        code: code.trim(),
        redirect_uri: REDIRECT_URI,
      });
      const d = res.data;
      if (d?.ok) {
        setResult(d);
        setStep('done');
      } else {
        setError(d?.error || 'Erro ao trocar código');
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const copy = (text) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="min-h-screen bg-canvas flex items-center justify-center p-6">
      <div className="w-full max-w-lg space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="w-12 h-12 rounded-2xl bg-cyan/15 border border-cyan/20 flex items-center justify-center mx-auto">
            <Key className="w-6 h-6 text-cyan" />
          </div>
          <h1 className="text-xl font-bold text-white">Configurar SP-API</h1>
          <p className="text-sm text-slate-400">Autorize o acesso ao Seller Central para buscar nomes de produtos</p>
        </div>

        {/* Steps */}
        <div className="bg-surface-1 border border-surface-2 rounded-2xl p-6 space-y-6">

          {/* STEP 1 — Autorizar */}
          {(step === 'start') && (
            <div className="space-y-4">
              <div className="space-y-2">
                <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-cyan text-white text-xs flex items-center justify-center font-bold">1</span>
                  Autorizar no Seller Central
                </h2>
                <p className="text-xs text-slate-400 ml-7">
                  Clica no botão abaixo para abrir o Seller Central e autorizar o acesso. Após autorizar, serás redirecionado de volta automaticamente.
                </p>
              </div>
              <a
                href={authorizeUrl}
                target="_self"
                className="flex items-center justify-center gap-2 w-full px-5 py-3 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-xl transition-colors"
              >
                <ExternalLink className="w-4 h-4" />
                Autorizar no Seller Central
              </a>
              <div className="border-t border-surface-2 pt-4 space-y-2">
                <p className="text-xs text-slate-500">Ou cole o código manualmente:</p>
                <div className="flex gap-2">
                  <input
                    value={code}
                    onChange={e => setCode(e.target.value)}
                    placeholder="spapi_oauth_code=..."
                    className="flex-1 px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan/50"
                  />
                  <button
                    onClick={() => setStep('callback')}
                    disabled={!code.trim()}
                    className="px-4 py-2 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-sm rounded-lg transition-colors disabled:opacity-40"
                  >
                    Usar
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* STEP 2 — Trocar código */}
          {step === 'callback' && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 px-3 py-2 bg-emerald-400/10 border border-emerald-400/20 rounded-lg">
                <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                <p className="text-xs text-emerald-300">Código de autorização recebido!</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-slate-500 font-semibold">Código recebido:</p>
                <p className="text-xs font-mono text-slate-300 bg-surface-2 px-3 py-2 rounded-lg break-all">{code}</p>
              </div>
              {error && (
                <div className="flex items-start gap-2 px-3 py-2 bg-red-400/10 border border-red-400/20 rounded-lg">
                  <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-red-400">{error}</p>
                </div>
              )}
              <button
                onClick={exchangeCode}
                disabled={loading}
                className="flex items-center justify-center gap-2 w-full px-5 py-3 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-xl transition-colors disabled:opacity-60"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Key className="w-4 h-4" />}
                {loading ? 'A obter refresh token...' : 'Trocar código por Refresh Token'}
              </button>
            </div>
          )}

          {/* STEP 3 — Sucesso */}
          {step === 'done' && result && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <CheckCircle className="w-8 h-8 text-emerald-400 flex-shrink-0" />
                <div>
                  <p className="text-sm font-bold text-white">Refresh Token obtido!</p>
                  <p className="text-xs text-slate-400">Copia e configura como secret SP_REFRESH_TOKEN</p>
                </div>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-slate-500 font-semibold">SP_REFRESH_TOKEN:</p>
                <div className="flex items-start gap-2">
                  <p className="flex-1 text-xs font-mono text-emerald-300 bg-surface-2 px-3 py-2 rounded-lg break-all border border-emerald-400/20">
                    {result.refresh_token}
                  </p>
                  <button
                    onClick={() => copy(result.refresh_token)}
                    className="flex-shrink-0 p-2 bg-surface-2 border border-surface-3 rounded-lg text-slate-400 hover:text-white transition-colors"
                    title="Copiar"
                  >
                    {copied ? <CheckCircle className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <div className="px-4 py-3 bg-amber-500/10 border border-amber-500/20 rounded-xl text-xs text-amber-300 space-y-1">
                <p className="font-semibold">Próximos passos:</p>
                <ol className="list-decimal list-inside space-y-0.5 text-amber-400/80">
                  <li>Copia o token acima</li>
                  <li>Vai a Settings → Environment Variables no dashboard</li>
                  <li>Atualiza o secret <span className="font-mono">SP_REFRESH_TOKEN</span></li>
                  <li>Vai a Produtos e clica "Sincronizar Nomes"</li>
                </ol>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}