import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { loadAllCampaigns, classifyCampaigns } from '@/lib/campaignUtils';
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
import MoMComparisonChart from '@/components/dashboard/MoMComparisonChart';
import UnifiedMetricsPanel from '@/components/dashboard/UnifiedMetricsPanel';
import PerformanceGoalsPanel from '@/components/dashboard/PerformanceGoalsPanel';
import AutoWindowStatus from '@/components/dashboard/AutoWindowStatus';

// ─── Utilitários de período fechado ─────────────────────────────────────────

function getYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function getClosedReportingPeriod(period) {
  const yesterday = getYesterday();
  if (period === 'yesterday') return { startDate: yesterday, endDate: yesterday, label: 'Ontem' };
  const days = Number(period);
  const start = new Date();
  start.setDate(start.getDate() - days);
  start.setHours(0, 0, 0, 0);
  return { startDate: start.toISOString().slice(0, 10), endDate: yesterday, label: `${days} dias` };
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
      {sub && <p className="text-[10px] text-slate-500 mt-1">{sub}</p>}
    </div>
  );
}

const ChartTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-[#111318] border border-surface-2 rounded-lg p-3 text-xs shadow-xl">
      <p className="text-slate-400 mb-1.5 font-medium">{label}</p>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2 mb-1">
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: p.color }} />
          <span className="text-slate-300">{p.name}:</span>
          <span className="text-white font-semibold">
            {['impressões', 'cliques', 'alterações'].some(w => String(p.name).toLowerCase().includes(w))
              ? Number(p.value).toLocaleString('pt-BR')
              : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(p.value))}
          </span>
        </div>
      ))}
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
        {real > 0 && <span className={`text-[10px] ${tone}`}>{dir}</span>}
      </div>
    </div>
  );
}

// ─── Dashboard principal ─────────────────────────────────────────────────────

export default function Dashboard() {
  const [user, setUser] = useState(null);
  const [account, setAccount] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [products, setProducts] = useState([]);
  const [metricsDaily, setMetricsDaily] = useState([]);
  const [decisions, setDecisions] = useState([]);
  const [allDecisions, setAllDecisions] = useState([]);
  const [syncRuns, setSyncRuns] = useState([]);
  const [bidChanges, setBidChanges] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [autopilotConfig, setAutopilotConfig] = useState(null);
  const [lastSyncInfo, setLastSyncInfo] = useState(null);
  const [syncingDashboard, setSyncingDashboard] = useState(false);
  const [syncError, setSyncError] = useState(null);
  const [period, setPeriod] = useState('7');
  const [budgetCfg, setBudgetCfg] = useState(null);
  const [sellerBenchmark, setSellerBenchmark] = useState(null);
  const [salesDaily, setSalesDaily] = useState([]);
  const autoSyncedRef = useRef(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await base44.auth.me();
      setUser(me);
      const allAccounts = await base44.entities.AmazonAccount.filter({ user_id: me.id }, '-updated_date', 5);
      const acc = allAccounts.find(a => a.status === 'connected') || allAccounts[0] || null;
      setAccount(acc);
      if (!acc) { setLoading(false); return; }
      const aid = acc.id;
      const safe_ = async (fn, fb = []) => { try { return await fn(); } catch (e) { if (String(e?.message).includes('429')) return fb; throw e; } };

      // Carregar tudo em paralelo — elimina latência sequencial
      const [cams, prods, metrics, decs, allDecs, runs, changes, apConfigs, budgCfgs, benchmarks, salesDailyData] = await Promise.all([
        safe_(() => loadAllCampaigns(aid)),
        safe_(() => base44.entities.Product.filter({ amazon_account_id: aid }, '-fba_inventory', 20)),
        safe_(() => base44.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 5000)),
        safe_(() => base44.entities.OptimizationDecision.filter({ amazon_account_id: aid, status: 'pending' }, '-created_at', 10)),
        safe_(() => base44.entities.OptimizationDecision.filter({ amazon_account_id: aid }, '-created_at', 2000)),
        safe_(() => base44.entities.SyncExecutionLog.filter({ amazon_account_id: aid }, '-started_at', 5)),
        safe_(() => base44.entities.AdsBidChangeLog.filter({ amazon_account_id: aid }, '-created_at', 2000)),
        safe_(() => base44.entities.AutopilotConfig.filter({ amazon_account_id: aid })),
        safe_(() => base44.entities.BudgetConfiguration.filter({ amazon_account_id: aid }), []),
        safe_(() => base44.entities.SellerPerformanceBenchmark.filter({ amazon_account_id: aid }, '-period_end', 5), []),
        safe_(() => {
          const since60 = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
          return base44.entities.SalesDaily.filter({ amazon_account_id: aid, date: { $gte: since60 } }, '-date', 1000);
        }, []),
      ]);

      setCampaigns(cams);
      setProducts(prods);
      setMetricsDaily(metrics);
      setDecisions(decs);
      setAllDecisions(allDecs);
      setSyncRuns(runs);
      setBidChanges(changes);
      setAutopilotConfig(apConfigs[0] || null);
      setBudgetCfg(budgCfgs[0] || null);
      setSellerBenchmark(benchmarks[0] || null);
      setSalesDaily(salesDailyData);

      if (acc?.last_sync_at) setLastSyncInfo({ at: acc.last_sync_at });
      else {
        const last = runs.find(r => r.status === 'success' || r.status === 'skipped_limit');
        if (last) setLastSyncInfo({ at: last.completed_at || last.started_at });
      }

      // Sync automático se gap > 2 dias e ainda não rodou nesta sessão
      const yesterday_ = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const uniqueDatesAll = [...new Set(metrics.map(m => m.date).filter(Boolean))].sort();
      const lastDataDate = uniqueDatesAll.length > 0 ? uniqueDatesAll[uniqueDatesAll.length - 1] : null;
      const gapDays = lastDataDate ? Math.round((new Date(yesterday_).getTime() - new Date(lastDataDate).getTime()) / 86400000) : 0;
      const needsSync = gapDays > 2;

      if (needsSync && !autoSyncedRef.current) {
        // Verificar cooldown de 23h para não sobrecarregar a API
        const lastSyncAt = acc?.last_sync_at;
        const ageHours = lastSyncAt ? (Date.now() - new Date(lastSyncAt).getTime()) / 3600000 : 999;
        if (ageHours >= 23) {
        autoSyncedRef.current = true;
        setSyncingDashboard(true);
        setSyncError(null);
        base44.functions.invoke('syncAdsQuick', { amazon_account_id: aid })
          .then(res => {
            if (!res?.data?.ok) setSyncError(res?.data?.error || 'Sync automático falhou.');
            else loadData();
          })
          .catch(e => setSyncError(e.message))
          .finally(() => setSyncingDashboard(false));
        }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const runSync = async () => {
    if (!account || syncingDashboard) return;
    setSyncingDashboard(true);
    setSyncError(null);
    try {
      const res = await base44.functions.invoke('syncAdsQuick', { amazon_account_id: account.id });
      if (res?.data?.ok) await loadData();
      else setSyncError(res?.data?.error || 'Falha no sync.');
    } catch (e) {
      setSyncError(e.message);
    } finally {
      setSyncingDashboard(false);
    }
  };

  // ─── Cálculos com período fechado ─────────────────────────────────────────

  const allMetrics = useMemo(() => dedupeMetrics(metricsDaily), [metricsDaily]);

  // Determinar períodos disponíveis
  const availablePeriods = useMemo(() => {
    const yesterday = getYesterday();
    const dates = new Set(allMetrics.filter(m => m.date <= yesterday).map(m => m.date));
    const periods = ['yesterday'];
    if (dates.size >= 7) periods.push('7');
    if (dates.size >= 14) periods.push('14');
    if (dates.size >= 28) periods.push('30');
    return periods;
  }, [allMetrics]);

  // Garantir que period seja válido
  const activePeriod = availablePeriods.includes(period) ? period : availablePeriods[availablePeriods.length - 1] || 'yesterday';

  // Última data com dados de Ads (pode ser anterior a ontem por latência da Amazon)
  const lastAvailableAdsDate = useMemo(() => {
    const dates = allMetrics.map(m => m.date).filter(Boolean).sort();
    return dates.length > 0 ? dates[dates.length - 1] : null;
  }, [allMetrics]);

  const { startDate, endDate, label: periodLabel } = useMemo(() => {
    const base = getClosedReportingPeriod(activePeriod);
    // Se "Ontem" não tem dados de Ads mas há dados mais antigos, usar o último dia disponível
    if (activePeriod === 'yesterday' && lastAvailableAdsDate && lastAvailableAdsDate < base.endDate) {
      return { startDate: lastAvailableAdsDate, endDate: lastAvailableAdsDate, label: `${fmtDateBRFull(lastAvailableAdsDate)} (último c/ dados)` };
    }
    return base;
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

  // Ontem para subtexto
  const yesterday = getYesterday();
  const yesterdayKpis = useMemo(() =>
    deriveRates(calcKpis(allMetrics.filter(m => m.date === yesterday))),
    [allMetrics, yesterday]
  );

  // ─── Total de alterações da IA (soma de todos os registros de bidChanges) ──
  const totalChanges = bidChanges.length;

  // ─── SalesDaily: faturamento real por data ────────────────────────────────

  const salesDailyByDate = useMemo(() => {
    const map = {};
    for (const s of salesDaily) {
      if (!s.date) continue;
      if (!map[s.date]) map[s.date] = { revenue: 0, units: 0 };
      map[s.date].revenue += s.ordered_product_sales || 0;
      map[s.date].units += s.units_ordered || 0;
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
    }
    // Incluir todos os dias do SalesDaily disponíveis
    for (const [isoDate, v] of Object.entries(salesDailyByDate)) {
      if (isoDate > todayStr) continue;
      const label = fmtDateBR(isoDate);
      if (!byDate[isoDate]) byDate[isoDate] = { _isoDate: isoDate, date: label, gasto: 0, 'vendas ads': 0, impressões: 0 };
      byDate[isoDate]['faturamento real'] = v.revenue;
    }
    // Preencher faturamento real nos dias que já existiam via ads metrics
    for (const entry of Object.values(byDate)) {
      if (entry['faturamento real'] === undefined && salesDailyByDate[entry._isoDate] !== undefined) {
        entry['faturamento real'] = salesDailyByDate[entry._isoDate].revenue;
      }
      // Integrar alterações da IA por dia
      const aiCount = aiChangesByDate.get(entry._isoDate);
      if (aiCount) entry['alterações IA'] = aiCount;
    }
    // Incluir dias que só têm alterações da IA (sem métricas de ads)
    for (const [isoDate, count] of aiChangesByDate.entries()) {
      if (isoDate > todayStr) continue;
      if (!byDate[isoDate]) {
        byDate[isoDate] = { _isoDate: isoDate, date: fmtDateBR(isoDate), gasto: 0, 'vendas ads': 0, impressões: 0 };
      }
      if (!byDate[isoDate]['alterações IA']) byDate[isoDate]['alterações IA'] = count;
    }
    return Object.values(byDate).sort((a, b) => a._isoDate.localeCompare(b._isoDate));
  }, [allMetrics, salesDailyByDate, aiChangesByDate]);

  const hasSalesDailyData = salesDaily.length > 0;

  // ─── Orçamento e pacing ────────────────────────────────────────────────────

  const { active: activeCampsList, active_count, paused_count } = useMemo(() => classifyCampaigns(campaigns), [campaigns]);
  const officialDailyLimit = budgetCfg?.calculated_daily_budget || autopilotConfig?.daily_budget_limit || autopilotConfig?.total_daily_budget || 0;
  const spendYesterday = useMemo(() => {
    const seen = new Set();
    let s = 0;
    for (const m of allMetrics) {
      if (m.date !== yesterday) continue;
      const k = `${m.campaign_id}-${m.date}`;
      if (seen.has(k)) continue;
      seen.add(k);
      s += m.spend || 0;
    }
    return s;
  }, [allMetrics, yesterday]);

  // Média diária do período selecionado
  const uniqueDates = useMemo(() => new Set(periodMetrics.map(m => m.date)), [periodMetrics]);
  const avgDailySpend = uniqueDates.size > 0 ? safe(kpis.spend / uniqueDates.size) : 0;

  // ─── Metas ────────────────────────────────────────────────────────────────

  const cfg = autopilotConfig || {};
  const targetAcos = cfg.target_acos || 0;
  const maxAcos = cfg.maximum_acos || 0;
  const targetRoas = cfg.target_roas || 0;
  const targetTacos = cfg.target_tacos || 0;
  const targetCpc = cfg.target_cpc || 0;
  const maxCpc = cfg.maximum_cpc || 0;

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
            {loading ? 'Carregando...' : account
              ? <><span className="text-emerald-400/80">{campaigns.length} campanhas</span> · {active_count} ativas · {products.length} produtos</>
              : <Link to="/settings" className="text-cyan hover:underline">Configure sua conta Amazon →</Link>}
            {lastSyncInfo && (
              <span className="flex items-center gap-1 text-slate-500 ml-1">
                · <Clock className="w-3 h-3" />
                Atualizado em {new Date(lastSyncInfo.at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <AutoWindowStatus />
          <button onClick={loadData} disabled={loading}
            className="p-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* ── 2. ALERTAS ESSENCIAIS ────────────────────────────────────────────── */}
      {account && <SyncStatusBanner accountId={account.id} />}


      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
          <p className="text-xs text-red-400">{error}</p>
        </div>
      )}

      {/* Erro de sync automático — só aparece quando falha */}
      {syncError && (
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
      )}

      {/* Decisões pendentes — compacto */}
      {decisions.length > 0 && (
        <div className="flex items-center justify-between px-4 py-2.5 rounded-xl border bg-violet-500/5 border-violet-500/20 text-xs">
          <span className="text-violet-300"><span className="font-bold">{decisions.length}</span> decisões de IA pendentes de revisão.</span>
          <Link to="/sala-de-comando" className="text-violet-400 hover:underline whitespace-nowrap">Ver na Sala de Controle →</Link>
        </div>
      )}

      {/* ── 3. GRÁFICO CONSOLIDADO: range máximo de dados disponíveis ──────────── */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
        <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
          <h2 className="text-sm font-semibold text-slate-300">Gasto · Vendas · Faturamento Real</h2>
          <div className="flex items-center gap-3 text-[10px] flex-wrap">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-cyan inline-block" />Gasto: {fmtBRL(kpis.spend)}</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" />Vendas Ads: {fmtBRL(kpis.sales)}</span>
            {hasSalesDailyData && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-orange-400 inline-block" />Fat. Real: {fmtBRL(realSalesKpis.revenue)}</span>}
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-violet-400/60 inline-block" />Impr.: {kpis.impressions.toLocaleString('pt-BR')}</span>
            {totalChanges > 0 && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400 inline-block" />Alt. IA: {totalChanges}</span>}
          </div>
        </div>
        <p className="text-[10px] text-slate-500 mb-2">
          Todo o histórico disponível · Vendas Ads = atribuição Amazon
          {hasSalesDailyData && <> · <span className="text-orange-400/80">curva laranja = faturamento real (SP-API)</span></>}
          {' · '}barras roxas = impressões · barras âmbar = alterações da IA
          {activePeriod === 'yesterday' && lastAvailableAdsDate && lastAvailableAdsDate < getYesterday() && (
            <> · <span className="text-amber-400/80">⚠ dados de Ads disponíveis até {fmtDateBR(lastAvailableAdsDate)} (latência Amazon)</span></>
          )}
        </p>
        {hasSalesDailyData && (
          <div className="flex flex-wrap items-center gap-3 px-3 py-2 mb-3 rounded-lg bg-orange-500/8 border border-orange-500/20 text-[10px]">
            <span className="text-slate-400">📦 Faturamento real (SP-API · {periodLabel}):</span>
            <span className="text-orange-400 font-bold">{fmtBRL(realSalesKpis.revenue)}</span>
            <span className="text-slate-500">{realSalesKpis.units} unid.</span>
            {realSalesKpis.tacos !== null && (
              <span className="text-slate-400">TACoS: <span className={`font-semibold ${realSalesKpis.tacos > (autopilotConfig?.maximum_tacos || 15) ? 'text-red-400' : realSalesKpis.tacos > (autopilotConfig?.target_tacos || 10) ? 'text-amber-400' : 'text-emerald-400'}`}>{realSalesKpis.tacos.toFixed(1)}%</span></span>
            )}
            {monthProjection && (
              <>
                <span className="text-slate-600">·</span>
                <span className="text-slate-400">Mês atual: <span className="text-orange-300 font-semibold">{fmtBRL(monthProjection.monthRevenue)}</span> <span className="text-slate-600">({monthProjection.completedPct}% do mês)</span></span>
                <span className="text-slate-400">Projeção mês: <span className="text-amber-300 font-bold">{fmtBRL(monthProjection.projected)}</span> <span className="text-slate-600">(~{fmtBRL(monthProjection.avgPerDay)}/dia)</span></span>
              </>
            )}
          </div>
        )}

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
              <Tooltip content={<ChartTooltip />} />
              {/* Impressões: barras roxas (eixo direito) */}
              <Bar yAxisId="impr" dataKey="impressões" name="Impressões" fill="#8B5CF6" opacity={0.3} radius={[1, 1, 0, 0]} />
              {/* Alterações da IA: barras âmbar (eixo ai — escala própria) */}
              <Bar yAxisId="ai" dataKey="alterações IA" name="Alterações IA" fill="#F59E0B" opacity={0.7} radius={[2, 2, 0, 0]} />
              {/* Linhas de valor em R$ */}
              <Area yAxisId="brl" type="monotone" dataKey="vendas ads" name="Vendas Ads" stroke="#10B981" fill="url(#gVendas)" strokeWidth={2} dot={false} />
              <Area yAxisId="brl" type="monotone" dataKey="gasto" name="Gasto" stroke="#3B82F6" fill="url(#gGasto)" strokeWidth={2} dot={false} />
              {hasSalesDailyData && (
                <Line yAxisId="brl" type="monotone" dataKey="faturamento real" name="Faturamento Real" stroke="#FB923C" strokeWidth={2} dot={false} />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ── 3b. COMPARAÇÃO MÊS ATUAL VS MÊS ANTERIOR ───────────────────────── */}
      {!loading && (
        <MoMComparisonChart allMetrics={allMetrics} salesDailyByDate={salesDailyByDate} />
      )}

      {/* ── 3c. RELATÓRIOS UNIFICADOS — blocos inteligentes ─────────────────── */}
      {account && <UnifiedMetricsPanel amazonAccountId={account.id} />}

      {/* ── 3d. METAS DE PERFORMANCE APLICADAS ──────────────────────────────── */}
      {account && (
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
      )}

      {/* ── 4. RESUMO DE PERFORMANCE ────────────────────────────────────────── */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-300">Resumo de performance</h2>
            <p className="text-[10px] text-slate-500 mt-0.5">Período: {periodLabel} · dados fechados sem o dia atual</p>
          </div>
          <PeriodSelector value={activePeriod} onChange={setPeriod} available={availablePeriods} />
        </div>
        {/* Indicador de qualidade da fonte */}
        {!loading && (
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg mb-4 text-[10px] font-medium ${
            dataQuality.quality === 'high'   ? 'bg-emerald-500/8 border border-emerald-500/15 text-emerald-400' :
            dataQuality.quality === 'medium' ? 'bg-amber-500/8 border border-amber-500/15 text-amber-400' :
            dataQuality.quality === 'low'    ? 'bg-red-500/8 border border-red-500/15 text-red-400' :
                                               'bg-surface-2 border border-surface-3 text-slate-500'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
              dataQuality.quality === 'high' ? 'bg-emerald-400' :
              dataQuality.quality === 'medium' ? 'bg-amber-400' :
              dataQuality.quality === 'low' ? 'bg-red-400' : 'bg-slate-600'
            }`} />
            <span>Fonte: {dataQuality.label}</span>
            {dataQuality.quality === 'low' && (
              <button onClick={runSync} disabled={syncingDashboard}
                className="ml-auto text-red-400 hover:text-red-300 underline whitespace-nowrap disabled:opacity-50">
                Sincronizar agora
              </button>
            )}
          </div>
        )}


        {loading ? (
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
            {Array.from({length: 9}).map((_, i) => (
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
            {hasSalesDailyData && (
              <KpiCard label="Fat. Real (SP-API)" value={fmtBRL(realSalesKpis.revenue)}
                sub={`${realSalesKpis.units} unidades`}
                tone={realSalesKpis.revenue > 0 ? 'good' : 'default'} />
            )}
            {hasSalesDailyData && realSalesKpis.tacos !== null && (
              <KpiCard label="TACoS Real"
                value={`${realSalesKpis.tacos.toFixed(1)}%`}
                sub={targetTacos > 0 ? `Meta: ${targetTacos}%` : 'Gasto Ads / Fat. Real'}
                tone={realSalesKpis.tacos > (autopilotConfig?.maximum_tacos || 15) ? 'bad' : realSalesKpis.tacos > (autopilotConfig?.target_tacos || 10) ? 'warn' : 'good'} />
            )}
            {monthProjection && (
              <KpiCard label="Projeção do Mês"
                value={fmtBRL(monthProjection.projected)}
                sub={`${monthProjection.completedPct}% concluído · ${fmtBRL(monthProjection.avgPerDay)}/dia`}
                tone="cyan" />
            )}
          </div>
        )}
      </div>



      {/* ── 5b. CARDS COMPLEMENTARES ─────────────────────────────────────────── */}
      {!loading && (
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
                          {acos > 0 && <span className={`text-[10px] font-semibold ${acosColor}`}>{acos.toFixed(1)}%</span>}
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
      )}

      {/* ── 6. ORÇAMENTO E PACING ────────────────────────────────────────────── */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-slate-300">Orçamento e pacing</h2>
          {officialDailyLimit === 0 && (
            <Link to="/settings" className="text-xs text-amber-400 hover:underline">Configurar limite →</Link>
          )}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <KpiCard label="Limite diário geral" value={officialDailyLimit > 0 ? fmtBRL(officialDailyLimit) : '—'} tone="cyan" />
          <KpiCard label="Gasto D-1 (ontem)" value={fmtBRL(spendYesterday)}
            sub={officialDailyLimit > 0 ? `${Math.round(spendYesterday / officialDailyLimit * 100)}% do limite` : undefined}
            tone={officialDailyLimit > 0 && spendYesterday > officialDailyLimit ? 'bad' : 'default'} />
          <KpiCard label="Média diária" value={fmtBRL(avgDailySpend)} sub={`Período: ${periodLabel}`} />
          <KpiCard label="Campanhas ativas" value={active_count} sub={`${paused_count} pausadas`} />
        </div>
        {officialDailyLimit > 0 && spendYesterday > 0 && (
          <div>
            <div className="flex justify-between text-[10px] text-slate-500 mb-1">
              <span>Pacing D-1: {fmtBRL(spendYesterday)} / {fmtBRL(officialDailyLimit)}</span>
              <span className={`font-semibold ${spendYesterday > officialDailyLimit ? 'text-red-400' : 'text-emerald-400'}`}>
                {Math.round(spendYesterday / officialDailyLimit * 100)}%
              </span>
            </div>
            <div className="h-1.5 bg-surface-3 rounded-full overflow-hidden">
              <div className={`h-full rounded-full transition-all ${spendYesterday > officialDailyLimit ? 'bg-red-500' : 'bg-emerald-500'}`}
                style={{ width: `${Math.min(100, spendYesterday / officialDailyLimit * 100)}%` }} />
            </div>
          </div>
        )}
        {budgetCfg?.next_weekly_recalculation && (
          <p className="text-[10px] text-slate-600 mt-2">
            Próximo recálculo: {new Date(budgetCfg.next_weekly_recalculation).toLocaleDateString('pt-BR')}
          </p>
        )}
      </div>

      {/* ── 7. METAS VS REALIDADE ────────────────────────────────────────────── */}
      {(targetAcos > 0 || targetRoas > 0 || targetTacos > 0) && (
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-300">Metas vs realidade</h2>
            <span className="text-[10px] text-slate-500">Período: {periodLabel}</span>
          </div>
          <div className="space-y-0">
            <GoalRow label="ACoS" real={kpis.acos} target={targetAcos} unit="%" lowerIsBetter />
            {maxAcos > 0 && <GoalRow label="ACoS máximo" real={kpis.acos} target={maxAcos} unit="%" lowerIsBetter />}
            <GoalRow label="ROAS" real={kpis.roas} target={targetRoas} unit="x" lowerIsBetter={false} realLabel={kpis.roas > 0 ? `${kpis.roas.toFixed(2)}x` : '—'} />
            <GoalRow label="TACoS real" real={realSalesKpis.tacos || 0} target={targetTacos} unit="%" lowerIsBetter realLabel={realSalesKpis.tacos !== null ? `${realSalesKpis.tacos.toFixed(1)}%` : '—'} />
            {targetCpc > 0 && <GoalRow label="CPC alvo" real={kpis.cpc} target={targetCpc} unit="" lowerIsBetter realLabel={kpis.cpc > 0 ? fmtBRL(kpis.cpc) : '—'} />}
            {maxCpc > 0 && <GoalRow label="CPC máximo" real={kpis.cpc} target={maxCpc} unit="" lowerIsBetter realLabel={kpis.cpc > 0 ? fmtBRL(kpis.cpc) : '—'} />}
            {officialDailyLimit > 0 && <GoalRow label="Budget D-1" real={spendYesterday} target={officialDailyLimit} unit="" lowerIsBetter realLabel={fmtBRL(spendYesterday)} />}
          </div>
          {!targetAcos && !targetRoas && !targetTacos && (
            <p className="text-xs text-slate-500">
              Nenhuma meta configurada. <Link to="/settings" className="text-cyan hover:underline">Configurar →</Link>
            </p>
          )}
        </div>
      )}

      {/* ── 8. RESUMO DE DECISÕES ────────────────────────────────────────────── */}
      {(decisions.length > 0 || allDecisions.length > 0 || bidChanges.length > 0) && (() => {
        const total = allDecisions.length;
        const executed = allDecisions.filter(d => d.status === 'executed' || d.status === 'approved').length;
        const failed = allDecisions.filter(d => d.status === 'failed' || d.status === 'error').length;
        const pending = allDecisions.filter(d => d.status === 'pending').length;
        const pctExecuted = total > 0 ? Math.round(executed / total * 100) : 0;
        const pctFailed = total > 0 ? Math.round(failed / total * 100) : 0;
        const pctPending = total > 0 ? Math.round(pending / total * 100) : 0;
        return (
          <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-slate-300">Decisões e automação</h2>
              <Link to="/sala-de-comando" className="text-xs text-cyan hover:underline">Sala de Controle →</Link>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-surface-2 rounded-lg p-3">
                <p className="text-[10px] text-slate-500 mb-1">Implementadas</p>
                <p className="text-xl font-bold text-emerald-400">{executed}</p>
                <p className="text-[10px] text-slate-600 mt-0.5">{pctExecuted}% do total</p>
              </div>
              <div className="bg-surface-2 rounded-lg p-3">
                <p className="text-[10px] text-slate-500 mb-1">Com erro</p>
                <p className={`text-xl font-bold ${failed > 0 ? 'text-red-400' : 'text-emerald-400'}`}>{failed}</p>
                <p className="text-[10px] text-slate-600 mt-0.5">{pctFailed}% do total</p>
              </div>
              <div className="bg-surface-2 rounded-lg p-3">
                <p className="text-[10px] text-slate-500 mb-1">Pendentes</p>
                <p className={`text-xl font-bold ${pending > 0 ? 'text-amber-400' : 'text-slate-400'}`}>{pending}</p>
                <p className="text-[10px] text-slate-600 mt-0.5">{pctPending}% do total</p>
              </div>
              <div className="bg-surface-2 rounded-lg p-3">
                <p className="text-[10px] text-slate-500 mb-1">Ajustes de bid (30d)</p>
                <p className="text-xl font-bold text-white">{totalChanges}</p>
                <p className="text-[10px] text-slate-600 mt-0.5">AdsBidChangeLog</p>
              </div>
            </div>
          </div>
        );
      })()}

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