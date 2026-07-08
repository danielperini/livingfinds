import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Settings as SettingsIcon, CheckCircle, AlertTriangle, Loader2, Save,
  ShieldAlert, ShieldCheck, WifiOff, ExternalLink, DollarSign, Package,
  BarChart2, Key, Target, ChevronDown, ChevronRight, Eye, Palette
} from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import AppearanceSelector from '@/components/settings/AppearanceSelector';

const PERFORMANCE_DEFAULTS = {
  primary_goal: 'acos',
  objective: 'profitability',
  target_acos: 10,
  max_acos: 15,
  target_roas: 4,
  target_tacos: 5,
  max_tacos: 10,
  daily_budget_limit: 80,
  target_cpc: 0,
  max_cpc: 0,
  min_bid: 0.50,
  max_bid: 5.00,
  max_bid_increase_pct: 15,
  max_bid_decrease_pct: 20,
  target_daily_impressions: 0,
  impressions_goal_enabled: false,
  pacing_enabled: true,
  dayparting_enabled: true,
  placement_optimization_enabled: true,
  first_page_exposure_enabled: false,
  top_of_search_limit: 0,
  rest_of_search_limit: 0,
  product_page_limit: 0,
  minimum_campaign_budget: 15,
  campaign_budget_increment: 5,
  weekly_campaign_capacity: 10,
  target_coverage_hours: 24,
  ai_auto_optimization: false,
};

function Toggle({ value, onChange }) {
  return (
    <button type="button" onClick={() => onChange(!value)}
      className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${value ? 'bg-cyan' : 'bg-surface-3'}`}>
      <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${value ? 'left-5' : 'left-0.5'}`} />
    </button>
  );
}

function NumberInput({ label, hint, value, onChange, min, max, step = 0.01, unit = '' }) {
  return (
    <div>
      <label className="block text-xs text-slate-400 mb-1.5">{label}</label>
      <div className="flex items-center gap-1.5">
        <input type="number" min={min} max={max} step={step} value={value}
          onChange={e => onChange(parseFloat(e.target.value) || 0)}
          className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50" />
        {unit && <span className="text-xs text-slate-500 flex-shrink-0">{unit}</span>}
      </div>
      {hint && <p className="text-[10px] text-slate-600 mt-1">{hint}</p>}
    </div>
  );
}

export default function Settings() {
  const [user, setUser] = useState(null);
  const [account, setAccount] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [authStatus, setAuthStatus] = useState(null);
  const [authChecking, setAuthChecking] = useState(false);
  const [credOpen, setCredOpen] = useState(false);
  const [perfSettings, setPerfSettings] = useState(null); // registro PerformanceSettings
  const [form, setForm] = useState({ seller_name: '', marketplace_id: '', ads_profile_id: '', region: 'NA' });
  const [goals, setGoals] = useState(PERFORMANCE_DEFAULTS);
  const [goalsSaving, setGoalsSaving] = useState(false);
  const [goalsSaved, setGoalsSaved] = useState(false);

  const setGoal = (key, val) => setGoals(p => ({ ...p, [key]: val }));

  useEffect(() => {
    base44.auth.me().then(me => {
      setUser(me);
      return base44.entities.AmazonAccount.filter({ user_id: me.id });
    }).then(accounts => {
      if (!accounts.length) return;
      const acc = accounts[0];
      setAccount(acc);
      setForm({
        seller_name: acc.seller_name || '',
        marketplace_id: acc.marketplace_id || '',
        ads_profile_id: acc.ads_profile_id || '',
        region: acc.region || 'NA',
      });
      // Carregar PerformanceSettings (fonte única de metas)
      return base44.entities.PerformanceSettings.filter({ amazon_account_id: acc.id });
    }).then(settings => {
      if (!settings || !settings.length) {
        // fallback: tentar carregar do AutopilotConfig para migração
        if (account?.id) {
          base44.entities.AutopilotConfig.filter({ amazon_account_id: account?.id }).then(cfgs => {
            if (cfgs.length) {
              const cfg = cfgs[0];
              setGoals(p => ({
                ...p,
                target_acos: cfg.target_acos ?? p.target_acos,
                max_acos: cfg.maximum_acos ?? p.max_acos,
                target_roas: cfg.target_roas ?? p.target_roas,
                target_tacos: cfg.target_tacos ?? p.target_tacos,
                max_tacos: cfg.maximum_tacos ?? p.max_tacos,
                daily_budget_limit: cfg.total_daily_budget ?? cfg.daily_budget_target ?? p.daily_budget_limit,
                target_cpc: cfg.target_cpc ?? 0,
                max_cpc: cfg.maximum_cpc ?? 0,
                min_bid: cfg.min_bid ?? p.min_bid,
                max_bid: cfg.max_bid ?? p.max_bid,
                max_bid_increase_pct: cfg.max_bid_increase_pct ?? p.max_bid_increase_pct,
                max_bid_decrease_pct: cfg.max_bid_decrease_pct ?? p.max_bid_decrease_pct,
                objective: cfg.objective ?? p.objective,
                ai_auto_optimization: cfg.ai_auto_optimization ?? false,
              }));
            }
          }).catch(() => {});
        }
        return;
      }
      const s = settings[0];
      setPerfSettings(s);
      setGoals({ ...PERFORMANCE_DEFAULTS, ...s });
    }).catch(console.error);
  }, []);

  const saveAccount = async () => {
    if (!user) return;
    setSaving(true);
    try {
      if (account) {
        await base44.entities.AmazonAccount.update(account.id, form);
      } else {
        const created = await base44.entities.AmazonAccount.create({ user_id: user.id, ...form, status: 'pending' });
        setAccount(created);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      alert(`Erro: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const saveGoals = async () => {
    if (!account) return;
    setGoalsSaving(true);
    try {
      const payload = { ...goals, amazon_account_id: account.id, updated_at: new Date().toISOString() };
      if (perfSettings) {
        await base44.entities.PerformanceSettings.update(perfSettings.id, payload);
      } else {
        const created = await base44.entities.PerformanceSettings.create(payload);
        setPerfSettings(created);
      }
      // Sincronizar com AutopilotConfig para compatibilidade com o motor existente
      const apCfgs = await base44.entities.AutopilotConfig.filter({ amazon_account_id: account.id });
      const apPayload = {
        target_acos: goals.target_acos,
        maximum_acos: goals.max_acos,
        target_roas: goals.target_roas,
        target_tacos: goals.target_tacos,
        maximum_tacos: goals.max_tacos,
        total_daily_budget: goals.daily_budget_limit,
        daily_budget_limit: goals.daily_budget_limit,
        min_bid: goals.min_bid,
        max_bid: goals.max_bid,
        max_bid_increase_pct: goals.max_bid_increase_pct,
        max_bid_decrease_pct: goals.max_bid_decrease_pct,
        target_cpc: goals.target_cpc,
        maximum_cpc: goals.max_cpc,
        cpc_enforcement: goals.max_cpc > 0,
        objective: goals.objective,
        ai_auto_optimization: goals.ai_auto_optimization,
        dayparting_enabled: goals.dayparting_enabled,
        placement_optimization_enabled: goals.placement_optimization_enabled,
      };
      if (apCfgs.length) {
        await base44.entities.AutopilotConfig.update(apCfgs[0].id, apPayload);
      } else {
        await base44.entities.AutopilotConfig.create({ amazon_account_id: account.id, ...apPayload });
      }
      setGoalsSaved(true);
      setTimeout(() => setGoalsSaved(false), 3000);
    } catch (err) {
      alert(`Erro ao salvar metas: ${err.message}`);
    } finally {
      setGoalsSaving(false);
    }
  };

  const checkAuth = async () => {
    setAuthChecking(true);
    setAuthStatus(null);
    try {
      const res = await base44.functions.invoke('testAuthHealth', {});
      setAuthStatus(res?.data || null);
    } catch (e) {
      setAuthStatus({ ok: false, error: e.message });
    } finally {
      setAuthChecking(false);
    }
  };

  const GOAL_OPTIONS = [
    { value: 'acos', label: 'ACoS — minimizar custo por venda' },
    { value: 'roas', label: 'ROAS — maximizar retorno sobre investimento' },
    { value: 'tacos', label: 'TACoS — controlar impacto total da mídia' },
    { value: 'cpc', label: 'CPC — manter custo por clique no alvo' },
    { value: 'daily_impressions', label: 'Impressões diárias — volume de alcance' },
    { value: 'budget_coverage', label: 'Cobertura do orçamento ao longo do dia' },
    { value: 'cost_per_order', label: 'Custo por pedido' },
    { value: 'growth', label: 'Crescimento com controle de eficiência' },
  ];

  const OBJECTIVE_OPTIONS = [
    { value: 'profitability', label: 'Lucratividade — reduzir ACoS e maximizar margem' },
    { value: 'growth', label: 'Crescimento — aumentar vendas mantendo ACoS controlado' },
    { value: 'launch', label: 'Lançamento — ganhar visibilidade e reviews iniciais' },
    { value: 'defense', label: 'Defesa — proteger posição e marca' },
    { value: 'liquidation', label: 'Liquidação — girar estoque rapidamente' },
    { value: 'maintenance', label: 'Manutenção — estabilizar sem mudanças agressivas' },
  ];

  return (
    <div className="p-6 space-y-6 max-w-3xl animate-fade-in">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
          <SettingsIcon className="w-5 h-5 text-cyan" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-white">Configurações</h1>
          <p className="text-xs text-slate-500">Fonte única de metas e parâmetros do motor de decisão</p>
        </div>
      </div>

      {/* Status da Conta */}
      {account && (
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-4 flex items-center gap-4">
          <StatusBadge status={account.status || 'pending'} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white">{account.seller_name || 'Conta Amazon'}</p>
            <p className="text-xs text-slate-500">
              Marketplace: {account.marketplace_id || '—'} · Moeda: {account.currency_symbol || 'R$'} · Último sync: {account.last_sync_at ? new Date(account.last_sync_at).toLocaleString('pt-BR') : 'Nunca'}
            </p>
          </div>
        </div>
      )}

      {/* Dados básicos da conta */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-6">
        <h2 className="text-sm font-semibold text-white mb-5">Dados da Conta</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {[
            { key: 'seller_name', label: 'Nome do Seller', placeholder: 'Ex: Minha Loja' },
            { key: 'marketplace_id', label: 'Marketplace ID', placeholder: 'Ex: A2Q3Y263D00KWC' },
            { key: 'ads_profile_id', label: 'Ads Profile ID', placeholder: 'Ex: 1234567890' },
            { key: 'region', label: 'Região', placeholder: 'NA / EU / FE' },
          ].map(f => (
            <div key={f.key}>
              <label className="block text-xs text-slate-400 mb-1.5">{f.label}</label>
              <input value={form[f.key]} onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
                placeholder={f.placeholder}
                className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white placeholder-slate-600 focus:outline-none focus:border-cyan/50" />
            </div>
          ))}
        </div>
        <button onClick={saveAccount} disabled={saving}
          className="mt-5 flex items-center gap-2 px-5 py-2.5 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <CheckCircle className="w-4 h-4" /> : <Save className="w-4 h-4" />}
          {saving ? 'Salvando...' : saved ? 'Salvo!' : 'Salvar configurações'}
        </button>
      </div>

      {/* ─── METAS DE PERFORMANCE (Fonte Única) ─── */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-6">
        <div className="flex items-center gap-2 mb-1">
          <Target className="w-4 h-4 text-cyan" />
          <h2 className="text-sm font-semibold text-white">Metas de Performance</h2>
          <span className="text-[10px] text-cyan/60 bg-cyan/10 border border-cyan/20 px-1.5 py-0.5 rounded-full ml-1">Fonte única do motor</span>
        </div>
        <p className="text-xs text-slate-500 mb-5">Todos os cálculos e decisões de bid usam estes valores. Dashboard e Campanhas apenas leem.</p>

        {/* Meta principal e objetivo */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Meta Principal</label>
            <select value={goals.primary_goal} onChange={e => setGoal('primary_goal', e.target.value)}
              className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50">
              {GOAL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <p className="text-[10px] text-slate-600 mt-1">A IA prioriza esta métrica. Demais servem como limites de segurança.</p>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Objetivo Estratégico</label>
            <select value={goals.objective} onChange={e => setGoal('objective', e.target.value)}
              className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50">
              {OBJECTIVE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </div>

        {/* Metas de eficiência */}
        <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-3">Metas de Eficiência</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-5">
          <NumberInput label="ACoS Alvo (%)" hint="Meta primária de gasto/venda" value={goals.target_acos} onChange={v => setGoal('target_acos', v)} min={1} max={200} step={0.5} />
          <NumberInput label="ACoS Máximo (%)" hint="Acima disso: corte de bid" value={goals.max_acos} onChange={v => setGoal('max_acos', v)} min={1} max={500} step={0.5} />
          <NumberInput label="ROAS Alvo (x)" hint="Retorno mínimo sobre investimento" value={goals.target_roas} onChange={v => setGoal('target_roas', v)} min={0.1} max={50} step={0.1} />
          <NumberInput label="TACoS Alvo (%)" hint="Gasto / Vendas Totais" value={goals.target_tacos} onChange={v => setGoal('target_tacos', v)} min={1} max={100} step={0.5} />
          <NumberInput label="TACoS Máximo (%)" hint="Limite de risco de TACoS" value={goals.max_tacos} onChange={v => setGoal('max_tacos', v)} min={1} max={200} step={0.5} />
          <NumberInput label="Orçamento Diário Geral (R$)" hint="Teto de risco diário do motor" value={goals.daily_budget_limit} onChange={v => setGoal('daily_budget_limit', v)} min={10} max={5000} step={5} />
        </div>

        {/* CPC */}
        <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-3">Meta de CPC</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-5">
          <NumberInput label="CPC Alvo (R$)" hint="A IA ajusta bids para este CPC" value={goals.target_cpc} onChange={v => setGoal('target_cpc', v)} min={0} step={0.01} />
          <NumberInput label="CPC Máximo (R$)" hint="Acima disso: bid reduzido" value={goals.max_cpc} onChange={v => setGoal('max_cpc', v)} min={0} step={0.01} />
          <div className="flex flex-col justify-between">
            <label className="block text-xs text-slate-400 mb-1.5">Enforçar CPC Máximo</label>
            <div className="flex items-center justify-between p-3 bg-surface-2 rounded-lg border border-surface-3 h-[42px]">
              <span className="text-xs text-slate-300">{goals.max_cpc > 0 ? 'Ativo' : 'Inativo'}</span>
              <Toggle value={goals.max_cpc > 0} onChange={v => { if (!v) setGoal('max_cpc', 0); }} />
            </div>
            <p className="text-[10px] text-slate-600 mt-1">Ativo quando CPC Máximo {'>'} 0</p>
          </div>
        </div>

        {/* Impressões diárias */}
        <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-3">Impressões Diárias</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-5">
          <div className="flex flex-col justify-between">
            <label className="block text-xs text-slate-400 mb-1.5">Meta de Impressões Ativa</label>
            <div className="flex items-center justify-between p-3 bg-surface-2 rounded-lg border border-surface-3 h-[42px]">
              <span className="text-xs text-slate-300">{goals.impressions_goal_enabled ? 'Ativa' : 'Inativa'}</span>
              <Toggle value={goals.impressions_goal_enabled} onChange={v => setGoal('impressions_goal_enabled', v)} />
            </div>
            <p className="text-[10px] text-slate-600 mt-1">Só atua quando metas de eficiência permitem</p>
          </div>
          <NumberInput label="Impressões Diárias Alvo" hint="Quantidade alvo por dia" value={goals.target_daily_impressions} onChange={v => setGoal('target_daily_impressions', v)} min={0} step={100} />
          <NumberInput label="Impressões Mínimas/Dia" hint="Alerta abaixo deste nível" value={goals.min_daily_impressions || 0} onChange={v => setGoal('min_daily_impressions', v)} min={0} step={100} />
        </div>

        {/* Controles de Bid */}
        <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-3">Controles de Bid</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">
          <NumberInput label="Bid Mínimo (R$)" value={goals.min_bid} onChange={v => setGoal('min_bid', v)} min={0.02} max={10} step={0.01} />
          <NumberInput label="Bid Máximo (R$)" value={goals.max_bid} onChange={v => setGoal('max_bid', v)} min={0.10} max={100} step={0.10} />
          <NumberInput label="Aumento Máx. de Bid (%)" value={goals.max_bid_increase_pct} onChange={v => setGoal('max_bid_increase_pct', v)} min={1} max={100} step={1} />
          <NumberInput label="Redução Máx. de Bid (%)" value={goals.max_bid_decrease_pct} onChange={v => setGoal('max_bid_decrease_pct', v)} min={1} max={100} step={1} />
        </div>

        {/* Budget por campanha */}
        <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-3">Budget por Campanha</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-5">
          <NumberInput label="Budget Mínimo por Campanha (R$)" hint="Piso de budget individual" value={goals.minimum_campaign_budget} onChange={v => setGoal('minimum_campaign_budget', v)} min={5} step={5} />
          <NumberInput label="Incremento Permitido (R$)" hint="Variação máxima por ciclo" value={goals.campaign_budget_increment} onChange={v => setGoal('campaign_budget_increment', v)} min={1} step={1} />
          <NumberInput label="Capacidade Semanal de Campanhas" hint="Usado no cálculo de budget sugerido" value={goals.weekly_campaign_capacity} onChange={v => setGoal('weekly_campaign_capacity', v)} min={1} step={1} />
        </div>

        {/* Dayparting e Posicionamento */}
        <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-3">Automações</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
          {[
            { key: 'pacing_enabled', label: 'Pacing do Orçamento', hint: 'Controla ritmo do gasto ao longo do dia' },
            { key: 'dayparting_enabled', label: 'Dayparting', hint: 'Ajusta bids por horário de performance' },
            { key: 'placement_optimization_enabled', label: 'Otimização de Posicionamento', hint: 'Ajusta exposição por placement' },
          ].map(({ key, label, hint }) => (
            <div key={key} className="flex items-center justify-between p-3 bg-surface-2 rounded-lg border border-surface-3">
              <div>
                <p className="text-xs font-medium text-slate-300">{label}</p>
                <p className="text-[10px] text-slate-600 mt-0.5">{hint}</p>
              </div>
              <Toggle value={goals[key]} onChange={v => setGoal(key, v)} />
            </div>
          ))}
        </div>

        {/* Top of Search / Placement */}
        {goals.placement_optimization_enabled && (
          <>
            <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-3">Limites de Placement (%)</p>
            <div className="grid grid-cols-3 gap-4 mb-4">
              <NumberInput label="Top of Search Máx." hint="0 = sem ajuste" value={goals.top_of_search_limit} onChange={v => setGoal('top_of_search_limit', v)} min={0} max={900} step={5} />
              <NumberInput label="Rest of Search Máx." hint="0 = sem ajuste" value={goals.rest_of_search_limit} onChange={v => setGoal('rest_of_search_limit', v)} min={0} max={900} step={5} />
              <NumberInput label="Product Pages Máx." hint="0 = sem ajuste" value={goals.product_page_limit} onChange={v => setGoal('product_page_limit', v)} min={0} max={900} step={5} />
            </div>
          </>
        )}

        {/* Otimização IA automática */}
        <div className="flex items-center justify-between p-4 bg-surface-2 rounded-lg border border-surface-3 mb-5">
          <div>
            <p className="text-sm font-medium text-white">Otimização Automática com IA</p>
            <p className="text-xs text-slate-500 mt-0.5">Quando ativo, o motor executa decisões sem revisão manual.</p>
            {goals.ai_auto_optimization && (
              <p className="text-xs text-amber-400 mt-1 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Modo automático ativo — decisões sem revisão.</p>
            )}
          </div>
          <Toggle value={goals.ai_auto_optimization} onChange={v => setGoal('ai_auto_optimization', v)} />
        </div>

        {/* Resumo de metas */}
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 p-4 bg-surface-2 rounded-lg border border-surface-3 mb-5">
          {[
            { label: 'ACoS Alvo', value: `${goals.target_acos}%`, color: 'text-cyan' },
            { label: 'ACoS Máx.', value: `${goals.max_acos}%`, color: 'text-red-400' },
            { label: 'ROAS Alvo', value: `${goals.target_roas}x`, color: 'text-emerald-400' },
            { label: 'TACoS Alvo', value: `${goals.target_tacos}%`, color: 'text-amber-400' },
            { label: 'CPC Alvo', value: goals.target_cpc > 0 ? `R$${goals.target_cpc.toFixed(2)}` : '—', color: 'text-violet-400' },
            { label: 'Budget/dia', value: `R$${goals.daily_budget_limit}`, color: 'text-slate-300' },
          ].map(({ label, value, color }) => (
            <div key={label} className="text-center">
              <p className="text-[10px] text-slate-500 mb-0.5">{label}</p>
              <p className={`text-sm font-bold ${color}`}>{value}</p>
            </div>
          ))}
        </div>

        <button onClick={saveGoals} disabled={goalsSaving || !account}
          className="flex items-center gap-2 px-5 py-2.5 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60">
          {goalsSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : goalsSaved ? <CheckCircle className="w-4 h-4" /> : <Save className="w-4 h-4" />}
          {goalsSaving ? 'Salvando...' : goalsSaved ? 'Salvo!' : 'Salvar configurações'}
        </button>
      </div>

      {/* ─── APARÊNCIA ─── */}
      <AppearanceSelector />

      {/* ─── CREDENCIAIS AMAZON — accordion ─── */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
        <button type="button" onClick={() => setCredOpen(o => !o)}
          className="w-full flex items-center justify-between px-6 py-4 hover:bg-surface-2 transition-colors">
          <div className="flex items-center gap-2">
            <Key className="w-4 h-4 text-slate-400" />
            <span className="text-sm font-semibold text-white">Credenciais Amazon</span>
            <span className="text-[10px] text-slate-500 bg-surface-3 px-2 py-0.5 rounded-full">Environment Variables</span>
          </div>
          {credOpen ? <ChevronDown className="w-4 h-4 text-slate-500" /> : <ChevronRight className="w-4 h-4 text-slate-500" />}
        </button>

        {credOpen && (
          <div className="px-6 pb-6 space-y-4 border-t border-surface-2">
            <p className="text-xs text-slate-500 mt-4">Configuradas em Base44 → Settings → Environment Variables. Nunca expostas aqui por segurança.</p>

            {/* Status rápido sem valores sensíveis */}
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'Ads Profile ID', value: account?.ads_profile_id, icon: BarChart2 },
                { label: 'Marketplace ID', value: account?.marketplace_id, icon: Package },
                { label: 'Região', value: account?.region || 'NA', icon: Key },
                { label: 'Moeda', value: `${account?.currency_code || 'BRL'} (${account?.currency_symbol || 'R$'})`, icon: DollarSign },
              ].map(({ label, value, icon: Icon }) => (
                <div key={label} className="bg-surface-2 rounded-lg p-3">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Icon className="w-3 h-3 text-slate-500" />
                    <p className="text-[10px] text-slate-500">{label}</p>
                  </div>
                  <p className="text-xs font-mono text-slate-200 truncate">{value || '—'}</p>
                </div>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${account?.status === 'connected' ? 'bg-emerald-400' : 'bg-amber-400'}`} />
              <p className="text-xs text-slate-400">
                Status: <span className={account?.status === 'connected' ? 'text-emerald-400 font-semibold' : 'text-amber-400 font-semibold'}>{account?.status || 'desconhecido'}</span>
                {account?.profile_validated_at && ` · Validado em ${new Date(account.profile_validated_at).toLocaleDateString('pt-BR')}`}
              </p>
            </div>

            <div className="flex items-center gap-3">
              <button onClick={checkAuth} disabled={authChecking}
                className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold bg-surface-2 border border-surface-3 text-slate-300 hover:text-white rounded-lg transition-colors disabled:opacity-60">
                {authChecking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                {authChecking ? 'Verificando...' : 'Testar conexão'}
              </button>
              {!authStatus && !authChecking && (
                <p className="text-xs text-slate-600">Clique para testar a conexão com a Amazon.</p>
              )}
            </div>

            {authStatus && (
              <div className="space-y-2">
                {[
                  { key: 'ads', label: 'Amazon Ads API' },
                  { key: 'sp', label: 'SP-API' },
                ].map(({ key, label }) => {
                  const svc = authStatus?.services?.[key];
                  const ok = svc?.ok;
                  return (
                    <div key={key} className={`p-3 rounded-lg border text-xs ${ok ? 'border-emerald-400/20 bg-emerald-400/5' : 'border-red-400/20 bg-red-400/5'}`}>
                      <div className="flex items-center gap-2">
                        {ok ? <ShieldCheck className="w-4 h-4 text-emerald-400" /> : <ShieldAlert className="w-4 h-4 text-red-400" />}
                        <span className={`font-semibold ${ok ? 'text-emerald-300' : 'text-red-300'}`}>{label}</span>
                        {!ok && svc?.error_code && <span className="text-red-400 font-mono">{svc.error_code}</span>}
                      </div>
                    </div>
                  );
                })}

                {!authStatus?.services?.ads?.ok && (
                  <div className="flex items-start gap-2 p-3 bg-amber-400/5 border border-amber-400/20 rounded-lg">
                    <WifiOff className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                    <div className="text-xs text-amber-300 space-y-2">
                      <p className="font-semibold">Reconectar Amazon Ads via OAuth</p>
                      <a href="https://www.amazon.com/ap/oa?client_id=amzn1.application-oa2-client.a30fb7e08c524463acb3611c8d7f71e4&scope=advertising::campaign_management&response_type=code&redirect_uri=https://livingfinds-app.base44.app/amazon-ads-callback"
                        target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 px-3 py-1.5 bg-amber-500/20 border border-amber-500/40 text-amber-300 hover:bg-amber-500/30 rounded-lg font-semibold transition-colors">
                        <ExternalLink className="w-3.5 h-3.5" />Autorizar Amazon Ads →
                      </a>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}