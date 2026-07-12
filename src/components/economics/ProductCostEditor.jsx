import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { X, Save, History, AlertCircle, CheckCircle, Calculator, Loader2 } from 'lucide-react';

const SAFETY_FACTOR = 0.80;

function normalizeSku(sku) {
  if (!sku) return '';
  return sku.trim().toUpperCase().replace(/\s+/g, '-').replace(/-{2,}/g, '-');
}

function calcBreakEven({ unit_cost, inbound, tax, logistics, packaging, other, amazon_fee, price }) {
  if (!price || price <= 0) return null;
  const totalCost = Number(unit_cost || 0) + Number(inbound || 0) + Number(tax || 0) +
    Number(logistics || 0) + Number(packaging || 0) + Number(other || 0) + Number(amazon_fee || 0);
  const margin = price - totalCost;
  const marginPct = (margin / price) * 100;
  return {
    total_cost: Math.round(totalCost * 100) / 100,
    margin_amount: Math.round(margin * 100) / 100,
    margin_pct: Math.round(marginPct * 100) / 100,
    break_even_acos: Math.round(marginPct * 100) / 100,
    target_acos: Math.round(marginPct * SAFETY_FACTOR * 100) / 100,
    is_profitable: margin > 0,
  };
}

export default function ProductCostEditor({ product, economics, onSave, onClose, mode = 'edit' }) {
  const [form, setForm] = useState({
    unit_cost: '',
    inbound_freight_per_unit: '',
    tax_per_unit: '',
    logistics_cost_per_unit: '',
    packaging_cost_per_unit: '',
    other_variable_cost_per_unit: '',
    other_cost_description: '',
    amazon_fee_amount: '',
    amazon_fee_percent: '',
    current_price: '',
    effective_from: new Date().toISOString().slice(0, 10),
    cost_source: 'manual_confirmed',
    reason: '',
  });
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (economics) {
      setForm(prev => ({
        ...prev,
        unit_cost: economics.unit_cost ?? '',
        inbound_freight_per_unit: economics.inbound_freight_per_unit ?? '',
        tax_per_unit: economics.tax_per_unit ?? '',
        logistics_cost_per_unit: economics.logistics_cost_per_unit ?? '',
        packaging_cost_per_unit: economics.packaging_cost_per_unit ?? '',
        other_variable_cost_per_unit: economics.other_variable_cost_per_unit ?? '',
        other_cost_description: economics.other_cost_description ?? '',
        amazon_fee_amount: economics.amazon_fee_amount ?? '',
        amazon_fee_percent: economics.amazon_fee_percent ?? '',
        current_price: economics.current_price ?? product?.price ?? '',
        cost_source: economics.cost_source || 'manual_confirmed',
      }));
    } else if (product) {
      setForm(prev => ({
        ...prev,
        unit_cost: product.product_cost ?? '',
        current_price: product.price ?? '',
        amazon_fee_percent: product.amazon_fees ? '' : '',
      }));
    }
  }, [economics, product]);

  useEffect(() => {
    const price = Number(form.current_price);
    const feeAmt = form.amazon_fee_amount !== ''
      ? Number(form.amazon_fee_amount)
      : (price > 0 && form.amazon_fee_percent !== '' ? price * (Number(form.amazon_fee_percent) / 100) : 0);
    if (Number(form.unit_cost) > 0) {
      const result = calcBreakEven({
        unit_cost: form.unit_cost, inbound: form.inbound_freight_per_unit,
        tax: form.tax_per_unit, logistics: form.logistics_cost_per_unit,
        packaging: form.packaging_cost_per_unit, other: form.other_variable_cost_per_unit,
        amazon_fee: feeAmt, price,
      });
      setPreview(result);
    } else {
      setPreview(null);
    }
  }, [form]);

  const set = (key, val) => setForm(prev => ({ ...prev, [key]: val }));

  const handleSave = async () => {
    if (!form.unit_cost || Number(form.unit_cost) <= 0) {
      setError('Informe o custo unitário (maior que zero).');
      return;
    }
    if (form.current_price !== '' && Number(form.current_price) <= 0) {
      setError('Preço não pode ser zero. Deixe em branco se desconhecido.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const account = await base44.entities.AmazonAccount.filter({ user_id: (await base44.auth.me()).id }).then(a => a[0]);
      const aid = account?.id || product?.amazon_account_id;
      const price = form.current_price !== '' ? Number(form.current_price) : 0;
      const feeAmt = form.amazon_fee_amount !== ''
        ? Number(form.amazon_fee_amount)
        : (price > 0 && form.amazon_fee_percent !== '' ? price * (Number(form.amazon_fee_percent) / 100) : 0);

      const payload = {
        amazon_account_id: aid,
        items: [{
          sku: product?.sku,
          product_name: product?.product_name || product?.display_name,
          unit_cost: Number(form.unit_cost),
          inbound_freight_per_unit: Number(form.inbound_freight_per_unit || 0),
          tax_per_unit: Number(form.tax_per_unit || 0),
          logistics_cost_per_unit: Number(form.logistics_cost_per_unit || 0),
          packaging_cost_per_unit: Number(form.packaging_cost_per_unit || 0),
          other_variable_cost_per_unit: Number(form.other_variable_cost_per_unit || 0),
          other_cost_description: form.other_cost_description || null,
          amazon_fee_amount: feeAmt,
          amazon_fee_percent: form.amazon_fee_percent !== '' ? Number(form.amazon_fee_percent) : 15,
          current_price: price,
          average_sale_price: price,
          cost_source: form.cost_source,
          price_source: price > 0 ? 'manual_confirmed' : 'unknown',
          fees_source: feeAmt > 0 ? 'manual_confirmed' : 'account_configuration',
          effective_from: form.effective_from,
          reason: form.reason || 'Edição manual pelo usuário',
        }],
      };

      const res = await base44.functions.invoke('importProductEconomics', payload);
      if (!res?.data?.ok) throw new Error(res?.data?.error || 'Erro ao salvar');
      setSuccess(true);
      setTimeout(() => { onSave?.(res.data); }, 1200);
    } catch (e) {
      setError(e.message || 'Erro ao salvar custos.');
    } finally {
      setSaving(false);
    }
  };

  const Field = ({ label, field, placeholder, type = 'number', hint }) => (
    <div>
      <label className="block text-xs text-slate-400 mb-1 font-medium">{label}</label>
      <input
        type={type}
        value={form[field]}
        onChange={e => set(field, e.target.value)}
        placeholder={placeholder || '0,00'}
        step="0.01"
        className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan/50"
      />
      {hint && <p className="text-[10px] text-slate-600 mt-0.5">{hint}</p>}
    </div>
  );

  const productName = product?.display_name || product?.product_name || product?.sku;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="bg-surface-1 border border-surface-2 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-2">
          <div>
            <h2 className="text-sm font-bold text-white">
              {mode === 'new' ? 'Cadastrar custos do produto' : 'Atualizar custos do produto'}
            </h2>
            <p className="text-xs text-slate-400 mt-0.5 truncate max-w-[400px]">{productName}</p>
          </div>
          <button onClick={onClose} className="p-1.5 text-slate-500 hover:text-white rounded-lg transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-5">
          {/* Identificação */}
          <div className="bg-surface-2 rounded-xl p-3 grid grid-cols-3 gap-3 text-xs">
            <div><span className="text-slate-500">ASIN</span><p className="font-mono text-cyan mt-0.5">{product?.asin || '—'}</p></div>
            <div><span className="text-slate-500">SKU</span><p className="font-mono text-slate-300 mt-0.5">{product?.sku || '—'}</p></div>
            <div><span className="text-slate-500">Estoque</span><p className="text-slate-300 mt-0.5">{product?.fba_inventory ?? '—'}</p></div>
          </div>

          {/* Custo principal */}
          <div>
            <p className="text-xs font-semibold text-slate-300 mb-3 uppercase tracking-wider">Custo do Produto</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Custo unitário (CMV) *" field="unit_cost" hint="Custo de fabricação ou compra" />
              <Field label="Frete de entrada por unidade" field="inbound_freight_per_unit" />
              <Field label="Impostos por unidade" field="tax_per_unit" hint="ICMS, PIS, COFINS s/ custo" />
              <Field label="Logística por unidade" field="logistics_cost_per_unit" hint="Prep, fulfillment, armazenagem" />
              <Field label="Embalagem por unidade" field="packaging_cost_per_unit" />
              <Field label="Outros custos variáveis" field="other_variable_cost_per_unit" />
            </div>
            <div className="mt-3">
              <label className="block text-xs text-slate-400 mb-1 font-medium">Descrição dos outros custos</label>
              <input type="text" value={form.other_cost_description}
                onChange={e => set('other_cost_description', e.target.value)}
                placeholder="Ex: royalties, certificações..."
                className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan/50" />
            </div>
          </div>

          {/* Tarifa Amazon */}
          <div>
            <p className="text-xs font-semibold text-slate-300 mb-3 uppercase tracking-wider">Tarifas Amazon</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Tarifa Amazon (R$)" field="amazon_fee_amount" hint="Valor fixo; sobrepõe o %%" />
              <Field label="Tarifa Amazon (%)" field="amazon_fee_percent" hint="Padrão: 15%. Usado quando R$ = 0" />
            </div>
          </div>

          {/* Preço */}
          <div>
            <p className="text-xs font-semibold text-slate-300 mb-3 uppercase tracking-wider">Preço de Venda</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Preço atual (R$)" field="current_price" hint="Não aceita zero como válido" />
            </div>
            {product?.price && (
              <p className="text-[10px] text-slate-500 mt-1">Preço registrado no banco: R$ {Number(product.price).toFixed(2)}</p>
            )}
          </div>

          {/* Vigência */}
          <div>
            <p className="text-xs font-semibold text-slate-300 mb-3 uppercase tracking-wider">Vigência e Registro</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1 font-medium">Data de início de vigência</label>
                <input type="date" value={form.effective_from} onChange={e => set('effective_from', e.target.value)}
                  className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-slate-200 focus:outline-none focus:border-cyan/50" />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1 font-medium">Fonte do custo</label>
                <select value={form.cost_source} onChange={e => set('cost_source', e.target.value)}
                  className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-slate-200 focus:outline-none focus:border-cyan/50">
                  <option value="manual_confirmed">Manual confirmado</option>
                  <option value="manual_confirmed_import">Importação manual confirmada</option>
                  <option value="historical_import">Importação histórica</option>
                  <option value="sp_api_listing">SP-API listing</option>
                  <option value="account_configuration">Configuração da conta</option>
                </select>
              </div>
            </div>
            <div className="mt-3">
              <label className="block text-xs text-slate-400 mb-1 font-medium">Justificativa / Observação</label>
              <input type="text" value={form.reason}
                onChange={e => set('reason', e.target.value)}
                placeholder="Ex: Reajuste do fornecedor em julho/2026"
                className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan/50" />
            </div>
          </div>

          {/* Preview de cálculo */}
          {preview && (
            <div className={`rounded-xl p-4 border ${preview.is_profitable ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-red-500/5 border-red-500/20'}`}>
              <div className="flex items-center gap-2 mb-3">
                <Calculator className="w-4 h-4 text-slate-400" />
                <p className="text-xs font-semibold text-slate-300">Prévia do cálculo econômico</p>
              </div>
              <div className="grid grid-cols-3 gap-3 text-xs">
                <div>
                  <p className="text-slate-500">Custo total/un.</p>
                  <p className="font-bold text-slate-200">R$ {preview.total_cost.toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-slate-500">Margem contribuição</p>
                  <p className={`font-bold ${preview.is_profitable ? 'text-emerald-400' : 'text-red-400'}`}>
                    {preview.margin_pct.toFixed(1)}% (R$ {preview.margin_amount.toFixed(2)})
                  </p>
                </div>
                <div>
                  <p className="text-slate-500">Break-even ACoS</p>
                  <p className="font-bold text-slate-200">{preview.break_even_acos.toFixed(1)}%</p>
                </div>
                <div>
                  <p className="text-slate-500">Target ACoS (80%)</p>
                  <p className="font-bold text-cyan">{preview.target_acos.toFixed(1)}%</p>
                </div>
                {!Number(form.current_price) && (
                  <div className="col-span-2">
                    <p className="text-amber-400 text-[10px]">⚠ Informe o preço para calcular ACoS e CPC máximo</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Histórico anterior */}
          {economics && (
            <div className="bg-surface-2 rounded-xl p-3">
              <div className="flex items-center gap-1.5 mb-1">
                <History className="w-3 h-3 text-slate-500" />
                <p className="text-[10px] text-slate-500">Último registro</p>
              </div>
              <div className="grid grid-cols-3 gap-2 text-[10px]">
                <div><span className="text-slate-600">Custo anterior:</span> <span className="text-slate-400">R$ {Number(economics.unit_cost || 0).toFixed(2)}</span></div>
                <div><span className="text-slate-600">Status:</span> <span className="text-slate-400">{economics.economics_status}</span></div>
                <div><span className="text-slate-600">Atualizado:</span> <span className="text-slate-400">{economics.updated_at ? new Date(economics.updated_at).toLocaleDateString('pt-BR') : '—'}</span></div>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />{error}
            </div>
          )}
          {success && (
            <div className="flex items-center gap-2 px-3 py-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-xs text-emerald-400">
              <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" />Custos salvos com sucesso!
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-surface-2">
          <button onClick={onClose} className="px-4 py-2 text-xs text-slate-400 hover:text-white transition-colors">Cancelar</button>
          <button onClick={handleSave} disabled={saving || success}
            className="flex items-center gap-2 px-5 py-2 text-xs font-semibold bg-cyan/20 border border-cyan/30 text-cyan hover:bg-cyan/30 rounded-lg transition-colors disabled:opacity-50">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {saving ? 'Salvando...' : 'Salvar custos'}
          </button>
        </div>
      </div>
    </div>
  );
}