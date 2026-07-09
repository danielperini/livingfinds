import React, { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { Link } from 'react-router-dom';
import {
  Zap, RefreshCw, Play, Loader2, CheckCircle, XCircle,
  Clock, AlertTriangle, ChevronDown, ChevronRight, Settings, Target
} from 'lucide-react';

const ACTION_LABELS = {
  adjust_bid: 'Ajuste de Bid',
  adjust_budget: 'Ajuste de Budget',
  create_manual_exact_campaign: 'Criar EXACT',
  create_manual_phrase_campaign: 'Criar PHRASE',
  create_product_target_campaign: 'Criar Product Target',
  pause_keyword: 'Pausar Keyword',
  pause_campaign: 'Pausar Campanha',
  archive_campaign: 'Arquivar Campanha',
  negative_keyword: 'Negativar Termo',
  adjust_dayparting: 'Dayparting',
  recommend_placement: 'Rec. Placement',
  repair_campaign: 'Reparar Campanha',
  hold_for_maturation: 'Aguardar Maturação',
  redistribute_budget: 'Redistribuir Budget',
  increase_discovery: 'Aumentar Descoberta',
  reduce_waste: 'Reduzir Desperdício',
  protect_margin: 'Proteger Margem',
};

const RISK_STYLES = {
  low: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  medium: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  high: 'bg-red-500/10 text-red-400 border-red-500/20',
};

const GOAL_STYLES = {
  acos: 'text-red-400', roas: 'text-emerald-400', tacos: 'text-orange-400',
  cpc: 'text-violet-400', budget: 'text-cyan', keyword: 'text-amber-400',
  campaign: 'text-blue-400', placement: 'text-pink-400', dayparting: 'text-teal-400',
  margin: 'text-lime-400', maturation: 'text-slate-400', stock: 'text-amber-300',
};

const STATUS_STYLES = {
  pending: 'bg-amber-500/10 text-amber-400',
  maturing: 'bg-blue-500/10 text-blue-400',
  evaluated: 'bg-slate-500/10 text-slate-400',
  success: 'bg-emerald-500/10 text-emerald-400',
  failed: 'bg-red-500/10 text-red-400',
};

function fmtBRL(v) {
  if (v == null || isNaN(v)) return '—';
  return `R$${Number(v).toFixed(2)}`;
}
function fmtPct(v) {
  if (v == null || isNaN(v)) return '—';
  return `${Number(v).toFixed(1)}%`;
}
function maturationRemaining(until) {
  if (!until) return null;
  const ms = new Date(until).getTime() - Date.now();
  if (ms <= 0) return 'Pronto para avaliação';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m restantes`;
}

function DecisionCard({ dec, expanded, onToggle }) {
  const before = dec.before_metrics || {};
  const payload = dec.action_taken || dec.action_payload || {};
  const statusStyle = STATUS_STYLES[dec.status] || STATUS_STYLES.pending;

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
      <button onClick={onToggle} className="w-full flex items-start gap-3 p-4 hover:bg-surface-2/40 transition-colors text-left">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${RISK_STYLES[dec.risk_level] || RISK_STYLES.medium}`}>
              {dec.risk_level?.toUpperCase()}
            </span>
            <span className={`text-xs font-semibold ${GOAL_STYLES[dec.goal_targeted] || 'text-slate-300'}`}>
              {(dec.goal_targeted || '').toUpperCase()}
            </span>
            <span className="text-xs font-semibold text-slate-200">
              {ACTION_LABELS[dec.action_type] || dec.action_type}
            </span>
            {dec.status && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${statusStyle}`}>{dec.status}</span>
            )}
            {dec.use_ai && <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400 border border-violet-500/20">IA</span>}
          </div>
          <p className="text-xs font-semibold text-slate-300 truncate">{dec.strategy_name || dec.strategy_id}</p>
          <p className="text-[10px] text-slate-500 mt-0.5 line-clamp-1">{payload.reason || dec.reason}</p>
        </div>
        <div className="flex-shrink-0 mt-0.5">
          {expanded ? <ChevronDown className="w-4 h-4 text-slate-500" /> : <ChevronRight className="w-4 h-4 text-slate-500" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-surface-2 p-4 space-y-4">
          {/* Campanha / Keyword */}
          <div className="text-xs text-slate-400 space-y-0.5">
            {dec.keyword_text && <p>🔑 Keyword: <span className="text-white font-semibold">{dec.keyword_text}</span></p>}
            {dec.campaign_id && <p>📢 Campanha: <span className="font-mono text-[10px] text-slate-300">{dec.campaign_id}</span></p>}
            {dec.asin && <p>📦 ASIN: <span className="font-mono text-[10px] text-cyan">{dec.asin}</span></p>}
          </div>

          {/* Métricas atuais vs metas */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              { label: 'ACoS atual', value: fmtPct(before.acos), color: 'text-slate-200' },
              { label: 'ROAS atual', value: before.roas ? `${Number(before.roas).toFixed(2)}x` : '—', color: 'text-slate-200' },
              { label: 'CPC atual', value: fmtBRL(before.cpc), color: 'text-slate-200' },
              { label: 'Bid atual', value: fmtBRL(before.bid), color: 'text-slate-200' },
            ].map(m => (
              <div key={m.label} className="bg-surface-2 rounded-lg p-2 text-center">
                <p className="text-[9px] text-slate-500">{m.label}</p>
                <p className={`text-sm font-bold ${m.color}`}>{m.value}</p>
              </div>
            ))}
          </div>

          {/* Ação proposta */}
          <div className="bg-surface-2 rounded-lg p-3 space-y-1.5">
            <p className="text-[10px] font-semibold text-slate-400 uppercase">Ação proposta</p>
            <p className="text-xs font-bold text-white">{ACTION_LABELS[dec.action_type] || dec.action_type}</p>
            {payload.new_bid != null && (
              <p className="text-xs text-cyan">Bid proposto: <span className="font-bold">{fmtBRL(payload.new_bid)}</span>
                {before.bid && <span className="text-slate-500 ml-1">← era {fmtBRL(before.bid)}</span>}
              </p>
            )}
            {payload.new_budget != null && (
              <p className="text-xs text-amber-400">Budget proposto: <span className="font-bold">{fmtBRL(payload.new_budget)}</span></p>
            )}
            {payload.keyword && (
              <p className="text-xs text-emerald-400">Keyword: <span className="font-semibold">{payload.keyword}</span></p>
            )}
            {payload.recommendation && (
              <p className="text-xs text-pink-400">Recomendação: {payload.recommendation}</p>
            )}
            <p className="text-[10px] text-slate-500 mt-1">{payload.reason}</p>
          </div>

          {/* Maturação */}
          {dec.maturation_hours > 0 && (
            <div className="flex items-center gap-2 text-xs text-blue-400">
              <Clock className="w-3.5 h-3.5 flex-shrink-0" />
              <span>Maturação: {dec.maturation_hours}h · {maturationRemaining(dec.maturation_until) || `até ${new Date(dec.maturation_until).toLocaleString('pt-BR')}`}</span>
            </div>
          )}

          {/* Resultados pós-ação */}
          {(dec.after_metrics_24h || dec.after_metrics_48h || dec.after_metrics_7d) && (
            <div className="space-y-2">
              <p className="text-[10px] font-semibold text-slate-400 uppercase">Resultados pós-ação</p>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: '24h', data: dec.after_metrics_24h },
                  { label: '48h', data: dec.after_metrics_48h },
                  { label: '7 dias', data: dec.after_metrics_7d },
                ].map(({ label, data }) => data ? (
                  <div key={label} className="bg-surface-2 rounded-lg p-2">
                    <p className="text-[9px] text-slate-500 mb-1">{label}</p>
                    <p className="text-[10px] text-slate-300">ACoS: {fmtPct(data.acos)}</p>
                    <p className="text-[10px] text-slate-300">ROAS: {data.roas ? `${Number(data.roas).toFixed(2)}x` : '—'}</p>
                  </div>
                ) : null)}
              </div>
              {dec.success != null && (
                <div className={`flex items-center gap-2 text-xs font-semibold ${dec.success ? 'text-emerald-400' : 'text-red-400'}`}>
                  {dec.success ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                  {dec.success ? 'Estratégia bem-sucedida' : `Falha: ${dec.failure_reason || 'sem detalhes'}`}
                </div>
              )}
              {dec.next_recommendation && (
                <p className="text-[10px] text-slate-500">Próxima ação: {dec.next_recommendation}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function StrategyEnginePage() {
  const [account, setAccount] = useState(null);
  const [perfSettings, setPerfSettings] = useState(null);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [expandedIds, setExpandedIds] = useState(new Set());
  const [filterGoal, setFilterGoal] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [dryRun, setDryRun] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accounts.find(a => a.status === 'connected') || accounts[0] || null;
      setAccount(acc);
      if (!acc) { setLoading(false); return; }

      const [psList, logsList] = await Promise.all([
        base44.entities.PerformanceSettings.filter({ amazon_account_id: acc.id }, '-updated_at', 1).catch(() => []),
        base44.entities.StrategyExecutionLog.filter({ amazon_account_id: acc.id }, '-created_at', 100).catch(() => []),
      ]);
      setPerfSettings(psList[0] || null);
      setLogs(logsList);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const runEngine = async () => {
    if (!account || running) return;
    setRunning(true);
    setResult(null);
    setError(null);
    try {
      const res = await base44.functions.invoke('runStrategyEngine', {
        amazon_account_id: account.id,
        dry_run: dryRun,
      });
      setResult(res?.data || null);
      if (!dryRun) await loadData();
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  const evaluateMaturations = async () => {
    if (!account || running) return;
    setRunning(true);
    try {
      const res = await base44.functions.invoke('runStrategyEngine', {
        amazon_account_id: account.id,
        evaluate_only: true,
      });
      setResult(res?.data || null);
      await loadData();
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  const toggleExpand = (id) => setExpandedIds(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const allDecisions = result?.decisions || [];
  const displayItems = logs.map(l => ({
    ...l,
    before_metrics: l.before_metrics || {},
    action_payload: l.action_taken || {},
    strategy_name: l.strategy_id,
    goal_targeted: l.action_type?.includes('bid') ? 'acos' : 'campaign',
    risk_level: l.risk_level || 'medium',
    use_ai: false,
  }));

  const allItems = allDecisions.length > 0
    ? allDecisions.map(d => ({ ...d, id: `dec-${d.strategy_id}-${d.entity_id || Math.random()}` }))
    : displayItems;

  const goals = ['all', 'acos', 'roas', 'tacos', 'cpc', 'budget', 'keyword', 'campaign', 'dayparting', 'placement', 'margin'];
  const statuses = ['all', 'pending', 'maturing', 'evaluated', 'success', 'failed'];

  const filtered = allItems.filter(d => {
    if (filterGoal !== 'all' && d.goal_targeted !== filterGoal) return false;
    if (filterStatus !== 'all' && d.status !== filterStatus && !allDecisions.length) return false;
    return true;
  });

  const ps = perfSettings || {};
  const maturingCount = displayItems.filter(l => l.status === 'maturing').length;
  const successCount = displayItems.filter(l => l.status === 'success').length;

  return (
    <div className="p-5 space-y-5 animate-fade-in">

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-violet-500/15 border border-violet-500/20 flex items-center justify-center">
            <Zap className="w-5 h-5 text-violet-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Motor de Estratégias</h1>
            <p className="text-xs text-slate-500">100 estratégias · Ciclo MÉTRICAS → METAS → DECISÃO → MATURAÇÃO → ANÁLISE</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={loadData} disabled={loading}
            className="p-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={evaluateMaturations} disabled={running || !account}
            className="flex items-center gap-1.5 px-3 py-2 bg-blue-500/10 border border-blue-500/20 text-blue-400 hover:bg-blue-500/20 text-xs font-semibold rounded-lg transition-colors disabled:opacity-50">
            <Clock className="w-3.5 h-3.5" />
            Avaliar Maturações
          </button>
          <div className="flex items-center gap-2 px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg">
            <span className="text-xs text-slate-400">Simulação</span>
            <button onClick={() => setDryRun(!dryRun)}
              className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 ${dryRun ? 'bg-amber-500' : 'bg-cyan'}`}>
              <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${dryRun ? 'left-0.5' : 'left-4'}`} />
            </button>
          </div>
          <button onClick={runEngine} disabled={running || !account}
            className="flex items-center gap-1.5 px-4 py-2 bg-violet-500/20 border border-violet-500/30 text-violet-300 hover:bg-violet-500/30 text-sm font-semibold rounded-lg transition-colors disabled:opacity-50">
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {running ? 'Analisando...' : dryRun ? 'Simular Motor' : 'Executar Motor'}
          </button>
        </div>
      </div>

      {!account && !loading && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 text-xs text-amber-400">
          Nenhuma conta Amazon conectada. <Link to="/settings" className="underline">Configurar →</Link>
        </div>
      )}

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 flex items-center gap-2 text-xs text-red-400">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" /> {error}
        </div>
      )}

      {/* Metas configuradas */}
      {perfSettings && (
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Target className="w-4 h-4 text-cyan" />
            <p className="text-xs font-semibold text-slate-300">Metas ativas — fonte única do motor</p>
            <Link to="/settings" className="ml-auto text-[10px] text-cyan hover:underline flex items-center gap-1"><Settings className="w-3 h-3" />Editar</Link>
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {[
              { label: 'ACoS alvo', value: `${ps.target_acos || 10}%`, color: 'text-cyan' },
              { label: 'ACoS máx.', value: `${ps.max_acos || 15}%`, color: 'text-red-400' },
              { label: 'ROAS alvo', value: `${ps.target_roas || 4}x`, color: 'text-emerald-400' },
              { label: 'CPC máx.', value: ps.max_cpc ? `R$${Number(ps.max_cpc).toFixed(2)}` : '—', color: 'text-violet-400' },
              { label: 'Bid máx.', value: ps.max_bid ? `R$${Number(ps.max_bid).toFixed(2)}` : '—', color: 'text-amber-400' },
              { label: 'Budget/dia', value: `R$${ps.daily_budget_limit || 56}`, color: 'text-slate-300' },
            ].map(m => (
              <div key={m.label} className="bg-surface-2 rounded-lg p-2 text-center">
                <p className="text-[9px] text-slate-500 mb-0.5">{m.label}</p>
                <p className={`text-sm font-bold ${m.color}`}>{m.value}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Resultado da última execução */}
      {result && (
        <div className={`rounded-xl border p-4 text-xs ${result.ok ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-red-500/5 border-red-500/20'}`}>
          <div className="flex items-center gap-2 mb-2">
            {result.ok ? <CheckCircle className="w-4 h-4 text-emerald-400" /> : <XCircle className="w-4 h-4 text-red-400" />}
            <span className="font-semibold text-slate-200">
              {result.dry_run ? '(Simulação) ' : ''}{result.decisions_generated} decisões geradas · {result.entities_evaluated} entidades avaliadas
            </span>
          </div>
          <div className="flex gap-4 text-slate-400">
            <span>Estratégias: {result.strategies_checked}</span>
            <span>Salvas: {result.decisions_saved}</span>
            <span>Fonte: {result.settings_source}</span>
          </div>
        </div>
      )}

      {/* KPIs rápidos */}
      {!loading && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Total de execuções', value: displayItems.length, color: 'text-white' },
            { label: 'Em maturação', value: maturingCount, color: 'text-blue-400' },
            { label: 'Bem-sucedidas', value: successCount, color: 'text-emerald-400' },
            { label: 'Estratégias disponíveis', value: 100, color: 'text-violet-400' },
          ].map(k => (
            <div key={k.label} className="bg-surface-1 border border-surface-2 rounded-xl p-4">
              <p className="text-[10px] text-slate-500 mb-1 uppercase">{k.label}</p>
              <p className={`text-xl font-bold ${k.color}`}>{k.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Filtros */}
      <div className="flex flex-wrap gap-2">
        <div className="flex gap-1 bg-surface-2 border border-surface-3 rounded-lg p-0.5">
          {goals.map(g => (
            <button key={g} onClick={() => setFilterGoal(g)}
              className={`px-2.5 py-1 rounded text-[10px] font-semibold transition-all capitalize ${filterGoal === g ? 'bg-cyan text-white' : 'text-slate-400 hover:text-slate-200'}`}>
              {g === 'all' ? 'Todos' : g.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="flex gap-1 bg-surface-2 border border-surface-3 rounded-lg p-0.5">
          {statuses.map(st => (
            <button key={st} onClick={() => setFilterStatus(st)}
              className={`px-2.5 py-1 rounded text-[10px] font-semibold transition-all ${filterStatus === st ? 'bg-cyan text-white' : 'text-slate-400 hover:text-slate-200'}`}>
              {st === 'all' ? 'Todos' : st}
            </button>
          ))}
        </div>
      </div>

      {/* Lista de decisões */}
      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-6 h-6 text-violet-400 animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-8 text-center">
          <Zap className="w-8 h-8 text-slate-600 mx-auto mb-3" />
          <p className="text-sm text-slate-500">Nenhuma decisão encontrada.</p>
          <p className="text-xs text-slate-600 mt-1">Execute o motor para gerar estratégias baseadas nas metas configuradas.</p>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-[10px] text-slate-500">{filtered.length} decisões{filterGoal !== 'all' ? ` · meta: ${filterGoal}` : ''}</p>
          {filtered.map(dec => (
            <DecisionCard
              key={dec.id || dec.strategy_id}
              dec={dec}
              expanded={expandedIds.has(dec.id || dec.strategy_id)}
              onToggle={() => toggleExpand(dec.id || dec.strategy_id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}