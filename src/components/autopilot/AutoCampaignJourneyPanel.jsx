/**
 * AutoCampaignJourneyPanel — Jornada completa: AUTO → Termos Convertidos → MANUAL EXACT + Negativação
 */
import React, { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Brain, TrendingUp, TrendingDown, Target, Zap, CheckCircle, Clock,
  AlertTriangle, RefreshCw, Loader2, ChevronDown, ChevronRight, ArrowUp,
  ArrowDown, Minus, Tag, BarChart2, XCircle, ArrowRight
} from 'lucide-react';

// ── Config de estados de aprendizado ────────────────────────────────────────
const STATE_CONFIG = {
  learning_48h:           { label: 'Aprendendo 48h',       color: 'text-slate-400',   bg: 'bg-slate-500/15 border-slate-500/30' },
  no_spend:               { label: 'Sem Gasto',             color: 'text-amber-400',   bg: 'bg-amber-500/15 border-amber-500/30' },
  bid_increase_10:        { label: 'Bid +R$0,10',           color: 'text-blue-400',    bg: 'bg-blue-500/15 border-blue-500/30' },
  observing_24h:          { label: 'Observando 24h',        color: 'text-slate-400',   bg: 'bg-slate-500/15 border-slate-500/30' },
  observing_48h:          { label: 'Observando 48h',        color: 'text-slate-400',   bg: 'bg-slate-500/15 border-slate-500/30' },
  bid_increase_05:        { label: 'Bid +R$0,05',           color: 'text-blue-300',    bg: 'bg-blue-500/10 border-blue-500/20' },
  spending:               { label: 'Gastando',              color: 'text-emerald-400', bg: 'bg-emerald-500/15 border-emerald-500/30' },
  bid_reduction_05:       { label: 'Redução -R$0,05/dia',   color: 'text-cyan',        bg: 'bg-cyan/15 border-cyan/30' },
  delivery_lost:          { label: 'Entrega Perdida',       color: 'text-red-400',     bg: 'bg-red-500/15 border-red-500/30' },
  bid_recovery_10:        { label: 'Recuperação +R$0,10',   color: 'text-orange-400',  bg: 'bg-orange-500/15 border-orange-500/30' },
  stable:                 { label: 'Estável',               color: 'text-emerald-400', bg: 'bg-emerald-500/15 border-emerald-500/30' },
  term_promotion_pending: { label: 'Termos Pendentes',      color: 'text-violet-400',  bg: 'bg-violet-500/15 border-violet-500/30' },
  term_promoted:          { label: 'Termos Promovidos',     color: 'text-violet-300',  bg: 'bg-violet-500/10 border-violet-500/20' },
  blocked:                { label: 'Bloqueada',             color: 'text-red-400',     bg: 'bg-red-500/15 border-red-500/30' },
};

// ── Config de status de promoção (campo: promotion_status) ───────────────────
const PROMO_STATUS_CONFIG = {
  identified:        { label: 'Identificado',       color: 'text-slate-400',   bg: 'bg-slate-500/15 border-slate-500/30' },
  validated:         { label: 'Validado',            color: 'text-blue-400',    bg: 'bg-blue-500/15 border-blue-500/30' },
  campaign_creating: { label: 'Criando campanha…',  color: 'text-amber-400',   bg: 'bg-amber-500/15 border-amber-500/30' },
  campaign_created:  { label: 'Campanha criada',    color: 'text-amber-300',   bg: 'bg-amber-500/10 border-amber-500/20' },
  ad_group_created:  { label: 'Ad Group criado',    color: 'text-blue-300',    bg: 'bg-blue-500/10 border-blue-500/20' },
  product_ad_created:{ label: 'ProductAd criado',   color: 'text-blue-400',    bg: 'bg-blue-500/15 border-blue-500/30' },
  keyword_created:   { label: 'Keyword criada',     color: 'text-violet-400',  bg: 'bg-violet-500/15 border-violet-500/30' },
  enabling:          { label: 'Ativando…',           color: 'text-amber-400',   bg: 'bg-amber-500/15 border-amber-500/30' },
  manual_active:     { label: 'Manual Ativa ✓',     color: 'text-emerald-400', bg: 'bg-emerald-500/15 border-emerald-500/30' },
  negative_creating: { label: 'Negativando AUTO…',  color: 'text-violet-400',  bg: 'bg-violet-500/15 border-violet-500/30' },
  negative_created:  { label: 'Negativado ✓',       color: 'text-emerald-300', bg: 'bg-emerald-500/10 border-emerald-500/20' },
  completed:         { label: 'Concluído ✓',         color: 'text-emerald-400', bg: 'bg-emerald-500/15 border-emerald-500/30' },
  repair_required:   { label: 'Reparo necessário',   color: 'text-amber-400',   bg: 'bg-amber-500/15 border-amber-500/30' },
  failed_retryable:  { label: 'Falha (retry)',       color: 'text-red-400',     bg: 'bg-red-500/15 border-red-500/30' },
  failed_permanent:  { label: 'Falha permanente',    color: 'text-red-500',     bg: 'bg-red-500/20 border-red-500/40' },
};

// Agrupamento de status para as abas
const isCompleted = (s) => ['completed', 'manual_active', 'negative_created'].includes(s);
const isFailed = (s) => ['failed_retryable', 'failed_permanent', 'repair_required'].includes(s);
const isPending = (s) => !isCompleted(s) && !isFailed(s);

const CHANGE_TYPE_CONFIG = {
  initial_bid:          { label: 'Bid Inicial',            icon: Minus,     color: 'text-slate-400' },
  increase_no_spend_10: { label: '+R$0,10 sem gasto',      icon: ArrowUp,   color: 'text-blue-400' },
  increase_no_spend_05: { label: '+R$0,05 sem gasto',      icon: ArrowUp,   color: 'text-blue-300' },
  reduce_low_cpc_05:    { label: '-R$0,05 CPC baixo',      icon: ArrowDown, color: 'text-cyan' },
  reduce_for_goal_05:   { label: '-R$0,05 meta ACoS',      icon: ArrowDown, color: 'text-cyan' },
  recover_delivery_10:  { label: '+R$0,10 recuperação',    icon: ArrowUp,   color: 'text-orange-400' },
  manual_adjustment:    { label: 'Ajuste manual',          icon: Target,    color: 'text-amber-400' },
};

function StateBadge({ state }) {
  const cfg = STATE_CONFIG[state] || { label: state, color: 'text-slate-400', bg: 'bg-slate-500/15 border-slate-500/30' };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${cfg.bg} ${cfg.color}`}>
      {cfg.label}
    </span>
  );
}

function PromoStatusBadge({ status }) {
  const cfg = PROMO_STATUS_CONFIG[status] || { label: status || '—', color: 'text-slate-400', bg: 'bg-slate-500/15 border-slate-500/30' };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${cfg.bg} ${cfg.color}`}>
      {cfg.label}
    </span>
  );
}

// ── Linha de campanha AUTO em aprendizado ─────────────────────────────────────
function LearningRow({ record, onExpand, expanded }) {
  return (
    <div className="bg-surface-2 border border-surface-3 rounded-lg overflow-hidden">
      <button
        onClick={() => onExpand(record.id)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-surface-3 transition-colors text-left"
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />}
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-white truncate">{record.campaign_name || record.campaign_id}</p>
          <p className="text-[10px] text-slate-500 font-mono">{record.asin || '—'}</p>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <div className="text-right">
            <p className="text-xs font-bold text-white">R${(record.current_bid || 0).toFixed(2)}</p>
            <p className="text-[9px] text-slate-500">bid atual</p>
          </div>
          {record.terms_pending_promotion > 0 && (
            <span className="flex items-center gap-1 text-[10px] text-violet-400 bg-violet-500/15 border border-violet-500/30 px-1.5 py-0.5 rounded-full">
              <Tag className="w-3 h-3" /> {record.terms_pending_promotion}
            </span>
          )}
          <StateBadge state={record.learning_state} />
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 pt-3 border-t border-surface-3 space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            {[
              { label: 'Impressões', value: (record.total_impressions || 0).toLocaleString('pt-BR'), color: 'text-white' },
              { label: 'Gasto Total', value: `R$${(record.total_spend || 0).toFixed(2)}`, color: 'text-white' },
              { label: 'CPC Médio', value: `R$${(record.avg_cpc || 0).toFixed(2)}`, color: 'text-cyan' },
              { label: 'ACoS', value: (record.avg_acos || 0) > 0 ? `${record.avg_acos.toFixed(1)}%` : '—', color: (record.avg_acos || 0) > 25 ? 'text-amber-400' : 'text-emerald-400' },
            ].map((m, i) => (
              <div key={i} className="bg-surface-1 rounded-lg p-2.5">
                <p className="text-slate-500 text-[10px] mb-0.5">{m.label}</p>
                <p className={`font-bold ${m.color}`}>{m.value}</p>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
            <div className="bg-surface-1 rounded-lg p-2.5">
              <p className="text-slate-500 text-[10px] mb-0.5">Piso Operacional</p>
              <p className="font-semibold text-slate-300">R${(record.bid_floor_operational || 0.50).toFixed(2)}</p>
            </div>
            <div className="bg-surface-1 rounded-lg p-2.5">
              <p className="text-slate-500 text-[10px] mb-0.5">Teto</p>
              <p className="font-semibold text-slate-300">R${(record.bid_ceiling || 3.00).toFixed(2)}</p>
            </div>
            <div className="bg-surface-1 rounded-lg p-2.5">
              <p className="text-slate-500 text-[10px] mb-0.5">Ajustes de Bid</p>
              <p className="font-semibold text-slate-300">↑{record.bid_increase_count || 0} ↓{record.bid_reduction_count || 0}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-[10px]">
            <div className="text-slate-500">Próxima revisão: <span className="text-slate-300">{record.next_review_at ? new Date(record.next_review_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}</span></div>
            <div className="text-slate-500">Última análise: <span className="text-slate-300">{record.last_analysis_at ? new Date(record.last_analysis_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}</span></div>
          </div>
          {record.block_reason && (
            <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              Bloqueada: {record.block_reason}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Linha de promoção de search term → EXACT ─────────────────────────────────
function PromotionRow({ promo, onPromote, promoting }) {
  const cfg = PROMO_STATUS_CONFIG[promo.promotion_status] || PROMO_STATUS_CONFIG.identified;
  const done = isCompleted(promo.promotion_status);
  const failed = isFailed(promo.promotion_status);
  const canPromote = !done && !failed && promo.promotion_status === 'identified';
  const canRetry = promo.promotion_status === 'failed_retryable' || promo.promotion_status === 'repair_required';
  const busy = promoting === promo.id;

  // Calcular conversões a partir dos dados disponíveis
  const conversions = promo.orders || 0;
  const cpc = promo.average_cpc || (promo.clicks > 0 ? promo.spend / promo.clicks : 0);

  return (
    <div className={`bg-surface-2 border rounded-lg px-4 py-3 flex items-start gap-3 ${failed ? 'border-red-500/20' : done ? 'border-emerald-500/20' : 'border-surface-3'}`}>
      <div className="flex-1 min-w-0">
        {/* Termo e ASIN */}
        <div className="flex items-center gap-2 mb-1.5 flex-wrap">
          <p className="text-xs font-semibold text-white">{promo.source_search_term}</p>
          <span className="text-[9px] text-slate-500 font-mono bg-surface-3 px-1.5 py-0.5 rounded">{promo.asin}</span>
          {promo.ai_validated && (
            <span className="text-[9px] text-violet-400 bg-violet-500/10 border border-violet-500/20 px-1.5 py-0.5 rounded">IA ✓</span>
          )}
        </div>

        {/* Métricas */}
        <div className="flex items-center gap-3 text-[10px] text-slate-400 flex-wrap mb-2">
          <span className="text-emerald-400 font-semibold">{conversions} conv.</span>
          <span>Clicks: {promo.clicks || 0}</span>
          <span>CPC: R${cpc.toFixed(2)}</span>
          {promo.acos > 0 && <span>ACoS: {promo.acos.toFixed(1)}%</span>}
          {promo.sales > 0 && <span>Vendas: R${promo.sales.toFixed(2)}</span>}
        </div>

        {/* Fluxo de promoção */}
        <div className="flex items-center gap-1 text-[10px] text-slate-500 flex-wrap">
          <span className="text-slate-400">AUTO</span>
          <ArrowRight className="w-3 h-3" />
          {promo.destination_campaign_name ? (
            <span className="text-violet-300 truncate max-w-[180px]" title={promo.destination_campaign_name}>{promo.destination_campaign_name}</span>
          ) : (
            <span>Campanha MANUAL EXACT</span>
          )}
          {promo.negative_keyword_id && (
            <>
              <ArrowRight className="w-3 h-3" />
              <span className="text-red-400">Negativado ✓</span>
            </>
          )}
        </div>

        {/* Erros */}
        {promo.last_error && (
          <p className="mt-1 text-[10px] text-red-400 bg-red-500/10 px-2 py-1 rounded truncate" title={promo.last_error}>
            ⚠ {promo.last_error}
          </p>
        )}
      </div>

      <div className="flex flex-col items-end gap-2 flex-shrink-0">
        <div className="text-right">
          <p className="text-xs font-bold text-white">R${(promo.target_bid || 0.50).toFixed(2)}</p>
          <p className="text-[9px] text-slate-500">bid alvo</p>
        </div>
        <PromoStatusBadge status={promo.promotion_status} />
        {canPromote && !busy && (
          <button
            onClick={() => onPromote(promo)}
            className="flex items-center gap-1.5 text-[10px] text-violet-300 bg-violet-500/20 border border-violet-500/30 hover:bg-violet-500/30 px-2 py-1 rounded-lg transition-colors"
          >
            <Zap className="w-3 h-3" /> Criar EXACT
          </button>
        )}
        {canRetry && !busy && (
          <button
            onClick={() => onPromote(promo)}
            className="flex items-center gap-1.5 text-[10px] text-amber-300 bg-amber-500/15 border border-amber-500/25 hover:bg-amber-500/25 px-2 py-1 rounded-lg transition-colors"
          >
            <RefreshCw className="w-3 h-3" /> Retry
          </button>
        )}
        {busy && (
          <span className="flex items-center gap-1 text-[10px] text-cyan">
            <Loader2 className="w-3 h-3 animate-spin" /> Criando…
          </span>
        )}
        {promo.retry_count > 0 && (
          <span className="text-[9px] text-slate-500">{promo.retry_count} tentativa(s)</span>
        )}
      </div>
    </div>
  );
}

// ── Componente principal ──────────────────────────────────────────────────────
export default function AutoCampaignJourneyPanel({ account }) {
  const [learningRecords, setLearningRecords] = useState([]);
  const [promotions, setPromotions] = useState([]);
  const [bidHistory, setBidHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState(null);
  const [expandedIds, setExpandedIds] = useState(new Set());
  const [promoting, setPromoting] = useState(null);
  const [tab, setTab] = useState('campaigns');

  const aid = account?.id;

  const loadData = useCallback(async () => {
    if (!aid) return;
    setLoading(true);
    try {
      const [records, promos, history] = await Promise.all([
        base44.entities.AutoCampaignLearning.filter({ amazon_account_id: aid }, '-updated_date', 100),
        base44.entities.SearchTermPromotion.filter({ amazon_account_id: aid }, '-created_at', 200),
        base44.entities.CampaignBidHistory.filter({ amazon_account_id: aid }, '-created_at', 50),
      ]);
      setLearningRecords(records);
      setPromotions(promos);
      setBidHistory(history);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, [aid]);

  useEffect(() => { loadData(); }, [loadData]);

  const runMotor = async () => {
    setRunning(true);
    setRunMsg(null);
    try {
      const res = await base44.functions.invoke('runAutoCampaignLearning', { amazon_account_id: aid });
      if (res.data?.ok) {
        const s = res.data.stats || {};
        setRunMsg({ type: 'success', text: `Motor executado: ${s.bid_increases || 0} aumentos · ${s.bid_reductions || 0} reduções · ${s.promotions_created || 0} promoções criadas` });
        await loadData();
      } else {
        setRunMsg({ type: 'error', text: res.data?.error || 'Erro ao executar motor' });
      }
    } catch (e) {
      setRunMsg({ type: 'error', text: e.message });
    }
    setRunning(false);
    setTimeout(() => setRunMsg(null), 8000);
  };

  const handlePromote = async (promo) => {
    setPromoting(promo.id);
    try {
      const res = await base44.functions.invoke('promoteSearchTermToExact', {
        amazon_account_id: aid,
        promotion_id: promo.id,
      });
      if (res.data?.ok) {
        setRunMsg({ type: 'success', text: `Campanha "${res.data.campaign_name || 'MANUAL EXACT'}" enfileirada para criação.` });
        await loadData();
      } else {
        setRunMsg({ type: 'error', text: res.data?.error || res.data?.reason || 'Erro ao promover' });
      }
    } catch (e) {
      setRunMsg({ type: 'error', text: e.message });
    }
    setPromoting(null);
    setTimeout(() => setRunMsg(null), 8000);
  };

  const toggleExpand = (id) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // Agrupamentos
  const pendingPromos = promotions.filter(p => isPending(p.promotion_status))
    .sort((a, b) => (b.orders || 0) - (a.orders || 0));
  const completedPromos = promotions.filter(p => isCompleted(p.promotion_status));
  const failedPromos = promotions.filter(p => isFailed(p.promotion_status));

  const statsOverview = {
    total: learningRecords.length,
    spending: learningRecords.filter(r => ['spending', 'stable', 'bid_reduction_05'].includes(r.learning_state)).length,
    noSpend: learningRecords.filter(r => ['no_spend', 'bid_increase_10', 'bid_increase_05', 'observing_24h', 'observing_48h'].includes(r.learning_state)).length,
    blocked: learningRecords.filter(r => r.learning_state === 'blocked').length,
    promotionsPending: pendingPromos.length,
    promotionsDone: completedPromos.length,
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="bg-surface-1 border border-cyan/20 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-cyan/15 border border-cyan/30 flex items-center justify-center">
              <Brain className="w-4 h-4 text-cyan" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">Jornada AUTO → MANUAL EXACT → Negativação</h2>
              <p className="text-[10px] text-slate-500">Criação automática · Bid R$0,50 inicial · Promoção de termos convertidos · Negativação na AUTO</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={loadData} disabled={loading} className="p-1.5 text-slate-400 hover:text-slate-200 transition-colors">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={runMotor}
              disabled={running || !aid}
              className="flex items-center gap-2 px-3 py-2 bg-cyan/20 border border-cyan/30 text-cyan hover:bg-cyan/30 text-xs rounded-lg transition-colors disabled:opacity-50"
            >
              {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
              Executar Motor
            </button>
          </div>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
          {[
            { label: 'Campanhas AUTO', value: statsOverview.total,              color: 'text-white' },
            { label: 'Gastando',        value: statsOverview.spending,           color: 'text-emerald-400' },
            { label: 'Sem Gasto',       value: statsOverview.noSpend,            color: 'text-amber-400' },
            { label: 'Bloqueadas',      value: statsOverview.blocked,            color: 'text-red-400' },
            { label: 'Promoções Ativas',value: statsOverview.promotionsPending,  color: 'text-violet-400' },
            { label: 'Concluídas',      value: statsOverview.promotionsDone,     color: 'text-emerald-400' },
          ].map((kpi, i) => (
            <div key={i} className="bg-surface-2 rounded-lg p-3">
              <p className="text-[10px] text-slate-500 mb-1">{kpi.label}</p>
              <p className={`text-xl font-bold ${kpi.color}`}>{kpi.value}</p>
            </div>
          ))}
        </div>

        {runMsg && (
          <div className={`mt-3 flex items-center gap-2 p-2.5 rounded-lg text-xs ${runMsg.type === 'success' ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border border-red-500/20 text-red-400'}`}>
            {runMsg.type === 'success' ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
            {runMsg.text}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-surface-2 gap-1 flex-wrap">
        {[
          { id: 'campaigns',   label: `Campanhas AUTO (${statsOverview.total})` },
          { id: 'promotions',  label: `Termos → EXACT (${pendingPromos.length} pendentes)` },
          { id: 'completed',   label: `Concluídos (${completedPromos.length})` },
          { id: 'failed',      label: `Falhas (${failedPromos.length})` },
          { id: 'history',     label: `Histórico Bids (${bidHistory.length})` },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 text-xs font-medium border-b-2 transition-colors ${tab === t.id ? 'border-cyan text-cyan' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
      ) : (
        <>
          {/* Campanhas AUTO */}
          {tab === 'campaigns' && (
            <div className="space-y-2">
              {learningRecords.length === 0 ? (
                <div className="text-center py-12 text-slate-500 text-sm">
                  <Brain className="w-10 h-10 text-slate-600 mx-auto mb-3" />
                  Nenhuma campanha AUTO em aprendizado.<br />
                  <span className="text-[11px]">Execute o motor para iniciar o rastreamento.</span>
                </div>
              ) : learningRecords.map(r => (
                <LearningRow key={r.id} record={r} onExpand={toggleExpand} expanded={expandedIds.has(r.id)} />
              ))}
            </div>
          )}

          {/* Termos pendentes → EXACT */}
          {tab === 'promotions' && (
            <div className="space-y-2">
              {pendingPromos.length === 0 ? (
                <div className="text-center py-12 text-slate-500 text-sm">
                  <Tag className="w-10 h-10 text-slate-600 mx-auto mb-3" />
                  Nenhum termo aguardando promoção.<br />
                  <span className="text-[11px]">São necessárias ≥ 2 conversões para qualificar um termo.</span>
                </div>
              ) : (
                <>
                  <p className="text-xs text-slate-500 mb-3 flex items-center gap-1.5">
                    <Zap className="w-3.5 h-3.5 text-violet-400" />
                    Termos identificados para promoção a campanha MANUAL EXACT · Negativação automática na AUTO após criação
                  </p>
                  {pendingPromos.map(p => (
                    <PromotionRow key={p.id} promo={p} onPromote={handlePromote} promoting={promoting} />
                  ))}
                </>
              )}
            </div>
          )}

          {/* Concluídos */}
          {tab === 'completed' && (
            <div className="space-y-2">
              {completedPromos.length === 0 ? (
                <div className="text-center py-12 text-slate-500 text-sm">
                  <CheckCircle className="w-10 h-10 text-slate-600 mx-auto mb-3" />
                  Nenhuma promoção concluída ainda.
                </div>
              ) : completedPromos.map(p => (
                <PromotionRow key={p.id} promo={p} onPromote={handlePromote} promoting={promoting} />
              ))}
            </div>
          )}

          {/* Falhas */}
          {tab === 'failed' && (
            <div className="space-y-2">
              {failedPromos.length === 0 ? (
                <div className="text-center py-12 text-slate-500 text-sm">
                  <XCircle className="w-10 h-10 text-slate-600 mx-auto mb-3" />
                  Nenhuma falha registrada.
                </div>
              ) : (
                <>
                  <p className="text-xs text-slate-500 mb-3">Promoções com falha — use "Retry" nos casos retentáveis.</p>
                  {failedPromos.map(p => (
                    <PromotionRow key={p.id} promo={p} onPromote={handlePromote} promoting={promoting} />
                  ))}
                </>
              )}
            </div>
          )}

          {/* Histórico de Bids */}
          {tab === 'history' && (
            <div>
              {bidHistory.length === 0 ? (
                <div className="text-center py-12 text-slate-500 text-sm">
                  <BarChart2 className="w-10 h-10 text-slate-600 mx-auto mb-3" />
                  Nenhum histórico de ajuste de bid ainda.
                </div>
              ) : (
                <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-surface-2 bg-surface-2/50">
                          {['Quando', 'Campanha / ASIN', 'Tipo', 'Anterior', 'Novo', 'Impressões', 'CPC', 'ACoS', 'Motivo'].map(h => (
                            <th key={h} className="px-3 py-2.5 text-left text-[10px] text-slate-500 uppercase whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {bidHistory.map(h => {
                          const ct = CHANGE_TYPE_CONFIG[h.change_type] || { label: h.change_type, icon: Minus, color: 'text-slate-400' };
                          const CtIcon = ct.icon;
                          const isUp = h.new_bid > h.previous_bid;
                          return (
                            <tr key={h.id} className="border-b border-surface-2/50 hover:bg-surface-2/40 transition-colors">
                              <td className="px-3 py-2.5 text-slate-400 whitespace-nowrap text-[10px]">
                                {new Date(h.created_at || h.created_date).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                              </td>
                              <td className="px-3 py-2.5 max-w-[130px]">
                                <p className="text-white truncate">{h.campaign_id?.slice(-8)}</p>
                                <p className="text-[9px] text-slate-500 font-mono">{h.asin || '—'}</p>
                              </td>
                              <td className="px-3 py-2.5">
                                <span className={`flex items-center gap-1 text-[10px] font-semibold ${ct.color}`}>
                                  <CtIcon className="w-3 h-3" />{ct.label}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 text-slate-400 font-mono">R${(h.previous_bid || 0).toFixed(2)}</td>
                              <td className="px-3 py-2.5">
                                <span className={`font-bold font-mono ${isUp ? 'text-blue-400' : h.new_bid < h.previous_bid ? 'text-cyan' : 'text-slate-300'}`}>
                                  R${(h.new_bid || 0).toFixed(2)}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 text-slate-400">{(h.impressions_before || 0).toLocaleString()}</td>
                              <td className="px-3 py-2.5 text-slate-400 font-mono">R${(h.average_cpc_before || 0).toFixed(2)}</td>
                              <td className="px-3 py-2.5">
                                <span className={`font-mono ${(h.acos_before || 0) > 25 ? 'text-amber-400' : (h.acos_before || 0) > 0 ? 'text-emerald-400' : 'text-slate-500'}`}>
                                  {(h.acos_before || 0) > 0 ? `${h.acos_before.toFixed(1)}%` : '—'}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 text-[10px] text-slate-500 max-w-[150px] truncate" title={h.reason}>{h.reason || '—'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}