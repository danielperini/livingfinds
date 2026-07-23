import { useState, useEffect, useRef, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Zap, Loader2, CheckCircle, XCircle, Clock, AlertTriangle,
  ChevronDown, ChevronRight, ExternalLink, RefreshCw, Bot,
  Database, Cpu, Send, RotateCcw, Eye
} from 'lucide-react';
import { Link } from 'react-router-dom';

// ── Configuração das fases ────────────────────────────────────────────────────
const PHASES = [
  { id: 'phase1', number: 1, name: 'Sync de Dados', icon: Database, description: 'Atualiza campanhas, keywords e métricas da Amazon Ads' },
  { id: 'phase2', number: 2, name: 'Motor Determinístico', icon: Cpu, description: 'Gera decisões com guardrails v8 (winner protection, ACoS ponderado)' },
  { id: 'phase3', number: 3, name: 'Análise IA', icon: Bot, description: 'Camada IA complementar — analisa dados dos últimos 14d', isAi: true },
  { id: 'phase4', number: 4, name: 'Execução Amazon Ads', icon: Send, description: 'Aplica decisões via API: bids, budgets, pausas' },
  { id: 'phase5', number: 5, name: 'Confirmação', icon: RotateCcw, description: 'Reconcilia estado local vs Amazon Ads' },
];

function PhaseStatusIcon({ status }) {
  if (status === 'running') return <Loader2 className="w-4 h-4 text-cyan animate-spin flex-shrink-0" />;
  if (status === 'success') return <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0" />;
  if (status === 'error') return <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />;
  if (status === 'warning') return <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />;
  if (status === 'skipped') return <Clock className="w-4 h-4 text-slate-500 flex-shrink-0" />;
  return <div className="w-4 h-4 rounded-full border-2 border-slate-700 flex-shrink-0" />;
}

function PhaseRow({ phase, data }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = phase.icon;
  const status = data?.status || 'pending';
  const hasError = status === 'error' && data?.error;
  const hasDetail = hasError || (status === 'success' && data);

  return (
    <div className={`border rounded-xl overflow-hidden transition-colors ${
      status === 'error' ? 'border-red-500/30 bg-red-500/5' :
      status === 'warning' ? 'border-amber-500/20 bg-amber-500/5' :
      status === 'success' ? 'border-emerald-500/20 bg-emerald-500/5' :
      status === 'running' ? 'border-cyan/20 bg-cyan/5' :
      'border-surface-2 bg-surface-1'
    }`}>
      <button
        className="w-full flex items-center gap-3 px-4 py-3 text-left"
        onClick={() => hasDetail && setExpanded(v => !v)}
        disabled={!hasDetail}
      >
        {/* Number badge */}
        <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 ${
          status === 'success' ? 'bg-emerald-500/20 text-emerald-400' :
          status === 'error' ? 'bg-red-500/20 text-red-400' :
          status === 'running' ? 'bg-cyan/20 text-cyan' :
          status === 'warning' ? 'bg-amber-500/20 text-amber-400' :
          'bg-surface-3 text-slate-500'
        }`}>
          {phase.number}
        </div>

        <PhaseStatusIcon status={status} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-sm font-semibold ${
              status === 'success' ? 'text-emerald-300' :
              status === 'error' ? 'text-red-300' :
              status === 'running' ? 'text-cyan' :
              status === 'warning' ? 'text-amber-300' :
              'text-slate-300'
            }`}>{phase.name}</span>

            {phase.isAi && (
              <span className="text-[10px] px-1.5 py-0.5 rounded border bg-blue-500/15 border-blue-500/25 text-blue-400 font-bold">IA</span>
            )}

            {status === 'running' && (
              <span className="text-[10px] text-cyan/80 animate-pulse">Executando...</span>
            )}

            {status === 'success' && data?.records != null && (
              <span className="text-[10px] text-emerald-400/70">{data.records} registros</span>
            )}
            {status === 'success' && data?.decisions_generated != null && (
              <span className="text-[10px] text-emerald-400/70">{data.decisions_generated} decisões</span>
            )}
            {status === 'success' && data?.ai_decisions_added != null && (
              <span className="text-[10px] text-blue-400/80">{data.ai_decisions_added} decisões IA</span>
            )}
            {status === 'success' && data?.executed != null && (
              <span className="text-[10px] text-emerald-400/70">{data.executed} executadas{data.failed > 0 ? ` · ${data.failed} falhas` : ''}</span>
            )}
            {(status === 'warning' || status === 'skipped') && data?.ai_error && (
              <span className="text-[10px] text-amber-400/70">{data.ai_error}</span>
            )}
          </div>
          <p className="text-[10px] text-slate-500 mt-0.5">{phase.description}</p>
        </div>

        {/* Duration */}
        {data?.duration_ms != null && (
          <span className="text-[10px] text-slate-500 flex-shrink-0">{data.duration_ms > 1000 ? `${(data.duration_ms / 1000).toFixed(1)}s` : `${data.duration_ms}ms`}</span>
        )}

        {/* Expand icon */}
        {hasDetail && (
          expanded ? <ChevronDown className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
        )}
      </button>

      {expanded && hasDetail && (
        <div className="px-4 pb-3 space-y-2">
          {hasError && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 space-y-1">
              <p className="text-[11px] font-bold text-red-400">Erro:</p>
              <p className="text-[11px] text-red-300/80 break-all">{data.error}</p>
              {data.amazon_status && (
                <p className="text-[10px] text-slate-500">HTTP Status: {data.amazon_status}</p>
              )}
              {data.amazon_error && (
                <p className="text-[10px] text-slate-500">Amazon: {data.amazon_error}</p>
              )}
              {data.retryable === false && data.link && (
                <Link to={data.link} className="inline-flex items-center gap-1 text-[11px] text-red-400 hover:text-red-300 mt-1">
                  <ExternalLink className="w-3 h-3" /> Reconectar Amazon Ads
                </Link>
              )}
              {data.retryable && (
                <p className="text-[10px] text-amber-400">↻ Erro temporário — tente novamente</p>
              )}
            </div>
          )}

          {status === 'success' && data && (
            <div className="rounded-lg border border-emerald-500/15 bg-emerald-500/5 px-3 py-2">
              <pre className="text-[10px] text-emerald-300/70 whitespace-pre-wrap overflow-x-auto">
                {JSON.stringify(
                  Object.fromEntries(Object.entries(data).filter(([k]) => !['status', 'started_at'].includes(k))),
                  null, 2
                ).slice(0, 600)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Componente principal ───────────────────────────────────────────────────────
export default function MotorExecutionPanel({ account }) {
  const [isRunning, setIsRunning] = useState(false);
  const [correlationId, setCorrelationId] = useState(null);
  const [syncLogId, setSyncLogId] = useState(null);
  const [phases, setPhases] = useState({});
  const [finalSummary, setFinalSummary] = useState(null);
  const [runError, setRunError] = useState(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [showDecisions, setShowDecisions] = useState(false);
  const [recentDecisions, setRecentDecisions] = useState([]);

  // KPIs
  const [kpis, setKpis] = useState({ lastRun: null, decisionsLastCycle: 0, executedToday: 0, tokenStatus: 'unknown' });
  const [loadingKpis, setLoadingKpis] = useState(true);

  const pollingRef = useRef(null);
  const elapsedRef = useRef(null);
  const startTimeRef = useRef(null);

  const aid = account?.id;

  // ── Carregar KPIs ──────────────────────────────────────────────────────────
  const loadKpis = useCallback(async () => {
    if (!aid) return;
    setLoadingKpis(true);
    try {
      const todayStr = new Date().toISOString().slice(0, 10);
      const [logs, execDecisions, acc] = await Promise.all([
        base44.entities.SyncExecutionLog.filter({ amazon_account_id: aid, operation: 'motor_v8_pipeline' }, '-started_at', 5),
        base44.entities.OptimizationDecision.filter({ amazon_account_id: aid, status: 'executed' }, '-created_date', 100),
        base44.entities.AmazonAccount.filter({ id: aid }, null, 1),
      ]);

      const lastLog = logs[0];
      const executedToday = execDecisions.filter(d => (d.created_date || d.created_at || '').slice(0, 10) === todayStr).length;

      let lastCycleDecisions = 0;
      if (lastLog?.result_summary) {
        try {
          const s = JSON.parse(lastLog.result_summary);
          lastCycleDecisions = (s.final?.total_decisions || 0);
        } catch {}
      }

      setKpis({
        lastRun: lastLog?.completed_at || lastLog?.started_at,
        decisionsLastCycle: lastCycleDecisions,
        executedToday,
        tokenStatus: acc[0]?.ads_token_status || account?.ads_token_status || 'unknown',
      });
    } catch {}
    finally { setLoadingKpis(false); }
  }, [aid]);

  useEffect(() => {
    loadKpis();
  }, [loadKpis]);

  // ── Polling do SyncExecutionLog ───────────────────────────────────────────
  const startPolling = useCallback((logId) => {
    if (pollingRef.current) clearInterval(pollingRef.current);

    pollingRef.current = setInterval(async () => {
      try {
        const logs = await base44.entities.SyncExecutionLog.filter({ id: logId }, null, 1);
        const log = logs[0];
        if (!log) return;

        let summary = {};
        try { summary = JSON.parse(log.result_summary || '{}'); } catch {}

        // Atualizar fases a partir do summary
        const newPhases = {};
        for (const p of ['phase1', 'phase2', 'phase3', 'phase4', 'phase5']) {
          if (summary[p]) newPhases[p] = summary[p];
        }
        setPhases(newPhases);

        if (['success', 'error', 'warning'].includes(log.status)) {
          clearInterval(pollingRef.current);
          if (elapsedRef.current) clearInterval(elapsedRef.current);
          setIsRunning(false);
          setFinalSummary(summary.final || null);
          loadKpis();
        }
      } catch {}
    }, 2000);
  }, [loadKpis]);

  // ── Timer de tempo decorrido ──────────────────────────────────────────────
  const startElapsed = () => {
    startTimeRef.current = Date.now();
    if (elapsedRef.current) clearInterval(elapsedRef.current);
    elapsedRef.current = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
  };

  // ── Executar Motor ────────────────────────────────────────────────────────
  const handleRun = async (force = false) => {
    if (!account || isRunning) return;
    setIsRunning(true);
    setPhases({});
    setFinalSummary(null);
    setRunError(null);
    setElapsedSec(0);
    startElapsed();

    try {
      const res = await base44.functions.invoke('runMotorImediato', {
        amazon_account_id: account.id,
        force,
      });
      const data = res?.data || res;

      if (data?.locked) {
        setRunError({ message: data.message, locked: true });
        setIsRunning(false);
        if (elapsedRef.current) clearInterval(elapsedRef.current);
        return;
      }

      if (!data?.ok || !data?.correlation_id) {
        setRunError({ message: data?.error || data?.message || 'Falha ao iniciar motor' });
        setIsRunning(false);
        if (elapsedRef.current) clearInterval(elapsedRef.current);
        return;
      }

      setCorrelationId(data.correlation_id);
      setSyncLogId(data.sync_log_id);

      if (data.sync_log_id) {
        startPolling(data.sync_log_id);
      }
    } catch (e) {
      setRunError({ message: e.message });
      setIsRunning(false);
      if (elapsedRef.current) clearInterval(elapsedRef.current);
    }
  };

  // ── Carregar decisões do ciclo ────────────────────────────────────────────
  const loadDecisions = async () => {
    if (!correlationId) return;
    setShowDecisions(true);
    try {
      const decs = await base44.entities.OptimizationDecision.filter(
        { amazon_account_id: aid, run_id: correlationId }, '-created_date', 50
      );
      setRecentDecisions(decs);
    } catch {}
  };

  // Cleanup
  useEffect(() => {
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
      if (elapsedRef.current) clearInterval(elapsedRef.current);
    };
  }, []);

  const tokenOk = ['active', 'valid'].includes(kpis.tokenStatus);
  const tokenExpired = ['expired', 'revoked', 'missing'].includes(kpis.tokenStatus);

  const allPhasesData = PHASES.map(p => ({ ...p, data: phases[p.id] }));
  const completedPhases = allPhasesData.filter(p => ['success', 'warning', 'error', 'skipped'].includes(p.data?.status)).length;

  return (
    <div className="space-y-4">

      {/* ── KPI Cards + Botão ──────────────────────────────────────────────── */}
      <div className="flex items-start gap-3 flex-wrap lg:flex-nowrap">
        {/* KPI cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 flex-1">
          <div className="bg-surface-1 border border-surface-2 rounded-xl p-3">
            <p className="text-[10px] text-slate-500 mb-1">Última Execução</p>
            <p className="text-xs font-semibold text-white">
              {loadingKpis ? '...' : kpis.lastRun
                ? new Date(kpis.lastRun).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
                : 'Nunca executado'}
            </p>
          </div>
          <div className="bg-surface-1 border border-surface-2 rounded-xl p-3">
            <p className="text-[10px] text-slate-500 mb-1">Decisões Geradas</p>
            <p className="text-xl font-bold text-cyan">{loadingKpis ? '...' : kpis.decisionsLastCycle}</p>
          </div>
          <div className="bg-surface-1 border border-surface-2 rounded-xl p-3">
            <p className="text-[10px] text-slate-500 mb-1">Executadas Hoje</p>
            <p className={`text-xl font-bold ${kpis.executedToday > 0 ? 'text-emerald-400' : 'text-slate-500'}`}>
              {loadingKpis ? '...' : kpis.executedToday}
            </p>
          </div>
          <div className={`rounded-xl p-3 border ${tokenOk ? 'bg-emerald-500/5 border-emerald-500/20' : tokenExpired ? 'bg-red-500/5 border-red-500/20' : 'bg-surface-1 border-surface-2'}`}>
            <p className="text-[10px] text-slate-500 mb-1">Token Amazon Ads</p>
            <p className={`text-xs font-bold ${tokenOk ? 'text-emerald-400' : tokenExpired ? 'text-red-400' : 'text-amber-400'}`}>
              {loadingKpis ? '...' : tokenOk ? 'Válido' : tokenExpired ? 'Expirado' : kpis.tokenStatus}
            </p>
          </div>
        </div>

        {/* Botão executar */}
        <div className="flex flex-col gap-2 flex-shrink-0">
          <button
            onClick={() => handleRun(false)}
            disabled={isRunning || tokenExpired}
            className={`flex items-center gap-2 px-5 py-3 rounded-xl text-sm font-bold border transition-all ${
              isRunning
                ? 'bg-cyan/10 border-cyan/30 text-cyan cursor-not-allowed'
                : tokenExpired
                ? 'bg-surface-2 border-surface-3 text-slate-500 cursor-not-allowed'
                : 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25'
            }`}
          >
            {isRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            {isRunning ? `Executando... ${elapsedSec}s` : 'Executar Motor Agora'}
          </button>
          {tokenExpired && (
            <Link to="/amazon-oauth-setup" className="text-[10px] text-red-400 hover:text-red-300 text-center">
              Token expirado → Reconectar
            </Link>
          )}
        </div>
      </div>

      {/* ── Erro de lock / inicialização ──────────────────────────────────── */}
      {runError && (
        <div className={`rounded-xl border px-4 py-3 flex items-start gap-3 ${runError.locked ? 'bg-amber-500/5 border-amber-500/20' : 'bg-red-500/5 border-red-500/20'}`}>
          <AlertTriangle className={`w-4 h-4 flex-shrink-0 mt-0.5 ${runError.locked ? 'text-amber-400' : 'text-red-400'}`} />
          <div className="flex-1">
            <p className={`text-xs font-semibold ${runError.locked ? 'text-amber-300' : 'text-red-300'}`}>{runError.message}</p>
            {runError.locked && (
              <button
                onClick={() => handleRun(true)}
                disabled={isRunning}
                className="mt-2 text-[11px] px-3 py-1.5 bg-amber-500/15 border border-amber-500/30 text-amber-300 rounded-lg hover:bg-amber-500/25"
              >
                Forçar nova execução (force=true)
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Progresso das Fases ───────────────────────────────────────────── */}
      {(isRunning || Object.keys(phases).length > 0) && (
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Zap className="w-4 h-4 text-cyan" />
              Pipeline Motor v8
              {correlationId && <span className="text-[10px] text-slate-500 font-mono">#{correlationId.slice(0, 12)}</span>}
            </h3>
            {isRunning && (
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-cyan">{completedPhases}/5 fases</span>
                <div className="w-24 h-1.5 bg-surface-3 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-cyan rounded-full transition-all duration-500"
                    style={{ width: `${(completedPhases / 5) * 100}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="space-y-2">
            {allPhasesData.map(phase => (
              <PhaseRow key={phase.id} phase={phase} data={phase.data} />
            ))}
          </div>
        </div>
      )}

      {/* ── Banner de conclusão ───────────────────────────────────────────── */}
      {!isRunning && finalSummary && (
        <div className={`rounded-xl border px-4 py-4 space-y-3 ${
          finalSummary.status === 'success' ? 'bg-emerald-500/8 border-emerald-500/25' :
          finalSummary.status === 'warning' ? 'bg-amber-500/8 border-amber-500/25' :
          'bg-red-500/8 border-red-500/25'
        }`}>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-2">
              {finalSummary.status === 'success' ? <CheckCircle className="w-5 h-5 text-emerald-400" /> :
               finalSummary.status === 'warning' ? <AlertTriangle className="w-5 h-5 text-amber-400" /> :
               <XCircle className="w-5 h-5 text-red-400" />}
              <p className={`text-sm font-bold ${
                finalSummary.status === 'success' ? 'text-emerald-300' :
                finalSummary.status === 'warning' ? 'text-amber-300' : 'text-red-300'
              }`}>
                Ciclo concluído — {finalSummary.executed || 0} decisões executadas
              </p>
            </div>
            {finalSummary.duration_total_ms && (
              <span className="text-[10px] text-slate-500">{(finalSummary.duration_total_ms / 1000).toFixed(1)}s total</span>
            )}
          </div>

          {/* Breakdown por tipo */}
          <div className="flex items-center gap-2 flex-wrap">
            {finalSummary.motor_decisions > 0 && (
              <span className="text-[11px] px-2.5 py-1 bg-cyan/10 border border-cyan/20 text-cyan rounded-full font-semibold">
                Motor: {finalSummary.motor_decisions} decisões
              </span>
            )}
            {finalSummary.ai_decisions > 0 && (
              <span className="text-[11px] px-2.5 py-1 bg-blue-500/10 border border-blue-500/20 text-blue-400 rounded-full font-semibold">
                IA: {finalSummary.ai_decisions} decisões
              </span>
            )}
            {finalSummary.executed > 0 && (
              <span className="text-[11px] px-2.5 py-1 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-full font-semibold">
                ✓ {finalSummary.executed} executadas
              </span>
            )}
            {finalSummary.failed > 0 && (
              <span className="text-[11px] px-2.5 py-1 bg-red-500/10 border border-red-500/20 text-red-400 rounded-full font-semibold">
                ✗ {finalSummary.failed} falhas
              </span>
            )}
          </div>

          {/* Botões de ação */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={loadDecisions}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-xs rounded-lg transition-colors"
            >
              <Eye className="w-3.5 h-3.5" />
              Ver Decisões
            </button>
            <button
              onClick={() => { setFinalSummary(null); setPhases({}); setCorrelationId(null); loadKpis(); }}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-xs rounded-lg transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Limpar
            </button>
          </div>
        </div>
      )}

      {/* ── Drawer de Decisões ────────────────────────────────────────────── */}
      {showDecisions && (
        <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-surface-2 flex items-center justify-between">
            <p className="text-sm font-semibold text-white">Decisões do Ciclo ({recentDecisions.length})</p>
            <button onClick={() => setShowDecisions(false)} className="text-xs text-slate-500 hover:text-slate-300">Fechar</button>
          </div>
          {recentDecisions.length === 0 ? (
            <div className="py-10 text-center text-sm text-slate-500">Nenhuma decisão encontrada</div>
          ) : (
            <div className="max-h-96 overflow-y-auto scrollbar-thin divide-y divide-surface-2/50">
              {recentDecisions.map(d => (
                <div key={d.id} className="px-4 py-3 flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-semibold text-white truncate">{d.keyword_text || d.action || d.decision_type || '—'}</span>
                      {d.source_function === 'motor_v8_ai_layer' && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded border bg-blue-500/15 border-blue-500/25 text-blue-400 font-bold">IA</span>
                      )}
                    </div>
                    <p className="text-[10px] text-slate-500 mt-0.5 truncate">{d.rationale?.slice(0, 100)}</p>
                    {d.value_before != null && d.value_after != null && (
                      <p className="text-[10px] text-slate-400 mt-0.5">
                        R${Number(d.value_before).toFixed(2)} → R${Number(d.value_after).toFixed(2)}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold ${
                      d.status === 'executed' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' :
                      d.status === 'failed' ? 'bg-red-500/10 border-red-500/20 text-red-400' :
                      'bg-amber-500/10 border-amber-500/20 text-amber-400'
                    }`}>{d.status}</span>
                    {d.risk && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${
                        d.risk === 'high' ? 'bg-red-500/10 border-red-500/20 text-red-400' :
                        d.risk === 'medium' ? 'bg-amber-500/10 border-amber-500/20 text-amber-400' :
                        'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                      }`}>{d.risk}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}