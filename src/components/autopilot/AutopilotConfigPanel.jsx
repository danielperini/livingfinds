import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Save, Loader2, Shield, Zap, AlertTriangle } from 'lucide-react';

const DEFAULTS = {
  acos_target: 25,
  roas_target: 4,
  daily_budget_limit: 500,
  max_bid_increase_pct: 15,
  max_bid_decrease_pct: 20,
  min_bid: 0.10,
  max_bid: 5.00,
  auto_apply_enabled: false,
  approval_required: true,
  emergency_pause_enabled: true,
  learning_enabled: true,
};

export default function AutopilotConfigPanel({ amazonAccountId, onConfigSaved }) {
  const [form, setForm] = useState(DEFAULTS);
  const [configId, setConfigId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [autoModeConfirm, setAutoModeConfirm] = useState(false);

  useEffect(() => {
    if (!amazonAccountId) return;
    base44.entities.AutopilotConfig.filter({ amazon_account_id: amazonAccountId }).then(data => {
      if (data[0]) { setForm({ ...DEFAULTS, ...data[0] }); setConfigId(data[0].id); }
    });
  }, [amazonAccountId]);

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      const payload = { ...form, amazon_account_id: amazonAccountId };
      if (configId) await base44.entities.AutopilotConfig.update(configId, payload);
      else { const c = await base44.entities.AutopilotConfig.create(payload); setConfigId(c.id); }
      setSaved(true);
      onConfigSaved?.();
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const handleAutoMode = (val) => {
    if (val && !autoModeConfirm) {
      const ok = window.confirm(
        '⚠️ MODO AUTOMÁTICO\n\n' +
        'Ao ativar, o agente poderá alterar campanhas, bids e orçamentos via Amazon Ads API sem aprovação manual.\n\n' +
        '"Entendo que o agente poderá alterar campanhas, bids e orçamentos via Amazon Ads API."\n\n' +
        'Clique OK para confirmar.'
      );
      if (!ok) return;
      setAutoModeConfirm(true);
    }
    set('auto_apply_enabled', val);
  };

  const Field = ({ label, k, type = 'number', step = 1, min, max, hint }) => (
    <div>
      <label className="block text-xs text-slate-400 mb-1">{label}</label>
      <input
        type={type} value={form[k] ?? ''} step={step} min={min} max={max}
        onChange={e => set(k, type === 'number' ? Number(e.target.value) : e.target.value)}
        className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50"
      />
      {hint && <p className="text-xs text-slate-600 mt-0.5">{hint}</p>}
    </div>
  );

  const Toggle = ({ label, k, danger, hint }) => (
    <div className={`flex items-center justify-between p-3 rounded-xl border ${danger ? 'border-amber-400/20 bg-amber-400/5' : 'border-surface-2 bg-surface-1'}`}>
      <div>
        <p className="text-sm font-medium text-slate-300">{label}</p>
        {hint && <p className="text-xs text-slate-500">{hint}</p>}
      </div>
      <button onClick={() => k === 'auto_apply_enabled' ? handleAutoMode(!form[k]) : set(k, !form[k])}
        className={`relative w-11 h-6 rounded-full transition-colors ${form[k] ? (danger ? 'bg-amber-500' : 'bg-cyan') : 'bg-surface-3'}`}>
        <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${form[k] ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </button>
    </div>
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-cyan" />
          <h3 className="text-sm font-semibold text-white">Configuração Global do Autopilot</h3>
        </div>
        <button onClick={save} disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg disabled:opacity-50 transition-colors">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? '✓ Salvo' : <><Save className="w-4 h-4" /> Salvar</>}
        </button>
      </div>

      {/* Metas */}
      <div>
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Metas de Performance</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Field label="ACoS Alvo (%)" k="acos_target" min={1} max={100} hint="Ex: 25 = 25%" />
          <Field label="ROAS Alvo (x)" k="roas_target" step={0.1} min={0.1} hint="Ex: 4 = 4x retorno" />
          <Field label="Orçamento Máximo Diário ($)" k="daily_budget_limit" min={1} hint="Limite total da conta" />
        </div>
      </div>

      {/* Lances */}
      <div>
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Limites de Lance</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Field label="Bid Mínimo ($)" k="min_bid" step={0.01} min={0.02} />
          <Field label="Bid Máximo ($)" k="max_bid" step={0.10} min={0.10} />
          <Field label="Aumento Máx. (%)" k="max_bid_increase_pct" min={1} max={50} />
          <Field label="Redução Máx. (%)" k="max_bid_decrease_pct" min={1} max={50} />
        </div>
      </div>

      {/* Comportamento */}
      <div>
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Comportamento do Agente</p>
        <div className="space-y-2">
          <Toggle label="Aprovação Manual Obrigatória" k="approval_required" hint="Decisões precisam de aprovação antes de executar" />
          <Toggle label="Pausa de Emergência" k="emergency_pause_enabled" hint="Pausar campanhas com gasto muito alto sem vendas" />
          <Toggle label="Aprendizado Contínuo" k="learning_enabled" hint="Agente aprende com resultados anteriores" />
          <Toggle
            label="Modo Automático — Aplicar sem aprovação"
            k="auto_apply_enabled"
            danger
            hint="Ação em bids de baixo risco aplicada automaticamente"
          />
          {form.auto_apply_enabled && (
            <div className="flex items-start gap-2 p-3 bg-amber-400/10 border border-amber-400/20 rounded-xl">
              <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-300">Modo Automático ATIVO. Bids de baixo risco serão alterados sem aprovação. Pausas, negativações e aumento de orçamento ainda requerem aprovação manual.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}