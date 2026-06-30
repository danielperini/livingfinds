import { useState, useEffect, useCallback, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Legend } from 'recharts';
import { BarChart2, Loader2, TrendingUp, TrendingDown, Minus, RefreshCw, AlertCircle, Brain, Zap, Clock, Activity, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import StatusBadge from '@/components/ui/StatusBadge';
import { Link } from 'react-router-dom';

function KPICard({ label, value, unit, sub, inverse, loading }) {
  if (loading) return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-5 animate-pulse">
      <div className="h-3 w-24 bg-surface-3 rounded mb-3" />
      <div className="h-7 w-32 bg-surface-3 rounded mb-2" />
      <div className="h-3 w-16 bg-surface-3 rounded" />
    </div>
  );
  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
      <p className="text-xs font-medium text-slate-400 mb-2">{label}</p>
      <p className="text-2xl font-bold text-white mb-1">{value}</p>
      {sub && <p className="text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

const SYNC_KEY = 'lf_sync_state';

function saveSyncState(data) {
  try { localStorage.setItem(SYNC_KEY, JSON.stringify(data)); } catch {}
}
function loadSyncState() {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY) || 'null'); } catch { return null; }
}
function clearSyncState() {
  try { localStorage.removeItem(SYNC_KEY); } catch {}
}

function ReportSyncWidget({ amazonAccountId, onDone }) {
  const [state, setState] = useState('idle');
  const [msg, setMsg] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const pollRef = useRef(null);
  const timerRef = useRef(null);
  const pendingRef = useRef(null);
  const startTimeRef = useRef(null);

  const stopAll = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
  };

  const startElapsedTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setElapsed(startTimeRef.current ? Math.round((Date.now() - startTimeRef.current) / 1000) : 0);
    }, 1000);
  };

  const startPolling = (pending, campaigns_imported, report_errors) => {
    pendingRef.current = pending;
    setState('polling');
    setMsg(`✓ ${campaigns_imported} campanhas importadas. A aguardar relatórios Amazon...`);
    if (report_errors?.length > 0) setMsg(prev => prev + ` ⚠ ${report_errors.join(', ')}`);

    pollRef.current = setInterval(async () => {
      try {
        const r2 = await base44.functions.invoke('runFullSync', {
          amazon_account_id: amazonAccountId,
          action: 'download',
          ...pendingRef.current,
        });
        const d2 = r2.data;
        if (!d2?.ok && !d2?.ready) {
          stopAll(); clearSyncState();
          setState('error');
          setMsg(d2?.message || JSON.stringify(d2).slice(0, 200));
          setTimeout(() => { setState('idle'); setMsg(''); }, 15000);
          return;
        }
        if (d2.ready) {
          stopAll(); clearSyncState();
          setState('done');
          const sum = d2.summary || {};
          setMsg(`✓ Concluído — ${d2.campaigns_metrics || 0} camp. · ${d2.products || 0} prod. · ${d2.keywords || 0} kws · $${(sum.total_spend || 0).toFixed(2)} spend · $${(sum.total_sales || 0).toFixed(2)} vendas`);
          onDone?.();
        } else {
          const pend = Object.entries(d2.pending || {}).map(([k, v]) => `${k}:${v}`).join(', ');
          const fail = Object.keys(d2.failed || {}).length > 0 ? ` ⚠ falhou: ${Object.keys(d2.failed).join(',')}` : '';
          setMsg(`A aguardar Amazon... ${pend}${fail}`);
          saveSyncState({ reportIds: pendingRef.current.reportIds, syncRunId: pendingRef.current.syncRunId, startedAt: startTimeRef.current, campaigns_imported });
        }
      } catch (e) {
        stopAll(); clearSyncState();
        setState('error');
        setMsg(e.message);
        setTimeout(() => { setState('idle'); setMsg(''); }, 15000);
      }
    }, 30000);
  };

  useEffect(() => {
    const saved = loadSyncState();
    if (saved?.reportIds && amazonAccountId) {
      startTimeRef.current = saved.startedAt || Date.now();
      setElapsed(Math.round((Date.now() - startTimeRef.current) / 1000));
      startElapsedTimer();
      startPolling({ reportIds: saved.reportIds, syncRunId: saved.syncRunId }, saved.campaigns_imported || '?', []);
    }
    return stopAll;
  }, [amazonAccountId]);

  const request = async () => {
    stopAll();
    setState('requesting');
    startTimeRef.current = Date.now();
    setElapsed(0);
    setMsg('A importar campanhas e solicitar relatórios 30d...');
    try {
      const r1 = await base44.functions.invoke('runFullSync', { amazon_account_id: amazonAccountId, action: 'request' });
      const d1 = r1.data;
      if (!d1?.ok) {
        setState('error');
        setMsg(d1?.message || d1?.amazon_error || JSON.stringify(d1).slice(0, 200));
        setTimeout(() => { setState('idle'); setMsg(''); }, 15000);
        return;
      }
      startElapsedTimer();
      saveSyncState({ reportIds: d1.reportIds, syncRunId: d1.syncRunId, startedAt: startTimeRef.current, campaigns_imported: d1.campaigns_imported });
      startPolling({ reportIds: d1.reportIds, syncRunId: d1.syncRunId }, d1.campaigns_imported, d1.report_errors);
    } catch (e) {
      stopAll(); clearSyncState();
      setState('error');
      setMsg(e.message);
      setTimeout(() => { setState('idle'); setMsg(''); }, 15000);
    }
  };

  const isLoading = state === 'requesting' || state === 'polling';
  const color = state === 'done' ? 'border-emerald-400/30 text-emerald-400 bg-emerald-400/5'
    : state === 'error' ? 'border-red-400/30 text-red-400 bg-red-400/5'
    : 'border-cyan/20 text-cyan bg-cyan/5 hover:bg-cyan/10';

  const label = state === 'requesting' ? 'A solicitar...'
    : state === 'polling' ? `A aguardar Amazon... (${elapsed}s)`
    : state === 'done' ? 'Sync Concluído!'
    : 'Sync Amazon Ads 30d';

  return (
    <div className="flex flex-col gap-2">
      <button onClick={request} disabled={isLoading}
        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold border transition-all disabled:opacity-60 ${color}`}>
        {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
        {label}
      </button>
      {msg && <p className={`text-xs max-w-xs ${state === 'error' ? 'text-red-400' : 'text-slate-400'}`}>{msg}</p>}
    </div>
  );
}

export default function Dashboard() {
  const [user, setUser] = useState(null);
  const [account, setAccount] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [products, setProducts] = useState([]);
  const [metricsDaily, setMetricsDaily] = useState([]);
  const [hourlyMetrics, setHourlyMetrics] = useState([]);
  const [decisions, setDecisions] = useState([]);
  const [syncRuns, setSyncRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [auditData, setAuditData] = useState(null);
  const [showAudit, setShowAudit] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await base44.auth.me();
      setUser(me);
      let accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      if (!accounts.length) accounts = await base44.entities.AmazonAccount.list();
      const acc = accounts[0] || null;
      setAccount(acc);
      if (!acc) { setLoading(false); return; }

      const aid = acc.id;
      const [cams, prods, metrics, hourly, decs, runs] = await Promise.all([
        base44.entities.Campaign.filter({ amazon_account_id: aid }, '-spend', 2000),
        base44.entities.Product.filter({ amazon_account_id: aid }, '-total_sales_30d', 30),
        base44.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 120),
        base44.entities.HourlyMetric.filter({ amazon_account_id: aid }, '-date', 720),
        base44.entities.Decision.filter({ amazon_account_id: aid, status: 'pending' }, '-created_date', 10),
        base44.entities.SyncRun.filter({ amazon_account_id: aid }, '-started_at', 8),
      ]);

      setCampaigns(cams);
      setProducts(prods);
      setMetricsDaily(metrics);
      setHourlyMetrics(hourly);
      setDecisions(decs);
      setSyncRuns(runs);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const cutoffDate = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const metricsLast30Days = metricsDaily.filter(m => m.date >= cutoffDate);
  
  const uniqueMetricsMap = new Map();
  metricsLast30Days.forEach(m => {
    const key = `${m.campaign_id || ''}-${m.date}`;
    uniqueMetricsMap.set(key, m);
  });
  const uniqueMetrics = Array.from(uniqueMetricsMap.values());
  
  const kpis = uniqueMetrics.reduce((acc, m) => ({
    spend: acc.spend + (m.spend || 0),
    sales: acc.sales + (m.sales || 0),
    clicks: acc.clicks + (m.clicks || 0),
    impressions: acc.impressions + (m.impressions || 0),
    orders: acc.orders + (m.orders || 0),
  }), { spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0 });

  const acos = kpis.sales > 0 ? (kpis.spend / kpis.sales * 100) : 0;
  const roas = kpis.spend > 0 ? (kpis.sales / kpis.spend) : 0;
  const ctr = kpis.impressions > 0 ? (kpis.clicks / kpis.impressions * 100) : 0;
  const cpc = kpis.clicks > 0 ? (kpis.spend / kpis.clicks) : 0;

  const chartData = Object.values(
    uniqueMetrics.reduce((acc, m) => {
      if (!acc[m.date]) acc[m.date] = { name: m.date?.slice(5) || '', date: m.date, spend: 0, sales: 0, orders: 0, clicks: 0 };
      acc[m.date].spend += m.spend || 0;
      acc[m.date].sales += m.sales || 0;
      acc[m.date].orders += m.orders || 0;
      acc[m.date].clicks += m.clicks || 0;
      return acc;
    }, {})
  ).sort((a, b) => a.date.localeCompare(b.date));

  const hourlyData = Object.values(
    hourlyMetrics.reduce((acc, h) => {
      const hour = h.hour ?? 0;
      if (!acc[hour]) acc[hour] = { hour: `${String(hour).padStart(2, '0')}:00`, clicks: 0, orders: 0, spend: 0, sales: 0, impressions: 0 };
      acc[hour].clicks += h.clicks || 0;
      acc[hour].orders += h.orders || 0;
      acc[hour].spend += h.spend || 0;
      acc[hour].sales += h.sales || 0;
      acc[hour].impressions += h.impressions || 0;
      return acc;
    }, {})
  ).sort((a, b) => parseInt(a.hour) - parseInt(b.hour)).map(h => ({
    ...h,
    cvr: h.clicks > 0 ? safe(h.orders / h.clicks * 100) : 0,
    cpc: h.clicks > 0 ? safe(h.spend / h.clicks) : 0,
    roas: h.spend > 0 ? safe(h.sales / h.spend) : 0,
  }));

  function safe(num, decimals = 2) {
    if (!num || !isFinite(num) || isNaN(num)) return 0;
    return Number(num.toFixed(decimals));
  }

  const runAudit = async () => {
    if (!account) return;
    try {
      const res = await base44.functions.invoke('auditSyncData', { amazon_account_id: account.id });
      if (res.data?.ok) {
        setAuditData(res.data);
        setShowAudit(true);
      } else {
        alert('Erro na auditoria: ' + (res.data?.error || 'Falha desconhecida'));
      }
    } catch (error) {
      alert('Erro: ' + error.message);
    }
  };

  useEffect(() => {
    if (!loading && kpis.spend > 0) {
      console.log('📊 AUDITORIA DASHBOARD:', {
        'Ad Spend': `$${kpis.spend.toFixed(2)}`,
        'Vendas': `$${kpis.sales.toFixed(2)}`,
        'Pedidos': kpis.orders,
        'Cliques': kpis.clicks,
        'ACoS': `${acos.toFixed(2)}%`,
        'ROAS': `${roas.toFixed(2)}x`,
        'Registros diários': metricsDaily.length,
        'Registros únicos': uniqueMetrics.length,
        'Duplicatas': metricsDaily.length - uniqueMetrics.length,
      });
    }
  }, [loading, kpis, metricsDaily.length, uniqueMetrics.length]);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  const firstName = user?.full_name?.split(' ')[0] || 'gestor';
  const lastSync = account?.last_sync_at ? new Date(account.last_sync_at).toLocaleString('pt-BR') : null;

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-white">{greeting}, {firstName}.</h1>
          <p className="text-sm text-slate-400 mt-0.5">
            {decisions.length > 0
              ? <><span className="text-amber-400 font-semibold">{decisions.length}</span> recomendações IA pendentes · </>
              : 'Sem recomendações pendentes · '}
            {lastSync ? `Último sync: ${lastSync}` : 'Nenhum sync realizado'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {account && <ReportSyncWidget amazonAccountId={account.id} onDone={loadData} />}
          <button onClick={loadData} disabled={loading}
            className="flex items-center gap-2 px-3 py-2 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-sm rounded-lg transition-colors">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={runAudit} disabled={loading}
            className="flex items-center gap-2 px-3 py-2 bg-cyan/10 border border-cyan/20 text-cyan hover:bg-cyan/20 text-sm rounded-lg transition-colors">
            <Activity className="w-4 h-4" />
            Auditoria
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Painel de Auditoria de Dados */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold text-slate-400">📊 Auditoria de Dados (30 dias)</h3>
          <span className="text-[10px] text-slate-500">Fontes: CampaignMetricsDaily</span>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 text-xs">
          <div className="bg-surface-2 rounded-lg p-2">
            <p className="text-slate-500 mb-0.5">Registros diários</p>
            <p className="text-white font-semibold">{metricsDaily.length}</p>
          </div>
          <div className="bg-surface-2 rounded-lg p-2">
            <p className="text-slate-500 mb-0.5">Registros únicos</p>
            <p className="text-white font-semibold">{uniqueMetrics.length}</p>
          </div>
          <div className="bg-surface-2 rounded-lg p-2">
            <p className="text-slate-500 mb-0.5">Duplicatas removidas</p>
            <p className="text-amber-400 font-semibold">{metricsDaily.length - uniqueMetrics.length}</p>
          </div>
          <div className="bg-surface-2 rounded-lg p-2">
            <p className="text-slate-500 mb-0.5">Campanhas ativas</p>
            <p className="text-emerald-400 font-semibold">{campaigns.filter(c => c.state === 'enabled' && !c.archived).length}</p>
          </div>
          <div className="bg-surface-2 rounded-lg p-2">
            <p className="text-slate-500 mb-0.5">Campanhas totais</p>
            <p className="text-white font-semibold">{campaigns.length}</p>
          </div>
          <div className="bg-surface-2 rounded-lg p-2">
            <p className="text-slate-500 mb-0.5">Data corte</p>
            <p className="text-cyan font-mono text-[10px]">{cutoffDate}</p>
          </div>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard label="✓ Ad Spend 30d" value={`$${kpis.spend.toFixed(2)}`} sub={`${campaigns.filter(c => c.state === 'enabled' && !c.archived).length} ativas`} loading={loading} />
        <KPICard label="Vendas Ads 30d" value={`$${kpis.sales.toFixed(2)}`} sub={`${kpis.orders} pedidos`} loading={loading} />
        <KPICard label="ACoS" value={`${acos.toFixed(1)}%`} sub={`ROAS: ${roas.toFixed(2)}x`} loading={loading} />
        <KPICard label="CPC Médio" value={`$${cpc.toFixed(2)}`} sub={`CTR: ${ctr.toFixed(2)}%`} loading={loading} />
      </div>

      {/* Gráfico Spend vs Vendas */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-slate-300 mb-4">Spend vs Vendas — 30 dias</h2>
        {loading ? <div className="h-52 flex items-center justify-center"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div> : chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={210}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="gSpend" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#3B82F6" stopOpacity={0.25} /><stop offset="95%" stopColor="#3B82F6" stopOpacity={0} /></linearGradient>
                <linearGradient id="gSales" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#10B981" stopOpacity={0.25} /><stop offset="95%" stopColor="#10B981" stopOpacity={0} /></linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ background: '#111318', border: '1px solid #1A1D26', borderRadius: 8, fontSize: 12 }} formatter={(v) => `$${Number(v).toFixed(2)}`} />
              <Area type="monotone" dataKey="spend" stroke="#3B82F6" fill="url(#gSpend)" strokeWidth={2} name="Spend" />
              <Area type="monotone" dataKey="sales" stroke="#10B981" fill="url(#gSales)" strokeWidth={2} name="Vendas" />
            </AreaChart>
          </ResponsiveContainer>
        ) : <div className="h-52 flex items-center justify-center text-sm text-slate-500">Sem dados. Execute um Sync.</div>}
      </div>

      {/* Campanhas Ativas */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-surface-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-300">Campanhas Ativas</h2>
          <Link to="/ads" className="text-xs text-cyan hover:underline">Ver todas →</Link>
        </div>
        {loading ? <div className="p-8 flex items-center justify-center"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div> : campaigns.filter(c => c.state === 'enabled' && !c.archived).length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">Nenhuma campanha ativa</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-surface-2">{['Nome', 'Spend', 'Vendas', 'ACoS', 'ROAS'].map(h => <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase">{h}</th>)}</tr></thead>
              <tbody>
                {campaigns.filter(c => c.state === 'enabled' && !c.archived).slice(0, 20).map(c => (
                  <tr key={c.id} className="border-b border-surface-2/50 hover:bg-surface-2">
                    <td className="px-4 py-3 text-white font-medium truncate max-w-[200px]">{c.name || '—'}</td>
                    <td className="px-4 py-3 text-slate-300">${(c.spend || 0).toFixed(2)}</td>
                    <td className="px-4 py-3 text-emerald-400">${(c.sales || 0).toFixed(2)}</td>
                    <td className={`px-4 py-3 font-semibold ${(c.acos || 0) > 50 ? 'text-red-400' : (c.acos || 0) > 30 ? 'text-amber-400' : 'text-emerald-400'}`}>{(c.acos || 0).toFixed(1)}%</td>
                    <td className="px-4 py-3 text-slate-300">{(c.roas || 0).toFixed(2)}x</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal de Auditoria */}
      {showAudit && auditData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={e => e.target === e.currentTarget && setShowAudit(false)}>
          <div className="bg-surface-1 border border-surface-2 rounded-2xl w-full max-w-4xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-surface-2">
              <div>
                <h2 className="text-sm font-bold text-white">📊 Auditoria de Dados Amazon</h2>
                <p className="text-xs text-slate-400 font-mono">{auditData.account?.seller_name || auditData.account?.id}</p>
              </div>
              <button onClick={() => setShowAudit(false)} className="text-slate-500 hover:text-white">
                <XCircle className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* Totais */}
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                <div className="bg-surface-2 rounded-xl p-4 border border-surface-3">
                  <p className="text-xs text-slate-500 mb-1">Spend</p>
                  <p className="text-lg font-bold text-white">{auditData.formatted?.spend}</p>
                </div>
                <div className="bg-surface-2 rounded-xl p-4 border border-surface-3">
                  <p className="text-xs text-slate-500 mb-1">Vendas</p>
                  <p className="text-lg font-bold text-emerald-400">{auditData.formatted?.sales}</p>
                </div>
                <div className="bg-surface-2 rounded-xl p-4 border border-surface-3">
                  <p className="text-xs text-slate-500 mb-1">ACoS</p>
                  <p className="text-lg font-bold text-amber-400">{auditData.formatted?.acos}</p>
                </div>
                <div className="bg-surface-2 rounded-xl p-4 border border-surface-3">
                  <p className="text-xs text-slate-500 mb-1">ROAS</p>
                  <p className="text-lg font-bold text-cyan">{auditData.formatted?.roas}</p>
                </div>
                <div className="bg-surface-2 rounded-xl p-4 border border-surface-3">
                  <p className="text-xs text-slate-500 mb-1">CPC</p>
                  <p className="text-lg font-bold text-slate-300">{auditData.formatted?.cpc}</p>
                </div>
              </div>

              {/* Qualidade */}
              <div className="bg-surface-2 rounded-xl p-4 border border-surface-3">
                <h3 className="text-xs font-semibold text-slate-400 mb-3">Qualidade dos Dados</h3>
                <div className="space-y-2 text-xs">
                  <div className="flex items-center justify-between py-1.5 border-b border-surface-3/50"><span className="text-slate-500">Total:</span><span className="text-white font-semibold">{auditData.metrics?.total_records}</span></div>
                  <div className="flex items-center justify-between py-1.5 border-b border-surface-3/50"><span className="text-slate-500">Únicos:</span><span className="text-emerald-400 font-semibold">{auditData.metrics?.unique_records}</span></div>
                  <div className="flex items-center justify-between py-1.5"><span className="text-slate-500">Duplicatas:</span><span className={`font-semibold ${auditData.metrics?.duplicates_removed > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>{auditData.metrics?.duplicates_removed}</span></div>
                </div>
              </div>

              {/* Campanhas */}
              <div className="bg-surface-2 rounded-xl p-4 border border-surface-3">
                <h3 className="text-xs font-semibold text-slate-400 mb-3">Campanhas</h3>
                <div className="grid grid-cols-4 gap-3 text-center">
                  <div><p className="text-xs text-slate-500">Total</p><p className="text-lg font-bold text-white">{auditData.campaigns?.total}</p></div>
                  <div><p className="text-xs text-slate-500">Ativas</p><p className="text-lg font-bold text-emerald-400">{auditData.campaigns?.active}</p></div>
                  <div><p className="text-xs text-slate-500">Pausadas</p><p className="text-lg font-bold text-amber-400">{auditData.campaigns?.paused}</p></div>
                  <div><p className="text-xs text-slate-500">Arquivadas</p><p className="text-lg font-bold text-slate-400">{auditData.campaigns?.archived}</p></div>
                </div>
              </div>

              {/* Nota */}
              <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4">
                <p className="text-xs text-amber-300"><strong>⚠️ Nota:</strong> Divergências podem indicar necessidade de novo sync. Dados Amazon levam 48h para atribuição completa.</p>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-surface-2 flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => setShowAudit(false)}>Fechar</Button>
              <Button onClick={() => { setShowAudit(false); loadData(); }}>Atualizar</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}