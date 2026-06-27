import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { xanoDashboard, xanoCampaigns, isXanoAuthenticated } from '@/lib/xanoClient';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { AlertTriangle, BarChart2, Wifi, WifiOff, Loader2, ExternalLink, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import SyncButton from '@/components/ui/SyncButton';
import { Link } from 'react-router-dom';

// KPI Card com suporte a change_percent e inverse_trend
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
  const isPositive = pct > 0;
  const isNegative = pct < 0;
  // inverse_trend: menor é melhor (ex: ACoS). Verde quando desce.
  const colorClass = card.inverse_trend
    ? (isNegative ? 'text-emerald-400' : isPositive ? 'text-red-400' : 'text-slate-400')
    : (isPositive ? 'text-emerald-400' : isNegative ? 'text-red-400' : 'text-slate-400');

  const TrendIcon = pct > 0 ? TrendingUp : pct < 0 ? TrendingDown : Minus;

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
      <p className="text-xs font-medium text-slate-400 mb-2">{card.label}</p>
      <p className="text-2xl font-bold text-white mb-1">
        {card.unit === 'BRL' ? 'R$ ' : card.unit === '%' ? '' : ''}{card.value}
        {card.unit === '%' ? '%' : ''}
      </p>
      {pct !== 0 && (
        <div className={`flex items-center gap-1 text-xs font-semibold ${colorClass}`}>
          <TrendIcon className="w-3 h-3" />
          {pct > 0 ? '+' : ''}{pct.toFixed(1)}% vs período anterior
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
  const [syncRuns, setSyncRuns] = useState([]);
  const [decisions, setDecisions] = useState([]);
  const [loading, setLoading] = useState(true);
  const xanoConnected = isXanoAuthenticated();

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      setUser(me);

      const [accounts, runs, decs] = await Promise.all([
        base44.entities.AmazonAccount.filter({ user_id: me.id }),
        base44.entities.SyncRun.list('-created_date', 10),
        base44.entities.Decision.filter({ status: 'pending' }),
      ]);
      setAccount(accounts[0] || null);
      setSyncRuns(runs);
      setDecisions(decs);

      if (xanoConnected) {
        const [xCards, xCampaigns, xMetrics] = await Promise.allSettled([
          xanoDashboard.getCards(),
          xanoCampaigns.list(),
          xanoDashboard.getDailyMetrics(),
        ]);

        if (xCards.status === 'fulfilled') {
          const cards = Array.isArray(xCards.value) ? xCards.value : (xCards.value?.cards || []);
          setKpiCards(cards);
        }

        if (xCampaigns.status === 'fulfilled') {
          const list = Array.isArray(xCampaigns.value) ? xCampaigns.value : (xCampaigns.value?.campaigns || []);
          setCampaigns(list);
        }

        if (xMetrics.status === 'fulfilled') {
          const metrics = Array.isArray(xMetrics.value) ? xMetrics.value : (xMetrics.value?.metrics || []);
          setDailyMetrics(metrics.slice(-14));
        }
      } else {
        const c = await base44.entities.Campaign.list('-synced_at', 100);
        setCampaigns(c);
      }
    } catch (err) {
      console.error('Dashboard load error:', err);
    } finally {
      setLoading(false);
    }
  }, [xanoConnected]);

  useEffect(() => { loadData(); }, [loadData]);

  // Fallback KPIs calculados das campanhas quando não há cards do Xano
  const totalSpend = campaigns.reduce((s, c) => s + (c.spend || 0), 0);
  const totalSales = campaigns.reduce((s, c) => s + (c.sales || 0), 0);
  const avgAcos = totalSales > 0 ? (totalSpend / totalSales) * 100 : 0;
  const avgRoas = totalSpend > 0 ? totalSales / totalSpend : 0;

  const fallbackCards = [
    { label: 'Total Spend', value: totalSpend.toFixed(2), unit: 'BRL', change_percent: 0, trend: 'neutral' },
    { label: 'Total Sales', value: totalSales.toFixed(2), unit: 'BRL', change_percent: 0, trend: 'neutral' },
    { label: 'ACoS Médio', value: avgAcos.toFixed(1), unit: '%', change_percent: 0, trend: 'neutral', inverse_trend: true },
    { label: 'ROAS Médio', value: avgRoas.toFixed(2), unit: '', change_percent: 0, trend: 'neutral' },
  ];

  const displayCards = kpiCards.length > 0 ? kpiCards : fallbackCards;

  // Gráfico — preferir métricas diárias do Xano
  const chartData = dailyMetrics.length > 0
    ? dailyMetrics.map(m => ({ name: m.date?.slice(5) || '', spend: m.cost || m.spend || 0, sales: m.ads_sales || m.sales || 0 }))
    : campaigns.slice(0, 10).map((c, i) => ({ name: c.name?.slice(0, 10) || `C${i + 1}`, spend: c.spend || 0, sales: c.sales || 0 }));

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  const firstName = user?.full_name?.split(' ')[0] || 'gestor';

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-white">{greeting}, {firstName}.</h1>
          <p className="text-sm text-slate-400 mt-0.5">
            {decisions.length > 0
              ? `${decisions.length} recomendação${decisions.length !== 1 ? 'ões' : ''} pendente${decisions.length !== 1 ? 's' : ''} no Learner.`
              : 'Sem recomendações pendentes.'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border ${xanoConnected ? 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' : 'text-amber-400 bg-amber-400/10 border-amber-400/20'}`}>
            {xanoConnected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
            {xanoConnected ? 'Xano conectado' : 'Xano desconectado'}
          </div>
          <SyncButton amazonAccountId={account?.id} onSuccess={loadData} />
        </div>
      </div>

      {/* Banners */}
      {!xanoConnected && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0" />
            <div>
              <p className="text-sm font-semibold text-amber-300">Xano não autenticado</p>
              <p className="text-xs text-amber-400/70 mt-0.5">Liga o Xano nas Configurações para ver dados reais da Amazon.</p>
            </div>
          </div>
          <Link to="/settings" className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/30 text-amber-300 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap">
            <ExternalLink className="w-3.5 h-3.5" /> Configurar
          </Link>
        </div>
      )}
      {!account && !loading && (
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-slate-500 flex-shrink-0" />
          <p className="text-sm text-slate-400">Conta Amazon não configurada. <Link to="/settings" className="text-cyan hover:underline">Configurar →</Link></p>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {displayCards.slice(0, 4).map((card, i) => (
          <KPICard key={i} card={card} loading={loading} />
        ))}
      </div>

      {/* Chart + Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-surface-1 border border-surface-2 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-slate-300">Spend vs Sales</h2>
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
                <Tooltip contentStyle={{ background: '#111318', border: '1px solid #1A1D26', borderRadius: 8, fontSize: 12 }} labelStyle={{ color: '#94a3b8' }} />
                <Area type="monotone" dataKey="spend" stroke="#3B82F6" fill="url(#gSpend)" strokeWidth={2} name="Spend (R$)" />
                <Area type="monotone" dataKey="sales" stroke="#10B981" fill="url(#gSales)" strokeWidth={2} name="Sales (R$)" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-48 flex items-center justify-center">
              <p className="text-sm text-slate-500">Sem dados — liga o Xano ou executa um Sync</p>
            </div>
          )}
        </div>

        <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-slate-300 mb-4">Atividade Recente</h2>
          <div className="space-y-3">
            {syncRuns.length === 0 && !loading && (
              <p className="text-sm text-slate-500 text-center py-4">Sem atividade recente</p>
            )}
            {syncRuns.slice(0, 6).map(run => (
              <div key={run.id} className="flex items-start gap-3">
                <StatusBadge status={run.status} size="xs" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-slate-300 truncate">{run.operation}</p>
                  <p className="text-xs text-slate-500">{run.records_upserted || 0} registos • {run.duration_ms ? `${(run.duration_ms / 1000).toFixed(1)}s` : '—'}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Campaign table */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-2">
          <h2 className="text-sm font-semibold text-slate-300">Campanhas</h2>
          <span className="text-xs text-slate-500">{campaigns.length} campanhas</span>
        </div>
        {loading ? (
          <div className="p-8 flex items-center justify-center"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
        ) : campaigns.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm text-slate-400">Sem campanhas. {xanoConnected ? 'Executa um Sync.' : 'Liga o Xano primeiro.'}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-2">
                  {['Campanha', 'Estado', 'Orçamento/dia', 'Spend', 'Sales', 'ACoS', 'ROAS', 'Cliques'].map(h => (
                    <th key={h} className="px-5 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {campaigns.slice(0, 25).map((c, i) => (
                  <tr key={c.id || i} className="border-b border-surface-2/50 hover:bg-surface-2 transition-colors duration-150">
                    <td className="px-5 py-3">
                      <p className="font-medium text-white truncate max-w-xs">{c.name || '—'}</p>
                      <p className="text-xs text-slate-500">{c.campaign_type || c.campaignType}</p>
                    </td>
                    <td className="px-5 py-3"><StatusBadge status={c.state} /></td>
                    <td className="px-5 py-3 text-slate-300">R$ {(c.daily_budget || c.dailyBudget || 0).toFixed(2)}</td>
                    <td className="px-5 py-3 text-slate-300">R$ {(c.spend || 0).toFixed(2)}</td>
                    <td className="px-5 py-3 text-emerald-400">R$ {(c.sales || 0).toFixed(2)}</td>
                    <td className="px-5 py-3">
                      <span className={`font-semibold ${(c.acos || 0) > 40 ? 'text-red-400' : (c.acos || 0) > 25 ? 'text-amber-400' : 'text-emerald-400'}`}>
                        {(c.acos || 0).toFixed(1)}%
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <span className={`font-semibold ${(c.roas || 0) > 3 ? 'text-emerald-400' : (c.roas || 0) > 1.5 ? 'text-amber-400' : 'text-red-400'}`}>
                        {(c.roas || 0).toFixed(2)}x
                      </span>
                    </td>
                    <td className="px-5 py-3 text-slate-300">{(c.clicks || 0).toLocaleString()}</td>
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