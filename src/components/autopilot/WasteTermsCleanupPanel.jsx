import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { Trash2, Play, RefreshCw, ChevronDown, ChevronUp, AlertTriangle, CheckCircle, Loader2, PauseCircle, XCircle } from 'lucide-react';

export default function WasteTermsCleanupPanel({ account }) {
  const [lastRun, setLastRun] = useState(null);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);

  const loadLastRun = useCallback(async () => {
    if (!account?.id) return;
    setLoading(true);
    try {
      const logs = await base44.entities.SyncExecutionLog.filter(
        { amazon_account_id: account.id, operation: 'runWeeklyWasteTermsCleanup' },
        '-completed_at', 1
      ).catch(() => []);
      if (logs[0]) {
        setLastRun(logs[0]);
        try { setResults(JSON.parse(logs[0].result_summary || '{}')); } catch { setResults(null); }
      }
    } finally {
      setLoading(false);
    }
  }, [account?.id]);

  useEffect(() => { loadLastRun(); }, [loadLastRun]);

  const runCleanup = async () => {
    if (!account?.id || running) return;
    setRunning(true);
    setMsg(null);
    try {
      const res = await base44.functions.invoke('runWeeklyWasteTermsCleanup', { amazon_account_id: account.id });
      const d = res.data;
      if (d?.ok) {
        const s = d.stats || {};
        setMsg({
          type: 'success',
          text: `✓ ${s.waste_terms_found} termos desperdiçadores · ${s.negatives_created} negativados · ${s.campaigns_paused} campanhas pausadas · ${s.campaigns_preserved} preservadas`,
        });
        // Store results locally for display
        setResults({
          waste_terms: s.waste_terms_found,
          negatives_created: s.negatives_created,
          campaigns_paused: s.campaigns_paused,
          campaigns_preserved: s.campaigns_preserved,
        });
        if (d.pause_actions?.length || d.negative_actions?.length) {
          setExpanded(true);
          setLastRun({ ...lastRun, _fresh: d });
        }
        await loadLastRun();
      } else {
        setMsg({ type: 'error', text: d?.error || 'Erro desconhecido' });
      }
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setRunning(false);
      setTimeout(() => setMsg(null), 15000);
    }
  };

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-surface-2 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Trash2 className="w-4 h-4 text-red-400" />
          <h3 className="text-sm font-semibold text-slate-200">Limpeza Semanal de Desperdício</h3>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-500/15 border border-slate-500/30 text-slate-400 font-medium">
            &gt; 3 semanas
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={loadLastRun} disabled={loading}
            className="p-2 bg-surface-2 border border-surface-3 rounded-lg text-slate-400 hover:text-white disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={runCleanup} disabled={running}
            className="flex items-center gap-1.5 px-4 py-2 bg-red-500/15 border border-red-500/30 text-red-300 hover:bg-red-500/25 text-xs font-semibold rounded-lg disabled:opacity-50">
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            {running ? 'Limpando...' : 'Executar limpeza'}
          </button>
        </div>
      </div>

      {/* Description */}
      <div className="px-5 pt-4 pb-2">
        <p className="text-xs text-slate-500 leading-relaxed">
          Analisa termos com <span className="text-slate-300">≥ 21 dias</span> de dados que <span className="text-red-400">apenas gastam sem converter</span> → negativados automaticamente.
          Campanhas AUTO/MANUAL com <span className="text-amber-400">ACoS acima da meta ou zero conversões</span> por 3 semanas são pausadas.
          Campanhas AUTO ainda viáveis são preservadas.
        </p>
      </div>

      {/* KPIs */}
      <div className="p-5 pt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-surface-2 rounded-lg p-3">
          <p className="text-[10px] text-slate-500 mb-1">Última execução</p>
          <p className="text-sm font-semibold text-white">
            {lastRun?.completed_at ? new Date(lastRun.completed_at).toLocaleDateString('pt-BR') : '—'}
          </p>
          <p className="text-[10px] text-slate-600">
            {lastRun?.completed_at ? new Date(lastRun.completed_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : 'nunca'}
          </p>
        </div>
        <div className="bg-surface-2 rounded-lg p-3">
          <p className="text-[10px] text-slate-500 mb-1">Termos negativados</p>
          <p className="text-xl font-bold text-red-400">{results?.negatives_created ?? '—'}</p>
          <p className="text-[10px] text-slate-600">só gastavam</p>
        </div>
        <div className="bg-surface-2 rounded-lg p-3">
          <p className="text-[10px] text-slate-500 mb-1">Campanhas pausadas</p>
          <p className="text-xl font-bold text-amber-400">{results?.campaigns_paused ?? '—'}</p>
          <p className="text-[10px] text-slate-600">prejuízo / sem retorno</p>
        </div>
        <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-3">
          <p className="text-[10px] text-slate-500 mb-1">Campanhas preservadas</p>
          <p className="text-xl font-bold text-emerald-400">{results?.campaigns_preserved ?? '—'}</p>
          <p className="text-[10px] text-slate-600">ainda viáveis</p>
        </div>
      </div>

      {/* Message */}
      {msg && (
        <div className={`mx-5 mb-4 px-4 py-3 rounded-lg text-xs border flex items-center gap-2 ${msg.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300' : 'bg-red-500/10 border-red-500/20 text-red-400'}`}>
          {msg.type === 'success' ? <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />}
          {msg.text}
        </div>
      )}

      {/* Regras aplicadas */}
      <div className="px-5 pb-4">
        <button onClick={() => setExpanded(e => !e)}
          className="w-full flex items-center justify-between py-2 text-xs text-slate-500 hover:text-slate-300 transition-colors">
          <span>Regras aplicadas</span>
          {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>
        {expanded && (
          <div className="mt-2 space-y-2">
            <div className="bg-surface-2 rounded-lg p-3 space-y-2 text-xs text-slate-400">
              <div className="flex items-start gap-2">
                <XCircle className="w-3.5 h-3.5 text-red-400 mt-0.5 flex-shrink-0" />
                <span><span className="text-slate-200 font-medium">Termos negativados:</span> ≥ 21 dias de presença · spend &gt; limiar mínimo · <span className="text-red-400">0 conversões</span> → NEGATIVE_EXACT na campanha de origem</span>
              </div>
              <div className="flex items-start gap-2">
                <PauseCircle className="w-3.5 h-3.5 text-amber-400 mt-0.5 flex-shrink-0" />
                <span><span className="text-slate-200 font-medium">Campanhas pausadas (MANUAL):</span> ≥ 21 dias · ACoS acima da meta configurada OU 0 conversões com spend significativo</span>
              </div>
              <div className="flex items-start gap-2">
                <PauseCircle className="w-3.5 h-3.5 text-amber-400 mt-0.5 flex-shrink-0" />
                <span><span className="text-slate-200 font-medium">Campanhas pausadas (AUTO):</span> ≥ 21 dias · 0 conversões com spend alto OU ACoS &gt; 1,5× a meta (caso extremo)</span>
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle className="w-3.5 h-3.5 text-emerald-400 mt-0.5 flex-shrink-0" />
                <span><span className="text-slate-200 font-medium">Campanhas AUTO preservadas:</span> ainda dentro da meta de ACoS, ou ainda aprendendo (spend baixo), ou com conversões recentes</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}