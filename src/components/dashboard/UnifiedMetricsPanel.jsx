/**
 * UnifiedMetricsPanel
 * Blocos novos do Dashboard com dados dos Relatórios Unificados Amazon.
 * Exibe: fonte dos dados, qualidade de tráfego, entrega, parcela de impressões, conversão promovida/aura.
 */
import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { ShieldAlert, TrendingUp, PieChart, ShoppingCart, Zap, AlertTriangle, CheckCircle, Info } from 'lucide-react';

const fmt = (v, dec = 1) => Number(v || 0).toFixed(dec).replace('.', ',');
const fmtPct = (v, dec = 1) => `${fmt(v * 100, dec)}%`;
const fmtCur = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);

function MetricItem({ label, value, sub, highlight }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] text-slate-500 uppercase tracking-wide">{label}</span>
      <span className={`text-sm font-semibold ${highlight ? 'text-amber-400' : 'text-white'}`}>{value}</span>
      {sub && <span className="text-[10px] text-slate-500">{sub}</span>}
    </div>
  );
}

function Block({ icon: BlockIcon, title, color, children }) {
  return (
    <div className={`rounded-xl border bg-surface-1 p-4 space-y-3 border-surface-2`}>
      <div className="flex items-center gap-2">
        <BlockIcon className={`h-4 w-4 ${color}`} />
        <span className="text-xs font-semibold text-slate-300">{title}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">{children}</div>
    </div>
  );
}

export default function UnifiedMetricsPanel({ amazonAccountId }) {
  const [metrics, setMetrics] = useState(null);
  const [reconciliation, setReconciliation] = useState(null);
  const [dataSource, setDataSource] = useState('loading');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!amazonAccountId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);

        const [unifiedRaw, reconRaw, account] = await Promise.all([
          base44.entities.UnifiedAdsMetricsDaily.filter({ amazon_account_id: amazonAccountId }, '-date', 300),
          base44.entities.UnifiedMetricsReconciliation.filter({ amazon_account_id: amazonAccountId }, '-date', 100),
          base44.entities.AmazonAccount.filter({ id: amazonAccountId }),
        ]);

        if (cancelled) return;

        const hasUnified = unifiedRaw.length > 0;
        const hasAccess = account[0]?.unified_reports_access;

        if (!hasUnified) {
          setDataSource(hasAccess === false ? 'no_access' : 'legacy');
          setLoading(false);
          return;
        }

        setDataSource('unified');

        // Agregar métricas dos últimos 14 dias
        const agg = {
          impressions: 0, gross_impressions: 0, invalid_impressions: 0,
          clicks: 0, gross_clicks: 0, invalid_clicks: 0,
          cost: 0, sales: 0, purchases: 0,
          promoted_purchases: 0, promoted_sales: 0,
          halo_purchases: 0, halo_sales: 0,
          impression_share_sum: 0, top_of_search_sum: 0,
          pacing_sum: 0, pacing_rows: 0,
          budget_at_risk_count: 0,
          projected_spend_sum: 0, required_daily_sum: 0,
          rows: 0,
        };

        for (const r of unifiedRaw) {
          if (!r.date || r.date < cutoff) continue;
          agg.impressions += r.impressions || 0;
          agg.gross_impressions += r.gross_impressions || r.impressions || 0;
          agg.invalid_impressions += r.invalid_impressions || 0;
          agg.clicks += r.clicks || 0;
          agg.gross_clicks += r.gross_clicks || r.clicks || 0;
          agg.invalid_clicks += r.invalid_clicks || 0;
          agg.cost += r.cost || 0;
          agg.sales += r.sales || 0;
          agg.purchases += r.purchases || 0;
          agg.promoted_purchases += r.promoted_purchases || 0;
          agg.promoted_sales += r.promoted_sales || 0;
          agg.halo_purchases += r.halo_purchases || 0;
          agg.halo_sales += r.halo_sales || 0;
          if (r.impression_share > 0) agg.impression_share_sum += r.impression_share;
          if (r.top_of_search_impression_share > 0) agg.top_of_search_sum += r.top_of_search_impression_share;
          if (r.campaign_pacing_rate > 0) { agg.pacing_sum += r.campaign_pacing_rate; agg.pacing_rows++; }
          if (r.budget_at_risk) agg.budget_at_risk_count++;
          if (r.projected_spend > 0) agg.projected_spend_sum += r.projected_spend;
          if (r.required_daily_spend > 0) agg.required_daily_sum += r.required_daily_spend;
          agg.rows++;
        }

        agg.invalid_impression_rate = agg.gross_impressions > 0 ? agg.invalid_impressions / agg.gross_impressions : 0;
        agg.invalid_click_rate = agg.gross_clicks > 0 ? agg.invalid_clicks / agg.gross_clicks : 0;
        agg.avg_impression_share = agg.rows > 0 ? agg.impression_share_sum / agg.rows : 0;
        agg.avg_top_of_search = agg.rows > 0 ? agg.top_of_search_sum / agg.rows : 0;
        agg.avg_pacing_rate = agg.pacing_rows > 0 ? agg.pacing_sum / agg.pacing_rows : 0;
        agg.promoted_roas = agg.cost > 0 ? agg.promoted_sales / agg.cost : 0;
        agg.promoted_acos = agg.promoted_sales > 0 ? agg.cost / agg.promoted_sales * 100 : 0;
        agg.halo_pct = agg.sales > 0 ? agg.halo_sales / agg.sales * 100 : 0;

        setMetrics(agg);

        // Resumo de reconciliação
        const warnings = reconRaw.filter(r => r.status === 'warning' || r.status === 'critical').length;
        const maxDiff = reconRaw.reduce((m, r) => Math.max(m, r.difference_percent || 0), 0);
        setReconciliation({ warnings, maxDiff, total: reconRaw.length });

      } catch (e) {
        console.error('[UnifiedMetricsPanel]', e.message);
        setDataSource('error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [amazonAccountId]);

  if (loading) return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
      {[...Array(4)].map((_, i) => (
        <div key={i} className="rounded-xl border border-surface-2 bg-surface-1 p-4 h-32 animate-pulse" />
      ))}
    </div>
  );

  // Badge de fonte
  const sourceBadge = {
    unified: { label: 'Amazon Unified Reports', color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20', icon: CheckCircle },
    legacy: { label: 'Sponsored Products Legacy', color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/20', icon: Info },
    no_access: { label: 'Sem acesso a Relatórios Unificados', color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/20', icon: AlertTriangle },
    error: { label: 'Erro ao carregar dados', color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/20', icon: AlertTriangle },
    loading: { label: 'Carregando...', color: 'text-slate-400', bg: 'bg-surface-2', icon: Info },
  }[dataSource] || {};

  const BadgeIcon = sourceBadge.icon;

  return (
    <div className="space-y-4">
      {/* Fonte dos dados */}
      <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${sourceBadge.bg}`}>
        <BadgeIcon className={`h-3.5 w-3.5 ${sourceBadge.color} flex-shrink-0`} />
        <span className={`text-xs font-medium ${sourceBadge.color}`}>Fonte dos dados: {sourceBadge.label}</span>
        {reconciliation?.warnings > 0 && (
          <span className="ml-auto text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-0.5">
            {reconciliation.warnings} camp. divergentes · max {fmt(reconciliation.maxDiff, 1)}%
          </span>
        )}
      </div>

      {dataSource !== 'unified' || !metrics ? null : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">

          {/* A: Qualidade de tráfego */}
          <Block icon={ShieldAlert} title="Qualidade de Tráfego" color="text-red-400">
            <MetricItem
              label="Impressões inválidas"
              value={metrics.invalid_impressions.toLocaleString('pt-BR')}
              highlight={metrics.invalid_impression_rate > 0.05}
            />
            <MetricItem
              label="Taxa inv. impr."
              value={fmtPct(metrics.invalid_impression_rate, 2)}
              highlight={metrics.invalid_impression_rate > 0.05}
            />
            <MetricItem
              label="Cliques inválidos"
              value={metrics.invalid_clicks.toLocaleString('pt-BR')}
              highlight={metrics.invalid_click_rate > 0.08}
            />
            <MetricItem
              label="Taxa inv. cliques"
              value={fmtPct(metrics.invalid_click_rate, 2)}
              highlight={metrics.invalid_click_rate > 0.08}
            />
          </Block>

          {/* B: Entrega e orçamento */}
          <Block icon={Zap} title="Entrega e Orçamento" color="text-amber-400">
            <MetricItem
              label="Taxa de inserção"
              value={fmtPct(metrics.avg_pacing_rate)}
              highlight={metrics.avg_pacing_rate < 0.7 || metrics.avg_pacing_rate > 1.1}
            />
            <MetricItem
              label="Orçamento em risco"
              value={metrics.budget_at_risk_count > 0 ? `${metrics.budget_at_risk_count} camp.` : 'Nenhum'}
              highlight={metrics.budget_at_risk_count > 0}
            />
            <MetricItem
              label="Gasto projetado"
              value={fmtCur(metrics.projected_spend_sum)}
            />
            <MetricItem
              label="Gasto diário nec."
              value={fmtCur(metrics.required_daily_sum)}
            />
          </Block>

          {/* C: Parcela de impressões */}
          <Block icon={PieChart} title="Parcela de Impressões" color="text-cyan">
            <MetricItem
              label="Parcela média"
              value={fmtPct(metrics.avg_impression_share)}
              sub="últimos 14 dias"
            />
            <MetricItem
              label="Topo da pesquisa"
              value={fmtPct(metrics.avg_top_of_search)}
              highlight={metrics.avg_top_of_search < 0.1}
            />
            <MetricItem
              label="Impressões válidas"
              value={metrics.impressions.toLocaleString('pt-BR')}
            />
            <MetricItem
              label="Gross impressões"
              value={metrics.gross_impressions.toLocaleString('pt-BR')}
            />
          </Block>

          {/* D: Conversão promovida x aura */}
          <Block icon={ShoppingCart} title="Promovido vs Aura" color="text-violet-400">
            <MetricItem
              label="Compras promovidas"
              value={metrics.promoted_purchases.toLocaleString('pt-BR')}
            />
            <MetricItem
              label="Vendas promovidas"
              value={fmtCur(metrics.promoted_sales)}
            />
            <MetricItem
              label="ROAS promovido"
              value={`${fmt(metrics.promoted_roas, 2)}x`}
              highlight={metrics.promoted_roas < 2}
            />
            <MetricItem
              label="ACoS promovido"
              value={`${fmt(metrics.promoted_acos, 1)}%`}
              highlight={metrics.promoted_acos > 20}
            />
            <MetricItem
              label="Compras aura/halo"
              value={metrics.halo_purchases.toLocaleString('pt-BR')}
              sub="outros produtos"
            />
            <MetricItem
              label="Vendas aura/halo"
              value={fmtCur(metrics.halo_sales)}
            />
          </Block>

        </div>
      )}
    </div>
  );
}