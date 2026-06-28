import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { xanoRequest, toArray } from '@/lib/useXano';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { BarChart2, Loader2, TrendingUp, TrendingDown, Minus, RefreshCw, AlertCircle } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import { Link } from 'react-router-dom';

function KPICard({ card, loading }) {
  if (loading) {
    return (
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-5 animate-pulse">
        <div className="h-3 w-24 bg-surface-3 rounded mb-3" />
        <div className="h-7 w-32 bg-surface-3 rounded mb-2" />
        <div className="h-3 w-16 bg-surface-3 rounded" />
      </div>
    );
  }
  const pct = card.change_percent ?? 0;
  const colorClass = card.inverse_trend
    ? (pct < 0 ? 'text-emerald-400' : pct > 0 ? 'text-red-400' : 'text-slate-400')
    : (pct > 0 ? 'text-emerald-400' : pct < 0 ? 'text-red-400' : 'text-slate-400');
  const TrendIcon = pct > 0 ? TrendingUp : pct < 0 ? TrendingDown : Minus;
  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
      <p className="text-xs font-medium text-slate-400 mb-2">{card.label}</p>
      <p className="text-2xl font-bold text-white mb-1">
        {card.unit === 'BRL' || card.unit === 'R$' ? 'R$ ' : ''}{card.value}{card.unit === '%' ? '%' : ''}
      </p>
      {pct !== 0 && (
        <div className={`flex items-center gap-1 text-xs font-semibold ${colorClass}`}>
          <TrendIcon className="w-3 h-3" />
          {pct > 0 ? '+' : ''}{Number(pct).toFixed(1)}% vs período anterior
        </div>
      )}
    </div>
  );
}

function SyncActionButton({ label, path, onDone }) {
  const [state, setState] = useState('idle');
  const [result, setResult] = useState(null);

  const run = async () => {
    setState('loading');
    setResult(null);
    try {
      const data = await xanoRequest('POST', path);
      setState('success');
      setResult(data);
      onDone?.();
      setTimeout(() => setState('idle'), 4000);
    } catch (err) {
      setState('error');
      setResult({ error: err.message });
      setTimeout(() => setState('idle'), 5000);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={run}
        disabled={state === 'loading'}
        className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold transition-all ${
          state === 'success' ? 'bg-emerald-600/20 border border-emerald-600/30 text-emerald-400' :
          state === 'error' ? 'bg-red-600/20 border border-red-600/30 text-red-400' :
          'bg-surface-2 border border-surface-3 text-slate-300 hover:text-white'
        } disabled:opacity-60`}
      >
        <RefreshCw className={`w-3.5 h-3.5 ${state === 'loading' ? 'animate-spin' : ''}`} />
        {state === 'loading' ? 'Executando...' : state === 'success' ? 'Concluído!' : state === 'error' ? 'Erro' : label}
      </button>
      {result && state !== 'idle' && (
        <div className={`text-xs px-2 py-1 rounded ${state === 'success' ? 'text-emerald-400' : 'text-red-400'}`}>
          {state === 'success'
            ? `✓ ${result.records_imported ?? result.records_read ?? ''} importados${result.errors_count ? ` · ${result.errors_count} erros` : ''}`
            : result.error}
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const [user, setUser] = useState(null);
  const [account, setAccount] = useState(null);
  const [kpiCards, setKpiCards] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [dailyMetrics, setDailyMetrics] = useState([]);
  const [xanoLogs, setXanoLogs] = useState([]);
  const [decisions, setDecisions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await base44.auth.me();
      setUser(me);
      const [accounts, decs] = await Promise.all([
        base44.entities.AmazonAccount.filter({ user_id: me.id }),
        base44.entities.Decision.filter({ status: 'pending' }),
      ]);
      setAccount(accounts[0] || null);
      setDecisions(decs);

      const today = new Date().toISOString().slice(0, 10);
      const start = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

      const [xDashboard, xProds, xMetrics] = await Promise.allSettled([
        xanoRequest('GET', '/amazon/dashboard'),
        xanoRequest('GET', '/amazon/products'),
        xanoRequest('GET', '/amazon/metrics/daily_summary'),
      ]);

      // KPIs do dashboard
      if (xDashboard.status === 'fulfilled') {
        const d = xDashboard.value?.data || xDashboard.value || {};
        const acos = d.acos || (d.spend > 0 && d.revenue > 0 ? (d.spend / d.revenue * 100) : 0);
        const roas = d.roas || (d.spend > 0 ? (d.revenue / d.spend) : 0);
        setKpiCards([
          { label: 'Receita', value: Number(d.revenue || 0).toFixed(2), unit: 'BRL' },
          { label: 'Ad Spend', value: Number(d.spend || 0).toFixed(2), unit: 'BRL' },
          { label: 'ACoS', value: Number(acos).toFixed(1), unit: '%', inverse_trend: true },
          { label: 'ROAS', value: Number(roas).toFixed(2), unit: 'x' },
          { label: 'Cliques', value: Number(d.clicks || 0).toLocaleString(), unit: '' },
          { label: 'Impressões', value: Number(d.impressions || 0).toLocaleString(), unit: '' },
          { label: 'Pedidos', value: Number(d.orders || 0).toLocaleString(), unit: '' },
          { label: 'TaCoS', value: Number(d.tacos || 0).toFixed(1), unit: '%', inverse_trend: true },
        ]);
      }

      // Produtos para a tabela
      if (xProds.status === 'fulfilled') {
        const prods = toArray(xProds.value, 'data');
        setCampaigns(prods);
      }

      // Métricas diárias para o gráfico
      if (xMetrics.status === 'fulfilled') {
        const metrics = toArray(xMetrics.value, 'data');
        setDailyMetrics(metrics.slice(-14));
      }

    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const chartData = dailyMetrics.length > 0
    ? dailyMetrics.map(m => ({ name: m.date?.slice(5) || '', spend: m.spend || m.cost || 0, sales: m.sales || m.ads_sales || 0 }))
    : [];

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  const firstName = user?.full_name?.split(' ')[0] || 'gestor';

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-white">{greeting}, {firstName}.</h1>
          <p className="text-sm text-slate-400 mt-0.5">
            {decisions.length > 0 ? `${decisions.length} recomendações pendentes no Learner.` : 'Sem recomendações pendentes.'}
          </p>
        </div>
        <button onClick={loadData} disabled={loading} className="flex items-center gap-2 px-4 py-2 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-sm rounded-lg transition-colors">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Atualizar
        </button>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Sync buttons */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
        <p className="text-xs font-semibold text-slate-400 mb-3 uppercase tracking-wider">Sincronização</p>
        <div className="flex flex-wrap gap-3">
          <SyncActionButton label="Histórico 30d" path="/amazon/sync/history_30d" onDone={loadData} />
          <SyncActionButton label="Sync Mensal" path="/amazon/sync/monthly" onDone={loadData} />
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {(kpiCards.length > 0 ? kpiCards : Array(8).fill(null)).slice(0, 8).map((card, i) => (
          <KPICard key={i} card={card || {}} loading={loading || !card} />
        ))}
      </div>

      {/* Chart + Logs */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-surface-1 border border-surface-2 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-slate-300">Spend vs Sales (últimos 14 dias)</h2>
            <BarChart2 className="w-4 h-4 text-slate-500" />
          </div>
          {loading ? (
            <div className="h-48 flex items-center justify-center"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
          ) : chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={chartData} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="gSpend" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#3B82F6" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gSales" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10B981" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#10B981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ background: '#111318', border: '1px solid #1A1D26', borderRadius: 8, fontSize: 12 }} />
                <Area type="monotone" dataKey="spend" stroke="#3B82F6" fill="url(#gSpend)" strokeWidth={2} name="Spend (R$)" />
                <Area type="monotone" dataKey="sales" stroke="#10B981" fill="url(#gSales)" strokeWidth={2} name="Sales (R$)" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-48 flex items-center justify-center">
              <p className="text-sm text-slate-500">Sem dados de métricas. Execute um Sync.</p>
            </div>
          )}
        </div>

        <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-slate-300 mb-4">Logs Recentes</h2>
          <div className="space-y-3">
            {xanoLogs.length === 0 && !loading && (
              <p className="text-sm text-slate-500 text-center py-4">Sem logs recentes</p>
            )}
            {xanoLogs.map((log, i) => (
              <div key={i} className="flex items-start gap-3">
                <StatusBadge status={log.status || 'pending'} size="xs" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-slate-300 truncate">{log.operation || log.type || log.event || `Log ${i + 1}`}</p>
                  <p className="text-xs text-slate-500">{log.message || log.details || '—'}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Campaign table */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-2">
          <h2 className="text-sm font-semibold text-slate-300">Produtos</h2>
          <span className="text-xs text-slate-500">{campaigns.length} produtos</span>
        </div>
        {loading ? (
          <div className="p-8 flex items-center justify-center"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
        ) : campaigns.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm text-slate-400">Sem produtos. Execute um Sync.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-2">
                  {['ASIN', 'Título', 'SKU', 'Preço', 'Stock', 'Status'].map(h => (
                    <th key={h} className="px-5 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {campaigns.slice(0, 25).map((p, i) => (
                  <tr key={p.id || i} className="border-b border-surface-2/50 hover:bg-surface-2 transition-colors">
                    <td className="px-5 py-3 font-mono text-xs text-cyan">{p.asin || '—'}</td>
                    <td className="px-5 py-3 text-white truncate max-w-xs">{p.title || p.name || '—'}</td>
                    <td className="px-5 py-3 text-slate-400 font-mono text-xs">{p.sku || '—'}</td>
                    <td className="px-5 py-3 text-slate-300">${(p.price || 0).toFixed(2)}</td>
                    <td className="px-5 py-3">
                      <span className={`font-semibold ${(p.stock || 0) === 0 ? 'text-red-400' : (p.stock || 0) < 10 ? 'text-amber-400' : 'text-white'}`}>
                        {p.stock || 0}
                      </span>
                    </td>
                    <td className="px-5 py-3"><StatusBadge status={p.status || 'active'} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}