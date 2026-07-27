/**
 * EngineMotorsPanel
 * Painel compacto com dois cards: Bid Rescue Engine | Auto Campaign Cleanup
 * Cada card: último resultado (do SyncExecutionLog) + badge de status + botão Executar Agora
 */
import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Zap, Trash2, Loader2, CheckCircle, XCircle, AlertTriangle,
  Play, ChevronDown, ChevronUp, Clock
} from 'lucide-react';

function parseResult(log) {
  if (!log) return null;
  const summary = log.result_summary || '';
  // bid_rescue: "N keywords corrigidas de M elegíveis (T analisadas)."
  const rescueMatch = summary.match(/(\d+) keywords corrigidas/);
  if (rescueMatch) return { type: 'rescue', fixed: parseInt(rescueMatch[1]) };
  // cleanup: "archived_dup:N paused_manual:M archived_zero:P ..."
  const dupMatch = summary.match(/archived_dup:(\d+)/);
  const pausedMatch = summary.match(/paused_manual:(\d+)/);
  const zeroMatch = summary.match(/archived_zero:(\d+)/);
  if (dupMatch || pausedMatch || zeroMatch) {
    return {
      type: 'cleanup',
      archived_dup: parseInt(dupMatch?.[1] || '0'),
      paused: parseInt(pausedMatch?.[1] || '0'),
      archived_zero: parseInt(zeroMatch?.[1] || '0'),
    };
  }
  return null;
}

function StatusBadge({ status }) {
  if (status === 'success' || status === 'completed') return (
    <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border bg-emerald-500/10 border-emerald-500/20 text-emerald-400 font-bold">
      <CheckCircle className="w-2.5 h-2.5" /> OK
    </span>
  );
  if (status === 'error') return (
    <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border bg-red-500/10 border-red-500/20 text-red-400 font-bold">
      <XCircle className="w-2.5 h-2.5" /> Erro
    </span>
  );
  if (status === 'partial') return (
    <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border bg-amber-500/10 border-amber-500/20 text-amber-400 font-bold">
      <AlertTriangle className="w-2.5 h-2.5" /> Parcial
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border bg-slate-500/10 border-slate-500/20 text-slate-400 font-bold">
      <Clock className="w-2.5 h-2.5" /> —
    </span>
  );
}

function EngineCard({ title, icon: Icon, iconColor, borderColor, operation, fnName, account }) {
  const [log, setLog] = useState(null);
  const [loadingLog, setLoadingLog] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState(null);

  const loadLog = useCallback(async () => {
    if (!account) return;
    setLoadingLog(true);
    try {
      const logs = await base44.entities.SyncExecutionLog.filter(
        { amazon_account_id: account.id, operation },
        '-started_at', 1
      );
      setLog(logs[0] || null);
    } catch (_) {}
    finally { setLoadingLog(false); }
  }, [account, operation]);

  useEffect(() => { loadLog(); }, [loadLog]);

  const runNow = async () => {
    if (!account || running) return;
    setRunning(true);
    setResult(null);
    setError(null);
    setExpanded(true);
    try {
      const res = await base44.functions.invoke(fnName, {
        amazon_account_id: account.id,
        trigger_type: 'manual',
      });
      const data = res?.data || res;
      setResult(data);
      await loadLog();
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  const parsed = parseResult(log);
  const lastDate = log?.completed_at || log?.started_at;

  return (
    <div className={`bg-surface-1 border ${borderColor} rounded-xl p-4 space-y-3`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className={`w-7 h-7 rounded-lg ${iconColor} flex items-center justify-center flex-shrink-0`}>
            <Icon className="w-3.5 h-3.5" />
          </div>
          <p className="text-xs font-bold text-white">{title}</p>
        </div>
        <div className="flex items-center gap-2">
          {!loadingLog && <StatusBadge status={log?.status} />}
          <button
            onClick={runNow}
            disabled={running || !account}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-cyan/10 border border-cyan/25 text-cyan hover:bg-cyan/20 text-[10px] font-bold rounded-lg disabled:opacity-50 transition-colors"
          >
            {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
            {running ? 'Executando...' : 'Executar Agora'}
          </button>
        </div>
      </div>

      {/* Último resultado */}
      {loadingLog ? (
        <div className="h-8 bg-surface-2 rounded animate-pulse" />
      ) : log ? (
        <div className="space-y-1">
          {parsed?.type === 'rescue' && (
            <p className="text-xs text-slate-300">
              <span className="font-bold text-amber-400">{parsed.fixed}</span> keywords corrigidas
            </p>
          )}
          {parsed?.type === 'cleanup' && (
            <div className="flex items-center gap-3 text-xs">
              <span><span className="font-bold text-red-400">{parsed.archived_dup}</span> <span className="text-slate-500">dup. arquivadas</span></span>
              <span><span className="font-bold text-amber-400">{parsed.paused}</span> <span className="text-slate-500">pausadas</span></span>
              <span><span className="font-bold text-slate-400">{parsed.archived_zero}</span> <span className="text-slate-500">zero-ativ. arquivadas</span></span>
            </div>
          )}
          {!parsed && (
            <p className="text-xs text-slate-500 truncate">{log.result_summary || '—'}</p>
          )}
          {lastDate && (
            <p className="text-[10px] text-slate-600">
              {new Date(lastDate).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
            </p>
          )}
        </div>
      ) : (
        <p className="text-xs text-slate-500">Nenhuma execução registrada</p>
      )}

      {/* Resultado da execução manual */}
      {(result || error) && (
        <div>
          <button
            onClick={() => setExpanded(v => !v)}
            className="flex items-center gap-1 text-[10px] text-slate-400 hover:text-slate-300 transition-colors"
          >
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {expanded ? 'Ocultar resultado' : 'Ver resultado'}
          </button>

          {expanded && (
            <div className="mt-2 space-y-2">
              {error && (
                <div className="px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">
                  {error}
                </div>
              )}
              {result && !error && (
                <div className="px-3 py-2.5 bg-surface-2 rounded-lg space-y-1.5 text-xs">
                  {result.total_fixed != null && (
                    <div className="flex justify-between">
                      <span className="text-slate-400">Keywords corrigidas</span>
                      <span className="font-bold text-amber-400">{result.total_fixed}</span>
                    </div>
                  )}
                  {result.total_eligible != null && (
                    <div className="flex justify-between">
                      <span className="text-slate-400">Elegíveis</span>
                      <span className="text-slate-300">{result.total_eligible}</span>
                    </div>
                  )}
                  {result.total_analyzed != null && (
                    <div className="flex justify-between">
                      <span className="text-slate-400">Analisadas</span>
                      <span className="text-slate-300">{result.total_analyzed}</span>
                    </div>
                  )}
                  {result.archived_duplicates != null && (
                    <div className="flex justify-between">
                      <span className="text-slate-400">Dup. arquivadas</span>
                      <span className="font-bold text-red-400">{result.archived_duplicates}</span>
                    </div>
                  )}
                  {result.paused_has_manual != null && (
                    <div className="flex justify-between">
                      <span className="text-slate-400">Pausadas (tem manual)</span>
                      <span className="font-bold text-amber-400">{result.paused_has_manual}</span>
                    </div>
                  )}
                  {result.archived_zero_activity != null && (
                    <div className="flex justify-between">
                      <span className="text-slate-400">Zero-atividade arquivadas</span>
                      <span className="font-bold text-slate-400">{result.archived_zero_activity}</span>
                    </div>
                  )}
                  {result.errors?.length > 0 && (
                    <div className="pt-1 border-t border-surface-3">
                      <p className="text-red-400 font-semibold mb-1">{result.errors.length} erro(s)</p>
                      {result.errors.slice(0, 3).map((e, i) => (
                        <p key={i} className="text-slate-500 truncate text-[10px]">{e.keyword || e.campaign}: {e.reason}</p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function EngineMotorsPanel({ account }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-xs font-bold text-slate-300">Motores Automáticos</p>
        <span className="text-[10px] text-slate-600">agendados diariamente · 08h e 06h BRT</span>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <EngineCard
          title="Bid Rescue Engine"
          icon={Zap}
          iconColor="bg-amber-500/15 border border-amber-500/30 text-amber-400"
          borderColor="border-amber-500/20"
          operation="bid_rescue_engine"
          fnName="runBidRescueEngine"
          account={account}
        />
        <EngineCard
          title="Auto Campaign Cleanup"
          icon={Trash2}
          iconColor="bg-red-500/15 border border-red-500/30 text-red-400"
          borderColor="border-red-500/20"
          operation="auto_campaign_cleanup"
          fnName="runAutoCampaignCleanup"
          account={account}
        />
      </div>
    </div>
  );
}