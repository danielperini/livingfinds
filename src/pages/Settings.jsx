import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Settings as SettingsIcon, CheckCircle, AlertTriangle, Loader2, Save,
  ShieldAlert, ShieldCheck, ExternalLink, DollarSign, Package,
  BarChart2, Key, Target, ChevronDown, ChevronRight, FlaskConical, Wifi,
} from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import AppearanceSelector from '@/components/settings/AppearanceSelector';
import BackupPanel from '@/components/backup/BackupPanel';
import ObjectiveSelector from '@/components/settings/ObjectiveSelector';
import { OBJECTIVE_PRESETS, divergesFromPreset, getCoherenceWarnings } from '@/components/settings/objectivePresets';
import {
  normalizePerformanceSettings,
  updateEfficiencyGoal,
  updateUnifiedBidCeiling,
} from '@/lib/performanceSettingsNormalization';


const PERFORMANCE_DEFAULTS = {
  primary_goal: 'acos',
  objective: 'profitability',
  target_acos: 10,
  max_acos: 15,
  target_roas: 10,
  target_tacos: 5,
  max_tacos: 10,
  daily_budget_limit: 80,
  target_cpc: 0,
  max_cpc: 5.00,
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

function NumberInput({ label, hint, value, onChange, min, max, step = 0.01, unit = '', zeroMeansIgnored = false }) {
  const showIgnoredHint = zeroMeansIgnored && (value === 0 || value === '0' || value === null || value === undefined || value === '');
  return (
    <div>
      <label className="block text-xs text-slate-400 mb-1.5">{label}</label>
      <div className="flex items-center gap-1.5">
        <input type="number" min={min} max={max} step={step} value={value}
          onChange={e => onChange(parseFloat(e.target.value) || 0)}
          className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50" />
        {unit && <span className="text-xs text-slate-500 flex-shrink-0">{unit}</span>}
      </div>
      {showIgnoredHint
        ? <p className="text-[10px] text-amber-400/70 mt-1 flex items-center gap-1"><AlertTriangle className="w-2.5 h-2.5 flex-shrink-0" />Ignorado — defina &gt; 0 para ativar</p>
        : hint && <p className="text-[10px] text-slate-600 mt-1">{hint}</p>
      }
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
  const [spApiTestLoading, setSpApiTestLoading] = useState(false);
  const [spApiTestResult, setSpApiTestResult] = useState(null);
  const [perfSettings, setPerfSettings] = useState(null); // registro PerformanceSettings
  const [form, setForm] = useState({ seller_name: '', marketplace_id: '', ads_profile_id: '', region: 'NA' });
  const [goals, setGoals] = useState(PERFORMANCE_DEFAULTS);
  const [goalsSaving, setGoalsSaving] = useState(false);
  const [goalsSaved, setGoalsSaved] = useState(false);
  const [todaySpend, setTodaySpend] = useState(null);
  const [justApplied, setJustApplied] = useState(false);

  const setGoal = (key, val) => setGoals((previous) => {
    if (key === 'target_acos' || key === 'target_roas') {
      return updateEfficiencyGoal(previous, key, val);
    }
    if (key === 'max_bid' || key === 'max_cpc') {
      return updateUnifiedBidCeiling(previous, val);
    }
    return { ...previous, [key]: val };
  });

  const applyObjectivePreset = (key) => {
    const preset = OBJECTIVE_PRESETS[key];
    if (!preset?.values) return;
    setGoals((previous) => {
      const next = { ...previous, ...preset.values, objective: key };
      if (preset.values.max_bid != null) next.max_cpc = preset.values.max_bid;
      return normalizePerformanceSettings(next, PERFORMANCE_DEFAULTS);
    });
    setJustApplied(true);
    setTimeout(() => setJustApplied(false), 1000);
  };

  useEffect(() => {
    async function load() {
      const me = await base44.auth.me();
      setUser(me);

      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      if (!accounts.length) return;
      const acc = accounts[0];
      setAccount(acc);
      setForm({
        seller_name: acc.seller_name || '',
        marketplace_id: acc.marketplace_id || '',
        ads_profile_id: acc.ads_profile_id || '',
        region: acc.region || 'NA',
      });

      // Carregar gasto de hoje (leitura única, sem polling)
      const todayBRT = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
      base44.entities.AccountDailySpendController.filter(
        { amazon_account_id: acc.id, spend_date: todayBRT }, null, 1
      ).then(ctrs => { if (ctrs[0]) setTodaySpend(ctrs[0]); }).catch(() => {});

      // Carregar PerformanceSettings (fonte única de metas)
      const settings = await base44.entities.PerformanceSettings.filter({ amazon_account_id: acc.id });
      if (settings && settings.length) {
        const s = settings[0];
        setPerfSettings(s);
        setGoals(normalizePerformanceSettings(s, PERFORMANCE_DEFAULTS));
      } else {
        // fallback: AutopilotConfig para migração
        const cfgs = await base44.entities.AutopilotConfig.filter({ amazon_account_id: acc.id }).catch(() => []);
        if (cfgs.length) {
          const cfg = cfgs[0];
          setGoals((previous) => normalizePerformanceSettings({
            ...previous,
            target_acos: cfg.target_acos ?? previous.target_acos,
            max_acos: cfg.maximum_acos ?? previous.max_acos,
            target_roas: cfg.target_roas ?? previous.target_roas,
            target_tacos: cfg.target_tacos ?? previous.target_tacos,
            max_tacos: cfg.maximum_tacos ?? previous.max_tacos,
            daily_budget_limit: cfg.total_daily_budget ?? cfg.daily_budget_target ?? previous.daily_budget_limit,
            target_cpc: cfg.target_cpc ?? 0,
            max_cpc: cfg.maximum_cpc ?? 0,
            min_bid: cfg.min_bid ?? previous.min_bid,
            max_bid: cfg.max_bid ?? previous.max_bid,
            max_bid_increase_pct: cfg.max_bid_increase_pct ?? previous.max_bid_increase_pct,
            max_bid_decrease_pct: cfg.max_bid_decrease_pct ?? previous.max_bid_decrease_pct,
            objective: cfg.objective ?? previous.objective,
            ai_auto_optimization: cfg.ai_auto_optimization ?? false,
          }, PERFORMANCE_DEFAULTS));
        }
      }
    }
    load().catch(console.error);
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

  // Campos elegíveis: zero → null ao salvar
  const ZERO_IGNORED_FIELDS = [
    'target_acos', 'max_acos', 'target_roas', 'target_tacos', 'max_tacos',
    'target_cpc', 'max_cpc', 'top_of_search_limit', 'rest_of_search_limit',
    'product_page_limit', 'minimum_campaign_budget', 'campaign_budget_increment',
    'weekly_campaign_capacity',
  ];

  const saveGoals = async () => {
    if (!account) return;
    setGoalsSaving(true);
    try {
      const now = new Date().toISOString();
      const canonicalGoals = normalizePerformanceSettings(goals, PERFORMANCE_DEFAULTS);
      setGoals(canonicalGoals);
      // Serializar: campos elegíveis com valor 0 → null (motor os ignora)
      const serializedGoals = { ...canonicalGoals };
      for (const field of ZERO_IGNORED_FIELDS) {
        if (serializedGoals[field] === 0 || serializedGoals[field] === '0') {
          serializedGoals[field] = null;
        }
      }
      // Objetivo efetivo: se campos divergem do preset base → 'custom'
      const baseObjective = canonicalGoals.objective;
      const effectiveObjective = divergesFromPreset(canonicalGoals) ? 'custom' : baseObjective;
      serializedGoals.objective = effectiveObjective;
      serializedGoals.objective_base = effectiveObjective === 'custom' && baseObjective !== 'custom' ? baseObjective : null;

      const payload = { ...serializedGoals, amazon_account_id: account.id, updated_at: now };

      // Detectar campos alterados para o histórico
      const changedFields = [];
      if (perfSettings) {
        const TRACKED = ['target_acos','max_acos','target_roas','target_tacos','max_tacos','daily_budget_limit','target_cpc','max_cpc','min_bid','max_bid','max_bid_increase_pct','max_bid_decrease_pct','objective','primary_goal','dayparting_enabled','placement_optimization_enabled','top_of_search_limit','rest_of_search_limit','product_page_limit','ai_auto_optimization','minimum_campaign_budget','weekly_campaign_capacity'];
        for (const field of TRACKED) {
          const oldVal = perfSettings[field];
          const newVal = canonicalGoals[field];
          if (String(oldVal ?? '') !== String(newVal ?? '')) {
            changedFields.push({ field, old_value: oldVal ?? null, new_value: newVal ?? null });
          }
        }
      }

      if (perfSettings) {
        await base44.entities.PerformanceSettings.update(perfSettings.id, payload);
        setPerfSettings((previous) => ({ ...previous, ...payload }));
      } else {
        const created = await base44.entities.PerformanceSettings.create(payload);
        setPerfSettings(created);
      }

      // Gravar snapshot no histórico (sempre, mesmo sem diff detectado — primeiro save)
      const me = user || await base44.auth.me();
      base44.entities.PerformanceSettingsHistory.create({
        amazon_account_id: account.id,
        changed_by_id: me?.id || '',
        changed_by_name: me?.full_name || '',
        changed_by_email: me?.email || '',
        snapshot: { ...canonicalGoals },
        changed_fields: changedFields,
        changed_at: now,
      }).catch(() => {});
      // Sincronizar com AutopilotConfig para compatibilidade com o motor existente
      const apCfgs = await base44.entities.AutopilotConfig.filter({ amazon_account_id: account.id });
      const apPayload = {
        target_acos: serializedGoals.target_acos,
        maximum_acos: serializedGoals.max_acos,
        target_roas: serializedGoals.target_roas,
        target_tacos: serializedGoals.target_tacos,
        maximum_tacos: serializedGoals.max_tacos,
        total_daily_budget: serializedGoals.daily_budget_limit,
        daily_budget_limit: serializedGoals.daily_budget_limit,
        min_bid: serializedGoals.min_bid,
        max_bid: serializedGoals.max_bid,
        max_bid_increase_pct: serializedGoals.max_bid_increase_pct,
        max_bid_decrease_pct: serializedGoals.max_bid_decrease_pct,
        target_cpc: serializedGoals.target_cpc,
        maximum_cpc: serializedGoals.max_cpc,
        cpc_enforcement: (serializedGoals.max_cpc ?? 0) > 0,
        objective: serializedGoals.objective,
        impressions_goal_enabled: serializedGoals.impressions_goal_enabled,
        target_daily_impressions: serializedGoals.target_daily_impressions,
        top_of_search_limit: serializedGoals.top_of_search_limit,
        rest_of_search_limit: serializedGoals.rest_of_search_limit,
        product_page_limit: serializedGoals.product_page_limit,
        ...(baseObjective === 'flex_stock' ? { auto_reduce_low_stock: true, auto_pause_zero_stock: true } : {}),
        ai_auto_optimization: serializedGoals.ai_auto_optimization,
        dayparting_enabled: serializedGoals.dayparting_enabled,
        placement_optimization_enabled: serializedGoals.placement_optimization_enabled,
      };
      if (apCfgs.length) {
        await base44.entities.AutopilotConfig.update(apCfgs[0].id, apPayload);
      } else {
        await base44.entities.AutopilotConfig.create({ amazon_account_id: account.id, ...apPayload });
      }
      setGoalsSaved(true);
      setTimeout(() => setGoalsSaved(false), 4000);

      // ── Propagação canônica: budgets, budget mínimo, placements e cap diário
      //    em uma única chamada backend com log em SyncExecutionLog ──
      base44.functions.invoke('propagateCanonicalSettings', {
        amazon_account_id: account.id,
        trigger: 'settings_updated',
      }).then(res => {
        const d = res?.data;
        if (d?.ok) {
          // Budget confirmado pela Amazon — atualizar feedback visual
          setGoalsSaved(true);
          setTimeout(() => setGoalsSaved(false), 6000);
        }
      }).catch(() => {});

      // ── Pós-save: disparar motor imediatamente + enfileirar recalibração ──
      // 1. Motor relê os novos parâmetros e gera decisões atualizadas agora
      base44.functions.invoke('runUnifiedDecisionEngine', {
        amazon_account_id: account.id,
        trigger: 'settings_updated',
        force: true,
      }).catch(() => {});

      // 2. Enfileirar na OptimizationDecision para a próxima janela de execução
      base44.entities.OptimizationDecision.create({
        amazon_account_id: account.id,
        decision_type: 'bid_change',
        entity_type: 'account',
        action: 'reload_settings',
        status: 'approved',
        approval_status: 'auto_approved',
        autopilot_authorized: true,
        requires_approval: false,
        rationale: `Metas atualizadas: ACoS=${canonicalGoals.target_acos}%, ROAS=${canonicalGoals.target_roas}x, teto de lance=R$${canonicalGoals.max_bid}, Budget/dia=R$${canonicalGoals.daily_budget_limit}. Motor recarregará os parâmetros na próxima janela.`,
        source_function: 'Settings.saveGoals',
        created_at: new Date().toISOString(),
      }).catch(() => {});

    } catch (err) {
      alert(`Erro ao salvar metas: ${err.message}`);
    } finally {
      setGoalsSaving(false);
    }
  };

  const testSpApiPrice = async () => {
    if (!account || spApiTestLoading) return;
    setSpApiTestLoading(true);
    setSpApiTestResult(null);
    try {
      // Buscar o primeiro produto da conta para testar
      const products = await base44.entities.Product.filter({ amazon_account_id: account.id }, null, 1);
      const product = products[0];
      if (!product) { setSpApiTestResult({ ok: false, error: 'Nenhum produto encontrado para testar.' }); return; }
      const res = await base44.functions.invoke('refreshProductMarketPrice', {
        amazon_account_id: account.id,
        product_id: product.id,
        force: true,
        next_active: true,
      });
      const data = res?.data || res;
      // Sanitizar: remover campos sensíveis antes de exibir
      const safe = { ...data };
      delete safe.access_token; delete safe.refresh_token; delete safe.token;
      setSpApiTestResult({ ok: !!data?.ok, asin: product.asin, data: safe });
    } catch (e) {
      setSpApiTestResult({ ok: false, error: e.message });
    } finally {
      setSpApiTestLoading(false);
    }
  };

  const checkAuth = async () => {
    setAuthChecking(true);
    setAuthStatus(null);
    try {
      // Renovar token antes de testar
      await base44.functions.invoke('refreshAmazonAdsTokenDailyOrHourly', { force: true }).catch(() => {});
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

  const efficiencyUsesRoas = goals.primary_goal === 'roas';
  const coherenceWarnings = getCoherenceWarnings(goals);

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
      <div className={`bg-surface-1 border border-surface-2 rounded-xl p-6 ${justApplied ? 'animate-pulse' : ''}`}>
        <div className="flex items-center gap-2 mb-1">
          <Target className="w-4 h-4 text-cyan" />
          <h2 className="text-sm font-semibold text-white">Metas de Performance</h2>
          <span className="text-[10px] text-cyan/60 bg-cyan/10 border border-cyan/20 px-1.5 py-0.5 rounded-full ml-1">Fonte única do motor</span>
        </div>
        <p className="text-xs text-slate-500 mb-5">Todos os cálculos e decisões de bid usam estes valores. Dashboard e Campanhas apenas leem.</p>

        {/* Meta principal */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Meta Principal</label>
            <select value={goals.primary_goal} onChange={e => setGoal('primary_goal', e.target.value)}
              className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50">
              {GOAL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <p className="text-[10px] text-slate-600 mt-1">A IA prioriza esta métrica. Demais servem como limites de segurança.</p>
          </div>
        </div>

        {/* Objetivo estratégico — cards com presets */}
        <div className="mb-5">
          <ObjectiveSelector
            objective={goals.objective}
            isCustomized={divergesFromPreset(goals)}
            onApply={applyObjectivePreset}
          />
        </div>

        {/* Metas de eficiência */}
        <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-3">Metas de Eficiência</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-5">
          <NumberInput
            label={efficiencyUsesRoas ? 'Meta de Eficiência — ROAS (x)' : 'Meta de Eficiência — ACoS (%)'}
            hint={efficiencyUsesRoas ? 'Quanto maior, melhor o retorno' : 'Quanto menor, menor o gasto por venda'}
            value={efficiencyUsesRoas ? goals.target_roas : goals.target_acos}
            onChange={v => setGoal(efficiencyUsesRoas ? 'target_roas' : 'target_acos', v)}
            min={0}
            max={efficiencyUsesRoas ? 50 : 200}
            step={efficiencyUsesRoas ? 0.1 : 0.5}
            zeroMeansIgnored
          />
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">
              {efficiencyUsesRoas ? 'ACoS equivalente' : 'ROAS equivalente'}
            </label>
            <div className="h-[42px] flex items-center px-3 bg-surface-2 border border-surface-3 rounded-lg text-sm font-semibold text-emerald-400">
              {efficiencyUsesRoas ? `${goals.target_acos}%` : `${goals.target_roas}x`}
            </div>
            <p className="text-[10px] text-slate-600 mt-1">Calculado automaticamente; não é outro parâmetro.</p>
          </div>
          <NumberInput label="ACoS Máximo (%)" hint="Acima disso: corte de bid" value={goals.max_acos} onChange={v => setGoal('max_acos', v)} min={0} max={500} step={0.5} zeroMeansIgnored />
          <NumberInput label="TACoS Alvo (%)" hint="Gasto / Vendas Totais" value={goals.target_tacos} onChange={v => setGoal('target_tacos', v)} min={0} max={100} step={0.5} zeroMeansIgnored />
          <NumberInput label="TACoS Máximo (%)" hint="Limite de risco de TACoS" value={goals.max_tacos} onChange={v => setGoal('max_tacos', v)} min={0} max={200} step={0.5} zeroMeansIgnored />
          <div>
            <NumberInput label="Orçamento Diário Geral (R$)" hint="Teto de risco diário do motor" value={goals.daily_budget_limit} onChange={v => setGoal('daily_budget_limit', v)} min={10} max={5000} step={5} />
            {todaySpend?.confirmed_spend != null && (
              <p className="text-[10px] mt-1.5 flex items-center gap-1">
                <span className="text-slate-400">📊 Gasto Ads hoje:</span>
                <span className="font-semibold font-mono text-slate-200">R${Number(todaySpend.confirmed_spend).toFixed(2)}</span>
                <span className="text-slate-500">de R${Number(goals.daily_budget_limit).toFixed(2)}</span>
                {Number(todaySpend.confirmed_spend) > Number(goals.daily_budget_limit) && (
                  <span className="text-red-400 ml-1">⚠ acima do teto</span>
                )}
              </p>
            )}
          </div>
        </div>

        {/* Lances e CPC — um único teto operacional */}
        <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-3">Lances e CPC</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-5">
          <NumberInput label="CPC Alvo (R$)" hint="A IA ajusta bids para este CPC" value={goals.target_cpc} onChange={v => setGoal('target_cpc', v)} min={0} step={0.01} zeroMeansIgnored />
          <NumberInput label="Teto Máximo de Lance/CPC (R$)" hint="Único limite enviado à Amazon" value={goals.max_bid} onChange={v => setGoal('max_bid', v)} min={0.10} max={100} step={0.10} />
          <NumberInput label="Bid Mínimo (R$)" hint="Nunca ultrapassa o teto máximo" value={goals.min_bid} onChange={v => setGoal('min_bid', v)} min={0.02} max={10} step={0.01} />
          <NumberInput label="Aumento Máx. de Bid (%)" value={goals.max_bid_increase_pct} onChange={v => setGoal('max_bid_increase_pct', v)} min={1} max={100} step={1} />
          <NumberInput label="Redução Máx. de Bid (%)" value={goals.max_bid_decrease_pct} onChange={v => setGoal('max_bid_decrease_pct', v)} min={1} max={100} step={1} />
          <div className="flex items-end">
            <p className="w-full px-3 py-2.5 rounded-lg border border-emerald-500/20 bg-emerald-500/5 text-[11px] text-slate-400">
              Teto ativo: <strong className="text-emerald-300 font-mono">R${Number(goals.max_bid).toFixed(2)}</strong>. Os campos legados são sincronizados automaticamente.
            </p>
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

        {/* Budget por campanha */}
        <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-3">Budget por Campanha</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-5">
          <NumberInput label="Budget Mínimo por Campanha (R$)" hint="Piso de budget individual" value={goals.minimum_campaign_budget} onChange={v => setGoal('minimum_campaign_budget', v)} min={0} step={5} zeroMeansIgnored />
          <NumberInput label="Incremento Permitido (R$)" hint="Variação máxima por ciclo" value={goals.campaign_budget_increment} onChange={v => setGoal('campaign_budget_increment', v)} min={0} step={1} zeroMeansIgnored />
          <NumberInput label="Capacidade Semanal de Campanhas" hint="Usado no cálculo de budget sugerido" value={goals.weekly_campaign_capacity} onChange={v => setGoal('weekly_campaign_capacity', v)} min={0} step={1} zeroMeansIgnored />
        </div>

        {/* Dayparting e Posicionamento */}
        <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-3">Automações</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
          {[
            {
              key: 'pacing_enabled',
              label: 'Pacing do Orçamento',
              hint: 'Controla ritmo do gasto ao longo do dia',
              activeNote: 'Motor aplica guardrail de orçamento a cada hora',
              inactiveNote: 'Gasto diário não é controlado pelo motor',
            },
            {
              key: 'dayparting_enabled',
              label: 'Dayparting',
              hint: 'Ajusta bids por horário de performance',
              activeNote: 'Bids reduzidos em horários de baixo desempenho automaticamente',
              inactiveNote: 'Bids não variam por horário',
            },
            {
              key: 'placement_optimization_enabled',
              label: 'Otimização de Posicionamento',
              hint: 'Ajusta exposição por placement',
              activeNote: 'Ajustes de Top of Search / Product Pages ativos',
              inactiveNote: 'Nenhum ajuste de placement aplicado',
            },
          ].map(({ key, label, hint, activeNote, inactiveNote }) => {
            const isOn = !!goals[key];
            return (
              <div key={key} className={`flex flex-col p-3 bg-surface-2 rounded-lg border transition-colors ${isOn ? 'border-emerald-500/30' : 'border-surface-3'}`}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isOn ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                    <p className="text-xs font-medium text-slate-300">{label}</p>
                  </div>
                  <Toggle value={isOn} onChange={v => setGoal(key, v)} />
                </div>
                <p className="text-[10px] text-slate-500 mb-1.5">{hint}</p>
                <div className={`text-[10px] px-2 py-1 rounded ${isOn ? 'bg-emerald-500/10 text-emerald-400' : 'bg-surface-3 text-slate-600'}`}>
                  {isOn ? `✓ ${activeNote}` : `✗ ${inactiveNote}`}
                </div>
              </div>
            );
          })}
        </div>

        {/* Top of Search / Placement */}
        {goals.placement_optimization_enabled && (
          <>
            <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-3">Limites de Placement (%)</p>
            <div className="grid grid-cols-3 gap-4 mb-4">
              <NumberInput label="Top of Search Máx." value={goals.top_of_search_limit} onChange={v => setGoal('top_of_search_limit', v)} min={0} max={900} step={5} zeroMeansIgnored />
              <NumberInput label="Rest of Search Máx." value={goals.rest_of_search_limit} onChange={v => setGoal('rest_of_search_limit', v)} min={0} max={900} step={5} zeroMeansIgnored />
              <NumberInput label="Product Pages Máx." value={goals.product_page_limit} onChange={v => setGoal('product_page_limit', v)} min={0} max={900} step={5} zeroMeansIgnored />
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
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 p-4 bg-surface-2 rounded-lg border border-surface-3 mb-1">
          {[
            { label: 'Eficiência', raw: goals.target_acos, fmt: v => `${v}% · ${goals.target_roas}x`, color: 'text-cyan' },
            { label: 'ACoS Máx.', raw: goals.max_acos, fmt: v => `${v}%`, color: 'text-red-400' },
            { label: 'TACoS Alvo', raw: goals.target_tacos, fmt: v => `${v}%`, color: 'text-amber-400' },
            { label: 'CPC Alvo', raw: goals.target_cpc, fmt: v => `R$${Number(v).toFixed(2)}`, color: 'text-violet-400' },
            { label: 'Teto de Lance', raw: goals.max_bid, fmt: v => `R$${Number(v).toFixed(2)}`, color: 'text-emerald-400', noZeroCheck: true },
            { label: 'Budget/dia', raw: goals.daily_budget_limit, fmt: v => `R$${v}`, color: 'text-slate-300', noZeroCheck: true },
          ].map(({ label, raw, fmt, color, noZeroCheck }) => {
            const inactive = !noZeroCheck && (!raw || raw === 0);
            return (
              <div key={label} className="text-center">
                <p className="text-[10px] text-slate-500 mb-0.5">{label}</p>
                <p className={`text-sm font-bold ${inactive ? 'text-slate-500' : color}`}>{inactive ? '—' : fmt(raw)}</p>
              </div>
            );
          })}
        </div>
        {todaySpend && (
          <p className="text-[10px] text-slate-500 px-1 mb-5">
            Gasto hoje: <span className="text-slate-300 font-medium">R$ {Number(todaySpend.confirmed_spend || 0).toFixed(2).replace('.', ',')}</span>
            {' '}de <span className="text-slate-300 font-medium">R$ {Number(goals.daily_budget_limit || 0).toFixed(2).replace('.', ',')}</span>
            {goals.daily_budget_limit > 0 && (
              <span className="text-slate-600"> ({((todaySpend.confirmed_spend / goals.daily_budget_limit) * 100).toFixed(0)}%)</span>
            )}
          </p>
        )}

        {/* Avisos de coerência objetivo × metas (não bloqueiam) */}
        {coherenceWarnings.length > 0 && (
          <div className="mb-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/25 space-y-1">
            {coherenceWarnings.map((w, i) => (
              <p key={i} className="text-[11px] text-amber-300 flex items-center gap-1.5">
                <AlertTriangle className="w-3 h-3 flex-shrink-0" />{w} Você pode continuar mesmo assim.
              </p>
            ))}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button onClick={saveGoals} disabled={goalsSaving || !account}
            className="flex items-center gap-2 px-5 py-2.5 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60">
            {goalsSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : goalsSaved ? <CheckCircle className="w-4 h-4" /> : <Save className="w-4 h-4" />}
            {goalsSaving ? 'Salvando...' : goalsSaved ? '✓ Salvo' : 'Salvar configurações'}
          </button>
          {goalsSaved && (
            <span className="inline-flex items-center gap-1 text-xs text-emerald-400 animate-fade-in">
              <Wifi className="w-3.5 h-3.5" />
              Orçamento sincronizado na Amazon
            </span>
          )}
        </div>
      </div>

      {/* ─── BACKUP ─── */}
      <BackupPanel />

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

            <div className="flex flex-wrap items-center gap-3">
              <button onClick={checkAuth} disabled={authChecking}
                className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold bg-surface-2 border border-surface-3 text-slate-300 hover:text-white rounded-lg transition-colors disabled:opacity-60">
                {authChecking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                {authChecking ? 'Verificando...' : 'Testar conexão'}
              </button>
              <button onClick={testSpApiPrice} disabled={spApiTestLoading || !account}
                className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors disabled:opacity-60">
                {spApiTestLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FlaskConical className="w-3.5 h-3.5" />}
                {spApiTestLoading ? 'Testando...' : 'Testar SP-API (Preço Competitivo)'}
              </button>
              {!authStatus && !authChecking && (
                <p className="text-xs text-slate-600">Clique para testar a conexão com a Amazon.</p>
              )}
            </div>

            {/* Resultado do teste SP-API */}
            {spApiTestResult && (
              <div className={`p-3 rounded-lg border text-xs space-y-2 ${spApiTestResult.ok ? 'border-emerald-400/20 bg-emerald-400/5' : 'border-amber-400/20 bg-amber-400/5'}`}>
                <div className="flex items-center gap-2">
                  {spApiTestResult.ok
                    ? <ShieldCheck className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                    : <ShieldAlert className="w-4 h-4 text-amber-400 flex-shrink-0" />}
                  <span className={`font-semibold ${spApiTestResult.ok ? 'text-emerald-300' : 'text-amber-300'}`}>
                    SP-API Preço Competitivo — {spApiTestResult.ok ? 'Sucesso' : 'Falha'}
                  </span>
                  {spApiTestResult.asin && <span className="text-slate-500 font-mono">{spApiTestResult.asin}</span>}
                </div>
                {spApiTestResult.error && (
                  <p className="text-amber-400/80">{spApiTestResult.error}</p>
                )}
                {spApiTestResult.data && (
                  <pre className="text-[10px] text-slate-400 bg-surface-3 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all max-h-40">
                    {JSON.stringify(spApiTestResult.data, null, 2)}
                  </pre>
                )}
                {!spApiTestResult.ok && (
                  <p className="text-[10px] text-amber-400/70">
                    Se o erro for 401 ou "unauthorized", verifique os secrets: <code>SP_REFRESH_TOKEN</code>, <code>SP_CLIENT_ID</code>, <code>SP_CLIENT_SECRET</code> em Base44 → Settings → Environment Variables.
                  </p>
                )}
              </div>
            )}

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

                {(!authStatus?.services?.ads?.ok || !authStatus?.services?.sp?.ok) && (
                  <div className="mt-3 p-4 bg-red-500/8 border border-red-500/20 rounded-lg space-y-4">
                    <p className="text-xs font-bold text-red-300">🔑 Falha de autenticação — ação necessária</p>

                    {!authStatus?.services?.ads?.ok && (
                      <div className="space-y-2 pb-3 border-b border-surface-3">
                        <p className="text-xs text-slate-300 font-semibold">Amazon Ads API</p>
                        {authStatus?.services?.ads?.error_code === 'unauthorized_client' ? (
                          <>
                            <p className="text-[11px] text-slate-400">
                              O <strong className="text-slate-200">refresh token (ADS_REFRESH_TOKEN)</strong> foi revogado ou expirou.
                              As credenciais Client ID/Secret estão corretas — só o token precisa ser renovado via OAuth.
                            </p>
                            <div className="flex flex-wrap gap-2">
                              <a href="/amazon-oauth-setup"
                                className="inline-flex items-center gap-2 px-3 py-1.5 bg-amber-500/20 border border-amber-500/40 text-amber-300 hover:bg-amber-500/30 rounded-lg text-xs font-semibold transition-colors">
                                <ExternalLink className="w-3 h-3" /> Renovar Token (OAuth) →
                              </a>
                            </div>
                          </>
                        ) : authStatus?.services?.ads?.error_code === 'invalid_client' ? (
                          <>
                            <p className="text-[11px] text-slate-400">
                              <strong className="text-slate-200">ADS_CLIENT_ID</strong> ou <strong className="text-slate-200">ADS_CLIENT_SECRET</strong> estão incorretos.
                              Verifique as variáveis de ambiente no painel Base44 → Settings → Environment Variables.
                            </p>
                          </>
                        ) : (
                          <p className="text-[11px] text-slate-400">{authStatus?.services?.ads?.message || 'Erro desconhecido.'}</p>
                        )}
                      </div>
                    )}

                    {!authStatus?.services?.sp?.ok && (
                      <div className="space-y-2">
                        <p className="text-xs text-slate-300 font-semibold">SP-API (Seller Central)</p>
                        {authStatus?.services?.sp?.error_code === 'invalid_client' ? (
                          <>
                            <p className="text-[11px] text-slate-400">
                              <strong className="text-slate-200">SP_CLIENT_ID</strong> ou <strong className="text-slate-200">SP_CLIENT_SECRET</strong> estão incorretos ou desatualizados.
                              Verifique em Base44 → Settings → Environment Variables se os valores batem com o app LWA no Seller Central.
                            </p>
                            <a href="/sp-api-self-auth"
                              className="inline-flex items-center gap-2 px-3 py-1.5 bg-blue-500/20 border border-blue-500/40 text-blue-300 hover:bg-blue-500/30 rounded-lg text-xs font-semibold transition-colors">
                              <ExternalLink className="w-3 h-3" /> Reconectar SP-API →
                            </a>
                          </>
                        ) : authStatus?.services?.sp?.error_code === 'unauthorized_client' ? (
                          <>
                            <p className="text-[11px] text-slate-400">
                              O <strong className="text-slate-200">SP_REFRESH_TOKEN</strong> foi revogado. Reautorize o app no Seller Central.
                            </p>
                            <a href="/sp-api-self-auth"
                              className="inline-flex items-center gap-2 px-3 py-1.5 bg-blue-500/20 border border-blue-500/40 text-blue-300 hover:bg-blue-500/30 rounded-lg text-xs font-semibold transition-colors">
                              <ExternalLink className="w-3 h-3" /> Reconectar SP-API →
                            </a>
                          </>
                        ) : (
                          <p className="text-[11px] text-slate-400">{authStatus?.services?.sp?.message || 'Erro desconhecido.'}</p>
                        )}
                      </div>
                    )}

                    <div className="text-[10px] text-slate-500 border-t border-surface-3 pt-2 space-y-0.5">
                      <p>Variáveis usadas: <code className="text-slate-400">ADS_CLIENT_ID</code>, <code className="text-slate-400">ADS_CLIENT_SECRET</code>, <code className="text-slate-400">ADS_REFRESH_TOKEN</code>, <code className="text-slate-400">SP_CLIENT_ID</code>, <code className="text-slate-400">SP_CLIENT_SECRET</code>, <code className="text-slate-400">SP_REFRESH_TOKEN</code></p>
                      <p>Confirme que o app LWA ainda está autorizado em <strong className="text-slate-400">sellercentral.amazon.com.br → Aplicativos</strong>.</p>
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
