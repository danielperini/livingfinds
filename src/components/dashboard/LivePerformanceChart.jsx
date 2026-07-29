import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Area, Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import { base44 } from '@/api/base44Client';

const RANGE_DAYS = 60;
const REFRESH_MS = 10 * 60 * 1000;

function brazilDate(offsetDays = 0) {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const reference = new Date(`${today}T12:00:00-03:00`);
  reference.setUTCDate(reference.getUTCDate() + offsetDays);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(reference);
}

function dateRange(days = RANGE_DAYS) {
  const result = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) result.push(brazilDate(-offset));
  return result;
}

function fmtDate(date) {
  const [, month, day] = String(date || '').split('-');
  return day && month ? `${day}/${month}` : date;
}

function fmtDateFull(date) {
  const [year, month, day] = String(date || '').split('-');
  return day && month && year ? `${day}/${month}/${year}` : '—';
}

function fmtBRL(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency', currency: 'BRL', minimumFractionDigits: 2,
  }).format(Number(value || 0));
}

function latestByKey(records, keyOf) {
  const result = new Map();
  for (const record of records || []) {
    const key = keyOf(record);
    if (!key) continue;
    const previous = result.get(key);
    const currentTime = new Date(record.updated_date || record.synced_at || record.created_date || 0).getTime();
    const previousTime = previous
      ? new Date(previous.updated_date || previous.synced_at || previous.created_date || 0).getTime()
      : -1;
    if (!previous || currentTime >= previousTime) result.set(key, record);
  }
  return Array.from(result.values());
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload || {};
  return (
    <div className="bg-[#111318] border border-surface-3 rounded-lg p-3 text-[11px] shadow-xl min-w-52">
      <div className="flex items-center justify-between gap-3 mb-2">
        <strong className="text-slate-200">{label}</strong>
        <span className="text-[9px] text-slate-500">{row.sourceLabel}</span>
      </div>
      <div className="space-y-1">
        <p className="flex justify-between gap-4"><span className="text-slate-500">Gasto Ads</span><strong>{row.gasto == null ? '—' : fmtBRL(row.gasto)}</strong></p>
        <p className="flex justify-between gap-4"><span className="text-slate-500">Vendas Ads</span><strong>{row.vendasAds == null ? '—' : fmtBRL(row.vendasAds)}</strong></p>
        <p className="flex justify-between gap-4"><span className="text-slate-500">Faturamento real</span><strong>{row.faturamentoReal == null ? '—' : fmtBRL(row.faturamentoReal)}</strong></p>
        <p className="flex justify-between gap-4"><span className="text-slate-500">Impressões</span><strong>{row.impressoes == null ? '—' : row.impressoes.toLocaleString('pt-BR')}</strong></p>
        <p className="flex justify-between gap-4"><span className="text-slate-500">Cliques</span><strong>{row.cliques == null ? '—' : row.cliques.toLocaleString('pt-BR')}</strong></p>
        <p className="flex justify-between gap-4"><span className="text-slate-500">Alterações IA</span><strong>{row.alteracoes || 0}</strong></p>
      </div>
    </div>
  );
}

export default function LivePerformanceChart() {
  const [state, setState] = useState({ loading: true, refreshing: false, error: null, data: null, loadedAt: null });

  const load = useCallback(async ({ silent = false } = {}) => {
    setState((current) => ({ ...current, loading: silent ? current.loading : !current.data, refreshing: silent }));
    try {
      let accounts = await base44.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_date', 5);
      if (!accounts.length) accounts = await base44.entities.AmazonAccount.list('-updated_date', 5);
      const account = accounts[0];
      if (!account) throw new Error('Nenhuma conta Amazon conectada.');

      const [daily, hourly, sales, decisions] = await Promise.all([
        base44.entities.CampaignMetricsDaily.filter({ amazon_account_id: account.id }, '-date', 8000),
        base44.entities.UnifiedAdsMetricsHourly.filter({ amazon_account_id: account.id }, '-date', 8000).catch(() => []),
        base44.entities.SalesDaily.filter({ amazon_account_id: account.id }, '-date', 8000),
        base44.entities.OptimizationDecision.filter({ amazon_account_id: account.id }, '-created_at', 3000),
      ]);

      setState({
        loading: false, refreshing: false, error: null, loadedAt: new Date(),
        data: { daily, hourly, sales, decisions },
      });
    } catch (error) {
      setState((current) => ({
        ...current, loading: false, refreshing: false,
        error: error?.message || 'Falha ao atualizar o gráfico.',
      }));
    }
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(() => load({ silent: true }), REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') load({ silent: true }); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const derived = useMemo(() => {
    if (!state.data) return null;
    const today = brazilDate();
    const dates = dateRange();
    const allowed = new Set(dates);
    const rows = new Map(dates.map((date) => [date, {
      isoDate: date, date: fmtDate(date), gasto: null, vendasAds: null,
      faturamentoReal: null, impressoes: null, cliques: null, alteracoes: 0,
      sourceLabel: date === today ? 'API intradiária' : 'Relatório diário',
    }]));

    const daily = latestByKey(state.data.daily, (item) =>
      item?.date ? `${item.amazon_account_id || ''}:${item.campaign_id || ''}:${item.date}` : null
    );
    for (const item of daily) {
      if (!allowed.has(item.date)) continue;
      const row = rows.get(item.date);
      row.gasto = Number(row.gasto || 0) + Number(item.spend || 0);
      row.vendasAds = Number(row.vendasAds || 0) + Number(item.sales || 0);
      row.impressoes = Number(row.impressoes || 0) + Number(item.impressions || 0);
      row.cliques = Number(row.cliques || 0) + Number(item.clicks || 0);
      row.sourceLabel = 'Relatório Amazon Ads';
    }

    const hourly = latestByKey(state.data.hourly, (item) =>
      item?.date ? `${item.amazon_account_id || ''}:${item.campaign_id || ''}:${item.date}:${item.hour}` : null
    );
    const todayHourly = hourly.filter((item) => item.date === today);
    if (todayHourly.length && rows.get(today)?.gasto == null) {
      const row = rows.get(today);
      row.gasto = todayHourly.reduce((sum, item) => sum + Number(item.cost || item.spend || 0), 0);
      row.vendasAds = todayHourly.reduce((sum, item) => sum + Number(item.sales || 0), 0);
      row.impressoes = todayHourly.reduce((sum, item) => sum + Number(item.impressions || 0), 0);
      row.cliques = todayHourly.reduce((sum, item) => sum + Number(item.clicks || 0), 0);
      row.sourceLabel = 'API Ads intradiária';
    }

    const sales = latestByKey(state.data.sales, (item) =>
      item?.date ? `${item.amazon_account_id || ''}:${item.asin || item.sku || item.id}:${item.date}` : null
    );
    for (const item of sales) {
      if (!allowed.has(item.date)) continue;
      const row = rows.get(item.date);
      const revenue = item.finance_sync_status === 'synced' && Number(item.gross_revenue || 0) > 0
        ? Number(item.gross_revenue || 0)
        : Number(item.ordered_product_sales || 0);
      row.faturamentoReal = Number(row.faturamentoReal || 0) + revenue;
    }

    for (const item of state.data.decisions || []) {
      if (!['executed', 'approved'].includes(String(item.status || '').toLowerCase())) continue;
      const raw = item.executed_at || item.created_at || item.created_date;
      if (!raw) continue;
      const date = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(raw));
      if (allowed.has(date)) rows.get(date).alteracoes += 1;
    }

    const chartData = Array.from(rows.values());
    const lastAdsDate = [...new Set(daily.map((item) => item.date).filter(Boolean))].sort().at(-1) || null;
    const lastSpDate = [...new Set(sales.map((item) => item.date).filter(Boolean))].sort().at(-1) || null;
    const latestSeven = chartData.slice(-7);
    const totals = latestSeven.reduce((acc, row) => ({
      gasto: acc.gasto + Number(row.gasto || 0),
      vendas: acc.vendas + Number(row.vendasAds || 0),
      real: acc.real + Number(row.faturamentoReal || 0),
      alteracoes: acc.alteracoes + Number(row.alteracoes || 0),
    }), { gasto: 0, vendas: 0, real: 0, alteracoes: 0 });

    return { chartData, lastAdsDate, lastSpDate, totals, today };
  }, [state.data]);

  if (state.loading) {
    return <div className="bg-surface-1 border border-surface-2 rounded-xl h-72 flex items-center justify-center"><Loader2 className="w-5 h-5 text-cyan animate-spin" /></div>;
  }

  if (!derived) {
    return <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-4 text-xs text-red-300 flex items-center gap-2"><AlertCircle className="w-4 h-4" />{state.error || 'Dados indisponíveis.'}</div>;
  }

  const { chartData, lastAdsDate, lastSpDate, totals, today } = derived;
  const adsCurrent = lastAdsDate === brazilDate(-1);
  const spCurrent = lastSpDate && lastSpDate >= brazilDate(-2);

  return (
    <section className="bg-surface-1 border border-surface-2 rounded-xl p-5" data-live-performance-chart="true">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-300">Gasto · Vendas · Faturamento Real</h2>
          <p className="text-[10px] text-slate-500 mt-0.5">Relatório diário + API Ads intradiária + faturamento SP‑API · atualização automática a cada 10 minutos</p>
        </div>
        <button onClick={() => load({ silent: true })} disabled={state.refreshing}
          className="flex items-center gap-1.5 text-[10px] text-slate-400 hover:text-white border border-surface-3 rounded-lg px-2 py-1.5 disabled:opacity-50">
          <RefreshCw className={`w-3 h-3 ${state.refreshing ? 'animate-spin' : ''}`} />Atualizar agora
        </button>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] mb-3">
        <span className={adsCurrent ? 'text-emerald-400' : 'text-amber-400'}>Ads até {fmtDateFull(lastAdsDate)}</span>
        <span className={spCurrent ? 'text-emerald-400' : 'text-amber-400'}>SP‑API até {fmtDateFull(lastSpDate)}</span>
        <span className="text-slate-500">Hoje {fmtDateFull(today)}: API intradiária</span>
        <span className="text-slate-600">Tela atualizada {state.loadedAt?.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
        {state.error ? <span className="text-red-400">Última tentativa: {state.error}</span> : null}
      </div>

      <div className="flex flex-wrap gap-4 text-[10px] mb-3">
        <span className="text-blue-400">Gasto 7d: <strong>{fmtBRL(totals.gasto)}</strong></span>
        <span className="text-emerald-400">Vendas Ads 7d: <strong>{fmtBRL(totals.vendas)}</strong></span>
        <span className="text-orange-400">Faturamento real 7d: <strong>{fmtBRL(totals.real)}</strong></span>
        <span className="text-amber-400">Alterações IA 7d: <strong>{totals.alteracoes}</strong></span>
      </div>

      <ResponsiveContainer width="100%" height={250}>
        <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="liveSpend" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#3B82F6" stopOpacity={0.25} /><stop offset="95%" stopColor="#3B82F6" stopOpacity={0} /></linearGradient>
            <linearGradient id="liveSales" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#10B981" stopOpacity={0.25} /><stop offset="95%" stopColor="#10B981" stopOpacity={0} /></linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
          <XAxis dataKey="date" tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
          <YAxis yAxisId="brl" tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false} width={44} tickFormatter={(value) => value >= 1000 ? `${Math.round(value / 1000)}k` : value} />
          <YAxis yAxisId="volume" orientation="right" tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false} width={38} tickFormatter={(value) => value >= 1000 ? `${Math.round(value / 1000)}k` : value} />
          <YAxis yAxisId="actions" orientation="right" hide />
          <Tooltip content={<ChartTooltip />} />
          <Bar yAxisId="volume" dataKey="impressoes" name="Impressões" fill="#8B5CF6" opacity={0.28} />
          <Bar yAxisId="volume" dataKey="cliques" name="Cliques" fill="#38BDF8" opacity={0.65} />
          <Bar yAxisId="actions" dataKey="alteracoes" name="Alterações IA" fill="#F59E0B" opacity={0.75} />
          <Area yAxisId="brl" type="monotone" dataKey="vendasAds" name="Vendas Ads" stroke="#10B981" fill="url(#liveSales)" strokeWidth={2} connectNulls={false} />
          <Area yAxisId="brl" type="monotone" dataKey="gasto" name="Gasto Ads" stroke="#3B82F6" fill="url(#liveSpend)" strokeWidth={2} connectNulls={false} />
          <Line yAxisId="brl" type="monotone" dataKey="faturamentoReal" name="Faturamento real" stroke="#FB923C" strokeWidth={2.2} dot={false} connectNulls={false} />
        </ComposedChart>
      </ResponsiveContainer>

      <p className="text-[9px] text-slate-600 mt-2">Dias sem fonte confirmada permanecem como lacuna; o gráfico não inventa zero. O relatório fechado prevalece e a API intradiária completa somente o dia atual.</p>
    </section>
  );
}
