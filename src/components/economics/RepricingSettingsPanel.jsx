import { useCallback, useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { AlertCircle, CheckCircle, Clock3, Loader2, RefreshCw, Save, ShieldAlert } from 'lucide-react';

const DEFAULTS = {
  default_minimum_margin_pct: 15, default_target_margin_pct: 20, normal_max_change_pct: 3,
  daily_max_change_pct: 10, minimum_effective_change_pct: 1, cooldown_hours: 6,
  learning_window_hours: 72, minimum_confidence: 75, minimum_automatic_confidence: 96,
  repricing_rollout_mode: 'guarded', maximum_price_change_amount_24h: 2,
  minimum_price_change_amount: 0.05, price_change_window_hours: 24,
  automation_mode: 'recommendation_only',
  max_changes_per_cycle: 20, competition_max_age_minutes: 30, fees_max_age_hours: 24, simple_national_tax_pct: 7, enabled: true,
};
const dateTime = value => value ? new Date(value).toLocaleString('pt-BR') : 'Ainda não executado';

function NumberField({ label, field, form, setForm, suffix, min, max, hint, step = 1 }) {
  return <div><label className="block text-xs text-slate-400 mb-1">{label}</label><div className="relative"><input type="number" min={min} max={max} step={step} value={form[field]} onChange={event => setForm(current => ({ ...current, [field]: Number(event.target.value) }))} className="w-full px-3 py-2 pr-12 bg-surface-2 border border-surface-3 rounded-lg text-sm text-slate-200" />{suffix && <span className="absolute right-3 top-2 text-xs text-slate-600">{suffix}</span>}</div>{hint && <p className="text-[10px] text-slate-600 mt-1">{hint}</p>}</div>;
}

export default function RepricingSettingsPanel({ accountId, account }) {
  const [form, setForm] = useState(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState(null);
  const [status, setStatus] = useState({ queue: [], economics: [], logs: [] });

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const [settings, queue, economics, logs] = await Promise.all([
        base44.entities.RepricingSettings.filter({ amazon_account_id: accountId }, '-updated_at', 1).catch(() => []),
        base44.entities.AmazonActionQueue.filter({ amazon_account_id: accountId, entity_type: 'product_price' }, '-created_at', 200).catch(() => []),
        base44.entities.ProductEconomics.filter({ amazon_account_id: accountId }, '-updated_at', 5000).catch(() => []),
        base44.entities.SyncExecutionLog.filter({ amazon_account_id: accountId }, '-completed_at', 100).catch(() => []),
      ]);
      setForm({ ...DEFAULTS, ...(settings?.[0] || {}), minimum_automatic_confidence: Math.max(96, Number(settings?.[0]?.minimum_automatic_confidence || 96)) });
      setStatus({ queue, economics, logs: logs.filter(item => String(item.operation || '').startsWith('runAutomaticRepricing')) });
    } catch (loadError) {
      setMessage({ type: 'error', text: loadError?.message || 'Falha ao carregar configurações.' });
    } finally { setLoading(false); }
  }, [accountId]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      if (Number(form.default_minimum_margin_pct) < 15) throw new Error('A margem mínima nunca pode ser inferior a 15%.');
      if (Number(form.default_target_margin_pct) < Number(form.default_minimum_margin_pct)) throw new Error('A margem-alvo deve ser maior ou igual à margem mínima.');
      if (Number(form.simple_national_tax_pct) < 7) throw new Error('A alíquota do Simples Nacional desta conta não pode ser inferior a 7%.');
      const response = await base44.functions.invoke('runAutomaticRepricing', { operation: 'save_settings', amazon_account_id: accountId, settings: form });
      const result = response?.data || response;
      if (!result?.ok) throw new Error(result?.error || 'Falha ao salvar.');
      setForm({ ...DEFAULTS, ...result.settings });
      setMessage({ type: 'success', text: 'Configurações salvas. Os limites rígidos continuam protegidos pelo servidor.' });
    } catch (saveError) {
      setMessage({ type: 'error', text: saveError?.message || 'Falha ao salvar.' });
    } finally { setSaving(false); }
  };

  const runNow = async () => {
    setRunning(true);
    setMessage(null);
    try {
      const response = await base44.functions.invoke('runAutomaticRepricing', { operation: 'evaluate', amazon_account_id: accountId, max_products: 100 });
      const result = response?.data || response;
      if (!result?.ok) throw new Error(result?.error || 'Falha na avaliação.');
      setMessage({ type: 'success', text: 'Monitoramento executado. Recomendações e bloqueios foram atualizados.' });
      await load();
    } catch (runError) {
      setMessage({ type: 'error', text: runError?.message || 'Falha na avaliação.' });
    } finally { setRunning(false); }
  };

  const counts = {
    pending: status.queue.filter(item => ['pending', 'submitted', 'processing'].includes(item.status)).length,
    failed: status.queue.filter(item => ['failed', 'blocked'].includes(item.status)).length,
    confirmed: status.queue.filter(item => item.status === 'confirmed').length,
    blockedProducts: status.economics.filter(item => item.repricing_status === 'blocked').length,
    incomplete: status.economics.filter(item => !item.economic_data_complete).length,
  };
  const latest = status.logs[0];
  const permissionHints = status.economics.map(item => item.repricing_block_reason).filter(reason => /permiss|token|oauth|autoriz/i.test(String(reason || '')));

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>;
  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-cyan/20 bg-cyan/5 p-4"><div className="flex items-start gap-3"><ShieldAlert className="w-5 h-5 text-cyan mt-0.5" /><div><h2 className="text-sm font-bold text-white">Configurações de Repricing</h2><p className="text-xs text-slate-400 mt-1">A otimização busca maior lucro diário esperado. Nunca publica preço com margem líquida projetada abaixo de 15%.</p></div></div></div>

      <section className="rounded-xl border border-surface-2 bg-surface-1 p-5"><h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-4">Política global</h3><div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <NumberField label="Margem mínima" field="default_minimum_margin_pct" form={form} setForm={setForm} suffix="%" min={15} hint="Piso rígido: 15%" />
        <NumberField label="Margem-alvo" field="default_target_margin_pct" form={form} setForm={setForm} suffix="%" min={15} hint="Padrão: 20%" />
        <NumberField label="Imposto Simples Nacional" field="simple_national_tax_pct" form={form} setForm={setForm} suffix="%" min={7} hint="Aplicado sobre o preço de venda" step={0.01} />
        <NumberField label="Variação máxima/ciclo" field="normal_max_change_pct" form={form} setForm={setForm} suffix="%" min={1} max={3} />
        <NumberField label="Variação máxima/24h" field="daily_max_change_pct" form={form} setForm={setForm} suffix="%" min={1} max={10} />
        <NumberField label="Mudança mínima efetiva" field="minimum_effective_change_pct" form={form} setForm={setForm} suffix="%" min={1} />
        <NumberField label="Intervalo mínimo" field="cooldown_hours" form={form} setForm={setForm} suffix="h" min={6} />
        <NumberField label="Janela de aprendizado" field="learning_window_hours" form={form} setForm={setForm} suffix="h" min={72} />
        <NumberField label="Confiança mínima" field="minimum_confidence" form={form} setForm={setForm} suffix="%" min={0} max={100} />
        <NumberField label="Teto absoluto/24h" field="maximum_price_change_amount_24h" form={form} setForm={setForm} suffix="R$" min={0.01} max={2} step={0.05} hint="Máximo rígido: R$ 2,00 por SKU" />
        <NumberField label="Mudança mínima" field="minimum_price_change_amount" form={form} setForm={setForm} suffix="R$" min={0.05} step={0.05} />
        <NumberField label="Confiança automática" field="minimum_automatic_confidence" form={form} setForm={setForm} suffix="%" min={96} max={100} hint="Automação exige mais de 95%; IA isolada não autoriza" />
        <NumberField label="Janela móvel" field="price_change_window_hours" form={form} setForm={setForm} suffix="h" min={24} max={24} />
        <NumberField label="Máximo por ciclo" field="max_changes_per_cycle" form={form} setForm={setForm} min={1} max={100} />
        <NumberField label="Validade da concorrência" field="competition_max_age_minutes" form={form} setForm={setForm} suffix="min" min={5} />
        <NumberField label="Validade das tarifas" field="fees_max_age_hours" form={form} setForm={setForm} suffix="h" min={1} />
      </div>
      <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-3"><label className={`rounded-xl border p-4 cursor-pointer ${form.automation_mode === 'recommendation_only' ? 'border-cyan/30 bg-cyan/10' : 'border-surface-3'}`}><input type="radio" name="mode" value="recommendation_only" checked={form.automation_mode === 'recommendation_only'} onChange={event => setForm(current => ({ ...current, automation_mode: event.target.value }))} className="accent-cyan" /><span className="ml-2 text-xs font-semibold text-cyan">Somente recomendações</span><p className="mt-1 ml-5 text-[10px] text-slate-500">Modo inicial. Nenhum preço é publicado sem ação manual.</p></label><label className={`rounded-xl border p-4 cursor-pointer ${form.automation_mode === 'automatic' ? 'border-amber-500/30 bg-amber-500/10' : 'border-surface-3'}`}><input type="radio" name="mode" value="automatic" checked={form.automation_mode === 'automatic'} onChange={event => setForm(current => ({ ...current, automation_mode: event.target.value }))} className="accent-amber-500" /><span className="ml-2 text-xs font-semibold text-amber-400">Automático com guardrails</span><p className="mt-1 ml-5 text-[10px] text-slate-500">Só SKUs solicitados, completos, com estoque, listing ativo e confiança suficiente.</p></label></div>
      <div className="mt-4 flex items-center justify-between flex-wrap gap-3"><label className="flex items-center gap-2 text-xs text-slate-300"><input type="checkbox" checked={form.enabled} onChange={event => setForm(current => ({ ...current, enabled: event.target.checked }))} className="accent-cyan" />Motor habilitado</label><div className="flex gap-2"><button onClick={runNow} disabled={running} className="flex items-center gap-1.5 px-3 py-2 text-xs border border-surface-3 text-slate-300 rounded-lg disabled:opacity-50">{running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}Executar monitoramento</button><button onClick={save} disabled={saving} className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-cyan/20 border border-cyan/30 text-cyan rounded-lg disabled:opacity-50">{saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}Salvar</button></div></div></section>

      {message && <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${message.type === 'success' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400' : 'border-red-500/20 bg-red-500/10 text-red-400'}`}>{message.type === 'success' ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}{message.text}</div>}

      <section className="rounded-xl border border-surface-2 bg-surface-1 p-5"><div className="flex items-center gap-2 mb-4"><Clock3 className="w-4 h-4 text-slate-500" /><h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Status operacional</h3></div><div className="grid grid-cols-2 lg:grid-cols-5 gap-3">{[['Fila ativa', counts.pending], ['Confirmados', counts.confirmed], ['Falhas/bloqueios', counts.failed], ['Produtos bloqueados', counts.blockedProducts], ['Dados incompletos', counts.incomplete]].map(([label, value]) => <div key={label} className="rounded-lg bg-surface-2 p-3"><p className="text-[10px] text-slate-500">{label}</p><p className="text-lg font-bold text-slate-200">{value}</p></div>)}</div><div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs"><div className="rounded-lg border border-surface-3 p-3"><p className="text-slate-500">Última execução</p><p className="text-slate-300 mt-1">{dateTime(latest?.completed_at)}</p><p className="text-[10px] text-slate-600 mt-1">{latest?.operation || 'Nenhum registro do motor'}</p></div><div className="rounded-lg border border-surface-3 p-3"><p className="text-slate-500">Conta e permissões</p><p className="text-slate-300 mt-1">{account?.status === 'connected' ? 'Conta conectada' : `Conta: ${account?.status || 'desconhecida'}`}</p><p className={`text-[10px] mt-1 ${permissionHints.length ? 'text-red-400' : 'text-slate-600'}`}>{permissionHints[0] || 'Nenhum bloqueio de token/permissão registrado pelo motor.'}</p></div></div><p className="mt-4 text-[10px] text-slate-600">Rotinas: monitoramento 15 min · fila 5 min · economia completa 6 h · reconciliação diária.</p></section>
    </div>
  );
}
