import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import {
  Activity, AlertTriangle, Bot, CheckCircle2, Clock3,
  ExternalLink, Loader2, RefreshCw, Rocket, ServerCog, ShieldCheck,
  Sparkles, Wrench, XCircle,
} from 'lucide-react';
import TokenExpiredBanner from '@/components/amazon/TokenExpiredBanner';

const TABS = [
  { id: 'pendentes', label: 'Pendentes' },
  { id: 'execucao', label: 'Execução' },
  { id: 'monitoramento', label: 'Monitoramento' },
  { id: 'kickoff', label: 'Kick-off' },
  { id: 'sistema', label: 'Sistema' },
];

const LEGACY_LINKS = {
  pendentes: '/sala-de-comando?tab=pendentes',
  execucao: '/sala-de-comando?tab=execucao',
  monitoramento: '/sala-de-comando?tab=monitoramento',
  kickoff: '/sala-de-comando?tab=kickoff',
  sistema: '/sala-de-comando?tab=sistema',
};

function formatDate(value) {
  if (!value) return 'Sem registro';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Sem registro';
  return date.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}


function queueStatus(item) {
  return String(
    item?.status || ''
  )
    .trim()
    .toLowerCase();
}

function queueTimestamp(item) {
  return item?.updated_at || item?.updated_date || item?.completed_at || item?.started_at || item?.scheduled_at || item?.created_at || item?.created_date || null;
}

function isWithinHours(value, hours) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) && timestamp >= Date.now() - hours * 60 * 60 * 1000;
}

function parseDecisionData(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;

  try {
    return JSON.parse(String(value));
  } catch {
    return {};
  }
}

function decisionStatus(item) {
  return String(
    item?.confirmation_status ||
    item?.queue_status ||
    item?.status ||
    ''
  ).toLowerCase();
}



/*
 * ========================================================
 * V3 OPERATIONAL ACTION PLAN
 * ========================================================
 *
 * Prioridades operacionais representam trabalho futuro
 * decidido/proposto pelo V3.
 *
 * NÃO representam alertas informativos.
 *
 * Ciclo:
 *
 * AI/V3
 *   -> operational priority
 *   -> executable queue
 *   -> Amazon
 *   -> confirmed execution
 *
 * Hard guards permanecem em Proteções.
 */

function v3PlannedActionType(item) {
  const action = String(
    item?.action ||
    item?.decision_type ||
    item?.proposed_action ||
    item?.recommended_action ||
    ''
  ).toLowerCase();

  const reason = String(
    item?.reason ||
    item?.rationale ||
    item?.decision_reason ||
    ''
  ).toLowerCase();

  const text = `${action} ${reason}`;

  if (
    /kick.?off|launch_product|product_launch/.test(text)
  ) {
    return 'KICKOFF';
  }

  if (
    /create.*campaign|new.*campaign|manual_exact|harvest/.test(text)
  ) {
    return 'CREATE_CAMPAIGN';
  }

  if (
    /replace|rebuild|replacement/.test(text)
  ) {
    return 'REBUILD_CAMPAIGN';
  }

  if (
    /increase.*bid|raise.*bid|bid_increase/.test(text)
  ) {
    return 'INCREASE_BID';
  }

  if (
    /reduce.*bid|decrease.*bid|lower.*bid|bid_reduction/.test(text)
  ) {
    return 'REDUCE_BID';
  }

  if (
    /budget/.test(text)
  ) {
    return 'BUDGET';
  }

  if (
    /negative/.test(text)
  ) {
    return 'NEGATIVE_TARGET';
  }

  if (
    /pause/.test(text)
  ) {
    return 'PAUSE';
  }

  if (
    /reactivat|resume|restart/.test(text)
  ) {
    return 'REACTIVATE';
  }

  if (
    /zero_delivery|recovery|recover/.test(text)
  ) {
    return 'RECOVERY';
  }

  return 'OPTIMIZATION';
}

function isV3ProtectionOnly(item) {
  const text = String(
    [
      item?.status,
      item?.reason,
      item?.rationale,
      item?.code,
      item?.blocker_code,
      item?.decision_reason
    ]
      .filter(Boolean)
      .join(' ')
  ).toUpperCase();

  return (
    /OUT_OF_STOCK/.test(text) ||
    /PRODUCT_NOT_ELIGIBLE/.test(text) ||
    /NOT_BUYABLE/.test(text) ||
    /BUYABILITY/.test(text) ||
    /LISTING/.test(text) ||
    /SKU_NOT_AUTHORIZED/.test(text) ||
    /OUT_OF_SCOPE/.test(text) ||
    /HARD_GUARD/.test(text)
  );
}

function isV3CompletedAction(item) {
  const status = String(
    item?.status || ''
  ).toLowerCase();

  return [
    'executed',
    'confirmed',
    'completed',
    'amazon_confirmed',
    'superseded',
    'cancelled'
  ].includes(status);
}

function isV3FutureOperationalAction(item) {
  if (!item) return false;

  const operationalText = String([
    item?.status, item?.queue_status, item?.approval_status, item?.reason_code,
    item?.error_message, item?.action, item?.decision_type,
  ].filter(Boolean).join(' ')).toUpperCase();
  if (
    item?.hide_from_live_operational_feed === true ||
    /CANCELLED|CANCELED|SKIPPED|SUPERSEDED|EXPIRED|NO_DECISION|SOFT_BID_BLOCK/.test(operationalText) ||
    /(^|[^A-Z])HOLD([^A-Z]|$)/.test(operationalText)
  ) return false;

  if (isV3ProtectionOnly(item)) {
    return false;
  }

  if (isV3CompletedAction(item)) {
    return false;
  }

  const status = String(
    item?.status || ''
  ).toLowerCase();

  /*
   * Somente trabalho ainda existente.
   */
  if (
    [
      'pending',
      'approved',
      'scheduled',
      'ready',
      'proposed',
      'planned',
      'processing',
      'queued'
    ].includes(status)
  ) {
    return true;
  }

  /*
   * Alguns registros V3 podem não possuir status explícito
   * ainda, mas possuem ação proposta.
   */
  return Boolean(
    item?.action ||
    item?.proposed_action ||
    item?.recommended_action
  );
}

function v3ActionLabel(item) {
  switch (v3PlannedActionType(item)) {

    case 'KICKOFF':
      return 'Kick-off de produto';

    case 'CREATE_CAMPAIGN':
      return 'Criar nova campanha';

    case 'REBUILD_CAMPAIGN':
      return 'Substituir campanha ineficiente';

    case 'INCREASE_BID':
      return 'Aumentar bid';

    case 'REDUCE_BID':
      return 'Reduzir bid';

    case 'BUDGET':
      return 'Ajustar orçamento';

    case 'NEGATIVE_TARGET':
      return 'Adicionar segmentação negativa';

    case 'PAUSE':
      return 'Pausar campanha ineficiente';

    case 'REACTIVATE':
      return 'Reativar campanha';

    case 'RECOVERY':
      return 'Recuperar entrega';

    default:
      return 'Otimização V4';
  }
}

function v3OperationalPriority(item) {
  const type = v3PlannedActionType(item);

  /*
   * P0 — impedir prejuízo atual.
   */
  if (
    type === 'REDUCE_BID' ||
    type === 'PAUSE'
  ) {
    return 0;
  }

  /*
   * P1 — criar capacidade de venda.
   */
  if (
    type === 'KICKOFF' ||
    type === 'CREATE_CAMPAIGN' ||
    type === 'REBUILD_CAMPAIGN' ||
    type === 'RECOVERY' ||
    type === 'NEGATIVE_TARGET'
  ) {
    return 1;
  }

  /*
   * P2 — escalar ativos economicamente bons.
   */
  if (
    type === 'INCREASE_BID' ||
    type === 'BUDGET' ||
    type === 'REACTIVATE'
  ) {
    return 2;
  }

  return 3;
}

function isV3OperationallyActionable(item) {
  const priority = v3OperationalPriority(item);

  const status = String([
    item?.status, item?.queue_status, item?.approval_status,
    item?.reason_code, item?.error_message, item?.action,
  ].filter(Boolean).join(' ')).toUpperCase();

  /*
   * Histórico resolvido não entra nas prioridades.
   */
  if (
    priority >= 4 ||
    item?.hide_from_live_operational_feed === true ||
    /SUPERSEDED|CANCELLED|CANCELED|CONFIRMED|SKIPPED|EXPIRED|NO_DECISION|SOFT_BID_BLOCK/.test(status) ||
    /(^|[^A-Z])HOLD([^A-Z]|$)/.test(status)
  ) {
    return false;
  }

  return true;
}

function isV3Decision(item) {
  const data = parseDecisionData(item?.data_used);

  const policy = String(
    item?.policy_version ||
    data?.policy_version ||
    ''
  ).toUpperCase();

  const owner = String(
    item?.decision_owner ||
    item?.canonical_engine ||
    data?.canonical_engine ||
    ''
  ).toUpperCase();

  const source = String(
    item?.source_function ||
    data?.original_source_function ||
    ''
  );

  /*
   * Compatibilidade de transição:
   *
   * decisões criadas pelos submotores que hoje são
   * componentes INTERNOS do V3 contam como V3 mesmo
   * quando registros antigos ainda não receberam todos
   * os campos policy_version / decision_owner.
   */
  const internalV3Sources = new Set([
    'runDeterministicDecisionEngine',
    'runSalesModeWasteRotation',
    'runIntradaySalesRecovery',
    'runAsinPortfolioDiversificationGuard',
    'runCanonicalDecisionCycle',
    'runCanonicalProfitEngineV3',
  ]);

  return (
    policy === 'PROFIT_ENGINE_V4' ||
    owner === 'CANONICAL_PROFIT_ENGINE_V4' ||
    policy === 'PROFIT_ENGINE_V3' ||
    owner === 'CANONICAL_PROFIT_ENGINE_V3' ||
    internalV3Sources.has(source) ||
    Boolean(item?.canonical_action_type)
  );
}

function isConfirmedDecision(item) {
  const status = decisionStatus(item);

  return (
    status === 'confirmed' ||
    String(item?.confirmation_status || '').toLowerCase() === 'confirmed' ||
    item?.confirmed_at != null
  );
}

function isExecutedDecision(item) {
  const status = decisionStatus(item);

  return (
    status === 'executed' ||
    status === 'confirmed' ||
    item?.executed_at != null ||
    item?.confirmed_at != null
  );
}

function isProtectedDecision(item) {
  const status = decisionStatus(item);

  const reason = String(
    item?.cancelled_reason ||
    item?.reason_code ||
    item?.blocked_reason ||
    item?.reason ||
    ''
  ).toUpperCase();

  return (
    ['cancelled', 'canceled', 'superseded', 'rejected'].includes(status) ||
    /(OUT_OF_STOCK|NOT_BUYABLE|LISTING_|OFFER_|WINNER_PROTECTION|PRODUCT_NOT_ELIGIBLE|SAFE_CPC|ACCOUNT_)/.test(reason)
  );
}

function isToday(value) {
  if (!value) return false;

  const d = new Date(value);

  if (Number.isNaN(d.getTime())) {
    return false;
  }

  const now = new Date();

  return (
    d.toLocaleDateString(
      'en-CA',
      { timeZone: 'America/Sao_Paulo' }
    ) ===
    now.toLocaleDateString(
      'en-CA',
      { timeZone: 'America/Sao_Paulo' }
    )
  );
}

const RETRYABLE_QUEUE_ERROR = /(\b429\b|rate.?limit|throttl|timeout|timed.?out|network|temporar|\b502\b|\b503\b|\b504\b|\b524\b|connection reset|circuit.?open)/i;

function isRetryableQueueFailure(item) {
  const attempts = Number(item?.attempt_count || 0);
  const maxAttempts = Math.max(1, Number(item?.max_attempts || 5));
  return attempts < maxAttempts && (item?.retryable === true || RETRYABLE_QUEUE_ERROR.test(String(item?.last_error || item?.error_code || '')));
}

function isSafetyBlockedQueue(item, product) {
  if (['waiting_stock', 'cancelled'].includes(queueStatus(item))) return true;
  const scope = String(product?.ads_scope_status || '').toLowerCase();
  if (['not_authorized', 'manual_block', 'mapping_conflict'].includes(scope)) return true;
  if (!product) return false;
  const stock = Number(product.fulfillable_quantity ?? product.available_quantity ?? product.inventory_quantity ?? product.stock ?? product.fba_inventory);
  return Number.isFinite(stock) && stock <= 0;
}


/*
 * =========================================================
 * CANONICAL PROFIT ENGINE V3 — AGENDA OPERACIONAL
 * =========================================================
 *
 * Esta lista reflete o scheduler oficial confirmado:
 *
 * 22:45 métricas
 * 23:00 IA + V3
 * 23:20 executor
 * 23:35 confirmação Amazon
 * 23:50 remote truth
 * domingo 21:00 revisão semanal ampla
 *
 * Não é um segundo scheduler no frontend.
 * É somente representação visual do scheduler real.
 */
const V3_SCHEDULED_ACTIONS = [
  {
    id: 'daily-metrics',
    label: 'Atualizar métricas Ads',
    time: '22:45',
    hour: 22,
    minute: 45,
    cadence: 'daily',
    detail:
      'Atualiza métricas de campanhas e SKUs antes da revisão diária.',
  },
  {
    id: 'daily-ai-review',
    label: 'Revisão diária V4',
    time: '23:00',
    hour: 23,
    minute: 0,
    cadence: 'daily',
    highlight: true,
    detail:
      'Full scan SKU por SKU: vendas, ACoS, ROAS, CPC, bids, budget, waste, zero delivery, winners, harvesting, kick-off e rebuild.',
  },
  {
    id: 'daily-execution',
    label: 'Executar decisões admissíveis',
    time: '23:20',
    hour: 23,
    minute: 20,
    cadence: 'daily',
    detail:
      'Envia à execução os ajustes aprovados pelo CANONICAL_PROFIT_ENGINE_V4.',
  },
  {
    id: 'daily-confirmation',
    label: 'Confirmar alterações na Amazon',
    time: '23:35',
    hour: 23,
    minute: 35,
    cadence: 'daily',
    detail:
      'Confere bids, campanhas, keywords e demais alterações efetivamente aplicadas.',
  },
  {
    id: 'daily-truth',
    label: 'Sincronizar verdade Amazon',
    time: '23:50',
    hour: 23,
    minute: 50,
    cadence: 'daily',
    detail:
      'Atualiza o estado remoto final; Amazon prevalece sobre expectativas locais antigas.',
  },
  {
    id: 'weekly-ai-review',
    label: 'Revisão semanal ampla da IA',
    time: '21:00',
    hour: 21,
    minute: 0,
    cadence: 'sunday',
    highlight: true,
    detail:
      'Domingo: compara 7d × 30d, reavalia campanhas atuais e pausadas, winners, estrutura e ajustes autônomos.',
  },
];

function brtParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat(
    'en-CA',
    {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }
  ).formatToParts(date);

  return Object.fromEntries(
    parts.map(part => [
      part.type,
      part.value,
    ])
  );
}

function brtMinutesNow() {
  const parts = brtParts();

  return (
    Number(parts.hour || 0) * 60 +
    Number(parts.minute || 0)
  );
}

function brtWeekdayIndex() {
  const short = String(
    brtParts().weekday || ''
  ).toLowerCase();

  const map = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
  };

  return map[short] ?? 0;
}

function nextScheduledText(item) {
  const targetMinutes =
    Number(item.hour || 0) * 60 +
    Number(item.minute || 0);

  const nowMinutes =
    brtMinutesNow();

  if (item.cadence === 'daily') {
    if (targetMinutes > nowMinutes) {
      return `Hoje às ${item.time}`;
    }

    return `Amanhã às ${item.time}`;
  }

  if (item.cadence === 'sunday') {
    const weekday =
      brtWeekdayIndex();

    let days =
      (7 - weekday) % 7;

    if (
      days === 0 &&
      targetMinutes <= nowMinutes
    ) {
      days = 7;
    }

    if (days === 0) {
      return `Hoje às ${item.time}`;
    }

    if (days === 1) {
      return `Amanhã às ${item.time}`;
    }

    return `Domingo às ${item.time}`;
  }

  return item.time;
}

function MetricCard({ label, value, detail, tone = 'default', icon: Icon }) {
  const toneClass = {
    default: 'border-white/10 bg-white/[0.035] text-white',
    info: 'border-blue-400/20 bg-blue-500/10 text-blue-300',
    success: 'border-emerald-400/20 bg-emerald-500/10 text-emerald-300',
    warning: 'border-amber-400/20 bg-amber-500/10 text-amber-300',
    danger: 'border-red-400/20 bg-red-500/10 text-red-300',
  }[tone];

  return (
    <div className={`rounded-2xl border p-4 ${toneClass}`}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] uppercase tracking-[0.12em] text-slate-500">{label}</p>
        {Icon ? <Icon className="w-4 h-4 opacity-80" /> : null}
      </div>
      <p className="text-2xl font-semibold tracking-[-0.04em] mt-3">{value}</p>
      <p className="text-[11px] text-slate-500 mt-1">{detail}</p>
    </div>
  );
}


function ScheduledV3Actions() {
  return (
    <div className="border-t border-white/[0.06] bg-white/[0.012]">
      <div className="px-5 pt-5 pb-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Clock3 className="w-4 h-4 text-blue-300" />
              <h3 className="text-sm font-semibold text-white">
                Próximas ações programadas
              </h3>
            </div>

            <p className="text-[11px] text-slate-500 mt-1">
              Amazon Truth → Snapshot → IA → V4 → Fila Canônica → Amazon → Confirmação → Amazon Truth · horário de Brasília
            </p>
          </div>

          <span className="inline-flex items-center rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-semibold text-emerald-300">
            Automático
          </span>
        </div>
      </div>

      <div className="px-5 pb-5">
        <div className="rounded-xl border border-white/[0.07] bg-black/10 overflow-hidden">
          {V3_SCHEDULED_ACTIONS.map((item, index) => (
            <div
              key={item.id}
              className={`flex items-start gap-3 px-4 py-3 ${
                index !== V3_SCHEDULED_ACTIONS.length - 1
                  ? 'border-b border-white/[0.055]'
                  : ''
              }`}
            >
              <div
                className={`mt-0.5 w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
                  item.highlight
                    ? 'bg-blue-500/12 text-blue-300'
                    : 'bg-white/[0.04] text-slate-400'
                }`}
              >
                {item.id.includes('review') ? (
                  <Bot className="w-4 h-4" />
                ) : item.id.includes('confirmation') || item.id.includes('truth') ? (
                  <CheckCircle2 className="w-4 h-4" />
                ) : (
                  <Clock3 className="w-4 h-4" />
                )}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-xs font-semibold text-slate-200">
                    {item.time}
                  </span>

                  <span className="text-xs text-slate-300">
                    {item.label}
                  </span>

                  <span className="text-[10px] text-blue-300/80">
                    {nextScheduledText(item)}
                  </span>
                </div>

                <p className="text-[11px] text-slate-500 leading-relaxed mt-1">
                  {item.detail}
                </p>
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 mt-3 text-[10px] text-slate-500">
          <span>
            Métricas
          </span>
          <span>→</span>
          <span>
            V4
          </span>
          <span>→</span>
          <span>
            Execução
          </span>
          <span>→</span>
          <span>
            Confirmação
          </span>
          <span>→</span>
          <span className="text-emerald-400/80">
            Amazon truth
          </span>
        </div>
      </div>
    </div>
  );
}

function StatusLine({ label, status, detail }) {
  const good = status === 'success' || status === 'connected' || status === 'ok';
  return (
    <div className="flex items-center justify-between gap-4 py-3 border-b border-white/[0.06] last:border-0">
      <div className="min-w-0">
        <p className="text-sm text-slate-200">{label}</p>
        <p className="text-[11px] text-slate-500 mt-0.5 truncate">{detail}</p>
      </div>
      <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold ${good ? 'text-emerald-400' : 'text-amber-400'}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${good ? 'bg-emerald-400' : 'bg-amber-400'}`} />
        {good ? 'Operacional' : 'Atenção'}
      </span>
    </div>
  );
}

export default function SalaDeComandoPremium() {
  const [activeTab, setActiveTab] = useState('pendentes');
  const [account, setAccount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [verTodasPrioridades, setVerTodasPrioridades] = useState(false);
  const [data, setData] = useState({
    alerts: [], decisions: [], kickoff: [], repair: [], keyword: [], syncRuns: [], bidLogs: [], products: [],
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      let accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      if (!accounts.length) accounts = await base44.entities.AmazonAccount.filter({ status: 'connected' });
      if (!accounts.length) accounts = await base44.entities.AmazonAccount.list('-updated_date', 1);
      const current = accounts[0] || null;
      setAccount(current);
      if (!current) return;

      const aid = current.id;
      const [alerts, decisions, kickoff, repair, keyword, syncRuns, bidLogs, products] = await Promise.all([
        base44.entities.Alert.filter({ amazon_account_id: aid }, '-created_at', 100).catch(() => []),
        base44.entities.OptimizationDecision.filter({ amazon_account_id: aid }, '-created_at', 1000).catch(() => []),
        base44.entities.ProductKickoffQueue.filter({ amazon_account_id: aid }, '-updated_at', 1000).catch(() => []),
        base44.entities.AutoCampaignRepairQueue.filter({ amazon_account_id: aid }, '-updated_at', 1000).catch(() => []),
        base44.entities.KeywordRepairQueue.filter({ amazon_account_id: aid }, '-updated_at', 1000).catch(() => []),
        base44.entities.SyncExecutionLog.filter({ amazon_account_id: aid }, '-started_at', 100).catch(() => []),
        base44.entities.AdsBidChangeLog.filter({ amazon_account_id: aid }, '-created_at', 1000).catch(() => []),
        base44.entities.Product.filter({ amazon_account_id: aid }, '-updated_at', 500).catch(() => []),
      ]);
      setData({ alerts, decisions, kickoff, repair, keyword, syncRuns, bidLogs, products });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();

    /*
     * Central operacional V3:
     * atualizar o estado sem exigir reload manual.
     */
    const timer = window.setInterval(
      () => {
        load();
      },
      60_000
    );

    const onFocus = () => {
      load();
    };

    window.addEventListener(
      'focus',
      onFocus
    );

    return () => {
      window.clearInterval(timer);

      window.removeEventListener(
        'focus',
        onFocus
      );
    };
  }, [load]);

  const summary = useMemo(() => {
    const allQueue = [...data.kickoff, ...data.repair, ...data.keyword];
    const productByAsin = new Map(data.products.map(product => [String(product.asin || '').toUpperCase(), product]));
    const queueProduct = (item) => productByAsin.get(String(item?.asin || '').toUpperCase());
    const activeAlerts = data.alerts.filter(item => item.status === 'active');
    const urgentAlerts = activeAlerts.filter(item => ['critical', 'high'].includes(String(item.severity || '').toLowerCase()));
    const safetyBlockedQueue = allQueue.filter(item => isSafetyBlockedQueue(item, queueProduct(item)));
    /*
     * V3 CURRENT-STATE QUEUE CLASSIFICATION
     *
     * A UI reflete o estado ATUAL da entidade.
     * Um item que já foi recuperado de failed -> scheduled
     * deixa imediatamente de contar como falha.
     */
    const retryingQueue = allQueue.filter(item =>
      queueStatus(item) === 'failed' &&
      isRetryableQueueFailure(item)
    );

    const failedQueue = allQueue.filter(item =>
      queueStatus(item) === 'failed' &&
      isWithinHours(queueTimestamp(item), 24) &&
      !isSafetyBlockedQueue(
        item,
        queueProduct(item)
      ) &&
      !isRetryableQueueFailure(item)
    );

    const pendingQueue = allQueue.filter(item =>
      (
        ['scheduled', 'processing'].includes(
          queueStatus(item)
        ) &&
        isWithinHours(
          queueTimestamp(item),
          2
        )
      ) ||
      retryingQueue.includes(item)
    );

    const historicalQueue = allQueue.filter(item =>
      (
        ['scheduled', 'processing'].includes(
          queueStatus(item)
        ) &&
        !isWithinHours(
          queueTimestamp(item),
          2
        )
      ) ||
      (
        queueStatus(item) === 'failed' &&
        !isWithinHours(
          queueTimestamp(item),
          24
        ) &&
        !retryingQueue.includes(item)
      )
    );
    const v3Decisions =
      data.decisions.filter(isV3Decision);

    /*
     * Fila executável real do V3.
     */
    const pendingDecisions =
      v3Decisions.filter(item =>
        [
          'pending',
          'approved',
          'queued',
          'processing',
          'executing',
          'waiting_retry'
        ].includes(decisionStatus(item))
      )
      .filter(isV3OperationallyActionable)
      .sort(
        (a, b) =>
          v3OperationalPriority(a) -
          v3OperationalPriority(b)
      );

    /*
     * Execuções registradas nas OptimizationDecision.
     */
    const executedDecisionToday =
      v3Decisions.filter(item =>
        isExecutedDecision(item) &&
        isToday(
          item.confirmed_at ||
          item.executed_at ||
          item.updated_at ||
          item.updated_date ||
          item.created_at
        )
      );

    /*
     * AdsBidChangeLog é evidência operacional de que
     * uma mutação de bid realmente aconteceu.
     *
     * Não deixar o card zerado apenas porque uma decisão
     * antiga não recebeu confirmation_status.
     */
    const bidExecutionToday =
      data.bidLogs.filter(item =>
        isToday(
          item.created_at ||
          item.created_date ||
          item.updated_at
        )
      );

    const executedToday = [
      ...executedDecisionToday,
      ...bidExecutionToday
    ];

    const confirmedToday =
      v3Decisions.filter(item =>
        isConfirmedDecision(item) &&
        isToday(
          item.confirmed_at ||
          item.updated_at ||
          item.updated_date ||
          item.executed_at
        )
      );

    const protectedDecisions =
      v3Decisions.filter(
        isProtectedDecision
      );

    const awaitingConfirmation =
      v3Decisions.filter(item =>
        isExecutedDecision(item) &&
        !isConfirmedDecision(item)
      );
    const lastSync = [...data.syncRuns].sort((left, right) =>
      new Date(right.completed_at || right.started_at || right.created_date || 0) - new Date(left.completed_at || left.started_at || left.created_date || 0)
    )[0] || null;
    const syncHealthy = ['success', 'completed', 'ok'].includes(String(lastSync?.status || '').toLowerCase());
    const healthReasons = [
      !lastSync ? 'sem sincronização registrada' : !syncHealthy ? `última sincronização: ${lastSync.status || 'status desconhecido'}` : null,
      failedQueue.length ? `${failedQueue.length} falha(s) recente(s) na fila` : null,
      urgentAlerts.length ? `${urgentAlerts.length} alerta(s) crítico(s)` : null,
    ].filter(Boolean);
    const healthOk = healthReasons.length === 0;
    return {
      allQueue,
      activeAlerts,
      urgentAlerts,
      failedQueue,
      pendingQueue,
      retryingQueue,
      safetyBlockedQueue,
      historicalQueue,
      pendingDecisions,
      executedToday,
      confirmedToday,
      protectedDecisions,
      awaitingConfirmation,
      v3Decisions,
      lastSync,
      healthOk,
      healthReasons,
      syncHealthy
    };
  }, [data]);

  const priorityItems = useMemo(() => {
    const productByAsin = new Map(
      data.products.map(product => [
        String(
          product.asin || ''
        ).toUpperCase(),
        product,
      ])
    );

    const withProduct = (item) => {
      const asin = String(
        item?.asin ||
        item?.advertised_asin ||
        ''
      ).toUpperCase();

      const product =
        productByAsin.get(asin);

      const title =
        product?.product_name ||
        product?.display_name ||
        product?.title ||
        '';

      return [
        asin ||
        item?.campaign_name ||
        item?.sku ||
        'V4',
        title,
      ]
        .filter(Boolean)
        .join(' · ');
    };

    /*
     * =====================================================
     * 1. DECISÕES FUTURAS DO V3
     * =====================================================
     *
     * Alertas NÃO entram aqui.
     *
     * Somente decisões ainda existentes no fluxo:
     * planned/proposed/pending/approved/queued/scheduled.
     */
    const plannedDecisions = data.decisions
      .filter(
        isV3FutureOperationalAction
      )
      .filter(
        item =>
          !isV3ProtectionOnly(item)
      )
      .map(item => {
        const actionType =
          v3PlannedActionType(item);

        const current =
          item.current_value ??
          item.value_before;

        const proposed =
          item.proposed_value ??
          item.value_after;

        const valueDetail =
          Number.isFinite(Number(current)) &&
          Number.isFinite(Number(proposed))
            ? ` ${Number(current).toFixed(2)} → ${Number(proposed).toFixed(2)}`
            : '';

        return {
          id: `decision-${item.id}`,

          raw: item,

          type:
            'Ação V4',

          actionType,

          title:
            `${v3ActionLabel(item)}${valueDetail}`,

          detail:
            item.rationale ||
            item.reason ||
            item.decision_reason ||
            'Ação definida pelo CANONICAL_PROFIT_ENGINE_V4 aguardando execução.',

          tone:
            (
              actionType === 'REDUCE_BID' ||
              actionType === 'PAUSE'
            )
              ? 'warning'
              : (
                  actionType === 'KICKOFF' ||
                  actionType === 'CREATE_CAMPAIGN' ||
                  actionType === 'REBUILD_CAMPAIGN' ||
                  actionType === 'RECOVERY'
                )
                ? 'info'
                : 'success',

          meta:
            withProduct(item),

          priority:
            v3OperationalPriority(item),

          timestamp:
            item.updated_at ||
            item.updated_date ||
            item.created_at ||
            item.created_date ||
            null,
        };
      });

    /*
     * =====================================================
     * 2. KICK-OFF
     * =====================================================
     *
     * Produto novo/elegível que entrou no pipeline.
     */
    const kickoffActions = data.kickoff
      .filter(
        item =>
          ['scheduled', 'processing', 'ready', 'queued']
            .includes(
              queueStatus(item)
            )
      )
      .filter(
        item =>
          !isV3ProtectionOnly(item)
      )
      .map(item => ({
        id: `kickoff-${item.id}`,

        raw: item,

        type:
          'Ação V4',

        actionType:
          'KICKOFF',

        title:
          'Kick-off de produto',

        detail:
          item.reason ||
          item.last_error ||
          item.description ||
          'Produto elegível aguardando criação ou ativação de cobertura Ads.',

        tone:
          'info',

        meta:
          withProduct(item),

        priority:
          1,

        timestamp:
          queueTimestamp(item),
      }));

    /*
     * =====================================================
     * 3. REBUILD / REPAIR DE CAMPANHA
     * =====================================================
     */
    const campaignRepairActions = data.repair
      .filter(
        item =>
          ['scheduled', 'processing', 'ready', 'queued']
            .includes(
              queueStatus(item)
            )
      )
      .filter(
        item =>
          !isV3ProtectionOnly(item)
      )
      .map(item => ({
        id: `repair-${item.id}`,

        raw: item,

        type:
          'Ação V4',

        actionType:
          'REBUILD_CAMPAIGN',

        title:
          'Reparar ou substituir campanha',

        detail:
          item.last_error ||
          item.reason ||
          item.description ||
          'Estrutura de campanha identificada pelo V4 para reparo/rebuild.',

        tone:
          'info',

        meta:
          withProduct(item),

        priority:
          1,

        timestamp:
          queueTimestamp(item),
      }));

    /*
     * =====================================================
     * 4. KEYWORD/HARVEST REPAIR
     * =====================================================
     */
    const keywordActions = data.keyword
      .filter(
        item =>
          ['scheduled', 'processing', 'ready', 'queued']
            .includes(
              queueStatus(item)
            )
      )
      .filter(
        item =>
          !isV3ProtectionOnly(item)
      )
      .map(item => ({
        id: `keyword-${item.id}`,

        raw: item,

        type:
          'Ação V4',

        actionType:
          'CREATE_CAMPAIGN',

        title:
          item.search_term
            ? `Promover termo: ${item.search_term}`
            : 'Criar/ajustar segmentação vencedora',

        detail:
          item.last_error ||
          item.reason ||
          item.description ||
          'Termo/keyword identificado para correção, harvesting ou promoção MANUAL EXACT.',

        tone:
          'info',

        meta:
          withProduct(item),

        priority:
          1,

        timestamp:
          queueTimestamp(item),
      }));

    /*
     * =====================================================
     * PRIORIDADE FINAL
     * =====================================================
     *
     * P0:
     * perda econômica atual.
     *
     * P1:
     * criação/recovery/kickoff/rebuild/harvest.
     *
     * P2:
     * scale de winner/budget.
     */
    const combined = [
      ...plannedDecisions,
      ...kickoffActions,
      ...campaignRepairActions,
      ...keywordActions,
    ];

    /*
     * Deduplicação operacional.
     */
    const unique = new Map();

    for (const item of combined) {
      const raw = item.raw || {};

      const key = [
        item.actionType,
        raw.asin ||
          raw.advertised_asin ||
          '',
        raw.campaign_id ||
          raw.amazon_campaign_id ||
          '',
        raw.ad_group_id ||
          '',
        raw.keyword_id ||
          '',
        raw.search_term ||
          '',
      ].join('|');

      const existing =
        unique.get(key);

      if (!existing) {
        unique.set(
          key,
          item
        );

        continue;
      }

      const currentTime =
        new Date(
          item.timestamp || 0
        ).getTime();

      const existingTime =
        new Date(
          existing.timestamp || 0
        ).getTime();

      if (currentTime > existingTime) {
        unique.set(
          key,
          item
        );
      }
    }

    return [...unique.values()]
      .sort((a, b) => {
        const priorityDiff =
          Number(a.priority || 9) -
          Number(b.priority || 9);

        if (priorityDiff !== 0) {
          return priorityDiff;
        }

        return (
          new Date(
            b.timestamp || 0
          ).getTime()
          -
          new Date(
            a.timestamp || 0
          ).getTime()
        );
      });
  }, [
    data.decisions,
    data.kickoff,
    data.repair,
    data.keyword,
    data.products,
  ]);

  const visiblePriorities = verTodasPrioridades ? priorityItems : priorityItems.slice(0, 5);

  const renderTab = () => {
    if (activeTab === 'pendentes') {
      return (
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-5">
          <section className="rounded-2xl border border-white/[0.08] bg-white/[0.025] overflow-hidden">
            <div className="px-5 py-4 border-b border-white/[0.06] flex items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-white">Prioridades operacionais</h2>
                <p className="text-xs text-slate-500 mt-1">Ações definidas pela IA e pelo V4 que aguardam execução.</p>
              </div>
              <Link to={LEGACY_LINKS.pendentes} className="text-xs text-blue-300 hover:text-blue-200">Ver decisões completas →</Link>
            </div>
            {priorityItems.length === 0 ? (
              <div className="p-10 text-center">
                <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto" />
                <p className="text-sm text-slate-300 mt-3">Nenhuma ação V4 aguardando execução.</p>
                <p className="text-xs text-slate-500 mt-1">A próxima revisão diária ou semanal poderá gerar novas prioridades.</p>
              </div>
            ) : (
              <>
                <div className="divide-y divide-white/[0.06]">
                  {visiblePriorities.map(item => (
                    <div key={item.id} className="p-5 flex items-start gap-4 hover:bg-white/[0.025] transition-colors">
                      <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${item.tone === 'danger' ? 'bg-red-500/12 text-red-400' : item.tone === 'warning' ? 'bg-amber-500/12 text-amber-400' : 'bg-blue-500/12 text-blue-300'}`}>
                        {item.tone === 'danger' ? <AlertTriangle className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[10px] uppercase tracking-wider text-slate-500">{item.type}</span>
                          <span className="text-[10px] text-slate-600">{item.meta}</span>
                        </div>
                        <h3 className="text-sm font-semibold text-white mt-1">{item.title}</h3>
                        <p className="text-xs text-slate-400 leading-relaxed mt-1 line-clamp-2">{item.detail}</p>
                      </div>
                      <Link to={LEGACY_LINKS.pendentes} className="p-2 rounded-lg border border-white/[0.08] text-slate-400 hover:text-white hover:bg-white/[0.04]" aria-label="Ver detalhes">
                        <ExternalLink className="w-4 h-4" />
                      </Link>
                    </div>
                  ))}
                </div>
                <ScheduledV3Actions />

                {priorityItems.length > 5 && (
                  <div className="px-5 py-3 border-t border-white/[0.06] flex items-center justify-center bg-white/[0.02]">
                    <button
                      type="button"
                      onClick={() => setVerTodasPrioridades(v => !v)}
                      className="text-xs font-semibold text-blue-300 hover:text-blue-200 transition-colors"
                    >
                      {verTodasPrioridades ? 'Ver menos' : `Ver todas (${priorityItems.length})`}
                    </button>
                  </div>
                )}
              </>
            )}
          </section>

          <aside className="space-y-5">
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-5">
              <h2 className="text-sm font-semibold text-white">Saúde operacional</h2>
              <div className="mt-3">
                <StatusLine label="Conta Amazon" status={account?.status} detail={account?.profile_name || account?.name || 'Conta vinculada'} />
                <StatusLine label="Última sincronização" status={summary.syncHealthy ? 'success' : summary.lastSync?.status} detail={summary.healthReasons[0] || formatDate(summary.lastSync?.started_at || summary.lastSync?.created_date)} />
                <StatusLine label="Fila operacional" status={summary.failedQueue.length === 0 ? 'ok' : 'warning'} detail={`${summary.pendingQueue.length} em andamento/recuperação · ${summary.failedQueue.length} falhas executáveis${summary.safetyBlockedQueue.length ? ` · ${summary.safetyBlockedQueue.length} bloqueio(s) de segurança` : ''}${summary.historicalQueue.length ? ` · ${summary.historicalQueue.length} histórico(s)` : ''}`} />
              </div>
            </div>
            <div className="rounded-2xl border border-white/[0.08] bg-gradient-to-br from-blue-500/10 to-violet-500/5 p-5">
              <Sparkles className="w-5 h-5 text-blue-300" />
              <h2 className="text-sm font-semibold text-white mt-3">Atalhos operacionais</h2>
              <div className="grid gap-2 mt-4">
                <Link to="/logs" className="rounded-xl border border-white/[0.08] bg-black/10 px-3 py-2.5 text-xs text-slate-300 hover:text-white">Ver logs</Link>
                <Link to="/ads" className="rounded-xl border border-white/[0.08] bg-black/10 px-3 py-2.5 text-xs text-slate-300 hover:text-white">Campanhas afetadas</Link>
                <Link to="/products" className="rounded-xl border border-white/[0.08] bg-black/10 px-3 py-2.5 text-xs text-slate-300 hover:text-white">Produtos e estoque</Link>
              </div>
            </div>
          </aside>
        </div>
      );
    }

    const config = {
      execucao: {
        icon: Wrench,
        title: 'Fila e execução',
        description: 'Acompanhe processamento, retries, backoff e erros reais sem misturar com decisões pendentes.',
        stats: [
          ['Em andamento/recuperação', summary.pendingQueue.length],
          ['Falhas executáveis', summary.failedQueue.length],
          ['Histórico', summary.historicalQueue.length],
          ['Concluídos', summary.allQueue.filter(item => item.status === 'completed').length],
        ],
      },
      monitoramento: {
        icon: Activity,
        title: 'Monitoramento do motor',
        description: 'Visão consolidada de alertas, alterações de bid, rotinas e histórico de execução.',
        stats: [
          ['Ações V4 ativas', summary.activeAlerts.length],
          ['Ações V4 urgentes', summary.urgentAlerts.length],
          ['Alterações de bid', data.bidLogs.length],
        ],
      },
      kickoff: {
        icon: Rocket,
        title: 'Kick-off de produtos',
        description: 'Produtos elegíveis, fila, ciclos, falhas e acompanhamento de criação de campanhas.',
        stats: [
          ['Na fila', data.kickoff.filter(item => ['scheduled', 'processing'].includes(item.status)).length],
          ['Falhas', data.kickoff.filter(item => item.status === 'failed').length],
          ['Concluídos', data.kickoff.filter(item => item.status === 'completed').length],
        ],
      },
      sistema: {
        icon: ServerCog,
        title: 'Sistema e integrações',
        description: 'Amazon Ads, SP-API, autenticação, reports e observabilidade técnica.',
        stats: [
          ['Rotinas registradas', data.syncRuns.length],
          ['Última sync', formatDate(summary.lastSync?.started_at || summary.lastSync?.created_date)],
          ['Status', summary.lastSync?.status || 'sem registro'],
        ],
      },
    }[activeTab];

    const Icon = config.icon;
    return (
      <section className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-6 md:p-8">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-5">
          <div className="flex items-start gap-4">
            <div className="w-11 h-11 rounded-2xl bg-blue-500/12 text-blue-300 flex items-center justify-center"><Icon className="w-5 h-5" /></div>
            <div>
              <h2 className="text-xl font-semibold text-white tracking-[-0.03em]">{config.title}</h2>
              <p className="text-sm text-slate-400 mt-1 max-w-2xl">{config.description}</p>
            </div>
          </div>
          <Link to={LEGACY_LINKS[activeTab]} className="inline-flex items-center gap-2 rounded-xl bg-blue-500 text-white px-4 py-2.5 text-xs font-semibold hover:bg-blue-400">
            Abrir painel operacional <ExternalLink className="w-3.5 h-3.5" />
          </Link>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 mt-8">
          {config.stats.map(([label, value]) => (
            <div key={label} className="rounded-xl border border-white/[0.07] bg-black/10 p-4">
              <p className="text-[10px] uppercase tracking-wider text-slate-500">{label}</p>
              <p className="text-lg font-semibold text-white mt-2">{value}</p>
            </div>
          ))}
        </div>
      </section>
    );
  };

  return (
    <div className="p-4 md:p-6 space-y-5 animate-fade-in max-w-[1680px] mx-auto">
      {account ? <TokenExpiredBanner accountId={account.id} /> : null}

      <section className="rounded-3xl border border-[#E5E7EB] bg-white p-5 md:p-7 overflow-hidden relative">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_80%_0%,rgba(37,99,235,0.07),transparent_38%)] pointer-events-none" />
        <div className="relative flex flex-col xl:flex-row xl:items-center justify-between gap-5">
          <div>
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-blue-300">
              <ShieldCheck className="w-3.5 h-3.5" /> Central operacional
            </div>
            <h1 className="text-2xl md:text-3xl font-semibold text-white tracking-[-0.045em] mt-2">Central de Decisões</h1>
            <p className="text-sm text-slate-400 mt-2">Decisões do CANONICAL_PROFIT_ENGINE_V4, execução Amazon e proteções operacionais.</p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <div className={`rounded-xl border px-3 py-2 ${summary.healthOk ? 'border-emerald-400/20 bg-emerald-500/10' : 'border-amber-400/20 bg-amber-500/10'}`}>
              <p className={`text-xs font-semibold ${summary.healthOk ? 'text-emerald-300' : 'text-amber-300'}`}>
                {summary.healthOk ? 'Operação estável' : 'Atenção necessária'}
              </p>
              <p className="text-[10px] text-slate-500 mt-0.5">{summary.healthOk ? `Sync: ${formatDate(summary.lastSync?.started_at || summary.lastSync?.created_date)}` : summary.healthReasons.join(' · ')}</p>
            </div>
            <button type="button" onClick={load} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border border-white/[0.09] bg-white/[0.04] px-3.5 py-2.5 text-xs font-semibold text-slate-200 hover:bg-white/[0.07] disabled:opacity-50">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Atualizar
            </button>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <MetricCard label="Ação imediata" value={summary.urgentAlerts.length + summary.pendingDecisions.length} detail="prioridades e aprovações" tone={summary.urgentAlerts.length > 0 ? 'danger' : 'info'} icon={AlertTriangle} />
        <MetricCard label="Executadas hoje" value={summary.executedToday.length} detail="decisões concluídas" tone="success" icon={CheckCircle2} />
        <MetricCard label="Fila com erro" value={summary.failedQueue.length} detail={`${summary.pendingQueue.length} em processamento/recuperação${summary.safetyBlockedQueue.length ? ` · ${summary.safetyBlockedQueue.length} protegidos` : ''}${summary.historicalQueue.length ? ` · ${summary.historicalQueue.length} histórico(s)` : ''}`} tone={summary.failedQueue.length > 0 ? 'danger' : 'default'} icon={XCircle} />
        <MetricCard label="Protegidas pelo V4" value={summary.protectedDecisions?.length || 0} detail="hard guards / superseded" tone={summary.pendingDecisions.length > 0 ? 'warning' : 'default'} icon={Clock3} />
        <MetricCard label="Saúde do sistema" value={summary.healthOk ? 'Estável' : 'Atenção'} detail={summary.healthOk ? 'sincronização e fila operacionais' : summary.healthReasons.join(' · ')} tone={summary.healthOk ? 'success' : 'warning'} icon={Activity} />
      </div>

      <div className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-1.5 overflow-x-auto">
        <div className="flex min-w-max gap-1">
          {TABS.map(item => (
            <button key={item.id} type="button" onClick={() => setActiveTab(item.id)} className={`px-4 py-2.5 rounded-xl text-xs font-semibold transition-colors ${activeTab === item.id ? 'bg-blue-500 text-white shadow-lg shadow-blue-950/20' : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'}`}>
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {renderTab()}
    </div>
  );
}
