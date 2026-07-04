import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import {
  KeyRound, CheckCircle, XCircle, Loader2, AlertCircle,
  ExternalLink, ChevronRight, Copy, Check, ShieldCheck, Activity
} from 'lucide-react';

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
      className="inline-flex items-center gap-1 px-2 py-1 bg-surface-3 rounded text-xs text-slate-400 hover:text-white transition-colors"
    >
      {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
      {copied ? 'Copiado' : 'Copiar'}
    </button>
  );
}

const STEPS = [
  {
    n: 1,
    title: 'Aceder ao Seller Central',
    desc: 'Entre com o utilizador principal (conta de vendedor, não conta de desenvolvimento).',
    action: (
      <a
        href="https://sellercentral.amazon.com.br"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-xs text-cyan hover:text-cyan/80"
      >
        <ExternalLink className="w-3.5 h-3.5" /> Abrir Seller Central Brasil
      </a>
    ),
  },
  {
    n: 2,
    title: 'Ir a Apps e Serviços',
    desc: 'No menu superior clica em "Apps e serviços" → "Desenvolver aplicações".',
  },
  {
    n: 3,
    title: 'Localizar a aplicação',
    desc: 'Procura pela aplicação com o seguinte App ID:',
    code: 'amzn1.sp.solution.7c15f6b8-cfdd-4530-a25a-4c90edafe425',
  },
  {
    n: 4,
    title: 'Clicar em Autorizar',
    desc: 'Clica na seta (▾) ao lado do botão "Alterar/Edit" e selecciona "Autorizar".',
  },
  {
    n: 5,
    title: 'Confirmar autorização',
    desc: 'Na página que abre, clica em "Autorizar aplicativo". A Amazon gera imediatamente um refresh token.',
  },
  {
    n: 6,
    title: 'Copiar o token gerado',
    desc: 'O token começa com "Atzr|". Copia-o na íntegra e cola no campo abaixo.',
  },
];

export default function SpApiSelfAuth() {
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const [spStatus, setSpStatus] = useState(null);
  const [checkingStatus, setCheckingStatus] = useState(false);

  const checkCurrentStatus = async () => {
    setCheckingStatus(true);
    setSpStatus(null);
    try {
      const res = await base44.functions.invoke('testSpApiAuth', {});
      setSpStatus(res.data);
    } catch (e) {
      setSpStatus({ error: e.message });
    } finally {
      setCheckingStatus(false);
    }
  };

  const validate = async () => {
    const t = token.trim();
    if (!t) return;
    setSaving(true);
    setResult(null);
    try {
      const res = await base44.functions.invoke('saveSpRefreshToken', { refresh_token: t });
      setResult(res.data);
    } catch (e) {
      const d = e?.response?.data;
      setResult({ ok: false, error: d?.error || e.message });
    } finally {
      setSaving(false);
    }
  };

  const tokenOk = result?.ok && result?.token_valid;

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
          <KeyRound className="w-5 h-5 text-cyan" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-white">Self-Authorization SP-API</h1>
          <p className="text-xs text-slate-400">Gera o refresh token manualmente sem publicar a aplicação</p>
        </div>
      </div>

      {/* Verificar status atual */}
      <div className="bg-surface-1 border border-surface-2 rounded-2xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-cyan" />
            <p className="text-sm font-semibold text-white">Status atual da SP-API</p>
          </div>
          <button
            onClick={checkCurrentStatus}
            disabled={checkingStatus}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-cyan/15 border border-cyan/30 text-cyan hover:bg-cyan/25 rounded-lg transition-colors disabled:opacity-60"
          >
            {checkingStatus ? <Loader2 className="w-3 h-3 animate-spin" /> : <Activity className="w-3 h-3" />}
            {checkingStatus ? 'A verificar...' : 'Verificar agora'}
          </button>
        </div>

        {!spStatus && !checkingStatus && (
          <p className="text-xs text-slate-500">Clica em "Verificar agora" para testar se a SP-API já está a funcionar antes de gerar um novo token.</p>
        )}

        {spStatus && (
          <>
            {spStatus.error && <p className="text-xs text-red-400">{spStatus.error}</p>}
            {spStatus.tests && (
              <div className="space-y-1.5">
                {Object.entries(spStatus.tests).map(([key, t]) => {
                  const labels = { lwa_authentication: 'Autenticação LWA', sp_api_authorization: 'Autorização SP-API', marketplace_configuration: 'Marketplace', endpoint_access: 'Acesso ao Catálogo' };
                  return (
                    <div key={key} className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs ${t.status === 'PASSED' ? 'bg-emerald-400/5 border border-emerald-400/20 text-emerald-300' : t.status === 'FAILED' ? 'bg-red-400/5 border border-red-400/20 text-red-400' : 'bg-surface-2 border border-surface-3 text-slate-500'}`}>
                      {t.status === 'PASSED' ? <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" /> : t.status === 'FAILED' ? <XCircle className="w-3.5 h-3.5 flex-shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />}
                      <span className="font-semibold">{labels[key] || key}:</span>
                      <span>{t.message}</span>
                    </div>
                  );
                })}
              </div>
            )}
            {spStatus.tests && Object.values(spStatus.tests).every(t => t.status === 'PASSED') && (
              <div className="flex items-start gap-2 px-3 py-2.5 bg-emerald-400/10 border border-emerald-400/20 rounded-lg">
                <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-emerald-300"><strong>SP-API já está a funcionar!</strong> Não precisas de gerar um novo token. Se recebeste um erro "unauthorized_client" ao validar um token aqui, significa que esse token foi gerado com credenciais diferentes — mas as credenciais actuais estão correctas.</p>
              </div>
            )}
          </>
        )}
      </div>

      {/* Contexto */}
      <div className="flex items-start gap-3 px-4 py-3 bg-amber-500/10 border border-amber-500/20 rounded-xl">
        <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-amber-200">
          A aplicação está em modo <strong>Draft/Privado</strong> — o fluxo OAuth público causa MD1000.
          O suporte da Amazon confirmou que deves usar <strong>self-authorization</strong> para gerar o token SP-API directamente no Seller Central.
        </p>
      </div>

      {/* Passos */}
      <div className="bg-surface-1 border border-surface-2 rounded-2xl p-5 space-y-4">
        <p className="text-sm font-semibold text-white">Passos para gerar o token</p>
        <div className="space-y-3">
          {STEPS.map((step) => (
            <div key={step.n} className="flex items-start gap-3">
              <span className="w-6 h-6 rounded-full bg-cyan/15 border border-cyan/30 flex items-center justify-center text-xs font-bold text-cyan flex-shrink-0 mt-0.5">
                {step.n}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white">{step.title}</p>
                <p className="text-xs text-slate-400 mt-0.5">{step.desc}</p>
                {step.code && (
                  <div className="flex items-center gap-2 mt-1.5">
                    <code className="text-xs font-mono text-cyan bg-surface-2 border border-surface-3 px-2 py-1 rounded truncate flex-1">
                      {step.code}
                    </code>
                    <CopyButton text={step.code} />
                  </div>
                )}
                {step.action && <div className="mt-1.5">{step.action}</div>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Input do token */}
      <div className="bg-surface-1 border border-surface-2 rounded-2xl p-5 space-y-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-cyan" />
          <p className="text-sm font-semibold text-white">Colar e validar o token</p>
        </div>

        <div>
          <label className="block text-xs text-slate-400 mb-1.5">
            Refresh Token (começa com <code className="font-mono text-cyan">Atzr|</code>)
          </label>
          <textarea
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder="Atzr|..."
            rows={3}
            className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm font-mono text-white placeholder-slate-600 focus:outline-none focus:border-cyan/50 resize-none"
          />
          <p className="text-xs text-slate-500 mt-1">O token nunca é enviado para o frontend — é validado e armazenado apenas no backend.</p>
        </div>

        <button
          onClick={validate}
          disabled={saving || !token.trim()}
          className="flex items-center gap-2 px-5 py-2.5 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <ChevronRight className="w-4 h-4" />}
          {saving ? 'A validar...' : 'Validar e guardar token'}
        </button>

        {/* Resultado */}
        {result && (
          <div className={`p-4 rounded-xl border space-y-2 ${tokenOk ? 'bg-emerald-400/5 border-emerald-400/20' : 'bg-red-400/5 border-red-400/20'}`}>
            <div className="flex items-center gap-2">
              {tokenOk
                ? <CheckCircle className="w-5 h-5 text-emerald-400" />
                : <XCircle className="w-5 h-5 text-red-400" />}
              <p className={`text-sm font-semibold ${tokenOk ? 'text-emerald-300' : 'text-red-300'}`}>
                {tokenOk ? 'Token válido!' : 'Erro na validação'}
              </p>
            </div>
            <p className="text-xs text-slate-400">{result.message || result.error}</p>
            {result.amazon_error === 'unauthorized_client' && (
              <div className="mt-2 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg space-y-1.5">
                <p className="text-xs font-semibold text-amber-300">⚠️ Token de aplicação errada</p>
                <p className="text-xs text-amber-200">
                  Este erro acontece quando o token foi gerado por uma aplicação diferente.
                  Confirme que no Seller Central está a autorizar a aplicação com o App ID:
                </p>
                <code className="block text-xs font-mono text-cyan bg-surface-2 px-2 py-1 rounded break-all">
                  amzn1.sp.solution.7c15f6b8-cfdd-4530-a25a-4c90edafe425
                </code>
                <p className="text-xs text-amber-200">
                  <strong>Atenção:</strong> O token SP-API é diferente do token Amazon Ads. Não use um token Ads aqui.
                </p>
              </div>
            )}
            {result.seller_id && (
              <p className="text-xs text-slate-300">Seller ID confirmado: <code className="font-mono text-cyan">{result.seller_id}</code></p>
            )}
            {result.token_preview && (
              <p className="text-xs text-slate-500">Token (mascarado): <code className="font-mono">{result.token_preview}</code></p>
            )}
            {tokenOk && (
              <div className="mt-3 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
                <p className="text-xs text-amber-300 font-semibold mb-1">⚡ Próximo passo obrigatório</p>
                <p className="text-xs text-amber-200">{result.next_step}</p>
                <p className="text-xs text-amber-200 mt-1">
                  Secret a actualizar: <code className="font-mono text-amber-300">AMAZON_SP_REFRESH_TOKEN</code>
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Nota separação */}
      <div className="flex items-start gap-3 px-4 py-3 bg-surface-1 border border-surface-2 rounded-xl">
        <AlertCircle className="w-4 h-4 text-slate-500 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-slate-500">
          <strong className="text-slate-300">SP-API ≠ Amazon Ads.</strong>{' '}
          Este token serve para catálogo, inventário e pedidos.
          Para anúncios (<code className="font-mono">ADS_REFRESH_TOKEN</code>), as credenciais são separadas e configuradas em Definições → Credenciais Amazon.
        </p>
      </div>
    </div>
  );
}