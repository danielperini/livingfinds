/**
 * EngineMotorsPanel
 * Dois cards: Bid Rescue Engine | Auto Campaign Cleanup
 *
 * Auto Campaign Cleanup:
 *   - Fase 1: dry_run=true → mostra preview por regra (a/b/c)
 *   - Fase 2: após ver preview, botão "Confirmar e Executar" dispara dry_run=false
 *   - Erros de API Amazon aparecem em vermelho com HTTP status
 */
import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Zap, Trash2, Loader2, CheckCircle, XCircle, AlertTriangle,
  Play, ChevronDown, ChevronUp, Clock, Eye, ShieldCheck
} from 'lucide-react';

function StatusBadge({ status }) {
  if (!status) return null;
  if (status === 'success' || status === 'completed')
    return <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border bg-emerald-500/10 border-emerald-500/20 text-emerald-400 font-bold"><CheckCircle className="w-2.5 h-2.5" />OK</span>;
  if (status === 'error')
    return <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border bg-red-500/10 border-red-500/20 text-red-400 font-bold"><XCircle className="w-2.5 h-2.5" />Erro</span>;
  if (status === 'partial')
    return <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border bg-amber-500/10 border-amber-500/20 text-amber-400 font-bold"><AlertTriangle className="w-2.5 h-2.5" />Parcial</span>;
  return <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border bg-slate-500/10 border-slate-500/20 text-slate-400 font-bold"><Clock className="w-2.5 h-2.5" />—</span>;
}

// ── Bid Rescue Card (simples: dry_run não faz sentido aqui) ──────────────
function BidRescueCard({ account }) {
  const [log, setLog]         = useState(null);
  const [loadingLog, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult]   = useState(null);
  const [error, setError]     = useState(null);
  const [expanded, setExpanded] = useState(false);

  const loadLog = useCallback(async () => {
    if (!account) return;
    setLoading(true);
    try {
      const logs = await base44.entities.SyncExecutionLog.filter(
        { amazon_account_id: account.id, operation: 'bid_rescue_engine' }, '-started_at', 1
      );
      setLog(logs[0] || null);
    } finally { setLoading(false); }
  }, [account]);

  useEffect(() => { loadLog(); }, [loadLog]);

  const run = async () => {
    if (!account || running) return;
    setRunning(true); setResult(null); setError(null); setExpanded(true);
    try {
      const res = await base44.functions.invoke('runBidRescueEngine', {
        amazon_account_id: account.id, trigger_type: 'manual',
      });
      const data = res?.data || res;
      setResult(data);
      await loadLog();
    } catch (e) { setError(e.message); }
    finally { setRunning(false); }
  };

  const lastDate = log?.completed_at || log?.started_at;
  const summary  = log?.result_summary || '';
  const fixedMatch = summary.match(/(\d+) keywords corrigidas/);

  return (
    <div className="bg-surface-1 border border-amber-500/20 rounded-xl p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center flex-shrink-0">
            <Zap className="w-3.5 h-3.5 text-amber-400" />
          </div>
          <p className="text-xs font-bold text-white">Bid Rescue Engine</p>
        </div>
        <div className="flex items-center gap-2">
          {!loadingLog && <StatusBadge status={log?.status} />}
          <button onClick={run} disabled={running || !account}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-cyan/10 border border-cyan/25 text-cyan hover:bg-cyan/20 text-[10px] font-bold rounded-lg disabled:opacity-50 transition-colors">
            {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
            {running ? 'Executando...' : 'Executar Agora'}
          </button>
        </div>
      </div>

      {loadingLog ? <div className="h-6 bg-surface-2 rounded animate-pulse" /> : log ? (
        <div className="space-y-0.5">
          {fixedMatch && <p className="text-xs text-slate-300"><span className="font-bold text-amber-400">{fixedMatch[1]}</span> keywords corrigidas</p>}
          {!fixedMatch && <p className="text-xs text-slate-500 truncate">{summary || '—'}</p>}
          {lastDate && <p className="text-[10px] text-slate-600">{new Date(lastDate).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</p>}
        </div>
      ) : <p className="text-xs text-slate-500">Nenhuma execução registrada</p>}

      {(result || error) && (
        <div>
          <button onClick={() => setExpanded(v => !v)} className="flex items-center gap-1 text-[10px] text-slate-400 hover:text-slate-300 transition-colors">
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {expanded ? 'Ocultar resultado' : 'Ver resultado'}
          </button>
          {expanded && (
            <div className="mt-2 space-y-1.5">
              {error && <div className="px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">{error}</div>}
              {result && !error && (
                <div className="px-3 py-2.5 bg-surface-2 rounded-lg space-y-1 text-xs">
                  <div className="flex justify-between"><span className="text-slate-400">Keywords corrigidas</span><span className="font-bold text-amber-400">{result.total_fixed ?? '—'}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">Elegíveis</span><span className="text-slate-300">{result.total_eligible ?? '—'}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">Analisadas</span><span className="text-slate-300">{result.total_analyzed ?? '—'}</span></div>
                  {result.errors?.length > 0 && (
                    <div className="pt-1 border-t border-surface-3">
                      <p className="text-red-400 font-semibold mb-1">{result.errors.length} erro(s)</p>
                      {result.errors.slice(0, 3).map((e, i) => (
                        <p key={i} className="text-[10px] text-slate-500 truncate">{e.keyword}: {e.reason}</p>
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

// ── Preview section por regra ────────────────────────────────────────────
function PreviewSection({ title, items, colorClass }) {
  const [open, setOpen] = useState(true);
  if (!items?.length) return null;
  return (
    <div className="border border-surface-3 rounded-lg overflow-hidden">
      <button onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-3 py-2 bg-surface-2/50 hover:bg-surface-2 transition-colors">
        <span className={`text-[10px] font-bold ${colorClass}`}>{title} ({items.length})</span>
        {open ? <ChevronUp className="w-3 h-3 text-slate-500" /> : <ChevronDown className="w-3 h-3 text-slate-500" />}
      </button>
      {open && (
        <div className="divide-y divide-surface-3/50 max-h-40 overflow-y-auto scrollbar-thin">
          {items.map((item, i) => (
            <div key={i} className="px-3 py-1.5 flex items-center justify-between gap-2 text-[10px]">
              <div className="flex-1 min-w-0">
                <p className="text-slate-300 truncate font-medium">{item.campaign}</p>
                <div className="flex items-center gap-2 text-slate-500 mt-0.5">
                  <span className="font-mono">{item.asin}</span>
                  {item.amazon_campaign_id && <span className="font-mono text-[9px] opacity-70">{item.amazon_campaign_id}</span>}
                </div>
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                {!item.has_amazon_id && <span className="text-red-400 font-bold">SEM ID</span>}
                {!item.passes_cooldown && <span className="text-amber-400">cooldown</span>}
                {item.manual_spend_14d > 0 && <span className="text-emerald-400">R${item.manual_spend_14d?.toFixed(0)}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Auto Campaign Cleanup Card (com preview flow) ────────────────────────
function CleanupCard({ account }) {
  const [log, setLog]                = useState(null);
  const [loadingLog, setLoadingLog]  = useState(true);
  const [phase, setPhase]            = useState('idle'); // idle | previewing | preview_done | executing | done
  const [previewData, setPreviewData] = useState(null);
  const [execResult, setExecResult]  = useState(null);
  const [error, setError]            = useState(null);
  const [showLog, setShowLog]        = useState(false);

  const loadLog = useCallback(async () => {
    if (!account) return;
    setLoadingLog(true);
    try {
      const logs = await base44.entities.SyncExecutionLog.filter(
        { amazon_account_id: account.id, operation: 'auto_campaign_cleanup' }, '-started_at', 1
      );
      setLog(logs[0] || null);
    } finally { setLoadingLog(false); }
  }, [account]);

  useEffect(() => { loadLog(); }, [loadLog]);

  const runPreview = async () => {
    if (!account) return;
    setPhase('previewing'); setError(null); setPreviewData(null); setExecResult(null);
    try {
      const res = await base44.functions.invoke('runAutoCampaignCleanup', {
        amazon_account_id: account.id, dry_run: true,
      });
      const data = res?.data || res;
      setPreviewData(data);
      setPhase('preview_done');
    } catch (e) {
      setError(e.message); setPhase('idle');
    }
  };

  const runExecute = async () => {
    if (!account) return;
    setPhase('executing'); setError(null);
    try {
      const res = await base44.functions.invoke('runAutoCampaignCleanup', {
        amazon_account_id: account.id, dry_run: false, trigger_type: 'manual',
      });
      const data = res?.data || res;
      setExecResult(data);
      setPhase('done');
      await loadLog();
    } catch (e) {
      setError(e.message); setPhase('preview_done');
    }
  };

  const reset = () => { setPhase('idle'); setPreviewData(null); setExecResult(null); setError(null); };

  const lastDate = log?.completed_at || log?.started_at;
  const summary  = log?.result_summary || '';
  const dupMatch    = summary.match(/archived_dup:(\d+)/);
  const pausedMatch = summary.match(/paused_manual:(\d+)/);
  const zeroMatch   = summary.match(/archived_zero:(\d+)/);
  const hasSummary  = dupMatch || pausedMatch || zeroMatch;

  const totalPreviewCandidates = previewData
    ? (previewData.preview?.rule_a?.length || 0) + (previewData.preview?.rule_b?.length || 0) + (previewData.preview?.rule_c?.length || 0)
    : 0;

  return (
    <div className="bg-surface-1 border border-red-500/20 rounded-xl p-4 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-red-500/15 border border-red-500/30 flex items-center justify-center flex-shrink-0">
            <Trash2 className="w-3.5 h-3.5 text-red-400" />
          </div>
          <p className="text-xs font-bold text-white">Auto Campaign Cleanup</p>
        </div>
        <div className="flex items-center gap-2">
          {!loadingLog && <StatusBadge status={log?.status} />}
          {(phase === 'idle' || phase === 'done') && (
            <button onClick={runPreview} disabled={!account}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-500/10 border border-violet-500/25 text-violet-300 hover:bg-violet-500/20 text-[10px] font-bold rounded-lg disabled:opacity-50 transition-colors">
              <Eye className="w-3 h-3" />
              Preview
            </button>
          )}
          {phase === 'previewing' && (
            <span className="flex items-center gap-1.5 text-[10px] text-violet-300">
              <Loader2 className="w-3 h-3 animate-spin" />Analisando...
            </span>
          )}
          {phase === 'executing' && (
            <span className="flex items-center gap-1.5 text-[10px] text-red-300">
              <Loader2 className="w-3 h-3 animate-spin" />Executando na Amazon...
            </span>
          )}
        </div>
      </div>

      {/* Último resultado salvo */}
      {loadingLog ? <div className="h-6 bg-surface-2 rounded animate-pulse" /> : log && phase !== 'done' ? (
        <div className="space-y-0.5">
          {hasSummary ? (
            <div className="flex items-center gap-3 text-xs">
              <span><span className="font-bold text-red-400">{dupMatch?.[1] || '0'}</span> <span className="text-slate-500">dup.arq.</span></span>
              <span><span className="font-bold text-amber-400">{pausedMatch?.[1] || '0'}</span> <span className="text-slate-500">pausadas</span></span>
              <span><span className="font-bold text-slate-400">{zeroMatch?.[1] || '0'}</span> <span className="text-slate-500">zero-ativ.arq.</span></span>
            </div>
          ) : (
            <p className="text-xs text-slate-500 truncate">{summary || '—'}</p>
          )}
          {lastDate && <p className="text-[10px] text-slate-600">{new Date(lastDate).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</p>}
        </div>
      ) : !log && phase === 'idle' && <p className="text-xs text-slate-500">Nenhuma execução registrada</p>}

      {/* Error global */}
      {error && <div className="px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">{error}</div>}

      {/* Preview (phase = preview_done) */}
      {phase === 'preview_done' && previewData && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-bold text-violet-300 flex items-center gap-1">
              <Eye className="w-3 h-3" /> Preview — {totalPreviewCandidates} candidato(s) encontrado(s)
            </p>
            <button onClick={reset} className="text-[10px] text-slate-500 hover:text-slate-400 transition-colors">✕ Fechar</button>
          </div>

          <PreviewSection
            title="(a) Duplicatas AUTO por ASIN"
            items={previewData.preview?.rule_a || []}
            colorClass="text-red-400"
          />
          <PreviewSection
            title="(b) AUTO com MANUAL ativa"
            items={previewData.preview?.rule_b?.filter(i => i.has_manual && (i.manual_spend_14d || 0) > 0) || []}
            colorClass="text-amber-400"
          />
          <PreviewSection
            title="(c) AUTO zero-atividade 14d"
            items={previewData.preview?.rule_c?.filter(i => (i.impressions_14d || 0) === 0 && (i.spend_14d || 0) === 0) || []}
            colorClass="text-slate-400"
          />

          {totalPreviewCandidates === 0 ? (
            <div className="flex items-center gap-2 px-3 py-2 bg-emerald-500/8 border border-emerald-500/20 rounded-lg">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              <p className="text-[10px] text-emerald-300">Nenhuma campanha elegível para ação.</p>
            </div>
          ) : (
            <button onClick={runExecute}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-red-500/15 border border-red-500/30 text-red-300 hover:bg-red-500/25 text-xs font-bold rounded-lg transition-colors">
              <Play className="w-3.5 h-3.5" />
              Confirmar e Executar na Amazon ({totalPreviewCandidates} ação(ões))
            </button>
          )}
        </div>
      )}

      {/* Resultado final */}
      {phase === 'done' && execResult && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-bold text-emerald-300 flex items-center gap-1">
              <CheckCircle className="w-3 h-3" /> Execução concluída
            </p>
            <button onClick={reset} className="text-[10px] text-slate-500 hover:text-slate-400 transition-colors">✕ Fechar</button>
          </div>

          <div className="bg-surface-2 rounded-lg p-3 space-y-1 text-xs">
            <div className="flex justify-between"><span className="text-slate-400">Dup. arquivadas</span><span className="font-bold text-red-400">{execResult.archived_duplicates}</span></div>
            <div className="flex justify-between"><span className="text-slate-400">Pausadas (tem manual)</span><span className="font-bold text-amber-400">{execResult.paused_has_manual}</span></div>
            <div className="flex justify-between"><span className="text-slate-400">Zero-ativ. arquivadas</span><span className="font-bold text-slate-400">{execResult.archived_zero_activity}</span></div>
          </div>

          {execResult.errors?.length > 0 && (
            <div className="space-y-1">
              <p className="text-[10px] font-bold text-red-400">{execResult.errors.length} erro(s) de API Amazon:</p>
              {execResult.errors.map((e, i) => (
                <div key={i} className="flex items-start gap-2 px-3 py-1.5 bg-red-500/8 border border-red-500/20 rounded-lg text-[10px]">
                  <XCircle className="w-3 h-3 text-red-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <span className="text-red-300 font-semibold">HTTP {e.http_status}</span>
                    <span className="text-slate-400 ml-1">{e.campaign}</span>
                    <p className="text-slate-500 mt-0.5 line-clamp-2">{e.reason}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          <button onClick={loadLog} className="text-[10px] text-slate-500 hover:text-slate-400 transition-colors flex items-center gap-1">
            <CheckCircle className="w-3 h-3" /> Log atualizado
          </button>
        </div>
      )}

      {/* Toggle log histórico */}
      {log && phase === 'idle' && (
        <button onClick={() => setShowLog(v => !v)} className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-400 transition-colors">
          {showLog ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          {showLog ? 'Ocultar detalhe' : 'Ver detalhes do log'}
        </button>
      )}
      {showLog && log && (
        <div className="bg-surface-2 rounded-lg px-3 py-2 text-[10px] text-slate-400 break-words">
          {log.result_summary}
          {log.error_message && <p className="text-red-400 mt-1">{log.error_message}</p>}
        </div>
      )}
    </div>
  );
}

// ── Export ────────────────────────────────────────────────────────────────
export default function EngineMotorsPanel({ account }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-xs font-bold text-slate-300">Motores Automáticos</p>
        <span className="text-[10px] text-slate-600">agendados diariamente · Bid Rescue 08h · Cleanup 06h BRT</span>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <BidRescueCard account={account} />
        <CleanupCard account={account} />
      </div>
    </div>
  );
}