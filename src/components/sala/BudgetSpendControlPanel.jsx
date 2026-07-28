/**
 * BudgetSpendControlPanel — Painel de Controle de Orçamento Diário
 *
 * SEPARAÇÃO EXPLÍCITA:
 *   1. Teto diário da conta (user_daily_spend_cap) — definido pelo usuário
 *   2. Budgets das campanhas — soma nominal pode ultrapassar o teto (normal)
 *   3. Sugestão da IA — apenas recomendação, nunca altera o teto automaticamente
 *   4. Gasto confirmado + projetado — controle real
 *   5. Pacing + status da faixa
 */
import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  DollarSign, RefreshCw, Loader2, AlertTriangle, CheckCircle,
  TrendingUp, TrendingDown, Gauge, Clock, Shield,
  Info, ChevronDown, ChevronUp, Brain, BarChart2, Pause,
  Zap, RotateCcw, ExternalLink
} from 'lucide-react';
import ProactiveBudgetOptimizerCard from './ProactiveBudgetOptimizerCard';
import KillSwitchPauseDetail from './KillSwitchPauseDetail';
import BudgetCheckpointsPanel from './BudgetCheckpointsPanel';

const CAP_STATUS_CONFIG = {
  safe:        { label: 'Normal',       color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20', bar: 'bg-emerald-500' },
  attention:   { label: 'Atenção',      color: 'text-amber-400',   bg: 'bg-amber-500/10 border-amber-500/20',     bar: 'bg-amber-500' },
  critical:    { label: 'Crítico',      color: 'text-orange-400',  bg: 'bg-orange-500/10 border-orange-500/20',   bar: 'bg-orange-500' },
  cap_imminent:{ label: 'Teto Próximo', color: 'text-red-400',     bg: 'bg-red-500/10 border-red-500/20',         bar: 'bg-red-500' },
  cap_reached: { label: 'Teto Atingido',color: 'text-red-300',     bg: 'bg-red-500/15 border-red-500/30',         bar: 'bg-red-600' },
};

const PACING_CONFIG = {
  underpacing: { label: 'Abaixo do ritmo', color: 'text-amber-400',   Icon: TrendingDown, desc: 'Possível underpacing — oportunidade de aumentar exposição de campanhas rentáveis.' },
  on_track:    { label: 'No ritmo',        color: 'text-emerald-400', Icon: CheckCircle,  desc: 'Distribuição dentro da faixa esperada.' },
  overpacing:  { label: 'Acima do ritmo',  color: 'text-orange-400',  Icon: TrendingUp,   desc: 'Gasto acima do esperado — reduzir exposição de descoberta temporariamente.' },
  unknown:     { label: 'Aguardando dados',color: 'text-slate-500',   Icon: Clock,        desc: '' },
};

function fmtBRL(v) {
  return v == null ? '—' : `R$${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function SpendBar({ confirmed, estimated, cap }) {
  if (!cap || cap <= 0) return null;
  const confPct = Math.min(100, (confirmed / cap) * 100);
  const estPct  = Math.min(100 - confPct, (estimated / cap) * 100);
  return (
    <div className="space-y-1">
      <div className="h-3 bg-surface-3 rounded-full overflow-hidden flex">
        <div className="h-full bg-cyan transition-all duration-500" style={{ width: `${confPct}%` }} title={`Confirmado: ${fmtBRL(confirmed)}`} />
        <div className="h-full bg-cyan/30 transition-all duration-500" style={{ width: `${estPct}%` }} title={`Estimado pendente: ${fmtBRL(estimated)}`} />
      </div>
      <div className="flex items-center gap-3 text-[9px] text-slate-500">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-cyan inline-block" />Confirmado</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-cyan/30 inline-block" />Estimado pendente</span>
        <span className="ml-auto">{Math.round(confPct + estPct)}% do teto projetado</span>
      </div>
    </div>
  );
}

export default function BudgetSpendControlPanel({ account }) {
  const [controller, setController] = useState(null); // setController usado também em saveCap para patch otimista
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showAiDetails, setShowAiDetails] = useState(false);
  const [editingCap, setEditingCap] = useState(false);
  const [newCapValue, setNewCapValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [runningRecovery, setRunningRecovery] = useState(false);
  const [recoveryResult, setRecoveryResult] = useState(null);
  const [aiDecisions, setAiDecisions] = useState([]);
  const [showDecisions, setShowDecisions] = useState(false);

  const load = useCallback(async () => {
    if (!account) return;
    setLoading(true);
    try {
      const today = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10); // BRT
      const list = await base44.entities.AccountDailySpendController.filter(
        { amazon_account_id: account.id, spend_date: today }, null, 1
      ).catch(() => []);
      setController(list[0] ?? null);
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setLoading(false);
    }
  }, [account]);

  useEffect(() => { load(); }, [load]);

  const refresh = async () => {
    if (!account || refreshing) return;
    setRefreshing(true);
    setMsg(null);
    try {
      const res = await base44.functions.invoke('updateDailySpendController', { amazon_account_id: account.id });
      if (res?.data?.ok) {
        setMsg({ type: 'success', text: 'Atualizado com sucesso.' });
        await load();
      } else {
        setMsg({ type: 'error', text: res?.data?.error || 'Erro ao atualizar.' });
      }
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setRefreshing(false);
      setTimeout(() => setMsg(null), 5000);
    }
  };

  const loadAiDecisions = useCallback(async () => {
    if (!account) return;
    const todayBRT = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
    const decisions = await base44.entities.OptimizationDecision.filter(
      { amazon_account_id: account.id, source_function: 'runKillSwitchRecoveryWithAI' }, '-created_at', 20
    ).catch(() => []);
    setAiDecisions(decisions.filter(d => (d.created_at || '').startsWith(todayBRT)));
  }, [account]);

  useEffect(() => { if (account) loadAiDecisions(); }, [loadAiDecisions]);

  const runRecovery = async () => {
    if (!account || runningRecovery) return;
    setRunningRecovery(true);
    setRecoveryResult(null);
    setMsg(null);
    try {
      const res = await base44.functions.invoke('runKillSwitchRecoveryWithAI', { amazon_account_id: account.id });
      const data = res?.data || res;
      setRecoveryResult(data);
      if (data?.ok) {
        setMsg({ type: 'success', text: `Recuperação concluída: ${data.campaigns_reactivated || 0} campanhas reativadas, ${data.decisions_created || 0} decisões criadas.` });
        await load();
        await loadAiDecisions();
      } else {
        setMsg({ type: 'error', text: data?.message || data?.error || 'Erro na recuperação.' });
      }
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setRunningRecovery(false);
      setTimeout(() => setMsg(null), 8000);
    }
  };

  const saveCap = async () => {
    if (!account || !newCapValue) return;
    const val = parseFloat(newCapValue);
    if (isNaN(val) || val <= 0) return;
    setSaving(true);
    setMsg(null);
    try {
      const res = await base44.functions.invoke('updateDailySpendCap', {
        amazon_account_id: account.id,
        new_cap: val,
      });
      const data = res?.data || res;
      if (!data?.ok) {
        setMsg({ type: 'error', text: data?.error || 'Erro ao salvar teto' });
        return;
      }

      // Aplicar patch no state local — sem reload completo
      setController(prev => ({
        ...(prev || {}),
        user_daily_spend_cap: data.new_cap,
        effective_daily_spend_cap: data.new_cap,
        confirmed_spend: data.confirmed_spend,
        estimated_pending_spend: data.estimated_pending_spend,
        projected_total_spend: data.projected_total_spend,
        remaining_spend: data.remaining_spend,
        cap_status: data.cap_status,
      }));

      setEditingCap(false);
      setMsg({
        type: 'success',
        text: `Teto atualizado para ${fmtBRL(data.new_cap)} · Saldo: ${fmtBRL(data.remaining_spend)} · Status: ${data.cap_status}`,
      });
      setTimeout(() => setMsg(null), 6000);
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-6 animate-pulse">
      <div className="h-4 w-48 bg-surface-3 rounded mb-4" />
      <div className="grid grid-cols-3 gap-4">{[1,2,3].map(i => <div key={i} className="h-16 bg-surface-2 rounded-lg" />)}</div>
    </div>
  );

  const c = controller;
  const cap = c?.effective_daily_spend_cap || c?.user_daily_spend_cap || 70;
  const confirmed = c?.confirmed_spend || 0;
  const estimated = c?.estimated_pending_spend || 0;
  const projected = c?.projected_total_spend || 0;
  const remaining = c?.remaining_spend ?? (cap - projected);
  const capStatus = c?.cap_status || 'safe';
  const pacing = c?.spend_pacing || 'unknown';
  const nominalBudget = c?.total_campaign_budget_nominal || 0;
  const capCfg = CAP_STATUS_CONFIG[capStatus] || CAP_STATUS_CONFIG.safe;
  const pacingCfg = PACING_CONFIG[pacing] || PACING_CONFIG.unknown;
  const PacingIcon = pacingCfg.Icon;

  return (
    <div className="space-y-4">
      {msg && (
        <div className={`px-4 py-3 rounded-xl border text-xs font-medium ${msg.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300' : 'bg-red-500/10 border-red-500/20 text-red-400'}`}>
          {msg.text}
        </div>
      )}

      {/* ── 0. KILL SWITCH ATIVO ─────────────────────────────────────────────── */}
      {c?.global_kill_switch && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
              <p className="text-sm font-bold text-red-300">⚡ Kill Switch Ativo — Campanhas Pausadas</p>
            </div>
            <button
              onClick={runRecovery}
              disabled={runningRecovery}
              className="flex items-center gap-2 px-3 py-1.5 bg-violet-500/15 border border-violet-500/30 text-violet-300 text-xs font-semibold rounded-lg hover:bg-violet-500/25 transition-colors disabled:opacity-50"
            >
              {runningRecovery ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Brain className="w-3.5 h-3.5" />}
              {runningRecovery ? 'IA analisando...' : 'Redistribuir com IA'}
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-[10px]">
            <div className="bg-surface-2/60 rounded-lg p-2">
              <p className="text-slate-500 mb-0.5">Acionado às</p>
              <p className="font-bold text-red-300">
                {c.kill_switch_activated_at
                  ? new Date(c.kill_switch_activated_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + ' BRT'
                  : '—'}
              </p>
            </div>
            <div className="bg-surface-2/60 rounded-lg p-2">
              <p className="text-slate-500 mb-0.5">Horas restantes</p>
              <p className="font-bold text-amber-300">
                {c.kill_switch_activated_at
                  ? `${Math.max(0, 23 - ((new Date(c.kill_switch_activated_at).getUTCHours() - 3 + 24) % 24))}h`
                  : '—'}
              </p>
            </div>
            <div className="bg-surface-2/60 rounded-lg p-2">
              <p className="text-slate-500 mb-0.5">Campanhas pausadas</p>
              <p className="font-bold text-red-300">{c.campaigns_paused_count || (c.campaigns_paused_today?.length || 0)}</p>
            </div>
          </div>

          {runningRecovery && (
            <div className="flex items-center gap-2 px-3 py-2 bg-violet-500/10 border border-violet-500/20 rounded-lg">
              <Loader2 className="w-3.5 h-3.5 text-violet-400 animate-spin" />
              <p className="text-xs text-violet-300">IA analisando padrão horário e redistribuindo lances...</p>
            </div>
          )}

          {recoveryResult?.ok && (
            <div className="px-3 py-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg space-y-1">
              <p className="text-xs font-semibold text-emerald-300">✓ Recuperação concluída pela IA</p>
              {recoveryResult.ai_summary && <p className="text-[10px] text-slate-300">{recoveryResult.ai_summary}</p>}
              {recoveryResult.ai_forecast_hours && (
                <p className="text-[10px] text-slate-400">Previsão de cobertura: {recoveryResult.ai_forecast_hours}h</p>
              )}
            </div>
          )}

          {aiDecisions.length > 0 && (
            <div>
              <button
                onClick={() => setShowDecisions(v => !v)}
                className="flex items-center gap-1.5 text-[10px] text-violet-400 hover:text-violet-300 transition-colors"
              >
                <ExternalLink className="w-3 h-3" />
                Ver {aiDecisions.length} decisão(ões) de lance da IA
                {showDecisions ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>
              {showDecisions && (
                <div className="mt-2 space-y-1.5">
                  {aiDecisions.map(d => (
                    <div key={d.id} className="flex items-start gap-2 px-3 py-2 bg-surface-2/60 rounded-lg">
                      <div className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${d.status === 'approved' ? 'bg-emerald-400' : d.status === 'executed' ? 'bg-cyan' : 'bg-amber-400'}`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-[10px] font-mono text-slate-400 truncate">{d.campaign_id}</p>
                        <p className="text-[10px] text-slate-300 mt-0.5 line-clamp-2">{d.rationale?.slice(0, 120)}</p>
                      </div>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-semibold flex-shrink-0 ${d.status === 'approved' ? 'bg-emerald-500/20 text-emerald-300' : d.status === 'executed' ? 'bg-cyan/20 text-cyan' : 'bg-amber-500/20 text-amber-300'}`}>
                        {d.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── 0b. RECUPERAÇÃO CONCLUÍDA HOJE ───────────────────────────────────── */}
      {!c?.global_kill_switch && c?.kill_switch_activated_at && c?.kill_switch_reason?.includes('IA redistribuiu') && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-emerald-500/8 border border-emerald-500/20 rounded-xl">
          <RotateCcw className="w-4 h-4 text-emerald-400 flex-shrink-0" />
          <p className="text-[10px] text-emerald-300 flex-1">{c.kill_switch_reason}</p>
        </div>
      )}

      {/* ── 1. LIMITE DA CONTA ────────────────────────────────────────────────── */}
      <div className={`border rounded-xl p-4 ${capCfg.bg}`}>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-slate-400" />
            <p className="text-xs font-bold text-slate-200">Limite Diário da Conta</p>
            <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold ${capCfg.bg} ${capCfg.color}`}>
              {capCfg.label}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={refresh} disabled={refreshing}
              className="p-1.5 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors disabled:opacity-50">
              {refreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            </button>
            {!editingCap ? (
              <button onClick={() => { setNewCapValue(String(cap)); setEditingCap(true); }}
                className="text-[10px] px-2.5 py-1 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors">
                Editar Teto
              </button>
            ) : (
              <div className="flex items-center gap-1.5">
                <input type="number" value={newCapValue} onChange={e => setNewCapValue(e.target.value)}
                  className="w-20 px-2 py-1 bg-surface-2 border border-cyan/40 rounded-lg text-xs text-white focus:outline-none"
                  min="10" max="5000" step="5" />
                <button onClick={saveCap} disabled={saving}
                  className="text-[10px] px-2.5 py-1 bg-cyan/20 border border-cyan/30 text-cyan rounded-lg font-semibold disabled:opacity-50">
                  {saving ? '...' : 'Salvar'}
                </button>
                <button onClick={() => setEditingCap(false)} className="text-[10px] px-2 py-1 bg-surface-2 border border-surface-3 text-slate-400 rounded-lg">✕</button>
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
          <div className="bg-surface-1/60 rounded-lg p-3">
            <p className="text-[9px] text-slate-500 mb-0.5 uppercase">Teto do Usuário</p>
            <p className="text-xl font-bold text-white">{fmtBRL(cap)}</p>
            <p className="text-[9px] text-cyan mt-0.5">definido por você</p>
          </div>
          <div className="bg-surface-1/60 rounded-lg p-3">
            <p className="text-[9px] text-slate-500 mb-0.5 uppercase">Confirmado</p>
            <p className="text-xl font-bold text-cyan">{fmtBRL(confirmed)}</p>
            <p className="text-[9px] text-slate-600 mt-0.5">{cap > 0 ? Math.round(confirmed/cap*100) : 0}% do teto</p>
          </div>
          <div className="bg-surface-1/60 rounded-lg p-3">
            <p className="text-[9px] text-slate-500 mb-0.5 uppercase">Projetado Total</p>
            <p className={`text-xl font-bold ${projected > cap ? 'text-red-400' : 'text-amber-400'}`}>{fmtBRL(projected)}</p>
            <p className="text-[9px] text-slate-600 mt-0.5">conf. + estimado</p>
          </div>
          <div className="bg-surface-1/60 rounded-lg p-3">
            <p className="text-[9px] text-slate-500 mb-0.5 uppercase">Saldo</p>
            <p className={`text-xl font-bold ${remaining < 0 ? 'text-red-400' : remaining < cap * 0.1 ? 'text-amber-400' : 'text-emerald-400'}`}>{fmtBRL(remaining)}</p>
            <p className="text-[9px] text-slate-600 mt-0.5">disponível</p>
          </div>
          <div className="bg-surface-1/60 rounded-lg p-3 flex flex-col items-center justify-center">
            <PacingIcon className={`w-5 h-5 ${pacingCfg.color} mb-1`} />
            <p className={`text-xs font-bold ${pacingCfg.color}`}>{pacingCfg.label}</p>
            {c?.pacing_ratio > 0 && <p className="text-[9px] text-slate-500 mt-0.5">ratio: {c.pacing_ratio}x</p>}
          </div>
        </div>

        <SpendBar confirmed={confirmed} estimated={estimated} cap={cap} />

        {pacingCfg.desc && (
          <p className={`text-[10px] mt-2 ${pacingCfg.color}`}>{pacingCfg.desc}</p>
        )}

        <div className="flex items-center gap-3 mt-2 text-[9px] text-slate-600">
          <Clock className="w-3 h-3" />
          <span>Hora BRT: {c?.current_hour_brt != null ? `${String(c.current_hour_brt).padStart(2,'0')}:xx` : '—'}</span>
          <span>·</span>
          <span>Reset: meia-noite BRT</span>
          {c?.spend_date ? <><span>·</span><span>Data: {c.spend_date}</span></> : null}
        </div>
      </div>

      {/* ── 2. BUDGETS DE CAMPANHA ─────────────────────────────────────────────── */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <BarChart2 className="w-4 h-4 text-slate-400" />
          <p className="text-xs font-bold text-slate-200">Budgets das Campanhas</p>
          <span className="ml-auto text-[10px] text-slate-500">soma nominal — independente do teto</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-3">
          <div className="bg-surface-2 rounded-lg p-3">
            <p className="text-[9px] text-slate-500 mb-0.5">Soma Nominal</p>
            <p className="text-lg font-bold text-white">{fmtBRL(nominalBudget)}</p>
            {nominalBudget > cap && cap > 0 && (
              <p className="text-[9px] text-violet-400 mt-0.5">+{fmtBRL(nominalBudget - cap)} acima do teto ✓</p>
            )}
          </div>
          <div className="bg-surface-2 rounded-lg p-3">
            <p className="text-[9px] text-slate-500 mb-0.5">Limitadas por Budget</p>
            <p className={`text-lg font-bold ${(c?.campaigns_budget_limited_count || 0) > 0 ? 'text-amber-400' : 'text-slate-400'}`}>
              {c?.campaigns_budget_limited_count ?? '—'}
            </p>
            <p className="text-[9px] text-slate-600 mt-0.5">≥90% do budget gasto</p>
          </div>
          <div className="bg-surface-2 rounded-lg p-3">
            <p className="text-[9px] text-slate-500 mb-0.5">Pausadas pelo Teto</p>
            <p className={`text-lg font-bold ${(c?.campaigns_paused_count || 0) > 0 ? 'text-red-400' : 'text-slate-400'}`}>
              {c?.campaigns_paused_count ?? 0}
            </p>
            <p className="text-[9px] text-slate-600 mt-0.5">hoje</p>
          </div>
        </div>

        <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-violet-500/5 border border-violet-500/15">
          <Info className="w-3.5 h-3.5 text-violet-400 flex-shrink-0 mt-0.5" />
          <p className="text-[10px] text-violet-300">
            A soma dos budgets das campanhas pode ser superior ao teto diário — isso é permitido e esperado.
            Os budgets representam a capacidade de entrega de cada campanha.
            O LivingFinds controla o gasto acumulado real da conta, não a soma nominal.
          </p>
        </div>
      </div>

      {/* ── 3. SUGESTÃO DA IA ────────────────────────────────────────────────── */}
      {c?.ai_suggested_daily_spend_cap > 0 && (
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
          <button onClick={() => setShowAiDetails(v => !v)}
            className="w-full flex items-center justify-between">
            <div className="flex items-center gap-2 flex-wrap">
              <Brain className="w-4 h-4 text-violet-400" />
              <p className="text-xs font-bold text-slate-200">Sugestão da IA</p>
              <span className="text-[10px] px-2 py-0.5 bg-violet-500/10 border border-violet-500/20 text-violet-400 rounded-full">
                {fmtBRL(c.ai_suggested_daily_spend_cap)} sugerido
              </span>
              <span className="text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-full">
                Apenas recomendação
              </span>
            </div>
            {showAiDetails ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
          </button>

          {showAiDetails && (
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-[10px]">
                <div className="bg-surface-2 rounded p-2">
                  <p className="text-slate-500 mb-0.5">Valor Sugerido</p>
                  <p className="font-bold text-violet-300">{fmtBRL(c.ai_suggested_daily_spend_cap)}</p>
                </div>
                <div className="bg-surface-2 rounded p-2">
                  <p className="text-slate-500 mb-0.5">Confiança</p>
                  <p className="font-bold text-slate-200">{c.ai_suggestion_confidence ? `${Math.round(c.ai_suggestion_confidence * 100)}%` : '—'}</p>
                </div>
                <div className="bg-surface-2 rounded p-2">
                  <p className="text-slate-500 mb-0.5">Gerado em</p>
                  <p className="font-bold text-slate-200">
                    {c.ai_suggestion_generated_at ? new Date(c.ai_suggestion_generated_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                  </p>
                </div>
              </div>
              {c.ai_suggestion_reason && (
                <div className="bg-surface-2 rounded-lg p-3">
                  <p className="text-[10px] text-slate-400 mb-1 font-semibold">Justificativa:</p>
                  <p className="text-[10px] text-slate-300 leading-relaxed">{c.ai_suggestion_reason}</p>
                </div>
              )}
              <p className="text-[10px] text-amber-400">
                ⚠ O teto real continua sendo {fmtBRL(cap)} (definido por você). A IA não altera automaticamente o teto.
                Para aceitar a sugestão, clique em "Editar Teto" e insira o novo valor manualmente.
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── 4. FAIXAS DE CONTROLE ────────────────────────────────────────────── */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <Gauge className="w-4 h-4 text-slate-400" />
          <p className="text-xs font-semibold text-slate-300">Faixas de Controle</p>
        </div>
        <div className="space-y-1.5">
          {[
            { range: '< 70%',   status: 'safe',         action: 'Operação normal. Crescimento e descoberta permitidos.' },
            { range: '70–85%',  status: 'attention',    action: 'Evitar expansão de baixa prioridade. Preservar campanhas fortes.' },
            { range: '85–95%',  status: 'critical',     action: 'Suspender novas campanhas. Limitar aumentos. Reduzir descoberta.' },
            { range: '95–100%', status: 'cap_imminent', action: 'Reservar saldo para vencedores. Preparar pausa.' },
            { range: '≥ 100%',  status: 'cap_reached',  action: 'Pausar campanhas por prioridade: sem venda > descoberta > auto ineficiente > manual teste > vencedores por último.' },
          ].map(r => {
            const cfg = CAP_STATUS_CONFIG[r.status];
            const active = capStatus === r.status;
            return (
              <div key={r.status} className={`flex items-start gap-3 px-3 py-2 rounded-lg transition-colors ${active ? `${cfg.bg} border` : 'bg-surface-2'}`}>
                <span className={`text-[10px] font-bold w-16 flex-shrink-0 ${active ? cfg.color : 'text-slate-500'}`}>{r.range}</span>
                <span className={`text-[10px] font-semibold w-24 flex-shrink-0 ${active ? cfg.color : 'text-slate-500'}`}>{cfg.label}</span>
                <span className={`text-[10px] flex-1 ${active ? 'text-slate-200' : 'text-slate-600'}`}>{r.action}</span>
                {active && <span className="ml-auto text-[9px] font-bold text-white bg-surface-3 px-1.5 py-0.5 rounded flex-shrink-0">ATUAL</span>}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── 5. CAMPANHAS PAUSADAS HOJE — status detalhado ────────────────────── */}
      <KillSwitchPauseDetail controller={c} />

      {/* ── 6. CHECKPOINTS DO DIA ────────────────────────────────────────────── */}
      <BudgetCheckpointsPanel account={account} />

      {/* ── 7. OTIMIZAÇÃO PROATIVA DE BUDGET ────────────────────────────────── */}
      <ProactiveBudgetOptimizerCard account={account} />

      {/* Sem dados hoje */}
      {!c && !loading && (
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-6 text-center">
          <DollarSign className="w-7 h-7 text-slate-600 mx-auto mb-2" />
          <p className="text-sm text-slate-400">Nenhum dado de gasto para hoje ainda.</p>
          <button onClick={refresh} disabled={refreshing}
            className="mt-3 flex items-center gap-2 px-4 py-2 bg-surface-2 border border-surface-3 text-slate-300 text-xs font-semibold rounded-lg mx-auto disabled:opacity-50">
            {refreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Inicializar controlador
          </button>
        </div>
      )}
    </div>
  );
}