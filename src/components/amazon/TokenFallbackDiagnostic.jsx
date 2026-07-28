import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Database, Zap, RefreshCw, CheckCircle, XCircle, Loader2, ShieldCheck, AlertTriangle } from 'lucide-react';

export default function TokenFallbackDiagnostic({ config, onRefresh }) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const hasDb = config?.has_entity_token;
  const hasEnv = config?.env_token_present;
  const envDiff = config?.env_is_different_from_db;
  const lastRecovery = config?.last_recovery_source;
  const lastRecoveryAt = config?.last_recovery_at;
  const canFallback = hasDb && hasEnv && envDiff;

  const testFallback = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      // Forçar refresh — o tokenManager tentará DB primeiro, depois ENV se necessário
      const accounts = await base44.entities.AmazonAccount.filter({}, null, 1).catch(() => []);
      const acc = accounts[0];
      if (!acc) { setTestResult({ ok: false, message: 'Nenhuma conta encontrada' }); return; }

      const res = await base44.functions.invoke('amazonAdsTokenManager', {
        amazon_account_id: acc.id,
        force_refresh: true,
        _service_role: true,
      });
      const d = res?.data || {};
      setTestResult({
        ok: d.ok,
        source: d.active_token_source || d.source,
        recovered: d.recovered_from_env_fallback,
        expires_at: d.expires_at,
        message: d.ok
          ? `Token renovado (fonte: ${d.active_token_source || 'database'})${d.recovered_from_env_fallback ? ' — FALLBACK ENV ativado!' : ''}`
          : (d.message || d.error || 'Falha na renovação'),
      });
      if (d.ok) onRefresh?.();
    } catch (e) {
      setTestResult({ ok: false, message: e.message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-cyan" />
          <h2 className="text-sm font-semibold text-white">Fallback Automático de Token</h2>
        </div>
        <button
          onClick={testFallback}
          disabled={testing}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-surface-2 border border-surface-3 text-slate-300 hover:text-white rounded-lg transition-colors disabled:opacity-50"
        >
          {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          {testing ? 'Testando...' : 'Testar agora'}
        </button>
      </div>

      {/* Indicadores em linha */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Token DB */}
        <div className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs ${hasDb ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300' : 'bg-red-500/10 border-red-500/20 text-red-400'}`}>
          <Database className="w-3 h-3" />
          <span>Token DB</span>
          {hasDb
            ? <span className="font-mono text-[10px] text-slate-400">{config?.refresh_token_preview}</span>
            : <span className="text-[10px]">ausente</span>
          }
          {hasDb ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
        </div>

        {/* Token ENV */}
        <div className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs ${hasEnv ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300' : 'bg-slate-500/10 border-slate-500/20 text-slate-500'}`}>
          <Zap className="w-3 h-3" />
          <span>Token ENV</span>
          {hasEnv
            ? <span className="font-mono text-[10px] text-slate-400">{config?.env_token_preview}</span>
            : <span className="text-[10px]">ausente</span>
          }
          {hasEnv ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
        </div>

        {/* Status fallback */}
        <div className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs ${
          canFallback ? 'bg-cyan/10 border-cyan/25 text-cyan' : 'bg-slate-500/10 border-slate-500/20 text-slate-500'
        }`}>
          <ShieldCheck className="w-3 h-3" />
          <span>{canFallback ? 'Fallback disponível' : 'Fallback indisponível'}</span>
        </div>
      </div>

      {/* Último recovery */}
      {lastRecovery && (
        <div className="flex items-center gap-2 p-2.5 bg-emerald-500/8 border border-emerald-500/15 rounded-lg">
          <CheckCircle className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
          <div className="text-xs text-emerald-300">
            <span className="font-semibold">Último fallback bem-sucedido</span>
            {lastRecovery === 'environment_fallback' && ' (ENV → DB atualizado automaticamente)'}
            {lastRecoveryAt && <span className="text-slate-500 ml-2">{new Date(lastRecoveryAt).toLocaleString('pt-BR')}</span>}
          </div>
        </div>
      )}

      {/* Aviso se não há fallback */}
      {!canFallback && (
        <p className="text-[11px] text-slate-500">
          {!hasEnv
            ? 'Configure ADS_REFRESH_TOKEN nos Secrets para habilitar o fallback automático silencioso.'
            : !hasDb
            ? 'Autorize via OAuth para salvar o token no banco.'
            : 'DB e ENV têm o mesmo token — fallback não é necessário.'
          }
        </p>
      )}

      {/* Resultado do teste */}
      {testResult && (
        <div className={`flex items-start gap-2 p-3 rounded-lg border text-xs ${testResult.ok ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300' : 'bg-red-500/10 border-red-500/20 text-red-400'}`}>
          {testResult.ok ? <CheckCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> : <XCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />}
          <div>
            <p className="font-semibold">{testResult.message}</p>
            {testResult.ok && testResult.expires_at && (
              <p className="text-slate-400 mt-0.5">Expira: {new Date(testResult.expires_at).toLocaleString('pt-BR')}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}