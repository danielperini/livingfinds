import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Brain, TrendingUp, TrendingDown, Loader2, RefreshCw,
  Zap, Target, BarChart2, Activity, ChevronDown, ChevronUp,
  AlertTriangle, CheckCircle, Clock, Database
} from 'lucide-react';

const TAIL_COLORS = {
  medium: 'text-cyan bg-cyan/10 border-cyan/20',
  long: 'text-violet-400 bg-violet-400/10 border-violet-400/20',
};

const CLASS_COLORS = {
  winner:           'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
  learning:         'text-blue-400 bg-blue-400/10 border-blue-400/20',
  wasting:          'text-red-400 bg-red-400/10 border-red-400/20',
  negative:         'text-slate-400 bg-slate-400/10 border-slate-400/20',
  new:              'text-amber-400 bg-amber-400/10 border-amber-400/20',
  insufficient_data:'text-slate-500 bg-slate-500/10 border-slate-500/20',
};

const CLASS_LABELS = {
  winner: 'Vencedor', learning: 'Aprendendo', wasting: 'Desperdiçando',
  negative: 'Negativa', new: 'Novo', insufficient_data: 'Dados insuficientes',
};

function ConfidenceBar({ value, max = 100 }) {
  const pct = Math.min((value / max) * 100, 100);
  const color = pct >= 95 ? 'bg-emerald-400' : pct >= 80 ? 'bg-cyan' : pct >= 60 ? 'bg-amber-400' : 'bg-slate-500';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-surface-3 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`text-xs font-bold w-8 text-right ${pct >= 95 ? 'text-emerald-400' : pct >= 80 ? 'text-cyan' : 'text-slate-400'}`}>
        {pct.toFixed(0)}%
      </span>
    </div>
  );
}

function ParamChange({ label, before, after, unit = '' }) {
  if (before == null || after == null || before === after) return null;
  const up = after > before;
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-surface-3/50 last:border-0">
      <span className="text-xs text-slate-400">{label}</span>
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-mono text-slate-500">{before}{unit}</span>
        <span className="text-xs text-slate-600">→</span>
        <span className={`text-xs font-mono font-bold ${up ? 'text-emerald-400' : 'text-red-400'}`}>{after}{unit}</span>
        {up ? <TrendingUp className="w-3 h-3 text-emerald-400" /> : <TrendingDown className="w-3 h-3 text-red-400" />}
      </div>
    </div>
  );
}

function TermRow({ term, currencySymbol }) {
  const [expanded, setExpanded] = useState(false);
  const words = (term.term || '').trim().split(/\s+/).length;
  const tailType = words >= 4 ? 'long' : 'medium';

  return (
    <>
      <tr
        className="border-b border-surface-2/40 hover:bg-surface-2/40 cursor-pointer transition-colors"
        onClick={() => setExpanded(v => !v)}
      >
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border uppercase tracking-wide ${TAIL_COLORS[tailType]}`}>
              {tailType === 'long' ? 'Longa' : 'Média'}
            </span>
            <span className="text-xs font-mono text-white">{term.term}</span>
          </div>
        </td>
        <td className="px-3 py-2.5">
          <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${CLASS_COLORS[term.classification] || CLASS_COLORS.new}`}>
            {CLASS_LABELS[term.classification] || term.classification || 'Novo'}
          </span>
        </td>
        <td className="px-3 py-2.5 w-40">
          <ConfidenceBar value={term.performance_score || 0} max={100} />
        </td>
        <td className="px-3 py-2.5 text-xs text-white font-semibold">{term.orders || 0}</td>
        <td className="px-3 py-2.5 text-xs text-emerald-400">{currencySymbol}{(term.sales || 0).toFixed(2)}</td>
        <td className="px-3 py-2.5 text-xs text-slate-400">{currencySymbol}{(term.spend || 0).toFixed(2)}</td>
        <td className="px-3 py-2.5 text-xs font-mono text-cyan">{term.asin || '—'}</td>
        <td className="px-3 py-2.5 w-8">
          {expanded ? <ChevronUp className="w-3.5 h-3.5 text-slate-500" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-500" />}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-surface-2/40 bg-surface-2/20">
          <td colSpan={8} className="px-8 py-3 space-y-1.5">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <div><span className="text-slate-500">Bid atual:</span> <span className="text-white font-mono">{currencySymbol}{(term.bid_current || 0).toFixed(2)}</span></div>
              <div><span className="text-slate-500">Bid inicial:</span> <span className="text-white font-mono">{currencySymbol}{(term.bid_initial || 0).toFixed(2)}</span></div>
              <div><span className="text-slate-500">CTR:</span> <span className="text-white">{((term.ctr || 0) * 100).toFixed(2)}%</span></div>
              <div><span className="text-slate-500">Conv.:</span> <span className="text-white">{((term.conversion_rate || 0) * 100).toFixed(1)}%</span></div>
              <div><span className="text-slate-500">ACoS:</span> <span className={(term.acos || 0) > 40 ? 'text-red-400' : 'text-emerald-400'}>{(term.acos || 0).toFixed(1)}%</span></div>
              <div><span className="text-slate-500">ROAS:</span> <span className="text-cyan">{(term.roas || 0).toFixed(2)}x</span></div>
              <div><span className="text-slate-500">Fonte:</span> <span className="text-slate-300">{term.source || '—'}</span></div>
              <div><span className="text-slate-500">Match:</span> <span className="text-slate-300">{term.match_type || '—'}</span></div>
            </div>
            {term.compatibility_notes && (
              <p className="text-xs text-slate-500 italic mt-1">💡 {term.compatibility_notes}</p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export default function MLLearningPanel({ amazonAccountId, currencySymbol = 'R$' }) {
  const [mlModel, setMlModel] = useState(null);
  const [terms, setTerms] = useState([]);
  const [learningEvents, setLearningEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState(null);
  const [filterTail, setFilterTail] = useState('all');
  const [filterClass, setFilterClass] = useState('all');
  const [showParams, setShowParams] = useState(false);

  const load = async () => {
    if (!amazonAccountId) return;
    setLoading(true);
    try {
      const [models, termBank, events] = await Promise.all([
        base44.entities.MLModel.filter({ amazon_account_id: amazonAccountId }, '-trained_at', 1),
        base44.entities.TermBank.filter({ amazon_account_id: amazonAccountId }, '-performance_score', 500),
        base44.entities.LearningEvent.filter({ amazon_account_id: amazonAccountId }, '-created_date', 30),
      ]);
      setMlModel(models[0] || null);
      // Filtrar somente cauda média (2-3 palavras) e longa (4+ palavras)
      const filtered = termBank.filter(t => {
        const words = (t.term || '').trim().split(/\s+/).length;
        return words >= 2;
      });
      setTerms(filtered);
      setLearningEvents(events);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [amazonAccountId]);

  const runMLLearning = async () => {
    setRunning(true);
    setRunMsg(null);
    try {
      const res = await base44.functions.invoke('runMLLearning', { amazon_account_id: amazonAccountId });
      const d = res?.data;
      if (d?.ok) {
        setRunMsg({ type: 'success', text: `✓ Ciclo ML concluído — ${d.param_changes_applied || 0} parâmetros atualizados · confiança ${d.confidence_score?.toFixed(0) || 0}%` });
        await load();
      } else {
        setRunMsg({ type: 'error', text: d?.error || 'Erro no ciclo ML' });
      }
    } catch (e) {
      setRunMsg({ type: 'error', text: e.message });
    } finally {
      setRunning(false);
      setTimeout(() => setRunMsg(null), 12000);
    }
  };

  // Filtrar termos
  const displayTerms = terms.filter(t => {
    const words = (t.term || '').trim().split(/\s+/).length;
    const tail = words >= 4 ? 'long' : 'medium';
    const matchTail = filterTail === 'all' || filterTail === tail;
    const matchClass = filterClass === 'all' || t.classification === filterClass;
    return matchTail && matchClass;
  });

  const mediumCount = terms.filter(t => {
    const w = (t.term || '').trim().split(/\s+/).length;
    return w >= 2 && w <= 3;
  }).length;
  const longCount = terms.filter(t => (t.term || '').trim().split(/\s+/).length >= 4).length;
  const winnerCount = terms.filter(t => t.classification === 'winner').length;
  const learningCount = terms.filter(t => t.classification === 'learning').length;

  const confidence = mlModel?.confidence_score || 0;
  const confColor = confidence >= 95 ? 'text-emerald-400' : confidence >= 80 ? 'text-cyan' : confidence >= 60 ? 'text-amber-400' : 'text-slate-400';

  return (
    <div className="space-y-4">
      {/* Header + run button */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-violet-500/15 border border-violet-500/25 flex items-center justify-center">
            <Brain className="w-5 h-5 text-violet-400" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-white">Motor de Aprendizado ML</h2>
            <p className="text-xs text-slate-400">
              {mlModel?.trained_at
                ? `Último treino: ${new Date(mlModel.trained_at).toLocaleString('pt-BR')}`
                : 'Nenhum ciclo executado ainda'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} disabled={loading}
            className="p-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors disabled:opacity-50">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={runMLLearning} disabled={running || loading}
            className="flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60">
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            {running ? 'Aprendendo...' : 'Executar Ciclo ML'}
          </button>
        </div>
      </div>

      {runMsg && (
        <div className={`p-3 rounded-xl border text-sm ${runMsg.type === 'success' ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300' : 'bg-red-400/10 border-red-400/20 text-red-400'}`}>
          {runMsg.text}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 text-violet-400 animate-spin" />
        </div>
      ) : (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <Activity className="w-4 h-4 text-violet-400" />
                <p className="text-xs text-slate-500">Confiança do Modelo</p>
              </div>
              <p className={`text-2xl font-bold ${confColor}`}>{confidence.toFixed(0)}%</p>
              <p className="text-xs text-slate-600 mt-1">{confidence >= 95 ? 'Auto-ajuste ativo' : confidence >= 80 ? 'Alta' : 'Em treinamento'}</p>
            </div>
            <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <Database className="w-4 h-4 text-cyan" />
                <p className="text-xs text-slate-500">Termos Processados</p>
              </div>
              <p className="text-2xl font-bold text-white">{terms.length}</p>
              <p className="text-xs text-slate-500 mt-1">{mediumCount} média · {longCount} longa</p>
            </div>
            <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle className="w-4 h-4 text-emerald-400" />
                <p className="text-xs text-slate-500">Termos Vencedores</p>
              </div>
              <p className="text-2xl font-bold text-emerald-400">{winnerCount}</p>
              <p className="text-xs text-slate-500 mt-1">{learningCount} aprendendo</p>
            </div>
            <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <Target className="w-4 h-4 text-amber-400" />
                <p className="text-xs text-slate-500">Parâmetros Atualizados</p>
              </div>
              <p className="text-2xl font-bold text-amber-400">{mlModel?.param_changes_applied || 0}</p>
              <p className="text-xs text-slate-500 mt-1">{mlModel?.training_samples || 0} amostras</p>
            </div>
          </div>

          {/* Parâmetros atuais do modelo */}
          {mlModel && (
            <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
              <button
                onClick={() => setShowParams(v => !v)}
                className="w-full flex items-center justify-between px-5 py-3 hover:bg-surface-2/40 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <BarChart2 className="w-4 h-4 text-slate-400" />
                  <h3 className="text-sm font-semibold text-white">Regras de Bid Aprendidas</h3>
                  {confidence >= 95 && (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-emerald-400/10 border-emerald-400/20 text-emerald-400 flex items-center gap-1">
                      <Zap className="w-2.5 h-2.5" /> Auto-aplicado
                    </span>
                  )}
                </div>
                {showParams ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
              </button>
              {showParams && (
                <div className="border-t border-surface-2 p-5 grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Ajustes de Bid</p>
                    <div className="space-y-0.5">
                      <ParamChange label="Aumento (vencedor)" before={15} after={mlModel.bid_winner_increase_pct} unit="%" />
                      <ParamChange label="Aumento (forte)" before={10} after={mlModel.bid_strong_winner_increase_pct} unit="%" />
                      <ParamChange label="Redução (desperdício)" before={15} after={mlModel.bid_wasting_reduce_pct} unit="%" />
                      <ParamChange label="Máx. aumento/ciclo" before={15} after={mlModel.max_bid_increase_pct} unit="%" />
                      <ParamChange label="Máx. redução/ciclo" before={20} after={mlModel.max_bid_decrease_pct} unit="%" />
                    </div>
                    <div className="mt-3 space-y-1.5">
                      <div className="flex justify-between text-xs"><span className="text-slate-500">Bid mínimo</span><span className="font-mono text-white">{currencySymbol}{(mlModel.min_bid || 0.1).toFixed(2)}</span></div>
                      <div className="flex justify-between text-xs"><span className="text-slate-500">Bid máximo</span><span className="font-mono text-white">{currencySymbol}{(mlModel.max_bid || 5).toFixed(2)}</span></div>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Thresholds de Decisão</p>
                    <div className="space-y-1.5">
                      <div className="flex justify-between text-xs"><span className="text-slate-500">ACoS alvo</span><span className="font-mono text-cyan">{mlModel.target_acos || 25}%</span></div>
                      <div className="flex justify-between text-xs"><span className="text-slate-500">ACoS máx.</span><span className="font-mono text-amber-400">{mlModel.max_acos || 40}%</span></div>
                      <div className="flex justify-between text-xs"><span className="text-slate-500">ROAS alvo</span><span className="font-mono text-emerald-400">{mlModel.target_roas || 4}x</span></div>
                      <div className="flex justify-between text-xs"><span className="text-slate-500">Cliques mín. para decisão</span><span className="font-mono text-white">{mlModel.min_clicks_for_decision || 8}</span></div>
                      <div className="flex justify-between text-xs"><span className="text-slate-500">Spend mín. para decisão</span><span className="font-mono text-white">{currencySymbol}{mlModel.min_spend_for_decision || 5}</span></div>
                      <div className="flex justify-between text-xs"><span className="text-slate-500">Pedidos mín. para escalar</span><span className="font-mono text-white">{mlModel.min_orders_for_scale || 2}</span></div>
                      <div className="flex justify-between text-xs"><span className="text-slate-500">Cooldown (horas)</span><span className="font-mono text-white">{mlModel.cooldown_hours || 24}h</span></div>
                    </div>
                    {mlModel.last_param_update_reason && (
                      <div className="mt-3 p-2.5 bg-surface-2/60 rounded-lg">
                        <p className="text-[10px] text-slate-500 italic">Último ajuste: {mlModel.last_param_update_reason}</p>
                      </div>
                    )}
                  </div>
                  {mlModel.feature_importances && (() => {
                    try {
                      const fi = JSON.parse(mlModel.feature_importances);
                      const entries = Object.entries(fi).sort(([,a], [,b]) => b - a).slice(0, 6);
                      return (
                        <div className="md:col-span-2">
                          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Importância das Features</p>
                          <div className="space-y-2">
                            {entries.map(([feat, val]) => (
                              <div key={feat} className="flex items-center gap-3">
                                <span className="text-xs text-slate-400 w-36 truncate">{feat}</span>
                                <div className="flex-1 h-1.5 bg-surface-3 rounded-full overflow-hidden">
                                  <div className="h-full bg-violet-400 rounded-full" style={{ width: `${Math.min(val * 100, 100)}%` }} />
                                </div>
                                <span className="text-xs text-violet-400 w-8 text-right">{(val * 100).toFixed(0)}%</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    } catch { return null; }
                  })()}
                </div>
              )}
            </div>
          )}

          {/* Termos de cauda média/longa */}
          <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
            <div className="px-5 py-3 border-b border-surface-2 flex items-center justify-between flex-wrap gap-2">
              <div>
                <h3 className="text-sm font-semibold text-white">Termos de Cauda Média e Longa</h3>
                <p className="text-xs text-slate-500 mt-0.5">{displayTerms.length} termos · {mediumCount} cauda média · {longCount} cauda longa</p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex gap-1">
                  {[
                    { k: 'all', label: 'Todos' },
                    { k: 'medium', label: `Média (${mediumCount})` },
                    { k: 'long', label: `Longa (${longCount})` },
                  ].map(f => (
                    <button key={f.k} onClick={() => setFilterTail(f.k)}
                      className={`px-2.5 py-1 text-xs rounded-lg transition-colors ${filterTail === f.k ? 'bg-cyan/20 text-cyan' : 'bg-surface-2 text-slate-500 hover:text-slate-300'}`}>
                      {f.label}
                    </button>
                  ))}
                </div>
                <div className="flex gap-1">
                  {[
                    { k: 'all', label: 'Todos' },
                    { k: 'winner', label: 'Vencedores' },
                    { k: 'learning', label: 'Aprendendo' },
                    { k: 'wasting', label: 'Desperdiçando' },
                  ].map(f => (
                    <button key={f.k} onClick={() => setFilterClass(f.k)}
                      className={`px-2.5 py-1 text-xs rounded-lg transition-colors ${filterClass === f.k ? 'bg-violet-500/20 text-violet-400' : 'bg-surface-2 text-slate-500 hover:text-slate-300'}`}>
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {displayTerms.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-14 gap-3 text-center">
                <Brain className="w-8 h-8 text-slate-600" />
                <p className="text-sm text-slate-400">Nenhum termo neste filtro</p>
                <p className="text-xs text-slate-600">Execute o ciclo ML para popular o TermBank</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-surface-2 bg-surface-2/30">
                      {['Termo', 'Classificação', 'Confiança / Score', 'Pedidos', 'Vendas', 'Spend', 'ASIN', ''].map(h => (
                        <th key={h} className="px-3 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap first:pl-4">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {displayTerms.slice(0, 200).map(t => (
                      <TermRow key={t.id} term={t} currencySymbol={currencySymbol} />
                    ))}
                  </tbody>
                </table>
                {displayTerms.length > 200 && (
                  <p className="text-xs text-slate-600 text-center py-3">Mostrando 200 de {displayTerms.length} termos</p>
                )}
              </div>
            )}
          </div>

          {/* Eventos de aprendizado recentes */}
          {learningEvents.length > 0 && (
            <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b border-surface-2">
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <Clock className="w-4 h-4 text-slate-400" /> Eventos de Aprendizado Recentes
                </h3>
              </div>
              <div className="divide-y divide-surface-2/40">
                {learningEvents.slice(0, 10).map(ev => (
                  <div key={ev.id} className="px-5 py-3 flex items-start gap-3 hover:bg-surface-2/30 transition-colors">
                    <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${ev.outcome === 'positive' ? 'bg-emerald-400' : ev.outcome === 'negative' ? 'bg-red-400' : 'bg-slate-500'}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-white font-medium truncate">{ev.event_type || ev.action || 'Evento de aprendizado'}</p>
                      {ev.notes && <p className="text-xs text-slate-500 mt-0.5 truncate">{ev.notes}</p>}
                    </div>
                    <span className="text-xs text-slate-600 flex-shrink-0 whitespace-nowrap">
                      {ev.created_date ? new Date(ev.created_date).toLocaleDateString('pt-BR') : '—'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Aviso de confiança baixa */}
          {mlModel && confidence < 60 && (
            <div className="flex items-start gap-3 p-4 bg-amber-500/10 border border-amber-500/25 rounded-xl">
              <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-amber-300">Confiança baixa — auto-ajuste inativo</p>
                <p className="text-xs text-slate-400 mt-1">
                  O modelo precisa de confiança ≥ 95% para atualizar parâmetros automaticamente. Execute mais ciclos ML após sincronizar dados de campanhas.
                </p>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}