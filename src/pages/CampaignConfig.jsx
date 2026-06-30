import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Settings, DollarSign, Target, Zap, Clock, BarChart2,
  Package, Brain, Shield, Save, RefreshCw, Loader2,
  CheckCircle, AlertTriangle, Info, ChevronDown, ChevronUp
} from 'lucide-react';

const TABS = [
  { id: 'general', label: 'Geral', icon: Settings },
  { id: 'budget', label: 'Budget', icon: DollarSign },
  { id: 'objectives', label: 'Objetivos', icon: Target },
  { id: 'bids', label: 'Bids', icon: Zap },
  { id: 'auto_campaigns', label: 'Camps. Automáticas', icon: RefreshCw },
  { id: 'manual_campaigns', label: 'Camps. Manuais', icon: BarChart2 },
  { id: 'search_terms', label: 'Termos de Pesquisa', icon: Target },
  { id: 'dayparting', label: 'Dayparting', icon: Clock },
  { id: 'pacing', label: 'Pacing', icon: BarChart2 },
  { id: 'stock', label: 'Stock & Buy Box', icon: Package },
  { id: 'ai', label: 'IA', icon: Brain },
];

const DEFAULT_CONFIG = {
  // Geral
  brand_name: 'Living Finds',
  campaign_prefix: 'Living Finds',
  marketplace: 'Amazon Brasil',
  currency: 'BRL',
  timezone: 'America/Sao_Paulo',
  operation_mode: 'manual',
  primary_objective: 'acos',
  ads_profile_id: '',

  // Budget
  daily_budget_total: '',
  monthly_budget_total: '',
  max_budget_per_campaign: 20,
  max_budget_per_asin: 50,
  min_budget_per_campaign: 5,
  safety_reserve_pct: 10,
  proven_campaigns_pct: 60,
  discovery_campaigns_pct: 30,
  test_campaigns_pct: 10,
  allow_amazon_overage: false,
  max_overage_pct: 10,
  compensate_next_days: false,
  pause_discovery_at_limit: true,
  preserve_winning_campaigns: true,

  // Objetivos
  target_acos: 25,
  max_acos: 40,
  target_roas: 4,
  target_tacos: 15,
  min_margin: 20,
  max_cpc: 2,

  // Bids
  min_bid_global: 0.10,
  max_bid_global: 5.00,
  max_increase_pct: 15,
  max_decrease_pct: 20,
  min_change_amount: 0.05,
  cooldown_hours: 72,
  smoothing_factor: 0.25,
  min_clicks_to_act: 10,
  min_sales_to_act: 1,
  analysis_window_days: 14,
  neutral_zone_pct: 5,
  min_confidence: 0.6,

  // Campanhas AUTO
  create_auto_for_new_asins: true,
  auto_initial_budget: 20,
  auto_bid_strategy: 'dynamic_down_only',
  auto_bid_close_match: 0.30,
  auto_bid_loose_match: 0.25,
  auto_bid_substitutes: 0.20,
  auto_bid_complements: 0.20,
  auto_top_of_search_pct: 0,
  auto_rest_of_search_pct: 0,
  auto_product_pages_pct: 0,
  auto_learning_period_days: 14,

  // Campanhas MANUAIS
  exact_enabled: true,
  exact_auto_create: false,
  exact_requires_approval: true,
  exact_initial_budget: 15,
  exact_initial_bid: 0.50,
  exact_min_sales: 1,
  exact_max_acos: 35,
  phrase_enabled: true,
  phrase_auto_create: false,
  phrase_requires_approval: true,
  phrase_initial_budget: 15,
  phrase_initial_bid: 0.40,
  phrase_min_sales: 2,
  broad_enabled: false,
  broad_requires_approval: true,
  product_targeting_enabled: true,

  // Termos de pesquisa
  min_clicks_without_sale: 10,
  max_spend_without_sale: 5,
  max_days_without_sale: 30,
  auto_negate_exact: false,
  auto_negate_phrase: false,
  negate_phrase_requires_approval: true,
  auto_migrate_exact: false,
  auto_migrate_phrase: false,

  // Dayparting
  dayparting_enabled: false,
  dayparting_min_weeks: 4,
  dayparting_min_clicks_per_slot: 5,
  dayparting_auto_pause: false,
  dayparting_max_increase_pct: 30,
  dayparting_max_decrease_pct: 30,

  // Pacing
  pacing_enabled: true,
  pacing_max_pct_before_6h: 5,
  pacing_max_pct_before_9h: 15,
  pacing_max_pct_before_12h: 35,
  pacing_max_pct_before_15h: 55,
  pacing_max_pct_before_18h: 75,
  pacing_max_pct_before_21h: 90,

  // Stock & Buy Box
  pause_without_stock: true,
  reduce_with_low_stock: true,
  min_stock_units: 5,
  pause_without_buy_box: false,
  reduce_after_price_increase: true,
  price_change_stabilization_days: 3,

  // IA
  ai_enabled: true,
  ai_semantic_analysis: true,
  ai_anomaly_detection: true,
  ai_auto_execute: false,
  ai_min_confidence: 0.7,
  ai_max_daily_actions: 50,
  ai_max_campaigns_per_day: 3,
  ai_max_changes_per_campaign: 5,
};

function Section({ title, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-surface-2/30 transition-colors"
      >
        <span className="text-sm font-semibold text-white">{title}</span>
        {open ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
      </button>
      {open && <div className="px-5 pb-5 space-y-4 border-t border-surface-2">{children}</div>}
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-400 mb-1">{label}</label>
      {hint && <p className="text-xs text-slate-600 mb-1.5">{hint}</p>}
      {children}
    </div>
  );
}

function NumberInput({ value, onChange, min, max, step = 0.01, prefix, suffix }) {
  return (
    <div className="flex items-center gap-1.5">
      {prefix && <span className="text-xs text-slate-500">{prefix}</span>}
      <input
        type="number"
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        min={min}
        max={max}
        step={step}
        className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-slate-200 focus:outline-none focus:border-cyan/50"
      />
      {suffix && <span className="text-xs text-slate-500">{suffix}</span>}
    </div>
  );
}

function Toggle({ value, onChange, label }) {
  return (
    <div className="flex items-center gap-3">
      <button
        onClick={() => onChange(!value)}
        className={`relative w-10 h-5 rounded-full transition-colors ${value ? 'bg-cyan' : 'bg-surface-3'}`}
      >
        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${value ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </button>
      {label && <span className="text-xs text-slate-400">{label}</span>}
    </div>
  );
}

function SelectInput({ value, onChange, options }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-slate-200 focus:outline-none focus:border-cyan/50"
    >
      {options.map(o => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

// ── Tab Panels ──

function GeneralTab({ cfg, set }) {
  return (
    <div className="space-y-4">
      <Section title="Identificação">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Nome da marca">
            <input value={cfg.brand_name} onChange={e => set('brand_name', e.target.value)}
              className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-slate-200 focus:outline-none focus:border-cyan/50" />
          </Field>
          <Field label="Prefixo das campanhas">
            <input value={cfg.campaign_prefix} onChange={e => set('campaign_prefix', e.target.value)}
              className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-slate-200 focus:outline-none focus:border-cyan/50" />
          </Field>
          <Field label="Marketplace">
            <input value={cfg.marketplace} readOnly className="w-full px-3 py-2 bg-surface-3 border border-surface-3 rounded-lg text-sm text-slate-500" />
          </Field>
          <Field label="Moeda">
            <input value={cfg.currency} readOnly className="w-full px-3 py-2 bg-surface-3 border border-surface-3 rounded-lg text-sm text-slate-500" />
          </Field>
          <Field label="Timezone">
            <input value={cfg.timezone} readOnly className="w-full px-3 py-2 bg-surface-3 border border-surface-3 rounded-lg text-sm text-slate-500" />
          </Field>
          <Field label="Perfil Amazon Ads ID">
            <input value={cfg.ads_profile_id} onChange={e => set('ads_profile_id', e.target.value)} placeholder="ex: 1234567890"
              className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-slate-200 focus:outline-none focus:border-cyan/50" />
          </Field>
        </div>
      </Section>
      <Section title="Modo de operação">
        <Field label="Modo" hint="Simulação: nenhuma alteração real é executada na Amazon.">
          <SelectInput value={cfg.operation_mode} onChange={v => set('operation_mode', v)} options={[
            { value: 'simulation', label: 'Simulação (recomendado para começar)' },
            { value: 'manual', label: 'Manual (só executa com aprovação explícita)' },
            { value: 'semi_auto', label: 'Semiautomático' },
            { value: 'auto', label: 'Automático controlado' },
          ]} />
        </Field>
        <Field label="Objetivo principal">
          <SelectInput value={cfg.primary_objective} onChange={v => set('primary_objective', v)} options={[
            { value: 'acos', label: 'Otimizar por ACoS' },
            { value: 'roas', label: 'Otimizar por ROAS' },
            { value: 'tacos', label: 'Otimizar por TACoS' },
            { value: 'profit', label: 'Maximizar lucro' },
            { value: 'sales', label: 'Maximizar vendas dentro do budget' },
            { value: 'launch', label: 'Lançamento' },
            { value: 'visibility', label: 'Visibilidade' },
          ]} />
        </Field>
      </Section>
    </div>
  );
}

function BudgetTab({ cfg, set }) {
  const totalPct = (cfg.proven_campaigns_pct || 0) + (cfg.discovery_campaigns_pct || 0) + (cfg.test_campaigns_pct || 0);
  const pctOk = totalPct === 100;

  return (
    <div className="space-y-4">
      <Section title="Budget global">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Budget geral diário (R$)" hint="Obrigatório. Informe o valor diário máximo para todos os anúncios.">
            <NumberInput value={cfg.daily_budget_total} onChange={v => set('daily_budget_total', v)} min={0} step={1} prefix="R$" />
          </Field>
          <Field label="Budget geral mensal (R$)">
            <NumberInput value={cfg.monthly_budget_total} onChange={v => set('monthly_budget_total', v)} min={0} step={1} prefix="R$" />
          </Field>
          <Field label="Budget máximo por campanha (R$)">
            <NumberInput value={cfg.max_budget_per_campaign} onChange={v => set('max_budget_per_campaign', v)} min={1} step={1} prefix="R$" />
          </Field>
          <Field label="Budget máximo por ASIN (R$)">
            <NumberInput value={cfg.max_budget_per_asin} onChange={v => set('max_budget_per_asin', v)} min={1} step={1} prefix="R$" />
          </Field>
          <Field label="Budget mínimo por campanha (R$)">
            <NumberInput value={cfg.min_budget_per_campaign} onChange={v => set('min_budget_per_campaign', v)} min={1} step={1} prefix="R$" />
          </Field>
          <Field label="Reserva de segurança (%)">
            <NumberInput value={cfg.safety_reserve_pct} onChange={v => set('safety_reserve_pct', v)} min={0} max={50} step={1} suffix="%" />
          </Field>
        </div>
      </Section>

      <Section title="Distribuição do budget">
        {!pctOk && (
          <div className="flex items-center gap-2 px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs text-amber-400">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
            Soma dos percentuais: {totalPct}%. Deve ser exatamente 100%.
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Field label="Campanhas comprovadas (%)">
            <NumberInput value={cfg.proven_campaigns_pct} onChange={v => set('proven_campaigns_pct', v)} min={0} max={100} step={1} suffix="%" />
          </Field>
          <Field label="Descoberta (%)">
            <NumberInput value={cfg.discovery_campaigns_pct} onChange={v => set('discovery_campaigns_pct', v)} min={0} max={100} step={1} suffix="%" />
          </Field>
          <Field label="Testes (%)">
            <NumberInput value={cfg.test_campaigns_pct} onChange={v => set('test_campaigns_pct', v)} min={0} max={100} step={1} suffix="%" />
          </Field>
        </div>
      </Section>

      <Section title="Controlo de gasto">
        <div className="space-y-3">
          <Toggle value={cfg.allow_amazon_overage} onChange={v => set('allow_amazon_overage', v)} label="Permitir ultrapassagem diária Amazon" />
          {cfg.allow_amazon_overage && (
            <Field label="Limite máximo de ultrapassagem (%)">
              <NumberInput value={cfg.max_overage_pct} onChange={v => set('max_overage_pct', v)} min={0} max={100} step={1} suffix="%" />
            </Field>
          )}
          <Toggle value={cfg.compensate_next_days} onChange={v => set('compensate_next_days', v)} label="Compensar gasto nos dias seguintes" />
          <Toggle value={cfg.pause_discovery_at_limit} onChange={v => set('pause_discovery_at_limit', v)} label="Pausar exploração ao atingir limite" />
          <Toggle value={cfg.preserve_winning_campaigns} onChange={v => set('preserve_winning_campaigns', v)} label="Preservar campanhas vencedoras" />
        </div>
      </Section>
    </div>
  );
}

function ObjectivesTab({ cfg, set }) {
  const breakEven = cfg.min_margin > 0 ? (100 - cfg.min_margin).toFixed(1) : null;
  const acosAboveBreakeven = breakEven && cfg.target_acos > Number(breakEven);

  return (
    <div className="space-y-4">
      <Section title="Metas financeiras">
        {acosAboveBreakeven && (
          <div className="flex items-center gap-2 px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs text-amber-400">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
            ACoS alvo ({cfg.target_acos}%) acima do ACoS de equilíbrio estimado ({breakEven}%). Confirme que esta é a estratégia pretendida.
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="ACoS alvo (%)" hint="Percentagem de gasto em ads sobre as vendas.">
            <NumberInput value={cfg.target_acos} onChange={v => set('target_acos', v)} min={1} max={100} step={0.5} suffix="%" />
          </Field>
          <Field label="ACoS máximo (%)">
            <NumberInput value={cfg.max_acos} onChange={v => set('max_acos', v)} min={1} max={200} step={0.5} suffix="%" />
          </Field>
          <Field label="ROAS alvo">
            <NumberInput value={cfg.target_roas} onChange={v => set('target_roas', v)} min={0.1} max={50} step={0.1} suffix="x" />
          </Field>
          <Field label="TACoS alvo (%)">
            <NumberInput value={cfg.target_tacos} onChange={v => set('target_tacos', v)} min={1} max={100} step={0.5} suffix="%" />
          </Field>
          <Field label="Margem mínima (%)">
            <NumberInput value={cfg.min_margin} onChange={v => set('min_margin', v)} min={0} max={100} step={0.5} suffix="%" />
          </Field>
          <Field label="CPC máximo (R$)">
            <NumberInput value={cfg.max_cpc} onChange={v => set('max_cpc', v)} min={0.01} max={50} step={0.01} prefix="R$" />
          </Field>
        </div>
        {breakEven && (
          <div className="flex items-center gap-2 px-3 py-2 bg-surface-2 rounded-lg text-xs text-slate-400">
            <Info className="w-3.5 h-3.5 text-cyan flex-shrink-0" />
            ACoS de equilíbrio estimado com margem de {cfg.min_margin}%: <span className="text-white font-semibold ml-1">{breakEven}%</span>
          </div>
        )}
      </Section>
    </div>
  );
}

function BidsTab({ cfg, set }) {
  return (
    <div className="space-y-4">
      <Section title="Limites globais de bid">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Bid mínimo global (R$)">
            <NumberInput value={cfg.min_bid_global} onChange={v => set('min_bid_global', v)} min={0.02} max={10} step={0.01} prefix="R$" />
          </Field>
          <Field label="Bid máximo global (R$)">
            <NumberInput value={cfg.max_bid_global} onChange={v => set('max_bid_global', v)} min={0.10} max={100} step={0.01} prefix="R$" />
          </Field>
          <Field label="Aumento máximo por execução (%)">
            <NumberInput value={cfg.max_increase_pct} onChange={v => set('max_increase_pct', v)} min={1} max={100} step={1} suffix="%" />
          </Field>
          <Field label="Redução máxima por execução (%)">
            <NumberInput value={cfg.max_decrease_pct} onChange={v => set('max_decrease_pct', v)} min={1} max={100} step={1} suffix="%" />
          </Field>
          <Field label="Alteração mínima (R$)">
            <NumberInput value={cfg.min_change_amount} onChange={v => set('min_change_amount', v)} min={0.01} step={0.01} prefix="R$" />
          </Field>
          <Field label="Cooldown entre alterações (horas)">
            <NumberInput value={cfg.cooldown_hours} onChange={v => set('cooldown_hours', v)} min={1} max={168} step={1} suffix="h" />
          </Field>
          <Field label="Fator de suavização" hint="0 = sem mudança, 1 = bid ideal imediato.">
            <NumberInput value={cfg.smoothing_factor} onChange={v => set('smoothing_factor', v)} min={0.01} max={1} step={0.01} />
          </Field>
          <Field label="Janela de análise (dias)">
            <NumberInput value={cfg.analysis_window_days} onChange={v => set('analysis_window_days', v)} min={1} max={90} step={1} suffix="dias" />
          </Field>
          <Field label="Zona neutra (%)">
            <NumberInput value={cfg.neutral_zone_pct} onChange={v => set('neutral_zone_pct', v)} min={0} max={30} step={0.5} suffix="%" />
          </Field>
          <Field label="Confiança mínima para execução">
            <NumberInput value={cfg.min_confidence} onChange={v => set('min_confidence', v)} min={0.1} max={1} step={0.05} />
          </Field>
        </div>
      </Section>
      <Section title="Fórmulas" defaultOpen={false}>
        <div className="space-y-3 text-xs text-slate-400 font-mono bg-surface-2 rounded-lg p-4">
          <p><span className="text-cyan">bidIdeal (ACoS)</span> = bidAtual × ACoSAlvo / ACoSObservado</p>
          <p><span className="text-cyan">bidIdeal (ROAS)</span> = bidAtual × ROASObservado / ROASAlvo</p>
          <p><span className="text-cyan">novoBid</span> = bidAtual + {cfg.smoothing_factor} × (bidIdeal - bidAtual)</p>
          <p className="text-slate-500 mt-2">Aplicados: bid mín/máx, CPC máx, limite de aumento/redução, cooldown, stock, Buy Box, maturidade, budget.</p>
        </div>
      </Section>
    </div>
  );
}

function AutoCampaignsTab({ cfg, set }) {
  return (
    <div className="space-y-4">
      <Section title="Campanhas AUTO">
        <Toggle value={cfg.create_auto_for_new_asins} onChange={v => set('create_auto_for_new_asins', v)} label="Criar AUTO para novos ASINs" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
          <Field label="Budget inicial (R$)">
            <NumberInput value={cfg.auto_initial_budget} onChange={v => set('auto_initial_budget', v)} min={1} step={1} prefix="R$" />
          </Field>
          <Field label="Período mínimo de aprendizagem (dias)">
            <NumberInput value={cfg.auto_learning_period_days} onChange={v => set('auto_learning_period_days', v)} min={7} max={60} step={1} suffix="dias" />
          </Field>
          <Field label="Estratégia de bids">
            <SelectInput value={cfg.auto_bid_strategy} onChange={v => set('auto_bid_strategy', v)} options={[
              { value: 'dynamic_down_only', label: 'Dinâmica — somente redução' },
              { value: 'dynamic_up_down', label: 'Dinâmica — aumento e redução' },
              { value: 'fixed', label: 'Bid fixo' },
            ]} />
          </Field>
        </div>
        <div className="mt-4">
          <p className="text-xs font-semibold text-slate-400 mb-3">Bids por tipo de match</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { key: 'auto_bid_close_match', label: 'Close Match' },
              { key: 'auto_bid_loose_match', label: 'Loose Match' },
              { key: 'auto_bid_substitutes', label: 'Substitutes' },
              { key: 'auto_bid_complements', label: 'Complements' },
            ].map(f => (
              <Field key={f.key} label={f.label}>
                <NumberInput value={cfg[f.key]} onChange={v => set(f.key, v)} min={0.02} max={10} step={0.01} prefix="R$" />
              </Field>
            ))}
          </div>
        </div>
        <div className="mt-4">
          <p className="text-xs font-semibold text-slate-400 mb-3">Ajustes de placement (%)</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Topo da pesquisa">
              <NumberInput value={cfg.auto_top_of_search_pct} onChange={v => set('auto_top_of_search_pct', v)} min={0} max={900} step={1} suffix="%" />
            </Field>
            <Field label="Restante da pesquisa">
              <NumberInput value={cfg.auto_rest_of_search_pct} onChange={v => set('auto_rest_of_search_pct', v)} min={0} max={900} step={1} suffix="%" />
            </Field>
            <Field label="Páginas do produto">
              <NumberInput value={cfg.auto_product_pages_pct} onChange={v => set('auto_product_pages_pct', v)} min={0} max={900} step={1} suffix="%" />
            </Field>
          </div>
        </div>
      </Section>
    </div>
  );
}

function ManualCampaignsTab({ cfg, set }) {
  const types = [
    { prefix: 'exact', label: 'MANUAL-EXACT', hint: 'Criar quando: pedidos ≥ 1, relevância alta, dados maduros.' },
    { prefix: 'phrase', label: 'MANUAL-PHRASE', hint: 'Criar quando: vendas consistentes ≥ 2, ACoS dentro da meta.' },
    { prefix: 'broad', label: 'MANUAL-BROAD', hint: 'Desativado por padrão. Exige aprovação.' },
  ];
  return (
    <div className="space-y-4">
      {types.map(t => (
        <Section key={t.prefix} title={t.label}>
          <p className="text-xs text-slate-500 mb-3">{t.hint}</p>
          <div className="space-y-3">
            <Toggle value={cfg[`${t.prefix}_enabled`]} onChange={v => set(`${t.prefix}_enabled`, v)} label="Ativado" />
            <Toggle value={cfg[`${t.prefix}_auto_create`]} onChange={v => set(`${t.prefix}_auto_create`, v)} label="Criação automática" />
            <Toggle value={cfg[`${t.prefix}_requires_approval`]} onChange={v => set(`${t.prefix}_requires_approval`, v)} label="Aprovação obrigatória" />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-3">
            {cfg[`${t.prefix}_initial_budget`] !== undefined && (
              <Field label="Budget inicial (R$)">
                <NumberInput value={cfg[`${t.prefix}_initial_budget`]} onChange={v => set(`${t.prefix}_initial_budget`, v)} min={1} step={1} prefix="R$" />
              </Field>
            )}
            {cfg[`${t.prefix}_initial_bid`] !== undefined && (
              <Field label="Bid inicial (R$)">
                <NumberInput value={cfg[`${t.prefix}_initial_bid`]} onChange={v => set(`${t.prefix}_initial_bid`, v)} min={0.02} step={0.01} prefix="R$" />
              </Field>
            )}
            {cfg[`${t.prefix}_min_sales`] !== undefined && (
              <Field label="Vendas mínimas">
                <NumberInput value={cfg[`${t.prefix}_min_sales`]} onChange={v => set(`${t.prefix}_min_sales`, v)} min={0} step={1} />
              </Field>
            )}
            {cfg[`${t.prefix}_max_acos`] !== undefined && (
              <Field label="ACoS máximo (%)">
                <NumberInput value={cfg[`${t.prefix}_max_acos`]} onChange={v => set(`${t.prefix}_max_acos`, v)} min={1} max={200} step={0.5} suffix="%" />
              </Field>
            )}
          </div>
        </Section>
      ))}
      <Section title="Product Targeting">
        <Toggle value={cfg.product_targeting_enabled} onChange={v => set('product_targeting_enabled', v)} label="Ativado quando ASIN visitado gerar vendas" />
      </Section>
    </div>
  );
}

function SearchTermsTab({ cfg, set }) {
  return (
    <div className="space-y-4">
      <Section title="Regras de negativação">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Cliques mínimos sem venda">
            <NumberInput value={cfg.min_clicks_without_sale} onChange={v => set('min_clicks_without_sale', v)} min={1} max={100} step={1} />
          </Field>
          <Field label="Gasto máximo sem venda (R$)">
            <NumberInput value={cfg.max_spend_without_sale} onChange={v => set('max_spend_without_sale', v)} min={0.5} step={0.5} prefix="R$" />
          </Field>
          <Field label="Dias máximos sem venda">
            <NumberInput value={cfg.max_days_without_sale} onChange={v => set('max_days_without_sale', v)} min={7} max={90} step={1} suffix="dias" />
          </Field>
        </div>
        <div className="space-y-3 mt-3">
          <Toggle value={cfg.auto_negate_exact} onChange={v => set('auto_negate_exact', v)} label="Negativo exact automático" />
          <Toggle value={cfg.auto_negate_phrase} onChange={v => set('auto_negate_phrase', v)} label="Negativo phrase automático" />
          <Toggle value={cfg.negate_phrase_requires_approval} onChange={v => set('negate_phrase_requires_approval', v)} label="Negativo phrase exige aprovação (recomendado)" />
          <Toggle value={cfg.auto_migrate_exact} onChange={v => set('auto_migrate_exact', v)} label="Migração para exact automática" />
          <Toggle value={cfg.auto_migrate_phrase} onChange={v => set('auto_migrate_phrase', v)} label="Migração para phrase automática" />
        </div>
      </Section>
    </div>
  );
}

function DaypartingTab({ cfg, set }) {
  return (
    <div className="space-y-4">
      <Section title="Configuração geral">
        <Toggle value={cfg.dayparting_enabled} onChange={v => set('dayparting_enabled', v)} label="Dayparting ativado" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
          <Field label="Semanas mínimas de histórico">
            <NumberInput value={cfg.dayparting_min_weeks} onChange={v => set('dayparting_min_weeks', v)} min={2} max={52} step={1} suffix="semanas" />
          </Field>
          <Field label="Cliques mínimos por faixa">
            <NumberInput value={cfg.dayparting_min_clicks_per_slot} onChange={v => set('dayparting_min_clicks_per_slot', v)} min={1} max={100} step={1} />
          </Field>
          <Field label="Aumento horário máximo (%)">
            <NumberInput value={cfg.dayparting_max_increase_pct} onChange={v => set('dayparting_max_increase_pct', v)} min={0} max={100} step={5} suffix="%" />
          </Field>
          <Field label="Redução horária máxima (%)">
            <NumberInput value={cfg.dayparting_max_decrease_pct} onChange={v => set('dayparting_max_decrease_pct', v)} min={0} max={100} step={5} suffix="%" />
          </Field>
        </div>
        <Toggle value={cfg.dayparting_auto_pause} onChange={v => set('dayparting_auto_pause', v)} label="Permitir pausa automática por horário (requer aprovação antes de ativar)" />
        <div className="flex items-start gap-2 px-3 py-2 bg-surface-2 rounded-lg text-xs text-slate-500 mt-2">
          <Info className="w-3.5 h-3.5 text-cyan flex-shrink-0 mt-0.5" />
          Dados históricos por hora serão exibidos após importação dos relatórios da Amazon. A matriz Dia × Hora ficará disponível depois de {cfg.dayparting_min_weeks} semanas de dados.
        </div>
      </Section>
    </div>
  );
}

function PacingTab({ cfg, set }) {
  return (
    <div className="space-y-4">
      <Section title="Curva de pacing diário">
        <Toggle value={cfg.pacing_enabled} onChange={v => set('pacing_enabled', v)} label="Controlo de pacing ativado" />
        <p className="text-xs text-slate-500 mt-2">Percentual máximo do budget consumido até cada hora:</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-2">
          {[
            { key: 'pacing_max_pct_before_6h', label: 'Antes das 06h' },
            { key: 'pacing_max_pct_before_9h', label: 'Antes das 09h' },
            { key: 'pacing_max_pct_before_12h', label: 'Antes das 12h' },
            { key: 'pacing_max_pct_before_15h', label: 'Antes das 15h' },
            { key: 'pacing_max_pct_before_18h', label: 'Antes das 18h' },
            { key: 'pacing_max_pct_before_21h', label: 'Antes das 21h' },
          ].map(f => (
            <Field key={f.key} label={f.label}>
              <NumberInput value={cfg[f.key]} onChange={v => set(f.key, v)} min={0} max={100} step={1} suffix="%" />
            </Field>
          ))}
        </div>
        <div className="flex items-start gap-2 px-3 py-2 bg-surface-2 rounded-lg text-xs text-slate-500 mt-3">
          <Info className="w-3.5 h-3.5 text-cyan flex-shrink-0 mt-0.5" />
          Fórmula: pacing = gasto acumulado / gasto esperado. &lt;0,80 = subinvestimento · 0,80–1,10 = normal · &gt;1,25 = gasto acelerado.
        </div>
      </Section>
    </div>
  );
}

function StockTab({ cfg, set }) {
  return (
    <div className="space-y-4">
      <Section title="Stock & Buy Box">
        <div className="space-y-3">
          <Toggle value={cfg.pause_without_stock} onChange={v => set('pause_without_stock', v)} label="Pausar campanhas sem stock" />
          <Toggle value={cfg.reduce_with_low_stock} onChange={v => set('reduce_with_low_stock', v)} label="Reduzir bids com stock baixo" />
          <Field label="Stock mínimo (unidades)">
            <NumberInput value={cfg.min_stock_units} onChange={v => set('min_stock_units', v)} min={0} max={1000} step={1} />
          </Field>
          <Toggle value={cfg.pause_without_buy_box} onChange={v => set('pause_without_buy_box', v)} label="Pausar sem Buy Box" />
          <Toggle value={cfg.reduce_after_price_increase} onChange={v => set('reduce_after_price_increase', v)} label="Reduzir bids após aumento de preço" />
          <Field label="Dias de estabilização após mudança de preço">
            <NumberInput value={cfg.price_change_stabilization_days} onChange={v => set('price_change_stabilization_days', v)} min={1} max={30} step={1} suffix="dias" />
          </Field>
        </div>
        <div className="flex items-start gap-2 px-3 py-2 bg-surface-2 rounded-lg text-xs text-slate-500 mt-3">
          <Info className="w-3.5 h-3.5 text-cyan flex-shrink-0 mt-0.5" />
          A IA nunca aumenta bids quando: sem stock, Buy Box perdida, produto inelegível, preço fora do limite ou margem negativa.
        </div>
      </Section>
    </div>
  );
}

function AITab({ cfg, set }) {
  return (
    <div className="space-y-4">
      <Section title="Motor de IA">
        <div className="space-y-3">
          <Toggle value={cfg.ai_enabled} onChange={v => set('ai_enabled', v)} label="IA ativada" />
          <Toggle value={cfg.ai_semantic_analysis} onChange={v => set('ai_semantic_analysis', v)} label="Análise semântica de termos" />
          <Toggle value={cfg.ai_anomaly_detection} onChange={v => set('ai_anomaly_detection', v)} label="Deteção de anomalias" />
          <Toggle value={cfg.ai_auto_execute} onChange={v => set('ai_auto_execute', v)} label="Execução automática (apenas em modo Automático)" />
        </div>
        {cfg.ai_auto_execute && (
          <div className="flex items-center gap-2 px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs text-amber-400 mt-2">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
            Execução automática ativa. Recomendado testar em modo Simulação primeiro.
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
          <Field label="Confiança mínima para execução">
            <NumberInput value={cfg.ai_min_confidence} onChange={v => set('ai_min_confidence', v)} min={0.1} max={1} step={0.05} />
          </Field>
          <Field label="Máximo de ações diárias">
            <NumberInput value={cfg.ai_max_daily_actions} onChange={v => set('ai_max_daily_actions', v)} min={1} max={500} step={1} />
          </Field>
          <Field label="Máximo de campanhas criadas por dia">
            <NumberInput value={cfg.ai_max_campaigns_per_day} onChange={v => set('ai_max_campaigns_per_day', v)} min={0} max={50} step={1} />
          </Field>
          <Field label="Máximo de alterações por campanha">
            <NumberInput value={cfg.ai_max_changes_per_campaign} onChange={v => set('ai_max_changes_per_campaign', v)} min={1} max={50} step={1} />
          </Field>
        </div>
        <div className="flex items-start gap-2 px-3 py-2 bg-surface-2 rounded-lg text-xs text-slate-500 mt-3">
          <Info className="w-3.5 h-3.5 text-cyan flex-shrink-0 mt-0.5" />
          A IA interpreta, classifica, explica e prioriza. O motor matemático calcula os valores. A IA não define livremente valores financeiros.
        </div>
      </Section>
    </div>
  );
}

// ── Main Page ──

export default function CampaignConfig() {
  const [activeTab, setActiveTab] = useState('general');
  const [cfg, setCfg] = useState(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [account, setAccount] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const me = await base44.auth.me();
        const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
        const acc = accounts[0] || null;
        setAccount(acc);
        if (acc?.ads_profile_id) setCfg(prev => ({ ...prev, ads_profile_id: acc.ads_profile_id }));

        // Carregar config salva
        const rules = await base44.entities.BudgetRule.filter({ amazon_account_id: acc?.id }, '-created_date', 1);
        if (rules[0]) {
          const r = rules[0];
          setCfg(prev => ({
            ...prev,
            daily_budget_total: r.total_daily_budget || '',
            max_budget_per_campaign: r.max_budget_per_campaign || prev.max_budget_per_campaign,
            max_budget_per_asin: r.max_budget_per_asin || prev.max_budget_per_asin,
            min_bid_global: r.min_bid || prev.min_bid_global,
            max_bid_global: r.max_bid || prev.max_bid_global,
            max_increase_pct: r.bid_increase_step != null ? r.bid_increase_step : prev.max_increase_pct,
            max_decrease_pct: r.bid_decrease_step != null ? r.bid_decrease_step : prev.max_decrease_pct,
            target_acos: r.target_acos || prev.target_acos,
            target_roas: r.target_roas || prev.target_roas,
          }));
        }

        const autoCfg = await base44.entities.AutopilotConfig.filter({ amazon_account_id: acc?.id }, '-created_date', 1);
        if (autoCfg[0]) {
          const c = autoCfg[0];
          setCfg(prev => ({
            ...prev,
            target_acos: c.acos_target || prev.target_acos,
            target_roas: c.roas_target || prev.target_roas,
            min_bid_global: c.min_bid || prev.min_bid_global,
            max_bid_global: c.max_bid || prev.max_bid_global,
            max_increase_pct: c.max_bid_increase_pct || prev.max_increase_pct,
            max_decrease_pct: c.max_bid_decrease_pct || prev.max_decrease_pct,
            daily_budget_total: c.daily_budget_limit || prev.daily_budget_total,
          }));
        }
      } catch (e) {
        console.warn('CampaignConfig load error:', e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const set = (key, value) => setCfg(prev => ({ ...prev, [key]: value }));

  const validate = () => {
    const errors = [];
    const totalPct = (cfg.proven_campaigns_pct || 0) + (cfg.discovery_campaigns_pct || 0) + (cfg.test_campaigns_pct || 0);
    if (totalPct !== 100) errors.push(`Percentuais de distribuição somam ${totalPct}% (deve ser 100%)`);
    if (cfg.min_bid_global > cfg.max_bid_global) errors.push('Bid mínimo maior que bid máximo');
    if (cfg.ai_auto_execute && cfg.operation_mode === 'simulation') errors.push('Execução automática ativa em modo Simulação não tem efeito');
    if (!cfg.daily_budget_total) errors.push('Budget geral diário é obrigatório');
    return errors;
  };

  const save = async () => {
    const errors = validate();
    if (errors.length > 0) {
      setMsg({ type: 'error', text: errors.join(' · ') });
      return;
    }
    if (!account) {
      setMsg({ type: 'error', text: 'Nenhuma conta Amazon configurada.' });
      return;
    }
    setSaving(true);
    try {
      // Atualizar BudgetRule
      const existing = await base44.entities.BudgetRule.filter({ amazon_account_id: account.id }, '-created_date', 1);
      const ruleData = {
        amazon_account_id: account.id,
        total_daily_budget: Number(cfg.daily_budget_total),
        max_budget_per_campaign: cfg.max_budget_per_campaign,
        max_budget_per_asin: cfg.max_budget_per_asin,
        min_bid: cfg.min_bid_global,
        max_bid: cfg.max_bid_global,
        bid_increase_step: cfg.max_increase_pct,
        bid_decrease_step: cfg.max_decrease_pct,
        target_acos: cfg.target_acos,
        target_roas: cfg.target_roas,
      };
      if (existing[0]) {
        await base44.entities.BudgetRule.update(existing[0].id, ruleData);
      } else {
        await base44.entities.BudgetRule.create(ruleData);
      }

      // Atualizar AutopilotConfig
      const existingAuto = await base44.entities.AutopilotConfig.filter({ amazon_account_id: account.id }, '-created_date', 1);
      const autoData = {
        amazon_account_id: account.id,
        acos_target: cfg.target_acos,
        roas_target: cfg.target_roas,
        daily_budget_limit: Number(cfg.daily_budget_total),
        max_bid_increase_pct: cfg.max_increase_pct,
        max_bid_decrease_pct: cfg.max_decrease_pct,
        min_bid: cfg.min_bid_global,
        max_bid: cfg.max_bid_global,
        auto_apply_enabled: cfg.ai_auto_execute && cfg.operation_mode !== 'simulation',
        approval_required: cfg.exact_requires_approval,
      };
      if (existingAuto[0]) {
        await base44.entities.AutopilotConfig.update(existingAuto[0].id, autoData);
      } else {
        await base44.entities.AutopilotConfig.create(autoData);
      }

      setMsg({ type: 'success', text: 'Configuração salva com sucesso!' });
    } catch (e) {
      setMsg({ type: 'error', text: `Erro ao salvar: ${e.message}` });
    } finally {
      setSaving(false);
      setTimeout(() => setMsg(null), 6000);
    }
  };

  const tabProps = { cfg, set };

  const renderTab = () => {
    switch (activeTab) {
      case 'general': return <GeneralTab {...tabProps} />;
      case 'budget': return <BudgetTab {...tabProps} />;
      case 'objectives': return <ObjectivesTab {...tabProps} />;
      case 'bids': return <BidsTab {...tabProps} />;
      case 'auto_campaigns': return <AutoCampaignsTab {...tabProps} />;
      case 'manual_campaigns': return <ManualCampaignsTab {...tabProps} />;
      case 'search_terms': return <SearchTermsTab {...tabProps} />;
      case 'dayparting': return <DaypartingTab {...tabProps} />;
      case 'pacing': return <PacingTab {...tabProps} />;
      case 'stock': return <StockTab {...tabProps} />;
      case 'ai': return <AITab {...tabProps} />;
      default: return null;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 text-cyan animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
            <Settings className="w-5 h-5 text-cyan" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Configuração de Campanhas</h1>
            <p className="text-xs text-slate-400">Motor IA, bids, budget, dayparting e regras de operação</p>
          </div>
        </div>
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saving ? 'A guardar...' : 'Guardar alterações'}
        </button>
      </div>

      {msg && (
        <div className={`flex items-center gap-2 px-4 py-3 rounded-xl border text-sm font-medium ${
          msg.type === 'success' ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300' : 'bg-red-400/10 border-red-400/20 text-red-400'
        }`}>
          {msg.type === 'success' ? <CheckCircle className="w-4 h-4 flex-shrink-0" /> : <AlertTriangle className="w-4 h-4 flex-shrink-0" />}
          {msg.text}
        </div>
      )}

      {cfg.operation_mode === 'simulation' && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-cyan/5 border border-cyan/20 rounded-xl text-xs text-cyan">
          <Info className="w-3.5 h-3.5 flex-shrink-0" />
          Modo Simulação ativo — nenhuma alteração será executada na Amazon.
        </div>
      )}

      <div className="flex gap-5 min-h-0">
        {/* Sidebar tabs */}
        <div className="w-48 flex-shrink-0 space-y-1">
          {TABS.map(t => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm transition-colors text-left ${
                  activeTab === t.id
                    ? 'bg-cyan/15 text-cyan border border-cyan/20'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-surface-2'
                }`}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                <span className="font-medium text-xs">{t.label}</span>
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 space-y-4">
          {renderTab()}
        </div>
      </div>
    </div>
  );
}