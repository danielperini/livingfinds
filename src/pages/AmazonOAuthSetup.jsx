import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import {
  CheckCircle, XCircle, Loader2, ExternalLink, RefreshCw,
  ShieldCheck, ShieldAlert, Zap, Copy, Database, Key,
  Save, Eye, EyeOff, ArrowLeft, Megaphone, CircleDot,
  AlertTriangle, ChevronRight, Plug, Clock, RotateCcw, Server
} from 'lucide-react';
import { Link } from 'react-router-dom';

function Step({ n, label, status }) {
  return (
    <div className="flex items-center gap-2">
      <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border flex-shrink-0 transition-colors ${
        status === 'done'   ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400' :
        status === 'active' ? 'bg-cyan/20 border-cyan/40 text-cyan' :
                              'bg-surface-3 border-surface-3 text-slate-600'
      }`}>
        {status === 'done' ? <CheckCircle className="w-3.5 h-3.5" /> : n}
      </div>
      <span className={`text-xs font-medium ${
        status === 'done' ? 'text-emerald-400' : status === 'active' ? 'text-white' : 'text-slate-600'
      }`}>{label}</span>
    </div>
  );
}

function ConfigPill({ label, value, ok }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-surface-2 rounded-lg">
      <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${ok ? 'bg-emerald-400' : 'bg-red-400'}`} />
      <span className="text-[10px] text-slate-500 w-20 flex-shrink-0">{label}</span>
      <span className="text-xs font-mono text-slate-300 truncate">{value || '—'}</span>
    </div>
  );
}

export default function AmazonOAuthSetup() {
  const [info, setInfo]             = useState(null);
  const [loading, setLoading]       = useState(true);
  const [copied, setCopied]         = useState(false);
  const [pasteToken, setPasteToken] = useState('');
  const [showToken, setShowToken]   = useState(false);
  const [saving, setSaving]         = useState(false);
  const [saveResult, setSaveResult] = useState(null);
  const [lastTokenError, setLastTokenError] = useState(null);
  const [account, setAccount]       = useState(null);
  const [testingFallback, setTestingFallback] = useState(false);
  const [fallbackResult, setFallbackResult]   = useState(null);


  const load = async () => {
    setLoading(true);
    try {
      const [oauthRes, me] = await Promise.all([
        base44.functions.invoke('getOAuthSetupInfo', {}),
        base44.auth.me().catch(() => null),
      ]);
      setInfo(oauthRes.data);

      // Buscar última falha de token no SyncExecutionLog
      if (me) {
        const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id }, null, 1).catch(() => []);
        const acc = accounts[0];
        if (acc) {
          setAccount(acc);
          const logs = await base44.entities.SyncExecutionLog.filter(
            { amazon_account_id: acc.id, status: 'error' }, '-started_at', 50
          ).catch(() => []);
          const tokenLog = logs.find(l =>
            (l.operation || '').toLowerCase().includes('token') ||
            (l.error_message || '').toLowerCase().includes('token') ||
            (l.error_message || '').toLowerCase().includes('401') ||
            (l.error_message || '').toLowerCase().includes('403')
          );
          setLastTokenError(tokenLog || null);
        }
      }
    } catch (e) {
      setInfo({ error: e.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);


  const saveToken = async () => {
    const token = pasteToken.trim();
    if (!token.startsWith('Atzr|')) {
      setSaveResult({ ok: false, error: 'Token deve começar com Atzr|' });
      return;
    }
    setSaving(true);
    setSaveResult(null);
    try {
      const res = await base44.functions.invoke('saveAdsRefreshToken', { refresh_token: token });
      setSaveResult(res.data);
      if (res.data?.ok) {
        setPasteToken('');
        setTimeout(() => load(), 1500);
      }
    } catch (e) {
      setSaveResult({ ok: false, error: e.message });
    } finally {
      setSaving(false);
    }
  };

  const testFallback = async () => {
    if (!account?.id) return;
    setTestingFallback(true);
    setFallbackResult(null);
    try {
      const res = await base44.functions.invoke('amazonAdsTokenManager', {
        amazon_account_id: account.id,
        force_refresh: true,
        _service_role: true,
      });
      setFallbackResult(res.data);
      if (res.data?.ok) setTimeout(() => load(), 1200);
    } catch (e) {
      setFallbackResult({ ok: false, message: e.message });
    } finally {
      setTestingFallback(false);
    }
  };

  const copyUrl = () => {
    if (info?.auth_url) {
      navigator.clipboard.writeText(info.auth_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  };

  const tokenOk      = info?.token_status === 'valid';
  const tokenInvalid = info?.token_status === 'invalid' || info?.token_status === 'not_configured';
  const hasProfiles  = info?.profiles?.length > 0;
  const clientIdOk   = !!info?.config?.client_id_preview;
  const profileIdOk  = !!info?.config?.profile_id;
  const needsReauth  = account?.ads_requires_reauth === true || account?.ads_token_status === 'revoked';
  const envTokenPresent = info?.config?.env_token_present === true;
  const lastRecovery    = info?.config?.last_recovery_source;
  const lastRecoveryAt  = info?.config?.last_recovery_at;

  const stepStatus = (n) => {
    if (tokenOk && hasProfiles) return 'done';
    if (n === 1) return clientIdOk ? 'done' : 'active';
    if (n === 2) return clientIdOk && !tokenOk ? 'active' : tokenOk ? 'done' : 'pending';
    if (n === 3) return tokenOk && !hasProfiles ? 'active' : hasProfiles ? 'done' : 'pending';
    return 'pending';
  };

  return (
    <div className="p-6 max-w-2xl space-y-6 animate-fade-in">

      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <Link to="/integracoes/amazon" className="hover:text-white transition-colors flex items-center gap-1">
          <ArrowLeft className="w-3 h-3" /> Integração Amazon
        </Link>
        <ChevronRight className="w-3 h-3" />
        <span className="text-slate-300">Amazon Ads OAuth</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-amber-500/15 border border-amber-500/25 flex items-center justify-center">
            <Megaphone className="w-6 h-6 text-amber-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Amazon Ads — OAuth</h1>
            <p className="text-sm text-slate-400 mt-0.5">Autorização da API de Campanhas (LWA)</p>
          </div>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-2 px-3 py-2 text-xs bg-surface-2 border border-surface-3 text-slate-300 hover:text-white rounded-lg transition-colors disabled:opacity-50 flex-shrink-0">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Verificar
        </button>
      </div>

      {loading && !info && (
        <div className="space-y-3">
          {[1,2,3].map(i => (
            <div key={i} className="h-16 bg-surface-1 border border-surface-2 rounded-xl animate-pulse" />
          ))}
        </div>
      )}

      {info?.error && (
        <div className="flex items-center gap-3 p-4 bg-red-500/10 border border-red-500/20 rounded-xl">
          <XCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
          <p className="text-sm text-red-400">{info.error}</p>
        </div>
      )}

      {/* ── BANNER REAUTH OBRIGATÓRIO (ambos os tokens falharam) ──────── */}
      {needsReauth && !loading && (
        <div className="rounded-2xl border-2 border-red-500/60 bg-red-500/10 p-5 space-y-3">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-red-500/20 flex items-center justify-center flex-shrink-0">
              <ShieldAlert className="w-5 h-5 text-red-400" />
            </div>
            <div className="flex-1">
              <p className="text-base font-bold text-red-300">Reconexão obrigatória</p>
              <p className="text-xs text-red-400/80 mt-0.5">
                O token do banco e o token do ambiente falharam com a Amazon.
                {account?.ads_last_lwa_error_code && (
                  <> Erro: <code className="font-mono bg-red-500/10 px-1 rounded">{account.ads_last_lwa_error_code}</code></>
                )}
              </p>
            </div>
          </div>
          <div className="bg-red-500/8 rounded-xl p-3 space-y-1.5 text-xs text-red-200">
            <p className="font-semibold">Como resolver:</p>
            <p><span className="text-red-400 font-bold">1.</span> Clique em "Reconectar agora →" abaixo</p>
            <p><span className="text-red-400 font-bold">2.</span> Aguarde o redirecionamento automático da Amazon para este app</p>
          </div>
          {info?.auth_url && (
            <a href={info.auth_url} target="_blank" rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 w-full px-5 py-3 bg-orange-500 hover:bg-orange-400 text-white text-sm font-bold rounded-xl transition-colors">
              <ExternalLink className="w-4 h-4" />
              Reconectar agora →
            </a>
          )}
        </div>
      )}

      {info && !info.error && (
        <>
          {/* ── STATUS BANNER ─────────────────────────────────────────── */}
          <div className={`rounded-2xl border p-5 ${
            tokenOk && hasProfiles  ? 'bg-emerald-500/8 border-emerald-500/25' :
            tokenOk                 ? 'bg-amber-500/8 border-amber-500/25' :
                                      'bg-red-500/8 border-red-500/25'
          }`}>
            <div className="flex items-center gap-3 mb-4">
              {tokenOk && hasProfiles
                ? <ShieldCheck className="w-6 h-6 text-emerald-400" />
                : tokenOk
                ? <AlertTriangle className="w-6 h-6 text-amber-400" />
                : <ShieldAlert className="w-6 h-6 text-red-400" />
              }
              <div className="flex-1">
                <p className={`text-base font-bold ${
                  tokenOk && hasProfiles ? 'text-emerald-300' : tokenOk ? 'text-amber-300' : 'text-red-300'
                }`}>
                  {tokenOk && hasProfiles
                    ? '✓ Conectado e operacional'
                    : tokenOk
                    ? '⚠ Token válido — nenhum profile encontrado'
                    : '✗ Token inválido ou expirado'
                  }
                </p>
                {!tokenOk && info.token_error && (
                  <p className="text-xs text-red-400/80 mt-0.5 font-mono">{info.token_error}</p>
                )}
                {tokenOk && hasProfiles && (
                  <p className="text-xs text-slate-400 mt-0.5">
                    {info.profiles.length} profile(s) · Profile ativo: {info.config?.profile_id}
                  </p>
                )}
              </div>
            </div>

            <div className="flex items-center gap-1 flex-wrap">
              <Step n={1} label="Credenciais"  status={stepStatus(1)} />
              <div className="flex-1 h-px bg-surface-3 min-w-[20px] max-w-[40px]" />
              <Step n={2} label="Autorização"  status={stepStatus(2)} />
              <div className="flex-1 h-px bg-surface-3 min-w-[20px] max-w-[40px]" />
              <Step n={3} label="Profiles"     status={stepStatus(3)} />
              <div className="flex-1 h-px bg-surface-3 min-w-[20px] max-w-[40px]" />
              <Step n={4} label="Operacional"  status={tokenOk && hasProfiles ? 'done' : 'pending'} />
            </div>
          </div>

          {/* ── CONFIG PILLS ──────────────────────────────────────────── */}
          <div className="bg-surface-1 border border-surface-2 rounded-xl p-4 space-y-2">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs font-semibold text-slate-400">Configuração atual</p>
              <div className="flex items-center gap-3 text-[10px]">
                <span className={`flex items-center gap-1 ${info.config?.has_entity_token ? 'text-emerald-400' : 'text-slate-600'}`}>
                  <Database className="w-3 h-3" />
                  Token DB: {info.config?.has_entity_token ? 'sim' : 'não'}
                </span>
                <span className={`flex items-center gap-1 ${info.config?.has_secret_token ? 'text-emerald-400' : 'text-slate-600'}`}>
                  <Key className="w-3 h-3" />
                  Token Env: {info.config?.has_secret_token ? 'sim' : 'não'}
                </span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <ConfigPill label="Client ID"    value={info.config?.client_id_preview}     ok={clientIdOk} />
              <ConfigPill label="Refresh Token" value={info.config?.refresh_token_preview} ok={tokenOk} />
              <ConfigPill label="Profile ID"   value={info.config?.profile_id}            ok={profileIdOk} />
              <ConfigPill label="Região"       value={info.config?.region}                ok={!!info.config?.region} />
            </div>
          </div>

          {/* ── DIAGNÓSTICO FALLBACK AUTOMÁTICO ───────────────────────── */}
          <div className="bg-surface-1 border border-surface-2 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <RotateCcw className="w-4 h-4 text-slate-400" />
                <h2 className="text-sm font-semibold text-white">Status do Fallback Automático</h2>
              </div>
              <span className="text-[10px] text-slate-500 bg-surface-2 px-2 py-0.5 rounded">ciclo 40 min</span>
            </div>

            {/* 3 indicadores em linha */}
            <div className="grid grid-cols-3 gap-2">
              {/* DB Token */}
              <div className={`rounded-lg p-3 border text-center ${info.config?.db_token_present ? 'bg-emerald-500/8 border-emerald-500/20' : 'bg-red-500/8 border-red-500/20'}`}>
                <div className="flex items-center justify-center gap-1 mb-1">
                  <Database className={`w-3.5 h-3.5 ${info.config?.db_token_present ? 'text-emerald-400' : 'text-red-400'}`} />
                  <span className="text-[10px] text-slate-400 font-medium">Token DB</span>
                </div>
                <p className={`text-xs font-bold ${info.config?.db_token_present ? 'text-emerald-300' : 'text-red-400'}`}>
                  {info.config?.db_token_present ? 'Presente' : 'Ausente'}
                </p>
                {info.config?.db_token_present && (
                  <p className="text-[10px] font-mono text-slate-500 mt-0.5 truncate">{info.config?.refresh_token_preview}</p>
                )}
              </div>

              {/* ENV Token */}
              <div className={`rounded-lg p-3 border text-center ${envTokenPresent ? 'bg-emerald-500/8 border-emerald-500/20' : 'bg-surface-2 border-surface-3'}`}>
                <div className="flex items-center justify-center gap-1 mb-1">
                  <Server className={`w-3.5 h-3.5 ${envTokenPresent ? 'text-emerald-400' : 'text-slate-500'}`} />
                  <span className="text-[10px] text-slate-400 font-medium">Token ENV</span>
                </div>
                <p className={`text-xs font-bold ${envTokenPresent ? 'text-emerald-300' : 'text-slate-600'}`}>
                  {envTokenPresent ? 'Presente' : 'Ausente'}
                </p>
                {envTokenPresent && info.config?.env_token_preview && (
                  <p className="text-[10px] font-mono text-slate-500 mt-0.5 truncate">{info.config.env_token_preview}</p>
                )}
              </div>

              {/* Último fallback */}
              <div className={`rounded-lg p-3 border text-center ${lastRecovery ? 'bg-cyan/8 border-cyan/20' : 'bg-surface-2 border-surface-3'}`}>
                <div className="flex items-center justify-center gap-1 mb-1">
                  <Zap className={`w-3.5 h-3.5 ${lastRecovery ? 'text-cyan' : 'text-slate-500'}`} />
                  <span className="text-[10px] text-slate-400 font-medium">Último Fallback</span>
                </div>
                <p className={`text-xs font-bold ${lastRecovery ? 'text-cyan' : 'text-slate-600'}`}>
                  {lastRecovery ? 'Usado' : 'Nunca usado'}
                </p>
                {lastRecoveryAt && (
                  <p className="text-[10px] text-slate-500 mt-0.5">{new Date(lastRecoveryAt).toLocaleDateString('pt-BR')}</p>
                )}
              </div>
            </div>

            {/* Botão testar fallback */}
            <div className="flex items-center gap-3">
              <button
                onClick={testFallback}
                disabled={testingFallback || !account?.id}
                className="flex items-center gap-2 px-4 py-2 bg-surface-2 border border-surface-3 hover:border-cyan/30 text-slate-300 hover:text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                {testingFallback ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                {testingFallback ? 'Testando...' : 'Testar fallback agora'}
              </button>
              {fallbackResult && (
                <div className={`flex items-center gap-1.5 text-xs font-semibold ${fallbackResult.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                  {fallbackResult.ok
                    ? <><CheckCircle className="w-3.5 h-3.5" /> Token renovado via {fallbackResult.active_token_source || 'lwa'}</>
                    : <><XCircle className="w-3.5 h-3.5" /> {(fallbackResult.message || fallbackResult.error || 'Falha').slice(0, 60)}</>
                  }
                </div>
              )}
            </div>
          </div>

          {/* ── PROFILES ──────────────────────────────────────────────── */}
          {hasProfiles && (
            <div className="bg-surface-1 border border-emerald-500/20 rounded-xl p-4">
              <p className="text-xs font-semibold text-emerald-400 mb-3 flex items-center gap-2">
                <CircleDot className="w-3.5 h-3.5" />
                {info.profiles.length} profile(s) Amazon Ads encontrado(s)
              </p>
              <div className="space-y-2">
                {info.profiles.map((p, i) => (
                  <div key={i} className={`flex items-center justify-between px-3 py-2.5 rounded-lg border ${
                    String(p.profileId) === String(info.config?.profile_id)
                      ? 'bg-emerald-500/10 border-emerald-500/25'
                      : 'bg-surface-2 border-surface-3'
                  }`}>
                    <div className="flex items-center gap-2.5">
                      {String(p.profileId) === String(info.config?.profile_id) && (
                        <CheckCircle className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                      )}
                      <div>
                        <p className="text-sm text-white font-medium">{p.name || `Profile ${i + 1}`}</p>
                        <p className="text-xs text-slate-500 font-mono">{p.profileId}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-slate-400">{p.marketplace || p.countryCode}</p>
                      <p className="text-xs text-slate-600">{p.type}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {info.profiles_error && (
            <div className="flex items-center gap-2 p-3 bg-amber-500/8 border border-amber-500/20 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
              <p className="text-xs text-amber-300">Erro ao listar profiles: {info.profiles_error}</p>
            </div>
          )}

          {/* ── AUTORIZAR VIA OAUTH ───────────────────────────────────── */}
          <div className="bg-surface-1 border border-surface-2 rounded-xl p-5 space-y-4">
            <div className="flex items-center gap-2">
              <Plug className="w-4 h-4 text-cyan" />
              <h2 className="text-sm font-semibold text-white">
                {tokenOk ? 'Reconectar via OAuth' : 'Autorizar Amazon Ads via OAuth'}
              </h2>
              <span className="text-[10px] text-slate-500 bg-surface-2 px-2 py-0.5 rounded ml-auto">Recomendado</span>
            </div>

            {tokenInvalid && (
              <div className="p-3 bg-amber-500/8 border border-amber-500/20 rounded-lg space-y-1.5">
                <p className="text-xs text-amber-200 font-semibold">Antes de autorizar, confirme:</p>
                <ul className="text-xs text-slate-400 space-y-1">
                  <li className="flex items-start gap-1.5">
                    <span className="text-amber-400 mt-0.5">→</span>
                    Allowed Return URL no Developer Console inclui:<br />
                    <code className="text-cyan text-[10px] font-mono ml-4">{info.config?.redirect_uri}</code>
                  </li>
                  <li className="flex items-start gap-1.5">
                    <span className="text-amber-400 mt-0.5">→</span>
                    App registada em <strong className="text-white">advertising.amazon.com → API → Apps</strong>
                  </li>
                </ul>
              </div>
            )}

            {info.auth_url && (
              <div className="flex gap-2">
                <a href={info.auth_url} target="_blank" rel="noopener noreferrer"
                  className={`flex-1 flex items-center justify-center gap-2 px-5 py-3 text-white text-sm font-bold rounded-xl transition-colors ${
                    tokenOk ? 'bg-surface-2 border border-surface-3 hover:border-cyan/30 hover:text-cyan' : 'bg-amber-500 hover:bg-amber-400'
                  }`}>
                  <ExternalLink className="w-4 h-4" />
                  {tokenOk ? 'Reconectar Amazon Ads' : 'Autorizar Amazon Ads →'}
                </a>
                <button onClick={copyUrl} title="Copiar URL"
                  className="px-4 py-3 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-xl transition-colors">
                  <Copy className="w-4 h-4" />
                </button>
              </div>
            )}
            {copied && <p className="text-xs text-emerald-400 text-center">URL copiada!</p>}

            <p className="text-xs text-slate-500">
              Após autorizar, a Amazon redireciona de volta para o app e o token é salvo automaticamente.
            </p>
          </div>

          {/* ── COLAR TOKEN MANUALMENTE ───────────────────────────────── */}
          <div className="bg-surface-1 border border-surface-2 rounded-xl p-5 space-y-3">
            <div className="flex items-center gap-2">
              <Key className="w-4 h-4 text-slate-400" />
              <h2 className="text-sm font-semibold text-white">Colar token manualmente</h2>
              <span className="text-[10px] text-slate-600 bg-surface-2 px-2 py-0.5 rounded ml-auto">Alternativo</span>
            </div>
            <p className="text-xs text-slate-500">
              Se já tem um Refresh Token válido (começa com <code className="text-slate-300">Atzr|</code>), cole aqui para validar e salvar.
            </p>

            <div className="relative">
              <input
                type={showToken ? 'text' : 'password'}
                value={pasteToken}
                onChange={e => { setPasteToken(e.target.value); setSaveResult(null); }}
                placeholder="Atzr|..."
                className="w-full px-3 py-2.5 pr-10 bg-surface-2 border border-surface-3 rounded-lg text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-cyan/40 transition-colors"
              />
              <button type="button" onClick={() => setShowToken(v => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
                {showToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>

            {saveResult && (
              <div className={`flex items-start gap-2 p-3 rounded-lg text-xs border ${saveResult.ok ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300' : 'bg-red-500/10 border-red-500/20 text-red-400'}`}>
                {saveResult.ok ? <CheckCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> : <XCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />}
                <div>
                  {saveResult.ok
                    ? <><p className="font-semibold">Token salvo com sucesso!</p>{saveResult.profiles_found > 0 && <p className="mt-0.5">{saveResult.profiles_found} profile(s) encontrado(s)</p>}</>
                    : <p>{saveResult.error}</p>
                  }
                </div>
              </div>
            )}

            <button onClick={saveToken} disabled={saving || !pasteToken.trim()}
              className="flex items-center gap-2 px-4 py-2.5 bg-surface-2 border border-surface-3 hover:border-cyan/30 text-slate-300 hover:text-white text-sm font-semibold rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {saving ? 'Validando...' : 'Validar e salvar token'}
            </button>
          </div>

          {/* ── STATUS FINAL ──────────────────────────────────────────── */}
          {tokenOk && hasProfiles && (
            <div className="flex items-center gap-3 p-4 bg-emerald-500/8 border border-emerald-500/20 rounded-xl">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center flex-shrink-0">
                <ShieldCheck className="w-5 h-5 text-emerald-400" />
              </div>
              <div>
                <p className="text-sm font-bold text-emerald-300">Tudo configurado!</p>
                <p className="text-xs text-slate-400 mt-0.5">
                  Token válido · {info.profiles.length} profile(s) · Sync de campanhas operacional
                </p>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── ÚLTIMA FALHA DE TOKEN ─────────────────────────────────────────── */}
      {lastTokenError ? (
        <div className="bg-surface-1 border border-red-500/20 rounded-xl p-4 space-y-2">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-red-400 flex-shrink-0" />
            <h2 className="text-sm font-semibold text-red-300">Última falha de token</h2>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-400 flex-wrap">
            <span className="font-mono bg-surface-2 px-2 py-0.5 rounded text-[10px]">{lastTokenError.operation}</span>
            <span className="text-slate-600">·</span>
            <span>{lastTokenError.started_at ? new Date(lastTokenError.started_at).toLocaleString('pt-BR') : '—'}</span>
          </div>
          {lastTokenError.error_message && (
            <p className="text-xs text-red-300/80 font-mono bg-red-500/5 border border-red-500/15 rounded-lg px-3 py-2 break-words">
              {lastTokenError.error_message}
            </p>
          )}
          <p className="text-[10px] text-slate-500">
            Esta informação mostra quando e por que a conexão com a Amazon caiu.
          </p>
        </div>
      ) : null}

      {/* Footer nav */}
      <div className="flex items-center gap-4 pt-2 border-t border-surface-2">
        <Link to="/integracoes/amazon" className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-white transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" /> Integração Amazon
        </Link>
        <Link to="/diagnostico" className="text-xs text-slate-500 hover:text-white transition-colors">Diagnóstico</Link>
        <Link to="/settings" className="text-xs text-slate-500 hover:text-white transition-colors">Configurações</Link>
      </div>
    </div>
  );
}