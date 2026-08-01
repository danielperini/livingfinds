import { useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { AlertCircle, Calculator, CheckCircle, History, Loader2, Save, ShieldCheck, X } from 'lucide-react';

const money = value => value == null || Number.isNaN(Number(value))
  ? '—'
  : `R$ ${Number(value).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const finite = value => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value));
const round = value => Math.round((value + Number.EPSILON) * 100) / 100;

function economicsAt(price, form, economics) {
  if (!finite(price) || Number(price) <= 0 || !finite(form.unit_cost)) return null;
  const referral = finite(economics?.amazon_fee_percent) ? Number(economics.amazon_fee_percent) : null;
  const fba = finite(economics?.fba_fee) ? Number(economics.fba_fee) : null;
  const fixed = finite(economics?.amazon_fixed_fee) ? Number(economics.amazon_fixed_fee) : null;
  const ads = finite(economics?.estimated_ads_cost_per_order) ? Number(economics.estimated_ads_cost_per_order) : null;
  const verified = String(economics?.fees_source || '').startsWith('sp_api') && economics?.fees_verified_at &&
    economics?.ads_cost_source && economics.ads_cost_source !== 'missing' && economics?.ads_cost_verified_at;
  if (!verified || referral === null || fba === null || fixed === null || ads === null) return null;
  const fixedCosts = ['unit_cost', 'inbound_freight_per_unit', 'tax_per_unit', 'logistics_cost_per_unit',
    'packaging_cost_per_unit', 'other_variable_cost_per_unit', 'estimated_return_cost']
    .reduce((sum, key) => sum + Number(form[key] || 0), 0) + fba + fixed + ads;
  const fee = Number(price) * referral / 100;
  const profit = Number(price) - fixedCosts - fee;
  return { profit: round(profit), margin: round(profit / Number(price) * 100), total: round(fixedCosts + fee) };
}

function priceForMargin(form, economics, marginPct) {
  if (!economicsAt(Number(economics?.current_price || 1), form, economics)) return null;
  let low = 0.01;
  let high = 1000000;
  for (let index = 0; index < 80; index += 1) {
    const middle = (low + high) / 2;
    const result = economicsAt(middle, form, economics);
    if (!result || result.margin < marginPct) low = middle;
    else high = middle;
  }
  return Math.ceil(high * 100 - 1e-7) / 100;
}

function Field({ label, field, form, set, hint, min = 0 }) {
  return (
    <div>
      <label className="block text-xs text-slate-400 mb-1 font-medium">{label}</label>
      <input type="number" min={min} step="0.01" value={form[field]}
        onChange={event => set(field, event.target.value)} placeholder="0,00"
        className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan/50" />
      {hint && <p className="text-[10px] text-slate-600 mt-0.5">{hint}</p>}
    </div>
  );
}

export default function ProductCostEditor({ product, economics, onSave, onClose, mode = 'edit' }) {
  const [form, setForm] = useState({
    unit_cost: '', inbound_freight_per_unit: '', tax_per_unit: '', logistics_cost_per_unit: '',
    packaging_cost_per_unit: '', other_variable_cost_per_unit: '', estimated_return_cost: '',
    other_cost_description: '', minimum_margin_pct: 15, target_margin_pct: 20,
    manual_min_price: '', manual_max_price: '', repricing_enabled: false,
    effective_from: new Date().toISOString().slice(0, 10), reason: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    setForm(current => ({
      ...current,
      unit_cost: economics?.costs_confirmed_by_user ? economics.unit_cost ?? '' : product?.cost_confirmed ? product.product_cost ?? '' : '',
      inbound_freight_per_unit: economics?.inbound_freight_per_unit ?? '',
      tax_per_unit: economics?.tax_per_unit ?? '',
      logistics_cost_per_unit: economics?.logistics_cost_per_unit ?? '',
      packaging_cost_per_unit: economics?.packaging_cost_per_unit ?? '',
      other_variable_cost_per_unit: economics?.other_variable_cost_per_unit ?? '',
      estimated_return_cost: economics?.estimated_return_cost ?? '',
      other_cost_description: economics?.other_cost_description ?? '',
      minimum_margin_pct: economics?.minimum_margin_pct ?? 15,
      target_margin_pct: economics?.target_margin_pct ?? 20,
      manual_min_price: economics?.manual_min_price ?? '',
      manual_max_price: economics?.manual_max_price ?? '',
      repricing_enabled: economics?.repricing_requested === true || economics?.repricing_enabled === true,
    }));
  }, [economics, product]);

  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const currentPrice = economics?.current_price > 0 ? economics.current_price : product?.price;
  const preview = useMemo(() => economicsAt(currentPrice, form, economics), [currentPrice, economics, form]);
  const minimumPrice = useMemo(() => priceForMargin(form, economics, Math.max(15, Number(form.minimum_margin_pct || 15))), [form, economics]);
  const targetPrice = useMemo(() => priceForMargin(form, economics, Math.max(15, Number(form.target_margin_pct || 20))), [form, economics]);
  const dataComplete = Boolean(preview && economics?.price_source?.startsWith('sp_api'));

  const handleSave = async () => {
    const numericFields = ['unit_cost', 'inbound_freight_per_unit', 'tax_per_unit', 'logistics_cost_per_unit',
      'packaging_cost_per_unit', 'other_variable_cost_per_unit', 'estimated_return_cost'];
    if (!finite(form.unit_cost) || numericFields.some(key => finite(form[key]) && Number(form[key]) < 0)) {
      setError('Informe custos válidos, maiores ou iguais a zero. O custo unitário é obrigatório.');
      return;
    }
    if (Number(form.minimum_margin_pct) < 15 || Number(form.target_margin_pct) < Number(form.minimum_margin_pct)) {
      setError('A margem mínima deve ser pelo menos 15% e a margem-alvo não pode ser menor que ela.');
      return;
    }
    if (finite(form.manual_min_price) && finite(form.manual_max_price) && Number(form.manual_max_price) < Number(form.manual_min_price)) {
      setError('O preço máximo manual não pode ser menor que o preço mínimo manual.');
      return;
    }
    if (minimumPrice && finite(form.manual_min_price) && Number(form.manual_min_price) < minimumPrice) {
      setError(`O preço mínimo manual não pode ficar abaixo do piso rentável de ${money(minimumPrice)}.`);
      return;
    }
    if (minimumPrice && finite(form.manual_max_price) && Number(form.manual_max_price) < minimumPrice) {
      setError(`O preço máximo manual não pode ficar abaixo do piso rentável de ${money(minimumPrice)}.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const accountId = product?.amazon_account_id || accounts?.[0]?.id;
      const item = {
        sku: product?.sku,
        product_name: product?.display_name || product?.product_name,
        ...Object.fromEntries(numericFields.map(key => [key, Number(form[key] || 0)])),
        other_cost_description: form.other_cost_description || null,
        minimum_margin_pct: Number(form.minimum_margin_pct),
        target_margin_pct: Number(form.target_margin_pct),
        manual_min_price: finite(form.manual_min_price) && Number(form.manual_min_price) > 0 ? Number(form.manual_min_price) : null,
        manual_max_price: finite(form.manual_max_price) && Number(form.manual_max_price) > 0 ? Number(form.manual_max_price) : null,
        repricing_enabled: form.repricing_enabled,
        effective_from: form.effective_from,
        reason: form.reason || 'Edição manual dos custos e limites econômicos.',
      };
      const response = await base44.functions.invoke('importProductEconomics', { amazon_account_id: accountId, items: [item] });
      const result = response?.data || response;
      if (!result?.ok || result?.error_details?.length) throw new Error(result?.error_details?.[0]?.error || result?.error || 'Erro ao salvar');
      setSuccess(true);
      setTimeout(() => onSave?.(result), 700);
    } catch (saveError) {
      setError(saveError?.message || 'Erro ao salvar custos.');
    } finally {
      setSaving(false);
    }
  };

  const productName = product?.display_name || product?.product_name || product?.sku;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="bg-surface-1 border border-surface-2 rounded-2xl w-full max-w-3xl max-h-[92vh] overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-4 border-b border-surface-2 bg-surface-1">
          <div>
            <h2 className="text-sm font-bold text-white">{mode === 'new' ? 'Cadastrar economia e repricing' : 'Editar economia e repricing'}</h2>
            <p className="text-xs text-slate-400 mt-0.5 truncate max-w-[520px]">{productName}</p>
          </div>
          <button onClick={onClose} className="p-1.5 text-slate-500 hover:text-white rounded-lg"><X className="w-4 h-4" /></button>
        </div>

        <div className="px-5 py-4 space-y-5">
          <div className="bg-surface-2 rounded-xl p-3 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <div><span className="text-slate-500">ASIN</span><p className="font-mono text-cyan mt-0.5">{product?.asin || '—'}</p></div>
            <div><span className="text-slate-500">SKU</span><p className="font-mono text-slate-300 mt-0.5">{product?.sku || '—'}</p></div>
            <div><span className="text-slate-500">Estoque</span><p className="text-slate-300 mt-0.5">{product?.available_quantity ?? product?.fba_inventory ?? '—'}</p></div>
            <div><span className="text-slate-500">Preço Amazon</span><p className="text-slate-300 mt-0.5">{money(currentPrice)}</p></div>
          </div>

          <section>
            <p className="text-xs font-semibold text-slate-300 mb-3 uppercase tracking-wider">Custos informados pelo usuário</p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <Field label="Custo do produto/un. *" field="unit_cost" form={form} set={set} hint="Não é alterado pela sincronização Amazon" />
              <Field label="Frete de entrada/un." field="inbound_freight_per_unit" form={form} set={set} />
              <Field label="Impostos adicionais/un." field="tax_per_unit" form={form} set={set} />
              <Field label="Logística adicional/un." field="logistics_cost_per_unit" form={form} set={set} />
              <Field label="Embalagem/un." field="packaging_cost_per_unit" form={form} set={set} />
              <Field label="Outros custos/un." field="other_variable_cost_per_unit" form={form} set={set} />
              <Field label="Devolução estimada/un." field="estimated_return_cost" form={form} set={set} />
            </div>
            <input type="text" value={form.other_cost_description} onChange={event => set('other_cost_description', event.target.value)}
              placeholder="Descrição de outros custos" className="mt-3 w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-slate-200 focus:outline-none focus:border-cyan/50" />
          </section>

          <section className="rounded-xl border border-surface-3 p-4">
            <div className="flex items-center gap-2 mb-3"><ShieldCheck className="w-4 h-4 text-cyan" /><p className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Dados automáticos Amazon e Ads — somente leitura</p></div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <div><p className="text-slate-500">Comissão</p><p className="text-slate-200">{finite(economics?.amazon_fee_percent) ? `${Number(economics.amazon_fee_percent).toFixed(2)}%` : 'Pendente'}</p></div>
              <div><p className="text-slate-500">FBA/un.</p><p className="text-slate-200">{money(economics?.fba_fee)}</p></div>
              <div><p className="text-slate-500">Tarifa fixa/un.</p><p className="text-slate-200">{money(economics?.amazon_fixed_fee)}</p></div>
              <div><p className="text-slate-500">Ads/pedido</p><p className="text-slate-200">{money(economics?.estimated_ads_cost_per_order)}</p></div>
            </div>
            {!dataComplete && <p className="mt-2 text-[10px] text-amber-400">Cálculo operacional bloqueado até preço, tarifas SP-API e custo real de Ads estarem confirmados. Ausência de vendas não vira custo zero.</p>}
          </section>

          <section>
            <p className="text-xs font-semibold text-slate-300 mb-3 uppercase tracking-wider">Margens e limites</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Field label="Margem mínima (%)" field="minimum_margin_pct" form={form} set={set} min={15} hint="Nunca abaixo de 15%" />
              <Field label="Margem-alvo (%)" field="target_margin_pct" form={form} set={set} min={15} hint="Padrão: 20%" />
              <Field label="Preço mínimo manual" field="manual_min_price" form={form} set={set} hint="Opcional; não substitui o piso econômico" />
              <Field label="Preço máximo manual" field="manual_max_price" form={form} set={set} hint="Opcional" />
            </div>
            <label className="mt-4 flex items-start gap-3 rounded-xl border border-cyan/20 bg-cyan/5 p-3 cursor-pointer">
              <input type="checkbox" checked={form.repricing_enabled} onChange={event => set('repricing_enabled', event.target.checked)} className="mt-0.5 accent-cyan" />
              <span><span className="block text-xs font-semibold text-cyan">Solicitar repricing automático para este SKU</span><span className="block text-[10px] text-slate-500 mt-0.5">A configuração global começa em “somente recomendações”. O SKU permanece bloqueado se algum dado real estiver incompleto.</span></span>
            </label>
          </section>

          <section className={`rounded-xl p-4 border ${preview && preview.margin >= 15 ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-amber-500/5 border-amber-500/20'}`}>
            <div className="flex items-center gap-2 mb-3"><Calculator className="w-4 h-4 text-slate-400" /><p className="text-xs font-semibold text-slate-300">Cálculo reproduzível</p></div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
              <div><p className="text-slate-500">Custo total atual</p><p className="font-bold text-slate-200">{money(preview?.total)}</p></div>
              <div><p className="text-slate-500">Margem líquida</p><p className="font-bold text-slate-200">{preview ? `${preview.margin.toFixed(2)}%` : 'Incompleta'}</p></div>
              <div><p className="text-slate-500">Lucro/un.</p><p className="font-bold text-slate-200">{money(preview?.profit)}</p></div>
              <div><p className="text-slate-500">Piso rentável</p><p className="font-bold text-amber-300">{money(minimumPrice)}</p></div>
              <div><p className="text-slate-500">Preço-alvo</p><p className="font-bold text-cyan">{money(targetPrice)}</p></div>
            </div>
          </section>

          <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div><label className="block text-xs text-slate-400 mb-1">Vigência</label><input type="date" value={form.effective_from} onChange={event => set('effective_from', event.target.value)} className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-slate-200" /></div>
            <div><label className="block text-xs text-slate-400 mb-1">Justificativa</label><input type="text" value={form.reason} onChange={event => set('reason', event.target.value)} placeholder="Ex.: reajuste do fornecedor" className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-slate-200" /></div>
          </section>

          {economics && <div className="bg-surface-2 rounded-xl p-3 text-[10px] text-slate-500 flex items-center gap-2"><History className="w-3 h-3" />Última atualização: {economics.updated_at ? new Date(economics.updated_at).toLocaleString('pt-BR') : '—'} · status {economics.repricing_status || 'disabled'}</div>}
          {error && <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400"><AlertCircle className="w-3.5 h-3.5" />{error}</div>}
          {success && <div className="flex items-center gap-2 px-3 py-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-xs text-emerald-400"><CheckCircle className="w-3.5 h-3.5" />Custos e limites salvos.</div>}
        </div>

        <div className="sticky bottom-0 flex items-center justify-end gap-3 px-5 py-4 border-t border-surface-2 bg-surface-1">
          <button onClick={onClose} className="px-4 py-2 text-xs text-slate-400 hover:text-white">Cancelar</button>
          <button onClick={handleSave} disabled={saving || success} className="flex items-center gap-2 px-5 py-2 text-xs font-semibold bg-cyan/20 border border-cyan/30 text-cyan hover:bg-cyan/30 rounded-lg disabled:opacity-50">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}{saving ? 'Salvando...' : 'Salvar economia'}
          </button>
        </div>
      </div>
    </div>
  );
}
