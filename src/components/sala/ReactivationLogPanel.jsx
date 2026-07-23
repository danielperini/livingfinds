import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { PlayCircle, RefreshCw, Loader2, Package, Clock, CheckCircle, XCircle, AlertCircle } from 'lucide-react';

const REACTIVATION_OPERATIONS = [
  'reactivate_paused_with_stock',
  'reactivatePausedWithStock',
  'auto_stock_campaign_guard',
  'campaign_reactivation',
  'reactivate_winner_campaign',
  'reactivateNewManualCampaigns',
  'reactivate_new_manual',
];

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function parseSummary(raw) {
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

export default function ReactivationLogPanel({ accountId }) {
  const [logs, setLogs] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState({});

  const load = async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      // Buscar logs de execução relacionados à reativação
      const syncLogs = await base44.entities.SyncExecutionLog.filter(
        { amazon_account_id: accountId },
        '-started_at',
        500
      ).catch(() => []);

      // Filtrar apenas logs de reativação
      const reactivationLogs = syncLogs.filter(log => {
        const op = (log.operation || '').toLowerCase();
        return REACTIVATION_OPERATIONS.some(r => op.includes(r.toLowerCase()));
      });

      // Buscar OptimizationDecisions de reativação
      const reactivateDecisions = await base44.entities.OptimizationDecision.filter(
        { amazon_account_id: accountId, decision_type: 'reactivate' },
        '-created_at',
        200
      ).catch(() => []);

      setLogs(reactivationLogs);
      setCampaigns(reactivateDecisions);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [accountId]);

  const toggleExpand = (id) => setExpanded(prev => ({ ...prev, [id]: !prev[id] }));

  // Agregar estatísticas
  const totalReactivated = logs.reduce((sum, l) => {
    const s = parseSummary(l.result_summary);
    return sum + (s?.reactivated || s?.activated || l.records_processed || 0);
  }, 0);

  const totalRuns = logs.length;
  const lastRun = logs[0];
  const successRuns = logs.filter(l => l.status === 'success' || l.status === 'completed').length;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <PlayCircle className="w-4 h-4 text-emerald-400" />
            Log de Reativação Automática de Campanhas
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Campanhas pausadas que o sistema reativou automaticamente por estoque disponível.
          </p>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-2 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-xs rounded-lg transition-colors disabled:opacity-50">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Atualizar
        </button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Total Reativadas', value: totalReactivated, color: 'text-emerald-400' },
          { label: 'Execuções', value: totalRuns, color: 'text-white' },
          { label: 'Com Sucesso', value: successRuns, color: 'text-emerald-400' },
          { label: 'Última Execução', value: lastRun ? fmtDate(lastRun.started_at || lastRun.created_date) : '—', color: 'text-slate-300', small: true },
        ].map(k => (
          <div key={k.label} className="bg-surface-1 border border-surface-2 rounded-xl px-4 py-3 text-center">
            <p className="text-[10px] text-slate-500 mb-1">{k.label}</p>
            <p className={`font-bold ${k.small ? 'text-sm' : 'text-2xl'} ${k.color}`}>{k.value}</p>
          </div>
        ))}
      </div>

      {/* Decisões de reativação individuais */}
      {campaigns.length > 0 && (
        <div className="bg-surface-1 border border-emerald-500/20 rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-surface-2 flex items-center justify-between">
            <p className="text-sm font-semibold text-white">Campanhas Reativadas — Decisões Individuais</p>
            <span className="text-[10px] text-slate-500">{campaigns.length} registro(s)</span>
          </div>
          <div className="overflow-x-auto max-h-72 overflow-y-auto scrollbar-thin">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-surface-2/90">
                <tr className="border-b border-surface-2">
                  {['Campanha / ASIN', 'Motivo', 'Status', 'Confiança', 'Data'].map(h => (
                    <th key={h} className="px-4 py-2.5 text-left font-semibold text-slate-500 uppercase whitespace-nowrap text-[10px]">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {campaigns.map((d, i) => (
                  <tr key={d.id || i} className="border-b border-surface-2/40 hover:bg-surface-2/30 transition-colors">
                    <td className="px-4 py-2.5">
                      <p className="text-white font-medium truncate max-w-[180px]">{d.campaign_id || d.entity_id || '—'}</p>
                      {d.asin && <p className="text-cyan font-mono text-[10px]">{d.asin}</p>}
                    </td>
                    <td className="px-4 py-2.5 text-slate-400 max-w-[200px] truncate">
                      {d.rationale || d.reason || d.action || '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      {d.status === 'executed' ? (
                        <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border bg-emerald-500/10 border-emerald-500/20 text-emerald-400 font-bold">
                          <CheckCircle className="w-2.5 h-2.5" /> Executada
                        </span>
                      ) : d.status === 'failed' ? (
                        <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border bg-red-500/10 border-red-500/20 text-red-400 font-bold">
                          <XCircle className="w-2.5 h-2.5" /> Falhou
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border bg-amber-500/10 border-amber-500/20 text-amber-400 font-bold">
                          <Clock className="w-2.5 h-2.5" /> {d.status || 'pendente'}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {d.confidence != null ? (
                        <span className={`text-[10px] font-semibold ${d.confidence >= 0.8 ? 'text-emerald-400' : d.confidence >= 0.6 ? 'text-amber-400' : 'text-red-400'}`}>
                          {(d.confidence * 100).toFixed(0)}%
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-slate-500 whitespace-nowrap">{fmtDate(d.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Log de execuções da automação */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-5 h-5 text-cyan animate-spin" />
        </div>
      ) : logs.length === 0 && campaigns.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 bg-surface-1 border border-surface-2 rounded-xl">
          <PlayCircle className="w-10 h-10 text-slate-700" />
          <p className="text-sm text-slate-500">Nenhuma reativação automática registrada ainda.</p>
          <p className="text-xs text-slate-600">A automação roda diariamente às 06:30 BRT e registra aqui quando reativar campanhas.</p>
        </div>
      ) : (
        <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-surface-2 flex items-center justify-between">
            <p className="text-sm font-semibold text-white">Histórico de Execuções da Automação</p>
            <span className="text-[10px] text-slate-500">{logs.length} execução(ões)</span>
          </div>
          <div className="divide-y divide-surface-2/50 max-h-96 overflow-y-auto scrollbar-thin">
            {logs.map((log, i) => {
              const summary = parseSummary(log.result_summary);
              const reactivated = summary?.reactivated ?? summary?.activated ?? log.records_processed ?? 0;
              const skipped = summary?.skipped ?? 0;
              const candidates = summary?.candidates ?? 0;
              const errors = summary?.errors?.length ?? 0;
              const isSuccess = log.status === 'success' || log.status === 'completed';
              const isExpanded = expanded[log.id];

              return (
                <div key={log.id || i}>
                  <button
                    onClick={() => toggleExpand(log.id)}
                    className="w-full flex items-start gap-3 px-5 py-3 hover:bg-surface-2/30 transition-colors text-left"
                  >
                    <div className="flex-shrink-0 mt-0.5">
                      {isSuccess ? (
                        <CheckCircle className="w-4 h-4 text-emerald-400" />
                      ) : log.status === 'error' || log.status === 'failed' ? (
                        <XCircle className="w-4 h-4 text-red-400" />
                      ) : (
                        <AlertCircle className="w-4 h-4 text-amber-400" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-semibold text-white">
                          {reactivated > 0 ? `${reactivated} campanha(s) reativada(s)` : 'Nenhuma reativação necessária'}
                        </span>
                        {errors > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/20">
                            {errors} erro(s)
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-[10px] text-slate-500 flex-wrap">
                        <span className="flex items-center gap-1">
                          <Clock className="w-2.5 h-2.5" />
                          {fmtDate(log.started_at || log.created_date)}
                        </span>
                        {candidates > 0 && <span>{candidates} candidatas avaliadas</span>}
                        {skipped > 0 && <span>{skipped} ignoradas</span>}
                        {log.duration_ms && <span>{(log.duration_ms / 1000).toFixed(1)}s</span>}
                      </div>
                    </div>
                    <span className="text-[10px] text-slate-600 flex-shrink-0">{isExpanded ? '▲' : '▼'}</span>
                  </button>

                  {isExpanded && (
                    <div className="px-5 pb-4 ml-7 space-y-2">
                      {/* Detalhes do resultado */}
                      {summary?.accounts && Array.isArray(summary.accounts) && summary.accounts.map((acc, ai) => (
                        <div key={ai} className="rounded-lg bg-surface-2/50 border border-surface-3 p-3 text-xs space-y-1.5">
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                            {[
                              { label: 'Reativadas', value: acc.activated ?? acc.reactivated ?? 0, color: 'text-emerald-400' },
                              { label: 'Ignoradas', value: acc.skipped ?? 0, color: 'text-slate-400' },
                              { label: 'Sync. locais', value: acc.synced ?? 0, color: 'text-cyan' },
                              { label: 'Desbloqueadas', value: acc.unlocked ?? 0, color: 'text-amber-400' },
                            ].map(k => (
                              <div key={k.label} className="text-center bg-surface-1 rounded-lg p-2">
                                <p className="text-[9px] text-slate-500">{k.label}</p>
                                <p className={`text-base font-bold ${k.color}`}>{k.value}</p>
                              </div>
                            ))}
                          </div>
                          {acc.errors?.length > 0 && (
                            <div className="mt-2">
                              <p className="text-[10px] font-semibold text-red-400 mb-1">Erros:</p>
                              {acc.errors.slice(0, 3).map((e, ei) => (
                                <p key={ei} className="text-[10px] text-red-300/80">{e.asin || e.step}: {e.error}</p>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}

                      {/* Fallback: campos diretos do summary */}
                      {(!summary?.accounts) && summary && (
                        <div className="rounded-lg bg-surface-2/50 border border-surface-3 p-3 text-xs">
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                            {[
                              { label: 'Reativadas', value: summary.reactivated ?? summary.activated ?? 0, color: 'text-emerald-400' },
                              { label: 'Candidatas', value: summary.candidates ?? 0, color: 'text-slate-400' },
                              { label: 'Ignoradas', value: summary.skipped ?? 0, color: 'text-slate-400' },
                            ].map(k => (
                              <div key={k.label} className="text-center bg-surface-1 rounded-lg p-2">
                                <p className="text-[9px] text-slate-500">{k.label}</p>
                                <p className={`text-base font-bold ${k.color}`}>{k.value}</p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Motivo / erro */}
                      {log.error_message && (
                        <div className="rounded-lg bg-red-500/8 border border-red-500/20 px-3 py-2">
                          <p className="text-[10px] text-red-300">{log.error_message}</p>
                        </div>
                      )}
                      {log.result_summary && !summary && (
                        <p className="text-[10px] text-slate-500 font-mono break-all">{String(log.result_summary).slice(0, 300)}</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Info sobre automação */}
      <div className="flex items-start gap-3 px-4 py-3 rounded-xl border border-surface-2 bg-surface-1 text-xs text-slate-500">
        <Package className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />
        <div>
          <p className="text-slate-300 font-semibold mb-0.5">Como funciona a reativação automática</p>
          <p>A automação <span className="text-cyan font-mono">reactivatePausedWithStock</span> roda diariamente às 06:30 BRT. Ela verifica campanhas AUTO e MANUAL pausadas pelo motor e, se o produto associado tiver <span className="text-emerald-400">fba_inventory {'>'} 0</span>, reativa a campanha na Amazon Ads API. Motivos que bloqueiam a reativação: <span className="text-red-400/80">OUT_OF_STOCK · USER_MANUAL · POLICY · ABOVE_BREAK_EVEN · LISTING_BLOCKED</span>.</p>
        </div>
      </div>
    </div>
  );
}