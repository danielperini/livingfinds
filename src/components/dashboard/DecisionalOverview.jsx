import { groupOperationalAlerts, decisionRecoveryEligibility } from '../../../base44/shared/operationalState.js';
import { readAllDashboardPages } from '../../../base44/shared/dashboardReads.js';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { loadMotorDashboardStatus, refreshMotorDashboard } from '@/lib/motorDashboardRead';
import MotorOperationalReadout from './MotorOperationalReadout';
import { base44 } from '@/api/base44Client';
import { RefreshCw, Loader2 } from 'lucide-react';
import MetricCard from '@/components/ui/MetricCard';
import MotorDecisionFeed from '@/components/dashboard/MotorDecisionFeed';
import { isDecisionQueueOverdue } from '@/lib/operationalQueueHealth';

const fmtBRL = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2 }).format(Number(v) || 0);
const fmtPct = (v) => `${(Number(v) || 0).toFixed(1)}%`;

function lastXDaysRange(days) {
  const end = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
  const start = new Date(new Date(end + 'T12:00:00Z').getTime() - (days - 1) * 86400000).toISOString().slice(0, 10);
  return { start, end };
}

function pctChange(curr, prev) {
  if (!prev || prev === 0) return null;
  return ((curr - prev) / prev) * 100;
}

function FreshnessSource({ label, timestamp, coverage }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-theme-card-2 border border-[var(--border-color)]">
      <span className="text-[11px] text-theme-muted font-medium">{label}</span>
      <span className="text-[11px]">{timestamp ? new Date(timestamp).toLocaleString('pt-BR') : 'sem timestamp'} · {coverage?.status === 'fresh' ? 'cobertura recente completa' : 'cobertura incompleta ou não verificada'} ({coverage?.coverage_percent ?? '—'}%)</span>
    </div>
  );
}

function AttentionCard({ alert }) {
  return <div className="rounded-xl border border-amber-200 p-3">
    <p className="font-semibold">{alert.title || alert.alert_type || 'Alerta'} · {alert.classification}</p>
    <p>{alert.asin || 'Conta'} · campanha {alert.campaign_id || '—'} · {alert.occurrences} ocorrência(s)</p>
    <p className="text-xs">{typeof alert.message === 'string' ? alert.message : typeof alert.details === 'string' ? alert.details : 'Consultar evidência técnica.'}</p>
    {alert.classification === 'remote_unknown' && <p>Reconciliação pendente. Replay bloqueado por segurança.</p>}
  </div>;
}

function AttentionPanel({ accountId, decisions = [] }) {
  const [state, setState] = useState({ loading: true, error: '', rows: [] });
  useEffect(() => {
    if (!accountId) return;
    let active = true;
    setState({ loading: true, error: '', rows: [] });
    readAllDashboardPages(base44.entities.Alert, { filter: { amazon_account_id: accountId } })
      .then(rows => { if (active) setState({ loading: false, error: '', rows }); })
      .catch(error => { if (active) setState({ loading: false, error: error.message, rows: [] }); });
    return () => { active = false; };
  }, [accountId]);
  if (state.loading) return <p>Consultando alertas e evidências…</p>;
  if (state.error) return <p role="alert">Falha técnica na leitura de alertas: {state.error}</p>;
  const groups = groupOperationalAlerts(state.rows);
  const overdue = decisions.filter(row => isDecisionQueueOverdue(row) && decisionRecoveryEligibility(row).safe);
  return <div className="space-y-3 text-xs">
    <p>{groups.active.length} alertas acionáveis · {groups.reconciliation.length} pendentes de reconciliação · {groups.history.length} registros no histórico</p>
    {overdue.length > 0 && <p role="alert">{overdue.length} propostas recentes sem evidência de envio estão atrasadas; elegibilidade ainda deve ser validada pelo executor.</p>}
    {groups.active.length === 0 && <p>Nenhum alerta acionável com evidência recente. Isso não comprova saúde das fontes.</p>}
    <div className="grid md:grid-cols-2 gap-3">{groups.active.map(row => <AttentionCard key={row.id} alert={row} />)}</div>
    {groups.reconciliation.length > 0 && <section aria-label="Pendente de reconciliação"><p>Estado remoto desconhecido</p>{groups.reconciliation.map(row => <AttentionCard key={row.id} alert={row} />)}</section>}
    <details><summary>Histórico preservado ({groups.history.length})</summary><div className="max-h-64 overflow-auto">{groups.history.map((row,index) => <p key={`${row.id}-${index}`}>{row.title || row.alert_type} · {row.asin} · {row.campaign_id} · {row.classification}</p>)}</div></details>
  </div>;
}

/**
 * DecisionalOverview — as 3 faixas do dashboard Clean Light Pro.
 * Props (dados da página e estado do ciclo consultado em /health):
 *  - account, user, campaigns
 *  - metricsDaily (ou allMetrics), salesDaily
 *  - decisions, bidChanges
 *  - onRefresh (callback "Atualizar agora")
 */
export default function DecisionalOverview({
  account, user, campaigns = [], metricsDaily = [], salesDaily = [],
  decisions = [], bidChanges = [], onRefresh, decisionReadState,
}) {
  const [refreshing, setRefreshing] = useState(false);
  const motorStatusQuery = useQuery({
    queryKey: ['motorStatus', account?.id],
    queryFn: () => loadMotorDashboardStatus(base44, account.id),
    enabled: Boolean(account?.id), refetchInterval: 30_000,
  });
  const motorHealth = { loading: motorStatusQuery.isLoading,
    data: motorStatusQuery.data || null, error: motorStatusQuery.error?.message || null,
    checkedAt: motorStatusQuery.data?.checked_at || null };

  const snapshot30 = useMemo(() => {
    const { start, end } = lastXDaysRange(30);
    const prevEnd = new Date(new Date(start + 'T12:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
    const prevStart = new Date(new Date(prevEnd + 'T12:00:00Z').getTime() - 29 * 86400000).toISOString().slice(0, 10);

    let spend = 0, sales = 0, clicks = 0, impressions = 0, orders = 0;
    for (const m of metricsDaily) {
      if (!m?.date || m.date < start || m.date > end) continue;
      spend += m.spend || 0; sales += m.sales || 0; clicks += m.clicks || 0;
      impressions += m.impressions || 0; orders += m.orders || 0;
    }
    let revenue = 0, units = 0;
    const seen = new Set();
    for (const s of salesDaily) {
      if (!s?.date || s.date < start || s.date > end) continue;
      if (s.aggregation_level && s.aggregation_level !== 'account_total') continue;
      const k = s.date;
      if (seen.has(k)) continue; seen.add(k);
      revenue += s.ordered_product_sales || s.gross_revenue || 0;
      units += s.units_ordered || 0;
    }
    // previous window
    let prevSpend = 0, prevRevenue = 0;
    for (const m of metricsDaily) {
      if (!m?.date || m.date < prevStart || m.date > prevEnd) continue;
      prevSpend += m.spend || 0; prevSpend += 0;
    }
    for (const s of salesDaily) {
      if (!s?.date || s.date < prevStart || s.date > prevEnd) continue;
      if (s.aggregation_level && s.aggregation_level !== 'account_total') continue;
      prevRevenue += s.ordered_product_sales || s.gross_revenue || 0;
    }
    const acos = sales > 0 ? (spend / sales) * 100 : 0;
    const profit = revenue - spend;
    return {
      revenue, spend, sales, clicks, impressions, orders, units, acos, profit,
      revenueTrend: pctChange(revenue, prevRevenue),
      spendTrend: pctChange(spend, prevSpend),
      profitTrend: pctChange(profit, prevRevenue - prevSpend || 0),
    };
  }, [metricsDaily, salesDaily]);

  const timestamps = useMemo(() => ({
    ads: [account?.ads_metrics_last_sync_at, account?.ads_data_fresh_at, ...metricsDaily.map(m => m.synced_at || m.updated_at || m.updated_date)].filter(Boolean).sort().pop() || null,
    spApi: account?.sp_data_last_sync_at || account?.last_sync_at || null,
    motor: [...(decisions || []), ...(bidChanges || [])]
      .map(d => d?.created_at || d?.created_date || d?.evaluated_at || d?.executed_at)
      .filter(Boolean)
      .sort()
      .pop() || null,
  }), [account, decisions, bidChanges, metricsDaily]);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  const firstName = user?.full_name?.split(' ')[0] || 'gestor';

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await refreshMotorDashboard({ reloadSources: onRefresh, loadStatus: () => motorStatusQuery.refetch() }); }
    finally { setTimeout(() => setRefreshing(false), 800); }
  };

  return (
    <div className="space-y-4">
      {/* ════ FAIXA 1 — Hero + Freshness + KPIs ════ */}
      <div className="rounded-2xl border border-[var(--border-color)] bg-theme-card p-5 shadow-card">
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-theme-primary tracking-tight">{greeting}, {firstName}.</h1>
            <p className="text-xs text-theme-muted mt-1">
              {account
                ? `${campaigns.length} campanhas · resumo dos últimos 30 dias.`
                : 'Configure sua conta Amazon para começar.'}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap xl:justify-end">
            <FreshnessSource label="Ads API" timestamp={timestamps.ads} coverage={motorHealth.data?.data_freshness?.campaigns} />
            <FreshnessSource label="SP-API" timestamp={timestamps.spApi} coverage={motorHealth.data?.data_freshness?.products} />
            <FreshnessSource label="Motor" timestamp={timestamps.motor} coverage={motorHealth.data?.data_freshness?.decisions} />
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-amazon text-white text-xs font-semibold hover:bg-amazon-deep disabled:opacity-60 transition-colors"
            >
              {refreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              Atualizar dados atuais
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-5">
          <MetricCard
            label="Faturamento Real"
            value={fmtBRL(snapshot30.revenue)}
            trendPct={snapshot30.revenueTrend}
            freshness={timestamps.spApi}
            tone={snapshot30.revenue > 0 ? 'success' : 'default'}
          />
          <MetricCard
            label="Gasto Ads"
            value={fmtBRL(snapshot30.spend)}
            trendPct={snapshot30.spendTrend}
            freshness={timestamps.ads}
            tone="default"
          />
          <MetricCard
            label="ACoS médio"
            value={snapshot30.sales > 0 ? fmtPct(snapshot30.acos) : '—'}
            freshness={timestamps.ads}
            tone={snapshot30.acos === 0 ? 'default' : snapshot30.acos <= 15 ? 'success' : snapshot30.acos <= 25 ? 'warning' : 'danger'}
          />
          <MetricCard
            label="Receita menos Ads (antes dos custos)"
            value={fmtBRL(snapshot30.profit)}
            trendPct={snapshot30.profitTrend}
            freshness={timestamps.spApi}
            tone={snapshot30.profit > 0 ? 'success' : snapshot30.profit < 0 ? 'danger' : 'default'}
          />
        </div>
      </div>

      {/* ════ Atenção necessária — painel separado, full width ════ */}
      <div className="rounded-2xl border border-[var(--border-color)] bg-theme-card p-5 shadow-card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold text-theme-primary">Atenção necessária</h2>
          <p className="text-[11px] text-theme-muted hidden sm:block">Alertas críticos, alta severidade e fila Amazon atrasada.</p>
        </div>
        <AttentionPanel accountId={account?.id} decisions={decisions} />
      </div>

      {/* ════ O que o Motor está fazendo agora — card dedicado, ao final ════ */}
      <div className="rounded-2xl border border-[var(--border-color)] bg-theme-card p-5 shadow-card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold text-theme-primary">Estado atual e último ciclo do Motor</h2>
          <p className="text-[11px] text-theme-muted hidden sm:block">Toque na seta para abrir o colóquio da decisão.</p>
        </div>
        <MotorOperationalReadout data={motorHealth.data} error={motorHealth.error} accountId={account?.id} />
        <MotorDecisionFeed decisions={decisions} bidChanges={bidChanges} motorHealth={motorHealth} decisionReadState={decisionReadState} />
      </div>
    </div>
  );
}
