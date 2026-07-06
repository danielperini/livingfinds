/**
 * AutoCampaignJourneyPanel — Painel de Jornada de Aprendizado das Campanhas AUTO
 * Exibe: estado atual de cada campanha AUTO, histórico de bids, termos candidatos à promoção
 */
import React, { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Brain, TrendingUp, TrendingDown, Target, Zap, CheckCircle, Clock,
  AlertTriangle, RefreshCw, Loader2, ChevronDown, ChevronRight, ArrowUp,
  ArrowDown, Minus, Tag, BarChart2, BookOpen
} from 'lucide-react';

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

const CHANGE_TYPE_CONFIG = {
  initial_bid:          { label: 'Bid Inicial',            icon: Minus,       color: 'text-slate-400' },
  increase_no_spend_10: { label: '+R$0,10 sem gasto',      icon: ArrowUp,     color: 'text-blue-400' },
  increase_no_spend_05: { label: '+R$0,05 sem gasto',      icon: ArrowUp,     color: 'text-blue-300' },
  reduce_low_cpc_05:    { label: '-R$0,05 CPC baixo',      icon: ArrowDown,   color: 'text-cyan' },
  reduce_for_goal_05:   { label: '-R$0,05 meta ACoS',      icon: ArrowDown,   color: 'text-cyan' },
  recover_delivery_10:  { label: '+R$0,10 recuperação',    icon: ArrowUp,     color: 'text-orange-400' },
  manual_adjustment:    { label: 'Ajuste manual',          icon: Target,      color: 'text-amber-400' },
};

const TAIL_CONFIG = {
  long:   { label: 'Cauda Longa',   color: 'text-emerald-400', bg: 'bg-emerald-500/15' },
  medium: { label: 'Cauda Média',   color: 'text-cyan',        bg: 'bg-cyan/15' },
  short:  { label: 'Cauda Curta',   color: 'text-amber-400',   bg: 'bg-amber-500/15' },
};

function StateBadge({ state }) {
  const cfg = STATE_CONFIG[state] || { label: state, color: 'text-slate-400', bg: 'bg-slate-500/15 border-slate-500/30' };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${cfg.bg} ${cfg.color}`}>
      {cfg.label}
    </span>
  );
}

function LearningRow({ record, onExpand, expanded }) {
  const state = STATE_CONFIG[record.learning_state] || STATE_CONFIG.learning_48h;
  const bidDiff = (record.last_bid_with_delivery || 0) - (record.current_bid || 0);

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
          {/* Métricas */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="bg-surface-1 rounded-lg p-2.5">
              <p className="text-slate-500 text-[10px] mb-0.5">Impressões</p>
              <p className="font-bold text-white">{(record.total_impressions || 0).toLocaleString('pt-BR')}</p>
            </div>
            <div className="bg-surface-1 rounded-lg p-2.5">
              <p className="text-slate-500 text-[10px] mb-0.5">Gasto Total</p>
              <p className="font-bold text-white">R${(record.total_spend || 0).toFixed(2)}</p>
            </div>
            <div className="bg-surface-1 rounded-lg p-2.5">
              <p className="text-slate-500 text-[10px] mb-0.5">CPC Médio</p>
              <p className="font-bold text-cyan">R${(record.avg_cpc || 0).toFixed(2)}</p>
            </div>
            <div className="bg-surface-1 rounded-lg p-2.5">
              <p className="text-slate-500 text-[10px] mb-0.5">ACoS</p>
              <p className={`font-bold ${(record.avg_acos || 0) > 25 ? 'text-amber-400' : 'text-emerald-400'}`}>
                {(record.avg_acos || 0) > 0 ? `${record.avg_acos.toFixed(1)}%` : '—'}
              </p>
            </div>
          </div>

          {/* Info de bid */}
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
              <p className="text-slate-500 text-[10px] mb-0.5">Ajustes</p>
              <p className="font-semibold text-slate-300">
                ↑{record.bid_increase_count || 0} ↓{record.bid_reduction_count || 0}
              </p>
            </div>
          </div>

          {/* Datas */}
          <div className="grid grid-cols-2 gap-2 text-[10px]">
            <div className="text-slate-500">
              <span>Próxima revisão: </span>
              <span className="text-slate-300">{record.next_review_at ? new Date(record.next_review_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}</span>
            </div>
            <div className="text-slate-500">
              <span>Última análise: </span>
              <span className="text-slate-300">{record.last_analysis_at ? new Date(record.last_analysis_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}</span>
            </div>
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

function PromotionRow({ promo, onPromote, promoting }) {
  const tail = TAIL_CONFIG[promo.tail_type] || TAIL_CONFIG.medium;
  const statusOk = promo.status === 'promoted';
  const statusBlocked = promo.status?.startsWith('blocked') || promo.status === 'rejected';

  return (
    <div className="bg-surface-2 border border-surface-3 rounded-lg px-4 py-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <p className="text-xs font-semibold text-white truncate max-w-[200px]">{promo.search_term}</p>
          <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded ${tail.bg} ${tail.color}`}>{tail.label}</span>
          <span className="text-[9px] text-slate-500 bg-surface-3 px-1.5 py-0.5 rounded">Score: {promo.promotion_score}</span>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-slate-400">
          <span>{promo.conversions} conv.</span>
          <span>CPC: R${(promo.avg_cpc || 0).toFixed(2)}</span>
          {promo.acos > 0 && <span>ACoS: {promo.acos.toFixed(1)}%</span>}
          <span className="text-slate-500 font-mono truncate">{promo.asin}</span>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <div className="text-right">
          <p className="text-xs font-bold text-white">R${(promo.target_bid || 0.50).toFixed(2)}</p>
          <p className="text-[9px] text-slate-500">bid alvo</p>
        </div>
        {statusOk ? (
          <span className="flex items-center gap-1 text-[10px] text-emerald-400 bg-emerald-500/15 border border-emerald-500/30 px-2 py-1 rounded-lg">
            <CheckCircle className="w-3 h-3" /> Promovido
          </span>
        ) : statusBlocked ? (
          <span className="text-[10px] text-red-400 bg-red-500/10 border border-red-500/20 px-2 py-1 rounded-lg">
            Bloqueado
          </span>
        ) : (
          <button
            onClick={() => onPromote(promo)}
            disabled={promoting === promo.id}
            className="flex items-center gap-1.5 text-[10px] text-violet-300 bg-violet-500/20 border border-violet-500/30 hover:bg-violet-500/30 px-2 py-1 rounded-lg transition-colors disabled:opacity-50"
          >
            {promoting === promo.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
            Criar EXACT
          </button>
        )}
      </div>
    </div>
  );
}

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
        base44.entities.SearchTermPromotion.filter({ amazon_account_id: aid }, '-created_at', 100),
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
        setRunMsg({ type: 'success', text: `Motor executado: ${s.bid_increases || 0} aumentos, ${s.bid_reductions || 0} reduções, ${s.promotions_created || 0} promoções criadas` });
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
        setRunMsg({ type: 'success', text: `Campanha "${res.data.campaign_name}" enfileirada para criação.` });
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

  // Estatísticas
  const statsOverview = {
    total: learningRecords.length,
    spending: learningRecords.filter(r => ['spending', 'stable', 'bid_reduction_05'].includes(r.learning_state)).length,
    noSpend: learningRecords.filter(r => ['no_spend', 'bid_increase_10', 'bid_increase_05', 'observing_24h', 'observing_48h'].includes(r.learning_state)).length,
    blocked: learningRecords.filter(r => r.learning_state === 'blocked').length,
    promotionsPending: promotions.filter(p => ['candidate', 'validating'].includes(p.status)).length,
    promotionsDone: promotions.filter(p => p.status === 'promoted').length,
  };

  const pendingPromos = promotions.filter(p => ['candidate', 'validating'].includes(p.status))
    .sort((a, b) => (b.promotion_score || 0) - (a.promotion_score || 0));
  const donePromos = promotions.filter(p => p.status === 'promoted');
  const blockedPromos = promotions.filter(p => p.status?.startsWith('blocked') || p.status === 'rejected');

  const CHANGE_TYPE_ICONS = {
    initial_bid: Minus,
    increase_no_spend_10: ArrowUp,
    increase_no_spend_05: ArrowUp,
    reduce_low_cpc_05: ArrowDown,
    reduce_for_goal_05: ArrowDown,
    recover_delivery_10: ArrowUp,
    manual_adjustment: Target,
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
              <h2 className="text-sm font-bold text-white">Jornada de Aprendizado — Campanhas AUTO</h2>
              <p className="text-[10px] text-slate-500">Motor determinístico · Bid R$0,50 inicial · Promoção EXACT automática</p>
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
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {[
            { label: 'Campanhas AUTO', value: statsOverview.total, color: 'text-white' },
            { label: 'Gastando', value: statsOverview.spending, color: 'text-emerald-400' },
            { label: 'Sem Gasto', value: statsOverview.noSpend, color: 'text-amber-400' },
            { label: 'Promoções Pendentes', value: statsOverview.promotionsPending, color: 'text-violet-400' },
            { label: 'Termos Promovidos', value: statsOverview.promotionsDone, color: 'text-emerald-400' },
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
      <div className="flex border-b border-surface-2 gap-1">
        {[
          { id: 'campaigns', label: `Campanhas (${statsOverview.total})` },
          { id: 'promotions', label: `Termos Candidatos (${statsOverview.promotionsPending})` },
          { id: 'history', label: `Histórico de Bids (${bidHistory.length})` },
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
          {/* Tab: Campanhas */}
          {tab === 'campaigns' && (
            <div className="space-y-2">
              {learningRecords.length === 0 ? (
                <div className="text-center py-12 text-slate-500 text-sm">
                  <Brain className="w-10 h-10 text-slate-600 mx-auto mb-3" />
                  Nenhuma campanha AUTO em aprendizado ainda.<br />
                  <span className="text-[11px]">Execute o motor para iniciar o rastreamento.</span>
                </div>
              ) : (
                learningRecords.map(r => (
                  <LearningRow key={r.id} record={r} onExpand={toggleExpand} expanded={expandedIds.has(r.id)} />
                ))
              )}
            </div>
          )}

          {/* Tab: Promoções */}
          {tab === 'promotions' && (
            <div className="space-y-4">
              {pendingPromos.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-slate-400 mb-2 flex items-center gap-1.5">
                    <Zap className="w-3.5 h-3.5 text-violet-400" /> Candidatos à Promoção EXACT ({pendingPromos.length})
                  </p>
                  <p className="text-[10px] text-slate-500 mb-3">Ordenados por score. Mínimo: 2 conversões + score ≥ 6 + confiança ≥ 80%.</p>
                  <div className="space-y-2">
                    {pendingPromos.map(p => (
                      <PromotionRow key={p.id} promo={p} onPromote={handlePromote} promoting={promoting} />
                    ))}
                  </div>
                </div>
              )}
              {donePromos.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-slate-400 mb-2 flex items-center gap-1.5">
                    <CheckCircle className="w-3.5 h-3.5 text-emerald-400" /> Promovidos ({donePromos.length})
                  </p>
                  <div className="space-y-2">
                    {donePromos.map(p => (
                      <PromotionRow key={p.id} promo={p} onPromote={handlePromote} promoting={promoting} />
                    ))}
                  </div>
                </div>
              )}
              {blockedPromos.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-slate-400 mb-2 flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 text-red-400" /> Bloqueados/Rejeitados ({blockedPromos.length})
                  </p>
                  <div className="space-y-2">
                    {blockedPromos.map(p => (
                      <PromotionRow key={p.id} promo={p} onPromote={handlePromote} promoting={promoting} />
                    ))}
                  </div>
                </div>
              )}
              {promotions.length === 0 && (
                <div className="text-center py-12 text-slate-500 text-sm">
                  <Tag className="w-10 h-10 text-slate-600 mx-auto mb-3" />
                  Nenhum termo candidato ainda.<br />
                  <span className="text-[11px]">São necessárias ≥2 conversões para qualificar um termo.</span>
                </div>
              )}
            </div>
          )}

          {/* Tab: Histórico de Bids */}
          {tab === 'history' && (
            <div>
              {bidHistory.length === 0 ? (
                <div className="text-center py-12 text-slate-500 text-sm">
                  <BarChart2 className="w-10 h-10 text-slate-600 mx-auto mb-3" />
                  Nenhum histórico de ajuste de bid ainda.
                </div>
              ) : (
                <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-surface-2 bg-surface-2/50">
                        {['Quando', 'Campanha', 'Tipo', 'Bid Anterior', 'Novo Bid', 'Impressões', 'CPC', 'ACoS', 'Motivo'].map(h => (
                          <th key={h} className="px-3 py-2.5 text-left text-[10px] text-slate-500 uppercase whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {bidHistory.map(h => {
                        const ct = CHANGE_TYPE_CONFIG[h.change_type] || { label: h.change_type, icon: Minus, color: 'text-slate-400' };
                        const Icon = ct.icon;
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
                                <Icon className="w-3 h-3" />{ct.label}
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
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}