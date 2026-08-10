import { useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { RefreshCw, Loader2, AlertTriangle, CheckCircle2, ShieldAlert } from 'lucide-react';
import MetricCard from '@/components/ui/MetricCard';
import DataFreshnessBadge from '@/components/ui/DataFreshnessBadge';
import MotorDecisionFeed from '@/components/dashboard/MotorDecisionFeed';

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

function FreshnessSource({ label, timestamp }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-theme-card-2 border border-[var(--border-color)]">
      <span className="text-[11px] text-theme-muted font-medium">{label}</span>
      <DataFreshnessBadge timestamp={timestamp} variant="full" />
    </div>
  );
}

function AttentionCard({ alert }) {
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
          <p className="text-sm font-semibold text-theme-primary">{alert?.title || 'Alerta'}</p>
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

function AttentionPanel({ accountId }) {
  const [alerts, setAlerts] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    (async () => {
      try {
        const qs = accountId ? { amazon_account_id: accountId, status: 'active' } : { status: 'active' };
        const rows = await base44.entities.Alert.filter(qs, '-created_date', 50).catch(() => []);
        if (!mounted) return;
        const filtered = (rows || []).filter(a => ['high', 'critical'].includes(String(a?.severity || '').toLowerCase()));
        setAlerts(filtered);
      } catch {
        setAlerts([]);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [accountId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="w-4 h-4 text-slate-400 animate-spin" />
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
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {alerts.slice(0, 6).map(a => <AttentionCard key={a.id} alert={a} />)}
    </div>
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
            label="Lucro estimado"
            value={fmtBRL(snapshot30.profit)}
            trendPct={snapshot30.profitTrend}
            freshness={timestamps.spApi}
            tone={snapshot30.profit > 0 ? 'success' : snapshot30.profit < 0 ? 'danger' : 'default'}
          />
        </div>
      </div>

      {/* ════ FAIXA 2 + FAIXA 3 — lado a lado ════ */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="rounded-2xl border border-[var(--border-color)] bg-theme-card p-5 shadow-card">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-bold text-theme-primary">O que o Motor está fazendo agora</h2>
              <p className="text-[11px] text-theme-muted mt-0.5">Últimas decisões e ajustes de lance automatizados.</p>
            </div>
          </div>
          <MotorDecisionFeed decisions={decisions} bidChanges={bidChanges} />
        </div>

        <div className="rounded-2xl border border-[var(--border-color)] bg-theme-card p-5 shadow-card">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-bold text-theme-primary">Atenção Necessária</h2>
              <p className="text-[11px] text-theme-muted mt-0.5">Alertas ativos de alta severidade e críticos.</p>
            </div>
          </div>
          <AttentionPanel accountId={account?.id} />
        </div>
      </div>
    </div>
  );
}