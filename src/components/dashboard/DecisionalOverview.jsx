import { useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { RefreshCw, Loader2, AlertTriangle, CheckCircle2, ShieldAlert } from 'lucide-react';
import DataFreshnessBadge from '@/components/ui/DataFreshnessBadge';
import MotorDecisionFeed from '@/components/dashboard/MotorDecisionFeed';

const fmtBRL = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2 }).format(Number(v) || 0);

function lastXDaysRange(days) {
  const end = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
  const start = new Date(new Date(end + 'T12:00:00Z').getTime() - (days - 1) * 86400000).toISOString().slice(0, 10);
  return { start, end };
}

function pctChange(curr, prev) {
  if (!prev || prev === 0) return null;
  return ((curr - prev) / prev) * 100;
}

function FreshnessSource({ label, timestamp }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-theme-card-2 border border-[var(--border-color)]">
      <span className="text-[11px] text-theme-muted font-medium">{label}</span>
      <DataFreshnessBadge timestamp={timestamp} variant="full" />
    </div>
  );
}

function AttentionCard({ alert, onResolve, resolving }) {
  const severity = String(alert?.severity || 'medium').toLowerCase();
  const tone = severity === 'critical' ? 'danger' : 'warning';
  const ring = severity === 'critical' ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50';
  const Icon = severity === 'critical' ? ShieldAlert : AlertTriangle;
  const iconColor = severity === 'critical' ? 'text-red-500' : 'text-amber-500';
  return (
    <div className={`rounded-2xl border p-4 ${ring}`}>
      <div className="flex items-start gap-2">
        <Icon className={`w-4 h-4 ${iconColor} flex-shrink-0 mt-0.5`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm font-semibold text-theme-primary">{alert?.title || 'Alerta'}</p>
            <button
              type="button"
              onClick={() => onResolve?.(alert.id)}
              disabled={resolving}
              aria-label={`Resolver alerta ${alert?.title || ''}`}
              className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-white/70 px-2 py-1 text-[10px] font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-60"
            >
              {resolving ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
              Resolver
            </button>
          </div>
          {alert?.asin && <p className="text-[11px] font-mono text-[#0066CC] mt-0.5">{alert.asin}</p>}
          <p className="text-xs text-theme-secondary mt-1 leading-relaxed">{alert?.message || alert?.details || 'Verifique o detalhe do alerta.'}</p>
          {alert?.metric_name && (
            <p className="text-[10px] text-theme-muted mt-1.5">
              {alert.metric_name}: {alert.metric_value != null ? alert.metric_value : '—'}
              {alert.threshold_value != null ? ` · limite: ${alert.threshold_value}` : ''}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function AttentionPanel({ accountId, decisions = [] }) {
  const [alerts, setAlerts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [resolvingId, setResolvingId] = useState(null);
  const [resolveError, setResolveError] = useState('');

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    (async () => {
      try {
        const qs = accountId ? { amazon_account_id: accountId, status: 'active' } : { status: 'active' };
        const [criticalRows, highRows] = await Promise.all([
          base44.entities.Alert.filter({ ...qs, severity: 'critical' }, '-created_at', 50).catch(() => []),
          base44.entities.Alert.filter({ ...qs, severity: 'high' }, '-created_at', 50).catch(() => []),
        ]);
        if (!mounted) return;
        const byId = new Map(
          [...criticalRows, ...highRows].map(alert => [alert.id, alert])
        );
        setAlerts([...byId.values()]);
      } catch {
        setAlerts([]);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [accountId]);

  const resolveAlert = async (alertId) => {
    if (!alertId || resolvingId) return;
    setResolvingId(alertId);
    setResolveError('');
    try {
      await base44.entities.Alert.update(alertId, {
        status: 'resolved',
        resolved_at: new Date().toISOString(),
        resolution_reason: 'manual_resolve',
      });
      setAlerts(current => (current || []).filter(alert => alert.id !== alertId));
    } catch (error) {
      setResolveError(error?.message || 'Não foi possível resolver o alerta.');
    } finally {
      setResolvingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="w-4 h-4 text-slate-400 animate-spin" />
      </div>
    );
  }
  const now = Date.now();
  const recentFailures = decisions.filter(item => {
    const status = String(item?.status || item?.queue_status || '').toLowerCase();
    const timestamp = new Date(item?.updated_at || item?.created_at || 0).getTime();
    return ['failed', 'failed_final', 'error'].includes(status) && now - timestamp < 86400000;
  });
  const stalePending = decisions.filter(item => {
    const status = String(item?.status || item?.queue_status || '').toLowerCase();
    const timestamp = new Date(item?.updated_at || item?.created_at || 0).getTime();
    return ['executing', 'confirming', 'awaiting_confirmation', 'scheduled'].includes(status)
      && now - timestamp > 20 * 60000;
  });
  if ((!alerts || alerts.length === 0) && (recentFailures.length > 0 || stalePending.length > 0)) {
    return (
      <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4">
        <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0" />
        <div>
          <p className="text-sm font-semibold text-amber-800">Atenção operacional</p>
          <p className="text-xs text-amber-700 mt-0.5">{recentFailures.length} falha(s) recente(s) · {stalePending.length} confirmação(ões) atrasada(s).</p>
        </div>
      </div>
    );
  }
  if (!alerts || alerts.length === 0) {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
        <CheckCircle2 className="w-5 h-5 text-emerald-500 flex-shrink-0" />
        <div>
          <p className="text-sm font-semibold text-emerald-700">Tudo operacional</p>
          <p className="text-xs text-emerald-600/80 mt-0.5">Nenhum alerta crítico ou de alta severidade ativo.</p>
        </div>
      </div>
    );
  }
  return (
    <>
      {resolveError && <p className="mb-3 text-xs text-red-600">{resolveError}</p>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {alerts.slice(0, 6).map(a => (
          <AttentionCard
            key={a.id}
            alert={a}
            onResolve={resolveAlert}
            resolving={resolvingId === a.id}
          />
        ))}
      </div>
    </>
  );
}

/**
 * DecisionalOverview — as 3 faixas do dashboard Clean Light Pro.
 * Props (todos já carregados pela página; zero polling novo):
 *  - account, user, campaigns
 *  - metricsDaily (ou allMetrics), salesDaily
 *  - decisions, bidChanges
 *  - onRefresh (callback "Atualizar agora")
 */
export default function DecisionalOverview({
  account, user, campaigns = [], metricsDaily = [], salesDaily = [],
  decisions = [], bidChanges = [], onRefresh,
}) {
  const [refreshing, setRefreshing] = useState(false);

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
    ads: account?.ads_metrics_last_sync_at || account?.ads_data_fresh_at || null,
    spApi: account?.sp_data_last_sync_at || account?.last_sync_at || null,
    motor: [...(decisions || []), ...(bidChanges || [])]
      .map(d => d?.created_at || d?.created_date || d?.evaluated_at || d?.executed_at)
      .filter(Boolean)
      .sort()
      .pop() || null,
  }), [account, decisions, bidChanges]);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  const firstName = user?.full_name?.split(' ')[0] || 'gestor';

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await onRefresh?.(); }
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
            <FreshnessSource label="Ads API" timestamp={timestamps.ads} />
            <FreshnessSource label="SP-API" timestamp={timestamps.spApi} />
            <FreshnessSource label="Motor" timestamp={timestamps.motor} />
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-amazon text-white text-xs font-semibold hover:bg-amazon-deep disabled:opacity-60 transition-colors"
            >
              {refreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              Atualizar agora
            </button>
          </div>
        </div>

        <div className="mt-5">
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50/80 p-5">
            <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
                  Meta única do Motor
                </p>

                <h2 className="mt-1 text-lg font-bold text-theme-primary">
                  Maximizar lucro esperado
                </h2>

                <p className="mt-1 text-xs text-theme-secondary">
                  Sujeito a prejuízo máximo controlado. ACoS, ROAS, TACoS,
                  CPC, impressões, vendas e quantidade de campanhas são
                  apenas sinais internos e guardrails.
                </p>
              </div>

              <div className="md:text-right">
                <p className="text-[10px] text-theme-muted">
                  Lucro pós-Ads estimado · últimos 30 dias
                </p>

                <p className={`text-2xl font-bold ${
                  snapshot30.profit >= 0
                    ? 'text-emerald-700'
                    : 'text-red-600'
                }`}>
                  {fmtBRL(snapshot30.profit)}
                </p>

                {snapshot30.profitTrend != null ? (
                  <p className={`mt-0.5 text-[10px] ${
                    snapshot30.profitTrend >= 0
                      ? 'text-emerald-600'
                      : 'text-red-500'
                  }`}>
                    {snapshot30.profitTrend >= 0 ? '+' : ''}
                    {snapshot30.profitTrend.toFixed(1)}% vs. período anterior
                  </p>
                ) : null}
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2 text-[10px]">
              {[
                'Safe CPC',
                'Break-even',
                'Estoque',
                'Buyability',
                'Limite global',
                'Loss budget',
                'Confirmação Amazon',
              ].map(label => (
                <span
                  key={label}
                  className="rounded-full border border-emerald-200 bg-white/70 px-2 py-1 text-emerald-700"
                >
                  {label}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ════ Atenção necessária — painel separado, full width ════ */}
      <div className="rounded-2xl border border-[var(--border-color)] bg-theme-card p-5 shadow-card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold text-theme-primary">Atenção necessária</h2>
          <p className="text-[11px] text-theme-muted hidden sm:block">Alertas ativos de alta severidade e críticos.</p>
        </div>
        <AttentionPanel accountId={account?.id} decisions={decisions} />
      </div>

      {/* ════ O que o Motor está fazendo agora — card dedicado, ao final ════ */}
      <div className="rounded-2xl border border-[var(--border-color)] bg-theme-card p-5 shadow-card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold text-theme-primary">O que o Motor está fazendo agora</h2>
          <p className="text-[11px] text-theme-muted hidden sm:block">Toque na seta para abrir o colóquio da decisão.</p>
        </div>
        <MotorDecisionFeed decisions={decisions} bidChanges={bidChanges} />
      </div>
    </div>
  );
}
