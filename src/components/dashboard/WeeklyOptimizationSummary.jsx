import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Brain, TrendingDown, TrendingUp, Minus, CheckCircle, XCircle, AlertTriangle, Clock, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';

function Delta({ before, after, unit = '%', lowerIsBetter = false }) {
  if (!before || !after) return <span className="text-slate-500">—</span>;
  const diff = after - before;
  const pct = before !== 0 ? (diff / before) * 100 : 0;
  const improved = lowerIsBetter ? diff < 0 : diff > 0;
  const neutral = Math.abs(pct) < 1;
  const color = neutral ? 'text-slate-400' : improved ? 'text-emerald-400' : 'text-red-400';
  const Icon = neutral ? Minus : improved ? TrendingDown : TrendingUp;
  return (
    <div className={`flex items-center gap-1 ${color}`}>
      <Icon className="w-3 h-3" />
      <span className="text-xs font-semibold">
        {before.toFixed(1)}{unit} → {after.toFixed(1)}{unit}
      </span>
      <span className="text-[10px] opacity-70">({pct > 0 ? '+' : ''}{pct.toFixed(1)}%)</span>
    </div>
  );
}

function ReviewRow({ review, isLatest }) {
  const [expanded, setExpanded] = useState(isLatest);

  const statusColor = {
    completed: 'border-emerald-500/30 bg-emerald-500/5',
    failed: 'border-red-500/30 bg-red-500/5',
    running: 'border-cyan/30 bg-cyan/5',
    partial: 'border-amber-500/30 bg-amber-500/5',
  }[review.status] || 'border-surface-3 bg-surface-2';

  const approvalRate = review.rules_proposed > 0
    ? ((review.rules_approved / review.rules_proposed) * 100).toFixed(0)
    : null;

  return (
    <div className={`border rounded-xl overflow-hidden ${statusColor}`}>
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/5 transition-colors text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          {expanded ? <ChevronUp className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />}
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-white">
                {new Date(review.started_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })}
              </span>
              {isLatest && (
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30">ÚLTIMA</span>
              )}
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${
                review.status === 'completed' ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' :
                review.status === 'failed' ? 'bg-red-500/15 text-red-400 border-red-500/30' :
                'bg-slate-500/15 text-slate-400 border-slate-500/30'
              }`}>{review.status}</span>
            </div>
            <p className="text-[10px] text-slate-500 mt-0.5">
              {review.rules_proposed || 0} propostas · {review.rules_approved || 0} aprovadas · {review.rules_rejected || 0} rejeitadas
              {approvalRate !== null && <span className="ml-1 text-violet-400">({approvalRate}% taxa)</span>}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4 flex-shrink-0 ml-3">
          <div className="text-right hidden sm:block">
            <p className="text-[10px] text-slate-500">Dados analisados</p>
            <p className="text-xs font-semibold text-white">{(review.records_analyzed || 0).toLocaleString('pt-BR')}</p>
          </div>
          <div className="text-right hidden sm:block">
            <p className="text-[10px] text-slate-500">Qualidade</p>
            <p className="text-xs font-semibold text-cyan">{((review.data_quality_score || 0) * 100).toFixed(0)}%</p>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-white/10 pt-3">

          {/* Métricas antes/depois estimadas via backtest */}
          {review.status === 'completed' && review.rules_approved > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="bg-surface-2 rounded-lg p-3">
                <p className="text-[10px] text-slate-500 mb-1.5">Regras aprovadas / rejeitadas</p>
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1 text-emerald-400 font-bold text-sm">
                    <CheckCircle className="w-3.5 h-3.5" /> {review.rules_approved}
                  </span>
                  <span className="text-slate-600">/</span>
                  <span className="flex items-center gap-1 text-red-400 font-bold text-sm">
                    <XCircle className="w-3.5 h-3.5" /> {review.rules_rejected}
                  </span>
                </div>
              </div>
              <div className="bg-surface-2 rounded-lg p-3">
                <p className="text-[10px] text-slate-500 mb-1.5">Tokens · Custo</p>
                <p className="text-xs font-semibold text-white">{(review.tokens_used || 0).toLocaleString('pt-BR')}</p>
                <p className="text-[10px] text-slate-400">US${(review.cost_estimate_usd || 0).toFixed(4)}</p>
              </div>
              <div className="bg-surface-2 rounded-lg p-3">
                <p className="text-[10px] text-slate-500 mb-1.5">Duração</p>
                <p className="text-xs font-semibold text-white">
                  {review.duration_ms ? `${(review.duration_ms / 1000).toFixed(1)}s` : '—'}
                </p>
                <p className="text-[10px] text-slate-400">
                  {review.analysis_period_start} → {review.analysis_period_end}
                </p>
              </div>
            </div>
          )}

          {/* Observações do Claude */}
          {review.global_observations?.length > 0 && (
            <div className="p-3 bg-violet-500/5 border border-violet-500/20 rounded-lg">
              <p className="text-[10px] font-semibold text-violet-400 mb-2 flex items-center gap-1">
                <Brain className="w-3 h-3" /> Observações do Claude
              </p>
              <ul className="space-y-1">
                {review.global_observations.map((obs, i) => (
                  <li key={i} className="text-[10px] text-slate-300 leading-relaxed">• {obs}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Avisos de qualidade */}
          {review.data_warnings?.length > 0 && (
            <div className="p-3 bg-amber-500/5 border border-amber-500/15 rounded-lg">
              <p className="text-[10px] font-semibold text-amber-400 mb-1 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> Avisos de qualidade de dados
              </p>
              {review.data_warnings.map((w, i) => (
                <p key={i} className="text-[10px] text-amber-300">⚠ {w}</p>
              ))}
            </div>
          )}

          {/* Erro */}
          {review.status === 'failed' && review.error_message && (
            <div className="p-3 bg-red-500/5 border border-red-500/15 rounded-lg">
              <p className="text-[10px] font-semibold text-red-400 mb-1">Erro — regras anteriores mantidas</p>
              <p className="text-[10px] text-red-300">{review.error_message}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function WeeklyOptimizationSummary({ account }) {
  const [reviews, setReviews] = useState([]);
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!account?.id) return;
    const load = async () => {
      setLoading(true);
      try {
        const [revs, activeRules] = await Promise.all([
          base44.entities.WeeklyRuleReview.filter({ amazon_account_id: account.id }, '-started_at', 8),
          base44.entities.DecisionRule.filter({ amazon_account_id: account.id, status: 'active' }, null, 50),
        ]);
        setReviews(revs);
        setRules(activeRules);
      } catch (e) { console.error(e); }
      setLoading(false);
    };
    load();
  }, [account?.id]);

  const completedReviews = reviews.filter(r => r.status === 'completed');
  const totalApproved = completedReviews.reduce((s, r) => s + (r.rules_approved || 0), 0);
  const totalRejected = completedReviews.reduce((s, r) => s + (r.rules_rejected || 0), 0);
  const avgQuality = completedReviews.length > 0
    ? completedReviews.reduce((s, r) => s + (r.data_quality_score || 0), 0) / completedReviews.length
    : 0;

  const visibleReviews = showAll ? reviews : reviews.slice(0, 3);

  return (
    <div className="bg-surface-1 border border-violet-500/20 rounded-xl p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-violet-500/15 border border-violet-500/30 flex items-center justify-center">
            <Brain className="w-3.5 h-3.5 text-violet-400" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-white">Otimizações Semanais — Claude</h2>
            <p className="text-[10px] text-slate-500">{completedReviews.length} revisões concluídas · {rules.length} regras ativas</p>
          </div>
        </div>
        <span className="text-[10px] px-2 py-1 rounded-full bg-violet-500/10 border border-violet-500/20 text-violet-400 font-semibold">
          Módulo A
        </span>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 text-violet-400 animate-spin" />
        </div>
      ) : reviews.length === 0 ? (
        <div className="text-center py-8">
          <Brain className="w-8 h-8 text-slate-600 mx-auto mb-2" />
          <p className="text-sm text-slate-500">Nenhuma revisão executada ainda.</p>
          <p className="text-[11px] text-slate-600 mt-1">Próxima execução automática: domingo 23h BRT</p>
        </div>
      ) : (
        <>
          {/* KPI summary */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <div className="bg-surface-2 rounded-lg p-3 text-center">
              <p className="text-[10px] text-slate-500 mb-1">Revisões</p>
              <p className="text-lg font-bold text-white">{completedReviews.length}</p>
            </div>
            <div className="bg-surface-2 rounded-lg p-3 text-center">
              <p className="text-[10px] text-slate-500 mb-1">Regras aprovadas</p>
              <p className="text-lg font-bold text-emerald-400">{totalApproved}</p>
            </div>
            <div className="bg-surface-2 rounded-lg p-3 text-center">
              <p className="text-[10px] text-slate-500 mb-1">Rejeitadas</p>
              <p className="text-lg font-bold text-red-400">{totalRejected}</p>
            </div>
            <div className="bg-surface-2 rounded-lg p-3 text-center">
              <p className="text-[10px] text-slate-500 mb-1">Qualidade média</p>
              <p className="text-lg font-bold text-cyan">{(avgQuality * 100).toFixed(0)}%</p>
            </div>
          </div>

          {/* Regras ativas resumo */}
          {rules.length > 0 && (
            <div className="mb-4 p-3 bg-surface-2 rounded-lg border border-emerald-500/15">
              <p className="text-[10px] font-semibold text-emerald-400 mb-2">
                {rules.length} regras determinísticas ativas agora
              </p>
              <div className="flex flex-wrap gap-1.5">
                {rules.slice(0, 8).map(r => (
                  <span key={r.id} className="text-[10px] px-2 py-0.5 bg-surface-3 border border-surface-3 rounded text-slate-300 font-mono truncate max-w-[180px]">
                    {r.name}
                  </span>
                ))}
                {rules.length > 8 && (
                  <span className="text-[10px] px-2 py-0.5 bg-surface-3 rounded text-slate-500">+{rules.length - 8} mais</span>
                )}
              </div>
            </div>
          )}

          {/* Lista de revisões */}
          <div className="space-y-2">
            {visibleReviews.map((review, i) => (
              <ReviewRow key={review.id} review={review} isLatest={i === 0} />
            ))}
          </div>

          {reviews.length > 3 && (
            <button
              onClick={() => setShowAll(v => !v)}
              className="mt-3 w-full flex items-center justify-center gap-1.5 text-xs text-slate-500 hover:text-slate-300 transition-colors py-2"
            >
              {showAll ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              {showAll ? 'Mostrar menos' : `Ver todas as ${reviews.length} revisões`}
            </button>
          )}
        </>
      )}
    </div>
  );
}