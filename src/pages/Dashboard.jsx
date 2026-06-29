import { useState, useEffect, useCallback, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';
import { BarChart2, Loader2, TrendingUp, TrendingDown, Minus, RefreshCw, AlertCircle, Brain, Zap, Clock } from 'lucide-react';
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

function ReportSyncWidget({ amazonAccountId, onDone }) {
  const [state, setState] = useState('idle'); // idle | requesting | polling | done | error
  const [msg, setMsg] = useState('');
  const [reportIds, setReportIds] = useState(null);
  const [pollCount, setPollCount] = useState(0);

  // Polling a cada 30s enquanto aguarda os relatórios
  useEffect(() => {
    if (state !== 'polling' || !reportIds) return;
    const interval = setInterval(async () => {
      try {
        const res = await base44.functions.invoke('runFullSync', {
          amazon_account_id: amazonAccountId,
          action: 'download',
          reportIds: reportIds?.reportIds || reportIds,
          syncRunId: reportIds?.syncRunId || null,
        });
        const d = res.data;
        setPollCount(p => p + 1);
        if (!d?.ok) { clearInterval(interval); setState('error'); setMsg(d?.error || 'Erro desconhecido'); return; }
        if (d.ready) {
          clearInterval(interval);
          setState('done');
          setMsg(`✓ ${d.products || 0} produtos · ${d.keywords || 0} keywords · spend $${(d.summary?.total_spend || 0).toFixed(2)}`);
          onDone?.();
        } else {
          const pending = Object.entries(d.pending || {}).map(([k, v]) => `${k}:${v}`).join(' · ');
          setMsg(`⏳ Aguardando relatório da Amazon... (${pending})`);
        }
      } catch (e) {
        clearInterval(interval);
        setState('error');
        setMsg(e.message);
      }
    }, 30000);
    return () => clearInterval(interval);
  }, [state, reportIds, amazonAccountId]);

  const request = async () => {
    setState('requesting');
    setPollCount(0);
    setMsg('A importar campanhas e solicitar relatórios 30d...');
    try {
      const r1 = await base44.functions.invoke('runFullSync', { amazon_account_id: amazonAccountId, action: 'request' });
      const d1 = r1.data;
      if (!d1?.ok) throw new Error(d1?.error || 'Falhou ao iniciar sync');

      setReportIds({ reportIds: d1.reportIds, syncRunId: d1.syncRunId });
      setState('polling');
      setMsg(`✓ ${d1.campaigns_imported} campanhas importadas. ⏳ Aguardando relatório da Amazon... (pode demorar 5-15 min)`);
    } catch (e) {
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
    : state === 'polling' ? `Aguardando Amazon... (${pollCount * 30}s)`
    : state === 'done' ? 'Concluído!'
    : 'Sync Amazon Ads 30d';

  return (
    <div className="flex flex-col gap-2">
      <button onClick={request} disabled={isLoading}
        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold border transition-all disabled:opacity-60 ${color}`}>
        {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
        {label}
      </button>
      {msg && <p className="text-xs text-slate-400 max-w-xs">{msg}</p>}
    </div>
  );
}

export default function Dashboard() {
  const [user, setUser] = useState(null);
  const [account, setAccount] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [products, setProducts] = useState([]);
  const [metricsDaily, setMetricsDaily] = useState([]);
  const [decisions, setDecisions] = useState([]);
  const [syncRuns, setSyncRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await base44.auth.me();
      setUser(me);
      // Tenta por user_id primeiro, fallback para o primeiro registro disponível
      let accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      if (!accounts.length) accounts = await base44.entities.AmazonAccount.list();
      const acc = accounts[0] || null;
      setAccount(acc);
      if (!acc) { setLoading(false); return; }

      const aid = acc.id;
      const [cams, prods, metrics, decs, runs] = await Promise.all([
        base44.entities.Campaign.filter({ amazon_account_id: aid }, '-spend', 2000),
        base44.entities.Product.filter({ amazon_account_id: aid }, '-total_revenue_30d', 30),
        base44.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 90),
        base44.entities.Decision.filter({ amazon_account_id: aid, status: 'pending' }, '-created_date', 10),
        base44.entities.SyncRun.filter({ amazon_account_id: aid }, '-started_at', 8),
      ]);

      setCampaigns(cams);
      setProducts(prods);
      setMetricsDaily(metrics);
      setDecisions(decs);
      setSyncRuns(runs);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);



  // Calcular KPIs agregados das campanhas
  const kpis = campaigns.reduce((acc, c) => ({
    spend: acc.spend + (c.spend || 0),
    sales: acc.sales + (c.sales || 0),
    clicks: acc.clicks + (c.clicks || 0),
    impressions: acc.impressions + (c.impressions || 0),
    orders: acc.orders + (c.orders || 0),
  }), { spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0 });

  const acos = kpis.sales > 0 ? (kpis.spend / kpis.sales * 100) : 0;
  const roas = kpis.spend > 0 ? (kpis.sales / kpis.spend) : 0;
  const ctr = kpis.impressions > 0 ? (kpis.clicks / kpis.impressions * 100) : 0;
  const cpc = kpis.clicks > 0 ? (kpis.spend / kpis.clicks) : 0;

  // Agrupar métricas por data para o gráfico
  const chartData = Object.values(
    metricsDaily.reduce((acc, m) => {
      if (!acc[m.date]) acc[m.date] = { name: m.date?.slice(5) || '', spend: 0, sales: 0, orders: 0 };
      acc[m.date].spend += m.spend || 0;
      acc[m.date].sales += m.sales || 0;
      acc[m.date].orders += m.orders || 0;
      return acc;
    }, {})
  ).sort((a, b) => a.name.localeCompare(b.name)).slice(-30);

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
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard label="Ad Spend 30d" value={`$${kpis.spend.toFixed(2)}`} sub={`${campaigns.filter(c => c.state === 'enabled').length} ativas · ${campaigns.filter(c => c.state !== 'enabled').length} inativas`} loading={loading} />
        <KPICard label="Vendas Ads 30d" value={`$${kpis.sales.toFixed(2)}`} sub={`${kpis.orders} pedidos`} loading={loading} />
        <KPICard label="ACoS" value={`${acos.toFixed(1)}%`} sub={`ROAS: ${roas.toFixed(2)}x`} loading={loading} />
        <KPICard label="CPC Médio" value={`$${cpc.toFixed(2)}`} sub={`CTR: ${ctr.toFixed(2)}%`} loading={loading} />
        <KPICard label="Cliques" value={kpis.clicks.toLocaleString()} sub="30 dias" loading={loading} />
        <KPICard label="Impressões" value={kpis.impressions.toLocaleString()} sub="30 dias" loading={loading} />
        <KPICard label="Campanhas" value={campaigns.length} sub={`${campaigns.filter(c => c.state === 'enabled').length} ativas · ${campaigns.filter(c => c.state === 'paused').length} pausadas · ${campaigns.filter(c => c.state === 'archived').length} arquivadas`} loading={loading} />
        <KPICard label="Produtos" value={products.length} sub={`${products.filter(p => p.fba_inventory > 0).length} com stock`} loading={loading} />
      </div>

      {/* Chart + Decisions */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-surface-1 border border-surface-2 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-slate-300">Spend vs Vendas — 30 dias</h2>
            <BarChart2 className="w-4 h-4 text-slate-500" />
          </div>
          {loading ? (
            <div className="h-52 flex items-center justify-center"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
          ) : chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={210}>
              <AreaChart data={chartData} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="gSpend" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#3B82F6" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gSales" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10B981" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#10B981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ background: '#111318', border: '1px solid #1A1D26', borderRadius: 8, fontSize: 12 }} formatter={(v) => `$${Number(v).toFixed(2)}`} />
                <Area type="monotone" dataKey="spend" stroke="#3B82F6" fill="url(#gSpend)" strokeWidth={2} name="Spend" />
                <Area type="monotone" dataKey="sales" stroke="#10B981" fill="url(#gSales)" strokeWidth={2} name="Vendas" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-52 flex flex-col items-center justify-center gap-2">
              <p className="text-sm text-slate-500">Sem dados de métricas.</p>
              <p className="text-xs text-slate-600">Execute "Sync Completo 30d + IA" para popular o gráfico.</p>
            </div>
          )}
        </div>

        {/* Decisões IA */}
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
              <Brain className="w-4 h-4 text-cyan" /> Decisões IA
            </h2>
            <Link to="/learner" className="text-xs text-cyan hover:underline">Ver todas</Link>
          </div>
          {loading ? (
            <div className="space-y-2">
              {[1,2,3].map(i => <div key={i} className="h-12 bg-surface-2 rounded animate-pulse" />)}
            </div>
          ) : decisions.length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-6">Sem decisões pendentes.<br/><span className="text-xs">Execute um sync para gerar recomendações.</span></p>
          ) : (
            <div className="space-y-2">
              {decisions.slice(0, 6).map(d => (
                <div key={d.id} className="p-2.5 bg-surface-2 rounded-lg border border-surface-3">
                  <div className="flex items-center justify-between mb-1">
                    <StatusBadge status={d.priority} size="xs" />
                    <span className="text-xs text-slate-500">{d.decision_type?.replace('_', ' ')}</span>
                  </div>
                  <p className="text-xs text-slate-300 truncate">{d.entity_name || d.entity_id}</p>
                  <p className="text-xs text-slate-500 mt-0.5 line-clamp-1">{d.rationale}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Campanhas Top */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-2">
          <h2 className="text-sm font-semibold text-slate-300">Top Campanhas (30d)</h2>
          <Link to="/ads" className="text-xs text-cyan hover:underline">Ver todas →</Link>
        </div>
        {loading ? (
          <div className="p-8 flex items-center justify-center"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
        ) : campaigns.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm text-slate-400">Sem campanhas. Execute um Sync.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-2">
                  {['Nome', 'Tipo', 'Estado', 'Spend', 'Vendas', 'ACoS', 'ROAS', 'Cliques'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c, i) => {
                  const acosVal = c.acos || 0;
                  const acosColor = acosVal > 50 ? 'text-red-400' : acosVal > 30 ? 'text-amber-400' : 'text-emerald-400';
                  return (
                    <tr key={c.id || i} className="border-b border-surface-2/50 hover:bg-surface-2 transition-colors">
                      <td className="px-4 py-3 text-white font-medium truncate max-w-[200px]">{c.name || '—'}</td>
                      <td className="px-4 py-3"><span className="text-xs px-1.5 py-0.5 rounded bg-surface-3 text-slate-400">{c.campaign_type || 'SP'}</span></td>
                      <td className="px-4 py-3"><StatusBadge status={c.state || 'enabled'} size="xs" /></td>
                      <td className="px-4 py-3 text-slate-300">${(c.spend || 0).toFixed(2)}</td>
                      <td className="px-4 py-3 text-emerald-400">${(c.sales || 0).toFixed(2)}</td>
                      <td className={`px-4 py-3 font-semibold ${acosColor}`}>{acosVal.toFixed(1)}%</td>
                      <td className="px-4 py-3 text-slate-300">{(c.roas || 0).toFixed(2)}x</td>
                      <td className="px-4 py-3 text-slate-400">{(c.clicks || 0).toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Produtos + Sync Logs */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Produtos com mais vendas */}
        <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-surface-2">
            <h2 className="text-sm font-semibold text-slate-300">Produtos (30d)</h2>
            <Link to="/inventory" className="text-xs text-cyan hover:underline">Ver todos →</Link>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-2">
                  {['ASIN', 'SKU', 'Receita 30d', 'Units', 'Stock FBA'].map(h => (
                    <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {products.slice(0, 10).map((p, i) => (
                  <tr key={p.id || i} className="border-b border-surface-2/50 hover:bg-surface-2 transition-colors">
                    <td className="px-4 py-2.5 font-mono text-xs text-cyan">{p.asin || '—'}</td>
                    <td className="px-4 py-2.5 text-slate-400 font-mono text-xs">{p.sku || '—'}</td>
                    <td className="px-4 py-2.5 text-emerald-400">${(p.total_revenue_30d || 0).toFixed(2)}</td>
                    <td className="px-4 py-2.5 text-slate-300">{p.units_sold_30d || 0}</td>
                    <td className="px-4 py-2.5">
                      <span className={`font-semibold text-xs ${(p.fba_inventory || 0) === 0 ? 'text-red-400' : (p.fba_inventory || 0) < 10 ? 'text-amber-400' : 'text-white'}`}>
                        {p.fba_inventory || 0}
                      </span>
                    </td>
                  </tr>
                ))}
                {products.length === 0 && !loading && (
                  <tr><td colSpan={5} className="px-4 py-6 text-center text-sm text-slate-500">Sem produtos. Execute um sync.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Logs de Sync */}
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
            <Clock className="w-4 h-4 text-slate-500" /> Histórico de Syncs
          </h2>
          {syncRuns.length === 0 && !loading ? (
            <p className="text-sm text-slate-500 text-center py-4">Sem syncs registados</p>
          ) : (
            <div className="space-y-2">
              {syncRuns.map((run, i) => (
                <div key={run.id || i} className="flex items-center gap-3 py-2 border-b border-surface-2/50 last:border-0">
                  <StatusBadge status={run.status} size="xs" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-slate-300 truncate">
                      {run.operation?.startsWith('adsReports:') ? `Sync Ads 30d — ${run.operation.split(':')[1] || ''}` : run.operation}
                    </p>
                    <p className="text-xs text-slate-500">
                      {run.records_upserted ? `${run.records_upserted} registos` : ''}
                      {run.duration_ms ? ` · ${(run.duration_ms / 1000).toFixed(1)}s` : ''}
                    </p>
                  </div>
                  <span className="text-xs text-slate-600 flex-shrink-0">
                    {run.started_at ? new Date(run.started_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}