import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Brain, RefreshCw, Loader2, CheckCircle, XCircle, AlertTriangle, Clock, RotateCcw, ChevronDown, ChevronRight, Zap, Shield } from 'lucide-react';

const AI_WEEKLY_REVIEW_MODEL = 'claude-sonnet-4-5';

function StatusBadge({ status }) {
  const map = {
    running:    'bg-cyan/15 text-cyan border-cyan/30',
    completed:  'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    failed:     'bg-red-500/15 text-red-400 border-red-500/30',
    partial:    'bg-amber-500/15 text-amber-400 border-amber-500/30',
    skipped:    'bg-slate-500/15 text-slate-400 border-slate-500/30',
    active:     'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    suspended:  'bg-amber-500/15 text-amber-400 border-amber-500/30',
    rolled_back:'bg-red-500/15 text-red-400 border-red-500/30',
    draft:      'bg-slate-500/15 text-slate-400 border-slate-500/30',
    rejected:   'bg-red-500/15 text-red-400 border-red-500/30',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${map[status] || 'bg-slate-500/15 text-slate-400 border-slate-500/30'}`}>
      {status}
    </span>
  );
}

function RuleCard({ rule, onRollback }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="bg-surface-2 border border-surface-3 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-3 transition-colors text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          {expanded ? <ChevronDown className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />}
          {rule.is_protected && <Shield className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" title="Regra protegida" />}
          <div className="min-w-0">
            <p className="text-xs font-semibold text-white truncate">{rule.name}</p>
            <p className="text-[10px] text-slate-500 font-mono truncate">{rule.rule_key}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 ml-3">
          <span className="text-[10px] text-slate-500">{rule.scope}</span>
          <StatusBadge status={rule.status} />
        </div>
      </button>
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-surface-3 pt-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div><p className="text-slate-500">Acionamentos</p><p className="text-white font-semibold">{rule.times_triggered || 0}</p></div>
            <div><p className="text-slate-500">Sucesso</p><p className="text-emerald-400 font-semibold">{rule.times_succeeded || 0}</p></div>
            <div><p className="text-slate-500">Confiança</p><p className="text-cyan font-semibold">{((rule.confidence || 0) * 100).toFixed(0)}%</p></div>
            <div><p className="text-slate-500">Cooldown</p><p className="text-white font-semibold">{rule.cooldown_hours || 72}h</p></div>
          </div>
          {rule.conditions?.length > 0 && (
            <div>
              <p className="text-[10px] text-slate-500 mb-1">Condições</p>
              <div className="space-y-1">
                {rule.conditions.map((c, i) => (
                  <div key={i} className="text-[10px] text-slate-300 bg-surface-1 px-2 py-1 rounded font-mono">
                    {c.metric} {c.operator} {JSON.stringify(c.value ?? c.reference)}
                  </div>
                ))}
              </div>
            </div>
          )}
          {rule.action && (
            <div>
              <p className="text-[10px] text-slate-500 mb-1">Ação</p>
              <div className="text-[10px] text-amber-300 bg-surface-1 px-2 py-1 rounded font-mono">
                {rule.action.type}{rule.action.value !== undefined ? ` = ${rule.action.value}` : ''}
              </div>
            </div>
          )}
          {rule.reason && <p className="text-[10px] text-slate-400 leading-relaxed">{rule.reason}</p>}
          {!rule.is_protected && (rule.status === 'active' || rule.status === 'suspended') && (
            <button
              onClick={() => onRollback(rule)}
              className="flex items-center gap-1.5 text-[10px] text-red-400 hover:text-red-300 border border-red-500/20 px-2 py-1 rounded transition-colors"
            >
              <RotateCcw className="w-3 h-3" /> Rollback manual
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function WeeklyLearningTab({ account }) {
  const [reviews, setReviews] = useState([]);
  const [rules, setRules] = useState([]);
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [rollbackMsg, setRollbackMsg] = useState('');
  const [tab, setTab] = useState('overview');

  const aid = account?.id;

  const loadData = async () => {
    if (!aid) return;
    setLoading(true);
    try {
      const [revs, activeRules, vers] = await Promise.all([
        base44.entities.WeeklyRuleReview.filter({ amazon_account_id: aid }, '-started_at', 10),
        base44.entities.DecisionRule.filter({ amazon_account_id: aid }, '-created_date', 50),
        base44.entities.DecisionRuleVersion.filter({ amazon_account_id: aid }, '-version_number', 5),
      ]);
      setReviews(revs);
      setRules(activeRules);
      setVersions(vers);
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  useEffect(() => { loadData(); }, [aid]);

  const runWeeklyReview = async () => {
    setRunning(true);
    try {
      const res = await base44.functions.invoke('runWeeklyClaudeRuleReview', { amazon_account_id: aid });
      if (res.data?.ok) {
        await loadData();
      }
    } catch (e) { console.error(e); }
    setRunning(false);
  };

  const handleRollback = async (rule) => {
    if (!confirm(`Confirma rollback da regra "${rule.name}"? A regra será suspensa.`)) return;
    try {
      await base44.entities.DecisionRule.update(rule.id, { status: 'rolled_back', effective_until: new Date().toISOString() });
      setRollbackMsg(`Rollback de "${rule.name}" realizado.`);
      await loadData();
      setTimeout(() => setRollbackMsg(''), 4000);
    } catch (e) { console.error(e); }
  };

  const latestReview = reviews[0] || null;
  const activeVersion = versions.find(v => v.status === 'active');
  const activeRules = rules.filter(r => r.status === 'active');
  const suspendedRules = rules.filter(r => r.status === 'suspended' || r.status === 'rolled_back');

  // Próxima execução: próximo domingo às 03:00
  const nextSunday = (() => {
    const d = new Date();
    const daysUntilSunday = (7 - d.getDay()) % 7 || 7;
    d.setDate(d.getDate() + daysUntilSunday);
    d.setHours(3, 0, 0, 0);
    return d;
  })();

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="bg-surface-1 border border-violet-500/25 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-violet-500/15 border border-violet-500/30 flex items-center justify-center">
              <Brain className="w-4 h-4 text-violet-400" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">Aprendizado Semanal</h2>
              <p className="text-[10px] text-slate-500">Módulo A — Analista Claude · Módulo B — Motor Determinístico</p>
            </div>
          </div>
          <button
            onClick={runWeeklyReview}
            disabled={running || loading}
            className="flex items-center gap-2 px-3 py-2 bg-violet-500/20 border border-violet-500/30 text-violet-300 hover:text-violet-200 text-xs rounded-lg transition-colors disabled:opacity-50"
          >
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
            Executar revisão agora
          </button>
        </div>

        {/* Status grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-surface-2 rounded-lg p-3">
            <p className="text-[10px] text-slate-500 mb-1">Modelo</p>
            <p className="text-xs font-semibold text-violet-300 font-mono">{AI_WEEKLY_REVIEW_MODEL}</p>
          </div>
          <div className="bg-surface-2 rounded-lg p-3">
            <p className="text-[10px] text-slate-500 mb-1">Versão vigente</p>
            <p className="text-xs font-semibold text-white">v{activeVersion?.version_number || '—'}</p>
          </div>
          <div className="bg-surface-2 rounded-lg p-3">
            <p className="text-[10px] text-slate-500 mb-1">Regras ativas</p>
            <p className="text-xs font-semibold text-emerald-400">{activeRules.length}</p>
          </div>
          <div className="bg-surface-2 rounded-lg p-3">
            <p className="text-[10px] text-slate-500 mb-1">Próxima execução</p>
            <p className="text-[10px] font-semibold text-slate-300">{nextSunday.toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</p>
          </div>
        </div>

        {rollbackMsg && (
          <div className="mt-3 flex items-center gap-2 p-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-xs text-emerald-400">
            <CheckCircle className="w-3.5 h-3.5" /> {rollbackMsg}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-surface-2 gap-1">
        {[
          { id: 'overview', label: 'Última Revisão' },
          { id: 'rules', label: `Regras (${activeRules.length} ativas)` },
          { id: 'versions', label: 'Versões' },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 text-xs font-medium border-b-2 transition-colors ${tab === t.id ? 'border-violet-400 text-violet-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 text-violet-400 animate-spin" /></div>
      ) : (
        <>
          {/* Tab: Última Revisão */}
          {tab === 'overview' && (
            <div className="space-y-4">
              {!latestReview ? (
                <div className="text-center py-12 text-slate-500 text-sm">
                  <Brain className="w-10 h-10 text-slate-600 mx-auto mb-3" />
                  Nenhuma revisão semanal executada ainda.<br />
                  <span className="text-[11px]">Clique em "Executar revisão agora" para iniciar.</span>
                </div>
              ) : (
                <>
                  <div className={`bg-surface-1 border rounded-xl p-5 ${latestReview.status === 'completed' ? 'border-emerald-500/25' : latestReview.status === 'failed' ? 'border-red-500/25' : 'border-surface-2'}`}>
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-2">
                        <Clock className="w-4 h-4 text-slate-400" />
                        <span className="text-sm font-semibold text-white">
                          {new Date(latestReview.started_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </span>
                        <StatusBadge status={latestReview.status} />
                      </div>
                      <button onClick={loadData} className="text-slate-500 hover:text-slate-300 transition-colors">
                        <RefreshCw className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                      <div className="bg-surface-2 rounded-lg p-3">
                        <p className="text-[10px] text-slate-500 mb-1">Regras propostas</p>
                        <p className="text-lg font-bold text-white">{latestReview.rules_proposed || 0}</p>
                      </div>
                      <div className="bg-surface-2 rounded-lg p-3">
                        <p className="text-[10px] text-slate-500 mb-1">Aprovadas</p>
                        <p className="text-lg font-bold text-emerald-400">{latestReview.rules_approved || 0}</p>
                      </div>
                      <div className="bg-surface-2 rounded-lg p-3">
                        <p className="text-[10px] text-slate-500 mb-1">Rejeitadas</p>
                        <p className="text-lg font-bold text-red-400">{latestReview.rules_rejected || 0}</p>
                      </div>
                      <div className="bg-surface-2 rounded-lg p-3">
                        <p className="text-[10px] text-slate-500 mb-1">Qualidade dados</p>
                        <p className="text-lg font-bold text-cyan">{((latestReview.data_quality_score || 0) * 100).toFixed(0)}%</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                      <div><p className="text-slate-500">Modelo</p><p className="text-violet-300 font-mono text-[10px]">{latestReview.model || AI_WEEKLY_REVIEW_MODEL}</p></div>
                      <div><p className="text-slate-500">Período analisado</p><p className="text-white">{latestReview.analysis_period_start} → {latestReview.analysis_period_end}</p></div>
                      <div><p className="text-slate-500">Registros</p><p className="text-white">{(latestReview.records_analyzed || 0).toLocaleString()}</p></div>
                      <div><p className="text-slate-500">Custo estimado</p><p className="text-white">US${(latestReview.cost_estimate_usd || 0).toFixed(4)}</p></div>
                    </div>

                    {latestReview.global_observations?.length > 0 && (
                      <div className="mt-4 p-3 bg-violet-500/5 border border-violet-500/15 rounded-lg">
                        <p className="text-[10px] text-violet-400 font-semibold mb-2">Observações globais do Claude</p>
                        <ul className="space-y-1">
                          {latestReview.global_observations.map((obs, i) => (
                            <li key={i} className="text-[10px] text-slate-300">• {obs}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {latestReview.data_warnings?.length > 0 && (
                      <div className="mt-3 p-3 bg-amber-500/5 border border-amber-500/15 rounded-lg">
                        <p className="text-[10px] text-amber-400 font-semibold mb-1">Avisos de qualidade de dados</p>
                        {latestReview.data_warnings.map((w, i) => (
                          <p key={i} className="text-[10px] text-amber-300">⚠ {w}</p>
                        ))}
                      </div>
                    )}

                    {latestReview.status === 'failed' && latestReview.error_message && (
                      <div className="mt-3 p-3 bg-red-500/5 border border-red-500/15 rounded-lg">
                        <p className="text-[10px] text-red-400 font-semibold mb-1">Erro — Regras atuais mantidas intactas</p>
                        <p className="text-[10px] text-red-300">{latestReview.error_message}</p>
                      </div>
                    )}
                  </div>

                  {/* Histórico de revisões */}
                  {reviews.length > 1 && (
                    <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
                      <p className="text-xs font-semibold text-slate-400 mb-3">Histórico de revisões</p>
                      <div className="space-y-2">
                        {reviews.slice(1).map(r => (
                          <div key={r.id} className="flex items-center justify-between text-xs py-2 border-b border-surface-2">
                            <span className="text-slate-400">{new Date(r.started_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                            <StatusBadge status={r.status} />
                            <span className="text-slate-500">{r.rules_approved || 0} aprovadas / {r.rules_rejected || 0} rejeitadas</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Tab: Regras */}
          {tab === 'rules' && (
            <div className="space-y-4">
              {activeRules.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
                    <p className="text-xs font-semibold text-slate-300">Regras Ativas ({activeRules.length})</p>
                  </div>
                  <div className="space-y-2">
                    {activeRules.map(r => <RuleCard key={r.id} rule={r} onRollback={handleRollback} />)}
                  </div>
                </div>
              )}
              {suspendedRules.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <XCircle className="w-3.5 h-3.5 text-red-400" />
                    <p className="text-xs font-semibold text-slate-300">Suspensas / Rolled Back ({suspendedRules.length})</p>
                  </div>
                  <div className="space-y-2">
                    {suspendedRules.map(r => <RuleCard key={r.id} rule={r} onRollback={handleRollback} />)}
                  </div>
                </div>
              )}
              {rules.length === 0 && (
                <div className="text-center py-10 text-slate-500 text-sm">
                  <Shield className="w-8 h-8 text-slate-600 mx-auto mb-2" />
                  Nenhuma regra determinística criada ainda.<br />
                  <span className="text-[11px]">Execute a revisão semanal para gerar regras.</span>
                </div>
              )}
            </div>
          )}

          {/* Tab: Versões */}
          {tab === 'versions' && (
            <div className="space-y-3">
              {versions.length === 0 ? (
                <div className="text-center py-10 text-slate-500 text-sm">Nenhuma versão publicada ainda.</div>
              ) : versions.map(v => (
                <div key={v.id} className="bg-surface-1 border border-surface-2 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-white">Versão {v.version_number}</span>
                      <StatusBadge status={v.status} />
                    </div>
                    <span className="text-[10px] text-slate-500">{v.activated_at ? new Date(v.activated_at).toLocaleString('pt-BR') : '—'}</span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                    <div><p className="text-slate-500">Criadas</p><p className="text-emerald-400 font-semibold">{v.rules_created?.length || 0}</p></div>
                    <div><p className="text-slate-500">Desativadas</p><p className="text-red-400 font-semibold">{v.rules_disabled?.length || 0}</p></div>
                    <div><p className="text-slate-500">Modelo</p><p className="text-violet-300 font-mono text-[10px] truncate">{v.model || '—'}</p></div>
                    <div><p className="text-slate-500">Rollback disp.</p><p className={`font-semibold ${v.rollback_available ? 'text-emerald-400' : 'text-slate-500'}`}>{v.rollback_available ? 'Sim' : 'Não'}</p></div>
                  </div>
                  {v.justification && (
                    <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">{v.justification}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}