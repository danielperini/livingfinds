import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Sliders, Plus, Trash2, ToggleLeft, ToggleRight, Save, Loader2,
  AlertTriangle, CheckCircle, ChevronDown, ChevronUp, Zap
} from 'lucide-react';

const SCOPE_LABELS = {
  all_campaigns: 'Todas as campanhas',
  campaign_type: 'Tipo de campanha',
  specific_campaign: 'Campanha específica',
};

const ACTION_LABELS = {
  auto_approve: 'Aprovar automaticamente sugestões da IA',
  increase_bid: 'Aumentar bid automaticamente',
  decrease_bid: 'Diminuir bid automaticamente',
  pause_campaign: 'Pausar campanha automaticamente',
  alert_only: 'Apenas alertar (sem ação)',
};

const ACTION_COLORS = {
  auto_approve: 'text-cyan border-cyan/30 bg-cyan/10',
  increase_bid: 'text-emerald-400 border-emerald-400/30 bg-emerald-400/10',
  decrease_bid: 'text-amber-400 border-amber-400/30 bg-amber-400/10',
  pause_campaign: 'text-red-400 border-red-400/30 bg-red-400/10',
  alert_only: 'text-slate-400 border-slate-400/30 bg-slate-400/10',
};

const EMPTY_RULE = {
  name: '',
  is_active: true,
  scope: 'all_campaigns',
  campaign_type_filter: '',
  campaign_id_filter: '',
  acos_min: '',
  acos_max: '',
  action: 'auto_approve',
  bid_change_pct: 10,
  min_impressions: 100,
  min_clicks: 0,
  confidence_threshold: 0.6,
};

function RuleCard({ rule, onToggle, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    await onDelete(rule.id);
  };

  const acosRange = [rule.acos_min, rule.acos_max].filter(v => v != null);
  const acosLabel = acosRange.length === 2
    ? `${rule.acos_min}% – ${rule.acos_max}%`
    : acosRange.length === 1
    ? (rule.acos_min != null ? `≥ ${rule.acos_min}%` : `≤ ${rule.acos_max}%`)
    : 'Qualquer ACoS';

  return (
    <div className={`bg-surface-1 border rounded-xl overflow-hidden transition-all ${rule.is_active ? 'border-surface-2' : 'border-surface-2 opacity-60'}`}>
      <div className="p-4 flex items-center gap-4">
        {/* Toggle */}
        <button onClick={() => onToggle(rule)} className="flex-shrink-0 text-slate-400 hover:text-cyan transition-colors">
          {rule.is_active
            ? <ToggleRight className="w-6 h-6 text-cyan" />
            : <ToggleLeft className="w-6 h-6" />}
        </button>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-sm font-semibold text-white">{rule.name}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${ACTION_COLORS[rule.action]}`}>
              {ACTION_LABELS[rule.action]?.split(' ')[0] + ' ' + (ACTION_LABELS[rule.action]?.split(' ')[1] || '')}
            </span>
          </div>
          <div className="flex items-center gap-3 text-xs text-slate-500 flex-wrap">
            <span>ACoS: <span className="text-slate-300 font-medium">{acosLabel}</span></span>
            <span>Escopo: <span className="text-slate-300">{SCOPE_LABELS[rule.scope]}</span></span>
            {rule.applied_count > 0 && <span>Aplicada <span className="text-cyan font-medium">{rule.applied_count}x</span></span>}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <button onClick={() => setExpanded(v => !v)} className="p-1.5 text-slate-500 hover:text-slate-300 transition-colors">
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          <button onClick={handleDelete} disabled={deleting} className="p-1.5 text-slate-600 hover:text-red-400 transition-colors disabled:opacity-50">
            {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 pt-0 border-t border-surface-2 grid grid-cols-2 sm:grid-cols-3 gap-3">
          {[
            { label: 'Ação', value: ACTION_LABELS[rule.action] },
            { label: 'Escopo', value: SCOPE_LABELS[rule.scope] },
            { label: 'Faixa ACoS', value: acosLabel },
            { label: 'Alteração de Bid', value: rule.bid_change_pct ? `${rule.bid_change_pct}%` : 'N/A' },
            { label: 'Min. Impressões', value: rule.min_impressions ?? 0 },
            { label: 'Confiança mín.', value: rule.confidence_threshold ? `${(rule.confidence_threshold * 100).toFixed(0)}%` : '—' },
          ].map(f => (
            <div key={f.label} className="bg-surface-2 rounded-lg p-2.5">
              <p className="text-xs text-slate-500 mb-0.5">{f.label}</p>
              <p className="text-xs font-medium text-slate-300">{f.value}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function BiddingRulesPanel({ amazonAccountId }) {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_RULE);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState(null);

  const loadRules = useCallback(async () => {
    if (!amazonAccountId) return;
    setLoading(true);
    try {
      const data = await base44.entities.BiddingRule.filter({ amazon_account_id: amazonAccountId }, '-created_date', 50);
      setRules(data);
    } finally {
      setLoading(false);
    }
  }, [amazonAccountId]);

  useEffect(() => { loadRules(); }, [loadRules]);

  const saveRule = async () => {
    if (!form.name || !form.action) return;
    setSaving(true);
    try {
      await base44.entities.BiddingRule.create({
        ...form,
        amazon_account_id: amazonAccountId,
        acos_min: form.acos_min !== '' ? Number(form.acos_min) : null,
        acos_max: form.acos_max !== '' ? Number(form.acos_max) : null,
        bid_change_pct: Number(form.bid_change_pct),
        min_impressions: Number(form.min_impressions),
        min_clicks: Number(form.min_clicks),
        confidence_threshold: Number(form.confidence_threshold),
      });
      setSaved(true);
      setForm(EMPTY_RULE);
      setShowForm(false);
      await loadRules();
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const toggleRule = async (rule) => {
    await base44.entities.BiddingRule.update(rule.id, { is_active: !rule.is_active });
    setRules(prev => prev.map(r => r.id === rule.id ? { ...r, is_active: !r.is_active } : r));
  };

  const deleteRule = async (id) => {
    await base44.entities.BiddingRule.delete(id);
    setRules(prev => prev.filter(r => r.id !== id));
  };

  const set = (key, val) => setForm(p => ({ ...p, [key]: val }));

  const applyRules = async () => {
    setApplying(true);
    setApplyResult(null);
    try {
      const res = await base44.functions.invoke('approveDecision', {
        apply_rules: true,
        amazon_account_id: amazonAccountId,
      });
      const d = res.data;
      setApplyResult({
        ok: d?.ok,
        message: d?.ok
          ? `✓ ${d.auto_approved} sugestões aprovadas automaticamente de ${d.total_checked} analisadas`
          : (d?.error || 'Erro ao aplicar regras'),
      });
    } catch (e) {
      setApplyResult({ ok: false, message: e.message });
    } finally {
      setApplying(false);
      setTimeout(() => setApplyResult(null), 6000);
    }
  };

  const activeCount = rules.filter(r => r.is_active).length;

  return (
    <div className="space-y-4">
      {/* Header da seção */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-cyan/15 border border-cyan/20 flex items-center justify-center">
            <Sliders className="w-4 h-4 text-cyan" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-white">Regras Automáticas de Lances</h2>
            <p className="text-xs text-slate-400">
              {activeCount > 0
                ? <><span className="text-cyan font-medium">{activeCount}</span> {activeCount === 1 ? 'regra ativa' : 'regras ativas'}</>
                : 'Nenhuma regra ativa'}
            </p>
          </div>
        </div>
        <button onClick={() => setShowForm(v => !v)}
          className="flex items-center gap-2 px-3 py-2 bg-cyan hover:bg-cyan/90 text-white text-xs font-semibold rounded-lg transition-colors">
          <Plus className="w-3.5 h-3.5" /> Nova Regra
        </button>
      </div>

      {/* Aplicar Regras + Aviso */}
      <div className="flex items-stretch gap-3">
        <div className="flex-1 flex items-start gap-3 p-4 bg-amber-400/5 border border-amber-400/15 rounded-xl">
          <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-slate-400 leading-relaxed">
            A IA aplica as regras automaticamente após cada Sync. Use <strong className="text-white">"Aplicar Agora"</strong> para processar as sugestões pendentes imediatamente com as regras ativas.
          </p>
        </div>
        {activeCount > 0 && (
          <button onClick={applyRules} disabled={applying}
            className="flex-shrink-0 flex flex-col items-center justify-center gap-1.5 px-5 py-3 bg-cyan hover:bg-cyan/90 text-white font-semibold rounded-xl transition-colors disabled:opacity-60 min-w-[120px]">
            {applying ? <Loader2 className="w-5 h-5 animate-spin" /> : <Zap className="w-5 h-5" />}
            <span className="text-xs">{applying ? 'Aplicando...' : 'Aplicar Agora'}</span>
          </button>
        )}
      </div>

      {applyResult && (
        <div className={`p-3 rounded-xl border text-xs font-medium ${applyResult.ok ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300' : 'bg-red-400/10 border-red-400/20 text-red-400'}`}>
          {applyResult.message}
        </div>
      )}

      {/* Formulário de nova regra */}
      {showForm && (
        <div className="bg-surface-1 border border-cyan/20 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <Zap className="w-4 h-4 text-cyan" /> Nova Regra Automática
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label className="block text-xs text-slate-400 mb-1.5">Nome da Regra *</label>
              <input value={form.name} onChange={e => set('name', e.target.value)}
                placeholder="Ex: Reduzir bid quando ACoS alto"
                className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white placeholder-slate-600 focus:outline-none focus:border-cyan/50" />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1.5">ACoS Mínimo (%)</label>
              <input type="number" value={form.acos_min} onChange={e => set('acos_min', e.target.value)}
                placeholder="Ex: 0 (sem limite inferior)"
                className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white placeholder-slate-600 focus:outline-none focus:border-cyan/50" />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1.5">ACoS Máximo (%)</label>
              <input type="number" value={form.acos_max} onChange={e => set('acos_max', e.target.value)}
                placeholder="Ex: 35"
                className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white placeholder-slate-600 focus:outline-none focus:border-cyan/50" />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Ação *</label>
              <select value={form.action} onChange={e => set('action', e.target.value)}
                className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50">
                {Object.entries(ACTION_LABELS).map(([val, label]) => (
                  <option key={val} value={val}>{label}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Escopo</label>
              <select value={form.scope} onChange={e => set('scope', e.target.value)}
                className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50">
                {Object.entries(SCOPE_LABELS).map(([val, label]) => (
                  <option key={val} value={val}>{label}</option>
                ))}
              </select>
            </div>

            {(form.action === 'increase_bid' || form.action === 'decrease_bid') && (
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Alteração de Bid (%)</label>
                <input type="number" value={form.bid_change_pct} onChange={e => set('bid_change_pct', e.target.value)}
                  min={1} max={100}
                  className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50" />
              </div>
            )}

            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Mín. Impressões</label>
              <input type="number" value={form.min_impressions} onChange={e => set('min_impressions', e.target.value)}
                className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50" />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Confiança mínima da IA (0–1)</label>
              <input type="number" value={form.confidence_threshold} onChange={e => set('confidence_threshold', e.target.value)}
                step={0.05} min={0} max={1}
                className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white focus:outline-none focus:border-cyan/50" />
            </div>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button onClick={saveRule} disabled={saving || !form.name}
              className="flex items-center gap-2 px-4 py-2 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg disabled:opacity-50 transition-colors">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <CheckCircle className="w-4 h-4" /> : <Save className="w-4 h-4" />}
              {saving ? 'Guardando...' : 'Guardar Regra'}
            </button>
            <button onClick={() => { setShowForm(false); setForm(EMPTY_RULE); }}
              className="px-4 py-2 text-slate-400 hover:text-slate-200 text-sm transition-colors">Cancelar</button>
          </div>
        </div>
      )}

      {/* Lista de regras */}
      {loading ? (
        <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 text-cyan animate-spin" /></div>
      ) : rules.length === 0 ? (
        <div className="border border-dashed border-surface-3 rounded-xl p-6">
          <div className="text-center mb-5">
            <Sliders className="w-8 h-8 text-slate-600 mx-auto mb-2" />
            <p className="text-sm font-semibold text-slate-400">Nenhuma regra configurada</p>
            <p className="text-xs text-slate-600 mt-1">Crie regras para a IA aprovar lances automaticamente dentro dos seus limites de ACoS.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {[
              { name: 'ACoS Conservador', desc: 'ACoS ≤ 25% → aprovar sugestões', acos_max: 25, action: 'auto_approve' },
              { name: 'ACoS Agressivo', desc: 'ACoS ≤ 40% → aprovar sugestões', acos_max: 40, action: 'auto_approve' },
              { name: 'ACoS Alto → Pausar', desc: 'ACoS > 60% → pausar campanha', acos_min: 60, action: 'pause_campaign' },
            ].map(tmpl => (
              <button key={tmpl.name} onClick={() => {
                setForm({ ...EMPTY_RULE, name: tmpl.name, acos_max: tmpl.acos_max ?? '', acos_min: tmpl.acos_min ?? '', action: tmpl.action });
                setShowForm(true);
              }} className="text-left p-3 bg-surface-2 hover:bg-surface-3 border border-surface-3 hover:border-cyan/30 rounded-lg transition-colors">
                <p className="text-xs font-semibold text-slate-300 mb-0.5">{tmpl.name}</p>
                <p className="text-xs text-slate-500">{tmpl.desc}</p>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {rules.map(rule => (
            <RuleCard key={rule.id} rule={rule} onToggle={toggleRule} onDelete={deleteRule} />
          ))}
        </div>
      )}
    </div>
  );
}