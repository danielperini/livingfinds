import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Settings as SettingsIcon, CheckCircle, AlertTriangle, Loader2, Save, Zap, RefreshCw, ShieldAlert, ShieldCheck, WifiOff, ExternalLink, DollarSign, Package, BarChart2, Key, Target } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';

export default function Settings() {
  const [user, setUser] = useState(null);
  const [account, setAccount] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [authStatus, setAuthStatus] = useState(null);
  const [authChecking, setAuthChecking] = useState(false);
  const [secretsPreview, setSecretsPreview] = useState(null);
  const [secretsLoading, setSecretsLoading] = useState(false);
  const [bulkBidLoading, setBulkBidLoading] = useState(false);
  const [bulkBidResult, setBulkBidResult] = useState(null);
  const [bulkBidConfirm, setBulkBidConfirm] = useState(false);
  const [form, setForm] = useState({
    seller_name: '',
    marketplace_id: '',
    ads_profile_id: '',
    region: 'NA',
    ai_auto_optimization: false,
    max_daily_budget_limit: 1000,
    max_bid_change_pct: 20,
  });
  const [autopilotConfig, setAutopilotConfig] = useState(null);
  const [goalsForm, setGoalsForm] = useState({
    target_acos: 25,
    maximum_acos: 40,
    target_roas: 4,
    target_tacos: 10,
    maximum_tacos: 12,
    total_daily_budget: 500,
    min_bid: 0.10,
    max_bid: 5.00,
    max_bid_increase_pct: 15,
    max_bid_decrease_pct: 20,
    objective: 'profitability',
    // CPC
    target_cpc: 0,
    maximum_cpc: 0,
    cpc_enforcement: false,
    // Budget Diário
    daily_budget_target: 0,
    daily_budget_locked: false,
    daily_budget_source: 'auto',
  });
  const [goalsSaving, setGoalsSaving] = useState(false);
  const [goalsSaved, setGoalsSaved] = useState(false);

  useEffect(() => {
    base44.auth.me().then(me => {
      setUser(me);
      return base44.entities.AmazonAccount.filter({ user_id: me.id });
    }).then(accounts => {
      if (accounts.length > 0) {
        const acc = accounts[0];
        setAccount(acc);
        setForm({
          seller_name: acc.seller_name || '',
          marketplace_id: acc.marketplace_id || '',
          ads_profile_id: acc.ads_profile_id || '',
          region: acc.region || 'NA',
          ai_auto_optimization: acc.ai_auto_optimization || false,
          max_daily_budget_limit: acc.max_daily_budget_limit || 1000,
          max_bid_change_pct: acc.max_bid_change_pct || 20,
        });
        // Carregar AutopilotConfig
        base44.entities.AutopilotConfig.filter({ amazon_account_id: acc.id }).then(configs => {
          if (configs.length > 0) {
            const cfg = configs[0];
            setAutopilotConfig(cfg);
            setGoalsForm({
              target_acos: cfg.target_acos ?? 25,
              maximum_acos: cfg.maximum_acos ?? 40,
              target_roas: cfg.target_roas ?? 4,
              target_tacos: cfg.target_tacos ?? 10,
              maximum_tacos: cfg.maximum_tacos ?? 12,
              total_daily_budget: cfg.total_daily_budget ?? 500,
              min_bid: cfg.min_bid ?? 0.10,
              max_bid: cfg.max_bid ?? 5.00,
              max_bid_increase_pct: cfg.max_bid_increase_pct ?? 15,
              max_bid_decrease_pct: cfg.max_bid_decrease_pct ?? 20,
              objective: cfg.objective ?? 'profitability',
              target_cpc: cfg.target_cpc ?? 0,
              maximum_cpc: cfg.maximum_cpc ?? 0,
              cpc_enforcement: cfg.cpc_enforcement ?? false,
              daily_budget_target: cfg.daily_budget_target ?? 0,
              daily_budget_locked: cfg.daily_budget_locked ?? false,
              daily_budget_source: cfg.daily_budget_source ?? 'auto',
            });
          }
        }).catch(() => {});
      }
    }).catch(console.error);
  }, []);

  const saveAccount = async () => {
    if (!user) return;
    setSaving(true);
    try {
      if (account) {
        await base44.entities.AmazonAccount.update(account.id, form);
      } else {
        const created = await base44.entities.AmazonAccount.create({ user_id: user.id, ...form, status: 'pending', mode: 'real' });
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

  const loadSecretsPreview = async () => {
    setSecretsLoading(true);
    try {
      const res = await base44.functions.invoke('getAdsSecretsPreview', {});
      setSecretsPreview(res?.data || null);
    } catch (e) {
      setSecretsPreview({ ok: false, error: e.message });
    } finally {
      setSecretsLoading(false);
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

  const runBulkBid = async () => {
    if (!account) return;
    setBulkBidLoading(true);
    setBulkBidResult(null);
    setBulkBidConfirm(false);
    try {
      const res = await base44.functions.invoke('bulkSetAllBids', { amazon_account_id: account.id, bid: 0.60 });
      const d = res.data;
      if (d?.ok) {
        setBulkBidResult({ ok: true, message: `✓ ${d.keywords?.ok || 0} keywords + ${d.ad_groups?.ok || 0} ad groups atualizados para R$0,60` });
      } else {
        setBulkBidResult({ ok: false, message: d?.error || `Falha: ${d?.keywords?.failed || 0} keywords com erro` });
      }
    } catch (e) {
      setBulkBidResult({ ok: false, message: e.message });
    } finally {
      setBulkBidLoading(false);
    }
  };

  const runSync = async () => {
    if (!account) return;
    setSyncLoading(true);
    setSyncResult(null);
    try {
      const res = await base44.functions.invoke('syncAds', { amazon_account_id: account.id });
      const d = res.data;
      setSyncResult({ ok: d?.ok, message: d?.ok ? `✓ ${d.records_upserted || 0} campanhas sincronizadas` : (d?.error || 'Erro') });
    } catch (e) {
      setSyncResult({ ok: false, message: e.message });
    } finally {
      setSyncLoading(false);
    }
  };

  const saveGoals = async () => {
    if (!account) return;
    setGoalsSaving(true);
    try {
      // Aplicar redutor: total_daily_budget sempre entre R$50 e R$65
      const sanitized = {
        ...goalsForm,
        total_daily_budget: Math.min(70, Math.max(goalsForm.total_daily_budget > 0 ? 50 : 0, goalsForm.total_daily_budget)),
      };
      if (autopilotConfig) {
        await base44.entities.AutopilotConfig.update(autopilotConfig.id, sanitized);
        setGoalsForm(p => ({ ...p, total_daily_budget: sanitized.total_daily_budget }));
      } else {
        const created = await base44.entities.AutopilotConfig.create({ amazon_account_id: account.id, ...sanitized });
        setAutopilotConfig(created);
      }
      setGoalsSaved(true);
      setTimeout(() => setGoalsSaved(false), 3000);
    } catch (err) {
      alert(`Erro ao salvar metas: ${err.message}`);
    } finally {
      setGoalsSaving(false);
    }
  };

  const fields = [
    { key: 'seller_name', label: 'Nome do Seller', placeholder: 'Ex: My Store LLC' },
    { key: 'marketplace_id', label: 'Marketplace ID', placeholder: 'Ex: ATVPDKIKX0DER' },
    { key: 'ads_profile_id', label: 'Ads Profile ID', placeholder: 'Ex: 1234567890' },
    { key: 'region', label: 'Região', placeholder: 'NA / EU / FE' },
  ];

  return (
    <div className="p-6 space-y-6 max-w-3xl animate-fade-in">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
          <SettingsIcon className="w-5 h-5 text-cyan" />
        </div>
        <h1 className="text-lg font-bold text-white">Configurações</h1>
      </div>

      {/* Status da Conta */}
      {account && (
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-4">
            <StatusBadge status={account.status || 'pending'} />
            <div className="flex-1">
              <p className="text-sm font-semibold text-white">{account.seller_name || 'Conta Amazon'}</p>
              <p className="text-xs text-slate-500">Último sync: {account.last_sync_at ? new Date(account.last_sync_at).toLocaleString('pt-BR') : 'Nunca'}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Seller ID', value: account.seller_id, icon: Package },
              { label: 'Marketplace ID', value: account.marketplace_id, icon: BarChart2 },
              { label: 'Ads Profile ID', value: account.ads_profile_id, icon: Key },
              { label: 'Moeda', value: `${account.currency_code || 'BRL'} (${account.currency_symbol || 'R$'})`, icon: DollarSign },
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
        </div>
      )}

      {/* Configurações da Conta */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-6">
        <h2 className="text-sm font-semibold text-white mb-5">Configurações da Conta Amazon</h2>
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {fields.map(f => (
              <div key={f.key}>
                <label className="block text-xs text-slate-400 mb-1.5">{f.label}</label>
                <input
                  value={form[f.key]}
                  onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white placeholder-slate-600 focus:outline-none focus:border-cyan/50"
                />
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Orçamento Máximo Diário ($)</label>
              <input type="number" value={form.max_daily_budget_limit}
                onChange={e => setForm(p => ({ ...p, max_daily_budget_limit: parseFloat(e.target.value) || 0 }))}
                className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Alteração Máxima de Bid (%)</label>
              <input type="number" value={form.max_bid_change_pct}
                onChange={e => setForm(p => ({ ...p, max_bid_change_pct: parseFloat(e.target.value) || 0 }))}
                className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50" />
            </div>
          </div>

          <div className="flex items-start justify-between p-4 bg-surface-2 rounded-lg border border-surface-3">
            <div>
              <p className="text-sm font-medium text-white">Otimização Automática AI</p>
              <p className="text-xs text-slate-500 mt-0.5">Quando ativo, o Learner executa decisões automaticamente sem revisão manual.</p>
              {form.ai_auto_optimization && (
                <div className="flex items-center gap-1.5 mt-2 text-xs text-amber-400">
                  <AlertTriangle className="w-3 h-3" /> Modo automático ativo — decisões sem revisão.
                </div>
              )}
            </div>
            <button onClick={() => setForm(p => ({ ...p, ai_auto_optimization: !p.ai_auto_optimization }))}
              className={`relative w-11 h-6 rounded-full transition-colors duration-200 flex-shrink-0 ml-4 ${form.ai_auto_optimization ? 'bg-cyan' : 'bg-surface-3'}`}>
              <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-all duration-200 ${form.ai_auto_optimization ? 'left-6' : 'left-1'}`} />
            </button>
          </div>
        </div>

        <button onClick={saveAccount} disabled={saving}
          className="mt-6 flex items-center gap-2 px-5 py-2.5 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <CheckCircle className="w-4 h-4" /> : <Save className="w-4 h-4" />}
          {saving ? 'Guardando...' : saved ? 'Guardado!' : 'Guardar Configurações'}
        </button>
      </div>

      {/* Metas de Performance */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-6">
        <div className="flex items-center gap-2 mb-5">
          <Target className="w-4 h-4 text-cyan" />
          <h2 className="text-sm font-semibold text-white">Metas de Performance (Autopilot)</h2>
        </div>

        {/* Objetivo */}
        <div className="mb-5">
          <label className="block text-xs text-slate-400 mb-1.5">Objetivo Principal</label>
          <select value={goalsForm.objective}
            onChange={e => setGoalsForm(p => ({ ...p, objective: e.target.value }))}
            className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50">
            <option value="profitability">Lucratividade — reduzir ACoS e maximizar margem</option>
            <option value="growth">Crescimento — aumentar vendas mantendo ACoS controlado</option>
            <option value="launch">Lançamento — ganhar visibilidade e reviews iniciais</option>
            <option value="defense">Defesa — proteger posição e Brand</option>
            <option value="liquidation">Liquidação — girar estoque rapidamente</option>
            <option value="maintenance">Manutenção — estabilizar sem mudanças agressivas</option>
          </select>
        </div>

        {/* ACoS / ROAS */}
        <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-3">Metas de Eficiência</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-5">
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">ACoS Alvo (%)</label>
            <input type="number" min="1" max="200" step="0.5" value={goalsForm.target_acos}
              onChange={e => setGoalsForm(p => ({ ...p, target_acos: parseFloat(e.target.value) || 0 }))}
              className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50" />
            <p className="text-[10px] text-slate-600 mt-1">Meta primária de gasto/venda</p>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">ACoS Máximo (%)</label>
            <input type="number" min="1" max="500" step="0.5" value={goalsForm.maximum_acos}
              onChange={e => setGoalsForm(p => ({ ...p, maximum_acos: parseFloat(e.target.value) || 0 }))}
              className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50" />
            <p className="text-[10px] text-slate-600 mt-1">Acima disso: pausa ou corte de bid</p>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">ROAS Alvo (x)</label>
            <input type="number" min="0.1" max="50" step="0.1" value={goalsForm.target_roas}
              onChange={e => setGoalsForm(p => ({ ...p, target_roas: parseFloat(e.target.value) || 0 }))}
              className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50" />
            <p className="text-[10px] text-slate-600 mt-1">Retorno mínimo sobre o investimento</p>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">TACoS Alvo (%)</label>
            <input type="number" min="1" max="100" step="0.5" value={goalsForm.target_tacos}
              onChange={e => setGoalsForm(p => ({ ...p, target_tacos: parseFloat(e.target.value) || 0 }))}
              className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50" />
            <p className="text-[10px] text-slate-600 mt-1">Gasto / Vendas Totais (orgânico + ads)</p>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">TACoS Máximo (%)</label>
            <input type="number" min="1" max="200" step="0.5" value={goalsForm.maximum_tacos}
              onChange={e => setGoalsForm(p => ({ ...p, maximum_tacos: parseFloat(e.target.value) || 0 }))}
              className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50" />
            <p className="text-[10px] text-slate-600 mt-1">Limite de risco máximo de TACoS</p>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Orçamento Diário Total (R$)</label>
            <input type="number" min="50" max="70" step="5" value={goalsForm.total_daily_budget}
              onChange={e => setGoalsForm(p => ({ ...p, total_daily_budget: parseFloat(e.target.value) || 0 }))}
              className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50" />
            <p className="text-[10px] text-slate-600 mt-1">Faixa recomendada: R$50 – R$70/dia</p>
          </div>
        </div>

        {/* Controles de Bid */}
        <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-3">Controles de Bid</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Bid Mínimo (R$)</label>
            <input type="number" min="0.02" max="10" step="0.01" value={goalsForm.min_bid}
              onChange={e => setGoalsForm(p => ({ ...p, min_bid: parseFloat(e.target.value) || 0 }))}
              className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50" />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Bid Máximo (R$)</label>
            <input type="number" min="0.10" max="100" step="0.10" value={goalsForm.max_bid}
              onChange={e => setGoalsForm(p => ({ ...p, max_bid: parseFloat(e.target.value) || 0 }))}
              className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50" />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Aumento Máx. de Bid (%)</label>
            <input type="number" min="1" max="100" step="1" value={goalsForm.max_bid_increase_pct}
              onChange={e => setGoalsForm(p => ({ ...p, max_bid_increase_pct: parseFloat(e.target.value) || 0 }))}
              className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50" />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Redução Máx. de Bid (%)</label>
            <input type="number" min="1" max="100" step="1" value={goalsForm.max_bid_decrease_pct}
              onChange={e => setGoalsForm(p => ({ ...p, max_bid_decrease_pct: parseFloat(e.target.value) || 0 }))}
              className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50" />
          </div>
        </div>

        {/* Meta de CPC */}
        <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-3 mt-1">Meta de CPC</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-4">
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">CPC Alvo (R$)</label>
            <input type="number" min="0" step="0.01" value={goalsForm.target_cpc}
              onChange={e => setGoalsForm(p => ({ ...p, target_cpc: parseFloat(e.target.value) || 0 }))}
              className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50" />
            <p className="text-[10px] text-slate-600 mt-1">A IA ajusta bids para manter o CPC próximo deste valor</p>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">CPC Máximo (R$)</label>
            <input type="number" min="0" step="0.01" value={goalsForm.maximum_cpc}
              onChange={e => setGoalsForm(p => ({ ...p, maximum_cpc: parseFloat(e.target.value) || 0 }))}
              className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50" />
            <p className="text-[10px] text-slate-600 mt-1">Acima disso: bid reduzido automaticamente</p>
          </div>
          <div className="flex flex-col justify-between">
            <label className="block text-xs text-slate-400 mb-1.5">Enforçar CPC Máximo</label>
            <div className="flex items-center justify-between p-3 bg-surface-2 rounded-lg border border-surface-3 h-[42px]">
              <span className="text-xs text-slate-300">{goalsForm.cpc_enforcement ? 'Ativo' : 'Inativo'}</span>
              <button onClick={() => setGoalsForm(p => ({ ...p, cpc_enforcement: !p.cpc_enforcement }))}
                className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${goalsForm.cpc_enforcement ? 'bg-cyan' : 'bg-surface-3'}`}>
                <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${goalsForm.cpc_enforcement ? 'left-5' : 'left-0.5'}`} />
              </button>
            </div>
            <p className="text-[10px] text-slate-600 mt-1">Bloqueia aumentos de bid acima do CPC máx.</p>
          </div>
        </div>

        {/* Orçamento Diário Gerenciado */}
        <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-3 mt-1">Orçamento Diário Gerenciado</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Budget Diário Alvo (R$)</label>
            <div className="flex gap-2">
              <input type="number" min="0" step="10" value={goalsForm.daily_budget_target}
                onChange={e => setGoalsForm(p => ({ ...p, daily_budget_target: parseFloat(e.target.value) || 0 }))}
                className="flex-1 px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50" />
              {autopilotConfig?.ai_suggested_daily_budget > 0 && (
                <button
                  onClick={() => setGoalsForm(p => ({ ...p, daily_budget_target: autopilotConfig.ai_suggested_daily_budget, daily_budget_source: 'ai_suggestion' }))}
                  className="px-2.5 py-2 bg-violet-500/15 border border-violet-500/25 text-violet-300 hover:bg-violet-500/25 text-[10px] rounded-lg whitespace-nowrap transition-colors">
                  Usar sugestão IA<br/>R${autopilotConfig.ai_suggested_daily_budget.toFixed(2)}
                </button>
              )}
            </div>
            <p className="text-[10px] text-slate-600 mt-1">Define o teto de gasto diário que a IA perseguirá</p>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Modo de Controle</label>
            <select value={goalsForm.daily_budget_source}
              onChange={e => setGoalsForm(p => ({ ...p, daily_budget_source: e.target.value }))}
              className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50">
              <option value="auto">Automático — calculado pela IA</option>
              <option value="ai_suggestion">Sugestão da IA — aprovada pelo gestor</option>
              <option value="manager_fixed">Fixado pelo Gestor — valor acima é obrigatório</option>
            </select>
            <p className="text-[10px] text-slate-600 mt-1">
              {goalsForm.daily_budget_source === 'manager_fixed' ? '⚠️ A IA usará exatamente este valor — sugestões serão ignoradas.' :
               goalsForm.daily_budget_source === 'ai_suggestion' ? 'A IA pode sugerir atualizações, mas o valor foi revisado por você.' :
               'A IA calcula automaticamente com base no histórico.'}
            </p>
          </div>
        </div>
        {goalsForm.daily_budget_source === 'manager_fixed' && goalsForm.daily_budget_target > 0 && (
          <div className="flex items-center gap-2 p-3 bg-amber-500/10 border border-amber-500/25 rounded-lg text-xs text-amber-300 mb-4">
            <span>🔒</span>
            <span><strong>Budget fixado:</strong> R${goalsForm.daily_budget_target.toFixed(2)}/dia. A IA ajustará bids para otimizar o uso deste orçamento sem ultrapassá-lo.</span>
          </div>
        )}

        {/* Indicadores de referência */}
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-3 p-4 bg-surface-2 rounded-lg border border-surface-3 mb-5">
          <div className="text-center">
            <p className="text-[10px] text-slate-500 mb-1">ACoS Alvo</p>
            <p className="text-lg font-bold text-cyan">{goalsForm.target_acos}%</p>
          </div>
          <div className="text-center">
            <p className="text-[10px] text-slate-500 mb-1">ROAS Alvo</p>
            <p className="text-lg font-bold text-emerald-400">{goalsForm.target_roas}x</p>
          </div>
          <div className="text-center">
            <p className="text-[10px] text-slate-500 mb-1">TACoS Alvo</p>
            <p className="text-lg font-bold text-amber-400">{goalsForm.target_tacos}%</p>
          </div>
          <div className="text-center">
            <p className="text-[10px] text-slate-500 mb-1">CPC Alvo</p>
            <p className="text-lg font-bold text-violet-400">{goalsForm.target_cpc > 0 ? `R$${goalsForm.target_cpc.toFixed(2)}` : '—'}</p>
          </div>
          <div className="text-center">
            <p className="text-[10px] text-slate-500 mb-1">Budget/dia</p>
            <p className="text-lg font-bold text-slate-300">
              {goalsForm.daily_budget_target > 0 ? `R$${goalsForm.daily_budget_target.toFixed(0)}` : '—'}
              {goalsForm.daily_budget_source === 'manager_fixed' && <span className="text-[9px] text-amber-400 block">🔒 fixo</span>}
              {goalsForm.daily_budget_source === 'ai_suggestion' && <span className="text-[9px] text-violet-400 block">✓ IA</span>}
            </p>
          </div>
        </div>

        <button onClick={saveGoals} disabled={goalsSaving || !account}
          className="flex items-center gap-2 px-5 py-2.5 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60">
          {goalsSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : goalsSaved ? <CheckCircle className="w-4 h-4" /> : <Save className="w-4 h-4" />}
          {goalsSaving ? 'Salvando...' : goalsSaved ? 'Salvo!' : 'Salvar Metas'}
        </button>
      </div>

      {/* Status de Autenticação Amazon */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-white">Diagnóstico de Credenciais Amazon</h2>
          <button onClick={checkAuth} disabled={authChecking}
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold bg-surface-2 border border-surface-3 text-slate-300 hover:text-white rounded-lg transition-colors disabled:opacity-60">
            {authChecking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
            {authChecking ? 'Verificando...' : 'Verificar Credenciais'}
          </button>
        </div>

        {!authStatus && !authChecking && (
          <p className="text-xs text-slate-500">Clique em "Verificar Credenciais" para testar a conexão com a Amazon.</p>
        )}

        {authStatus && (
          <div className="space-y-3">
            {[
              { key: 'ads', label: 'Amazon Ads API (ADS_REFRESH_TOKEN)', hint: 'Regenere o token em sellercentral.amazon.com.br → Apps & Services → Authorize Apps' },
              { key: 'sp', label: 'SP-API (SP_CLIENT_ID / SP_CLIENT_SECRET)', hint: 'Verifique as credenciais no Amazon Developer Console' },
            ].map(({ key, label, hint }) => {
              const svc = authStatus?.services?.[key];
              const ok = svc?.ok;
              return (
                <div key={key} className={`p-3 rounded-lg border ${ok ? 'border-emerald-400/20 bg-emerald-400/5' : 'border-red-400/20 bg-red-400/5'}`}>
                  <div className="flex items-center gap-2 mb-1">
                    {ok
                      ? <ShieldCheck className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                      : <ShieldAlert className="w-4 h-4 text-red-400 flex-shrink-0" />}
                    <span className={`text-xs font-semibold ${ok ? 'text-emerald-300' : 'text-red-300'}`}>{label}</span>
                  </div>
                  {!ok && svc && (
                    <div className="ml-6 space-y-1">
                      <p className="text-xs text-red-400">
                        Erro: <span className="font-mono">{svc.error_code || svc.message || 'desconhecido'}</span>
                      </p>
                      <p className="text-[10px] text-slate-400">{hint}</p>
                    </div>
                  )}
                </div>
              );
            })}

            {!authStatus?.services?.ads?.ok && (
              <div className="flex items-start gap-2 p-3 bg-amber-400/5 border border-amber-400/20 rounded-lg">
                <WifiOff className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                <div className="text-xs text-amber-300 space-y-2 flex-1">
                  <p className="font-semibold">Reconectar Amazon Ads via OAuth</p>
                  <p className="text-amber-200/80">Clique no botão abaixo para autorizar o acesso. Você será redirecionado para a Amazon e depois de volta para a plataforma automaticamente.</p>
                  <a
                    href={`https://www.amazon.com/ap/oa?client_id=amzn1.application-oa2-client.a30fb7e08c524463acb3611c8d7f71e4&scope=advertising::campaign_management&response_type=code&redirect_uri=https://livingfinds-app.base44.app/amazon-ads-callback`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 px-4 py-2 bg-amber-500/20 border border-amber-500/40 text-amber-300 hover:bg-amber-500/30 rounded-lg font-semibold transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    Autorizar Amazon Ads →
                  </a>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Sync Rápido */}
      {account && (
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <Zap className="w-4 h-4 text-cyan" /> Sync Campanhas (Amazon Ads API)
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">Importa campanhas via credenciais ADS_* configuradas</p>
            </div>
            <button onClick={runSync} disabled={syncLoading}
              className="flex items-center gap-2 px-4 py-2 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60">
              {syncLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              {syncLoading ? 'Sincronizando...' : 'Sincronizar'}
            </button>
          </div>
          {syncResult && (
            <div className={`p-3 rounded-lg border text-xs ${syncResult.ok ? 'border-emerald-400/20 bg-emerald-400/5 text-emerald-300' : 'border-red-400/20 bg-red-400/5 text-red-400'}`}>
              {syncResult.message}
            </div>
          )}
        </div>
      )}

      {/* Bulk Bid Reset */}
      {account && (
        <div className="bg-surface-1 border border-amber-500/20 rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <DollarSign className="w-4 h-4 text-amber-400" /> Bulk Reset de Bids — R$0,60
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">Aplica bid de R$0,60 em <strong className="text-white">todas</strong> as keywords e ad groups ativos/pausados via Amazon API.</p>
            </div>
          </div>

          {!bulkBidConfirm && !bulkBidResult && (
            <button onClick={() => setBulkBidConfirm(true)}
              className="flex items-center gap-2 px-4 py-2 bg-amber-500/20 border border-amber-500/40 text-amber-300 hover:bg-amber-500/30 text-sm font-semibold rounded-lg transition-colors">
              <DollarSign className="w-4 h-4" /> Definir todos bids para R$0,60
            </button>
          )}

          {bulkBidConfirm && !bulkBidLoading && !bulkBidResult && (
            <div className="p-4 bg-amber-400/5 border border-amber-400/30 rounded-lg space-y-3">
              <p className="text-sm text-amber-300 font-semibold">⚠️ Confirmar alteração em massa?</p>
              <p className="text-xs text-slate-400">Esta ação irá alterar o bid de <strong className="text-white">todas</strong> as keywords e ad groups diretamente na Amazon Ads API. Não pode ser desfeita em massa.</p>
              <div className="flex gap-3">
                <button onClick={runBulkBid}
                  className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-black text-sm font-bold rounded-lg transition-colors">
                  Confirmar — Aplicar R$0,60
                </button>
                <button onClick={() => setBulkBidConfirm(false)}
                  className="px-4 py-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white text-sm rounded-lg transition-colors">
                  Cancelar
                </button>
              </div>
            </div>
          )}

          {bulkBidLoading && (
            <div className="flex items-center gap-3 p-4 bg-surface-2 rounded-lg">
              <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
              <span className="text-sm text-slate-300">Aplicando R$0,60 em todas as keywords via Amazon API... pode demorar alguns segundos.</span>
            </div>
          )}

          {bulkBidResult && (
            <div className={`p-3 rounded-lg border text-xs flex items-center justify-between ${bulkBidResult.ok ? 'border-emerald-400/20 bg-emerald-400/5 text-emerald-300' : 'border-red-400/20 bg-red-400/5 text-red-400'}`}>
              <span>{bulkBidResult.message}</span>
              <button onClick={() => setBulkBidResult(null)} className="ml-4 text-slate-500 hover:text-white text-xs">Fechar</button>
            </div>
          )}
        </div>
      )}

      {/* Secrets Info */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-sm font-semibold text-white">Credenciais Amazon (Environment Variables)</h2>
            <p className="text-xs text-slate-400 mt-0.5">Configuradas em Base44 → Settings → Environment Variables.</p>
          </div>
          <button onClick={loadSecretsPreview} disabled={secretsLoading}
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold bg-surface-2 border border-surface-3 text-slate-300 hover:text-white rounded-lg transition-colors disabled:opacity-60">
            {secretsLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {secretsLoading ? 'Carregando...' : 'Ver Valores'}
          </button>
        </div>
        <div className="space-y-2">
          {['ADS_CLIENT_ID', 'ADS_CLIENT_SECRET', 'ADS_REFRESH_TOKEN', 'ADS_PROFILE_ID', 'ADS_REGION',
            'AMAZON_SP_REFRESH_TOKEN', 'AMAZON_LWA_CLIENT_ID', 'AMAZON_LWA_CLIENT_SECRET', 'ANTHROPIC_API_KEY'].map(s => {
            const isSet = secretsPreview?.set?.[s];
            const val   = secretsPreview?.values?.[s];
            return (
              <div key={s} className="flex items-center justify-between p-3 bg-surface-2 rounded-lg border border-surface-3">
                <div className="flex items-center gap-2">
                  <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${secretsPreview ? (isSet ? 'bg-emerald-400' : 'bg-red-400') : 'bg-slate-600'}`} />
                  <code className="text-xs font-mono text-slate-300">{s}</code>
                </div>
                <div className="text-right">
                  {!secretsPreview && <span className="text-xs text-slate-600">—</span>}
                  {secretsPreview && !isSet && <span className="text-xs text-red-400 font-semibold">NÃO CONFIGURADO</span>}
                  {secretsPreview && isSet && (
                    <code className="text-xs font-mono text-slate-400">{val || '(configurado)'}</code>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}