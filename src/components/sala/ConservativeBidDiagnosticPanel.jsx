import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Search, Loader2, ChevronDown, ChevronRight, AlertTriangle,
  TrendingDown, TrendingUp, Minus, Clock, CheckCircle, XCircle, Info
} from 'lucide-react';

const DECISION_TYPE_CONFIG = {
  scale:    { label: 'Escala',    color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20', icon: TrendingUp },
  reduce:   { label: 'Redução',   color: 'text-red-400 bg-red-500/10 border-red-500/20',             icon: TrendingDown },
  maintain: { label: 'Mantido',   color: 'text-slate-400 bg-slate-500/10 border-slate-500/20',       icon: Minus },
  skipped:  { label: 'Ignorado',  color: 'text-amber-400 bg-amber-500/10 border-amber-500/20',       icon: Clock },
};

function DecisionRow({ d }) {
  const [open, setOpen] = useState(false);
  const outcome = d.action?.toLowerCase().includes('scale') ? 'scale'
    : d.action?.toLowerCase().includes('reduce') || d.decision_type === 'bid_adjustment' && (d.proposed_value || 0) < (d.current_value || 0) ? 'reduce'
    : d.rationale?.toLowerCase().includes('skip') || d.rationale?.toLowerCase().includes('insufici') || d.rationale?.toLowerCase().includes('min_click') ? 'skipped'
    : 'maintain';

  const cfg = DECISION_TYPE_CONFIG[outcome];
  const Icon = cfg.icon;
  const hasDetail = !!(d.rationale || d.data_used || d.proposed_value != null);

  return (
    <div className="border-b border-surface-2/40 last:border-0">
      <button
        onClick={() => hasDetail && setOpen(v => !v)}
        disabled={!hasDetail}
        className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-2/30 transition-colors"
      >
        {hasDetail
          ? (open ? <ChevronDown className="w-3 h-3 text-slate-500 flex-shrink-0" /> : <ChevronRight className="w-3 h-3 text-slate-500 flex-shrink-0" />)
          : <div className="w-3 h-3 flex-shrink-0" />}

        <span className={`text-[10px] font-bold px-2 py-0.5 rounded border flex items-center gap-1 flex-shrink-0 ${cfg.color}`}>
          <Icon className="w-2.5 h-2.5" />
          {cfg.label}
        </span>

        <span className="text-xs text-white font-medium truncate flex-1">
          {d.keyword_text || d.action || d.entity_id || '—'}
        </span>

        <div className="flex items-center gap-3 flex-shrink-0 text-[10px] text-slate-500">
          {d.current_value != null && (
            <span>Bid atual: <span className="text-slate-300 font-mono">R${Number(d.current_value).toFixed(2)}</span></span>
          )}
          {d.proposed_value != null && (
            <span>→ <span className={`font-mono font-semibold ${(d.proposed_value || 0) > (d.current_value || 0) ? 'text-emerald-400' : 'text-red-400'}`}>R${Number(d.proposed_value).toFixed(2)}</span></span>
          )}
          {d.confidence != null && (
            <span className="text-slate-600">conf: {d.confidence}%</span>
          )}
        </div>
      </button>

      {open && hasDetail && (
        <div className="px-10 pb-3 space-y-1.5">
          {d.rationale && (
            <div className="rounded-lg bg-surface-2/50 border border-surface-3/50 px-3 py-2">
              <p className="text-[10px] font-semibold text-slate-400 mb-0.5">Motivo</p>
              <p className="text-xs text-slate-300">{d.rationale}</p>
            </div>
          )}
          {d.data_used && (
            <div className="rounded-lg bg-surface-2/50 border border-surface-3/50 px-3 py-2">
              <p className="text-[10px] font-semibold text-slate-400 mb-0.5">Dados utilizados</p>
              <p className="text-xs text-slate-400 whitespace-pre-wrap break-words">{d.data_used}</p>
            </div>
          )}
          {d.metric_window && (
            <p className="text-[10px] text-slate-600">Janela de dados: <span className="text-slate-400">{d.metric_window}</span></p>
          )}
        </div>
      )}
    </div>
  );
}

export default function ConservativeBidDiagnosticPanel({ amazonAccountId }) {
  const [loading, setLoading] = useState(true);
  const [log, setLog] = useState(null);
  const [decisions, setDecisions] = useState([]);
  const [settings, setSettings] = useState(null);
  const [search, setSearch] = useState('');
  const [filterOutcome, setFilterOutcome] = useState('all');

  const load = useCallback(async () => {
    if (!amazonAccountId) return;
    setLoading(true);
    try {
      const [logs, decs, perfSettings] = await Promise.all([
        base44.entities.SyncExecutionLog.filter(
          { amazon_account_id: amazonAccountId, operation: 'runConservativeBidOptimizer' },
          '-started_at',
          1
        ),
        base44.entities.OptimizationDecision.filter(
          { amazon_account_id: amazonAccountId, source_function: 'runConservativeBidOptimizer' },
          '-created_at',
          200
        ),
        base44.entities.PerformanceSettings.filter({ amazon_account_id: amazonAccountId }, null, 1),
      ]);

      setLog(logs[0] || null);
      // Filtrar últimas 48h
      const since = new Date(Date.now() - 48 * 3600000).toISOString();
      setDecisions(decs.filter(d => (d.created_at || d.created_date || '') >= since));
      setSettings(perfSettings[0] || null);
    } catch (e) {
      console.error('ConservativeBidDiagnosticPanel error:', e);
    } finally {
      setLoading(false);
    }
  }, [amazonAccountId]);

  useEffect(() => { load(); }, [load]);

  // Parse do result_summary do último log
  const summary = (() => {
    if (!log?.result_summary) return null;
    try { return JSON.parse(log.result_summary); } catch { return null; }
  })();

  // Categorias derivadas dos decisions
  const categorize = (d) => {
    const a = (d.action || '').toLowerCase();
    const r = (d.rationale || '').toLowerCase();
    if (a.includes('scale')) return 'scale';
    if (d.decision_type === 'bid_adjustment' && (d.proposed_value || 0) < (d.current_value || 0)) return 'reduce';
    if (r.includes('skip') || r.includes('insufici') || r.includes('min_click') || r.includes('cooldown')) return 'skipped';
    return 'maintain';
  };

  const counts = { scale: 0, reduce: 0, maintain: 0, skipped: 0 };
  decisions.forEach(d => { counts[categorize(d)]++; });

  const filtered = decisions.filter(d => {
    const matchFilter = filterOutcome === 'all' || categorize(d) === filterOutcome;
    const matchSearch = !search || (d.keyword_text || d.action || d.entity_id || '').toLowerCase().includes(search.toLowerCase());
    return matchFilter && matchSearch;
  });

  const lastRunAt = log?.completed_at || log?.started_at;
  const logStatus = log?.status;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Search className="w-4 h-4 text-amber-400" />
            Diagnóstico — Conservative Bid Optimizer
          </h3>
          <p className="text-[10px] text-slate-500 mt-0.5">
            Por que o motor não reduziu bids? Veja o motivo exato por keyword.
          </p>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white text-xs rounded-lg transition-colors disabled:opacity-50">
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : '↻'} Atualizar
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="w-5 h-5 text-cyan animate-spin" /></div>
      ) : (
        <>
          {/* Último ciclo + thresholds */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {/* Info do ciclo */}
            <div className={`rounded-xl border p-4 ${
              logStatus === 'success' ? 'border-emerald-500/20 bg-emerald-500/5' :
              logStatus === 'error'   ? 'border-red-500/20 bg-red-500/5' :
              'border-surface-2 bg-surface-1'
            }`}>
              <p className="text-[10px] font-semibold text-slate-400 mb-2 uppercase tracking-wide">Último Ciclo</p>
              {!log ? (
                <p className="text-xs text-slate-500">Nenhum ciclo registrado ainda.</p>
              ) : (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    {logStatus === 'success' ? <CheckCircle className="w-4 h-4 text-emerald-400" /> : logStatus === 'error' ? <XCircle className="w-4 h-4 text-red-400" /> : <AlertTriangle className="w-4 h-4 text-amber-400" />}
                    <span className={`text-xs font-semibold ${logStatus === 'success' ? 'text-emerald-300' : logStatus === 'error' ? 'text-red-300' : 'text-amber-300'}`}>
                      {logStatus === 'success' ? 'Concluído com sucesso' : logStatus === 'error' ? 'Erro na execução' : logStatus || 'Desconhecido'}
                    </span>
                  </div>
                  {lastRunAt && (
                    <p className="text-[10px] text-slate-500">
                      Executado em: <span className="text-slate-300">{new Date(lastRunAt).toLocaleString('pt-BR')}</span>
                    </p>
                  )}
                  {log.duration_ms && (
                    <p className="text-[10px] text-slate-500">Duração: <span className="text-slate-300">{(log.duration_ms / 1000).toFixed(1)}s</span></p>
                  )}
                  {summary && (
                    <div className="mt-2 pt-2 border-t border-surface-3/50 space-y-0.5">
                      {summary.campaigns_analyzed != null && (
                        <p className="text-[10px] text-slate-400">Campanhas analisadas: <span className="text-white font-semibold">{summary.campaigns_analyzed}</span></p>
                      )}
                      {summary.keywords_analyzed != null && (
                        <p className="text-[10px] text-slate-400">Keywords analisadas: <span className="text-white font-semibold">{summary.keywords_analyzed}</span></p>
                      )}
                      {summary.bid_reduces != null && (
                        <p className="text-[10px] text-slate-400">Reduções aplicadas: <span className={`font-semibold ${summary.bid_reduces === 0 ? 'text-amber-400' : 'text-red-400'}`}>{summary.bid_reduces}</span></p>
                      )}
                      {summary.bid_scales != null && (
                        <p className="text-[10px] text-slate-400">Escalas aplicadas: <span className="text-emerald-400 font-semibold">{summary.bid_scales}</span></p>
                      )}
                      {summary.data_window && (
                        <p className="text-[10px] text-slate-400">Janela de dados: <span className="text-slate-300">{summary.data_window}</span></p>
                      )}
                    </div>
                  )}
                  {log.error_message && (
                    <div className="mt-2 px-2 py-1.5 bg-red-500/10 border border-red-500/20 rounded-lg">
                      <p className="text-[10px] text-red-400">{log.error_message}</p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Thresholds ativos */}
            <div className="rounded-xl border border-surface-2 bg-surface-1 p-4">
              <p className="text-[10px] font-semibold text-slate-400 mb-2 uppercase tracking-wide flex items-center gap-1.5">
                <Info className="w-3 h-3" /> Critérios Ativos (PerformanceSettings)
              </p>
              {!settings ? (
                <p className="text-xs text-slate-500">Configurações não encontradas.</p>
              ) : (
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                  {[
                    { label: 'Target ACoS',    value: `${settings.target_acos ?? 15}%` },
                    { label: 'Max ACoS',        value: `${settings.max_acos ?? 25}%` },
                    { label: 'Min Bid',         value: `R$${(settings.min_bid ?? 0.5).toFixed(2)}` },
                    { label: 'Max Bid',         value: `R$${(settings.max_bid ?? 5).toFixed(2)}` },
                    { label: 'Max ↑ Bid',       value: `${settings.max_bid_increase_pct ?? 15}%` },
                    { label: 'Max ↓ Bid',       value: `${settings.max_bid_decrease_pct ?? 20}%` },
                  ].map(item => (
                    <div key={item.label} className="flex items-center justify-between text-[10px] py-0.5 border-b border-surface-3/30 last:border-0">
                      <span className="text-slate-500">{item.label}</span>
                      <span className="text-white font-mono font-semibold">{item.value}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-3 px-3 py-2 bg-amber-500/5 border border-amber-500/15 rounded-lg">
                <p className="text-[10px] text-amber-400 font-medium">Causa raiz mais comum: "skipped"</p>
                <p className="text-[10px] text-slate-500 mt-0.5">
                  Keywords são ignoradas quando têm cliques abaixo do mínimo configurado no motor,
                  dados insuficientes no período, ou cooldown ativo após ajuste recente.
                </p>
              </div>
            </div>
          </div>

          {/* KPI breakdown */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {Object.entries(DECISION_TYPE_CONFIG).map(([key, cfg]) => {
              const Icon = cfg.icon;
              return (
                <button
                  key={key}
                  onClick={() => setFilterOutcome(f => f === key ? 'all' : key)}
                  className={`rounded-xl border p-3 text-left transition-colors ${
                    filterOutcome === key ? 'border-cyan/40 bg-cyan/5' : 'border-surface-2 bg-surface-1 hover:border-surface-3'
                  }`}
                >
                  <div className="flex items-center gap-1.5 mb-1">
                    <Icon className={`w-3.5 h-3.5 ${cfg.color.split(' ')[0]}`} />
                    <span className="text-[10px] font-semibold text-slate-400">{cfg.label}</span>
                  </div>
                  <p className={`text-2xl font-bold ${cfg.color.split(' ')[0]}`}>{counts[key]}</p>
                  <p className="text-[10px] text-slate-600 mt-0.5">keywords</p>
                </button>
              );
            })}
          </div>

          {/* Zero reduções — aviso explicativo */}
          {decisions.length > 0 && counts.reduce === 0 && (
            <div className="flex items-start gap-3 px-4 py-3 bg-amber-500/5 border border-amber-500/20 rounded-xl">
              <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-semibold text-amber-300">Nenhuma redução de bid neste ciclo</p>
                <p className="text-xs text-slate-400 mt-0.5">
                  Isso ocorre quando: (1) keywords não atingem o mínimo de cliques para decisão;
                  (2) o ACoS atual está abaixo do target (escalas prevalecem); ou
                  (3) cooldown pós-ajuste ainda está ativo.
                  Veja abaixo o motivo por keyword.
                </p>
              </div>
            </div>
          )}

          {/* Lista de decisions */}
          <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-surface-2 flex items-center gap-3 flex-wrap">
              <p className="text-sm font-semibold text-white flex-1">
                Detalhes por Keyword ({filtered.length})
              </p>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500" />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Filtrar keyword..."
                  className="pl-7 pr-3 py-1.5 bg-surface-2 border border-surface-3 rounded-lg text-xs text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan/40 w-44"
                />
              </div>
              <div className="flex gap-1">
                {['all', 'scale', 'maintain', 'skipped', 'reduce'].map(k => (
                  <button
                    key={k}
                    onClick={() => setFilterOutcome(k)}
                    className={`px-2 py-1 text-[10px] font-medium rounded transition-colors ${
                      filterOutcome === k
                        ? 'bg-cyan/20 text-cyan border border-cyan/30'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    {k === 'all' ? 'Todos' : DECISION_TYPE_CONFIG[k]?.label}
                  </button>
                ))}
              </div>
            </div>

            {decisions.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 gap-2 text-center">
                <Clock className="w-8 h-8 text-slate-700" />
                <p className="text-sm text-slate-500">Sem decisões do optimizer nas últimas 48h.</p>
                <p className="text-xs text-slate-600">O motor ainda não rodou ou não registrou decisões individuais.</p>
              </div>
            ) : filtered.length === 0 ? (
              <div className="py-10 text-center text-sm text-slate-500">Nenhuma keyword com este filtro.</div>
            ) : (
              <div className="max-h-[480px] overflow-y-auto scrollbar-thin divide-y divide-surface-2/40">
                {filtered.map((d, i) => (
                  <DecisionRow key={d.id || i} d={d} />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}