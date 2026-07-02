import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { CheckCircle, XCircle, Loader2, ExternalLink, RefreshCw, ShieldCheck, ShieldAlert, Zap, Copy } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function AmazonOAuthSetup() {
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await base44.functions.invoke('getOAuthSetupInfo', {});
      setInfo(res.data);
    } catch (e) {
      setInfo({ error: e.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const copyUrl = () => {
    if (info?.auth_url) {
      navigator.clipboard.writeText(info.auth_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const tokenOk = info?.token_status === 'valid';
  const hasProfiles = info?.profiles?.length > 0;

  return (
    <div className="p-6 max-w-2xl space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-amber-500/15 border border-amber-500/20 flex items-center justify-center">
            <Zap className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Configuração OAuth — Amazon Ads</h1>
            <p className="text-xs text-slate-500">Diagnóstico e reautorização do token de acesso</p>
          </div>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 text-xs bg-surface-2 border border-surface-3 text-slate-300 hover:text-white rounded-lg transition-colors disabled:opacity-50">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Actualizar
        </button>
      </div>

      {loading && !info && (
        <div className="flex items-center gap-3 p-6 bg-surface-1 border border-surface-2 rounded-xl">
          <Loader2 className="w-5 h-5 animate-spin text-cyan" />
          <span className="text-sm text-slate-400">A verificar configuração...</span>
        </div>
      )}

      {info && (
        <>
          {/* Token Status */}
          <div className={`p-5 rounded-xl border ${tokenOk ? 'bg-emerald-400/5 border-emerald-400/20' : 'bg-red-400/5 border-red-400/20'}`}>
            <div className="flex items-center gap-3 mb-3">
              {tokenOk
                ? <ShieldCheck className="w-5 h-5 text-emerald-400" />
                : <ShieldAlert className="w-5 h-5 text-red-400" />}
              <div>
                <p className={`text-sm font-semibold ${tokenOk ? 'text-emerald-300' : 'text-red-300'}`}>
                  Token Amazon Ads: {tokenOk ? 'Válido ✓' : 'Inválido / Revogado ✗'}
                </p>
                {!tokenOk && info.token_error && (
                  <p className="text-xs text-red-400 mt-0.5 font-mono">{info.token_error}</p>
                )}
              </div>
            </div>

            {/* Config summary */}
            <div className="grid grid-cols-2 gap-2 mt-3">
              {[
                { label: 'Client ID', value: info.config?.client_id_preview },
                { label: 'Refresh Token', value: info.config?.refresh_token_preview },
                { label: 'Profile ID', value: info.config?.profile_id },
                { label: 'Região', value: info.config?.region },
              ].map(({ label, value }) => (
                <div key={label} className="p-2 bg-black/20 rounded-lg">
                  <p className="text-[10px] text-slate-500">{label}</p>
                  <p className="text-xs font-mono text-slate-300">{value || '—'}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Profiles */}
          {hasProfiles && (
            <div className="bg-surface-1 border border-emerald-400/20 rounded-xl p-5">
              <p className="text-sm font-semibold text-emerald-300 mb-3">
                {info.profiles.length} Profile(s) encontrado(s)
              </p>
              <div className="space-y-2">
                {info.profiles.map((p, i) => (
                  <div key={i} className="flex items-center justify-between p-2.5 bg-surface-2 rounded-lg">
                    <div>
                      <p className="text-sm text-white font-medium">{p.name || `Profile ${i + 1}`}</p>
                      <p className="text-xs text-slate-500 font-mono">{p.profileId}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-slate-400">{p.marketplace}</p>
                      <p className="text-xs text-slate-500">{p.type}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {info.profiles_error && (
            <div className="p-3 bg-amber-400/5 border border-amber-400/20 rounded-lg">
              <p className="text-xs text-amber-300">Erro ao listar profiles: {info.profiles_error}</p>
            </div>
          )}

          {/* Re-auth section */}
          {!tokenOk && (
            <div className="bg-surface-1 border border-surface-2 rounded-xl p-5 space-y-4">
              <h2 className="text-sm font-semibold text-white">Reautorizar Amazon Ads</h2>

              <div className="p-4 bg-amber-500/5 border border-amber-500/20 rounded-lg space-y-3">
                <p className="text-xs text-amber-200 font-semibold">⚠️ Antes de clicar: verifique no Amazon Developer Console</p>
                <ol className="text-xs text-slate-400 space-y-1 list-decimal list-inside">
                  <li>O Security Profile tem <strong className="text-white">Allowed Return URLs</strong> com:<br />
                    <code className="text-cyan text-[10px] ml-4">{info.config?.redirect_uri}</code>
                  </li>
                  <li>A app está registada em <strong className="text-white">advertising.amazon.com → API → Apps</strong></li>
                  <li>O scope <code className="text-cyan text-[10px]">advertising::campaign_management</code> está autorizado</li>
                </ol>
              </div>

              <div className="flex flex-col gap-3">
                {info.auth_url && (
                  <a href={info.auth_url} target="_blank" rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 px-5 py-3 bg-cyan hover:bg-cyan/90 text-white text-sm font-bold rounded-xl transition-colors">
                    <ExternalLink className="w-4 h-4" />
                    Autorizar Amazon Ads →
                  </a>
                )}

                {info.auth_url && (
                  <button onClick={copyUrl}
                    className="flex items-center justify-center gap-2 px-5 py-2.5 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-sm rounded-xl transition-colors">
                    <Copy className="w-3.5 h-3.5" />
                    {copied ? 'Copiado!' : 'Copiar URL de autorização'}
                  </button>
                )}
              </div>

              <p className="text-xs text-slate-500">
                Após clicar, a Amazon irá redireccioná-lo de volta para a app. O token será guardado automaticamente.
              </p>
            </div>
          )}

          {tokenOk && hasProfiles && (
            <div className="p-4 bg-emerald-400/5 border border-emerald-400/20 rounded-xl">
              <p className="text-sm text-emerald-300 font-semibold mb-2">✓ Tudo configurado correctamente!</p>
              <p className="text-xs text-slate-400">O token está válido e os profiles foram encontrados. Pode sincronizar campanhas normalmente.</p>
            </div>
          )}

          {tokenOk && !hasProfiles && (
            <div className="p-4 bg-amber-400/5 border border-amber-400/20 rounded-xl">
              <p className="text-sm text-amber-300 font-semibold mb-1">Token válido mas sem profiles</p>
              <p className="text-xs text-slate-400">
                {info.profiles_error || 'A app pode não estar registada na Amazon Ads Console.'}
              </p>
            </div>
          )}
        </>
      )}

      <div className="flex gap-3 pt-2">
        <Link to="/settings" className="text-xs text-slate-500 hover:text-white transition-colors">← Configurações</Link>
        <Link to="/diagnostico" className="text-xs text-slate-500 hover:text-white transition-colors">← Diagnóstico</Link>
      </div>
    </div>
  );
}