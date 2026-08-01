import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { AlertCircle, Layers3, Loader2, Save, X } from 'lucide-react';

const finite = value => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value));

export default function BulkProductEconomicsEditor({ accountId, rows, onClose, onSave }) {
  const [form, setForm] = useState({
    unit_cost: '', inbound_freight_per_unit: '', tax_per_unit: '', logistics_cost_per_unit: '',
    packaging_cost_per_unit: '', other_variable_cost_per_unit: '', estimated_return_cost: '',
    minimum_margin_pct: '', target_margin_pct: '', repricing: 'preserve', reason: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));

  const save = async () => {
    const numeric = ['unit_cost', 'inbound_freight_per_unit', 'tax_per_unit', 'logistics_cost_per_unit',
      'packaging_cost_per_unit', 'other_variable_cost_per_unit', 'estimated_return_cost'];
    if (numeric.some(key => finite(form[key]) && Number(form[key]) < 0)) {
      setError('Custos em lote não podem ser negativos.');
      return;
    }
    if (finite(form.minimum_margin_pct) && Number(form.minimum_margin_pct) < 15) {
      setError('A margem mínima nunca pode ser inferior a 15%.');
      return;
    }
    if (finite(form.minimum_margin_pct) && finite(form.target_margin_pct) && Number(form.target_margin_pct) < Number(form.minimum_margin_pct)) {
      setError('A margem-alvo deve ser maior ou igual à margem mínima.');
      return;
    }
    const missingCost = rows.filter(row => !finite(form.unit_cost) && !(row.econ?.costs_confirmed_by_user && finite(row.econ?.unit_cost)));
    if (missingCost.length) {
      setError(`${missingCost.length} produto(s) ainda não têm custo. Informe um custo unitário comum ou edite-os individualmente.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const items = rows.map(({ product, econ }) => {
        const item = {
          sku: product.sku,
          product_name: product.display_name || product.product_name,
          unit_cost: finite(form.unit_cost) ? Number(form.unit_cost) : Number(econ.unit_cost),
          reason: form.reason || `Edição em lote de ${rows.length} produtos.`,
        };
        for (const key of numeric.filter(key => key !== 'unit_cost')) {
          item[key] = finite(form[key]) ? Number(form[key]) : Number(econ?.[key] || 0);
        }
        if (finite(form.minimum_margin_pct)) item.minimum_margin_pct = Number(form.minimum_margin_pct);
        if (finite(form.target_margin_pct)) item.target_margin_pct = Number(form.target_margin_pct);
        if (form.repricing !== 'preserve') item.repricing_enabled = form.repricing === 'enable';
        return item;
      });
      const response = await base44.functions.invoke('importProductEconomics', { amazon_account_id: accountId, items });
      const result = response?.data || response;
      if (!result?.ok || result?.error_details?.length) throw new Error(result?.error_details?.[0]?.error || result?.error || 'Falha na edição em lote.');
      onSave?.(result);
    } catch (saveError) {
      setError(saveError?.message || 'Falha na edição em lote.');
    } finally {
      setSaving(false);
    }
  };

  const fields = [
    ['unit_cost', 'Custo do produto/un.'], ['inbound_freight_per_unit', 'Frete de entrada/un.'],
    ['tax_per_unit', 'Impostos adicionais/un.'], ['logistics_cost_per_unit', 'Logística adicional/un.'],
    ['packaging_cost_per_unit', 'Embalagem/un.'], ['other_variable_cost_per_unit', 'Outros custos/un.'],
    ['estimated_return_cost', 'Devolução estimada/un.'], ['minimum_margin_pct', 'Margem mínima (%)'],
    ['target_margin_pct', 'Margem-alvo (%)'],
  ];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="w-full max-w-2xl rounded-2xl border border-surface-2 bg-surface-1">
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-2">
          <div className="flex items-center gap-2"><Layers3 className="w-4 h-4 text-cyan" /><div><h2 className="text-sm font-bold text-white">Editar {rows.length} produtos em lote</h2><p className="text-[10px] text-slate-500">Campos vazios preservam o valor atual.</p></div></div>
          <button onClick={onClose} className="text-slate-500 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {fields.map(([key, label]) => <div key={key}><label className="block text-xs text-slate-400 mb-1">{label}</label><input type="number" min={key === 'minimum_margin_pct' || key === 'target_margin_pct' ? 15 : 0} step="0.01" value={form[key]} onChange={event => set(key, event.target.value)} placeholder="Preservar" className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-slate-200" /></div>)}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div><label className="block text-xs text-slate-400 mb-1">Repricing por produto</label><select value={form.repricing} onChange={event => set('repricing', event.target.value)} className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-slate-200"><option value="preserve">Preservar</option><option value="enable">Solicitar para todos</option><option value="disable">Desativar para todos</option></select></div>
            <div><label className="block text-xs text-slate-400 mb-1">Justificativa</label><input value={form.reason} onChange={event => set('reason', event.target.value)} placeholder="Motivo da edição em lote" className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-slate-200" /></div>
          </div>
          {error && <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400"><AlertCircle className="w-3.5 h-3.5" />{error}</div>}
        </div>
        <div className="flex justify-end gap-3 px-5 py-4 border-t border-surface-2"><button onClick={onClose} className="px-4 py-2 text-xs text-slate-400">Cancelar</button><button onClick={save} disabled={saving} className="flex items-center gap-2 px-5 py-2 text-xs font-semibold bg-cyan/20 border border-cyan/30 text-cyan rounded-lg disabled:opacity-50">{saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}Aplicar em lote</button></div>
      </div>
    </div>
  );
}
