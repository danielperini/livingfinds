import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Zap, Loader2, CheckCircle, XCircle, Clock, AlertTriangle,
  ChevronDown, ChevronRight, ExternalLink, RefreshCw,
  Bot, Database, Cpu, Send, RotateCcw, Eye, Activity
} from 'lucide-react';
import { Link } from 'react-router-dom';

// ── Fases do pipeline ─────────────────────────────────────────────────────────
const PHASES = [
  { id: 'phase1', number: 1, name: 'Sync de Dados',        icon: Database,  description: 'Atualiza campanhas, keywords e métricas da Amazon Ads' },
  { id: 'phase2', number: 2, name: 'Motor Determinístico', icon: Cpu,        description: 'Gera decisões com guardrails v8 (winner protection, ACoS ponderado)' },
  { id: 'phase3', number: 3, name: 'Análise IA',           icon: Bot,        description: 'Camada IA complementar — analisa dados dos últimos 14d', isAi: true },
  { id: 'phase4', number: 4, name: 'Execução Amazon Ads',  icon: Send,       description: 'Aplica decisões via API: bids, budgets, pausas' },
  { id: 'phase5', number: 5, name: 'Confirmação',          icon: RotateCcw,  description: 'Reconcilia estado local vs Amazon Ads' },
];

function PhaseStatusIcon({ status }) {
  if (status === 'running') return <Loader2 className="w-4 h-4 text-cyan animate-spin flex-shrink-0" />;
  if (status === 'success') return <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0" />;
  if (status === 'error')   return <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />;
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
      status === 'error'   ? 'border-red-500/30 bg-red-500/5' :
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
        <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 ${
          status === 'success' ? 'bg-emerald-500/20 text-emerald-400' :
          status === 'error'   ? 'bg-red-500/20 text-red-400' :
          status === 'running' ? 'bg-cyan/20 text-cyan' :
          status === 'warning' ? 'bg-amber-500/20 text-amber-400' :
          'bg-surface-3 text-slate-500'
        }`}>{phase.number}</div>

        <PhaseStatusIcon status={status} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-sm font-semibold ${
              status === 'success' ? 'text-emerald-300' :
              status === 'error'   ? 'text-red-300' :
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
              <span className="text-[10px] text-emerald-400/70">
                {data.executed} executadas{data.failed > 0 ? ` · ${data.failed} falhas` : ''}
              </span>
            )}
            {(status === 'warning' || status === 'skipped') && data?.ai_error && (
              <span className="text-[10px] text-amber-400/70">{data.ai_error}</span>
            )}
          </div>
          <p className="text-[10px] text-slate-500 mt-0.5">{phase.description}</p>
        </div>

        {data?.duration_ms != null && (
          <span className="text-[10px] text-slate-500 flex-shrink-0">
            {data.duration_ms > 1000 ? `${(data.duration_ms / 1000).toFixed(1)}s` : `${data.duration_ms}ms`}
          </span>
        )}

        {hasDetail && (
          expanded
            ? <ChevronDown className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
            : <ChevronRight className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
        )}
      </button>

      {expanded && hasDetail && (
        <div className="px-4 pb-3 space-y-2">
          {hasError && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 space-y-1">
              <p className="text-[11px] font-bold text-red-400">Erro:</p>
              <p className="text-[11px] text-red-300/80 break-all">{data.error}</p>
              {data.amazon_status && <p className="text-[10px] text-slate-500">HTTP Status: {data.amazon_status}</p>}
              {data.amazon_error && <p className="text-[10px] text-slate-500">Amazon: {data.amazon_error}</p>}
              {data.retryable === false && data.link && (
                <Link to={data.link} className="inline-flex items-center gap-1 text-[11px] text-red-400 hover:text-red-300 mt-1">
                  <ExternalLink className="w-3 h-3" /> Reconectar Amazon Ads
                </Link>
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
  const [phases, setPhases] = useState({});
  const [lastSummary, setLastSummary] = useState(null);
  const [lastLogStatus, setLastLogStatus] = useState(null);
  const [correlationId, setCorrelationId] = useState(null);
  const [showDecisions, setShowDecisions] = useState(false);
  const [recentDecisions, setRecentDecisions] = useState([]);
  const [kpis, setKpis] = useState({ lastRun: null, decisionsLastCycle: 0, executedToday: 0, tokenStatus: 'unknown' });
  const [loading, setLoading] = useState(true);

  const aid = account?.id;

  // Próxima execução automática (a cada hora cheia)
  const nextAutoRun = (() => {
    const now = new Date();
    const next = new Date(now);
    next.setMinutes(0, 0, 0);
    next.setHours(next.getHours() + 1);
    const diffMin = Math.round((next - now) / 60000);
    return diffMin <= 1 ? 'menos de 1 min' : `${diffMin} min`;
  })();

  const load = useCallback(async () => {
    if (!aid) return;
    setLoading(true);
    try {
      const todayStr = new Date().toISOString().slice(0, 10);
      const [aggLogs, pipelineLogs, execDecisions, acc] = await Promise.all([
        base44.entities.SyncExecutionLog.filter({ amazon_account_id: aid, operation: 'aggressive_execution_pipeline' }, '-started_at', 3),
        base44.entities.SyncExecutionLog.filter({ amazon_account_id: aid, operation: 'motor_v8_pipeline' }, '-started_at', 3),
        base44.entities.OptimizationDecision.filter({ amazon_account_id: aid, status: 'executed' }, '-created_date', 100),
        base44.entities.AmazonAccount.filter({ id: aid }, null, 1),
      ]);

      // Último ciclo: preferir motor_v8_pipeline, fallback para aggressive_execution_pipeline
      const allLogs = [...pipelineLogs, ...aggLogs].sort(
        (a, b) => new Date(b.started_at || b.created_date) - new Date(a.started_at || a.created_date)
      );
      const lastLog = allLogs[0];
      setLastLogStatus(lastLog?.status || null);

      let summary = {};
      if (lastLog?.result_summary) {
        try { summary = JSON.parse(lastLog.result_summary); } catch {}
      }

      // Extrair fases do último log
      const newPhases = {};
      for (const p of ['phase1', 'phase2', 'phase3', 'phase4', 'phase5']) {
        if (summary[p]) newPhases[p] = summary[p];
      }
      setPhases(newPhases);
      setLastSummary(summary.final || null);
      if (summary.correlation_id) setCorrelationId(summary.correlation_id);

      const executedToday = execDecisions.filter(d => (d.created_date || d.created_at || '').slice(0, 10) === todayStr).length;
      const lastCycleDecisions = summary.final?.total_decisions || 0;

      setKpis({
        lastRun: lastLog?.completed_at || lastLog?.started_at,
        decisionsLastCycle: lastCycleDecisions,
        executedToday,
        tokenStatus: acc[0]?.ads_token_status || account?.ads_token_status || 'unknown',
      });
    } catch {}
    finally { setLoading(false); }
  }, [aid]);

  useEffect(() => { load(); }, [load]);
  // Refrescar a cada 2 minutos (o pipeline roda a cada hora — polling leve)
  useEffect(() => {
    const t = setInterval(load, 120000);
    return () => clearInterval(t);
  }, [load]);

  const loadDecisions = async () => {
    if (!correlationId) return;
    setShowDecisions(v => !v);
    if (recentDecisions.length > 0) return;
    try {
      const decs = await base44.entities.OptimizationDecision.filter(
        { amazon_account_id: aid, run_id: correlationId }, '-created_date', 50
      );
      setRecentDecisions(decs);
    } catch {}
  };

  const tokenOk      = ['active', 'valid'].includes(kpis.tokenStatus);
  const tokenExpired = ['expired', 'revoked', 'missing'].includes(kpis.tokenStatus);
  const allPhasesData = PHASES.map(p => ({ ...p, data: phases[p.id] }));
  const hasPhaseData  = Object.keys(phases).length > 0;

  // Status geral do último ciclo
  const cycleStatusColor =
    lastLogStatus === 'success' ? 'text-emerald-400' :
    lastLogStatus === 'warning' ? 'text-amber-400' :
    lastLogStatus === 'error'   ? 'text-red-400' :
    'text-slate-500';

  const cycleStatusLabel =
    lastLogStatus === 'success' ? 'Último ciclo: OK' :
    lastLogStatus === 'warning' ? 'Último ciclo: com avisos' :
    lastLogStatus === 'error'   ? 'Último ciclo: com erros' :
    'Aguardando primeiro ciclo';

  return (
    <div className="space-y-4">

      {/* ── Cabeçalho automático ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5 text-emerald-400" />
            <span className="text-xs font-semibold text-emerald-300">Automático — executa a cada hora</span>
          </div>
          <span className="text-[10px] text-slate-500">Próxima: ~{nextAutoRun}</span>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white text-xs rounded-lg transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          Atualizar
        </button>
      </div>

      {/* ── KPI Cards ────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-3">
          <p className="text-[10px] text-slate-500 mb-1">Último Ciclo</p>
          <p className="text-xs font-semibold text-white">
            {loading ? '...' : kpis.lastRun
              ? new Date(kpis.lastRun).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
              : 'Sem histórico'}
          </p>
          <p className={`text-[10px] font-semibold mt-0.5 ${cycleStatusColor}`}>{cycleStatusLabel}</p>
        </div>
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-3">
          <p className="text-[10px] text-slate-500 mb-1">Decisões Geradas</p>
          <p className="text-xl font-bold text-cyan">{loading ? '...' : kpis.decisionsLastCycle}</p>
          <p className="text-[10px] text-slate-500">último ciclo</p>
        </div>
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-3">
          <p className="text-[10px] text-slate-500 mb-1">Executadas Hoje</p>
          <p className={`text-xl font-bold ${kpis.executedToday > 0 ? 'text-emerald-400' : 'text-slate-500'}`}>
            {loading ? '...' : kpis.executedToday}
          </p>
          <p className="text-[10px] text-slate-500">ações confirmadas</p>
        </div>
        <div className={`rounded-xl p-3 border ${
          tokenOk ? 'bg-emerald-500/5 border-emerald-500/20' :
          tokenExpired ? 'bg-red-500/5 border-red-500/20' :
          'bg-surface-1 border-surface-2'
        }`}>
          <p className="text-[10px] text-slate-500 mb-1">Token Amazon Ads</p>
          <p className={`text-xs font-bold ${tokenOk ? 'text-emerald-400' : tokenExpired ? 'text-red-400' : 'text-amber-400'}`}>
            {loading ? '...' : tokenOk ? 'Válido' : tokenExpired ? 'Expirado' : kpis.tokenStatus}
          </p>
          {tokenExpired && (
            <Link to="/amazon-oauth-setup" className="text-[10px] text-red-400 hover:text-red-300 mt-0.5 block">
              → Reconectar
            </Link>
          )}
        </div>
      </div>

      {/* ── Status das fases do último ciclo ─────────────────────────────── */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-4 space-y-2">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <Zap className="w-4 h-4 text-cyan" />
            Fases do Último Ciclo
            {correlationId && (
              <span className="text-[10px] text-slate-500 font-mono">#{correlationId.slice(0, 12)}</span>
            )}
          </h3>
          {hasPhaseData && lastSummary && (
            <button
              onClick={loadDecisions}
              className="flex items-center gap-1.5 text-[10px] px-2.5 py-1 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors"
            >
              <Eye className="w-3 h-3" />
              {showDecisions ? 'Ocultar decisões' : 'Ver decisões'}
            </button>
          )}
        </div>

        {!hasPhaseData && !loading ? (
          <div className="flex flex-col items-center justify-center py-8 gap-2">
            <Clock className="w-8 h-8 text-slate-700" />
            <p className="text-sm text-slate-500">Nenhum ciclo registrado ainda</p>
            <p className="text-xs text-slate-600">O motor executa automaticamente a cada hora</p>
          </div>
        ) : loading && !hasPhaseData ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 text-cyan animate-spin" />
          </div>
        ) : (
          <div className="space-y-2">
            {allPhasesData.map(phase => (
              <PhaseRow key={phase.id} phase={phase} data={phase.data} />
            ))}
          </div>
        )}

        {/* Resumo do ciclo */}
        {lastSummary && (
          <div className={`mt-3 rounded-xl border px-4 py-3 flex items-center gap-3 flex-wrap ${
            lastSummary.status === 'success' ? 'border-emerald-500/20 bg-emerald-500/5' :
            lastSummary.status === 'warning' ? 'border-amber-500/20 bg-amber-500/5' :
            'border-red-500/20 bg-red-500/5'
          }`}>
            {lastSummary.status === 'success' ? <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0" /> :
             lastSummary.status === 'warning' ? <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" /> :
             <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />}
            <div className="flex items-center gap-2 flex-wrap flex-1">
              {lastSummary.motor_decisions > 0 && (
                <span className="text-[11px] px-2 py-0.5 bg-cyan/10 border border-cyan/20 text-cyan rounded-full font-semibold">
                  Motor: {lastSummary.motor_decisions}
                </span>
              )}
              {lastSummary.ai_decisions > 0 && (
                <span className="text-[11px] px-2 py-0.5 bg-blue-500/10 border border-blue-500/20 text-blue-400 rounded-full font-semibold">
                  IA: {lastSummary.ai_decisions}
                </span>
              )}
              {lastSummary.executed > 0 && (
                <span className="text-[11px] px-2 py-0.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-full font-semibold">
                  ✓ {lastSummary.executed} executadas
                </span>
              )}
              {lastSummary.failed > 0 && (
                <span className="text-[11px] px-2 py-0.5 bg-red-500/10 border border-red-500/20 text-red-400 rounded-full font-semibold">
                  ✗ {lastSummary.failed} falhas
                </span>
              )}
              {lastSummary.duration_total_ms && (
                <span className="text-[10px] text-slate-500 ml-auto">
                  {(lastSummary.duration_total_ms / 1000).toFixed(1)}s
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Decisões do ciclo ─────────────────────────────────────────────── */}
      {showDecisions && (
        <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-surface-2 flex items-center justify-between">
            <p className="text-sm font-semibold text-white">Decisões do Ciclo ({recentDecisions.length})</p>
            <button onClick={() => setShowDecisions(false)} className="text-xs text-slate-500 hover:text-slate-300">Fechar</button>
          </div>
          {recentDecisions.length === 0 ? (
            <div className="py-10 text-center text-sm text-slate-500">Nenhuma decisão encontrada para este ciclo</div>
          ) : (
            <div className="max-h-96 overflow-y-auto scrollbar-thin divide-y divide-surface-2/50">
              {recentDecisions.map(d => (
                <div key={d.id} className="px-4 py-3 flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-semibold text-white truncate">
                        {d.keyword_text || d.action || d.decision_type || '—'}
                      </span>
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
                      d.status === 'failed'   ? 'bg-red-500/10 border-red-500/20 text-red-400' :
                      'bg-amber-500/10 border-amber-500/20 text-amber-400'
                    }`}>{d.status}</span>
                    {d.risk && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${
                        d.risk === 'high'   ? 'bg-red-500/10 border-red-500/20 text-red-400' :
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