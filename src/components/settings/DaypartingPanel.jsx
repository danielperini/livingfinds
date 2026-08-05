import { useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { CalendarClock, ChevronDown, ChevronUp, Loader2, Plus, Save, Trash2, Zap } from 'lucide-react';

const DAYS = [
  ['MONDAY','Seg'],['TUESDAY','Ter'],['WEDNESDAY','Qua'],['THURSDAY','Qui'],
  ['FRIDAY','Sex'],['SATURDAY','Sáb'],['SUNDAY','Dom'],
];
const WEEKDAYS = DAYS.slice(0, 5).map(([value]) => value);
const WEEKEND_HOLIDAY_DAYS = ['SATURDAY', 'SUNDAY'];
const ACTIONS = [
  ['PAUSE_CAMPAIGN','Pausar campanha'],['ENABLE_CAMPAIGN','Ativar campanha'],
  ['BID_PERCENT','Alterar bid (%)'],['TOP_OF_SEARCH','Topo da pesquisa (%)'],
  ['REST_OF_SEARCH','Restante da pesquisa (%)'],['PRODUCT_PAGES','Páginas de produto (%)'],
  ['FIRST_PAGE','Primeira página'],
];

const blank = () => ({
  rule_name: '', action_type: 'BID_PERCENT', start_time: '00:00', end_time: '23:59',
  adjustment_value: 0, days_of_week: [...WEEKDAYS], scope_type: 'ALL',
  campaign_ids: [], holiday_mode: 'WEEKEND_POLICY', weekend_holiday_group: false,
  status: 'enabled', timezone: 'America/Sao_Paulo',
});

function RuleSummary({ rule }) {
  const days = rule.weekend_holiday_group
    ? 'Sáb, Dom e feriados'
    : (rule.days_of_week || []).map(day => DAYS.find(([value]) => value === day)?.[1] || day).join(', ');
  const scope = rule.scope_type === 'ALL' ? 'Todas as campanhas' : `${(rule.campaign_ids || []).length} campanhas`;
  return `${rule.start_time}–${rule.end_time} · ${days} · ${scope} · ${rule.action_type || rule.rule_category}${rule.adjustment_value !== undefined && rule.adjustment_value !== null ? ` ${rule.adjustment_value}%` : ''}`;
}

export default function DaypartingPanel({ account, enabled = true }) {
  const [rules, setRules] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [form, setForm] = useState(blank());
  const [editorOpen, setEditorOpen] = useState(false);
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
      setCampaigns((c || []).filter(item => String(item.state || item.status || '').toLowerCase() !== 'archived'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [account?.id]);

  const activeRules = useMemo(() => rules.filter(rule => rule.status !== 'archived'), [rules]);

  const startNewRule = () => {
    setForm(blank());
    setMessage('');
    setEditorOpen(true);
  };

  const toggleDay = day => setForm(previous => ({
    ...previous,
    weekend_holiday_group: false,
    days_of_week: previous.days_of_week.includes(day)
      ? previous.days_of_week.filter(value => value !== day)
      : [...previous.days_of_week, day],
  }));

  const applyWeekendHolidayGroup = checked => setForm(previous => ({
    ...previous,
    weekend_holiday_group: checked,
    holiday_mode: checked ? 'WEEKEND_POLICY' : previous.holiday_mode,
    days_of_week: checked ? [...WEEKEND_HOLIDAY_DAYS] : previous.days_of_week,
  }));

  const save = async () => {
    if (!account?.id || !form.rule_name.trim() || !form.days_of_week.length) return;
    setSaving(true);
    setMessage('');
    try {
      const now = new Date().toISOString();
      const normalizedCampaigns = form.scope_type === 'ALL' ? [] : [...new Set(form.campaign_ids.map(String))];
      const daysKey = form.weekend_holiday_group ? 'SATURDAY,SUNDAY,HOLIDAYS' : [...form.days_of_week].sort().join(',');
      const idempotency = [
        account.id, form.action_type, form.start_time, form.end_time, daysKey,
        form.scope_type, normalizedCampaigns.sort().join(','), form.adjustment_value,
      ].join('|');
      const existing = rules.find(rule => rule.idempotency_key === idempotency && rule.status !== 'archived');
      const payload = {
        ...form,
        amazon_account_id: account.id,
        campaign_ids: normalizedCampaigns,
        holiday_mode: form.weekend_holiday_group ? 'WEEKEND_POLICY' : form.holiday_mode,
        rule_category: ['PAUSE_CAMPAIGN','ENABLE_CAMPAIGN'].includes(form.action_type) ? 'CAMPAIGN_STATE' : 'BID',
        rule_subcategory: 'SCHEDULE',
        recurrence_type: 'WEEKLY',
        adjustment_unit: 'PERCENT',
        adjustment_operator: Number(form.adjustment_value) >= 0 ? 'INCREMENT' : 'DECREMENT',
        idempotency_key: idempotency,
        engine_version: 'settings-daypart-v2',
        updated_at: now,
        created_at: existing?.created_at || now,
      };
      if (existing) await base44.entities.AmazonScheduledRule.update(existing.id, payload);
      else await base44.entities.AmazonScheduledRule.create(payload);
      await base44.functions.invoke('syncDaypartingConfiguration', {
        amazon_account_id: account.id,
        force_holidays: true,
      });
      setForm(blank());
      setEditorOpen(false);
      setMessage('Regra salva e refletida no motor.');
      await load();
    } catch (error) {
      setMessage(`Erro: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  const archive = async rule => {
    await base44.entities.AmazonScheduledRule.update(rule.id, {
      status: 'archived',
      updated_at: new Date().toISOString(),
    });
    await base44.functions.invoke('syncDaypartingConfiguration', { amazon_account_id: account.id });
    await load();
  };

  const runImmediate = async () => {
    setRunning(true);
    setMessage('');
    try {
      const response = await base44.functions.invoke('runImmediateCampaignDeliveryRecovery', {
        amazon_account_id: account.id,
        force: true,
      });
      const data = response?.data || response;
      setMessage(`Ação imediata concluída: ${data?.evaluated || 0} avaliadas, ${data?.queued || 0} ações enfileiradas, ${data?.repaired || 0} reparos disparados.`);
    } catch (error) {
      setMessage(`Erro: ${error.message}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-6 space-y-5">
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <CalendarClock className="w-4 h-4 text-cyan" />
            Dayparting programado
          </h2>
          <p className="text-xs text-slate-500 mt-1">Configuração única para pausas, ativações, bids e placements. Sábado, domingo e feriados podem compartilhar exatamente a mesma regra.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={startNewRule} disabled={!account} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-cyan text-white text-xs font-semibold disabled:opacity-50">
            <Plus className="w-3.5 h-3.5" />Adicionar nova regra
          </button>
          <button onClick={runImmediate} disabled={!account || running} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-300 text-xs font-semibold disabled:opacity-50">
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
            Agir agora em campanhas +72h
          </button>
        </div>
      </div>

      {!enabled && <div className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">Ative Dayparting em Metas de Performance para executar as regras.</div>}

      <button type="button" onClick={() => setEditorOpen(value => !value)} className="w-full flex items-center justify-between px-4 py-3 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white">
        <span>{editorOpen ? 'Fechar editor de regra' : 'Adicionar ou editar regra'}</span>
        {editorOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>

      {editorOpen && (
        <div className="space-y-4 border border-cyan/20 bg-cyan/5 rounded-xl p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input value={form.rule_name} onChange={event => setForm(previous => ({ ...previous, rule_name: event.target.value }))} placeholder="Nome da regra" className="px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white" />
            <select value={form.action_type} onChange={event => setForm(previous => ({ ...previous, action_type: event.target.value }))} className="px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white">
              {ACTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <div className="grid grid-cols-2 gap-2">
              <input type="time" value={form.start_time} onChange={event => setForm(previous => ({ ...previous, start_time: event.target.value }))} className="px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white" />
              <input type="time" value={form.end_time} onChange={event => setForm(previous => ({ ...previous, end_time: event.target.value }))} className="px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white" />
            </div>
            <input type="number" value={form.adjustment_value} onChange={event => setForm(previous => ({ ...previous, adjustment_value: Number(event.target.value) }))} disabled={['PAUSE_CAMPAIGN','ENABLE_CAMPAIGN'].includes(form.action_type)} placeholder="Ajuste %" className="px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white disabled:opacity-40" />
          </div>

          <div>
            <p className="text-xs text-slate-400 mb-2">Dias da semana</p>
            <div className="flex flex-wrap gap-2">
              {DAYS.map(([value, label]) => <button type="button" key={value} onClick={() => toggleDay(value)} className={`px-3 py-1.5 rounded-full border text-xs ${form.days_of_week.includes(value) && !form.weekend_holiday_group ? 'bg-cyan/15 border-cyan/30 text-cyan' : 'bg-surface-2 border-surface-3 text-slate-500'}`}>{label}</button>)}
            </div>
          </div>

          <label className="flex items-start gap-3 p-3 rounded-lg bg-surface-2 border border-surface-3 cursor-pointer">
            <input type="checkbox" className="mt-0.5" checked={form.weekend_holiday_group} onChange={event => applyWeekendHolidayGroup(event.target.checked)} />
            <span>
              <span className="block text-sm font-medium text-white">Usar a mesma regra para sábado, domingo e feriados</span>
              <span className="block text-[11px] text-slate-500 mt-1">O motor buscará automaticamente os feriados nacionais do Brasil e aplicará exatamente o mesmo horário e ação usados no fim de semana.</span>
            </span>
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <select value={form.scope_type} onChange={event => setForm(previous => ({ ...previous, scope_type: event.target.value, campaign_ids: [] }))} className="px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white">
              <option value="ALL">Todas as campanhas</option>
              <option value="SELECTED">Campanhas selecionadas</option>
            </select>
            <select value={form.holiday_mode} disabled={form.weekend_holiday_group} onChange={event => setForm(previous => ({ ...previous, holiday_mode: event.target.value }))} className="px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white disabled:opacity-50">
              <option value="AUTO_BR">Buscar feriados do Brasil automaticamente</option>
              <option value="IGNORE">Ignorar feriados</option>
              <option value="WEEKEND_POLICY">Usar regra de fim de semana em feriados</option>
            </select>
          </div>

          {form.scope_type === 'SELECTED' && (
            <div className="max-h-48 overflow-auto bg-surface-2 border border-surface-3 rounded-lg p-2 space-y-1">
              {campaigns.map(campaign => {
                const id = String(campaign.campaign_id || campaign.amazon_campaign_id || campaign.id);
                return (
                  <label key={id} className="flex items-center gap-2 text-xs text-slate-300 p-1.5">
                    <input type="checkbox" checked={form.campaign_ids.includes(id)} onChange={event => setForm(previous => ({ ...previous, campaign_ids: event.target.checked ? [...previous.campaign_ids, id] : previous.campaign_ids.filter(value => value !== id) }))} />
                    <span className="truncate">{campaign.name || campaign.campaign_name || id}</span>
                  </label>
                );
              })}
            </div>
          )}

          <button onClick={save} disabled={saving || !account || !form.rule_name.trim()} className="flex items-center gap-2 px-4 py-2.5 bg-cyan text-white rounded-lg text-sm font-semibold disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Salvar regra
          </button>
        </div>
      )}

      {message && <p className="text-xs text-cyan">{message}</p>}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-slate-300">Regras ativas</h3>
          <span className="text-[10px] text-slate-500">{activeRules.length} regra(s)</span>
        </div>
        {loading
          ? <Loader2 className="w-5 h-5 animate-spin text-cyan" />
          : activeRules.length === 0
            ? <div className="text-xs text-slate-500 bg-surface-2 border border-surface-3 rounded-lg p-4">Nenhuma regra cadastrada. Use “Adicionar nova regra”.</div>
            : activeRules.map(rule => (
              <div key={rule.id} className="flex items-center justify-between gap-3 p-3 bg-surface-2 border border-surface-3 rounded-lg">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-white truncate">{rule.rule_name}</p>
                  <p className="text-[10px] text-slate-500">{RuleSummary({ rule })}</p>
                </div>
                <button onClick={() => archive(rule)} className="p-2 text-red-400 hover:bg-red-500/10 rounded-lg" title="Arquivar regra">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
      </div>
    </div>
  );
}
