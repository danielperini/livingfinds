import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Save, Loader2, Shield, AlertTriangle, Info, Target, DollarSign } from 'lucide-react';

const PRIORITY_MODE_LABELS = {
  acos_first:   { label: 'Reduzir ACoS',         hint: 'IA prioriza reduzir custo de publicidade sobre vendas' },
  roas_first:   { label: 'Maximizar ROAS',        hint: 'IA prioriza retorno sobre gasto em anúncios' },
  tacos_first:  { label: 'Controlar TACoS',       hint: 'IA prioriza percentual de gasto sobre vendas totais (inclui orgânico)' },
  budget_first: { label: 'Gastar Orçamento Alvo', hint: 'IA ajusta bids para usar o orçamento diário definido sem ultrapassar' },
};

const DEFAULTS = {
  enabled: true,
  autonomy_level: 3,
  objective: 'profitability',
  target_acos: 25,
  maximum_acos: 40,
  target_roas: 4,
  target_tacos: 10,
  maximum_tacos: 12,
  ai_budget_priority_mode: 'acos_first',
  ai_daily_budget_target: 0,
  ai_budget_enforcement: false,
  total_daily_budget: 500,
  max_bid_increase_pct: 15,
  max_bid_decrease_pct: 20,
  max_budget_increase_pct: 20,
  max_budget_decrease_pct: 20,
  min_bid: 0.10,
  max_bid: 5.00,
  min_clicks_for_decision: 8,
  min_spend_for_decision: 5,
  min_orders_for_scale: 2,
  cooldown_hours: 24,
  harvest_enabled: true,
  harvest_after_orders: 1,
  aggressive_harvesting: false,
  auto_pause_zero_stock: true,
  auto_reduce_low_stock: true,
  placement_optimization_enabled: true,
  dayparting_enabled: true,
  budget_optimization_enabled: true,
  search_term_optimization_enabled: true,
  bid_optimization_enabled: true,
  auto_create_manual_exact: true,
  auto_apply_low_risk: true,
  require_approval_medium_risk: false, // confiança >= 90% executa automaticamente
  require_approval_high_risk: true,    // risco very_high sempre exige humano
  currency_code: 'BRL',
  currency_symbol: 'R$',
  marketplace_timezone: 'America/Sao_Paulo',
};

const AUTONOMY_DESCRIPTIONS = {
  0: 'Apenas observa e classifica. Não cria decisões executáveis.',
  1: 'Cria recomendações pendentes. Nenhuma é executada automaticamente.',
  2: 'Executa automaticamente decisões com confiança ≥ 90% (exceto risco muito alto).',
  3: 'Recomendado: executa tudo com confiança ≥ 90% — bids, budgets, harvest, dayparting.',
  4: 'Máxima autonomia: reorganiza campanhas estrategicamente dentro dos limites configurados.',
};

export default function AutopilotConfigPanel({ amazonAccountId, onConfigSaved }) {
  const [form, setForm] = useState(DEFAULTS);
  const [configId, setConfigId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

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
    } finally { setSaving(false); }
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
      <button onClick={() => set(k, !form[k])}
        className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${form[k] ? (danger ? 'bg-amber-500' : 'bg-cyan') : 'bg-surface-3'}`}>
        <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${form[k] ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </button>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-cyan" />
          <h3 className="text-sm font-semibold text-white">Configuração do Autopilot</h3>
        </div>
        <button onClick={save} disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg disabled:opacity-50 transition-colors">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? '✓ Salvo' : <><Save className="w-4 h-4" /> Salvar</>}
        </button>
      </div>

      {/* Habilitado */}
      <Toggle label="Autopilot Ativo" k="enabled" hint="Habilita ou desabilita todo o sistema de otimização" />

      {/* Nível de Autonomia */}
      <div>
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Nível de Autonomia</p>
        <div className="space-y-2">
          {[0, 1, 2, 3, 4].map(level => (
            <button key={level} onClick={() => set('autonomy_level', level)}
              className={`w-full text-left p-3 rounded-xl border transition-all ${form.autonomy_level === level ? 'border-cyan/40 bg-cyan/10' : 'border-surface-2 bg-surface-1 hover:bg-surface-2'}`}>
              <div className="flex items-center gap-2">
                <span className={`text-xs font-bold w-5 h-5 rounded-full flex items-center justify-center ${form.autonomy_level === level ? 'bg-cyan text-white' : 'bg-surface-3 text-slate-400'}`}>{level}</span>
                <span className="text-sm font-medium text-white">
                  {['Observador', 'Recomendações', 'Automação Segura', 'Autopilot Completo', 'Estratégico'][level]}
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-1 ml-7">{AUTONOMY_DESCRIPTIONS[level]}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Metas da IA */}
      <div className="border border-cyan/20 bg-cyan/5 rounded-xl p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Target className="w-4 h-4 text-cyan" />
          <p className="text-sm font-semibold text-white">Metas da IA</p>
          <span className="text-xs text-slate-500">— define o que a IA vai otimizar</span>
        </div>

        {/* Métricas alvo */}
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Métricas Alvo</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Field label="ACoS Alvo (%)" k="target_acos" min={1} max={100} hint="Ex: 25 = 25%" />
            <Field label="ACoS Máximo (%)" k="maximum_acos" min={1} max={200} hint="Acima disso → reduzir bid" />
            <Field label="ROAS Alvo (x)" k="target_roas" step={0.1} min={0.1} hint="Ex: 4 = 4x retorno" />
            <Field label="TACoS Alvo (%)" k="target_tacos" min={1} max={100} hint="% gasto sobre vendas totais" />
            <Field label="TACoS Máximo (%)" k="maximum_tacos" min={1} max={100} hint="Gatilho para reduzir investimento" />
            <Field label={`Budget Total Diário (${form.currency_symbol || 'R$'})`} k="total_daily_budget" min={1} hint="Limite total da conta" />
          </div>
        </div>

        {/* Prioridade da IA */}
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Prioridade da IA ao Ajustar Bids</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {Object.entries(PRIORITY_MODE_LABELS).map(([mode, { label, hint }]) => (
              <button key={mode} onClick={() => set('ai_budget_priority_mode', mode)}
                className={`text-left p-3 rounded-xl border transition-all ${form.ai_budget_priority_mode === mode ? 'border-cyan/50 bg-cyan/10' : 'border-surface-2 bg-surface-1 hover:bg-surface-2'}`}>
                <div className="flex items-center gap-2 mb-0.5">
                  <div className={`w-3 h-3 rounded-full border-2 flex-shrink-0 ${form.ai_budget_priority_mode === mode ? 'border-cyan bg-cyan' : 'border-slate-500'}`} />
                  <span className={`text-xs font-semibold ${form.ai_budget_priority_mode === mode ? 'text-cyan' : 'text-slate-300'}`}>{label}</span>
                </div>
                <p className="text-[11px] text-slate-500 ml-5">{hint}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Orçamento diário alvo */}
        <div className="space-y-3">
          <div className="flex items-center justify-between p-3 rounded-xl border border-surface-2 bg-surface-1">
            <div>
              <p className="text-sm font-medium text-slate-300">Forçar Limite de Orçamento Diário</p>
              <p className="text-xs text-slate-500 mt-0.5">IA reduz bids para não ultrapassar o orçamento alvo definido abaixo</p>
            </div>
            <button onClick={() => set('ai_budget_enforcement', !form.ai_budget_enforcement)}
              className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ml-4 ${form.ai_budget_enforcement ? 'bg-cyan' : 'bg-surface-3'}`}>
              <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${form.ai_budget_enforcement ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
          </div>
          {form.ai_budget_enforcement && (
            <div className="ml-2">
              <Field
                label={`Orçamento Diário Alvo (${form.currency_symbol || 'R$'})`}
                k="ai_daily_budget_target"
                min={0}
                step={5}
                hint="A IA ajusta bids para que o gasto total do dia fique próximo deste valor"
              />
            </div>
          )}
        </div>

        {form.ai_budget_priority_mode && (
          <div className="flex items-start gap-2 p-3 bg-surface-1 border border-surface-2 rounded-xl">
            <Info className="w-3.5 h-3.5 text-cyan flex-shrink-0 mt-0.5" />
            <p className="text-xs text-slate-400">
              <span className="text-white font-semibold">Prioridade ativa: </span>
              {PRIORITY_MODE_LABELS[form.ai_budget_priority_mode]?.label} — {PRIORITY_MODE_LABELS[form.ai_budget_priority_mode]?.hint}.
              {form.ai_budget_enforcement && form.ai_daily_budget_target > 0 && (
                <> Limite de <span className="text-cyan font-semibold">{form.currency_symbol || 'R$'}{form.ai_daily_budget_target.toFixed(2)}/dia</span> será respeitado.</>
              )}
            </p>
          </div>
        )}
      </div>

      {/* Lances */}
      <div>
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Limites de Lance</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Field label={`Bid Mínimo (${form.currency_symbol || 'R$'})`} k="min_bid" step={0.01} min={0.02} />
          <Field label={`Bid Máximo (${form.currency_symbol || 'R$'})`} k="max_bid" step={0.10} min={0.10} />
          <Field label="Aumento Máx. (%)" k="max_bid_increase_pct" min={1} max={50} />
          <Field label="Redução Máx. (%)" k="max_bid_decrease_pct" min={1} max={50} />
        </div>
      </div>

      {/* Thresholds */}
      <div>
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Thresholds de Decisão</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Field label="Cliques mínimos" k="min_clicks_for_decision" min={1} hint="Para tomar decisão" />
          <Field label={`Spend mínimo (${form.currency_symbol || 'R$'})`} k="min_spend_for_decision" min={0.5} step={0.5} />
          <Field label="Pedidos mínimos p/ escalar" k="min_orders_for_scale" min={1} />
          <Field label="Cooldown (horas)" k="cooldown_hours" min={1} hint="Entre decisões no mesmo item" />
          <Field label="Pedidos p/ colher termo" k="harvest_after_orders" min={1} />
        </div>
      </div>

      {/* Módulos */}
      <div>
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Módulos Ativos</p>
        <div className="space-y-2">
          <Toggle label="Otimização de Bids" k="bid_optimization_enabled" hint="Ajustar bids de keywords" />
          <Toggle label="Colheita de Search Terms" k="search_term_optimization_enabled" hint="Promover termos com vendas para manual exact" />
          <Toggle label="Otimização de Budget" k="budget_optimization_enabled" hint="Ajustar orçamentos de campanhas" />
          <Toggle label="Dayparting (horários)" k="dayparting_enabled" hint="Ajustar bids por horário" />
          <Toggle label="Otimização de Placements" k="placement_optimization_enabled" hint="Ajustar top/rest/product pages" />
          <Toggle label="Criar Keyword Manual Exact" k="auto_create_manual_exact" hint="Ao colher termo, criar keyword exact automaticamente" />
          <Toggle label="Harvesting Agressivo" k="aggressive_harvesting" danger hint="Negativar termo na AUTO após criar manual (sem aguardar impressões)" />
        </div>
      </div>

      {/* Estoque */}
      <div>
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Controle de Estoque</p>
        <div className="space-y-2">
          <Toggle label="Pausar campanha sem estoque" k="auto_pause_zero_stock" hint="Pausa automática quando FBA = 0" />
          <Toggle label="Reduzir bid com estoque baixo" k="auto_reduce_low_stock" hint="Reduz investimento antes de pausar" />
        </div>
        <div className="grid grid-cols-2 gap-3 mt-3">
          <Field label="Estoque mínimo (un.)" k="minimum_stock_units" min={0} />
          <Field label="Dias mínimos de estoque" k="minimum_stock_days" min={0} />
        </div>
      </div>

      {/* Aprovações */}
      <div>
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Política de Aprovação</p>
        <div className="p-3 bg-surface-1 border border-surface-2 rounded-xl mb-3">
          <p className="text-xs text-slate-400 leading-relaxed">
            <span className="text-white font-semibold">Regra ativa:</span> decisões com <span className="text-cyan font-semibold">confiança ≥ 90%</span> são executadas automaticamente.
            Abaixo de 90% ficam pendentes para revisão. Risco <span className="text-red-400 font-semibold">muito alto</span> sempre exige aprovação humana.
          </p>
        </div>
        <div className="space-y-2">
          <Toggle label="Exigir aprovação para risco muito alto" k="require_approval_high_risk" hint="Ações críticas (negativar termos com venda histórica, pausar campanha rentável)" />
        </div>
      </div>

      {form.autonomy_level >= 2 && (
        <div className="flex items-start gap-2 p-3 bg-cyan/10 border border-cyan/20 rounded-xl">
          <Info className="w-4 h-4 text-cyan flex-shrink-0 mt-0.5" />
          <p className="text-xs text-cyan/80">
            <span className="font-semibold text-cyan">Modo Autopilot ativo (Nível {form.autonomy_level}):</span>{' '}
            Decisões com <span className="font-semibold">confiança ≥ 90%</span> são executadas automaticamente na Amazon Ads — aumentos e reduções de bid, colheita de termos, ajuste de budget e pausa por estoque.
            Decisões com confiança &lt; 90% ficam pendentes para revisão humana.
          </p>
        </div>
      )}
    </div>
  );
}