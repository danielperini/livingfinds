/**
 * BudgetConfigPanel — Painel de Configuração do Motor de Orçamento v2
 * Exibe e permite editar a BudgetConfiguration.
 * Mostra memória do cálculo, limite calculado, e botão "Recalcular".
 * 100% determinístico — sem IA.
 */
import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import {
  DollarSign, Calculator, RefreshCw, ChevronDown, ChevronUp,
  CheckCircle, AlertTriangle, Loader2, Save, Info
} from 'lucide-react';

const FLOOR   = 50;
const CEILING = 130;

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="block text-xs text-slate-400 mb-1">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-slate-600 mt-0.5">{hint}</p>}
    </div>
  );
}

function NumInput({ value, onChange, min, max, step = 1 }) {
  return (
    <input
      type="number" min={min} max={max} step={step} value={value}
      onChange={e => onChange(parseFloat(e.target.value) || 0)}
      className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50"
    />
  );
}

export default function BudgetConfigPanel({ accountId }) {
  const [cfg, setCfg]           = useState(null);
  const [form, setForm]         = useState(null);
  const [result, setResult]     = useState(null);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [running, setRunning]   = useState(false);
  const [showCalc, setShowCalc] = useState(false);
  const [saved, setSaved]       = useState(false);
  const [error, setError]       = useState(null);

  useEffect(() => { if (accountId) load(); }, [accountId]);

  async function load() {
    setLoading(true);
    try {
      const rows = await base44.entities.BudgetConfiguration.filter({ amazon_account_id: accountId });
      const c = rows[0] || null;
      setCfg(c);
      if (c) setForm({
        daily_budget_floor:       c.daily_budget_floor       ?? FLOOR,
        daily_budget_ceiling:     c.daily_budget_ceiling     ?? CEILING,
        weekly_campaign_capacity: c.weekly_campaign_capacity ?? 10,
        target_coverage_hours:    c.target_coverage_hours    ?? 24,
        campaign_weight:          c.campaign_weight          ?? 2,
        hours_weight:             c.hours_weight             ?? 1,
        primary_goal:             c.primary_goal             ?? 'acos',
        target_acos:              c.target_acos              ?? 25,
        target_tacos:             c.target_tacos             ?? 10,
        target_roas:              c.target_roas              ?? 4,
        target_cpc:               c.target_cpc               ?? 0,
        target_cost_per_order:    c.target_cost_per_order    ?? 0,
        minimum_campaign_budget:  c.minimum_campaign_budget  ?? 15,
        campaign_budget_increment: c.campaign_budget_increment ?? 5,
      });
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  async function saveConfig() {
    if (!form || !accountId) return;
    setSaving(true);
    try {
      if (cfg) {
        await base44.entities.BudgetConfiguration.update(cfg.id, { ...form, updated_at: new Date().toISOString() });
      } else {
        const created = await base44.entities.BudgetConfiguration.create({ amazon_account_id: accountId, ...form });
        setCfg(created);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      await load();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  async function recalculate(apply = false) {
    setRunning(true);
    setResult(null);
    setError(null);
    try {
      const res = await base44.functions.invoke('calculateDailyBudgetAllocation', {
        amazon_account_id: accountId,
        dry_run: !apply,
        trigger: apply ? 'manual_apply' : 'manual_preview',
        force: true,
      });
      setResult(res.data);
      if (apply) await load();
    } catch (e) { setError(e.message); }
    finally { setRunning(false); }
  }

  if (loading) return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-6 animate-pulse">
      <div className="h-4 w-48 bg-surface-3 rounded mb-4" />
      <div className="grid grid-cols-3 gap-4">{[1,2,3].map(i => <div key={i} className="h-20 bg-surface-2 rounded-lg" />)}</div>
    </div>
  );

  if (!form) return null;

  // Cálculo ao vivo para preview
  const campaignFactor   = Math.min(1, Math.max(0, (cfg?.eligible_campaign_count ?? 0) / Math.max(1, form.weekly_campaign_capacity)));
  const hoursFactor      = Math.min(1, Math.max(0, form.target_coverage_hours / 24));
  const totalW           = form.campaign_weight + form.hours_weight;
  const utilizationScore = ((campaignFactor * form.campaign_weight) + (hoursFactor * form.hours_weight)) / totalW;
  const liveLimit        = Math.round(Math.min(form.daily_budget_ceiling, Math.max(form.daily_budget_floor,
    form.daily_budget_floor + (form.daily_budget_ceiling - form.daily_budget_floor) * utilizationScore
  )) * 100) / 100;

  const savedLimit = cfg?.calculated_daily_budget || 0;

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-surface-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Calculator className="w-4 h-4 text-cyan" />
          <h3 className="text-sm font-semibold text-slate-300">Motor de Orçamento Diário v2</h3>
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 font-semibold">SEM IA</span>
        </div>
        <div className="flex gap-2">
          <button onClick={() => recalculate(false)} disabled={running || !accountId}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-surface-2 border border-surface-3 text-slate-300 hover:text-white rounded-lg transition-colors disabled:opacity-50">
            <RefreshCw className={`w-3 h-3 ${running ? 'animate-spin' : ''}`} />
            Simular
          </button>
          <button onClick={() => recalculate(true)} disabled={running || !accountId}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-cyan/20 border border-cyan/30 text-cyan hover:bg-cyan/30 rounded-lg transition-colors disabled:opacity-50">
            <DollarSign className="w-3 h-3" />
            Recalcular limite diário
          </button>
        </div>
      </div>

      {/* KPIs principais */}
      <div className="p-5 grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-surface-2 rounded-lg p-3">
          <p className="text-[10px] text-slate-400 mb-1">Limite Mínimo Geral</p>
          <p className="text-xl font-bold text-emerald-400">R${form.daily_budget_floor.toFixed(2)}</p>
          <p className="text-[10px] text-slate-500">0% da faixa</p>
        </div>
        <div className="bg-surface-2 rounded-lg p-3">
          <p className="text-[10px] text-slate-400 mb-1">Limite Máximo Geral</p>
          <p className="text-xl font-bold text-amber-400">R${form.daily_budget_ceiling.toFixed(2)}</p>
          <p className="text-[10px] text-slate-500">100% da faixa</p>
        </div>
        <div className="bg-cyan/5 border border-cyan/20 rounded-lg p-3">
          <p className="text-[10px] text-cyan mb-1">Limite Calculado Hoje</p>
          <p className="text-xl font-bold text-white">R${(savedLimit || liveLimit).toFixed(2)}</p>
          <p className="text-[10px] text-slate-500">
            {savedLimit ? 'último recálculo' : 'prévia ao vivo'}
          </p>
        </div>
        <div className="bg-surface-2 rounded-lg p-3">
          <p className="text-[10px] text-slate-400 mb-1">Campanhas Elegíveis</p>
          <p className="text-xl font-bold text-white">{cfg?.eligible_campaign_count ?? '—'}</p>
          <p className="text-[10px] text-slate-500">de {form.weekly_campaign_capacity} capacidade</p>
        </div>
      </div>

      {/* Memória do cálculo ao vivo */}
      <div className="px-5 pb-3">
        <button onClick={() => setShowCalc(v => !v)}
          className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300 transition-colors">
          {showCalc ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          Memória do cálculo
        </button>
        {showCalc && (
          <div className="mt-2 p-3 bg-surface-2 rounded-lg text-[11px] font-mono space-y-1 text-slate-400">
            <p>campaign_factor = {cfg?.eligible_campaign_count ?? 0} / {form.weekly_campaign_capacity} = <span className="text-cyan">{campaignFactor.toFixed(4)}</span></p>
            <p>hours_factor    = {form.target_coverage_hours} / 24 = <span className="text-cyan">{hoursFactor.toFixed(4)}</span></p>
            <p>utilization     = (({campaignFactor.toFixed(2)}×{form.campaign_weight}) + ({hoursFactor.toFixed(2)}×{form.hours_weight})) / {totalW} = <span className="text-amber-400">{utilizationScore.toFixed(4)}</span></p>
            <p>daily_limit     = {form.daily_budget_floor} + ({form.daily_budget_ceiling - form.daily_budget_floor} × {utilizationScore.toFixed(4)}) = <span className="text-emerald-400 font-bold">R${liveLimit.toFixed(2)}</span></p>
            <p className="text-slate-600">Faixa: R${form.daily_budget_floor} — R${form.daily_budget_ceiling} • Faixa variável: R${form.daily_budget_ceiling - form.daily_budget_floor}</p>
          </div>
        )}
      </div>

      {/* Formulário de configuração */}
      <div className="border-t border-surface-2 px-5 py-5 space-y-5">
        <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Parâmetros de Cálculo</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Field label="Capacidade Semanal" hint="Campanhas previstas na semana">
            <NumInput value={form.weekly_campaign_capacity} min={1} max={100} onChange={v => setForm(p => ({ ...p, weekly_campaign_capacity: v }))} />
          </Field>
          <Field label="Horas de Cobertura" hint="1–24h. Meta: 24 = dia inteiro">
            <NumInput value={form.target_coverage_hours} min={1} max={24} onChange={v => setForm(p => ({ ...p, target_coverage_hours: v }))} />
          </Field>
          <Field label="Peso Campanhas" hint="Padrão: 2 (maior influência)">
            <NumInput value={form.campaign_weight} min={1} max={10} onChange={v => setForm(p => ({ ...p, campaign_weight: v }))} />
          </Field>
          <Field label="Peso Horas" hint="Padrão: 1">
            <NumInput value={form.hours_weight} min={1} max={10} onChange={v => setForm(p => ({ ...p, hours_weight: v }))} />
          </Field>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Field label="Limite Mínimo (R$)" hint="Floor do limite geral">
            <NumInput value={form.daily_budget_floor} min={10} max={500} step={5} onChange={v => setForm(p => ({ ...p, daily_budget_floor: v }))} />
          </Field>
          <Field label="Limite Máximo (R$)" hint="Ceiling do limite geral">
            <NumInput value={form.daily_budget_ceiling} min={50} max={2000} step={5} onChange={v => setForm(p => ({ ...p, daily_budget_ceiling: v }))} />
          </Field>
          <Field label="Budget Mín./Campanha (R$)" hint="Toda nova campanha: R$15">
            <NumInput value={form.minimum_campaign_budget} min={5} max={100} step={1} onChange={v => setForm(p => ({ ...p, minimum_campaign_budget: v }))} />
          </Field>
          <Field label="Incremento (R$)" hint="+R$5 por dia quando elegível">
            <NumInput value={form.campaign_budget_increment} min={1} max={50} step={1} onChange={v => setForm(p => ({ ...p, campaign_budget_increment: v }))} />
          </Field>
        </div>

        <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Meta Principal & Metas de Eficiência</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Meta Principal" hint="Define o critério de aumento de budget">
            <select value={form.primary_goal} onChange={e => setForm(p => ({ ...p, primary_goal: e.target.value }))}
              className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50">
              <option value="acos">ACoS</option>
              <option value="tacos">TACoS</option>
              <option value="roas">ROAS</option>
              <option value="cpc">CPC</option>
              <option value="cost_per_order">Custo por Pedido</option>
              <option value="budget_duration">Duração do Budget (24h)</option>
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
          <Field label="ACoS Alvo (%)" hint="">
            <NumInput value={form.target_acos} min={1} max={200} step={0.5} onChange={v => setForm(p => ({ ...p, target_acos: v }))} />
          </Field>
          <Field label="TACoS Alvo (%)" hint="">
            <NumInput value={form.target_tacos} min={1} max={100} step={0.5} onChange={v => setForm(p => ({ ...p, target_tacos: v }))} />
          </Field>
          <Field label="ROAS Alvo (x)" hint="">
            <NumInput value={form.target_roas} min={0.1} max={50} step={0.1} onChange={v => setForm(p => ({ ...p, target_roas: v }))} />
          </Field>
          <Field label="CPC Máximo (R$)" hint="0 = sem limite">
            <NumInput value={form.target_cpc} min={0} max={50} step={0.01} onChange={v => setForm(p => ({ ...p, target_cpc: v }))} />
          </Field>
          <Field label="Custo/Pedido Máx. (R$)" hint="0 = sem limite">
            <NumInput value={form.target_cost_per_order} min={0} max={500} step={1} onChange={v => setForm(p => ({ ...p, target_cost_per_order: v }))} />
          </Field>
        </div>

        {/* Próximo recálculo semanal */}
        {cfg?.next_weekly_recalculation && (
          <div className="flex items-center gap-2 p-3 bg-surface-2 rounded-lg text-xs text-slate-400">
            <Info className="w-3.5 h-3.5 flex-shrink-0" />
            Próximo recálculo semanal (segunda-feira):
            <span className="text-white font-semibold ml-1">
              {new Date(cfg.next_weekly_recalculation).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        )}

        {/* Avisos importantes */}
        <div className="p-3 bg-amber-500/5 border border-amber-500/20 rounded-lg text-[10px] text-amber-300 space-y-1">
          <p className="font-semibold">⚠️ Regras de aumento de budget individual (+R${form.campaign_budget_increment}):</p>
          <p>✓ Budget esgotado (≥95% gasto) + ✓ pelo menos 1 venda + ✓ dentro da meta + ✓ limite geral permite</p>
          <p>✗ Budget esgotado sem venda → mantém budget + registra "esgotado sem conversão"</p>
          <p className="text-slate-500 mt-1">Máximo 1 aumento de R${form.campaign_budget_increment} por campanha por dia. O limite geral ({`R$${form.daily_budget_floor}–R$${form.daily_budget_ceiling}`}) nunca é a soma dos budgets individuais.</p>
        </div>

        {error && (
          <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
            {error}
          </div>
        )}

        <button onClick={saveConfig} disabled={saving}
          className="flex items-center gap-2 px-5 py-2.5 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <CheckCircle className="w-4 h-4" /> : <Save className="w-4 h-4" />}
          {saving ? 'Salvando...' : saved ? 'Salvo!' : 'Salvar Configurações de Budget'}
        </button>
      </div>

      {/* Resultado da simulação/aplicação */}
      {result && (
        <div className="border-t border-surface-2 px-5 py-4">
          <div className={`p-3 rounded-lg border text-xs mb-3 ${result.ok ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300' : 'bg-red-500/10 border-red-500/20 text-red-400'}`}>
            {result.ok
              ? `✓ Limite calculado: R$${result.daily_limit?.toFixed(2)} • ${result.eligible_campaigns} campanhas elegíveis • ${result.campaigns_increased} receberam +R$${result.budget_increment}`
              : `✗ ${result.error}`}
          </div>
          {result.ok && result.calculation && (
            <div className="p-3 bg-surface-2 rounded-lg text-[10px] font-mono text-slate-400 space-y-0.5">
              <p className="text-slate-300 font-semibold mb-1">Memória do cálculo (servidor):</p>
              <p>{result.calculation.formula}</p>
              <p>campaign_factor = {result.calculation.campaign_factor} | hours_factor = {result.calculation.hours_factor} | utilization = {result.calculation.utilization_score}</p>
              <p>Faixa variável: R${result.calculation.range_span} | Resultado: R$<strong className="text-emerald-400">{result.calculation.daily_limit}</strong></p>
            </div>
          )}
          {result.ok && result.allocations?.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-surface-2">
                    {['Campanha', 'Atual', 'Sugerido', 'Δ', 'Ação', 'Motivo', 'Spend D-1', 'Pedidos D-1', 'ACoS 30d'].map(h => (
                      <th key={h} className="px-2 py-2 text-left text-[10px] text-slate-500 uppercase whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.allocations.slice(0, 20).map((a, i) => (
                    <tr key={i} className="border-b border-surface-2/50 hover:bg-surface-2/40">
                      <td className="px-2 py-1.5 text-white truncate max-w-[160px]">{a.campaign_name || '—'}</td>
                      <td className="px-2 py-1.5 text-slate-300">R${(a.current_budget || 0).toFixed(2)}</td>
                      <td className={`px-2 py-1.5 font-semibold ${a.action === 'aumentar' ? 'text-emerald-400' : 'text-slate-300'}`}>R${(a.suggested_budget || 0).toFixed(2)}</td>
                      <td className={`px-2 py-1.5 font-semibold ${(a.budget_change || 0) > 0 ? 'text-emerald-400' : 'text-slate-500'}`}>
                        {(a.budget_change || 0) > 0 ? `+R$${a.budget_change.toFixed(2)}` : '—'}
                      </td>
                      <td className="px-2 py-1.5">
                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold ${
                          a.action === 'aumentar' ? 'bg-emerald-500/15 text-emerald-400'
                          : 'bg-surface-3 text-slate-500'
                        }`}>{a.action}</span>
                      </td>
                      <td className="px-2 py-1.5 text-slate-500 text-[10px] max-w-[140px] truncate" title={a.reason}>{a.reason}</td>
                      <td className="px-2 py-1.5 text-slate-300">R${(a.yesterday_spend || 0).toFixed(2)}</td>
                      <td className="px-2 py-1.5 text-slate-300">{a.yesterday_orders || 0}</td>
                      <td className={`px-2 py-1.5 text-[10px] font-semibold ${(a.acos_30d || 0) > 0 && (a.acos_30d || 0) <= 25 ? 'text-emerald-400' : (a.acos_30d || 0) > 0 ? 'text-amber-400' : 'text-slate-500'}`}>
                        {(a.acos_30d || 0) > 0 ? `${a.acos_30d}%` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {result.allocations.length > 20 && (
                <p className="text-[10px] text-slate-500 mt-2 px-2">+{result.allocations.length - 20} campanhas omitidas</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}