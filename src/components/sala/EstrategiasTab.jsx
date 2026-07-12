import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { Link } from 'react-router-dom';
import {
  Zap, RefreshCw, Loader2, CheckCircle, XCircle, AlertTriangle,
  Target, TrendingUp, TrendingDown, ChevronDown, ChevronRight,
  Shield, Brain, BarChart2, Settings, Package, Eye, Clock,
  Activity, DollarSign, ShoppingCart, Layers, Search, Play,
  Telescope, ArrowUpRight, Gauge, Sparkles
} from 'lucide-react';
import PerformanceSettingsHistoryTable from '@/components/strategy/PerformanceSettingsHistoryTable';
import VisibilityScoreChart from '@/components/strategy/VisibilityScoreChart';

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtBRL(v) { return v == null || isNaN(v) ? '—' : `R$${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function fmtPct(v) { return v == null || isNaN(v) ? '—' : `${Number(v).toFixed(1)}%`; }
function fmtNum(v) { return v == null ? '—' : Number(v).toLocaleString('pt-BR'); }

const INTENT_LABELS = {
  brand: 'Marca', category: 'Categoria', problem: 'Problema',
  benefit: 'Benefício', feature: 'Atributo', comparison: 'Comparação',
  competitor: 'Concorrente', commercial: 'Comercial', transactional: 'Transacional',
  informational: 'Informacional', long_tail: 'Cauda Longa', product_specific: 'Produto Específico',
};
const INTENT_COLORS = {
  high: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  medium: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  low: 'text-slate-400 bg-slate-500/10 border-slate-500/20',
};
const PRODUCT_STATE_LABELS = {
  unavailable: { label: 'Indisponível', color: 'text-red-400', bg: 'bg-red-500/10' },
  critical_stock: { label: 'Estoque Crítico', color: 'text-red-400', bg: 'bg-red-500/10' },
  low_stock: { label: 'Estoque Baixo', color: 'text-amber-400', bg: 'bg-amber-500/10' },
  learning: { label: 'Aprendendo', color: 'text-blue-400', bg: 'bg-blue-500/10' },
  inefficient: { label: 'Ineficiente', color: 'text-orange-400', bg: 'bg-orange-500/10' },
  profitable: { label: 'Lucrativo', color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  scalable: { label: 'Escalável', color: 'text-cyan bg-cyan/10', bg: 'bg-cyan/10' },
  mature: { label: 'Maduro', color: 'text-violet-400', bg: 'bg-violet-500/10' },
  discontinued: { label: 'Declínio', color: 'text-slate-500', bg: 'bg-slate-500/10' },
};
const RISK_STYLES = {
  low: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  medium: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  high: 'bg-red-500/10 text-red-400 border-red-500/20',
};

const OPPORTUNITY_STATE_LABELS = {
  no_opportunity: { label: 'Sem Oportunidade', color: 'text-slate-500', bg: 'bg-slate-500/10' },
  insufficient_data: { label: 'Dados Insuf.', color: 'text-slate-400', bg: 'bg-slate-500/10' },
  low_visibility: { label: '👁 Baixa Visib.', color: 'text-amber-400', bg: 'bg-amber-500/10' },
  emerging_opportunity: { label: '📊 Emergente', color: 'text-blue-400', bg: 'bg-blue-500/10' },
  profitable_opportunity: { label: '💰 Lucrativa', color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  high_growth_opportunity: { label: '🚀 Alto Crescimento', color: 'text-cyan', bg: 'bg-cyan/10' },
  budget_constrained: { label: '💸 Budget Limitado', color: 'text-violet-400', bg: 'bg-violet-500/10' },
  visibility_constrained: { label: '🔭 Visib. Limitada', color: 'text-amber-400', bg: 'bg-amber-500/10' },
  conversion_constrained: { label: '⚡ CVR Limitado', color: 'text-orange-400', bg: 'bg-orange-500/10' },
};

const GROWTH_DECISION_TYPES = new Set([
  'increase_bid_low_visibility', 'increase_bid_profitable_growth', 'increase_bid_high_growth',
  'increase_budget_constrained', 'increase_top_of_search', 'experimental_growth',
  'hold_for_listing_improvement', 'hold_for_more_data', 'reduce_waste', 'protect_winner',
]);

function KpiCard({ label, value, sub, tone = 'default', icon: KpiIcon }) {
  const tones = {
    default: 'border-surface-2',
    good: 'border-emerald-500/25 bg-emerald-500/5',
    warn: 'border-amber-500/25 bg-amber-500/5',
    bad: 'border-red-500/25 bg-red-500/5',
    cyan: 'border-cyan/20 bg-cyan/5',
    violet: 'border-violet-500/20 bg-violet-500/5',
  };
  return (
    <div className={`bg-surface-1 border rounded-xl p-4 ${tones[tone]}`}>
      <div className="flex items-center gap-1.5 mb-1">
        {KpiIcon && <KpiIcon className="w-3 h-3 text-slate-500" />}
        <p className="text-[10px] font-medium text-slate-500 uppercase tracking-wide">{label}</p>
      </div>
      <p className="text-xl font-bold text-white">{value}</p>
      {sub && <p className="text-[10px] text-slate-500 mt-1">{sub}</p>}
    </div>
  );
}

function IntentBadge({ intent_type, purchase_intent }) {
  const label = INTENT_LABELS[intent_type] || intent_type || '—';
  const color = INTENT_COLORS[purchase_intent] || INTENT_COLORS.low;
  return (
    <span className={`text-[9px] px-1.5 py-0.5 rounded border font-medium whitespace-nowrap ${color}`}>
      {label}
    </span>
  );
}

function DecisionRow({ dec, expanded, onToggle }) {
  const isIncrease = dec.value_after > dec.value_before;
  const isDecrease = dec.value_after < dec.value_before;
  const isPause = dec.action === 'pause_keyword' || dec.action === 'pause_campaign';
  const statusColor = {
    approved: 'text-cyan', executed: 'text-emerald-400', failed: 'text-red-400',
    pending: 'text-amber-400', skipped: 'text-slate-500',
  }[dec.status] || 'text-slate-400';

  return (
    <div className="border-b border-surface-2/50 last:border-0">
      <button onClick={onToggle} className="w-full flex items-start gap-3 px-5 py-3 hover:bg-surface-2/30 transition-colors text-left">
        {/* Ícone de direção */}
        <div className="flex-shrink-0 mt-0.5">
          {isPause ? <Shield className="w-4 h-4 text-amber-400" />
            : isIncrease ? <TrendingUp className="w-4 h-4 text-emerald-400" />
            : isDecrease ? <TrendingDown className="w-4 h-4 text-red-400" />
            : <Activity className="w-4 h-4 text-slate-500" />}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            {dec.keyword_text && dec.decision_type !== 'bid_change' && (
              <span className="text-xs font-semibold text-white truncate max-w-[200px]">{dec.keyword_text}</span>
            )}
            {dec.asin && <span className="text-[10px] font-mono text-cyan flex-shrink-0">{dec.asin}</span>}
            {dec.search_intent_type && (
              <IntentBadge intent_type={dec.search_intent_type} purchase_intent={dec.purchase_intent} />
            )}
            {dec.risk && (
              <span className={`text-[9px] px-1.5 py-0.5 rounded border font-bold ${RISK_STYLES[dec.risk] || RISK_STYLES.medium}`}>
                {dec.risk.toUpperCase()}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 text-[10px] flex-wrap">
            <span className="text-slate-500">{dec.decision_type || dec.action}</span>
            {dec.value_before != null && dec.value_after != null && (
              <span className={isIncrease ? 'text-emerald-400' : isDecrease ? 'text-red-400' : 'text-slate-400'}>
                R${(dec.value_before || 0).toFixed(2)} → R${(dec.value_after || 0).toFixed(2)}
              </span>
            )}
            <span className={`font-semibold ${statusColor}`}>{dec.status}</span>
            {dec.confidence > 0 && <span className="text-slate-600">Confiança: {dec.confidence}%</span>}
          </div>
        </div>

        <div className="flex-shrink-0">
          {expanded ? <ChevronDown className="w-4 h-4 text-slate-500" /> : <ChevronRight className="w-4 h-4 text-slate-500" />}
        </div>
      </button>

      {expanded && (
        <div className="px-5 pb-4 space-y-3">
          {/* Rationale explicado */}
          <div className="bg-surface-2/50 rounded-lg p-3">
            <p className="text-[10px] font-semibold text-slate-400 uppercase mb-1.5 flex items-center gap-1.5">
              <Brain className="w-3 h-3" /> Por que esta decisão?
            </p>
            <p className="text-xs text-slate-300 leading-relaxed">{dec.rationale || '—'}</p>
          </div>

          {/* Métricas antes/depois */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px]">
            {[
              { label: 'Bid antes', value: dec.value_before != null ? `R$${(dec.value_before).toFixed(2)}` : '—', color: 'text-slate-400' },
              { label: 'Bid depois', value: dec.value_after != null ? `R$${(dec.value_after).toFixed(2)}` : '—', color: isIncrease ? 'text-emerald-400' : 'text-red-400' },
              { label: 'Intenção', value: INTENT_LABELS[dec.search_intent_type] || '—', color: 'text-slate-300' },
              { label: 'Cluster', value: dec.search_intent_cluster || '—', color: 'text-violet-400' },
            ].map(m => (
              <div key={m.label} className="bg-surface-2 rounded p-2 text-center">
                <p className="text-slate-500 mb-0.5">{m.label}</p>
                <p className={`font-bold text-xs ${m.color}`}>{m.value}</p>
              </div>
            ))}
          </div>

          {/* Dados econômicos da decisão */}
          {dec.economic_audit && (
            <div className="bg-violet-500/5 border border-violet-500/15 rounded-lg p-3">
              <p className="text-[10px] font-semibold text-violet-400 mb-2 flex items-center gap-1.5">
                <DollarSign className="w-3 h-3" /> Auditoria Econômica
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px]">
                {[
                  { label: 'CPA Atual', value: dec.economic_audit.actual_cpa > 0 ? `R$${dec.economic_audit.actual_cpa.toFixed(2)}` : '—', color: dec.economic_audit.actual_cpa > dec.economic_audit.maximum_profitable_cpa ? 'text-red-400' : 'text-emerald-400' },
                  { label: 'CPA Máx. Lucrável', value: dec.economic_audit.maximum_profitable_cpa > 0 ? `R$${dec.economic_audit.maximum_profitable_cpa.toFixed(2)}` : '—', color: 'text-violet-400' },
                  { label: 'eCPM', value: dec.economic_audit.ecpm > 0 ? `R$${dec.economic_audit.ecpm.toFixed(2)}` : '—', color: 'text-slate-300' },
                  { label: 'CVR', value: dec.economic_audit.cvr > 0 ? `${(dec.economic_audit.cvr * 100).toFixed(2)}%` : '—', color: 'text-slate-300' },
                  { label: 'Margem Bruta', value: dec.economic_audit.contribution_margin > 0 ? `R$${dec.economic_audit.contribution_margin.toFixed(2)}` : '—', color: 'text-emerald-400' },
                  { label: 'Break-even ACoS', value: dec.economic_audit.break_even_acos > 0 ? `${dec.economic_audit.break_even_acos.toFixed(1)}%` : '—', color: 'text-slate-400' },
                  { label: 'Target ACoS', value: dec.economic_audit.target_acos > 0 ? `${dec.economic_audit.target_acos.toFixed(1)}%` : '—', color: 'text-cyan' },
                  { label: 'Lucro Pós-ADS', value: dec.economic_audit.profit_after_ads != null ? `R$${Number(dec.economic_audit.profit_after_ads).toFixed(2)}/ped` : '—', color: dec.economic_audit.profit_after_ads < 0 ? 'text-red-400' : 'text-emerald-400' },
                ].map(m => (
                  <div key={m.label} className="bg-surface-2 rounded p-1.5 text-center">
                    <p className="text-slate-500 mb-0.5">{m.label}</p>
                    <p className={`font-bold ${m.color}`}>{m.value}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Meta protegida e fonte */}
          <div className="flex flex-wrap gap-2 text-[10px]">
            {dec.settings_source && (
              <span className="px-2 py-1 bg-surface-2 rounded-lg text-slate-500">
                Fonte: {dec.settings_source}
              </span>
            )}
            {dec.data_quality && (
              <span className={`px-2 py-1 rounded-lg ${
                dec.data_quality === 'fresh' ? 'bg-emerald-500/10 text-emerald-400'
                : dec.data_quality === 'acceptable' ? 'bg-amber-500/10 text-amber-400'
                : 'bg-red-500/10 text-red-400'}`}>
                Dados: {dec.data_quality}
              </span>
            )}
            {dec.stock_coverage_days != null && (
              <span className="px-2 py-1 bg-surface-2 rounded-lg text-slate-500">
                Estoque: {Math.round(dec.stock_coverage_days)}d
              </span>
            )}
            {dec.created_at && (
              <span className="px-2 py-1 bg-surface-2 rounded-lg text-slate-500">
                {new Date(dec.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function EstrategiasTab({ account }) {
  const [perfSettings, setPerfSettings] = useState(null);
  const [decisions, setDecisions] = useState([]);
  const [products, setProducts] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [metrics, setMetrics] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [expandedIds, setExpandedIds] = useState(new Set());
  const [filterIntent, setFilterIntent] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterRisk, setFilterRisk] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [activeView, setActiveView] = useState('strategic'); // 'strategic' | 'opportunities' | 'decisions' | 'economy' | 'goals'
  const [economics, setEconomics] = useState([]);
  const [lastEngineResult, setLastEngineResult] = useState(null);

  const loadData = useCallback(async () => {
    if (!account) return;
    setLoading(true);
    try {
      const [psList, decList, prodList, campList, metList, econList] = await Promise.all([
        base44.entities.PerformanceSettings.filter({ amazon_account_id: account.id }, '-updated_at', 1).catch(() => []),
        base44.entities.OptimizationDecision.filter({ amazon_account_id: account.id }, '-created_at', 200).catch(() => []),
        base44.entities.Product.filter({ amazon_account_id: account.id }, null, 100).catch(() => []),
        base44.entities.Campaign.filter({ amazon_account_id: account.id }, null, 100).catch(() => []),
        base44.entities.CampaignMetricsDaily.filter({ amazon_account_id: account.id }, '-date', 100).catch(() => []),
        base44.entities.ProductEconomics?.filter ? base44.entities.ProductEconomics.filter({ amazon_account_id: account.id }, null, 200).catch(() => []) : Promise.resolve([]),
      ]);
      setPerfSettings(psList[0] || null);
      setDecisions(decList);
      setProducts(prodList);
      setCampaigns(campList);
      setMetrics(metList);
      setEconomics(econList || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [account]);

  useEffect(() => { loadData(); }, [loadData]);

  const runEngine = async () => {
    if (!account || running) return;
    setRunning(true); setResult(null); setError(null);
    try {
      const res = await base44.functions.invoke('runUnifiedDecisionEngine', { amazon_account_id: account.id });
      const data = res?.data || null;
      setResult(data);
      setLastEngineResult(data);
      await loadData();
    } catch (e) { setError(e.message); }
    finally { setRunning(false); }
  };

  const toggleExpand = (id) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // ── Métricas estratégicas calculadas ─────────────────────────────────────
  const strategicMetrics = useMemo(() => {
    const cutoff14d = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    const recentMetrics = metrics.filter(m => m.date >= cutoff14d);

    const totalSpend = recentMetrics.reduce((s, m) => s + (m.spend || 0), 0);
    const totalSales = recentMetrics.reduce((s, m) => s + (m.sales || 0), 0);
    const totalOrders = recentMetrics.reduce((s, m) => s + (m.orders || 0), 0);
    const globalAcos = totalSales > 0 ? (totalSpend / totalSales) * 100 : 0;
    const globalRoas = totalSpend > 0 ? totalSales / totalSpend : 0;

    const productsByState = {};
    for (const p of products) {
      // Contagem simples por estado de estoque
      const state = p.fba_inventory <= 0 ? 'unavailable'
        : p.inventory_status === 'low_stock' ? 'low_stock'
        : p.has_campaign ? 'profitable' : 'learning';
      productsByState[state] = (productsByState[state] || 0) + 1;
    }

    // Campanhas com ACoS problemático
    const activeCamps = campaigns.filter(c => c.state === 'enabled' || c.status === 'enabled');
    const highAcosCount = activeCamps.filter(c => (c.acos || 0) > (perfSettings?.target_acos || 10) * 1.5 && (c.spend || 0) > 5).length;
    const noConversionCount = activeCamps.filter(c => (c.spend || 0) > 5 && (c.orders || 0) === 0).length;

    // Decisões recentes
    const recentDecisions = decisions.filter(d => {
      const created = d.created_at;
      if (!created) return false;
      return (Date.now() - new Date(created).getTime()) < 24 * 3600000;
    });

    // Intent distribution nos decisions
    const intentDist = {};
    for (const d of decisions) {
      if (d.search_intent_type) {
        intentDist[d.search_intent_type] = (intentDist[d.search_intent_type] || 0) + 1;
      }
    }

    return {
      totalSpend, totalSales, totalOrders, globalAcos, globalRoas,
      productsByState, highAcosCount, noConversionCount,
      recentDecisionsCount: recentDecisions.length,
      pendingCount: decisions.filter(d => d.status === 'approved' || d.status === 'pending').length,
      executedCount: decisions.filter(d => d.status === 'executed').length,
      intentDist,
      scalableProducts: products.filter(p => p.has_campaign && p.fba_inventory > 0 && (p.acos || 0) < (perfSettings?.target_acos || 10)).length,
      profitableProducts: products.filter(p => p.has_campaign && p.fba_inventory > 0).length,
    };
  }, [metrics, products, campaigns, decisions, perfSettings]);

  // ── Filtrar decisões ───────────────────────────────────────────────────────
  const filteredDecisions = useMemo(() => {
    return decisions.filter(d => {
      if (filterIntent !== 'all' && d.purchase_intent !== filterIntent) return false;
      if (filterStatus !== 'all' && d.status !== filterStatus) return false;
      if (filterRisk !== 'all' && d.risk !== filterRisk) return false;
      if (searchTerm) {
        const q = searchTerm.toLowerCase();
        if (!(d.keyword_text || '').toLowerCase().includes(q) &&
            !(d.asin || '').includes(q) &&
            !(d.rationale || '').toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [decisions, filterIntent, filterStatus, filterRisk, searchTerm]);

  const ps = perfSettings || {};
  const acosColor = strategicMetrics.globalAcos === 0 ? 'default'
    : strategicMetrics.globalAcos <= (ps.target_acos || 10) ? 'good'
    : strategicMetrics.globalAcos <= (ps.max_acos || 15) ? 'warn' : 'bad';

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-violet-500/15 border border-violet-500/20 flex items-center justify-center">
            <Zap className="w-5 h-5 text-violet-400" />
          </div>
          <div>
            <h2 className="text-base font-bold text-white">Motor Estratégico de Decisões</h2>
            <p className="text-xs text-slate-500">Intenção de busca · Lucratividade · Proteção de margem · Escala sustentável</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={loadData} disabled={loading}
            className="p-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={runEngine} disabled={running || !account}
            className="flex items-center gap-2 px-4 py-2 bg-violet-500/15 border border-violet-500/30 text-violet-300 hover:bg-violet-500/25 text-sm font-semibold rounded-lg disabled:opacity-50 transition-colors">
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {running ? 'Executando Motor...' : 'Executar Motor'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 flex items-center gap-2 text-xs text-red-400">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" /> {error}
        </div>
      )}

      {/* Resultado da execução */}
      {result && (
        <div className={`rounded-xl border p-4 space-y-3 ${result.ok ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-red-500/5 border-red-500/20'}`}>
          <div className="flex items-center gap-2 flex-wrap">
            {result.ok ? <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0" /> : <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />}
            <span className="text-xs font-semibold text-slate-200">
              {result.decisions_generated || 0} decisões geradas · Dados: {result.data_freshness} ({result.data_age_hours}h) · Motor: {result.engine || 'unified'}
            </span>
          </div>
          {result.economic_context && (
            <div className="flex flex-wrap gap-2 text-[10px]">
              <span className="px-2 py-1 bg-surface-2 rounded-lg text-slate-400">
                Gasto ontem: R${(result.economic_context.real_spend_yesterday || 0).toFixed(2)} / cap R${result.economic_context.budget_cap}
              </span>
              <span className="px-2 py-1 bg-surface-2 rounded-lg text-slate-400">
                {result.economic_context.products_with_dynamic_target} produtos com meta dinâmica
              </span>
              {result.seasonal_context?.event && (
                <span className="px-2 py-1 bg-amber-500/10 border border-amber-500/20 rounded-lg text-amber-400">
                  🗓 {result.seasonal_context.event}
                </span>
              )}
            </div>
          )}
          {result.stats && (
            <div className="flex flex-wrap gap-3 text-[10px] text-slate-500">
              <span>Avaliadas: {result.stats.evaluated}</span>
              <span>Protegidas: {result.stats.protected}</span>
              <span>Aumentos: {result.stats.bid_increase}</span>
              <span>Reduções: {result.stats.bid_reduce}</span>
              <span>Sem dados: {result.stats.held}</span>
            </div>
          )}
        </div>
      )}

      {/* Sub-navegação */}
      <div className="flex gap-1 bg-surface-2 border border-surface-3 rounded-xl p-1 flex-wrap">
        {[
          { id: 'strategic', label: 'Estratégia', icon: BarChart2 },
          { id: 'visibility', label: 'Visibilidade', icon: Eye },
          { id: 'opportunities', label: `Oportunidades${lastEngineResult?.opportunity_summary?.can_grow > 0 ? ` (${lastEngineResult.opportunity_summary.can_grow})` : ''}`, icon: Telescope },
          { id: 'economy', label: 'Economia', icon: DollarSign },
          { id: 'decisions', label: `Decisões (${decisions.length})`, icon: Zap },
          { id: 'goals', label: 'Metas', icon: Target },
        ].map(v => (
          <button key={v.id} onClick={() => setActiveView(v.id)}
            className={`flex items-center gap-1.5 flex-1 justify-center px-3 py-2 rounded-lg text-xs font-semibold transition-all ${activeView === v.id ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30' : 'text-slate-400 hover:text-slate-200'}`}>
            <v.icon className="w-3.5 h-3.5" />
            {v.label}
          </button>
        ))}
      </div>

      {/* ── VISIBILIDADE × VENDAS ───────────────────────────────────────────── */}
      {activeView === 'visibility' && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-cyan/15 border border-cyan/20 flex items-center justify-center">
              <Eye className="w-4 h-4 text-cyan" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">Visibility Score × Volume de Vendas</h3>
              <p className="text-xs text-slate-500">Impacto da visibilidade de impressões nas vendas por produto/keyword — 14 dias</p>
            </div>
            <button onClick={loadData} disabled={loading} className="ml-auto p-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {!lastEngineResult && (
            <div className="bg-cyan/5 border border-cyan/20 rounded-xl p-3 flex items-center gap-2 text-xs text-cyan/80">
              <Eye className="w-3.5 h-3.5 flex-shrink-0" />
              Execute o motor de estratégias para ver os visibility scores calculados. Usando dados estimados de sessões enquanto isso.
            </div>
          )}

          <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
            <VisibilityScoreChart
              opportunities={lastEngineResult?.opportunity_summary?.top_opportunities || []}
              metrics={metrics}
              products={products}
            />
          </div>

          {/* Interpretação */}
          <div className="bg-surface-1 border border-surface-2 rounded-xl p-4 space-y-2">
            <p className="text-xs font-semibold text-slate-300 flex items-center gap-2">
              <Brain className="w-3.5 h-3.5 text-violet-400" /> Como interpretar o Visibility Score
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[10px]">
              {[
                { range: '< 0.3', label: 'Baixa visibilidade', desc: 'Impressões insuficientes para estimar intenção real. Bid provavelmente abaixo do mínimo de entrega.', color: 'border-red-500/20 bg-red-500/5 text-red-300' },
                { range: '0.3 – 0.6', label: 'Visibilidade média', desc: 'Recebendo tráfego mas limitado. Oportunidade de crescimento se CVR e margem permitirem.', color: 'border-amber-500/20 bg-amber-500/5 text-amber-300' },
                { range: '≥ 0.6', label: 'Alta visibilidade', desc: 'Boa cobertura. Foco em converter o tráfego existente — otimizar listing e preço antes de escalar bid.', color: 'border-emerald-500/20 bg-emerald-500/5 text-emerald-300' },
              ].map(r => (
                <div key={r.range} className={`rounded-lg p-3 border ${r.color}`}>
                  <p className="font-bold mb-1">{r.range} — {r.label}</p>
                  <p className="text-slate-400">{r.desc}</p>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-slate-600">Score calculado: impressões acumuladas / impressão máxima possível estimada pelo motor. Valores podem variar com a execução do motor.</p>
          </div>
        </div>
      )}

      {/* ── OPORTUNIDADES DE CRESCIMENTO v6 ─────────────────────────────────── */}
      {activeView === 'opportunities' && (
        <div className="space-y-4">
          {!lastEngineResult ? (
            <div className="bg-surface-1 border border-surface-2 rounded-xl p-10 text-center">
              <Telescope className="w-8 h-8 text-slate-600 mx-auto mb-3" />
              <p className="text-sm text-slate-500">Execute o motor para identificar oportunidades de crescimento.</p>
              <button onClick={runEngine} disabled={running || !account}
                className="mt-4 flex items-center gap-2 px-4 py-2 bg-violet-500/15 border border-violet-500/30 text-violet-300 text-xs font-semibold rounded-lg disabled:opacity-50 mx-auto">
                {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                {running ? 'Executando...' : 'Executar Motor'}
              </button>
            </div>
          ) : (
            <>
              {/* Resumo de política de crescimento */}
              <div className="bg-violet-500/5 border border-violet-500/20 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Sparkles className="w-4 h-4 text-violet-400" />
                  <p className="text-xs font-semibold text-violet-300">Política de Crescimento v6</p>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[10px]">
                  {[
                    { label: 'Tolerância Econômica', value: `${((lastEngineResult.growth_policy?.growth_tolerance_factor || 1.05) - 1) * 100}% acima do limite` },
                    { label: 'Custo Parcial Máx.', value: `+${lastEngineResult.growth_policy?.partial_cost_max_increase_pct || 5}%` },
                    { label: 'Cooldown Pós-Aumento', value: `${lastEngineResult.performance_settings?.growth_cooldown_hours || 72}h` },
                    { label: 'Oportunidades Ativas', value: lastEngineResult.opportunity_summary?.can_grow || 0 },
                  ].map(m => (
                    <div key={m.label} className="bg-surface-2 rounded-lg p-2 text-center">
                      <p className="text-slate-500 mb-0.5">{m.label}</p>
                      <p className="font-bold text-violet-300">{m.value}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Mini gráfico visibility × vendas inline */}
              {lastEngineResult.opportunity_summary?.top_opportunities?.length > 0 && (
                <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs font-semibold text-slate-300 flex items-center gap-2">
                      <Eye className="w-3.5 h-3.5 text-cyan" /> Visibility Score × Vendas
                    </p>
                    <button onClick={() => setActiveView('visibility')} className="text-[10px] text-cyan hover:underline">
                      Ver análise completa →
                    </button>
                  </div>
                  <VisibilityScoreChart
                    opportunities={lastEngineResult.opportunity_summary.top_opportunities}
                    metrics={metrics}
                    products={products}
                  />
                </div>
              )}

              {/* Distribuição por estado de oportunidade */}
              {lastEngineResult.opportunity_summary?.by_state && (
                <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
                  <p className="text-xs font-semibold text-slate-300 mb-3 flex items-center gap-2">
                    <Gauge className="w-3.5 h-3.5 text-cyan" /> Distribuição de Oportunidades
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(lastEngineResult.opportunity_summary.by_state)
                      .sort(([, a], [, b]) => b - a)
                      .map(([state, count]) => {
                        const cfg = OPPORTUNITY_STATE_LABELS[state] || { label: state, color: 'text-slate-400', bg: 'bg-slate-500/10' };
                        return (
                          <div key={state} className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-surface-3 ${cfg.bg}`}>
                            <span className={`text-xs font-semibold ${cfg.color}`}>{count}</span>
                            <span className="text-[10px] text-slate-400">{cfg.label}</span>
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}

              {/* Tabela de top oportunidades */}
              {lastEngineResult.opportunity_summary?.top_opportunities?.length > 0 && (
                <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-surface-2">
                    <p className="text-xs font-semibold text-slate-300 flex items-center gap-2">
                      <ArrowUpRight className="w-3.5 h-3.5 text-emerald-400" /> Top Oportunidades de Crescimento
                    </p>
                    <p className="text-[10px] text-slate-500 mt-0.5">Keywords com maior potencial baseado em visibilidade, conversão, margem e estoque</p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[10px]">
                      <thead>
                        <tr className="border-b border-surface-2 bg-surface-2/40">
                          {['Keyword / ASIN', 'Estado', 'Visib.', 'Impr.', 'CTR', 'CVR', 'ACoS', 'Bid Atual', 'Confiança', 'Score', 'Lucro Pós-ADS'].map(h => (
                            <th key={h} className="px-3 py-2 text-left font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {lastEngineResult.opportunity_summary.top_opportunities.map((opp, i) => {
                          const stateCfg = OPPORTUNITY_STATE_LABELS[opp.opportunity_state] || { label: opp.opportunity_state, color: 'text-slate-400', bg: 'bg-slate-500/10' };
                          const visColor = opp.visibility_score < 0.3 ? 'text-red-400' : opp.visibility_score < 0.6 ? 'text-amber-400' : 'text-emerald-400';
                          const confColor = { low: 'text-slate-400', moderate: 'text-amber-400', high: 'text-emerald-400', very_high: 'text-cyan', exceptional: 'text-violet-400' }[opp.growth_confidence] || 'text-slate-400';
                          return (
                            <tr key={i} className="border-b border-surface-2/40 hover:bg-surface-2/20 transition-colors">
                              <td className="px-3 py-2.5">
                                <p className="text-slate-200 font-medium truncate max-w-[140px]" title={opp.keyword_text}>{opp.keyword_text || '—'}</p>
                                {opp.asin && <p className="font-mono text-cyan text-[9px]">{opp.asin}</p>}
                              </td>
                              <td className="px-3 py-2.5">
                                <span className={`inline-flex px-1.5 py-0.5 rounded text-[9px] font-semibold ${stateCfg.bg} ${stateCfg.color}`}>
                                  {stateCfg.label}
                                </span>
                              </td>
                              <td className="px-3 py-2.5">
                                <span className={`font-bold ${visColor}`}>{opp.visibility_score?.toFixed(2)}</span>
                                <p className="text-slate-600">{opp.visibility_status}</p>
                              </td>
                              <td className="px-3 py-2.5 text-slate-300">{(opp.impressions_14d || 0).toLocaleString('pt-BR')}</td>
                              <td className="px-3 py-2.5 text-slate-300">{opp.ctr > 0 ? `${opp.ctr.toFixed(2)}%` : '—'}</td>
                              <td className="px-3 py-2.5">
                                <span className={opp.cvr > 3 ? 'text-emerald-400' : opp.cvr > 0 ? 'text-amber-400' : 'text-slate-500'}>
                                  {opp.cvr > 0 ? `${opp.cvr.toFixed(2)}%` : '—'}
                                </span>
                              </td>
                              <td className="px-3 py-2.5">
                                <span className={opp.acos !== null ? (opp.acos <= 10 ? 'text-emerald-400' : opp.acos <= 15 ? 'text-amber-400' : 'text-red-400') : 'text-slate-600'}>
                                  {opp.acos !== null ? `${opp.acos}%` : '—'}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 text-slate-300">R${(opp.current_bid || 0).toFixed(2)}</td>
                              <td className="px-3 py-2.5">
                                <span className={`font-semibold ${confColor}`}>{opp.growth_confidence || '—'}</span>
                              </td>
                              <td className="px-3 py-2.5">
                                <div className="flex items-center gap-1.5">
                                  <div className="w-12 h-1.5 bg-surface-3 rounded-full overflow-hidden">
                                    <div className="h-full bg-violet-500 rounded-full" style={{ width: `${(opp.opportunity_score || 0) * 100}%` }} />
                                  </div>
                                  <span className="text-violet-400 font-semibold">{((opp.opportunity_score || 0) * 100).toFixed(0)}%</span>
                                </div>
                              </td>
                              <td className="px-3 py-2.5">
                                {opp.profit_after_ads != null
                                  ? <span className={opp.profit_after_ads >= 0 ? 'text-emerald-400 font-semibold' : 'text-red-400 font-semibold'}>R${Number(opp.profit_after_ads).toFixed(2)}/ped</span>
                                  : <span className="text-slate-600">—</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Stats de crescimento */}
              {lastEngineResult.stats && (
                <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
                  <p className="text-xs font-semibold text-slate-300 mb-3 flex items-center gap-2">
                    <Activity className="w-3.5 h-3.5 text-cyan" /> Resultado do Último Ciclo de Crescimento
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {[
                      { label: 'Baixa Visibilidade', value: lastEngineResult.stats.low_visibility_growth, color: 'text-amber-400' },
                      { label: 'Emergente', value: lastEngineResult.stats.emerging_growth, color: 'text-blue-400' },
                      { label: 'Lucrativo', value: lastEngineResult.stats.profitable_growth, color: 'text-emerald-400' },
                      { label: 'Alto Crescimento', value: lastEngineResult.stats.high_growth, color: 'text-cyan' },
                      { label: 'Custo Parcial', value: lastEngineResult.stats.partial_cost_growth, color: 'text-violet-400' },
                      { label: 'Budget Increase', value: lastEngineResult.stats.budget_increase, color: 'text-violet-400' },
                      { label: 'Reduções', value: lastEngineResult.stats.bid_reduce, color: 'text-red-400' },
                      { label: 'Protegidos', value: lastEngineResult.stats.protected, color: 'text-slate-400' },
                    ].map(m => (
                      <div key={m.label} className="bg-surface-2 rounded-lg p-2 text-center">
                        <p className="text-[9px] text-slate-500 mb-0.5">{m.label}</p>
                        <p className={`text-sm font-bold ${m.color}`}>{m.value ?? 0}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Alertas de erosão de lucro */}
              {lastEngineResult.profit_after_ads_summary?.erosion_alerts?.length > 0 && (
                <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-4">
                  <p className="text-xs font-semibold text-red-300 mb-2 flex items-center gap-2">
                    <AlertTriangle className="w-3.5 h-3.5" /> Alertas de Erosão de Margem
                  </p>
                  <div className="space-y-2">
                    {lastEngineResult.profit_after_ads_summary.erosion_alerts.map((a, i) => (
                      <div key={i} className="flex items-start gap-2 text-[10px]">
                        <span className="font-mono text-cyan flex-shrink-0">{a.asin}</span>
                        <span className="text-red-300">{a.reason}</span>
                        <span className="ml-auto text-slate-500 flex-shrink-0">3d: R${a.profit_after_ads_3d}/ped · 14d: R${a.profit_after_ads_14d}/ped</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── VISÃO ESTRATÉGICA ────────────────────────────────────────────────── */}
      {activeView === 'strategic' && !loading && (
        <div className="space-y-4">
          {/* KPIs de Performance 14d */}
          <div>
            <p className="text-xs font-semibold text-slate-400 mb-3">Performance — últimos 14 dias</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <KpiCard label="Gasto Ads" value={fmtBRL(strategicMetrics.totalSpend)} sub="14 dias" tone="cyan" icon={DollarSign} />
              <KpiCard label="Vendas Ads" value={fmtBRL(strategicMetrics.totalSales)} sub={`${strategicMetrics.totalOrders} pedidos`} tone={strategicMetrics.totalSales > 0 ? 'good' : 'default'} icon={ShoppingCart} />
              <KpiCard label="ACoS" value={fmtPct(strategicMetrics.globalAcos)} sub={`Meta: ${ps.target_acos || 10}%`} tone={acosColor} icon={Target} />
              <KpiCard label="ROAS" value={strategicMetrics.globalRoas > 0 ? `${strategicMetrics.globalRoas.toFixed(2)}x` : '—'} sub={`Meta: ${ps.target_roas || 4}x`} tone={strategicMetrics.globalRoas >= (ps.target_roas || 4) ? 'good' : 'default'} icon={TrendingUp} />
            </div>
          </div>

          {/* Alertas estratégicos */}
          {(strategicMetrics.highAcosCount > 0 || strategicMetrics.noConversionCount > 0) && (
            <div className="space-y-2">
              {strategicMetrics.highAcosCount > 0 && (
                <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-red-500/8 border border-red-500/20 text-xs">
                  <AlertTriangle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
                  <span className="text-red-300"><strong>{strategicMetrics.highAcosCount}</strong> campanha(s) com ACoS acima da meta — risco de perda de margem</span>
                </div>
              )}
              {strategicMetrics.noConversionCount > 0 && (
                <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-amber-500/8 border border-amber-500/20 text-xs">
                  <TrendingDown className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                  <span className="text-amber-300"><strong>{strategicMetrics.noConversionCount}</strong> campanha(s) gastando sem converter — desperdício de orçamento</span>
                </div>
              )}
            </div>
          )}

          {/* Estado estratégico das decisões */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <KpiCard label="Decisões Pendentes" value={strategicMetrics.pendingCount} sub="Na fila aprovada" tone={strategicMetrics.pendingCount > 0 ? 'warn' : 'good'} icon={Clock} />
            <KpiCard label="Executadas" value={strategicMetrics.executedCount} tone="good" sub="Total histórico" icon={CheckCircle} />
            <KpiCard label="Produtos Lucrativos" value={strategicMetrics.profitableProducts} sub="Com campanha ativa" tone="cyan" icon={Package} />
            <KpiCard label="Escaláveis" value={strategicMetrics.scalableProducts} sub="ACoS abaixo da meta" tone="violet" icon={TrendingUp} />
          </div>

          {/* Distribuição de intenção de busca */}
          {Object.keys(strategicMetrics.intentDist).length > 0 && (
            <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                <Brain className="w-4 h-4 text-violet-400" />
                Distribuição de Intenção de Busca — Decisões
              </h3>
              <div className="space-y-2">
                {Object.entries(strategicMetrics.intentDist)
                  .sort(([, a], [, b]) => b - a)
                  .map(([intent, count]) => {
                    const total = Object.values(strategicMetrics.intentDist).reduce((s, v) => s + v, 0);
                    const pct = total > 0 ? Math.round(count / total * 100) : 0;
                    const isHigh = ['long_tail', 'transactional', 'commercial', 'product_specific'].includes(intent);
                    return (
                      <div key={intent} className="flex items-center gap-3">
                        <span className="text-[10px] text-slate-400 w-28 flex-shrink-0">{INTENT_LABELS[intent] || intent}</span>
                        <div className="flex-1 h-1.5 bg-surface-3 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${isHigh ? 'bg-emerald-500' : 'bg-slate-500'}`} style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-[10px] text-slate-500 w-12 text-right flex-shrink-0">{count} ({pct}%)</span>
                      </div>
                    );
                  })}
              </div>
              <p className="text-[10px] text-slate-600 mt-3">Termos comerciais/transacionais (verde) têm maior intenção de compra e devem ser priorizados.</p>
            </div>
          )}

          {/* Produtos por estado */}
          {products.length > 0 && (
            <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                <Layers className="w-4 h-4 text-cyan" />
                Produtos por Estado Estratégico
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {Object.entries(
                  products.reduce((acc, p) => {
                    const state = p.fba_inventory <= 0 ? 'unavailable'
                      : p.inventory_status === 'low_stock' ? 'low_stock'
                      : p.inventory_status === 'out_of_stock' ? 'unavailable'
                      : !p.has_campaign ? 'learning'
                      : (p.acos || 0) > (ps.target_acos || 10) * 1.5 ? 'inefficient'
                      : (p.acos || 0) > 0 && (p.acos || 0) <= (ps.target_acos || 10) * 0.7 ? 'scalable'
                      : p.has_campaign ? 'profitable' : 'learning';
                    acc[state] = (acc[state] || 0) + 1;
                    return acc;
                  }, {})
                ).map(([state, count]) => {
                  const cfg = PRODUCT_STATE_LABELS[state] || { label: state, color: 'text-slate-400', bg: 'bg-slate-500/10' };
                  return (
                    <div key={state} className={`rounded-lg p-3 text-center ${cfg.bg} border border-surface-3/50`}>
                      <p className={`text-xl font-bold ${cfg.color}`}>{count}</p>
                      <p className="text-[10px] text-slate-500 mt-0.5">{cfg.label}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── DECISÕES ────────────────────────────────────────────────────────── */}
      {activeView === 'decisions' && (
        <div className="space-y-4">
          {/* Filtros */}
          <div className="flex flex-wrap gap-2 items-center">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500" />
              <input value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
                placeholder="Keyword, ASIN..."
                className="pl-7 pr-3 py-1.5 bg-surface-2 border border-surface-3 rounded-lg text-xs text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan/50 w-40" />
            </div>

            {/* Intenção */}
            <div className="flex gap-1 bg-surface-2 border border-surface-3 rounded-lg p-0.5">
              {[
                { k: 'all', l: 'Todas' },
                { k: 'high', l: '🎯 Alta' },
                { k: 'medium', l: '⚡ Média' },
                { k: 'low', l: '💬 Baixa' },
              ].map(f => (
                <button key={f.k} onClick={() => setFilterIntent(f.k)}
                  className={`px-2 py-1 rounded text-[10px] font-semibold transition-all ${filterIntent === f.k ? 'bg-violet-500/20 text-violet-300' : 'text-slate-400 hover:text-slate-200'}`}>
                  {f.l}
                </button>
              ))}
            </div>

            {/* Status */}
            <div className="flex gap-1 bg-surface-2 border border-surface-3 rounded-lg p-0.5">
              {[
                { k: 'all', l: 'Todos' },
                { k: 'approved', l: 'Aprovadas' },
                { k: 'executed', l: 'Executadas' },
                { k: 'failed', l: 'Falharam' },
              ].map(f => (
                <button key={f.k} onClick={() => setFilterStatus(f.k)}
                  className={`px-2 py-1 rounded text-[10px] font-semibold transition-all ${filterStatus === f.k ? 'bg-cyan/20 text-cyan' : 'text-slate-400 hover:text-slate-200'}`}>
                  {f.l}
                </button>
              ))}
            </div>

            {/* Risco */}
            <div className="flex gap-1 bg-surface-2 border border-surface-3 rounded-lg p-0.5">
              {[{ k: 'all', l: 'Risco' }, { k: 'low', l: '🟢' }, { k: 'medium', l: '🟡' }, { k: 'high', l: '🔴' }].map(f => (
                <button key={f.k} onClick={() => setFilterRisk(f.k)}
                  className={`px-2 py-1 rounded text-[10px] font-semibold transition-all ${filterRisk === f.k ? 'bg-surface-3 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
                  {f.l}
                </button>
              ))}
            </div>
          </div>

          <p className="text-[10px] text-slate-500">{filteredDecisions.length} decisões</p>

          {loading ? (
            <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-violet-400 animate-spin" /></div>
          ) : filteredDecisions.length === 0 ? (
            <div className="bg-surface-1 border border-surface-2 rounded-xl p-10 text-center">
              <Zap className="w-8 h-8 text-slate-600 mx-auto mb-3" />
              <p className="text-sm text-slate-500">Nenhuma decisão encontrada com este filtro.</p>
              <p className="text-xs text-slate-600 mt-1">Execute o motor para gerar decisões baseadas nas metas econômicas e intenção de busca.</p>
              <button onClick={runEngine} disabled={running || !account}
                className="mt-4 flex items-center gap-2 px-4 py-2 bg-violet-500/15 border border-violet-500/30 text-violet-300 text-xs font-semibold rounded-lg disabled:opacity-50 mx-auto">
                {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                {running ? 'Executando...' : 'Executar Agora'}
              </button>
            </div>
          ) : (
            <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
              {filteredDecisions.slice(0, 100).map(dec => (
                <DecisionRow
                  key={dec.id}
                  dec={dec}
                  expanded={expandedIds.has(dec.id)}
                  onToggle={() => toggleExpand(dec.id)}
                />
              ))}
              {filteredDecisions.length > 100 && (
                <p className="px-5 py-3 text-[10px] text-slate-500 border-t border-surface-2">
                  Mostrando 100 de {filteredDecisions.length} decisões
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── ECONOMIA POR PRODUTO ─────────────────────────────────────────────── */}
      {activeView === 'economy' && (
        <div className="space-y-4">
          {/* KPIs econômicos */}
          {(() => {
            const normSku = s => (s || '').trim().toUpperCase().replace(/\s+/g, '-').replace(/-{2,}/g, '-');
            const econBySku = new Map(economics.map(e => [normSku(e.sku), e]));
            const econByAsin = new Map(economics.map(e => [e.asin, e]));
            const getEcon = p => econBySku.get(normSku(p.sku)) || econByAsin.get(p.asin) || null;
            const withCost = products.filter(p => { const e = getEcon(p); return e?.unit_cost > 0; });
            const withMargin = products.filter(p => { const e = getEcon(p); return e?.contribution_margin_amount > 0; });
            const negMargin = products.filter(p => { const e = getEcon(p); return e && e.contribution_margin_amount < 0; });
            const missingCost = products.filter(p => !getEcon(p) || !getEcon(p)?.unit_cost);

            return (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <KpiCard label="Com Custo Cadastrado" value={withCost.length} sub={`de ${products.length} produtos`} tone={withCost.length === products.length ? 'good' : 'warn'} icon={DollarSign} />
                  <KpiCard label="Margem Positiva" value={withMargin.length} sub="pré-ADS" tone="good" icon={TrendingUp} />
                  <KpiCard label="Margem Negativa" value={negMargin.length} sub="expansão bloqueada" tone={negMargin.length > 0 ? 'bad' : 'good'} icon={TrendingDown} />
                  <KpiCard label="Sem Custo" value={missingCost.length} sub="hold conservador" tone={missingCost.length > 0 ? 'warn' : 'good'} icon={AlertTriangle} />
                </div>

                {/* Tabela de economia por produto */}
                <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-surface-2">
                    <p className="text-xs font-semibold text-slate-300">Economia por Produto — Funil & CPA</p>
                    <p className="text-[10px] text-slate-500 mt-0.5">Custo · Margem · Break-even · CPA máximo lucrável · Safe Max CPC · Lucro pós-ADS</p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[10px]">
                      <thead>
                        <tr className="border-b border-surface-2 bg-surface-2/40">
                          {['ASIN / SKU', 'Custo Unit.', 'Preço', 'Margem', 'Break-even', 'Target ACoS', 'Safe Max CPC', 'CPA Máx. Lucrável', 'Lucro Pós-ADS 14d', 'Status Econ.'].map(h => (
                            <th key={h} className="px-3 py-2 text-left font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {products.slice(0, 50).map(p => {
                          const e = getEcon(p);
                          const hasCost = e?.unit_cost > 0;
                          const hasPrice = e?.current_price > 0;
                          const margin = e?.contribution_margin_amount;
                          const marginPct = e?.contribution_margin_percent;
                          const breakEven = e?.break_even_acos;
                          const targetAcos = e?.target_acos;
                          const safeCpc = e?.safe_max_cpc;
                          // CPA máximo lucrável = margem bruta (zero lucro mínimo exigido)
                          const maxCpa = margin > 0 ? margin : null;
                          const profitAds14d = e?.profit_after_ads_14d;
                          const protMode = e?.profit_protection_mode || 'normal';
                          const statusColor = !hasCost ? 'text-amber-400' : margin < 0 ? 'text-red-400' : margin === 0 ? 'text-slate-400' : 'text-emerald-400';
                          const statusLabel = !hasCost ? '⚠ Sem custo' : !hasPrice ? '⚠ Sem preço' : margin < 0 ? '🔴 Margem neg.' : margin === 0 ? '⚖ Break-even' : '✅ Lucrativo';
                          const modeColors = { normal: 'text-emerald-400', vigilant: 'text-amber-400', defensive: 'text-orange-400', paused: 'text-red-400' };
                          const modeIcons = { normal: '✅', vigilant: '👁', defensive: '⚠️', paused: '🚨' };
                          return (
                            <tr key={p.id} className="border-b border-surface-2/40 hover:bg-surface-2/20">
                              <td className="px-3 py-2">
                                <p className="font-mono text-cyan">{p.asin}</p>
                                <p className="text-slate-500">{p.sku}</p>
                              </td>
                              <td className="px-3 py-2">{hasCost ? `R$${Number(e.unit_cost).toFixed(2)}` : <span className="text-amber-400">—</span>}</td>
                              <td className="px-3 py-2">{hasPrice ? `R$${Number(e.current_price).toFixed(2)}` : <span className="text-amber-400">—</span>}</td>
                              <td className="px-3 py-2">
                                {margin != null ? (
                                  <div>
                                    <span className={`font-semibold ${margin > 0 ? 'text-emerald-400' : 'text-red-400'}`}>{`R$${Number(margin).toFixed(2)}`}</span>
                                    {marginPct != null && <p className="text-slate-500">{Number(marginPct).toFixed(1)}%</p>}
                                  </div>
                                ) : '—'}
                              </td>
                              <td className="px-3 py-2">{breakEven > 0 ? `${Number(breakEven).toFixed(1)}%` : '—'}</td>
                              <td className="px-3 py-2 text-cyan">{targetAcos > 0 ? `${Number(targetAcos).toFixed(1)}%` : '—'}</td>
                              <td className="px-3 py-2">{safeCpc > 0 ? `R$${Number(safeCpc).toFixed(2)}` : '—'}</td>
                              <td className="px-3 py-2">{maxCpa != null && maxCpa > 0 ? <span className="text-violet-400 font-semibold">{`R$${Number(maxCpa).toFixed(2)}`}</span> : '—'}</td>
                              <td className="px-3 py-2">
                                {profitAds14d != null ? (
                                  <div>
                                    <span className={`font-semibold ${modeColors[protMode] || 'text-slate-400'}`}>{`R$${Number(profitAds14d).toFixed(2)}/ped`}</span>
                                    <p className={`${modeColors[protMode] || 'text-slate-400'}`}>{modeIcons[protMode]} {protMode}</p>
                                  </div>
                                ) : '—'}
                              </td>
                              <td className="px-3 py-2"><span className={`font-semibold ${statusColor}`}>{statusLabel}</span></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Interpretação de funil */}
                <div className="bg-surface-1 border border-surface-2 rounded-xl p-5 space-y-3">
                  <h3 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
                    <Activity className="w-4 h-4 text-cyan" /> Interpretação do Funil Econômico
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[10px]">
                    {[
                      { signal: 'eCPM alto + CTR alto + CVR alto + lucro positivo', action: '✅ Manter ou escalar com cautela', color: 'border-emerald-500/20 bg-emerald-500/5' },
                      { signal: 'eCPM alto + CTR baixo', action: '⚠️ Exposição cara — revisar keyword/listing, não aumentar bid', color: 'border-amber-500/20 bg-amber-500/5' },
                      { signal: 'eCPM baixo + sem conversão', action: '🚫 Não escalar — refinar termos, avaliar negativa', color: 'border-red-500/20 bg-red-500/5' },
                      { signal: 'CTR alto + CVR baixo', action: '🔍 Produto não converte — revisar preço/listing, não aumentar bid', color: 'border-amber-500/20 bg-amber-500/5' },
                      { signal: 'CTR alto + CVR alto + lucro positivo', action: '🚀 Candidato a escala — CPA ≤ máximo lucrável obrigatório', color: 'border-emerald-500/20 bg-emerald-500/5' },
                      { signal: 'CPA real > CPA máximo lucrável', action: '🔴 Bid reduzido imediatamente — margem em risco', color: 'border-red-500/20 bg-red-500/5' },
                    ].map((item, i) => (
                      <div key={i} className={`rounded-lg p-3 border ${item.color}`}>
                        <p className="text-slate-400 mb-1">{item.signal}</p>
                        <p className="font-semibold text-slate-200">{item.action}</p>
                      </div>
                    ))}
                  </div>
                  <p className="text-[10px] text-slate-600">eCPM = gasto / impressões × 1000. Nunca usar eCPM isoladamente para pausar ou escalar — sempre cruzar com CVR e CPA máximo lucrável.</p>
                </div>
              </>
            );
          })()}
        </div>
      )}

      {/* ── METAS & HISTÓRICO ───────────────────────────────────────────────── */}
      {activeView === 'goals' && (
        <div className="space-y-5">
          {/* Metas ativas */}
          {perfSettings ? (
            <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
              <div className="flex items-center gap-2 mb-4">
                <Target className="w-4 h-4 text-cyan" />
                <p className="text-sm font-semibold text-slate-300">Metas de Performance — Fonte Única do Motor</p>
                <Link to="/settings" className="ml-auto text-[10px] text-cyan hover:underline flex items-center gap-1">
                  <Settings className="w-3 h-3" /> Editar
                </Link>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: 'ACoS alvo', value: `${ps.target_acos || 10}%`, color: 'text-cyan', sub: 'Meta principal' },
                  { label: 'ACoS máx.', value: `${ps.max_acos || 15}%`, color: 'text-red-400', sub: 'Limite de segurança' },
                  { label: 'ROAS alvo', value: `${ps.target_roas || 4}x`, color: 'text-emerald-400', sub: 'Retorno esperado' },
                  { label: 'CPC máx.', value: ps.max_cpc ? fmtBRL(ps.max_cpc) : '—', color: 'text-violet-400', sub: 'Safe max CPC' },
                  { label: 'Bid mín.', value: ps.min_bid ? fmtBRL(ps.min_bid) : fmtBRL(0.40), color: 'text-slate-300', sub: 'Piso de lance' },
                  { label: 'Bid máx.', value: ps.max_bid ? fmtBRL(ps.max_bid) : '—', color: 'text-amber-400', sub: 'Teto de lance' },
                  { label: 'Budget/dia', value: fmtBRL(ps.daily_budget_limit || 56), color: 'text-slate-300', sub: 'Guardrail real' },
                  { label: 'Safety Factor', value: '80%', color: 'text-slate-300', sub: 'Reserva de margem' },
                ].map(m => (
                  <div key={m.label} className="bg-surface-2 rounded-lg p-3 text-center">
                    <p className="text-[9px] text-slate-500 mb-0.5">{m.label}</p>
                    <p className={`text-sm font-bold ${m.color}`}>{m.value}</p>
                    {m.sub && <p className="text-[9px] text-slate-600 mt-0.5">{m.sub}</p>}
                  </div>
                ))}
              </div>

              {/* Nota sobre safety factor */}
              <div className="mt-4 px-3 py-2.5 rounded-lg bg-violet-500/8 border border-violet-500/15 text-[10px] text-violet-300">
                <strong>Proteção econômica:</strong> break_even_acos = margem bruta do produto.
                target_acos_asin = break_even × 80% (safety_factor).
                safe_max_cpc = preço × margem × cvr × safety_factor.
                Margem negativa bloqueia expansão. Estoque zero bloqueia campanhas.
              </div>
            </div>
          ) : (
            <div className="bg-surface-1 border border-amber-500/20 rounded-xl p-4 flex items-center gap-3">
              <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
              <div>
                <p className="text-sm font-semibold text-amber-300">Metas de Performance não configuradas</p>
                <p className="text-xs text-slate-400 mt-0.5">O motor está usando valores padrão do sistema. Configure metas reais para decisões mais precisas.</p>
              </div>
              <Link to="/settings" className="ml-auto px-3 py-2 bg-amber-500/15 border border-amber-500/30 text-amber-300 text-xs font-semibold rounded-lg hover:bg-amber-500/25 whitespace-nowrap">
                Configurar
              </Link>
            </div>
          )}

          {/* Hierarquia de decisão */}
          <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
              <Shield className="w-4 h-4 text-cyan" /> Hierarquia Estratégica de Prioridade
            </h3>
            <div className="space-y-1.5">
              {[
                { priority: 1, label: 'Segurança da conta', desc: 'Token, autenticação', color: 'text-red-400' },
                { priority: 2, label: 'Qualidade dos dados', desc: 'Sync recente, métricas válidas', color: 'text-orange-400' },
                { priority: 3, label: 'Estoque', desc: 'Zero = bid mínimo; crítico = reduzir', color: 'text-amber-400' },
                { priority: 4, label: 'Disponibilidade da oferta', desc: 'Produto ativo, buybox', color: 'text-yellow-400' },
                { priority: 5, label: 'Margem', desc: 'Break-even por produto, safe_max_cpc', color: 'text-lime-400' },
                { priority: 6, label: 'Orçamento global', desc: 'Guardrail de gasto real diário', color: 'text-green-400' },
                { priority: 7, label: 'Proteção de alta performance', desc: 'Vencedores não são pausados', color: 'text-emerald-400' },
                { priority: 8, label: 'Redução de desperdício', desc: 'Sem conversão = reduzir/pausar', color: 'text-cyan' },
                { priority: 9, label: 'Manutenção', desc: 'Ajustes finos de bid', color: 'text-blue-400' },
                { priority: 10, label: 'Escala', desc: 'ACoS abaixo da meta + intenção alta', color: 'text-violet-400' },
                { priority: 11, label: 'Expansão', desc: 'Novos termos, clusters semânticos', color: 'text-purple-400' },
                { priority: 12, label: 'Criação de campanhas', desc: 'Confiança ≥ 95%, relevância ≥ 95%', color: 'text-pink-400' },
              ].map(r => (
                <div key={r.priority} className="flex items-center gap-3">
                  <span className={`text-[10px] font-bold w-5 flex-shrink-0 ${r.color}`}>{r.priority}</span>
                  <span className={`text-xs font-semibold ${r.color}`}>{r.label}</span>
                  <span className="text-[10px] text-slate-600">{r.desc}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Histórico de metas */}
          {account && (
            <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
              <div className="flex items-center gap-2 mb-4">
                <Eye className="w-4 h-4 text-slate-400" />
                <p className="text-sm font-semibold text-slate-300">Histórico de Metas de Performance</p>
              </div>
              <PerformanceSettingsHistoryTable accountId={account.id} />
            </div>
          )}
        </div>
      )}

      {loading && (
        <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-violet-400 animate-spin" /></div>
      )}
    </div>
  );
}