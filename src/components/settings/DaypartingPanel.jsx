import { useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { CalendarClock, Loader2, Plus, Save, Trash2, Zap } from 'lucide-react';

const DAYS = [
  ['MONDAY','Seg'],['TUESDAY','Ter'],['WEDNESDAY','Qua'],['THURSDAY','Qui'],
  ['FRIDAY','Sex'],['SATURDAY','Sáb'],['SUNDAY','Dom'],
];
const ACTIONS = [
  ['PAUSE_CAMPAIGN','Pausar campanha'],['ENABLE_CAMPAIGN','Ativar campanha'],
  ['BID_PERCENT','Alterar bid (%)'],['TOP_OF_SEARCH','Topo da pesquisa (%)'],
  ['REST_OF_SEARCH','Restante da pesquisa (%)'],['PRODUCT_PAGES','Páginas de produto (%)'],
  ['FIRST_PAGE','Primeira página'],
];
const blank = () => ({
  rule_name: '', action_type: 'BID_PERCENT', start_time: '00:00', end_time: '23:59',
  adjustment_value: 0, days_of_week: DAYS.slice(0,5).map(([v]) => v), scope_type: 'ALL',
  campaign_ids: [], holiday_mode: 'AUTO_BR', status: 'enabled', timezone: 'America/Sao_Paulo',
});

export default function DaypartingPanel({ account, enabled = true }) {
  const [rules, setRules] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [form, setForm] = useState(blank());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState('');

  const load = async () => {
    if (!account?.id) return;
    setLoading(true);
    try {
      const [r, c] = await Promise.all([
        base44.entities.AmazonScheduledRule.filter({ amazon_account_id: account.id }, '-updated_at', 200),
        base44.entities.Campaign.filter({ amazon_account_id: account.id }, '-updated_at', 1000),
      ]);
      setRules(r || []);
      setCampaigns((c || []).filter(x => String(x.state || x.status || '').toLowerCase() !== 'archived'));
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [account?.id]);

  const activeRules = useMemo(() => rules.filter(r => r.status !== 'archived'), [rules]);
  const toggleDay = day => setForm(p => ({ ...p, days_of_week: p.days_of_week.includes(day) ? p.days_of_week.filter(x => x !== day) : [...p.days_of_week, day] }));

  const save = async () => {
    if (!account?.id || !form.rule_name.trim() || !form.days_of_week.length) return;
    setSaving(true); setMessage('');
    try {
      const now = new Date().toISOString();
      const normalizedCampaigns = form.scope_type === 'ALL' ? [] : [...new Set(form.campaign_ids.map(String))];
      const idempotency = [account.id, form.action_type, form.start_time, form.end_time, [...form.days_of_week].sort().join(','), form.scope_type, normalizedCampaigns.sort().join(',')].join('|');
      const existing = rules.find(r => r.idempotency_key === idempotency && r.status !== 'archived');
      const payload = {
        ...form, amazon_account_id: account.id, campaign_ids: normalizedCampaigns,
        rule_category: ['PAUSE_CAMPAIGN','ENABLE_CAMPAIGN'].includes(form.action_type) ? 'CAMPAIGN_STATE' : 'BID',
        rule_subcategory: 'SCHEDULE', recurrence_type: 'WEEKLY', adjustment_unit: 'PERCENT',
        adjustment_operator: Number(form.adjustment_value) >= 0 ? 'INCREMENT' : 'DECREMENT',
        idempotency_key: idempotency, engine_version: 'settings-daypart-v1', updated_at: now,
        created_at: existing?.created_at || now,
      };
      if (existing) await base44.entities.AmazonScheduledRule.update(existing.id, payload);
      else await base44.entities.AmazonScheduledRule.create(payload);
      await base44.functions.invoke('syncDaypartingConfiguration', { amazon_account_id: account.id, force_holidays: true });
      setForm(blank()); setMessage('Regra salva e refletida no motor.'); await load();
    } catch (e) { setMessage(`Erro: ${e.message}`); } finally { setSaving(false); }
  };

  const archive = async rule => {
    await base44.entities.AmazonScheduledRule.update(rule.id, { status: 'archived', updated_at: new Date().toISOString() });
    await base44.functions.invoke('syncDaypartingConfiguration', { amazon_account_id: account.id });
    await load();
  };

  const runImmediate = async () => {
    setRunning(true); setMessage('');
    try {
      const res = await base44.functions.invoke('runImmediateCampaignDeliveryRecovery', { amazon_account_id: account.id, force: true });
      const d = res?.data || res;
      setMessage(`Ação imediata concluída: ${d?.evaluated || 0} avaliadas, ${d?.queued || 0} ações enfileiradas, ${d?.repaired || 0} reparos disparados.`);
    } catch (e) { setMessage(`Erro: ${e.message}`); } finally { setRunning(false); }
  };

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-6 space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div><h2 className="text-sm font-semibold text-white flex items-center gap-2"><CalendarClock className="w-4 h-4 text-cyan"/>Dayparting programado</h2><p className="text-xs text-slate-500 mt-1">Usa as regras já ativas do motor e permite agenda global ou por campanha.</p></div>
        <button onClick={runImmediate} disabled={!account || running} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-300 text-xs font-semibold disabled:opacity-50">{running?<Loader2 className="w-3.5 h-3.5 animate-spin"/>:<Zap className="w-3.5 h-3.5"/>}Agir agora em campanhas +72h</button>
      </div>
      {!enabled && <div className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">Ative Dayparting em Metas de Performance para executar as regras.</div>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <input value={form.rule_name} onChange={e=>setForm(p=>({...p,rule_name:e.target.value}))} placeholder="Nome da regra" className="px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white"/>
        <select value={form.action_type} onChange={e=>setForm(p=>({...p,action_type:e.target.value}))} className="px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white">{ACTIONS.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select>
        <div className="grid grid-cols-2 gap-2"><input type="time" value={form.start_time} onChange={e=>setForm(p=>({...p,start_time:e.target.value}))} className="px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white"/><input type="time" value={form.end_time} onChange={e=>setForm(p=>({...p,end_time:e.target.value}))} className="px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white"/></div>
        <input type="number" value={form.adjustment_value} onChange={e=>setForm(p=>({...p,adjustment_value:Number(e.target.value)}))} disabled={['PAUSE_CAMPAIGN','ENABLE_CAMPAIGN'].includes(form.action_type)} placeholder="Ajuste %" className="px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white disabled:opacity-40"/>
      </div>
      <div className="flex flex-wrap gap-2">{DAYS.map(([v,l])=><button type="button" key={v} onClick={()=>toggleDay(v)} className={`px-3 py-1.5 rounded-full border text-xs ${form.days_of_week.includes(v)?'bg-cyan/15 border-cyan/30 text-cyan':'bg-surface-2 border-surface-3 text-slate-500'}`}>{l}</button>)}</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <select value={form.scope_type} onChange={e=>setForm(p=>({...p,scope_type:e.target.value,campaign_ids:[]}))} className="px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white"><option value="ALL">Todas as campanhas</option><option value="SELECTED">Campanhas selecionadas</option></select>
        <select value={form.holiday_mode} onChange={e=>setForm(p=>({...p,holiday_mode:e.target.value}))} className="px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white"><option value="AUTO_BR">Buscar feriados do Brasil automaticamente</option><option value="IGNORE">Ignorar feriados</option><option value="WEEKEND_POLICY">Usar regra de fim de semana em feriados</option></select>
      </div>
      {form.scope_type==='SELECTED' && <div className="max-h-48 overflow-auto bg-surface-2 border border-surface-3 rounded-lg p-2 space-y-1">{campaigns.map(c=>{const id=String(c.campaign_id||c.amazon_campaign_id||c.id);return <label key={id} className="flex items-center gap-2 text-xs text-slate-300 p-1.5"><input type="checkbox" checked={form.campaign_ids.includes(id)} onChange={e=>setForm(p=>({...p,campaign_ids:e.target.checked?[...p.campaign_ids,id]:p.campaign_ids.filter(x=>x!==id)}))}/><span className="truncate">{c.name||c.campaign_name||id}</span></label>})}</div>}
      <button onClick={save} disabled={saving||!account} className="flex items-center gap-2 px-4 py-2.5 bg-cyan text-white rounded-lg text-sm font-semibold disabled:opacity-50">{saving?<Loader2 className="w-4 h-4 animate-spin"/>:<><Plus className="w-4 h-4"/><Save className="w-4 h-4"/></>}Salvar regra</button>
      {message && <p className="text-xs text-cyan">{message}</p>}
      <div className="space-y-2">{loading?<Loader2 className="w-5 h-5 animate-spin text-cyan"/>:activeRules.map(r=><div key={r.id} className="flex items-center justify-between gap-3 p-3 bg-surface-2 border border-surface-3 rounded-lg"><div className="min-w-0"><p className="text-xs font-semibold text-white truncate">{r.rule_name}</p><p className="text-[10px] text-slate-500">{r.start_time}–{r.end_time} · {(r.days_of_week||[]).join(', ')} · {r.scope_type==='ALL'?'Todas':`${(r.campaign_ids||[]).length} campanhas`} · {r.action_type||r.rule_category} {r.adjustment_value??''}</p></div><button onClick={()=>archive(r)} className="p-2 text-red-400 hover:bg-red-500/10 rounded-lg"><Trash2 className="w-4 h-4"/></button></div>)}</div>
    </div>
  );
}
