import { useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import {
  CalendarClock, ChevronDown, ChevronUp, Loader2, Pencil, Plus,
  Power, Save, Trash2, Zap,
} from 'lucide-react';

const DAYS = [
  ['MONDAY', 'Seg'], ['TUESDAY', 'Ter'], ['WEDNESDAY', 'Qua'], ['THURSDAY', 'Qui'],
  ['FRIDAY', 'Sex'], ['SATURDAY', 'Sáb'], ['SUNDAY', 'Dom'],
];
const WEEKDAYS = DAYS.slice(0, 5).map(([value]) => value);
const WEEKEND_HOLIDAY_DAYS = ['SATURDAY', 'SUNDAY'];
const ACTIONS = [
  ['PAUSE_CAMPAIGN', 'Pausar campanha'], ['ENABLE_CAMPAIGN', 'Ativar campanha'],
  ['BID_PERCENT', 'Alterar bid (%)'], ['TOP_OF_SEARCH', 'Topo da pesquisa (%)'],
  ['REST_OF_SEARCH', 'Restante da pesquisa (%)'], ['PRODUCT_PAGES', 'Páginas de produto (%)'],
  ['FIRST_PAGE', 'Primeira página'],
];

const blank = () => ({
  rule_name: '',
  action_type: 'BID_PERCENT',
  start_time: '00:00',
  end_time: '23:59',
  adjustment_value: 0,
  days_of_week: [...WEEKDAYS],
  scope_type: 'ALL',
  campaign_ids: [],
  holiday_mode: 'WEEKEND_POLICY',
  weekend_holiday_group: false,
  status: 'enabled',
  timezone: 'America/Sao_Paulo',
});

function actionLabel(value) {
  return ACTIONS.find(([action]) => action === value)?.[1] || value || 'Regra programada';
}

function ruleDays(rule) {
  if (rule.weekend_holiday_group) return 'Sábado, domingo e feriados';
  return (rule.days_of_week || [])
    .map(day => DAYS.find(([value]) => value === day)?.[1] || day)
    .join(', ');
}

function RuleCard({ rule, onEdit, onToggle, onArchive, busy }) {
  const active = rule.status !== 'disabled';
  const scope = rule.scope_type === 'ALL'
    ? 'Todas as campanhas'
    : `${(rule.campaign_ids || []).length} campanha(s)`;
  const hasAdjustment = !['PAUSE_CAMPAIGN', 'ENABLE_CAMPAIGN'].includes(rule.action_type);

  return (
    <article className="bg-surface-2 border border-surface-3 rounded-xl p-4 flex flex-col gap-3 min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-sm font-semibold text-white truncate">{rule.rule_name || 'Regra sem nome'}</h4>
            <span className={`text-[10px] px-2 py-0.5 rounded-full border ${active ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20' : 'text-slate-400 bg-surface-3 border-surface-3'}`}>
              {active ? 'Ativa' : 'Desativada'}
            </span>
          </div>
          <p className="text-xs text-cyan mt-1">{actionLabel(rule.action_type || rule.rule_category)}</p>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px]">
        <div>
          <dt className="text-slate-500">Horário</dt>
          <dd className="text-slate-200 mt-0.5">{rule.start_time || '00:00'}–{rule.end_time || '23:59'}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Aplicação</dt>
          <dd className="text-slate-200 mt-0.5">{scope}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-slate-500">Dias</dt>
          <dd className="text-slate-200 mt-0.5">{ruleDays(rule) || 'Nenhum dia configurado'}</dd>
        </div>
        {hasAdjustment && (
          <div>
            <dt className="text-slate-500">Ajuste</dt>
            <dd className="text-slate-200 mt-0.5">{Number(rule.adjustment_value || 0)}%</dd>
          </div>
        )}
        <div>
          <dt className="text-slate-500">Fuso</dt>
          <dd className="text-slate-200 mt-0.5">{rule.timezone || 'America/Sao_Paulo'}</dd>
        </div>
      </dl>

      <div className="grid grid-cols-3 gap-2 mt-auto pt-1">
        <button type="button" onClick={() => onEdit(rule)} disabled={busy}
          className="flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg border border-cyan/25 bg-cyan/10 text-cyan text-xs font-medium disabled:opacity-50">
          <Pencil className="w-3.5 h-3.5" />Editar
        </button>
        <button type="button" onClick={() => onToggle(rule)} disabled={busy}
          className="flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg border border-surface-3 bg-surface-1 text-slate-300 text-xs font-medium disabled:opacity-50">
          <Power className="w-3.5 h-3.5" />{active ? 'Desativar' : 'Ativar'}
        </button>
        <button type="button" onClick={() => onArchive(rule)} disabled={busy}
          className="flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg border border-red-500/20 bg-red-500/10 text-red-300 text-xs font-medium disabled:opacity-50"
          title="Excluir da operação preservando o histórico">
          <Trash2 className="w-3.5 h-3.5" />Excluir
        </button>
      </div>
    </article>
  );
}

export default function DaypartingPanel({ account, enabled = true }) {
  const [rules, setRules] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [form, setForm] = useState(blank());
  const [editingRuleId, setEditingRuleId] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [mutatingRuleId, setMutatingRuleId] = useState(null);
  const [message, setMessage] = useState('');

  const load = async () => {
    if (!account?.id) return;
    setLoading(true);
    try {
      const [ruleRows, campaignRows] = await Promise.all([
        base44.entities.AmazonScheduledRule.filter({ amazon_account_id: account.id }, '-updated_at', 200),
        base44.entities.Campaign.filter({ amazon_account_id: account.id }, '-updated_at', 1000),
      ]);
      setRules(ruleRows || []);
      setCampaigns((campaignRows || []).filter(item => String(item.state || item.status || '').toLowerCase() !== 'archived'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [account?.id]);

  const visibleRules = useMemo(
    () => rules.filter(rule => rule.status !== 'archived'),
    [rules],
  );

  const startNewRule = () => {
    setEditingRuleId(null);
    setForm(blank());
    setMessage('');
    setEditorOpen(true);
  };

  const editRule = rule => {
    setEditingRuleId(rule.id);
    setForm({
      ...blank(),
      ...rule,
      campaign_ids: (rule.campaign_ids || []).map(String),
      days_of_week: Array.isArray(rule.days_of_week) ? rule.days_of_week : [...WEEKDAYS],
      weekend_holiday_group: Boolean(rule.weekend_holiday_group),
    });
    setMessage('');
    setEditorOpen(true);
  };

  const cancelEdit = () => {
    setEditingRuleId(null);
    setForm(blank());
    setEditorOpen(false);
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

  const syncConfiguration = async (forceHolidays = false) => {
    await base44.functions.invoke('syncDaypartingConfiguration', {
      amazon_account_id: account.id,
      force_holidays: forceHolidays,
    });
  };

  const save = async () => {
    if (!account?.id || !form.rule_name.trim() || !form.days_of_week.length) return;
    setSaving(true);
    setMessage('');
    try {
      const now = new Date().toISOString();
      const normalizedCampaigns = form.scope_type === 'ALL'
        ? []
        : [...new Set(form.campaign_ids.map(String))].sort();
      const daysKey = form.weekend_holiday_group
        ? 'SATURDAY,SUNDAY,HOLIDAYS'
        : [...form.days_of_week].sort().join(',');
      const idempotencyKey = [
        account.id,
        form.action_type,
        form.start_time,
        form.end_time,
        daysKey,
        form.scope_type,
        normalizedCampaigns.join(','),
        Number(form.adjustment_value || 0),
      ].join('|');

      const duplicate = rules.find(rule =>
        rule.id !== editingRuleId &&
        rule.idempotency_key === idempotencyKey &&
        rule.status !== 'archived');
      if (duplicate) throw new Error(`Já existe uma regra equivalente: ${duplicate.rule_name || duplicate.id}`);

      const currentRule = rules.find(rule => rule.id === editingRuleId);
      const payload = {
        ...form,
        amazon_account_id: account.id,
        campaign_ids: normalizedCampaigns,
        holiday_mode: form.weekend_holiday_group ? 'WEEKEND_POLICY' : form.holiday_mode,
        rule_category: ['PAUSE_CAMPAIGN', 'ENABLE_CAMPAIGN'].includes(form.action_type) ? 'CAMPAIGN_STATE' : 'BID',
        rule_subcategory: 'SCHEDULE',
        recurrence_type: 'WEEKLY',
        adjustment_unit: 'PERCENT',
        adjustment_operator: Number(form.adjustment_value) >= 0 ? 'INCREMENT' : 'DECREMENT',
        idempotency_key: idempotencyKey,
        engine_version: 'settings-daypart-v3',
        updated_at: now,
        created_at: currentRule?.created_at || now,
      };

      if (editingRuleId) {
        await base44.entities.AmazonScheduledRule.update(editingRuleId, payload);
      } else {
        await base44.entities.AmazonScheduledRule.create(payload);
      }

      await syncConfiguration(true);
      setForm(blank());
      setEditingRuleId(null);
      setEditorOpen(false);
      setMessage(editingRuleId ? 'Regra alterada e refletida no motor.' : 'Regra adicionada e refletida no motor.');
      await load();
    } catch (error) {
      setMessage(`Erro: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  const toggleRule = async rule => {
    setMutatingRuleId(rule.id);
    setMessage('');
    try {
      const nextStatus = rule.status === 'disabled' ? 'enabled' : 'disabled';
      await base44.entities.AmazonScheduledRule.update(rule.id, {
        status: nextStatus,
        updated_at: new Date().toISOString(),
      });
      await syncConfiguration();
      setMessage(nextStatus === 'enabled' ? 'Regra ativada.' : 'Regra desativada.');
      await load();
    } catch (error) {
      setMessage(`Erro: ${error.message}`);
    } finally {
      setMutatingRuleId(null);
    }
  };

  const archiveRule = async rule => {
    if (!window.confirm(`Excluir a regra “${rule.rule_name || 'sem nome'}” da operação? O histórico será preservado.`)) return;
    setMutatingRuleId(rule.id);
    setMessage('');
    try {
      await base44.entities.AmazonScheduledRule.update(rule.id, {
        status: 'archived',
        archived_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await syncConfiguration();
      if (editingRuleId === rule.id) cancelEdit();
      setMessage('Regra excluída da operação e preservada no histórico.');
      await load();
    } catch (error) {
      setMessage(`Erro: ${error.message}`);
    } finally {
      setMutatingRuleId(null);
    }
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

      {!enabled && (
        <div className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
          Ative Dayparting em Metas de Performance para executar as regras.
        </div>
      )}

      <button type="button" onClick={() => setEditorOpen(value => !value)} className="w-full flex items-center justify-between px-4 py-3 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white">
        <span>{editorOpen ? (editingRuleId ? 'Fechar edição da regra' : 'Fechar nova regra') : 'Adicionar ou editar regra'}</span>
        {editorOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>

      {editorOpen && (
        <div className="space-y-4 border border-cyan/20 bg-cyan/5 rounded-xl p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-white">{editingRuleId ? 'Editar regra vigente' : 'Adicionar nova regra'}</h3>
            {editingRuleId && (
              <button type="button" onClick={cancelEdit} className="text-xs text-slate-400 hover:text-white">Cancelar edição</button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input value={form.rule_name} onChange={event => setForm(previous => ({ ...previous, rule_name: event.target.value }))} placeholder="Nome da regra" className="px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white" />
            <select value={form.action_type} onChange={event => setForm(previous => ({ ...previous, action_type: event.target.value }))} className="px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white">
              {ACTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <div className="grid grid-cols-2 gap-2">
              <input type="time" value={form.start_time} onChange={event => setForm(previous => ({ ...previous, start_time: event.target.value }))} className="px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white" />
              <input type="time" value={form.end_time} onChange={event => setForm(previous => ({ ...previous, end_time: event.target.value }))} className="px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white" />
            </div>
            <input type="number" value={form.adjustment_value} onChange={event => setForm(previous => ({ ...previous, adjustment_value: Number(event.target.value) }))} disabled={['PAUSE_CAMPAIGN', 'ENABLE_CAMPAIGN'].includes(form.action_type)} placeholder="Ajuste %" className="px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white disabled:opacity-40" />
          </div>

          <div>
            <p className="text-xs text-slate-400 mb-2">Dias da semana</p>
            <div className="flex flex-wrap gap-2">
              {DAYS.map(([value, label]) => (
                <button type="button" key={value} onClick={() => toggleDay(value)}
                  className={`px-3 py-1.5 rounded-full border text-xs ${form.days_of_week.includes(value) && !form.weekend_holiday_group ? 'bg-cyan/15 border-cyan/30 text-cyan' : 'bg-surface-2 border-surface-3 text-slate-500'}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          <label className="flex items-start gap-3 p-3 rounded-lg bg-surface-2 border border-surface-3 cursor-pointer">
            <input type="checkbox" className="mt-0.5" checked={form.weekend_holiday_group} onChange={event => applyWeekendHolidayGroup(event.target.checked)} />
            <span>
              <span className="block text-sm font-medium text-white">Usar a mesma regra para sábado, domingo e feriados</span>
              <span className="block text-[11px] text-slate-500 mt-1">O motor buscará os feriados nacionais do Brasil e aplicará exatamente o mesmo horário e ação usados no fim de semana.</span>
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
                    <input type="checkbox" checked={form.campaign_ids.includes(id)} onChange={event => setForm(previous => ({
                      ...previous,
                      campaign_ids: event.target.checked
                        ? [...previous.campaign_ids, id]
                        : previous.campaign_ids.filter(value => value !== id),
                    }))} />
                    <span className="truncate">{campaign.name || campaign.campaign_name || id}</span>
                  </label>
                );
              })}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <button onClick={save} disabled={saving || !account || !form.rule_name.trim()} className="flex items-center gap-2 px-4 py-2.5 bg-cyan text-white rounded-lg text-sm font-semibold disabled:opacity-50">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {editingRuleId ? 'Salvar alterações' : 'Salvar nova regra'}
            </button>
            {editingRuleId && (
              <button type="button" onClick={cancelEdit} className="px-4 py-2.5 border border-surface-3 bg-surface-2 text-slate-300 rounded-lg text-sm">
                Cancelar
              </button>
            )}
          </div>
        </div>
      )}

      {message && <p className="text-xs text-cyan">{message}</p>}

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-white">Regras em vigor</h3>
            <p className="text-[11px] text-slate-500 mt-0.5">As regras abaixo são as mesmas persistidas e executadas pelo motor.</p>
          </div>
          <span className="text-[10px] text-slate-500">{visibleRules.length} regra(s)</span>
        </div>

        {loading ? (
          <div className="bg-surface-2 border border-surface-3 rounded-xl p-5">
            <Loader2 className="w-5 h-5 animate-spin text-cyan" />
          </div>
        ) : visibleRules.length === 0 ? (
          <div className="text-xs text-slate-500 bg-surface-2 border border-surface-3 rounded-xl p-4">
            Nenhuma regra cadastrada. Use “Adicionar nova regra”.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {visibleRules.map(rule => (
              <RuleCard
                key={rule.id}
                rule={rule}
                onEdit={editRule}
                onToggle={toggleRule}
                onArchive={archiveRule}
                busy={mutatingRuleId === rule.id}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
