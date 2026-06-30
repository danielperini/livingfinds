import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Settings, Save, Loader2, CheckCircle, AlertTriangle, Brain, Target, Shield, Clock, BarChart2, Zap } from 'lucide-react';

const DEFAULTS = {
  operation_mode: 'manual',
  objective: 'acos_target',
  acos_target: 25,
  roas_target: 4,
  tacos_target: 15,
  safety_margin: 5,
  bid_min: 0.10,
  bid_max: 5.00,
  bid_change_min: 0.05,
  bid_increase_max_pct: 15,
  bid_decrease_max_pct: 20,
  cooldown_hours: 72,
  analysis_window_days: 14,
  min_clicks: 10,
  min_orders: 1,
  maturity_provisional_days: 1,
  maturity_attribution_days: 3,
  maturity_mature_days: 7,
  min_confidence: 0.45,
  auto_negate: false,
  auto_migrate: false,
  auto_create_campaigns: false,
  daily_budget_limit: 100,
  monthly_budget_limit: 3000,
  budget_per_asin_max: 20,
  acos_neutral_lower: 22,
  acos_neutral_upper: 28,
  smoothing_factor: 0.25,
};

const MODE_OPTIONS = [
  { key: 'manual', label: 'Manual', desc: 'Toda ação exige aprovação humana', color: 'text-slate-400', icon: Shield },
  { key: 'semi_auto', label: 'Semiautomático', desc: 'Reduções pequenas são automáticas; aumentos e criações exigem aprovação', color: 'text-amber-400', icon: Brain },
  { key: 'auto_controlled', label: 'Automático Controlado', desc: 'Executa ações de alta confiança dentro dos limites configurados', color: 'text-cyan', icon: Zap },
];

const OBJECTIVE_OPTIONS = [
  { key: 'acos_target', label: 'ACoS Alvo' },
  { key: 'roas_target', label: 'ROAS Alvo' },
  { key: 'tacos_target', label: 'TACoS Alvo' },
  { key: 'maximize_sales', label: 'Maximizar Vendas' },
  { key: 'maximize_profit', label: 'Maximizar Lucro' },
  { key: 'launch', label: 'Lançamento de Produto' },
  { key: 'brand_protection', label: 'Proteção de Marca' },
  { key: 'visibility', label: 'Ganhar Visibilidade' },
  { key: 'organic_growth', label: 'Crescimento Orgânico' },
];

function Section({ title, icon: Icon, children }) {
  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
      <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
        <Icon className="w-4 h-4 text-cyan" /> {title}
      </h3>
      {children}
    </div>
  );
}

function NumField({ label, field, form, setForm, min, max, step = 0.01, prefix = '', suffix = '' }) {
  return (
    <div>
      <label className="block text-xs text-slate-400 mb-1.5">{label}</label>
      <div className="flex items-center gap-1">
        {prefix && <span className="text-xs text-slate-500">{prefix}</span>}
        <input type="number" value={form[field]} min={min} max={max} step={step}
          onChange={e => setForm(p => ({ ...p, [field]: parseFloat(e.target.value) || 0 }))}
          className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50" />
        {suffix && <span className="text-xs text-slate-500">{suffix}</span>}
      </div>
    </div>
  );
}

function Toggle({ label, desc, field, form, setForm, warning }) {
  return (
    <div className="flex items-start justify-between p-4 bg-surface-2 rounded-lg border border-surface-3">
      <div className="flex-1 min-w-0 pr-4">
        <p className="text-sm font-medium text-white">{label}</p>
        {desc && <p className="text-xs text-slate-500 mt-0.5">{desc}</p>}
        {warning && form[field] && (
          <div className="flex items-center gap-1.5 mt-2 text-xs text-amber-400">
            <AlertTriangle className="w-3 h-3" /> {warning}
          </div>
        )}
      </div>
      <button onClick={() => setForm(p => ({ ...p, [field]: !p[field] }))}
        className={`relative w-11 h-6 rounded-full transition-colors duration-200 flex-shrink-0 ${form[field] ? 'bg-cyan' : 'bg-surface-3'}`}>
        <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-all duration-200 ${form[field] ? 'left-6' : 'left-1'}`} />
      </button>
    </div>
  );
}

export default function MotorConfig() {
  const [account, setAccount] = useState(null);
  const [budgetRule, setBudgetRule] = useState(null);
  const [form, setForm] = useState(DEFAULTS);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const init = async () => {
      setLoading(true);
      try {
        const me = await base44.auth.me();
        const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
        const acc = accounts[0] || (await base44.entities.AmazonAccount.list())[0];
        setAccount(acc);
        if (!acc) return;
        const rules = await base44.entities.BudgetRule.filter({ amazon_account_id: acc.id });
        const rule = rules[0];
        setBudgetRule(rule);
        if (rule) {
          setForm(prev => ({
            ...prev,
            bid_min: rule.min_bid ?? prev.bid_min,
            bid_max: rule.max_bid ?? prev.bid_max,
            bid_increase_max_pct: rule.bid_increase_step ? rule.bid_increase_step * 100 : prev.bid_increase_max_pct,
            bid_decrease_max_pct: rule.bid_decrease_step ? rule.bid_decrease_step * 100 : prev.bid_decrease_max_pct,
            acos_target: rule.target_acos ?? prev.acos_target,
            roas_target: rule.target_roas ?? prev.roas_target,
            daily_budget_limit: rule.total_daily_budget ?? prev.daily_budget_limit,
            budget_per_asin_max: rule.max_budget_per_campaign ?? prev.budget_per_asin_max,
          }));
        }
        if (acc) {
          setForm(prev => ({
            ...prev,
            bid_increase_max_pct: acc.max_bid_change_pct ?? prev.bid_increase_max_pct,
            daily_budget_limit: acc.max_daily_budget_limit ?? prev.daily_budget_limit,
            auto_migrate: acc.ai_auto_optimization ?? prev.auto_migrate,
          }));
        }
      } finally {
        setLoading(false);
      }
    };
    init();
  }, []);

  const save = async () => {
    if (!account) return;
    setSaving(true);
    try {
      await base44.entities.AmazonAccount.update(account.id, {
        max_bid_change_pct: form.bid_increase_max_pct,
        max_daily_budget_limit: form.daily_budget_limit,
        ai_auto_optimization: form.auto_migrate,
      });
      const ruleData = {
        amazon_account_id: account.id,
        target_acos: form.acos_target,
        target_roas: form.roas_target,
        min_bid: form.bid_min,
        max_bid: form.bid_max,
        bid_increase_step: form.bid_increase_max_pct / 100,
        bid_decrease_step: form.bid_decrease_max_pct / 100,
        total_daily_budget: form.daily_budget_limit,
        max_budget_per_campaign: form.budget_per_asin_max,
        auto_apply_bid_reduction: form.operation_mode !== 'manual',
        approval_required_pause: true,
        approval_required_budget_increase: form.operation_mode === 'manual',
      };
      if (budgetRule) {
        await base44.entities.BudgetRule.update(budgetRule.id, ruleData);
      } else {
        const created = await base44.entities.BudgetRule.create(ruleData);
        setBudgetRule(created);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      alert(`Erro: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <Loader2 className="w-7 h-7 text-cyan animate-spin" />
    </div>
  );

  return (
    <div className="p-6 space-y-6 max-w-4xl animate-fade-in">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
            <Settings className="w-5 h-5 text-cyan" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Motor de Otimização</h1>
            <p className="text-xs text-slate-400">Configurações do motor de decisão e ajuste automático de bids</p>
          </div>
        </div>
        <button onClick={save} disabled={saving || !account}
          className="flex items-center gap-2 px-5 py-2.5 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <CheckCircle className="w-4 h-4" /> : <Save className="w-4 h-4" />}
          {saving ? 'Guardando...' : saved ? 'Guardado!' : 'Guardar Configurações'}
        </button>
      </div>

      {!account && (
        <div className="bg-amber-400/10 border border-amber-400/20 rounded-xl p-4 text-amber-400 text-sm">
          Configure primeiro uma conta Amazon nas Configurações.
        </div>
      )}

      {/* Modo de operação */}
      <Section title="Modo de Operação" icon={Shield}>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {MODE_OPTIONS.map(m => {
            const Icon = m.icon;
            const active = form.operation_mode === m.key;
            return (
              <button key={m.key} onClick={() => setForm(p => ({ ...p, operation_mode: m.key }))}
                className={`p-4 rounded-xl border text-left transition-all ${active ? 'border-cyan/40 bg-cyan/10' : 'border-surface-3 bg-surface-2 hover:border-surface-2'}`}>
                <div className="flex items-center gap-2 mb-2">
                  <Icon className={`w-4 h-4 ${active ? 'text-cyan' : 'text-slate-500'}`} />
                  <span className={`text-sm font-semibold ${active ? 'text-white' : 'text-slate-400'}`}>{m.label}</span>
                </div>
                <p className="text-xs text-slate-500">{m.desc}</p>
              </button>
            );
          })}
        </div>
      </Section>

      {/* Objetivo */}
      <Section title="Objetivo de Otimização" icon={Target}>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {OBJECTIVE_OPTIONS.map(o => (
            <button key={o.key} onClick={() => setForm(p => ({ ...p, objective: o.key }))}
              className={`px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${form.objective === o.key ? 'bg-cyan/20 text-cyan border-cyan/30' : 'bg-surface-2 text-slate-400 border-surface-3 hover:text-slate-300'}`}>
              {o.label}
            </button>
          ))}
        </div>
      </Section>

      {/* Metas financeiras */}
      <Section title="Metas Financeiras" icon={BarChart2}>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <NumField label="ACoS Alvo (%)" field="acos_target" form={form} setForm={setForm} min={1} max={100} step={0.5} suffix="%" />
          <NumField label="ROAS Alvo" field="roas_target" form={form} setForm={setForm} min={0.1} max={50} step={0.1} />
          <NumField label="TACoS Alvo (%)" field="tacos_target" form={form} setForm={setForm} min={1} max={100} step={0.5} suffix="%" />
          <NumField label="Margem de Segurança (%)" field="safety_margin" form={form} setForm={setForm} min={0} max={20} step={0.5} suffix="%" />
          <NumField label="Zona Neutra — ACoS Mín (%)" field="acos_neutral_lower" form={form} setForm={setForm} min={1} max={100} step={0.5} />
          <NumField label="Zona Neutra — ACoS Máx (%)" field="acos_neutral_upper" form={form} setForm={setForm} min={1} max={100} step={0.5} />
        </div>
      </Section>

      {/* Limites de bid */}
      <Section title="Limites de Bid" icon={Settings}>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <NumField label="Bid Mínimo (R$)" field="bid_min" form={form} setForm={setForm} min={0.02} max={10} step={0.01} prefix="R$" />
          <NumField label="Bid Máximo (R$)" field="bid_max" form={form} setForm={setForm} min={0.1} max={50} step={0.1} prefix="R$" />
          <NumField label="Alteração Mínima (R$)" field="bid_change_min" form={form} setForm={setForm} min={0.01} max={1} step={0.01} prefix="R$" />
          <NumField label="Aumento Máximo (%)" field="bid_increase_max_pct" form={form} setForm={setForm} min={1} max={50} step={1} suffix="%" />
          <NumField label="Redução Máxima (%)" field="bid_decrease_max_pct" form={form} setForm={setForm} min={1} max={50} step={1} suffix="%" />
          <NumField label="Fator de Suavização" field="smoothing_factor" form={form} setForm={setForm} min={0.05} max={1} step={0.05} />
        </div>
      </Section>

      {/* Orçamento */}
      <Section title="Limites de Orçamento" icon={BarChart2}>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <NumField label="Orçamento Diário Total (R$)" field="daily_budget_limit" form={form} setForm={setForm} min={10} max={10000} step={10} prefix="R$" />
          <NumField label="Orçamento Mensal (R$)" field="monthly_budget_limit" form={form} setForm={setForm} min={100} max={100000} step={100} prefix="R$" />
          <NumField label="Orçamento Máx. por ASIN/Camp. (R$)" field="budget_per_asin_max" form={form} setForm={setForm} min={1} max={500} step={5} prefix="R$" />
        </div>
      </Section>

      {/* Análise */}
      <Section title="Parâmetros de Análise" icon={Clock}>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <NumField label="Cooldown (horas)" field="cooldown_hours" form={form} setForm={setForm} min={6} max={168} step={6} suffix="h" />
          <NumField label="Janela de Análise (dias)" field="analysis_window_days" form={form} setForm={setForm} min={3} max={90} step={1} suffix="d" />
          <NumField label="Cliques Mínimos p/ Decisão" field="min_clicks" form={form} setForm={setForm} min={1} max={100} step={1} />
          <NumField label="Pedidos Mínimos p/ Migração" field="min_orders" form={form} setForm={setForm} min={1} max={10} step={1} />
          <NumField label="Confiança Mínima (0–1)" field="min_confidence" form={form} setForm={setForm} min={0.1} max={1} step={0.05} />
          <NumField label="Maturidade: Maduro (dias)" field="maturity_mature_days" form={form} setForm={setForm} min={1} max={14} step={1} suffix="d" />
        </div>
      </Section>

      {/* Automações */}
      <Section title="Ações Automáticas" icon={Brain}>
        <div className="space-y-3">
          <Toggle
            label="Negativação Automática"
            desc="Adiciona negativos exatos para termos abaixo do limite sem necessidade de aprovação"
            field="auto_negate"
            form={form} setForm={setForm}
            warning="Termos relevantes não serão negativados por um único clique."
          />
          <Toggle
            label="Migração Automática para Exata"
            desc="Cria campanhas MANUAL-EXACT para termos com venda sem aprovação manual"
            field="auto_migrate"
            form={form} setForm={setForm}
            warning="Ativo — termos com venda serão migrados automaticamente após validação."
          />
          <Toggle
            label="Criação Automática de Campanhas AUTO"
            desc="Cria campanhas automáticas para ASINs elegíveis sem aprovação"
            field="auto_create_campaigns"
            form={form} setForm={setForm}
            warning="Ativo — novas campanhas serão criadas automaticamente."
          />
        </div>
      </Section>
    </div>
  );
}