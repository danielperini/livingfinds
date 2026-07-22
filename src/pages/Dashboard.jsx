import React, { useState, useCallback, useMemo, useRef } from 'react';
import { useReportPolling } from '@/hooks/useReportPolling';
import { base44 } from '@/api/base44Client';
import { classifyCampaigns } from '@/lib/campaignUtils';
import { useQueryClient } from '@tanstack/react-query';
import { useAccountData, invalidateAccountData } from '@/hooks/useAccountData';
import { Link } from 'react-router-dom';
import {
  ComposedChart, AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine
} from 'recharts';
import {
  RefreshCw, AlertCircle, Clock, Loader2,
  AlertTriangle, BarChart2, Megaphone, BookOpen, Terminal
} from 'lucide-react';
import SyncStatusBanner from '@/components/dashboard/SyncStatusBanner';
import TokenExpiredBanner from '@/components/amazon/TokenExpiredBanner';
import MoMComparisonChart from '@/components/dashboard/MoMComparisonChart';
import UnifiedMetricsPanel from '@/components/dashboard/UnifiedMetricsPanel';
import PerformanceGoalsPanel from '@/components/dashboard/PerformanceGoalsPanel';
import AutoWindowStatus from '@/components/dashboard/AutoWindowStatus';
import SyncStatusCard from '@/components/dashboard/SyncStatusCard';
import AiChangesBreakdown from '@/components/dashboard/AiChangesBreakdown';
import DataConsistencyBadge from '@/components/dashboard/DataConsistencyBadge';
import FinanceSyncDiagnostic from '@/components/dashboard/FinanceSyncDiagnostic';

// ─── Utilitários de período fechado ─────────────────────────────────────────

function getYesterday() {
  // Usa timezone BRT (UTC-3) para determinar "ontem" corretamente
  const nowBRT = new Date(Date.now() - 3 * 3600000);
  const d = nowBRT.toISOString().slice(0, 10);
  // Subtrai 1 dia
  const date = new Date(d + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function getClosedReportingPeriod(period, anchor) {
  // anchor = último dia com dados reais (lastAvailableAdsDate) — evita zeros por latência Amazon
  const end = anchor || getYesterday();
  if (period === 'yesterday') return { startDate: end, endDate: end, label: `Dados até ${fmtDateBRFull(end)}` };
  const days = Number(period);
  const endDate = new Date(end + 'T12:00:00Z');
  const startDate = new Date(endDate.getTime() - (days - 1) * 86400000);
  return { startDate: startDate.toISOString().slice(0, 10), endDate: end, label: `${days} dias · até ${fmtDateBRFull(end)}` };
}

function safe(v, d = 2) {
  if (!v || !isFinite(v) || isNaN(v)) return 0;
  return Number(v.toFixed(d));
}

function fmt(v) { return v !== null && v !== undefined && isFinite(v) && !isNaN(v) ? v : 0; }
function fmtBRL(v) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2 }).format(fmt(v));
}
function fmtPct(v) { return `${fmt(v).toFixed(1)}%`; }

// Converte YYYY-MM-DD → DD/MM
function fmtDateBR(isoDate) {
  if (!isoDate) return '';
  const [, m, d] = isoDate.split('-');
  return `${d}/${m}`;
}
// Converte YYYY-MM-DD → DD/MM/YYYY
function fmtDateBRFull(isoDate) {
  if (!isoDate) return '';
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

// ─── Deduplicar métricas ────────────────────────────────────────────────────

function dedupeMetrics(metrics) {
  const map = new Map();
  for (const m of metrics) {
    const key = `${m.amazon_account_id || ''}-${m.campaign_id || ''}-${m.date}`;
    if (!map.has(key)) map.set(key, m);
  }
  return Array.from(map.values());
}

function calcKpis(metrics) {
  return metrics.reduce((acc, m) => ({
    spend: acc.spend + (m.spend || 0),
    sales: acc.sales + (m.sales || 0),
    clicks: acc.clicks + (m.clicks || 0),
    impressions: acc.impressions + (m.impressions || 0),
    orders: acc.orders + (m.orders || 0),
  }), { spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0 });
}

function deriveRates(k) {
  return {
    ...k,
    acos: k.sales > 0 ? safe(k.spend / k.sales * 100) : 0,
    roas: k.spend > 0 ? safe(k.sales / k.spend) : 0,
    cpc: k.clicks > 0 ? safe(k.spend / k.clicks) : 0,
    ctr: k.impressions > 0 ? safe(k.clicks / k.impressions * 100, 3) : 0,
  };
}

// ─── Componentes internos ───────────────────────────────────────────────────

function KpiCard({ label, value, sub, tone = 'default' }) {
  const tones = {
    default: 'border-surface-2',
    good: 'border-emerald-500/25 bg-emerald-500/5',
    warn: 'border-amber-500/25 bg-amber-500/5',
    bad: 'border-red-500/25 bg-red-500/5',
    cyan: 'border-cyan/20 bg-cyan/5',
  };
  return (
    <div className={`bg-surface-1 border rounded-xl p-4 ${tones[tone]}`}>
      <p className="text-[10px] font-medium text-slate-500 mb-1 uppercase tracking-wide">{label}</p>
      <p className="text-xl font-bold text-white">{value}</p>
      {sub ? <p className="text-[10px] text-slate-500 mt-1">{sub}</p> : null}
    </div>
  );
}

const ChartTooltip = ({ active, payload, label, consolidatedChart }) => {
  if (!active || !payload?.length) return null;
  // Encontrar dados completos do dia pelo label de data
  const dayData = consolidatedChart?.find(d => d.date === label);
  const fmtBRL_ = v => v != null ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v)) : 'Dado não disponível';
  const fmtNum_ = v => v != null ? Number(v).toLocaleString('pt-BR') : 'Dado não disponível';
  const fmtPct_ = v => v != null ? `${Number(v).toFixed(2)}%` : 'Dado não disponível';

  const gasto = dayData?.gasto || null;
  const vendasAds = dayData?.['vendas ads'] || null;
  const fatReal = dayData?.['faturamento real'] ?? null;
  const unidades = dayData?._units ?? null;
  const pedidosAds = dayData?._orders_ads ?? null;
  const pedidosReais = dayData?._orders_real ?? null;
  const cliques = dayData?._clicks ?? null;
  const impressoes = dayData?.impressões ?? null;
  const aiChanges = dayData?.['alterações IA'] ?? null;
  const dataStatus = dayData?._data_status ?? null;

  const roas = gasto && vendasAds ? vendasAds / gasto : null;
  const acos = gasto && vendasAds ? (gasto / vendasAds) * 100 : null;
  const tacos = gasto && fatReal ? (gasto / fatReal) * 100 : null;

  const statusLabel = { complete: 'Completo', partial: 'Parcial', missing: 'Ausente', stale: 'Desatualizado', error: 'Erro' };

  return (
    <div className="bg-[#111318] border border-surface-2 rounded-lg p-3 text-xs shadow-xl max-w-xs">
      <div className="flex items-center justify-between mb-2">
        <p className="text-slate-300 font-semibold">{label}</p>
        {dataStatus ? (
          <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${
            dataStatus === 'complete' ? 'bg-emerald-500/15 text-emerald-400' :
            dataStatus === 'partial' ? 'bg-amber-500/15 text-amber-400' :
            'bg-red-500/15 text-red-400'
          }`}>{statusLabel[dataStatus] || dataStatus}</span>
        ) : null}
      </div>
      <div className="space-y-1">
        {[
          { label: 'Gasto Ads', value: fmtBRL_(gasto) },
          { label: 'Vendas Ads', value: fmtBRL_(vendasAds) },
          { label: 'Faturamento real', value: fatReal != null ? fmtBRL_(fatReal) : 'Dado não disponível' },
          { label: 'Unidades', value: unidades != null ? fmtNum_(unidades) : 'Dado não disponível' },
          { label: 'Pedidos Ads', value: pedidosAds != null ? fmtNum_(pedidosAds) : 'Dado não disponível' },
          { label: 'Pedidos reais', value: pedidosReais != null ? fmtNum_(pedidosReais) : 'Dado não disponível' },
          { label: 'Impressões', value: impressoes != null ? fmtNum_(impressoes) : 'Dado não disponível' },
          { label: 'Cliques', value: cliques != null ? fmtNum_(cliques) : 'Dado não disponível' },
          { label: 'ROAS', value: roas != null ? `${roas.toFixed(2)}x` : 'Dado não disponível' },
          { label: 'ACOS', value: acos != null ? fmtPct_(acos) : 'Dado não disponível' },
          { label: 'TACoS', value: tacos != null ? fmtPct_(tacos) : 'Dado não disponível' },
          { label: 'Alterações IA', value: aiChanges != null ? fmtNum_(aiChanges) : '0' },
        ].map(({ label, value }) => (
          <div key={label} className="flex items-center justify-between gap-4">
            <span className="text-slate-500">{label}:</span>
            <span className={`font-semibold ${value === 'Dado não disponível' ? 'text-slate-600 italic' : 'text-white'}`}>{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

function PeriodSelector({ value, onChange, available }) {
  const ALL = [
    { key: 'yesterday', label: 'Ontem' },
    { key: '7', label: '7 dias' },
    { key: '14', label: '14 dias' },
    { key: '30', label: '30 dias' },
  ];
  const opts = ALL.filter(o => available.includes(o.key));
  return (
    <div className="flex bg-surface-2 border border-surface-3 rounded-lg p-0.5 gap-0.5">
      {opts.map(o => (
        <button key={o.key} onClick={() => onChange(o.key)}
          className={`px-3 py-1.5 rounded text-xs font-semibold transition-all ${value === o.key ? 'bg-cyan text-white' : 'text-slate-400 hover:text-slate-200'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function GoalRow({ label, real, target, unit = '%', lowerIsBetter = true, realLabel }) {
  if (!target) return null;
  const good = lowerIsBetter ? real <= target : real >= target;
  const warn = lowerIsBetter ? real > target && real <= target * 1.3 : real >= target * 0.75 && real < target;
  const tone = real === 0 ? 'text-slate-500' : good ? 'text-emerald-400' : warn ? 'text-amber-400' : 'text-red-400';
  const pct = target > 0 ? Math.round(Math.abs(real - target) / target * 100) : 0;
  const dir = lowerIsBetter ? (real <= target ? `${pct}% abaixo ✓` : `${pct}% acima`) : (real >= target ? `${pct}% acima ✓` : `${pct}% abaixo`);
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-surface-2/50 last:border-0">
      <div className="flex items-center gap-2 min-w-0">
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${good ? 'bg-emerald-400' : warn ? 'bg-amber-400' : real === 0 ? 'bg-slate-600' : 'bg-red-400'}`} />
        <span className="text-xs text-slate-400">{label}</span>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        <span className={`text-sm font-bold ${tone}`}>{realLabel || (real === 0 ? '—' : `${real.toFixed(1)}${unit}`)}</span>
        <span className="text-[10px] text-slate-600">Meta: {target}{unit}</span>
        {real > 0 ? <span className={`text-[10px] ${tone}`}>{dir}</span> : null}
      </div>
    </div>
  );
}

// ─── Dashboard principal ─────────────────────────────────────────────────────

export default function Dashboard() {
  const queryClient = useQueryClient();
  const [syncingDashboard, setSyncingDashboard] = useState(false);
  const [syncError, setSyncError] = useState(null);
  const [period, setPeriod] = useState('7');
  const [justUpdated, setJustUpdated] = useState(false);
  const justUpdatedTimerRef = useRef(null);

  // Camada única de dados compartilhada — React Query cuida de cache e dedup
  const {
    user, account,
    campaigns, metricsDaily, products, salesDaily,
    decisions, allDecisions,
    bidChanges, syncRuns,
    autopilotConfig, budgetCfg,
    performanceSettings,
    canonicalContext, canonicalLoading,
    loading, error,
  } = useAccountData();

  const loadData = useCallback(() => {
    if (!account?.id) return;
    invalidateAccountData(queryClient, account.id);
  }, [queryClient, account?.id]);

  // Polling automático: recarrega quando chega novo relatório
  const handleNewReport = useCallback(() => {
    if (!account?.id) return;
    invalidateAccountData(queryClient, account.id);
    setJustUpdated(true);
    clearTimeout(justUpdatedTimerRef.current);
    justUpdatedTimerRef.current = setTimeout(() => setJustUpdated(false), 3000);
  }, [queryClient, account?.id]);

  useReportPolling({
    accountId: account?.id,
    onNewReport: handleNewReport,
    enabled: !!account?.id,
  });

  // Último sync para subtexto do header
  const lastSyncInfo = useMemo(() => {
    if (account?.last_sync_at) return { at: account.last_sync_at };
    const last = syncRuns.find(r => r.status === 'success' || r.status === 'skipped_limit');
    return last ? { at: last.completed_at || last.started_at } : null;
  }, [account, syncRuns]);

  const runSync = async () => {
    if (!account || syncingDashboard) return;
    setSyncingDashboard(true);
    setSyncError(null);
    try {
      const res = await base44.functions.invoke('syncAdsQuick', { amazon_account_id: account.id });
      if (res?.data?.ok) invalidateAccountData(queryClient, account.id);
      else setSyncError(res?.data?.error || 'Falha no sync.');
    } catch (e) {
      setSyncError(e.message);
    } finally {
      setSyncingDashboard(false);
    }
  };

  // ─── Cálculos com período fechado ─────────────────────────────────────────

  const allMetrics = useMemo(() => dedupeMetrics(metricsDaily), [metricsDaily]);

  // Última data com dados de vendas Ads reais (sales > 0) — âncora para KPIs de período
  // Dias com spend mas sales=0 são artefatos de latência da Amazon (relatório ainda não fechado)
  const lastAvailableAdsDate = useMemo(() => {
    // Agregar sales por data (vários registros por campanha)
    const salesByDate = {};
    for (const m of allMetrics) {
      if (!m.date) continue;
      salesByDate[m.date] = (salesByDate[m.date] || 0) + (m.sales || 0);
    }
    // Última data com sales > 0
    const datesWithSales = Object.entries(salesByDate)
      .filter(([, s]) => s > 0)
      .map(([d]) => d)
      .sort();
    if (datesWithSales.length > 0) return datesWithSales[datesWithSales.length - 1];
    // Fallback: última data com spend > 0
    const spendByDate = {};
    for (const m of allMetrics) {
      if (!m.date) continue;
      spendByDate[m.date] = (spendByDate[m.date] || 0) + (m.spend || 0);
    }
    const datesWithSpend = Object.entries(spendByDate)
      .filter(([, s]) => s > 0)
      .map(([d]) => d)
      .sort();
    return datesWithSpend.length > 0 ? datesWithSpend[datesWithSpend.length - 1] : null;
  }, [allMetrics]);

  // Determinar períodos disponíveis (baseado na contagem de dias distintos com dados)
  const availablePeriods = useMemo(() => {
    const anchor = lastAvailableAdsDate || getYesterday();
    const dates = new Set(allMetrics.filter(m => m.date <= anchor).map(m => m.date));
    const periods = ['yesterday'];
    if (dates.size >= 7) periods.push('7');
    if (dates.size >= 14) periods.push('14');
    if (dates.size >= 28) periods.push('30');
    return periods;
  }, [allMetrics, lastAvailableAdsDate]);

  // Garantir que period seja válido
  const activePeriod = availablePeriods.includes(period) ? period : availablePeriods[availablePeriods.length - 1] || 'yesterday';

  // Todos os períodos usam lastAvailableAdsDate como âncora — sem zeros por latência Amazon
  const { startDate, endDate, label: periodLabel } = useMemo(() => {
    return getClosedReportingPeriod(activePeriod, lastAvailableAdsDate);
  }, [activePeriod, lastAvailableAdsDate]);

  const periodMetrics = useMemo(() =>
    allMetrics.filter(m => m.date >= startDate && m.date <= endDate),
    [allMetrics, startDate, endDate]
  );

  const kpis = useMemo(() => deriveRates(calcKpis(periodMetrics)), [periodMetrics]);

  // ─── Qualidade da fonte de dados ─────────────────────────────────────────
  // A Amazon tem latência natural de 1-2 dias nos relatórios.
  // "Atualizado" = o último sync foi recente (< 23h), independente do gap de datas do relatório.
  const dataQuality = useMemo(() => {
    const datesWithData = new Set(allMetrics.map(m => m.date).filter(Boolean));
    const lastDate = [...datesWithData].sort().pop();

    // Idade do último sync em horas (fonte confiável: last_sync_at da conta)
    const lastSyncAt = account?.last_sync_at;
    const syncAgeHours = lastSyncAt
      ? (Date.now() - new Date(lastSyncAt).getTime()) / 3600000
      : null;

    // Gap do relatório: quantos dias faltam até ontem (latência normal da Amazon = até 2 dias)
    const yesterday = getYesterday();
    const reportGapDays = lastDate
      ? Math.round((new Date(yesterday).getTime() - new Date(lastDate).getTime()) / 86400000)
      : null;

    // Consideramos atualizado se: sync recente (< 23h) OR dados com gap <= 2 dias (latência Amazon)
    const syncRecente = syncAgeHours !== null && syncAgeHours < 23;
    const reportNormal = reportGapDays !== null && reportGapDays <= 3; // Amazon pode demorar até 3 dias

    let source, quality, label;
    if (datesWithData.size === 0) {
      source = 'none'; quality = 'none';
      label = 'Sem dados de performance. Sincronize para começar.';
    } else if (syncRecente || reportNormal) {
      source = 'daily_report'; quality = 'high';
      const syncStr = lastSyncAt
        ? `sync ${new Date(lastSyncAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
        : '';
      label = `Relatório atualizado · ${datesWithData.size} dias · dados até ${fmtDateBRFull(lastDate)}${syncStr ? ` · ${syncStr}` : ''}`;
    } else {
      // Sync antigo E gap grande — aí sim é desatualizado
      source = 'stale'; quality = 'low';
      const dias = syncAgeHours !== null ? `há ${Math.round(syncAgeHours)}h` : 'há tempo desconhecido';
      label = `Último sync ${dias} — execute Sync para obter relatório atualizado`;
    }
    return { source, quality, label, lastDate, reportGapDays, daysCount: datesWithData.size, syncAgeHours };
  }, [allMetrics, account]);

  // Campanhas com métricas acumuladas (complemento quando metrics diárias estão desatualizadas)
  const campAggregated = useMemo(() => {
    const active = campaigns.filter(c => {
      const st = String(c.state || c.status || '').toLowerCase();
      return st !== 'archived' && !c.archived;
    });
    return active.reduce((acc, c) => ({
      spend: acc.spend + (c.spend || 0),
      sales: acc.sales + (c.sales || 0),
      orders: acc.orders + (c.orders || 0),
      clicks: acc.clicks + (c.clicks || 0),
      impressions: acc.impressions + (c.impressions || 0),
    }), { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0 });
  }, [campaigns]);

  // Top campanhas por gasto
  const topCampaigns = useMemo(() =>
    [...campaigns]
      .filter(c => (c.spend || 0) > 0)
      .sort((a, b) => (b.spend || 0) - (a.spend || 0))
      .slice(0, 5),
    [campaigns]
  );

  // Produtos com problemas (sem estoque, sem campanha, etc.)
  const productsNeedAttention = useMemo(() =>
    products.filter(p => p.status === 'active' && (
      p.inventory_status === 'out_of_stock' ||
      p.inventory_status === 'low_stock' ||
      (!p.has_campaign && p.fba_inventory > 0)
    )).slice(0, 5),
    [products]
  );

  // KPIs do último dia disponível (usado como "D-1" nos subtextos dos cartões)
  const yesterdayKpis = useMemo(() => {
    const refDate = lastAvailableAdsDate || getYesterday();
    return deriveRates(calcKpis(allMetrics.filter(m => m.date === refDate)));
  }, [allMetrics, lastAvailableAdsDate]);

  // ─── Total de alterações da IA (soma de todos os registros de bidChanges) ──
  const totalChanges = bidChanges.length;

  // ─── SalesDaily: faturamento real por data ────────────────────────────────

  const salesDailyByDate = useMemo(() => {
    const map = {};
    for (const s of salesDaily) {
      if (!s.date) continue;
      if (!map[s.date]) map[s.date] = { revenue: 0, units: 0, source: 'ads_report' };
      // Priorizar gross_revenue (Finance Events reais) sobre ordered_product_sales (estimado)
      const rev = s.finance_sync_status === 'synced' && (s.gross_revenue || 0) > 0
        ? s.gross_revenue
        : (s.ordered_product_sales || 0);
      map[s.date].revenue += rev;
      map[s.date].units += s.units_ordered || 0;
      if (s.finance_sync_status === 'synced') map[s.date].source = 'finance_events';
    }
    return map;
  }, [salesDaily]);

  // KPIs reais do SalesDaily no período selecionado
  const realSalesKpis = useMemo(() => {
    let revenue = 0, units = 0;
    for (const [date, v] of Object.entries(salesDailyByDate)) {
      if (date >= startDate && date <= endDate) {
        revenue += v.revenue;
        units += v.units;
      }
    }
    const adsSpend = kpis.spend;
    const tacos = revenue > 0 ? (adsSpend / revenue) * 100 : null;
    return { revenue, units, tacos };
  }, [salesDailyByDate, startDate, endDate, kpis.spend]);

  // ─── Projeção do mês atual ─────────────────────────────────────────────────
  const monthProjection = useMemo(() => {
    const today = new Date();
    const firstOfMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
    const yesterday_ = getYesterday();
    let monthRevenue = 0, monthDays = 0;
    for (const [date, v] of Object.entries(salesDailyByDate)) {
      if (date >= firstOfMonth && date <= yesterday_) {
        monthRevenue += v.revenue;
        monthDays++;
      }
    }
    if (monthDays === 0) return null;
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    const dayOfMonth = today.getDate(); // dias corridos (incluindo hoje)
    const avgPerDay = monthRevenue / monthDays;
    const projected = avgPerDay * daysInMonth;
    const remainingDays = daysInMonth - dayOfMonth;
    return { monthRevenue, monthDays, avgPerDay, projected, daysInMonth, remainingDays, completedPct: Math.round((dayOfMonth / daysInMonth) * 100) };
  }, [salesDailyByDate]);

  // ─── Gráfico: Consolidado Gasto + Vendas + Impressões (RANGE MÁXIMO) ────────
  // Usa TODOS os dados disponíveis — não filtrado pelo período selecionado nos KPIs.
  // Inclui alterações da IA integradas como barras de coluna secundárias.

  // Mapa de alterações da IA por data (para integrar no gráfico consolidado)
  const aiChangesByDate = useMemo(() => {
    const map = new Map();
    for (const c of bidChanges) {
      const raw = c.created_date || c.created_at;
      if (!raw) continue;
      const dBRT = new Date(new Date(raw).getTime() - 3 * 3600000);
      const key = dBRT.toISOString().slice(0, 10);
      map.set(key, (map.get(key) || 0) + 1);
    }
    return map;
  }, [bidChanges]);

  // Última data de cada API — para data_status
  const lastAdsDate = useMemo(() => {
    const dates = allMetrics.map(m => m.date).filter(Boolean).sort();
    return dates.length > 0 ? dates[dates.length - 1] : null;
  }, [allMetrics]);

  const lastSpApiDate = useMemo(() => {
    const dates = salesDaily.map(s => s.date).filter(Boolean).sort();
    return dates.length > 0 ? dates[dates.length - 1] : null;
  }, [salesDaily]);

  // Métricas extras por dia: cliques, pedidos ads, pedidos reais, unidades
  const adsExtraByDate = useMemo(() => {
    const map = {};
    for (const m of allMetrics) {
      if (!m.date) continue;
      if (!map[m.date]) map[m.date] = { clicks: 0, orders_ads: 0 };
      map[m.date].clicks += m.clicks || 0;
      map[m.date].orders_ads += m.orders || 0;
    }
    return map;
  }, [allMetrics]);

  const spExtraByDate = useMemo(() => {
    const map = {};
    for (const s of salesDaily) {
      if (!s.date) continue;
      if (!map[s.date]) map[s.date] = { units: 0, orders_real: 0 };
      map[s.date].units += s.units_ordered || 0;
      // SalesDaily não tem pedidos separados — usar unidades como proxy
      map[s.date].orders_real += s.units_ordered || 0;
    }
    return map;
  }, [salesDaily]);

  // ─── Cartões extras: unidades, pedidos reais, maior/menor dia, receita/unidade ──
  const extraKpis = useMemo(() => {
    let totalUnits = 0, totalRealOrders = 0;
    for (const s of salesDaily) {
      if (!s.date || s.date < startDate || s.date > endDate) continue;
      totalUnits += s.units_ordered || 0;
      totalRealOrders += s.units_ordered || 0;
    }
    const revenue = realSalesKpis.revenue;
    const revenuePerUnit = totalUnits > 0 ? revenue / totalUnits : null;

    let bestDay = null, worstDay = null;
    for (const [iso, entry] of Object.entries(salesDailyByDate)) {
      if (iso < startDate || iso > endDate) continue;
      if (!adsExtraByDate[iso]) continue; // apenas dias completos
      const rev = entry.revenue;
      if (!bestDay || rev > bestDay.revenue) bestDay = { date: iso, revenue: rev, units: entry.units };
      if (!worstDay || rev < worstDay.revenue) worstDay = { date: iso, revenue: rev, units: entry.units };
    }
    return { totalUnits, totalRealOrders, revenuePerUnit, bestDay, worstDay };
  }, [salesDaily, salesDailyByDate, adsExtraByDate, startDate, endDate, realSalesKpis.revenue]);

  const consolidatedChart = useMemo(() => {
    const byDate = {};
    const todayStr = new Date().toISOString().slice(0, 10);

    // Usar TODOS os dados de metrics (não filtrado pelo período)
    for (const m of allMetrics) {
      if (!m.date || m.date > todayStr) continue;
      const label = fmtDateBR(m.date);
      if (!byDate[m.date]) byDate[m.date] = { _isoDate: m.date, date: label, gasto: 0, 'vendas ads': 0, impressões: 0 };
      byDate[m.date].gasto += m.spend || 0;
      byDate[m.date]['vendas ads'] += m.sales || 0;
      byDate[m.date].impressões += m.impressions || 0;
      byDate[m.date].cliques = (byDate[m.date].cliques || 0) + (m.clicks || 0);
    }
    // Incluir todos os dias do SalesDaily disponíveis
    for (const [isoDate, v] of Object.entries(salesDailyByDate)) {
      if (isoDate > todayStr) continue;
      const label = fmtDateBR(isoDate);
      if (!byDate[isoDate]) byDate[isoDate] = { _isoDate: isoDate, date: label, gasto: 0, 'vendas ads': 0, impressões: 0 };
      byDate[isoDate]['faturamento real'] = v.revenue;
    }
    // Preencher faturamento real e campos extras
    for (const entry of Object.values(byDate)) {
      const iso = entry._isoDate;
      if (entry['faturamento real'] === undefined && salesDailyByDate[iso] !== undefined) {
        entry['faturamento real'] = salesDailyByDate[iso].revenue;
      }
      // Campos extras para tooltip — null se não disponível (não zero)
      const adsExtra = adsExtraByDate[iso];
      const spExtra = spExtraByDate[iso];
      entry._clicks = adsExtra ? adsExtra.clicks : null;
      entry._orders_ads = adsExtra ? adsExtra.orders_ads : null;
      entry._units = spExtra ? spExtra.units : null;
      entry._orders_real = spExtra ? spExtra.orders_real : null;

      // data_status: complete = ambas APIs têm dados, partial = só uma, missing = nenhuma
      const hasAds = !!adsExtra;
      const hasSP = !!spExtra;
      entry._data_status = hasAds && hasSP ? 'complete' : hasAds || hasSP ? 'partial' : 'missing';
      // Marcar como stale se a data é mais antiga que a última disponível de cada API
      if (lastAdsDate && iso > lastAdsDate) entry._data_status = 'missing';

      // Integrar alterações da IA por dia
      const aiCount = aiChangesByDate.get(iso);
      if (aiCount) entry['alterações IA'] = aiCount;
    }
    // Incluir dias que só têm alterações da IA (sem métricas de ads)
    for (const [isoDate, count] of aiChangesByDate.entries()) {
      if (isoDate > todayStr) continue;
      if (!byDate[isoDate]) {
        byDate[isoDate] = { _isoDate: isoDate, date: fmtDateBR(isoDate), gasto: 0, 'vendas ads': 0, impressões: 0, _data_status: 'partial' };
      }
      if (!byDate[isoDate]['alterações IA']) byDate[isoDate]['alterações IA'] = count;
    }
    return Object.values(byDate).sort((a, b) => a._isoDate.localeCompare(b._isoDate));
  }, [allMetrics, salesDailyByDate, aiChangesByDate, adsExtraByDate, spExtraByDate, lastAdsDate]);

  const hasSalesDailyData = salesDaily.length > 0;

  // ─── Orçamento e pacing ────────────────────────────────────────────────────

  const { active_count, paused_count } = useMemo(() => classifyCampaigns(campaigns), [campaigns]);
  const canonicalSettings = canonicalContext?.settings || null;
  const officialDailyLimitFromSettings = canonicalSettings?.daily_budget_limit || 0;
  // Limite diário: prioridade para o contexto canônico (mesma fonte do motor), depois fallbacks legacy
  const officialDailyLimit = officialDailyLimitFromSettings || budgetCfg?.calculated_daily_budget || autopilotConfig?.daily_budget_limit || autopilotConfig?.total_daily_budget || 0;
  // Gasto do último dia com dados disponíveis (lastAvailableAdsDate) — não de "ontem" sem dados
  const spendYesterday = useMemo(() => {
    const refDate = lastAvailableAdsDate || getYesterday();
    const seen = new Set();
    let s = 0;
    for (const m of allMetrics) {
      if (!m.date || m.date !== refDate) continue;
      const k = `${m.campaign_id}-${m.date}`;
      if (seen.has(k)) continue;
      seen.add(k);
      s += m.spend || 0;
    }
    return s;
  }, [allMetrics, lastAvailableAdsDate]);

  // Média diária do período selecionado — divide pelos dias CALENDÁRIO do período, não pelos dias com dados
  const periodDays = activePeriod === 'yesterday' ? 1 : Number(activePeriod);
  const avgDailySpend = periodDays > 0 && kpis.spend > 0 ? safe(kpis.spend / periodDays) : 0;

  // ─── Metas — usa a MESMA cascata de fallback do motor determinístico ──────
  const cfg = canonicalSettings || performanceSettings || autopilotConfig || {};
  // PerformanceSettings usa campos diretos; AutopilotConfig usa prefixo "maximum_"
  const targetAcos = cfg.target_acos || 0;
  const maxAcos = cfg.max_acos || cfg.maximum_acos || 0;
  const targetRoas = cfg.target_roas || 0;
  const targetTacos = cfg.target_tacos || 0;
  const targetCpc = cfg.target_cpc || 0;
  const maxCpc = cfg.max_cpc || cfg.maximum_cpc || 0;

  // ─── Decisões — calculado fora do JSX para evitar IIFE ──────────────────
  const decisionSummary = useMemo(() => {
    if (!decisions.length && !allDecisions.length && !bidChanges.length) return null;
    const total = allDecisions.length;
    const executed = allDecisions.filter(d => d.status === 'executed' || d.status === 'approved').length;
    const failed = allDecisions.filter(d => d.status === 'failed' || d.status === 'error').length;
    const pending = allDecisions.filter(d => d.status === 'pending').length;
    return {
      total,
      executed,
      failed,
      pending,
      pctExecuted: total > 0 ? Math.round(executed / total * 100) : 0,
      pctFailed: total > 0 ? Math.round(failed / total * 100) : 0,
      pctPending: total > 0 ? Math.round(pending / total * 100) : 0,
    };
  }, [decisions, allDecisions, bidChanges]);

  // ─── Próximo sync — calculado fora do JSX para evitar IIFE ──────────────
  const nextSyncLabel = useMemo(() => {
    if (!lastSyncInfo) return null;
    const syncDate = new Date(lastSyncInfo.at);
    const nextSync = new Date(syncDate.getTime() + 24 * 3600000);
    const diffMs = nextSync.getTime() - Date.now();
    const diffH = Math.floor(diffMs / 3600000);
    const diffM = Math.floor((diffMs % 3600000) / 60000);
    return {
      syncDate,
      label: diffMs <= 0 ? 'em breve' : diffH > 0 ? `em ~${diffH}h${diffM > 0 ? diffM + 'min' : ''}` : `em ~${diffM}min`,
    };
  }, [lastSyncInfo]);

  // ─── Header ───────────────────────────────────────────────────────────────

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  const firstName = user?.full_name?.split(' ')[0] || 'gestor';

  return (
    <div className="p-5 space-y-5 animate-fade-in">

      {/* ── 1. HEADER ───────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-white">{greeting}, {firstName}.</h1>
          <p className="text-xs text-slate-500 mt-0.5 flex items-center gap-1.5">
            <span>
              {loading ? (
                <span>Carregando...</span>
              ) : account ? (
                <span><span className="text-emerald-400/80">{campaigns.length} campanhas</span>{' · '}<span>{active_count} ativas</span>{' · '}<span>{products.filter(p => p.status === 'active' && (p.fba_inventory || 0) > 0).length} produtos com estoque</span></span>
              ) : (
                <Link to="/settings" className="text-cyan hover:underline">Configure sua conta Amazon →</Link>
              )}
            </span>
            {nextSyncLabel ? (
                <span className="flex items-center gap-1 text-slate-500 ml-1">
                  <span>{' · '}</span><Clock className="w-3 h-3" />
                  <span>Atualizado em {nextSyncLabel.syncDate.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                  <span className="text-slate-600">{'· Próximo sync '}{nextSyncLabel.label}</span>
                </span>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <AutoWindowStatus justUpdated={justUpdated} />
          <button onClick={loadData} disabled={loading}
            className="p-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* ── 1b. INDICADOR DE CONSISTÊNCIA Dashboard ↔ Motor de IA ───────────── */}
      {account && !loading ? (
        <DataConsistencyBadge
          canonicalContext={canonicalContext}
          loading={canonicalLoading}
        />
      ) : null}

      {/* ── TOKEN EXPIRED BANNER ────────────────────────────────────────────── */}
      {account ? <TokenExpiredBanner accountId={account.id} /> : null}

      {/* ── 2. ALERTAS ESSENCIAIS ────────────────────────────────────────────── */}
      <div className="space-y-2">
        {account ? <SyncStatusBanner accountId={account.id} /> : null}
        {account && !loading ? (
          <SyncStatusCard allMetrics={allMetrics} salesDaily={salesDaily} account={account} adsSales={kpis.sales} spRevenue={realSalesKpis.revenue} />
        ) : null}
      </div>


      {error ? (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
          <p className="text-xs text-red-400">{error}</p>
        </div>
      ) : null}

      {/* Erro de sync automático — só aparece quando falha */}
      {syncError ? (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl border bg-red-500/5 border-red-500/20 text-xs">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
            <span className="text-red-300">Sync falhou: {syncError}</span>
          </div>
          <button onClick={() => { setSyncError(null); runSync(); }}
            className="px-2.5 py-1.5 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white rounded-lg transition-colors whitespace-nowrap">
            Tentar novamente
          </button>
        </div>
      ) : null}

      {/* Decisões pendentes — compacto */}
      {decisions.length > 0 ? (
        <div className="flex items-center justify-between px-4 py-2.5 rounded-xl border bg-violet-500/5 border-violet-500/20 text-xs">
          <span className="text-violet-300"><span className="font-bold">{decisions.length}</span> decisões de IA pendentes de revisão.</span>
          <Link to="/sala-de-comando" className="text-violet-400 hover:underline whitespace-nowrap">Ver na Sala de Controle →</Link>
        </div>
      ) : null}

      {/* ── 3. GRÁFICO CONSOLIDADO: range máximo de dados disponíveis ──────────── */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
        <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
          <h2 className="text-sm font-semibold text-slate-300">Gasto · Vendas · Faturamento Real</h2>
          <div className="flex items-center gap-3 text-[10px] flex-wrap">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-cyan inline-block" />Gasto: {fmtBRL(kpis.spend)}</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" />Vendas Ads: {fmtBRL(kpis.sales)}</span>
          {hasSalesDailyData ? <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-orange-400 inline-block" />Fat. Real: {fmtBRL(realSalesKpis.revenue)}</span> : null}
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-violet-400/60 inline-block" />Impr.: {kpis.impressions.toLocaleString('pt-BR')}</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-sky-400/80 inline-block" />Cliques: {kpis.clicks.toLocaleString('pt-BR')}</span>
          {totalChanges > 0 ? (<span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400 inline-block" />Alt. IA: {totalChanges}</span>) : null}
          </div>
        </div>
        <p className="text-[10px] text-slate-500 mb-2">
          <span>Todo o histórico disponível · Vendas Ads = atribuição Amazon</span>
          {hasSalesDailyData ? <span> · <span className="text-orange-400/80">curva laranja = faturamento real (SP-API)</span></span> : null}
          <span>{' · '}barras roxas = impressões · barras azuis = cliques · barras âmbar = alterações da IA</span>
          {(activePeriod === 'yesterday' && lastAvailableAdsDate && lastAvailableAdsDate < getYesterday()) ? (
            <span> · <span className="text-amber-400/80">⚠ dados de Ads disponíveis até {fmtDateBR(lastAvailableAdsDate)} (latência Amazon)</span></span>
          ) : null}
        </p>
        {hasSalesDailyData ? (
          <div className="flex flex-wrap items-center gap-3 px-3 py-2 mb-3 rounded-lg bg-orange-500/8 border border-orange-500/20 text-[10px]">
            <span className="text-slate-400">📦 Faturamento real (SP-API · {periodLabel}):</span>
            <span className="text-orange-400 font-bold">{fmtBRL(realSalesKpis.revenue)}</span>
            <span className="text-slate-500">{realSalesKpis.units} unid.</span>
            {realSalesKpis.tacos !== null ? (
              <span className="text-slate-400">TACoS: <span className={`font-semibold ${realSalesKpis.tacos > (autopilotConfig?.maximum_tacos || 15) ? 'text-red-400' : realSalesKpis.tacos > (autopilotConfig?.target_tacos || 10) ? 'text-amber-400' : 'text-emerald-400'}`}>{realSalesKpis.tacos.toFixed(1)}%</span></span>
            ) : null}
            {monthProjection ? (
              <>
                <span className="text-slate-600">·</span>
                <span className="text-slate-400">Mês atual: <span className="text-orange-300 font-semibold">{fmtBRL(monthProjection.monthRevenue)}</span> <span className="text-slate-600">({monthProjection.completedPct}% do mês)</span></span>
                <span className="text-slate-400">Projeção mês: <span className="text-amber-300 font-bold">{fmtBRL(monthProjection.projected)}</span> <span className="text-slate-600">(~{fmtBRL(monthProjection.avgPerDay)}/dia)</span></span>
              </>
            ) : null}
          </div>
        ) : null}

        {loading ? (
          <div className="h-56 flex items-center justify-center"><Loader2 className="w-5 h-5 text-cyan animate-spin" /></div>
        ) : consolidatedChart.length === 0 ? (
          <div className="h-56 flex items-center justify-center text-xs text-slate-600">Sem dados. Execute sync para obter o relatório.</div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={consolidatedChart} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="gGasto" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#3B82F6" stopOpacity={0.25} /><stop offset="95%" stopColor="#3B82F6" stopOpacity={0} /></linearGradient>
                <linearGradient id="gVendas" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#10B981" stopOpacity={0.25} /><stop offset="95%" stopColor="#10B981" stopOpacity={0} /></linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
              <XAxis dataKey="date" tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
              {/* Eixo esquerdo: R$ (gasto, vendas, faturamento) */}
              <YAxis yAxisId="brl" tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false} width={42}
                tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(0)}k` : v.toFixed(0)} />
              {/* Eixo direito: impressões e alterações IA (escalas diferentes — impressões domina) */}
              <YAxis yAxisId="impr" orientation="right" tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false} width={36}
                tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(0)}k` : v.toFixed(0)} />
              <YAxis yAxisId="ai" orientation="right" hide />
              <YAxis yAxisId="clicks" orientation="right" hide />
              <Tooltip content={<ChartTooltip consolidatedChart={consolidatedChart} />} />
              {/* Impressões: barras roxas (eixo direito) */}
              <Bar yAxisId="impr" dataKey="impressões" name="Impressões" fill="#8B5CF6" opacity={0.3} radius={[1, 1, 0, 0]} />
              {/* Cliques: barras azul-céu (eixo próprio) */}
              <Bar yAxisId="clicks" dataKey="cliques" name="Cliques" fill="#38BDF8" opacity={0.6} radius={[1, 1, 0, 0]} />
              {/* Alterações da IA: barras âmbar (eixo ai — escala própria) */}
              <Bar yAxisId="ai" dataKey="alterações IA" name="Alterações IA" fill="#F59E0B" opacity={0.7} radius={[2, 2, 0, 0]} />
              {/* Linhas de valor em R$ */}
              <Area yAxisId="brl" type="monotone" dataKey="vendas ads" name="Vendas Ads" stroke="#10B981" fill="url(#gVendas)" strokeWidth={2} dot={false} />
              <Area yAxisId="brl" type="monotone" dataKey="gasto" name="Gasto" stroke="#3B82F6" fill="url(#gGasto)" strokeWidth={2} dot={false} />
              <Line yAxisId="brl" type="monotone" dataKey="faturamento real" name="Faturamento Real" stroke="#FB923C" strokeWidth={hasSalesDailyData ? 2 : 0} dot={false} opacity={hasSalesDailyData ? 1 : 0} />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ── 3b. COMPARAÇÃO MÊS ATUAL VS MÊS ANTERIOR ───────────────────────── */}
      {!loading ? (
        <MoMComparisonChart allMetrics={allMetrics} salesDailyByDate={salesDailyByDate} />
      ) : null}

      {/* ── 3b2. DIAGNÓSTICO Finance Events SP-API vs Dashboard ─────────────── */}
      {account ? <FinanceSyncDiagnostic accountId={account.id} /> : null}

      {/* ── 3c. RELATÓRIOS UNIFICADOS — blocos inteligentes ─────────────────── */}
      {account ? <UnifiedMetricsPanel amazonAccountId={account.id} /> : null}

      {/* ── 3d. METAS DE PERFORMANCE APLICADAS ──────────────────────────────── */}
      {account ? (
        <PerformanceGoalsPanel
          account={account}
          metricsData={{
            acos: kpis.acos,
            roas: kpis.roas,
            tacos: realSalesKpis.tacos,
            cpc: kpis.cpc,
            today_spend: spendYesterday,
            total_budget: autopilotConfig?.daily_budget_limit || autopilotConfig?.total_daily_budget || 0,
          }}
        />
      ) : null}

      {/* ── 4. RESUMO DE PERFORMANCE ────────────────────────────────────────── */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-300">Resumo de performance</h2>
            <p className="text-[10px] text-slate-500 mt-0.5">Período: {periodLabel} · dados fechados sem o dia atual</p>
          </div>
          <PeriodSelector value={activePeriod} onChange={setPeriod} available={availablePeriods} />
        </div>
        {/* Indicador de qualidade da fonte — usa contexto canônico quando disponível */}
        {!loading ? (
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg mb-4 text-[10px] font-medium ${
            dataQuality.quality === 'high'   ? 'bg-emerald-500/8 border border-emerald-500/15 text-emerald-400' :
            dataQuality.quality === 'low'    ? 'bg-red-500/8 border border-red-500/15 text-red-400' :
                                               'bg-surface-2 border border-surface-3 text-slate-500'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
              dataQuality.quality === 'high' ? 'bg-emerald-400' :
              dataQuality.quality === 'low' ? 'bg-red-400' : 'bg-slate-600'
            }`} />
            <span>Fonte: {dataQuality.label}</span>
            {canonicalSettings ? (
              <span className="text-slate-600 hidden sm:inline">· Metas: {canonicalSettings.source}</span>
            ) : null}
            <button onClick={runSync} disabled={syncingDashboard}
              className={`ml-auto underline whitespace-nowrap disabled:opacity-50 flex items-center gap-1 ${
                dataQuality.quality === 'low' ? 'text-red-400 hover:text-red-300' : 'text-emerald-500/70 hover:text-emerald-400'
              }`}>
              {syncingDashboard ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              {syncingDashboard ? 'Atualizando...' : 'Atualizar agora'}
            </button>
          </div>
        ) : null}


        {loading ? (
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
            {Array.from({ length: 9 }).map((_, i) => (
              <div key={i} className="h-20 bg-surface-2 rounded-xl animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
            <KpiCard label="Gasto em Ads" value={fmtBRL(kpis.spend)}
              sub={activePeriod !== 'yesterday' ? `Ontem: ${fmtBRL(yesterdayKpis.spend)}` : undefined} />
            <KpiCard label="Vendas Ads" value={fmtBRL(kpis.sales)}
              sub={`${kpis.orders} pedidos`}
              tone={kpis.sales > 0 ? 'good' : 'default'} />
            <KpiCard label="ACoS"
              value={kpis.spend > 0 ? fmtPct(kpis.acos) : '—'}
              sub={targetAcos > 0 ? `Meta: ${targetAcos}%` : activePeriod !== 'yesterday' ? `Ontem: ${fmtPct(yesterdayKpis.acos)}` : undefined}
              tone={kpis.acos === 0 ? 'default' : kpis.acos <= targetAcos && targetAcos > 0 ? 'good' : kpis.acos <= (maxAcos || 999) ? 'warn' : 'bad'} />
            <KpiCard label="ROAS"
              value={kpis.spend > 0 ? `${kpis.roas.toFixed(2)}x` : '—'}
              sub={targetRoas > 0 ? `Meta: ${targetRoas}x` : undefined}
              tone={kpis.roas === 0 ? 'default' : targetRoas > 0 && kpis.roas >= targetRoas ? 'good' : 'default'} />
            <KpiCard label="CPC médio"
              value={kpis.clicks > 0 ? fmtBRL(kpis.cpc) : '—'}
              sub={maxCpc > 0 ? `Máx: ${fmtBRL(maxCpc)}` : undefined}
              tone={maxCpc > 0 && kpis.cpc > maxCpc ? 'bad' : 'default'} />
            <KpiCard label="CTR" value={kpis.impressions > 0 ? `${kpis.ctr.toFixed(3)}%` : '—'} />
            <KpiCard label="Cliques" value={kpis.clicks.toLocaleString('pt-BR')}
              sub={activePeriod !== 'yesterday' ? `Ontem: ${yesterdayKpis.clicks.toLocaleString('pt-BR')}` : undefined} />
            <KpiCard label="Impressões" value={kpis.impressions.toLocaleString('pt-BR')}
              sub={activePeriod !== 'yesterday' ? `Ontem: ${yesterdayKpis.impressions.toLocaleString('pt-BR')}` : undefined}
              tone="cyan" />
            <KpiCard label="Pedidos" value={kpis.orders.toLocaleString('pt-BR')}
              sub={activePeriod !== 'yesterday' ? `Ontem: ${yesterdayKpis.orders.toLocaleString('pt-BR')}` : undefined}
              tone={kpis.orders > 0 ? 'good' : 'default'} />
            {hasSalesDailyData ? (
              <div className={`bg-surface-1 border rounded-xl p-4 ${realSalesKpis.revenue > 0 ? 'border-emerald-500/25 bg-emerald-500/5' : 'border-surface-2'}`}>
                <p className="text-[10px] font-medium text-slate-500 mb-1 uppercase tracking-wide">
                  Faturamento {salesDailyByDate[startDate]?.source === 'finance_events' ? '(Finance Events ✓)' : '(estimado)'}
                </p>
                <p className="text-xl font-bold text-white">{fmtBRL(realSalesKpis.revenue)}</p>
                {realSalesKpis.revenue === 0 ? (
                  <button onClick={runSync} disabled={syncingDashboard}
                    className="mt-1 flex items-center gap-1 text-[10px] text-amber-400 hover:text-amber-300 transition-colors disabled:opacity-50">
                    {syncingDashboard ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <RefreshCw className="w-2.5 h-2.5" />}
                    {syncingDashboard ? 'Atualizando...' : `${realSalesKpis.units} unidades · atualizar`}
                  </button>
                ) : (
                  <p className="text-[10px] text-slate-500 mt-1">{realSalesKpis.units} unidades</p>
                )}
              </div>
            ) : null}
            {hasSalesDailyData && realSalesKpis.tacos !== null ? (
              <KpiCard label="TACoS Real"
                value={kpis.sales > 0 && realSalesKpis.revenue === 0 ? '⚠ pendente' : `${realSalesKpis.tacos.toFixed(1)}%`}
                sub={kpis.sales > 0 && realSalesKpis.revenue === 0 ? 'Divergência Ads × SP-API' : targetTacos > 0 ? `Meta: ${targetTacos}%` : 'Gasto Ads / Fat. Real'}
                tone={kpis.sales > 0 && realSalesKpis.revenue === 0 ? 'warn' : realSalesKpis.tacos > (autopilotConfig?.maximum_tacos || 15) ? 'bad' : realSalesKpis.tacos > (autopilotConfig?.target_tacos || 10) ? 'warn' : 'good'} />
            ) : null}
            {monthProjection ? (
              <KpiCard label="Projeção do Mês"
                value={fmtBRL(monthProjection.projected)}
                sub={`${monthProjection.completedPct}% concluído · ${fmtBRL(monthProjection.avgPerDay)}/dia`}
                tone="cyan" />
            ) : null}
          </div>
        )}
      </div>



      {/* ── 5a. CARTÕES EXTRAS SP-API ────────────────────────────────────────── */}
      {!loading && hasSalesDailyData ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <KpiCard
            label="Unidades vendidas"
            value={extraKpis.totalUnits > 0 ? extraKpis.totalUnits.toLocaleString('pt-BR') : '—'}
            sub={`Período: ${periodLabel}`}
            tone={extraKpis.totalUnits > 0 ? 'good' : 'default'}
          />
          <KpiCard
            label="Pedidos reais"
            value={extraKpis.totalRealOrders > 0 ? extraKpis.totalRealOrders.toLocaleString('pt-BR') : '—'}
            sub="Fonte: SP-API"
          />
          <KpiCard
            label="Receita / unidade"
            value={extraKpis.revenuePerUnit != null ? fmtBRL(extraKpis.revenuePerUnit) : '—'}
            sub={extraKpis.totalUnits > 0 ? `${extraKpis.totalUnits} unid.` : 'Sem dados'}
          />
          <div className={`bg-surface-1 border rounded-xl p-4 border-surface-2`}>
            <p className="text-[10px] font-medium text-slate-500 mb-1 uppercase tracking-wide">Maior / Menor dia</p>
            {extraKpis.bestDay ? (
              <div className="space-y-1">
                <p className="text-xs text-emerald-400 font-semibold">↑ {fmtBRL(extraKpis.bestDay.revenue)} <span className="text-slate-500 font-normal text-[10px]">({fmtDateBR(extraKpis.bestDay.date)})</span></p>
                {extraKpis.worstDay && extraKpis.worstDay.date !== extraKpis.bestDay.date ? (
                  <p className="text-xs text-red-400 font-semibold">↓ {fmtBRL(extraKpis.worstDay.revenue)} <span className="text-slate-500 font-normal text-[10px]">({fmtDateBR(extraKpis.worstDay.date)})</span></p>
                ) : null}
                <p className="text-[9px] text-slate-600">Apenas dias com dados completos</p>
              </div>
            ) : (
              <p className="text-sm font-bold text-slate-500">—</p>
            )}
          </div>
        </div>
      ) : null}

      {/* ── 5a2. ALTERAÇÕES DA IA — segmentadas ──────────────────────────────── */}
      {!loading && bidChanges.length > 0 ? (
        <AiChangesBreakdown bidChanges={bidChanges} />
      ) : null}

      {/* ── 5b. CARDS COMPLEMENTARES ─────────────────────────────────────────── */}
      {!loading ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

          {/* Top campanhas por gasto */}
          <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-slate-300">Top campanhas por gasto</h2>
              <Link to="/ads" className="text-[10px] text-cyan hover:underline">Ver todas →</Link>
            </div>
            {topCampaigns.length === 0 ? (
              <p className="text-xs text-slate-600 py-4 text-center">Sem dados de campanhas</p>
            ) : (
              <div className="space-y-2.5">
                {topCampaigns.map((c, i) => {
                  const acos = c.acos || (c.sales > 0 ? c.spend / c.sales * 100 : 0);
                  const acosColor = acos === 0 ? 'text-slate-500' : acos <= (autopilotConfig?.target_acos || 25) ? 'text-emerald-400' : acos <= (autopilotConfig?.maximum_acos || 40) ? 'text-amber-400' : 'text-red-400';
                  return (
                    <div key={c.id || i} className="flex items-center gap-2">
                      <span className="text-[10px] text-slate-600 w-3 flex-shrink-0">{i + 1}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-slate-300 truncate">{(c.campaign_name || c.name || c.campaign_id || '—').replace(/AUTO \| /, '').slice(0, 35)}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[10px] text-cyan">R${(c.spend || 0).toFixed(2)}</span>
                          <span className="text-[10px] text-emerald-400">R${(c.sales || 0).toFixed(2)}</span>
                          {acos > 0 ? <span className={`text-[10px] font-semibold ${acosColor}`}>{acos.toFixed(1)}%</span> : null}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

          </div>

          {/* Estoque e saúde dos produtos */}
          <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-slate-300">Saúde dos produtos</h2>
              <Link to="/products" className="text-[10px] text-cyan hover:underline">Ver todos →</Link>
            </div>
            <div className="grid grid-cols-3 gap-2 mb-3">
              {[
                { label: 'Em estoque', value: products.filter(p => p.inventory_status === 'in_stock').length, sub: `${products.filter(p=>p.inventory_status==='in_stock').reduce((s,p)=>s+(p.fba_inventory||0),0)} un`, color: 'text-emerald-400' },
                { label: 'Baixo estoque', value: products.filter(p => p.inventory_status === 'low_stock').length, sub: `${products.filter(p=>p.inventory_status==='low_stock').reduce((s,p)=>s+(p.fba_inventory||0),0)} un`, color: 'text-amber-400' },
                { label: 'Sem estoque', value: products.filter(p => p.inventory_status === 'out_of_stock').length, sub: '0 un', color: 'text-red-400' },
              ].map(s => (
                <div key={s.label} className="text-center bg-surface-2 rounded-lg p-2">
                  <p className={`text-lg font-bold ${s.color}`}>{s.value}</p>
                  <p className="text-[9px] text-slate-500 leading-tight">{s.label}</p>
                  <p className="text-[9px] text-slate-600">{s.sub}</p>
                </div>
              ))}
            </div>
            {productsNeedAttention.length > 0 ? (
              <div className="space-y-1.5">
                <p className="text-[10px] text-slate-500 mb-1">Requer atenção:</p>
                {productsNeedAttention.map((p, i) => (
                  <div key={p.id || i} className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${p.inventory_status === 'out_of_stock' ? 'bg-red-400' : p.inventory_status === 'low_stock' ? 'bg-amber-400' : 'bg-violet-400'}`} />
                    <span className="text-[10px] text-slate-400 truncate">{p.asin}</span>
                    <span className="text-[10px] text-slate-600 ml-auto flex-shrink-0">
                      {p.inventory_status === 'out_of_stock' ? 'Sem estoque' : p.inventory_status === 'low_stock' ? `${p.fba_inventory || 0} un` : 'Sem campanha'}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-emerald-400 text-center py-2">Todos os produtos saudáveis</p>
            )}
          </div>

          {/* Eficiência operacional */}
          <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-slate-300 mb-3">Eficiência operacional</h2>
            <div className="space-y-2.5">
              {[
                {
                  label: 'CVR (Conversão)',
                  value: kpis.clicks > 0 ? `${(kpis.orders / kpis.clicks * 100).toFixed(2)}%` : '—',
                  hint: 'Pedidos / Cliques',
                  color: kpis.clicks > 0 && kpis.orders / kpis.clicks > 0.02 ? 'text-emerald-400' : 'text-amber-400',
                },
                {
                  label: 'CPA (Custo por pedido)',
                  value: kpis.orders > 0 ? `R$${(kpis.spend / kpis.orders).toFixed(2)}` : '—',
                  hint: 'Gasto / Pedidos',
                  color: 'text-slate-300',
                },
                {
                  label: 'Receita por clique',
                  value: kpis.clicks > 0 ? `R$${(kpis.sales / kpis.clicks).toFixed(2)}` : '—',
                  hint: 'Vendas / Cliques',
                  color: kpis.clicks > 0 && kpis.sales / kpis.clicks > 3 ? 'text-emerald-400' : 'text-slate-300',
                },
                {
                  label: 'Ticket médio',
                  value: kpis.orders > 0 ? `R$${(kpis.sales / kpis.orders).toFixed(2)}` : '—',
                  hint: 'Vendas / Pedidos',
                  color: 'text-slate-300',
                },
                {
                  label: 'Spend / Impressão',
                  value: kpis.impressions > 0 ? `R$${(kpis.spend / kpis.impressions * 1000).toFixed(3)}/mil` : '—',
                  hint: 'CPM — custo por mil impressões',
                  color: 'text-slate-300',
                },
              ].map(m => (
                <div key={m.label} className="flex items-center justify-between">
                  <div>
                    <p className="text-[10px] text-slate-500">{m.label}</p>
                    <p className="text-[9px] text-slate-600">{m.hint}</p>
                  </div>
                  <p className={`text-sm font-bold ${m.color}`}>{m.value}</p>
                </div>
              ))}
            </div>
            <p className="text-[9px] text-slate-600 mt-3">Período: {periodLabel}</p>
          </div>
        </div>
      ) : null}

      {/* ── 6. ORÇAMENTO E PACING ────────────────────────────────────────────── */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-slate-300">Orçamento e pacing</h2>
          {officialDailyLimit === 0 ? (
            <Link to="/settings" className="text-xs text-amber-400 hover:underline">Configurar limite →</Link>
          ) : null}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <KpiCard label="Limite diário geral" value={officialDailyLimit > 0 ? fmtBRL(officialDailyLimit) : '—'} tone="cyan" />
          <KpiCard label={`Gasto D-1 (${lastAvailableAdsDate || getYesterday()})`} value={fmtBRL(spendYesterday)}
            sub={officialDailyLimit > 0 ? `${Math.round(spendYesterday / officialDailyLimit * 100)}% do limite` : `${allMetrics.filter(m => m.date === (lastAvailableAdsDate || getYesterday())).length} registros`}
            tone={officialDailyLimit > 0 && spendYesterday > officialDailyLimit ? 'bad' : 'default'} />
          <KpiCard label="Média diária" value={fmtBRL(avgDailySpend)} sub={`Período: ${periodLabel}`} />
          <KpiCard label="Campanhas ativas" value={active_count} sub={`${paused_count} pausadas`} />
        </div>
        {(officialDailyLimit > 0 && spendYesterday > 0) ? (
          <div>
            <div className="flex justify-between text-[10px] text-slate-500 mb-1">
              <span>Pacing D-1 ({lastAvailableAdsDate || getYesterday()}): {fmtBRL(spendYesterday)} / {fmtBRL(officialDailyLimit)}</span>
              <span className={`font-semibold ${spendYesterday > officialDailyLimit ? 'text-red-400' : 'text-emerald-400'}`}>
                {Math.round(spendYesterday / officialDailyLimit * 100)}%
              </span>
            </div>
            <div className="h-1.5 bg-surface-3 rounded-full overflow-hidden">
              <div className={`h-full rounded-full transition-all ${spendYesterday > officialDailyLimit ? 'bg-red-500' : 'bg-emerald-500'}`}
                style={{ width: `${Math.min(100, spendYesterday / officialDailyLimit * 100)}%` }} />
            </div>
          </div>
        ) : null}
        {budgetCfg?.next_weekly_recalculation ? (
          <p className="text-[10px] text-slate-600 mt-2">
            Próximo recálculo: {new Date(String(budgetCfg.next_weekly_recalculation)).toLocaleDateString('pt-BR')}
          </p>
        ) : null}
      </div>

      {/* ── 7. METAS VS REALIDADE ────────────────────────────────────────────── */}
      {(targetAcos > 0 || targetRoas > 0 || targetTacos > 0) ? (
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-300">Metas vs realidade</h2>
            <span className="text-[10px] text-slate-500">Período: {periodLabel}</span>
          </div>
          <div className="space-y-0">
            <GoalRow label="ACoS" real={kpis.acos} target={targetAcos} unit="%" lowerIsBetter />
            {maxAcos > 0 ? <GoalRow label="ACoS máximo" real={kpis.acos} target={maxAcos} unit="%" lowerIsBetter /> : null}
            <GoalRow label="ROAS" real={kpis.roas} target={targetRoas} unit="x" lowerIsBetter={false} realLabel={kpis.roas > 0 ? `${kpis.roas.toFixed(2)}x` : '—'} />
            <GoalRow label="TACoS real" real={realSalesKpis.tacos || 0} target={targetTacos} unit="%" lowerIsBetter realLabel={realSalesKpis.tacos !== null ? `${realSalesKpis.tacos.toFixed(1)}%` : '—'} />
            {targetCpc > 0 ? <GoalRow label="CPC alvo" real={kpis.cpc} target={targetCpc} unit="" lowerIsBetter realLabel={kpis.cpc > 0 ? fmtBRL(kpis.cpc) : '—'} /> : null}
            {maxCpc > 0 ? <GoalRow label="CPC máximo" real={kpis.cpc} target={maxCpc} unit="" lowerIsBetter realLabel={kpis.cpc > 0 ? fmtBRL(kpis.cpc) : '—'} /> : null}
            {officialDailyLimit > 0 ? <GoalRow label="Budget D-1" real={spendYesterday} target={officialDailyLimit} unit="" lowerIsBetter realLabel={fmtBRL(spendYesterday)} /> : null}
          </div>
        </div>
      ) : null}

      {/* ── 8. RESUMO DE DECISÕES ────────────────────────────────────────────── */}
      {decisionSummary != null ? (
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-300">Decisões e automação</h2>
            <Link to="/sala-de-comando" className="text-xs text-cyan hover:underline">Sala de Controle →</Link>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-surface-2 rounded-lg p-3">
              <p className="text-[10px] text-slate-500 mb-1">Implementadas</p>
              <p className="text-xl font-bold text-emerald-400">{decisionSummary.executed}</p>
              <p className="text-[10px] text-slate-600 mt-0.5">{decisionSummary.pctExecuted}% do total</p>
            </div>
            <div className="bg-surface-2 rounded-lg p-3">
              <p className="text-[10px] text-slate-500 mb-1">Com erro</p>
              <p className={`text-xl font-bold ${decisionSummary.failed > 0 ? 'text-red-400' : 'text-emerald-400'}`}>{decisionSummary.failed}</p>
              <p className="text-[10px] text-slate-600 mt-0.5">{decisionSummary.pctFailed}% do total</p>
            </div>
            <div className="bg-surface-2 rounded-lg p-3">
              <p className="text-[10px] text-slate-500 mb-1">Pendentes</p>
              <p className={`text-xl font-bold ${decisionSummary.pending > 0 ? 'text-amber-400' : 'text-slate-400'}`}>{decisionSummary.pending}</p>
              <p className="text-[10px] text-slate-600 mt-0.5">{decisionSummary.pctPending}% do total</p>
            </div>
            <div className="bg-surface-2 rounded-lg p-3">
              <p className="text-[10px] text-slate-500 mb-1">Ajustes de bid (30d)</p>
              <p className="text-xl font-bold text-white">{totalChanges}</p>
              <p className="text-[10px] text-slate-600 mt-0.5">AdsBidChangeLog</p>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── 9. LINKS PARA ANÁLISES PROFUNDAS ────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { to: '/analytics', icon: BarChart2, label: 'Analytics', sub: 'Análise detalhada', color: 'text-cyan' },
          { to: '/ads', icon: Megaphone, label: 'Campanhas', sub: 'Gerenciar anúncios', color: 'text-emerald-400' },
          { to: '/term-bank', icon: BookOpen, label: 'Term Bank', sub: 'Palavras-chave', color: 'text-amber-400' },
          { to: '/sala-de-comando', icon: Terminal, label: 'Sala de Controle', sub: 'Operações e filas', color: 'text-violet-400' },
        ].map(({ to, icon: Icon, label, sub, color }) => (
          <Link key={to} to={to}
            className="bg-surface-1 border border-surface-2 hover:border-surface-3 rounded-xl p-4 flex items-center gap-3 transition-colors group">
            <div className="w-8 h-8 rounded-lg bg-surface-2 flex items-center justify-center flex-shrink-0">
              <Icon className={`w-4 h-4 ${color}`} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-300 group-hover:text-white transition-colors">{label}</p>
              <p className="text-[10px] text-slate-600">{sub}</p>
            </div>
          </Link>
        ))}
      </div>

    </div>
  );
}