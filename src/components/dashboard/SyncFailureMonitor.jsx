import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { AlertTriangle, CheckCircle, RefreshCw, Wrench, ChevronDown, ChevronUp, Clock, Zap } from 'lucide-react';

const ERROR_LABELS = {
  lock:       { label: 'Lock travado',       color: 'text-orange-400', bg: 'bg-orange-500/10 border-orange-500/20', dot: 'bg-orange-400',  fix: 'unlockStuckSyncs' },
  auth:       { label: 'Token/Auth expirado', color: 'text-red-400',   bg: 'bg-red-500/10 border-red-500/20',       dot: 'bg-red-400',     fix: 'keepAmazonConnected' },
  amazon_api: { label: 'Amazon API',          color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/20',   dot: 'bg-amber-400',   fix: null },
  db:         { label: 'Conexão DB',          color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/20',   dot: 'bg-amber-400',   fix: null },
  report:     { label: 'Relatório Amazon',    color: 'text-violet-400',bg: 'bg-violet-500/10 border-violet-500/20', dot: 'bg-violet-400',  fix: null },
  other:      { label: 'Outro',               color: 'text-slate-400', bg: 'bg-slate-500/10 border-slate-500/20',   dot: 'bg-slate-400',   fix: null },
};

function classifyError(msg, operation) {
  const e = String(msg || '').toLowerCase();
  const op = String(operation || '').toLowerCase();
  if (e.includes('lock') || e.includes('liberado') || op.includes('lock')) return 'lock';
  if (e.includes('403') || e.includes('401') || e.includes('token') || e.includes('unauthorized') || e.includes('expired') || e.includes('refresh') || e.includes('not authorized') || e.includes('sp_api_reauthorization_required') || op.includes('token') || op.includes('auth') || op.includes('keepamazon') || op.includes('oauth')) return 'auth';
  if (e.includes('1042') || e.includes('connection')) return 'db';
  if (e.includes('relat') || e.includes('report') || e.includes('pending') || e.includes('425')) return 'report';
  if (op.includes('keyword') || op.includes('campaign') || op.includes('bid') || op.includes('adgroup') || op.includes('inventory') || op.includes('decision') || op.includes('sync') || op.includes('amazon') || op.includes('ads')) return 'amazon_api';
  return 'other';
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function logTime(log) {
  return new Date(log?.completed_at || log?.started_at || log?.created_date || 0).getTime();
}

function resultStatus(log) {
  try { return Number(JSON.parse(log?.result_summary || '{}')?.status || 0); }
  catch { return 0; }
}

function expectedCatalogState(log) {
  const operation = String(log?.operation || '').toLowerCase();
  // Listings Items 404 = SKU não existe naquele marketplace. O chamador já
  // converte isso em offer_inactive; não é indisponibilidade da integração.
  return operation.includes('getlistingsitem') && resultStatus(log) === 404;
}

function benignLock(log) {
  const text = `${log?.error_message || ''} ${log?.result_summary || ''}`.toLowerCase();
  return text.includes('sync lock liberado') || text.includes('lock released') || text.includes('guardrail');
}

function operationKey(log) {
  return String(log?.operation || log?.sync_type || log?.job_name || 'unknown').trim().toLowerCase();
}

export default function SyncFailureMonitor({ amazonAccountId }) {
  const [logs, setLogs] = useState([]);
  const [historicalErrors, setHistoricalErrors] = useState(0);
  const [loading, setLoading] = useState(true);
  const [fixing, setFixing] = useState(false);
  const [fixingType, setFixingType] = useState(null);
  const [fixResult, setFixResult] = useState(null);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    if (!amazonAccountId) return;
    setLoading(true);
    try {
      const sinceMs = Date.now() - 7 * 86400000;
      // Precisamos ler sucesso + erro. Consultar só status=error mantinha falhas
      // já recuperadas eternamente no painel.
      const all = await base44.entities.SyncExecutionLog.filter(
        { amazon_account_id: amazonAccountId }, '-created_date', 500
      );
      const recent = (all || []).filter(log => logTime(log) >= sinceMs);
      const rawErrors = recent.filter(log => String(log.status).toLowerCase() === 'error');
      setHistoricalErrors(rawErrors.length);

      // A saúde operacional é o estado MAIS RECENTE de cada operação. Se houve
      // sucesso posterior, a falha histórica deixa de exigir atenção.
      const latestByOperation = new Map();
      [...recent].sort((a, b) => logTime(b) - logTime(a)).forEach(log => {
        const key = operationKey(log);
        if (!latestByOperation.has(key)) latestByOperation.set(key, log);
      });

      const active = [...latestByOperation.values()].filter(log =>
        String(log.status).toLowerCase() === 'error' &&
        !expectedCatalogState(log) &&
        !benignLock(log)
      );
      setLogs(active.sort((a, b) => logTime(b) - logTime(a)));
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [amazonAccountId]);

  useEffect(() => { load(); }, [load]);

  const groups = {};
  for (const log of logs) {
    const type = classifyError(log.error_message, log.operation);
    if (!groups[type]) groups[type] = { count: 0, operations: new Set(), lastError: '', lastAt: '' };
    groups[type].count++;
    groups[type].operations.add(log.operation || 'unknown');
    const at = log.completed_at || log.started_at || log.created_date || '';
    if (!groups[type].lastAt || at > groups[type].lastAt) {
      groups[type].lastAt = at;
      groups[type].lastError = log.error_message || '';
    }
  }

  const totalErrors = logs.length;
  const errorTypes = Object.keys(groups);

  const autoFix = async () => {
    setFixing(true);
    setFixResult(null);
    try {
      const res = await base44.functions.invoke('autoFixSyncFailures', { amazon_account_id: amazonAccountId });
      setFixResult(res?.data || {});
      await load();
    } catch (e) {
      setFixResult({ ok: false, error: e.message });
    } finally {
      setFixing(false);
    }
  };

  const fixType = async (type) => {
    const fn = ERROR_LABELS[type]?.fix;
    if (!fn) return;
    setFixingType(type);
    try {
      await base44.functions.invoke(fn, { amazon_account_id: amazonAccountId });
      await load();
    } catch (e) {
      console.error(e);
    } finally {
      setFixingType(null);
    }
  };

  if (loading) return null;
  if (totalErrors === 0 && !fixResult) return (
    <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl border bg-emerald-500/5 border-emerald-500/20 text-xs text-emerald-400">
      <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" />
      <span>Sincronização saudável — sem falhas ativas.{historicalErrors > 0 ? ` ${historicalErrors} ocorrência(s) histórica(s) nos últimos 7 dias já resolvida(s) ou não acionável(is).` : ''}</span>
    </div>
  );

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-2">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
          <span className="text-sm font-semibold text-white">Monitor de Falhas de Sincronização</span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 font-semibold border border-red-500/20">
            {totalErrors} falha(s) ativa(s)
          </span>
          {historicalErrors > totalErrors && <span className="text-[10px] text-slate-500">{historicalErrors} ocorrências em 7d</span>}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} disabled={loading} className="p-1.5 text-slate-500 hover:text-slate-300 transition-colors">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={autoFix} disabled={fixing || totalErrors === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border bg-cyan/10 border-cyan/25 text-cyan hover:bg-cyan/20 disabled:opacity-50 transition-colors">
            {fixing ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Wrench className="w-3 h-3" />}
            {fixing ? 'Corrigindo...' : 'Corrigir automaticamente'}
          </button>
          <button onClick={() => setExpanded(v => !v)} className="p-1.5 text-slate-500 hover:text-slate-300">
            {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {fixResult && (
        <div className={`mx-4 mt-3 px-3 py-2.5 rounded-lg border text-xs ${fixResult.ok ? 'bg-emerald-500/8 border-emerald-500/20 text-emerald-300' : 'bg-red-500/8 border-red-500/20 text-red-300'}`}>
          {fixResult.ok ? (
            <div className="flex flex-wrap gap-3 items-center">
              <span className="flex items-center gap-1"><Zap className="w-3 h-3" /><strong>{fixResult.fixed || 0}</strong> correções aplicadas em <strong>{fixResult.errors_found || 0}</strong> erros encontrados</span>
              {(fixResult.summary || []).filter(s => s.fixed > 0).map(s => (
                <span key={s.type} className="text-slate-300">· {ERROR_LABELS[s.type]?.label || s.type}: <span className="text-emerald-400">{s.fix_applied}</span></span>
              ))}
            </div>
          ) : <span>Erro ao corrigir: {fixResult.error}</span>}
        </div>
      )}

      <div className="p-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
        {errorTypes.map(type => {
          const g = groups[type];
          const meta = ERROR_LABELS[type] || ERROR_LABELS.other;
          return (
            <div key={type} className={`rounded-lg border px-3 py-2.5 ${meta.bg}`}>
              <div className="flex items-center gap-1.5 mb-1"><span className={`w-2 h-2 rounded-full flex-shrink-0 ${meta.dot}`} /><span className={`text-[10px] font-semibold uppercase tracking-wide ${meta.color}`}>{meta.label}</span></div>
              <p className={`text-xl font-bold ${meta.color}`}>{g.count}</p>
              <p className="text-[10px] text-slate-500 mt-0.5 truncate">{[...g.operations].slice(0, 2).join(', ')}</p>
              {meta.fix && <button onClick={() => fixType(type)} disabled={fixingType === type} className={`mt-1.5 flex items-center gap-1 text-[10px] font-semibold underline ${meta.color} disabled:opacity-50`}>
                {fixingType === type ? <RefreshCw className="w-2.5 h-2.5 animate-spin" /> : <Wrench className="w-2.5 h-2.5" />}{fixingType === type ? 'corrigindo...' : 'corrigir'}
              </button>}
            </div>
          );
        })}
      </div>

      {expanded && (
        <div className="border-t border-surface-2 divide-y divide-surface-2 max-h-64 overflow-y-auto scrollbar-thin">
          {logs.slice(0, 30).map(log => {
            const type = classifyError(log.error_message, log.operation);
            const meta = ERROR_LABELS[type] || ERROR_LABELS.other;
            return <div key={log.id} className="flex items-start gap-3 px-4 py-2.5 hover:bg-surface-2/40 transition-colors">
              <span className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${meta.dot}`} />
              <div className="flex-1 min-w-0"><div className="flex items-center gap-2 flex-wrap"><span className="text-[10px] font-semibold text-slate-400">{log.operation || 'unknown'}</span><span className={`text-[10px] ${meta.color}`}>{meta.label}</span></div><p className="text-[10px] text-slate-500 truncate mt-0.5">{log.error_message}</p></div>
              <div className="flex items-center gap-1 text-[9px] text-slate-600 flex-shrink-0"><Clock className="w-2.5 h-2.5" />{fmtDate(log.completed_at || log.started_at || log.created_date)}</div>
            </div>;
          })}
        </div>
      )}
    </div>
  );
}
