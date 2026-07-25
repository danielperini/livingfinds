/**
 * ProactiveBudgetOptimizerCard
 * Exibe o status da última execução do runDaypartingBudgetOptimizer.
 * Mostra: hora prevista de esgotamento, bids reduzidos, horários protegidos.
 */
import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Zap, Clock, TrendingDown, Shield, Loader2, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';

function fmtBRL(v) {
  return v == null ? '—' : `R$${Number(v).toFixed(2)}`;
}

export default function ProactiveBudgetOptimizerCard({ account }) {
  const [log, setLog] = useState(null);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState(null);
  const [expanded, setExpanded] = useState(false);

  const load = async () => {
    if (!account) return;
    setLoading(true);
    try {
      const logs = await base44.entities.SyncExecutionLog.filter(
        { amazon_account_id: account.id, operation: 'dayparting_budget_optimizer' },
        '-created_date',
        1
      ).catch(() => []);
      const latest = logs[0] || null;
      setLog(latest);
      if (latest?.result_summary) {
        try { setSummary(JSON.parse(latest.result_summary)); } catch { setSummary(null); }
      } else {
        setSummary(null);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [account]);

  const runNow = async () => {
    if (!account || running) return;
    setRunning(true);
    setMsg(null);
    try {
      const res = await base44.functions.invoke('runDaypartingBudgetOptimizer', {
        amazon_account_id: account.id,
        dry_run: false,
      });
      const data = res?.data ?? res;
      if (data?.ok) {
        setMsg({ type: 'success', text: data.message || 'Otimização concluída.' });
        await load();
      } else {
        setMsg({ type: 'error', text: data?.error || 'Erro na execução.' });
      }
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setRunning(false);
      setTimeout(() => setMsg(null), 8000);
    }
  };

  // Calcular se executou hoje
  const todayBRT = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
  const ranToday = log?.execution_date === todayBRT || (log?.started_at || '').startsWith(todayBRT);
  const isActive = ranToday && (summary?.bids_reduced || 0) > 0;

  if (loading) {
    return (
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-4 animate-pulse">
        <div className="h-4 w-40 bg-surface-3 rounded mb-3" />
        <div className="h-10 bg-surface-2 rounded" />
      </div>
    );
  }

  return (
    <div className={`border rounded-xl p-4 transition-colors ${
      isActive
        ? 'bg-violet-500/8 border-violet-500/25'
        : 'bg-surface-1 border-surface-2'
    }`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${isActive ? 'bg-violet-500/20' : 'bg-surface-2'}`}>
            <Zap className={`w-4 h-4 ${isActive ? 'text-violet-400' : 'text-slate-500'}`} />
          </div>
          <div>
            <p className="text-xs font-bold text-slate-200">Otimização Proativa de Budget</p>
            <p className="text-[10px] text-slate-500">Reduz lances em horários fracos antes do teto ser atingido</p>
          </div>
          {isActive && (
            <span className="text-[10px] px-2 py-0.5 bg-violet-500/20 border border-violet-500/30 text-violet-300 rounded-full font-semibold">
              ✓ Ativa hoje
            </span>
          )}
          {ranToday && !isActive && (
            <span className="text-[10px] px-2 py-0.5 bg-slate-500/15 border border-slate-500/20 text-slate-400 rounded-full">
              Executada hoje (sem ajustes necessários)
            </span>
          )}
          {!ranToday && log && (
            <span className="text-[10px] px-2 py-0.5 bg-amber-500/10 border border-amber-500/20 text-amber-400 rounded-full">
              Última: {log.execution_date || '—'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={runNow}
            disabled={running}
            title="Executar agora"
            className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-semibold bg-violet-500/15 border border-violet-500/25 text-violet-400 hover:bg-violet-500/25 rounded-lg transition-colors disabled:opacity-50"
          >
            {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            {running ? 'Executando...' : 'Executar agora'}
          </button>
          {summary && (
            <button onClick={() => setExpanded(v => !v)} className="text-slate-500 hover:text-slate-300 transition-colors p-1">
              {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          )}
        </div>
      </div>

      {msg && (
        <div className={`mb-3 px-3 py-2 rounded-lg text-xs font-medium ${msg.type === 'success' ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-300' : 'bg-red-500/10 border border-red-500/20 text-red-400'}`}>
          {msg.text}
        </div>
      )}

      {/* KPIs */}
      {summary ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
          <div className="bg-surface-2/60 rounded-lg p-2.5">
            <div className="flex items-center gap-1 mb-1">
              <Clock className="w-3 h-3 text-amber-400" />
              <p className="text-[9px] text-slate-500 uppercase">Hora prev. esgotamento</p>
            </div>
            <p className={`text-base font-bold ${summary.avg_exhaustion_hour != null ? 'text-amber-300' : 'text-slate-500'}`}>
              {summary.avg_exhaustion_hour != null ? `${String(summary.avg_exhaustion_hour).padStart(2, '0')}:00 BRT` : 'Sem histórico'}
            </p>
            <p className="text-[9px] text-slate-600 mt-0.5">
              {summary.kill_switch_days > 0 ? `média de ${summary.kill_switch_days} dia(s)` : 'sem kill switch recente'}
            </p>
          </div>

          <div className="bg-surface-2/60 rounded-lg p-2.5">
            <div className="flex items-center gap-1 mb-1">
              <TrendingDown className="w-3 h-3 text-cyan" />
              <p className="text-[9px] text-slate-500 uppercase">Bids reduzidos</p>
            </div>
            <p className={`text-base font-bold ${(summary.bids_reduced || 0) > 0 ? 'text-cyan' : 'text-slate-500'}`}>
              {summary.bids_reduced || 0}
            </p>
            <p className="text-[9px] text-slate-600 mt-0.5">keywords ajustadas</p>
          </div>

          <div className="bg-surface-2/60 rounded-lg p-2.5">
            <div className="flex items-center gap-1 mb-1">
              <Shield className="w-3 h-3 text-emerald-400" />
              <p className="text-[9px] text-slate-500 uppercase">Picos protegidos</p>
            </div>
            <p className="text-base font-bold text-emerald-400">
              {(summary.peak_hours_protected || []).length > 0
                ? `${summary.peak_hours_protected.length}h`
                : '—'}
            </p>
            <p className="text-[9px] text-slate-600 mt-0.5 truncate">
              {(summary.peak_hours_protected || []).length > 0
                ? (summary.peak_hours_protected || []).slice(0, 4).map(h => `${String(h).padStart(2,'0')}h`).join(' ')
                : 'nenhum identificado'}
            </p>
          </div>

          <div className="bg-surface-2/60 rounded-lg p-2.5">
            <div className="flex items-center gap-1 mb-1">
              <Zap className="w-3 h-3 text-violet-400" />
              <p className="text-[9px] text-slate-500 uppercase">Economia estimada</p>
            </div>
            <p className="text-base font-bold text-violet-300">
              {summary.economia_estimada_brl > 0 ? fmtBRL(summary.economia_estimada_brl) : '—'}
            </p>
            <p className="text-[9px] text-slate-600 mt-0.5">estimativa conservadora</p>
          </div>
        </div>
      ) : !ranToday ? (
        <div className="text-center py-4 text-[10px] text-slate-500">
          Nenhuma execução encontrada. Agendada para 08h BRT diariamente.
        </div>
      ) : null}

      {/* Detalhes expandidos */}
      {expanded && summary && (
        <div className="mt-2 pt-3 border-t border-surface-2 space-y-3">
          {(summary.target_hours_for_reduction || []).length > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-slate-400 mb-1.5">Horários com redução de lance:</p>
              <div className="flex flex-wrap gap-1.5">
                {(summary.target_hours_for_reduction || []).map(h => (
                  <span key={h} className="text-[10px] px-2 py-0.5 bg-amber-500/15 border border-amber-500/25 text-amber-300 rounded font-mono">
                    {String(h).padStart(2, '0')}h
                  </span>
                ))}
              </div>
            </div>
          )}
          {(summary.peak_hours_protected || []).length > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-slate-400 mb-1.5">Horários de pico protegidos:</p>
              <div className="flex flex-wrap gap-1.5">
                {(summary.peak_hours_protected || []).map(h => (
                  <span key={h} className="text-[10px] px-2 py-0.5 bg-emerald-500/15 border border-emerald-500/25 text-emerald-300 rounded font-mono">
                    {String(h).padStart(2, '0')}h
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="grid grid-cols-3 gap-2 text-[10px]">
            <div className="bg-surface-2/50 rounded p-2">
              <p className="text-slate-500">Campanhas analisadas</p>
              <p className="font-bold text-slate-200 mt-0.5">{summary.campaigns_analyzed || 0}</p>
            </div>
            <div className="bg-surface-2/50 rounded p-2">
              <p className="text-slate-500">Decisões geradas</p>
              <p className="font-bold text-slate-200 mt-0.5">{summary.decisions_created || 0}</p>
            </div>
            <div className="bg-surface-2/50 rounded p-2">
              <p className="text-slate-500">Ignoradas (vencedoras)</p>
              <p className="font-bold text-slate-200 mt-0.5">{summary.bids_skipped || 0}</p>
            </div>
          </div>
          {summary.dry_run && (
            <p className="text-[10px] text-amber-400">⚠ Última execução foi em modo DRY RUN — nenhum lance foi alterado de fato.</p>
          )}
          {(summary.errors || []).length > 0 && (
            <div className="bg-red-500/5 border border-red-500/20 rounded-lg p-2">
              <p className="text-[10px] font-semibold text-red-400 mb-1">Erros parciais:</p>
              {summary.errors.map((e, i) => <p key={i} className="text-[10px] text-red-300">{e}</p>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}