import { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Loader2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';

const DAYS = 30;
const TARGET_ACOS = 25;

function toDateOnly(value) {
  return value ? String(value).slice(0, 10) : '';
}

function formatDate(value) {
  const [, month, day] = String(value || '').split('-');
  return day && month ? `${day}/${month}` : value;
}

function salesRevenue(row) {
  return Number(
    row?.revenue
      ?? row?.sales
      ?? row?.ordered_product_sales
      ?? row?.orderedProductSales
      ?? row?.total_sales
      ?? 0
  );
}

function TrendTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-[#111318] border border-surface-2 rounded-lg p-3 text-xs shadow-xl">
      <p className="text-slate-400 mb-2 font-medium">{label}</p>
      {payload.map((item) => (
        <div key={item.dataKey} className="flex items-center justify-between gap-4 mb-1">
          <span className="text-slate-300">{item.name}</span>
          <span className="font-semibold text-white">
            {item.value == null ? '—' : `${Number(item.value).toFixed(1)}%`}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function AcosTacosTrendChart() {
  const [state, setState] = useState({ loading: true, error: null, metrics: [], sales: [] });

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const me = await base44.auth.me();
        let accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
        if (!accounts.length) accounts = await base44.entities.AmazonAccount.list();
        const account = accounts[0];
        if (!account) throw new Error('Conta Amazon não encontrada.');

        const cutoff = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
        const [metrics, sales] = await Promise.all([
          base44.entities.CampaignMetricsDaily.filter(
            { amazon_account_id: account.id, date: { $gte: cutoff } },
            '-date',
            5000
          ),
          base44.entities.SalesDaily.filter(
            { amazon_account_id: account.id, date: { $gte: cutoff } },
            '-date',
            2000
          ).catch(() => []),
        ]);

        if (active) setState({ loading: false, error: null, metrics, sales });
      } catch (error) {
        if (active) setState({ loading: false, error: error.message, metrics: [], sales: [] });
      }
    })();
    return () => { active = false; };
  }, []);

  const derived = useMemo(() => {
    const metricMap = new Map();
    const seenMetric = new Set();

    for (const row of state.metrics) {
      const date = toDateOnly(row.date);
      if (!date) continue;
      const key = `${row.campaign_id || 'global'}:${date}`;
      if (seenMetric.has(key)) continue;
      seenMetric.add(key);
      const current = metricMap.get(date) || { spend: 0, sales: 0 };
      current.spend += Number(row.spend || 0);
      current.sales += Number(row.sales || 0);
      metricMap.set(date, current);
    }

    const realRevenueByDate = new Map();
    const seenSales = new Set();
    for (const row of state.sales) {
      const date = toDateOnly(row.date);
      if (!date) continue;
      const key = row.id || `${date}:${row.asin || ''}:${row.sku || ''}:${salesRevenue(row)}`;
      if (seenSales.has(key)) continue;
      seenSales.add(key);
      realRevenueByDate.set(date, (realRevenueByDate.get(date) || 0) + salesRevenue(row));
    }

    const dates = [...new Set([...metricMap.keys(), ...realRevenueByDate.keys()])].sort();
    const data = dates.map((date) => {
      const ads = metricMap.get(date) || { spend: 0, sales: 0 };
      const realRevenue = Number(realRevenueByDate.get(date) || 0);
      const acos = ads.sales > 0 ? (ads.spend / ads.sales) * 100 : null;
      const tacos = realRevenue > 0 ? (ads.spend / realRevenue) * 100 : null;
      const salesSpendDeltaPct = ads.spend > 0
        ? ((ads.sales - ads.spend) / ads.spend) * 100
        : null;

      return {
        date: formatDate(date),
        acos: acos == null ? null : Number(acos.toFixed(2)),
        tacos: tacos == null ? null : Number(tacos.toFixed(2)),
        salesSpendDeltaPct: salesSpendDeltaPct == null ? null : Number(salesSpendDeltaPct.toFixed(2)),
      };
    });

    const spendTotal = [...metricMap.values()].reduce((sum, row) => sum + row.spend, 0);
    const adsSalesTotal = [...metricMap.values()].reduce((sum, row) => sum + row.sales, 0);
    const realRevenueTotal = [...realRevenueByDate.values()].reduce((sum, value) => sum + value, 0);

    return {
      data,
      currentAcos: adsSalesTotal > 0 ? (spendTotal / adsSalesTotal) * 100 : 0,
      currentTacos: realRevenueTotal > 0 ? (spendTotal / realRevenueTotal) * 100 : 0,
    };
  }, [state.metrics, state.sales]);

  if (state.loading) {
    return (
      <div className="bg-surface-1 border border-surface-2 rounded-xl h-64 flex items-center justify-center">
        <Loader2 className="w-5 h-5 text-cyan animate-spin" />
      </div>
    );
  }

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-5" data-acos-tacos-trend-chart="true">
      <h2 className="text-sm font-semibold text-slate-300 mb-1">
        Tendência de ACoS, TACoS e Diferença Vendas x Gasto (30d)
      </h2>
      <p className="text-xs text-slate-500 mb-4">
        Meta ideal de ACoS: abaixo de 25% · ACoS atual: <span className={derived.currentAcos > 40 ? 'text-red-400' : derived.currentAcos > 25 ? 'text-amber-400' : 'text-emerald-400'}>{derived.currentAcos.toFixed(1)}%</span>
        {' · '}TACoS atual: <span className="text-cyan">{derived.currentTacos > 0 ? `${derived.currentTacos.toFixed(1)}%` : '—'}</span>
      </p>

      {state.error || derived.data.length === 0 ? (
        <div className="h-48 flex items-center justify-center text-xs text-slate-500">
          {state.error || 'Sem dados suficientes para o período.'}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={230}>
          <LineChart data={derived.data} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} unit="%" />
            <Tooltip content={<TrendTooltip />} />
            <Legend wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} />
            <ReferenceLine y={TARGET_ACOS} stroke="#64748B" strokeDasharray="4 4" />
            <ReferenceLine y={0} stroke="#475569" />
            <Line type="monotone" dataKey="acos" name="ACoS" stroke="#F59E0B" strokeWidth={2} dot={false} connectNulls />
            <Line type="monotone" dataKey="tacos" name="TACoS" stroke="#22D3EE" strokeWidth={2} dot={false} connectNulls />
            <Line type="monotone" dataKey="salesSpendDeltaPct" name="Diferença Vendas x Gasto" stroke="#A78BFA" strokeWidth={2} dot={false} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      )}
      <p className="text-[10px] text-slate-500 mt-3">
        Diferença % = ((Vendas Ads − Gasto Ads) ÷ Gasto Ads) × 100. Positivo indica vendas acima do gasto; negativo indica gasto acima das vendas. TACoS usa faturamento real da SP-API.
      </p>
    </div>
  );
}
