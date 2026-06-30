import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Link2, CheckCircle, XCircle, Loader2, Copy, Check,
  ExternalLink, AlertCircle, ShieldCheck, RefreshCw
} from 'lucide-react';

const SP_APP_ID = 'amzn1.sp.solution.cc1bd118-49e3-438e-8cf1-42169eb3f443';
const BASE_URL = 'https://livingfinds-app.base44.app';
const LOGIN_URI = `${BASE_URL}/integracoes/amazon`;
const REDIRECT_URI = `${BASE_URL}/api/auth/amazon/callback`;

function buildAuthorizeUrl(state) {
  return (
    `https://sellercentral.amazon.com.br/apps/authorize/consent` +
    `?application_id=${SP_APP_ID}` +
    `&state=${encodeURIComponent(state)}` +
    `&version=beta`
  );
}

function CopyField({ label, value }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="space-y-1">
      <p className="text-xs text-slate-500 font-semibold uppercase tracking-wider">{label}</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 text-xs text-cyan bg-surface-2 border border-surface-3 px-3 py-2 rounded-lg break-all font-mono">
          {value}
        </code>
        <button
          onClick={copy}
          className="flex-shrink-0 p-2 bg-surface-2 border border-surface-3 rounded-lg text-slate-400 hover:text-white transition-colors"
          title="Copiar"
        >
          {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}

export default function AmazonIntegracao() {
  const [account, setAccount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [statusMsg, setStatusMsg] = useState(null);
  // Detectar retorno do OAuth
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('status');
    const msg = params.get('msg');
    const seller = params.get('seller');

    if (status === 'success') {
      setStatusMsg({ type: 'success', text: `✅ Amazon conectada com sucesso!${seller ? ` Seller ID: ${seller}` : ''}` });
      window.history.replaceState({}, '', window.location.pathname);
    } else if (status === 'error') {
      setStatusMsg({ type: 'error', text: `❌ Erro: ${msg || 'Falha na autorização'}` });
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  // Carregar conta
  useEffect(() => {
    (async () => {
      try {
        const me = await base44.auth.me();
        const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
        setAccount(accounts[0] || null);
      } catch {
        setAccount(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [statusMsg]);

  const startOAuth = () => {
    setConnecting(true);
    const state = `livingfinds_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    sessionStorage.setItem('sp_oauth_state', state);
    window.location.href = buildAuthorizeUrl(state);
  };

  const isConnected = account?.status === 'connected';

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/20 flex items-center justify-center">
          <Link2 className="w-5 h-5 text-amber-400" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-white">Integração Amazon SP-API</h1>
          <p className="text-xs text-slate-400">Conecta o teu Seller Central para sincronização de dados</p>
        </div>
      </div>

      {/* Status message */}
      {statusMsg && (
        <div className={`flex items-start gap-3 px-4 py-3 rounded-xl border text-sm font-medium ${
          statusMsg.type === 'success'
            ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300'
            : 'bg-red-400/10 border-red-400/20 text-red-400'
        }`}>
          {statusMsg.type === 'success'
            ? <CheckCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
            : <XCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />}
          {statusMsg.text}
        </div>
      )}

      {/* Estado da ligação */}
      <div className="bg-surface-1 border border-surface-2 rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-white">Estado da Ligação</p>
          {loading ? (
            <Loader2 className="w-4 h-4 text-slate-500 animate-spin" />
          ) : isConnected ? (
            <span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 px-2.5 py-1 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Conectado
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-xs font-semibold text-amber-400 bg-amber-400/10 border border-amber-400/20 px-2.5 py-1 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" /> Não conectado
            </span>
          )}
        </div>

        {account && (
          <div className="grid grid-cols-2 gap-3 text-xs">
            {account.seller_name && (
              <div>
                <p className="text-slate-500 mb-0.5">Seller Name</p>
                <p className="text-slate-200 font-medium">{account.seller_name}</p>
              </div>
            )}
            {account.seller_id && (
              <div>
                <p className="text-slate-500 mb-0.5">Seller ID</p>
                <p className="text-slate-200 font-mono">{account.seller_id}</p>
              </div>
            )}
            {account.marketplace_id && (
              <div>
                <p className="text-slate-500 mb-0.5">Marketplace</p>
                <p className="text-slate-200 font-mono">{account.marketplace_id}</p>
              </div>
            )}
            {account.last_sync_at && (
              <div>
                <p className="text-slate-500 mb-0.5">Última sincronização</p>
                <p className="text-slate-200">{new Date(account.last_sync_at).toLocaleString('pt-BR')}</p>
              </div>
            )}
          </div>
        )}

        <button
          onClick={startOAuth}
          disabled={connecting || loading}
          className={`flex items-center justify-center gap-2 w-full px-5 py-3 text-sm font-semibold rounded-xl transition-colors disabled:opacity-60 ${
            isConnected
              ? 'bg-surface-2 border border-surface-3 text-slate-300 hover:text-white'
              : 'bg-amber-500 hover:bg-amber-400 text-white'
          }`}
        >
          {connecting ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> A redirecionar para o Seller Central...</>
          ) : isConnected ? (
            <><RefreshCw className="w-4 h-4" /> Reconectar Amazon</>
          ) : (
            <><Link2 className="w-4 h-4" /> Conectar Amazon</>
          )}
        </button>
      </div>

      {/* URLs para cadastrar */}
      <div className="bg-surface-1 border border-surface-2 rounded-2xl p-5 space-y-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-cyan" />
          <p className="text-sm font-semibold text-white">URLs para cadastrar na Amazon</p>
        </div>
        <p className="text-xs text-slate-500">
          Regista estas URLs nas credenciais LWA do teu app no Seller Central Developer Central.
        </p>

        <CopyField label="SP App ID (Solution ID)" value={SP_APP_ID} />
        <CopyField label="Login URI" value={LOGIN_URI} />
        <CopyField label="OAuth Redirect URI" value={REDIRECT_URI} />

        <a
          href="https://sellercentral.amazon.com.br/apps/manage"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-xs text-cyan hover:text-cyan/80 transition-colors"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          Abrir Seller Central → Apps &amp; Services
        </a>
      </div>

      {/* Aviso de segurança */}
      <div className="flex items-start gap-3 px-4 py-3 bg-surface-1 border border-surface-2 rounded-xl">
        <AlertCircle className="w-4 h-4 text-slate-500 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-slate-500">
          O refresh token é armazenado de forma segura apenas no backend e nunca exposto ao navegador.
          O fluxo valida o parâmetro <code className="text-slate-400 font-mono">state</code> para prevenir ataques CSRF e replay.
        </p>
      </div>
    </div>
  );
}