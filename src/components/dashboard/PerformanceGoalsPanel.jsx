/**
 * PerformanceGoalsPanel
 * Exibe as Metas de Performance Aplicadas no Dashboard.
 * Lê exclusivamente de PerformanceSettings (fonte única configurada em Configurações).
 * Não calcula nem deriva metas próprias.
 */
import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Target, AlertTriangle, CheckCircle, Clock, TrendingDown, TrendingUp, DollarSign, Activity } from 'lucide-react';

const fmt2 = (v) => Number(v || 0).toFixed(2);
const fmtPct = (v) => `${Number(v || 0).toFixed(1)}%`;

function GoalBadge({ label, value, status }) {
  const colors = {
    ok: 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300',
    warn: 'bg-amber-400/10 border-amber-400/20 text-amber-300',
    danger: 'bg-red-400/10 border-red-400/20 text-red-300',
    info: 'bg-cyan/10 border-cyan/20 text-cyan',
    neutral: 'bg-surface-2 border-surface-3 text-slate-300',
  };
  return (
    <div className={`flex flex-col gap-0.5 px-3 py-2 rounded-lg border text-center ${colors[status || 'neutral']}`}>
      <span className="text-[10px] opacity-70">{label}</span>
      <span className="text-sm font-bold">{value}</span>
    </div>
  );
}

function MetricCard({ icon: IconComp, label, configured, current, unit = '', goal_name, status }) {
  const Icon = IconComp;
  const statusColors = {
    ok: 'border-emerald-400/20 bg-emerald-400/5',
    warn: 'border-amber-400/20 bg-amber-400/5',
    danger: 'border-red-400/20 bg-red-400/5',
    neutral: 'border-surface-2 bg-surface-1',
  };
  const textColors = {
    ok: 'text-emerald-300',
    warn: 'text-amber-300',
    danger: 'text-red-300',
    neutral: 'text-slate-300',
  };
  return (
    <div className={`rounded-lg border p-3 ${statusColors[status || 'neutral']}`}>
      <div className="flex items-center gap-2 mb-2">
        <Icon className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
        <span className="text-[10px] text-slate-400">{label}</span>
      </div>
      <div className="flex items-end justify-between">
        <div>
          <p className={`text-base font-bold ${textColors[status || 'neutral']}`}>
            {current !== null && current !== undefined ? `${unit}${typeof current === 'number' ? current.toFixed(1) : current}` : '—'}
          </p>
          <p className="text-[10px] text-slate-500 mt-0.5">Meta: {unit}{configured}</p>
        </div>
        {goal_name && (
          <span className="text-[9px] text-slate-600 bg-surface-3 px-1.5 py-0.5 rounded">{goal_name}</span>
        )}
      </div>
    </div>
  );
}

export default function PerformanceGoalsPanel({ account, metricsData }) {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!account?.id) return;
    base44.entities.PerformanceSettings.filter({ amazon_account_id: account.id }, '-updated_at', 1)
      .then(list => {
        if (list.length > 0) { setSettings(list[0]); return; }
        // Fallback AutopilotConfig
        return base44.entities.AutopilotConfig.filter({ amazon_account_id: account.id }, null, 1)
          .then(cfgs => {
            if (!cfgs.length) return;
            const c = cfgs[0];
            setSettings({
              target_acos: c.target_acos, max_acos: c.maximum_acos, target_roas: c.target_roas,
              target_tacos: c.target_tacos, max_tacos: c.maximum_tacos,
              daily_budget_limit: c.total_daily_budget || c.daily_budget_limit,
              target_cpc: c.target_cpc, max_cpc: c.maximum_cpc, min_bid: c.min_bid,
              max_bid: c.max_bid, max_bid_increase_pct: c.max_bid_increase_pct,
              max_bid_decrease_pct: c.max_bid_decrease_pct, minimum_campaign_budget: 15,
              campaign_budget_increment: 5, weekly_campaign_capacity: 10,
              pacing_enabled: c.budget_optimization_enabled, dayparting_enabled: c.dayparting_enabled,
              placement_optimization_enabled: c.placement_optimization_enabled,
              top_of_search_limit: c.top_of_search_limit, rest_of_search_limit: c.rest_of_search_limit,
              product_page_limit: c.product_page_limit, ai_auto_optimization: c.ai_auto_optimization,
              _source: 'AutopilotConfig',
            });
          });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [account?.id]);

  if (loading) return null;
  if (!settings) return null;

  const s = settings;
  const m = metricsData || {};

  // Comparar métricas atuais com metas configuradas
  const currentAcos = m.acos || null;
  const currentRoas = m.roas || null;
  const currentTacos = m.tacos || null;
  const currentCpc = m.cpc || null;
  const totalBudget = m.total_budget || null;
  const todaySpend = m.today_spend || null;

  const acosStatus = currentAcos == null ? 'neutral' : currentAcos <= (s.target_acos || 10) ? 'ok' : currentAcos <= (s.max_acos || 15) ? 'warn' : 'danger';
  const roasStatus = currentRoas == null ? 'neutral' : currentRoas >= (s.target_roas || 4) ? 'ok' : currentRoas >= (s.target_roas || 4) * 0.8 ? 'warn' : 'danger';
  const tacosStatus = currentTacos == null ? 'neutral' : currentTacos <= (s.target_tacos || 5) ? 'ok' : currentTacos <= (s.max_tacos || 10) ? 'warn' : 'danger';
  const cpcStatus = currentCpc == null || !(s.max_cpc > 0) ? 'neutral' : currentCpc <= (s.target_cpc || 0.60) ? 'ok' : currentCpc <= (s.max_cpc || 1.00) ? 'warn' : 'danger';
  const budgetStatus = todaySpend == null || !totalBudget ? 'neutral' : todaySpend <= totalBudget * 0.85 ? 'ok' : todaySpend <= totalBudget ? 'warn' : 'danger';

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Target className="w-4 h-4 text-cyan" />
          <h3 className="text-sm font-semibold text-white">Metas de Performance Aplicadas</h3>
          <span className="text-[10px] text-cyan/60 bg-cyan/10 border border-cyan/20 px-1.5 py-0.5 rounded-full">
            {s._source === 'AutopilotConfig' ? 'AutopilotConfig' : 'Configurações'}
          </span>
        </div>
        <a href="/settings" className="text-[10px] text-cyan hover:underline">Editar metas →</a>
      </div>

      {/* Resumo compacto de metas */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        <GoalBadge label="Meta Principal" value={s.primary_goal === 'acos' ? 'ACoS' : (s.primary_goal || 'ACoS').toUpperCase()} status="info" />
        <GoalBadge label="ACoS Alvo" value={fmtPct(s.target_acos)} status={acosStatus} />
        <GoalBadge label="ACoS Máx." value={fmtPct(s.max_acos)} status={acosStatus === 'danger' ? 'danger' : 'neutral'} />
        <GoalBadge label="ROAS Alvo" value={`${s.target_roas || 4}x`} status={roasStatus} />
        <GoalBadge label="TACoS Alvo" value={fmtPct(s.target_tacos)} status={tacosStatus} />
        <GoalBadge label="Budget/dia" value={`R$${s.daily_budget_limit || 56}`} status={budgetStatus} />
      </div>

      {/* Cards de métricas comparadas */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <MetricCard icon={Activity} label="ACoS Atual vs Alvo" configured={fmtPct(s.target_acos)} current={currentAcos} unit="" goal_name="ACoS Alvo" status={acosStatus} />
        <MetricCard icon={TrendingUp} label="ROAS Atual vs Alvo" configured={`${s.target_roas || 4}x`} current={currentRoas ? `${currentRoas.toFixed(2)}x` : null} unit="" goal_name="ROAS Alvo" status={roasStatus} />
        <MetricCard icon={TrendingDown} label="TACoS Atual vs Alvo" configured={fmtPct(s.target_tacos)} current={currentTacos} unit="" goal_name="TACoS Alvo" status={tacosStatus} />
        <MetricCard icon={DollarSign} label="CPC Atual vs Alvo" configured={`R$${fmt2(s.target_cpc)}`} current={currentCpc ? `R$${currentCpc.toFixed(2)}` : null} unit="" goal_name="CPC Alvo" status={cpcStatus} />
      </div>

      {/* Parâmetros de controle */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 border-t border-surface-2">
        {[
          { label: 'Bid Mín / Máx', value: `R$${fmt2(s.min_bid)} / R$${fmt2(s.max_bid)}` },
          { label: 'Aumento/Redução Bid', value: `+${s.max_bid_increase_pct || 20}% / -${s.max_bid_decrease_pct || 20}%` },
          { label: 'Budget Mín Campanha', value: `R$${s.minimum_campaign_budget || 15} (+R$${s.campaign_budget_increment || 5})` },
          { label: 'CPC Máx. (Enforç.)', value: s.max_cpc > 0 ? `R$${fmt2(s.max_cpc)} ✓` : 'Inativo' },
        ].map(({ label, value }) => (
          <div key={label} className="text-center px-2 py-1.5 bg-surface-2 rounded-lg">
            <p className="text-[10px] text-slate-500">{label}</p>
            <p className="text-xs font-semibold text-slate-200 mt-0.5">{value}</p>
          </div>
        ))}
      </div>

      {/* Status automações */}
      <div className="flex flex-wrap gap-2 pt-1 border-t border-surface-2">
        {[
          { label: 'Pacing', active: s.pacing_enabled },
          { label: 'Dayparting', active: s.dayparting_enabled },
          { label: 'Placement', active: s.placement_optimization_enabled, note: (s.top_of_search_limit === 0 && s.rest_of_search_limit === 0 && s.product_page_limit === 0) ? '(limites 0)' : null },
          { label: 'IA Auto', active: s.ai_auto_optimization },
          { label: 'Meta Impressões', active: s.impressions_goal_enabled },
        ].map(({ label, active, note }) => (
          <div key={label} className={`flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium border ${active ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300' : 'bg-surface-2 border-surface-3 text-slate-500'}`}>
            {active ? <CheckCircle className="w-2.5 h-2.5" /> : <Clock className="w-2.5 h-2.5" />}
            {label}{note ? ` ${note}` : ''}
          </div>
        ))}
        {s.placement_optimization_enabled && s.top_of_search_limit === 0 && (
          <div className="flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium border bg-amber-400/10 border-amber-400/20 text-amber-300">
            <AlertTriangle className="w-2.5 h-2.5" />
            Placement ativo mas limites = 0 (somente sugestões)
          </div>
        )}
      </div>
    </div>
  );
}