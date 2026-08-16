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
  pendentes: '/sala-de-comando/legacy?tab=historico',
  execucao: '/sala-de-comando/legacy?tab=fila',
  monitoramento: '/sala-de-comando/legacy?tab=alertas',
  kickoff: '/sala-de-comando/legacy?tab=kickoff',
  sistema: '/sala-de-comando/legacy?tab=sync_monitor',
};

function formatDate(value) {
  if (!value) return 'Sem registro';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Sem registro';
  return date.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function queueTimestamp(item) {
  return item?.updated_at || item?.updated_date || item?.completed_at || item?.started_at || item?.scheduled_at || item?.created_at || item?.created_date || null;
}

function isWithinHours(value, hours) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) && timestamp >= Date.now() - hours * 60 * 60 * 1000;
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
        base44.entities.OptimizationDecision.filter({ amazon_account_id: aid }, '-created_at', 100).catch(() => []),
        base44.entities.ProductKickoffQueue.filter({ amazon_account_id: aid }, '-scheduled_at', 100).catch(() => []),
        base44.entities.AutoCampaignRepairQueue.filter({ amazon_account_id: aid }, '-scheduled_at', 100).catch(() => []),
        base44.entities.KeywordRepairQueue.filter({ amazon_account_id: aid }, '-scheduled_at', 100).catch(() => []),
        base44.entities.SyncExecutionLog.filter({ amazon_account_id: aid }, '-started_at', 100).catch(() => []),
        base44.entities.AdsBidChangeLog.filter({ amazon_account_id: aid }, '-created_at', 200).catch(() => []),
        base44.entities.Product.filter({ amazon_account_id: aid }, '-updated_at', 500).catch(() => []),
      ]);
      setData({ alerts, decisions, kickoff, repair, keyword, syncRuns, bidLogs, products });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const summary = useMemo(() => {
    const allQueue = [...data.kickoff, ...data.repair, ...data.keyword];
    const activeAlerts = data.alerts.filter(item => item.status === 'active');
    const urgentAlerts = activeAlerts.filter(item => ['critical', 'high'].includes(String(item.severity || '').toLowerCase()));
    const failedQueue = allQueue.filter(item => item.status === 'failed' && isWithinHours(queueTimestamp(item), 24));
    const pendingQueue = allQueue.filter(item => ['scheduled', 'processing'].includes(item.status) && isWithinHours(queueTimestamp(item), 2));
    const historicalQueue = allQueue.filter(item =>
      (['scheduled', 'processing'].includes(item.status) && !isWithinHours(queueTimestamp(item), 2)) ||
      (item.status === 'failed' && !isWithinHours(queueTimestamp(item), 24))
    );
    const pendingDecisions = data.decisions.filter(item => item.status === 'pending');
    const executedToday = data.decisions.filter(item => {
      const date = String(item.executed_at || item.updated_date || item.created_at || '').slice(0, 10);
      return item.status === 'executed' && date === new Date().toISOString().slice(0, 10);
    });
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
    return { allQueue, activeAlerts, urgentAlerts, failedQueue, pendingQueue, historicalQueue, pendingDecisions, executedToday, lastSync, healthOk, healthReasons, syncHealthy };
  }, [data]);

  const priorityItems = useMemo(() => {
    const productByAsin = new Map(data.products.map(product => [String(product.asin || '').toUpperCase(), product]));
    const withProduct = (item) => {
      const asin = String(item.asin || '').toUpperCase();
      const product = productByAsin.get(asin);
      const title = product?.product_name || product?.display_name || product?.title || '';
      return [asin || item.campaign_name || item.alert_type || 'Motor de alertas', title].filter(Boolean).join(' · ');
    };
    const alerts = summary.activeAlerts.slice(0, 30).map(item => ({
      id: `alert-${item.id}`,
      type: 'Alerta',
      title: item.title || item.message || item.alert_type || 'Alerta operacional',
      detail: item.recommendation || item.description || item.message || 'Revisar condição detectada pelo motor.',
      tone: ['critical', 'high'].includes(String(item.severity || '').toLowerCase()) ? 'danger' : 'warning',
      meta: withProduct(item),
    }));
    const decisions = summary.pendingDecisions.slice(0, 30).map(item => ({
      id: `decision-${item.id}`,
      type: 'Decisão',
      title: item.title || item.action || item.decision_type || 'Decisão pendente',
      detail: item.rationale || item.reason || 'Aguardando avaliação ou execução.',
      tone: 'info',
      meta: withProduct(item),
    }));
    return [...alerts, ...decisions];
  }, [summary, data.products]);

  const visiblePriorities = verTodasPrioridades ? priorityItems : priorityItems.slice(0, 5);

  const renderTab = () => {
    if (activeTab === 'pendentes') {
      return (
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-5">
          <section className="rounded-2xl border border-white/[0.08] bg-white/[0.025] overflow-hidden">
            <div className="px-5 py-4 border-b border-white/[0.06] flex items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-white">Prioridades operacionais</h2>
                <p className="text-xs text-slate-500 mt-1">Itens reais que exigem análise, aprovação ou correção.</p>
              </div>
              <Link to={LEGACY_LINKS.pendentes} className="text-xs text-blue-300 hover:text-blue-200">Abrir painel completo →</Link>
            </div>
            {priorityItems.length === 0 ? (
              <div className="p-10 text-center">
                <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto" />
                <p className="text-sm text-slate-300 mt-3">Nenhuma ação imediata encontrada.</p>
                <p className="text-xs text-slate-500 mt-1">O histórico e as rotinas continuam disponíveis no painel completo.</p>
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
                <StatusLine label="Fila operacional" status={summary.failedQueue.length === 0 ? 'ok' : 'warning'} detail={`${summary.pendingQueue.length} em andamento · ${summary.failedQueue.length} falhas${summary.historicalQueue.length ? ` · ${summary.historicalQueue.length} histórico(s)` : ''}`} />
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
          ['Em andamento', summary.pendingQueue.length],
          ['Falhas recentes', summary.failedQueue.length],
          ['Histórico', summary.historicalQueue.length],
          ['Concluídos', summary.allQueue.filter(item => item.status === 'completed').length],
        ],
      },
      monitoramento: {
        icon: Activity,
        title: 'Monitoramento do motor',
        description: 'Visão consolidada de alertas, alterações de bid, rotinas e histórico de execução.',
        stats: [
          ['Alertas ativos', summary.activeAlerts.length],
          ['Alertas urgentes', summary.urgentAlerts.length],
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
            <p className="text-sm text-slate-400 mt-2">Ações determinísticas, risco operacional e aprovações do motor.</p>
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
        <MetricCard label="Fila com erro" value={summary.failedQueue.length} detail={`${summary.pendingQueue.length} em processamento${summary.historicalQueue.length ? ` · ${summary.historicalQueue.length} histórico(s)` : ''}`} tone={summary.failedQueue.length > 0 ? 'danger' : 'default'} icon={XCircle} />
        <MetricCard label="Aprovação humana" value={summary.pendingDecisions.length} detail="aguardando decisão" tone={summary.pendingDecisions.length > 0 ? 'warning' : 'default'} icon={Clock3} />
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
