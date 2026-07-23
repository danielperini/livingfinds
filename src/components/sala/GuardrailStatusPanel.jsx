import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Shield, AlertTriangle, CheckCircle, XCircle, Loader2,
  RefreshCw, Play, Search, ChevronDown, ChevronRight
} from 'lucide-react';

function StatusPill({ active, label }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border ${
      active
        ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400'
        : 'bg-red-500/15 border-red-500/30 text-red-400'
    }`}>
      {active ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
      {label} {active ? 'ATIVO' : 'INATIVO'}
    </span>
  );
}

export default function GuardrailStatusPanel({ account }) {
  const [auditResult, setAuditResult] = useState(null);
  const [staleDecisions, setStaleDecisions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [runningAudit, setRunningAudit] = useState(false);
  const [expandedEvents, setExpandedEvents] = useState(false);

  const loadStaleDecisions = useCallback(async () => {
    if (!account) return;
    try {
      const decisions = await base44.entities.OptimizationDecision.filter(
        { amazon_account_id: account.id },
        '-created_at',
        100
      ).catch(() => []);
      const stale = decisions.filter(d =>
        d.error_message && d.error_message.includes('STALE_DECISION_REVALIDATION')
      );
      setStaleDecisions(stale);
    } catch {}
  }, [account]);

  const runAudit = async () => {
    if (!account || runningAudit) return;
    setRunningAudit(true);
    try {
      const res = await base44.functions.invoke('auditCampaignPauseHistory', {
        amazon_account_id: account.id,
      });
      setAuditResult(res?.data || null);
      await loadStaleDecisions();
    } catch (e) {
      setAuditResult({ ok: false, error: e.message });
    } finally {
      setRunningAudit(false);
    }
  };

  useEffect(() => {
    if (account) loadStaleDecisions();
  }, [account, loadStaleDecisions]);

  const rca = auditResult?.root_cause_analysis;

  const severityColor = {
    critical: 'text-red-400 bg-red-500/10 border-red-500/25',
    high: 'text-amber-400 bg-amber-500/10 border-amber-500/25',
    medium: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/25',
    low: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/25',
  };

  return (
    <div className="space-y-5">
      {/* Status dos Guardrails */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2 mb-2">
          <Shield className="w-4 h-4 text-cyan" />
          <h3 className="text-sm font-semibold text-white">Status dos Guardrails</h3>
        </div>
        <div className="flex flex-wrap gap-3">
          <StatusPill active={true} label="Zero Campaign Guard" />
          <StatusPill active={true} label="Batch Pause Guard (30%/50%)" />
          <StatusPill active={true} label="Winner Protection" />
          <StatusPill active={true} label="ACoS Null Fix (sales=0)" />
          <StatusPill active={true} label="Stale Decision Revalidation" />
        </div>
        <div className="text-xs text-slate-500 space-y-1 pt-1">
          <p>• <span className="text-slate-300">Zero Campaign Guard:</span> bloqueia pausas se active_after=0 com estoque disponível</p>
          <p>• <span className="text-slate-300">Batch Pause Guard:</span> &gt;30% exige force_batch=true; &gt;50% bloqueia automaticamente</p>
          <p>• <span className="text-slate-300">Winner Protection:</span> orders_14d&gt;0 AND ACoS≤target → nunca pausar (por nenhuma regra)</p>
          <p>• <span className="text-slate-300">ACoS Null Fix:</span> sales=0 → acos=null (nunca acos=0) em todo o motor</p>
          <p>• <span className="text-slate-300">Stale Decision:</span> decisões de pausa revalidadas antes de executar</p>
        </div>
      </div>

      {/* Auditoria de Causa Raiz */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <Search className="w-4 h-4 text-amber-400" />
            <h3 className="text-sm font-semibold text-white">Auditoria de Causa Raiz de Pausas (30 dias)</h3>
          </div>
          <button
            onClick={runAudit}
            disabled={runningAudit || !account}
            className="flex items-center gap-2 px-4 py-2 bg-amber-500/15 border border-amber-500/30 text-amber-300 hover:bg-amber-500/25 text-xs font-semibold rounded-lg disabled:opacity-50 transition-colors"
          >
            {runningAudit ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            {runningAudit ? 'Auditando...' : 'Executar Auditoria'}
          </button>
        </div>

        {!auditResult && (
          <div className="flex flex-col items-center justify-center py-10 gap-2">
            <Search className="w-8 h-8 text-slate-700" />
            <p className="text-sm text-slate-500">Clique em "Executar Auditoria" para analisar a causa raiz das pausas</p>
          </div>
        )}

        {auditResult?.ok === false && (
          <div className="px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-400">
            Erro: {auditResult.error}
          </div>
        )}

        {rca && (
          <div className="space-y-4">
            {/* Severidade */}
            <div className={`flex items-center gap-3 px-4 py-3 rounded-xl border ${severityColor[rca.severity] || severityColor.medium}`}>
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <div>
                <p className="text-sm font-bold uppercase">Severidade: {rca.severity}</p>
                <p className="text-xs opacity-80">Período: {auditResult.audit_period}</p>
              </div>
            </div>

            {/* KPIs */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Pausas em 30d', value: rca.total_pause_events_30d, color: rca.total_pause_events_30d > 0 ? 'text-amber-400' : 'text-emerald-400' },
                { label: '⚠ Vencedores Pausados', value: rca.winner_violations, color: rca.winner_violations > 0 ? 'text-red-400' : 'text-emerald-400' },
                { label: '📦 Pausadas com Estoque', value: rca.paused_with_stock, color: rca.paused_with_stock > 0 ? 'text-amber-400' : 'text-emerald-400' },
                { label: '✅ Ativas Agora', value: rca.current_active_campaigns, color: rca.current_active_campaigns > 0 ? 'text-emerald-400' : 'text-red-400' },
              ].map(k => (
                <div key={k.label} className="bg-surface-2 border border-surface-3 rounded-xl px-3 py-3 text-center">
                  <p className="text-[10px] text-slate-500 mb-1 leading-tight">{k.label}</p>
                  <p className={`text-xl font-bold ${k.color}`}>{k.value}</p>
                </div>
              ))}
            </div>

            {/* Recomendações */}
            {rca.recommendations?.length > 0 && (
              <div className="space-y-2">
                {rca.recommendations.map((rec, i) => (
                  <div key={i} className="px-4 py-2 bg-red-500/8 border border-red-500/20 rounded-lg text-xs text-red-300">
                    {rec}
                  </div>
                ))}
              </div>
            )}

            {/* Top funções causadoras */}
            {rca.top_functions_causing_pauses?.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-slate-400 mb-2">Funções que mais causaram pausas:</p>
                <div className="space-y-1">
                  {rca.top_functions_causing_pauses.slice(0, 5).map((f, i) => (
                    <div key={i} className="flex items-center justify-between text-xs py-1 border-b border-surface-2/40 last:border-0">
                      <span className="font-mono text-cyan text-[10px]">{f.function}</span>
                      <span className="text-slate-400 font-bold">{f.count}x</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Timeline de eventos */}
            {auditResult.pause_events?.length > 0 && (
              <div>
                <button
                  onClick={() => setExpandedEvents(v => !v)}
                  className="flex items-center gap-2 text-xs text-slate-400 hover:text-white transition-colors"
                >
                  {expandedEvents ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  {expandedEvents ? 'Ocultar' : 'Ver'} timeline de {auditResult.pause_events.length} evento(s)
                </button>
                {expandedEvents && (
                  <div className="mt-3 max-h-80 overflow-y-auto scrollbar-thin bg-surface-2/30 rounded-xl border border-surface-2 divide-y divide-surface-2/50">
                    {auditResult.pause_events.slice(0, 50).map((ev, i) => (
                      <div key={i} className={`px-4 py-2.5 text-xs ${ev.is_winner_violation ? 'bg-red-500/5' : ''}`}>
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <span className="font-semibold text-white truncate max-w-[200px]">
                            {ev.campaign_name || ev.campaign_id}
                          </span>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            {ev.is_winner_violation && (
                              <span className="text-[9px] px-1.5 py-0.5 bg-red-500/20 text-red-400 rounded font-bold">WINNER VIOLATION</span>
                            )}
                            <span className="text-slate-500 text-[10px]">
                              {ev.timestamp ? new Date(ev.timestamp).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                            </span>
                          </div>
                        </div>
                        <div className="text-slate-500 mt-0.5 text-[10px] flex items-center gap-3 flex-wrap">
                          <span>ASIN: <span className="text-cyan font-mono">{ev.asin || '—'}</span></span>
                          <span>Pedidos 14d: <span className={ev.orders_14d > 0 ? 'text-emerald-400 font-semibold' : 'text-slate-400'}>{ev.orders_14d}</span></span>
                          {ev.acos_14d !== null && <span>ACoS 14d: <span className={ev.acos_14d <= 15 ? 'text-emerald-400 font-semibold' : 'text-amber-400'}>{ev.acos_14d}%</span></span>}
                          <span>Estoque: <span className={ev.stock > 0 ? 'text-cyan' : 'text-red-400'}>{ev.stock}un</span></span>
                          <span className="font-mono text-[9px] text-slate-600">{ev.function_name}</span>
                        </div>
                        {ev.reason && <p className="text-slate-600 mt-0.5 text-[10px] truncate">{ev.reason}</p>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Decisões Obsoletas Canceladas */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <XCircle className="w-4 h-4 text-slate-400" />
            <h3 className="text-sm font-semibold text-white">Decisões Obsoletas Canceladas</h3>
            {staleDecisions.length > 0 && (
              <span className="text-[10px] px-2 py-0.5 bg-amber-500/20 text-amber-400 rounded-full border border-amber-500/30">
                {staleDecisions.length}
              </span>
            )}
          </div>
          <button onClick={loadStaleDecisions} className="text-[10px] text-slate-500 hover:text-slate-300 flex items-center gap-1">
            <RefreshCw className="w-3 h-3" /> Atualizar
          </button>
        </div>

        {staleDecisions.length === 0 ? (
          <div className="flex items-center gap-2 text-xs text-slate-500 py-4 justify-center">
            <CheckCircle className="w-4 h-4 text-emerald-400" />
            Nenhuma decisão obsoleta detectada
          </div>
        ) : (
          <div className="max-h-60 overflow-y-auto scrollbar-thin divide-y divide-surface-2/50">
            {staleDecisions.map((d, i) => (
              <div key={d.id || i} className="py-2 px-1 text-xs">
                <p className="text-white font-medium truncate">{d.campaign_id || d.entity_id || '—'}</p>
                <p className="text-slate-500 text-[10px] mt-0.5">{d.error_message?.slice(0, 150)}</p>
                <p className="text-slate-600 text-[10px]">{d.created_at ? new Date(d.created_at).toLocaleString('pt-BR') : ''}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}