import { useState, useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { ShieldCheck, ShieldAlert, Clock, Zap, RefreshCw, CheckCircle, XCircle, Loader2 } from 'lucide-react';

/**
 * Painel de saúde do token Amazon Ads.
 * Exibe: último sucesso, próxima expiração com countdown, margem de segurança e histórico das últimas 5 renovações.
 */
export default function TokenHealthPanel({ account }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [countdown, setCountdown] = useState(null); // segundos restantes
  const intervalRef = useRef(null);

  const load = async () => {
    if (!account?.id) return;
    setLoading(true);
    try {
      const logs = await base44.entities.SyncExecutionLog.filter(
        { amazon_account_id: account.id, operation: 'amazon_ads:token_manager_v8' },
        '-started_at',
        10
      ).catch(() => []);

      const lastSuccess = logs.find(l => l.status === 'success');
      const recent5 = logs.slice(0, 5);

      setData({ lastSuccess, recent5, account });
    } catch { /* silencioso */ }
    finally { setLoading(false); }
  };

  // Countdown em tempo real até expiração do token
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    const updateCountdown = () => {
      const expiresAt = account?.ads_access_token_expires_at;
      if (!expiresAt) { setCountdown(null); return; }
      const diff = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000);
      setCountdown(diff);
    };
    updateCountdown();
    intervalRef.current = setInterval(updateCountdown, 1000);
    return () => clearInterval(intervalRef.current);
  }, [account?.ads_access_token_expires_at]);

  useEffect(() => { load(); }, [account?.id]);

  const formatCountdown = (secs) => {
    if (secs == null) return '—';
    if (secs <= 0) return 'Expirado';
    const m = Math.floor(Math.abs(secs) / 60);
    const s = Math.abs(secs) % 60;
    return `${m}m ${String(s).padStart(2, '0')}s`;
  };

  const countdownColor = () => {
    if (countdown == null) return 'text-slate-500';
    if (countdown <= 0) return 'text-red-400';
    if (countdown < 5 * 60) return 'text-red-400';
    if (countdown < 15 * 60) return 'text-amber-400';
    return 'text-emerald-400';
  };

  const countdownBg = () => {
    if (countdown == null) return 'bg-surface-2 border-surface-3';
    if (countdown <= 0) return 'bg-red-500/10 border-red-500/25';
    if (countdown < 5 * 60) return 'bg-red-500/10 border-red-500/25';
    if (countdown < 15 * 60) return 'bg-amber-500/10 border-amber-500/25';
    return 'bg-emerald-500/8 border-emerald-500/20';
  };

  const parseLogSummary = (log) => {
    try { return JSON.parse(log.result_summary || '{}'); } catch { return {}; }
  };

  const getLogDot = (log) => {
    if (log.status === 'success') return 'bg-emerald-400';
    if (log.status === 'warning') return 'bg-amber-400';
    return 'bg-red-400';
  };

  const getLogSource = (log) => {
    const s = parseLogSummary(log);
    if (s.source === 'proactive_refresh') return 'proativo';
    if (s.source === 'environment_fallback') return 'env-fallback';
    if (s.source) return s.source;
    return log.status === 'success' ? 'database' : 'erro';
  };

  const formatTime = (iso) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  if (loading) {
    return (
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-4 flex items-center gap-3">
        <Loader2 className="w-4 h-4 text-slate-500 animate-spin flex-shrink-0" />
        <span className="text-xs text-slate-500">Carregando saúde do token...</span>
      </div>
    );
  }

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-4 space-y-4">
      {/* Título */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-cyan" />
          <h3 className="text-sm font-semibold text-white">Saúde do Token</h3>
          <span className="text-[10px] bg-cyan/10 text-cyan border border-cyan/20 px-1.5 py-0.5 rounded">buffer +10min</span>
        </div>
        <button onClick={load} className="text-slate-600 hover:text-slate-300 transition-colors">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Countdown + última renovação */}
      <div className="grid grid-cols-2 gap-3">
        {/* Countdown */}
        <div className={`rounded-lg p-3 border ${countdownBg()}`}>
          <div className="flex items-center gap-1.5 mb-1">
            <Clock className="w-3 h-3 text-slate-400" />
            <span className="text-[10px] text-slate-400 font-medium">Expira em</span>
          </div>
          <p className={`text-lg font-bold font-mono ${countdownColor()}`}>
            {formatCountdown(countdown)}
          </p>
          <p className="text-[9px] text-slate-500 mt-0.5">
            {account?.ads_access_token_expires_at
              ? `às ${formatTime(account.ads_access_token_expires_at)}`
              : 'sem token ativo'}
          </p>
        </div>

        {/* Margem de segurança */}
        <div className="rounded-lg p-3 border bg-surface-2 border-surface-3">
          <div className="flex items-center gap-1.5 mb-1">
            <Zap className="w-3 h-3 text-cyan" />
            <span className="text-[10px] text-slate-400 font-medium">Margem de segurança</span>
          </div>
          <p className="text-base font-bold text-cyan">10 min</p>
          <p className="text-[9px] text-slate-500 mt-0.5">buffer aplicado ao salvar</p>
        </div>
      </div>

      {/* Última renovação bem-sucedida */}
      {data?.lastSuccess && (
        <div className="flex items-center gap-2 px-3 py-2 bg-emerald-500/8 border border-emerald-500/20 rounded-lg">
          <CheckCircle className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-xs text-emerald-300 font-medium">Último sucesso: </span>
            <span className="text-xs text-slate-400">
              {data.lastSuccess.started_at
                ? new Date(data.lastSuccess.started_at).toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' })
                : '—'}
            </span>
          </div>
          <span className="text-[10px] font-mono bg-emerald-500/15 text-emerald-400 px-1.5 py-0.5 rounded flex-shrink-0">
            {getLogSource(data.lastSuccess)}
          </span>
        </div>
      )}

      {/* Linha do tempo das últimas 5 renovações */}
      {data?.recent5?.length > 0 && (
        <div>
          <p className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider mb-2">Últimas renovações</p>
          <div className="flex items-center gap-2">
            {/* Linha horizontal com pontos */}
            <div className="flex-1 flex items-center gap-0">
              {[...data.recent5].reverse().map((log, i) => {
                const summary = parseLogSummary(log);
                const tooltipText = `${formatTime(log.started_at)} · ${getLogSource(log)}${log.error_message ? ` · ${log.error_message.slice(0,50)}` : ''}`;
                return (
                  <div key={log.id || i} className="flex items-center flex-1 group relative">
                    {i > 0 && (
                      <div className="h-px flex-1 bg-surface-3" />
                    )}
                    <div
                      className={`w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 cursor-default transition-transform group-hover:scale-125 ${
                        log.status === 'success' ? 'bg-emerald-400 border-emerald-300' :
                        log.status === 'warning' ? 'bg-amber-400 border-amber-300' :
                        'bg-red-400 border-red-300'
                      }`}
                      title={tooltipText}
                    />
                    {/* Tooltip */}
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-10 pointer-events-none">
                      <div className="bg-surface-1 border border-surface-2 rounded-lg px-2 py-1.5 text-[9px] text-slate-300 whitespace-nowrap shadow-lg">
                        <p className="font-semibold">{formatTime(log.started_at)}</p>
                        <p className="text-slate-400">{getLogSource(log)}</p>
                        {log.status !== 'success' && log.error_message && (
                          <p className="text-red-400 mt-0.5">{log.error_message.slice(0, 40)}</p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {/* Legenda */}
            <div className="flex items-center gap-2 flex-shrink-0 ml-2">
              <span className="flex items-center gap-1 text-[9px] text-slate-500">
                <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" />ok
              </span>
              <span className="flex items-center gap-1 text-[9px] text-slate-500">
                <span className="w-2 h-2 rounded-full bg-red-400 inline-block" />erro
              </span>
            </div>
          </div>
          {/* Horários abaixo dos pontos */}
          <div className="flex items-center mt-1 gap-0">
            {[...data.recent5].reverse().map((log, i) => (
              <div key={log.id || i} className={`flex-1 text-center text-[8px] text-slate-600 ${i === 0 ? '' : ''}`}>
                {formatTime(log.started_at)}
              </div>
            ))}
          </div>
        </div>
      )}

      {!data?.recent5?.length && (
        <p className="text-xs text-slate-600 text-center py-2">Nenhum log de renovação encontrado ainda.</p>
      )}
    </div>
  );
}