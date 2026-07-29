import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Area, Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import { base44 } from '@/api/base44Client';

const RANGE_DAYS = 90;
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

function offsetFrom(date, days) {
  if (!date) return null;
  const reference = new Date(`${date}T12:00:00-03:00`);
  reference.setUTCDate(reference.getUTCDate() + days);
  return reference.toISOString().slice(0, 10);
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

// Mantém o mesmo critério do Dashboard anterior: primeiro registro por campanha/data.
function dedupeMetrics(records) {
  const unique = new Map();
  for (const item of records || []) {
    if (!item?.date) continue;
    const key = `${item.amazon_account_id || ''}:${item.campaign_id || ''}:${item.date}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  return Array.from(unique.values());
}

function brDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload || {};
  const number = (value) => value == null ? '—' : Number(value).toLocaleString('pt-BR');
  return (
    <div className="bg-[#111318] border border-surface-3 rounded-lg p-3 text-[11px] shadow-xl min-w-52">
      <div className="flex items-center justify-between gap-3 mb-2"><strong>{label}</strong><span className="text-[9px] text-slate-500">{row.sourceLabel}</span></div>
      <div className="space-y-1">
        <p className="flex justify-between gap-4"><span className="text-slate-500">Gasto Ads</span><strong>{row.gasto == null ? '—' : fmtBRL(row.gasto)}</strong></p>
        <p className="flex justify-between gap-4"><span className="text-slate-500">Vendas Ads</span><strong>{row.vendasAds == null ? '—' : fmtBRL(row.vendasAds)}</strong></p>
        <p className="flex justify-between gap-4"><span className="text-slate-500">Faturamento real</span><strong>{row.faturamentoReal == null ? '—' : fmtBRL(row.faturamentoReal)}</strong></p>
        <p className="flex justify-between gap-4"><span className="text-slate-500">Impressões</span><strong>{number(row.impressoes)}</strong></p>
        <p className="flex justify-between gap-4"><span className="text-slate-500">Cliques</span><strong>{number(row.cliques)}</strong></p>
        <p className="flex justify-between gap-4"><span className="text-slate-500">Alterações IA</span><strong>{number(row.alteracoes || 0)}</strong></p>
      </div>
    </div>
  );
}

export default function LivePerformanceChart() {
  const [state, setState] = useState({ loading: true, refreshing: false, error: null, data: null, loadedAt: null });
  const [syncMessage, setSyncMessage] = useState(null);

  const load = useCallback(async ({ silent = false } = {}) => {
    setState((current) => ({ ...current, loading: silent ? current.loading : !current.data, refreshing: silent }));
    try {
      let accounts = await base44.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_date', 5);
      if (!accounts.length) accounts = await base44.entities.AmazonAccount.list('-updated_date', 5);
      const account = accounts[0];
      if (!account) throw new Error('Nenhuma conta Amazon conectada.');
      const since = brazilDate(-(RANGE_DAYS - 1));

      const [daily, hourly, sales, bidChanges, decisions] = await Promise.all([
        base44.entities.CampaignMetricsDaily.filter({ amazon_account_id: account.id, date: { $gte: since } }, '-date', 5000),
        base44.entities.UnifiedAdsMetricsHourly.filter({ amazon_account_id: account.id, date: { $gte: brazilDate(-2) } }, '-date', 8000).catch(() => []),
        base44.entities.SalesDaily.filter({ amazon_account_id: account.id, date: { $gte: since } }, '-date', 3000),
        base44.entities.AdsBidChangeLog.filter({ amazon_account_id: account.id }, '-created_at', 5000).catch(() => []),
        base44.entities.OptimizationDecision.filter({ amazon_account_id: account.id }, '-created_at', 5000).catch(() => []),
      ]);

      setState({ loading: false, refreshing: false, error: null, loadedAt: new Date(), data: { accountId: account.id, daily, hourly, sales, bidChanges, decisions } });
    } catch (error) {
      setState((current) => ({ ...current, loading: false, refreshing: false, error: error?.message || 'Falha ao atualizar o gráfico.' }));
    }
  }, []);

  const refreshBackend = useCallback(async () => {
    const accountId = state.data?.accountId;
    if (!accountId || state.refreshing) return;
    setState((current) => ({ ...current, refreshing: true }));
    setSyncMessage('Solicitando relatórios fechados e reconciliação SP‑API…');
    try {
      const response = await base44.functions.invoke('syncYesterdayClosedData', {
        amazon_account_id: accountId,
        force: true,
        trigger_type: 'live_performance_chart',
      });
      const result = response?.data || response || {};
      setSyncMessage(result.ok === false
        ? 'Atualização parcial: uma fonte falhou e será tentada novamente; dados anteriores preservados.'
        : result.report_pending
          ? 'Relatório solicitado à Amazon; o processamento continuará automaticamente.'
          : 'Fontes reconciliadas. Dados anteriores foram preservados.');
      await load({ silent: true });
    } catch (error) {
      setSyncMessage(`Falha ao solicitar atualização: ${error?.message || 'erro desconhecido'}`);
      setState((current) => ({ ...current, refreshing: false }));
    }
  }, [load, state.data?.accountId, state.refreshing]);

  useEffect(() => {
    load();
    const timer = window.setInterval(() => load({ silent: true }), REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') load({ silent: true }); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [load]);

  const derived = useMemo(() => {
    if (!state.data) return null;
    const today = brazilDate();
    const since = brazilDate(-(RANGE_DAYS - 1));
    const byDate = new Map();
    const ensure = (date) => {
      if (!byDate.has(date)) byDate.set(date, {
        isoDate: date, date: fmtDate(date), gasto: 0, vendasAds: 0,
        faturamentoReal: undefined, impressoes: 0, cliques: 0, alteracoes: 0,
        sourceLabel: date === today ? 'API intradiária' : 'Relatório diário',
      });
      return byDate.get(date);
    };

    const daily = dedupeMetrics(state.data.daily).filter((item) => item.date >= since && item.date <= today);
    for (const item of daily) {
      const row = ensure(item.date);
      row.gasto += Number(item.spend || 0);
      row.vendasAds += Number(item.sales || 0);
      row.impressoes += Number(item.impressions || 0);
      row.cliques += Number(item.clicks || 0);
      row.sourceLabel = 'Relatório Amazon Ads';
    }

    const hasClosedToday = daily.some((item) => item.date === today);
    if (!hasClosedToday) {
      const hourlyKeys = new Set();
      for (const item of state.data.hourly || []) {
        if (item.date !== today) continue;
        const key = `${item.campaign_id || ''}:${item.hour}`;
        if (hourlyKeys.has(key)) continue;
        hourlyKeys.add(key);
        const row = ensure(today);
        row.gasto += Number(item.cost || item.spend || 0);
        row.vendasAds += Number(item.sales || 0);
        row.impressoes += Number(item.impressions || 0);
        row.cliques += Number(item.clicks || 0);
        row.sourceLabel = 'API Ads intradiária';
      }
    }

    // Preserva a mesma soma do gráfico anterior, inclusive registros por ASIN.
    for (const item of state.data.sales || []) {
      if (!item.date || item.date < since || item.date > today) continue;
      const row = ensure(item.date);
      const revenue = item.finance_sync_status === 'synced' && Number(item.gross_revenue || 0) > 0
        ? Number(item.gross_revenue || 0)
        : Number(item.ordered_product_sales || 0);
      row.faturamentoReal = Number(row.faturamentoReal || 0) + revenue;
    }

    // Os motores atuais persistem ações em duas entidades. Somamos somente
    // execuções reais e eliminamos decisões que já possuem log correspondente.
    const changesByDate = new Map();
    const loggedDecisionIds = new Set();
    for (const item of state.data.bidChanges || []) {
      const status = String(item.status || '').toLowerCase();
      if (status && !['executed', 'success', 'completed'].includes(status)) continue;
      if (item.decision_id) loggedDecisionIds.add(String(item.decision_id));
      const date = brDateTime(item.executed_at || item.changed_at || item.created_at || item.created_date);
      if (!date) continue;
      changesByDate.set(date, (changesByDate.get(date) || 0) + 1);
    }
    const seenDecisions = new Set();
    for (const item of state.data.decisions || []) {
      if (String(item.status || '').toLowerCase() !== 'executed') continue;
      if (loggedDecisionIds.has(String(item.id))) continue;
      const identity = String(item.id || item.idempotency_key || '');
      if (identity && seenDecisions.has(identity)) continue;
      if (identity) seenDecisions.add(identity);
      const date = brDateTime(item.executed_at || item.queue_processed_at || item.updated_at || item.created_at || item.created_date);
      if (!date) continue;
      changesByDate.set(date, (changesByDate.get(date) || 0) + 1);
    }
    for (const [date, count] of changesByDate) {
      if (date < since || date > today) continue;
      ensure(date).alteracoes = count;
    }

    const chartData = Array.from(byDate.values()).sort((a, b) => a.isoDate.localeCompare(b.isoDate));
    const adsDates = daily.map((item) => item.date).filter(Boolean).sort();
    const salesDates = (state.data.sales || []).map((item) => item.date).filter(Boolean).sort();
    const lastAdsDate = adsDates.at(-1) || null;
    const lastSpDate = salesDates.at(-1) || null;
    const aiDates = Array.from(changesByDate.keys()).filter((date) => date <= today).sort();
    const lastAiDate = aiDates.at(-1) || null;
    const adsStart = offsetFrom(lastAdsDate, -6);
    const spStart = offsetFrom(lastSpDate, -6);

    const totals = chartData.reduce((acc, row) => {
      if (lastAdsDate && row.isoDate >= adsStart && row.isoDate <= lastAdsDate) {
        acc.gasto += Number(row.gasto || 0);
        acc.vendas += Number(row.vendasAds || 0);
        acc.alteracoes += Number(row.alteracoes || 0);
      }
      if (lastSpDate && row.isoDate >= spStart && row.isoDate <= lastSpDate) acc.real += Number(row.faturamentoReal || 0);
      return acc;
    }, { gasto: 0, vendas: 0, real: 0, alteracoes: 0 });

    return { chartData, lastAdsDate, lastSpDate, lastAiDate, totals, today };
  }, [state.data]);

  if (state.loading) return <div className="bg-surface-1 border border-surface-2 rounded-xl h-72 flex items-center justify-center"><Loader2 className="w-5 h-5 text-cyan animate-spin" /></div>;
  if (!derived) return <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-4 text-xs text-red-300 flex items-center gap-2"><AlertCircle className="w-4 h-4" />{state.error || 'Dados indisponíveis.'}</div>;

  const { chartData, lastAdsDate, lastSpDate, lastAiDate, totals, today } = derived;
  const adsCurrent = lastAdsDate === brazilDate(-1);
  const spCurrent = lastSpDate && lastSpDate >= brazilDate(-2);
  const aiCurrent = lastAiDate && lastAiDate >= brazilDate(-1);

  return (
    <section className="bg-surface-1 border border-surface-2 rounded-xl p-5" data-live-performance-chart="true">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
        <div><h2 className="text-sm font-semibold text-slate-300">Gasto · Vendas · Faturamento Real</h2><p className="text-[10px] text-slate-500 mt-0.5">Histórico completo de 90 dias · relatório diário + API Ads intradiária + faturamento SP‑API · atualização automática a cada 10 minutos</p></div>
        <button onClick={refreshBackend} disabled={state.refreshing} className="flex items-center gap-1.5 text-[10px] text-slate-400 hover:text-white border border-surface-3 rounded-lg px-2 py-1.5 disabled:opacity-50"><RefreshCw className={`w-3 h-3 ${state.refreshing ? 'animate-spin' : ''}`} />Atualizar agora</button>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] mb-3">
        <span className={adsCurrent ? 'text-emerald-400' : 'text-amber-400'}>Ads até {fmtDateFull(lastAdsDate)}</span>
        <span className={spCurrent ? 'text-emerald-400' : 'text-amber-400'}>SP‑API até {fmtDateFull(lastSpDate)}</span>
        <span className={aiCurrent ? 'text-emerald-400' : 'text-amber-400'}>IA até {fmtDateFull(lastAiDate)}</span>
        <span className="text-slate-500">Hoje {fmtDateFull(today)}: API intradiária</span>
        <span className="text-slate-600">Tela atualizada {state.loadedAt?.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
        {state.error ? <span className="text-red-400">Última tentativa: {state.error}</span> : null}
        {syncMessage ? <span className="text-cyan-400">{syncMessage}</span> : null}
      </div>

      <div className="flex flex-wrap gap-4 text-[10px] mb-3">
        <span className="text-blue-400">Gasto 7d fechados: <strong>{fmtBRL(totals.gasto)}</strong></span>
        <span className="text-emerald-400">Vendas Ads 7d fechados: <strong>{fmtBRL(totals.vendas)}</strong></span>
        <span className="text-orange-400">Faturamento real 7d fechados: <strong>{fmtBRL(totals.real)}</strong></span>
        <span className="text-amber-400">Alterações IA: <strong>{totals.alteracoes}</strong></span>
      </div>

      <ResponsiveContainer width="100%" height={250}>
        <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <defs><linearGradient id="liveSpend" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#3B82F6" stopOpacity={0.25} /><stop offset="95%" stopColor="#3B82F6" stopOpacity={0} /></linearGradient><linearGradient id="liveSales" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#10B981" stopOpacity={0.25} /><stop offset="95%" stopColor="#10B981" stopOpacity={0} /></linearGradient></defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
          <XAxis dataKey="date" tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
          <YAxis yAxisId="brl" tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false} width={44} tickFormatter={(value) => value >= 1000 ? `${Math.round(value / 1000)}k` : value} />
          <YAxis yAxisId="volume" orientation="right" tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false} width={38} tickFormatter={(value) => value >= 1000 ? `${Math.round(value / 1000)}k` : value} />
          <YAxis yAxisId="actions" orientation="right" hide />
          <Tooltip content={<ChartTooltip />} />
          <Bar yAxisId="volume" dataKey="impressoes" name="Impressões" fill="#8B5CF6" opacity={0.28} />
          <Bar yAxisId="volume" dataKey="cliques" name="Cliques" fill="#38BDF8" opacity={0.65} />
          <Bar yAxisId="actions" dataKey="alteracoes" name="Alterações IA" fill="#F59E0B" opacity={0.75} />
          <Area yAxisId="brl" type="monotone" dataKey="vendasAds" name="Vendas Ads" stroke="#10B981" fill="url(#liveSales)" strokeWidth={2} dot={false} connectNulls />
          <Area yAxisId="brl" type="monotone" dataKey="gasto" name="Gasto Ads" stroke="#3B82F6" fill="url(#liveSpend)" strokeWidth={2} dot={false} connectNulls />
          <Line yAxisId="brl" type="monotone" dataKey="faturamentoReal" name="Faturamento real" stroke="#FB923C" strokeWidth={2.2} dot={false} connectNulls />
        </ComposedChart>
      </ResponsiveContainer>
      <p className="text-[9px] text-slate-600 mt-2">Totais de cada fonte são calculados pelos sete dias encerrados na última data disponível dessa própria fonte; a API intradiária não substitui o relatório fechado.</p>
    </section>
  );
}
