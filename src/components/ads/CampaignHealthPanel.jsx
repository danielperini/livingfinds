import { useMemo } from 'react';
import { TrendingUp, TrendingDown, Zap, Sparkles, AlertTriangle, CheckCircle, PauseCircle, Activity, Target, DollarSign, ShoppingCart } from 'lucide-react';

function MetricCard({ label, value, sub, tone = 'default' }) {
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

function AcosBar({ asin, name, spend, sales, acos, orders }) {
  const color = acos === 0 ? 'bg-slate-600' : acos <= 15 ? 'bg-emerald-500' : acos <= 30 ? 'bg-amber-500' : 'bg-red-500';
  const textColor = acos === 0 ? 'text-slate-500' : acos <= 15 ? 'text-emerald-400' : acos <= 30 ? 'text-amber-400' : 'text-red-400';
  const pct = Math.min(100, acos);
  return (
    <div className="flex items-center gap-3">
      <div className="w-20 flex-shrink-0">
        <p className="text-[10px] font-mono text-cyan truncate">{asin}</p>
        <p className="text-[9px] text-slate-500 truncate">{name}</p>
      </div>
      <div className="flex-1 h-1.5 bg-surface-3 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`text-xs font-bold w-10 text-right flex-shrink-0 ${textColor}`}>
        {acos > 0 ? `${acos.toFixed(0)}%` : '—'}
      </span>
      <span className="text-[10px] text-slate-500 w-20 text-right flex-shrink-0">
        R${spend.toFixed(0)} · {orders}p
      </span>
    </div>
  );
}

export default function CampaignHealthPanel({ campaigns, products }) {
  const stats = useMemo(() => {
    const active = campaigns.filter(c => c.state === 'enabled' || c.status === 'enabled');
    const paused = campaigns.filter(c => c.state === 'paused' || c.status === 'paused');
    const auto = campaigns.filter(c => (c.targeting_type || '').toUpperCase() === 'AUTO');
    const manual = campaigns.filter(c => (c.targeting_type || '').toUpperCase() !== 'AUTO');

    const totalSpend = campaigns.reduce((s, c) => s + (c.spend || 0), 0);
    const totalSales = campaigns.reduce((s, c) => s + (c.sales || 0), 0);
    const totalOrders = campaigns.reduce((s, c) => s + (c.orders || 0), 0);
    const totalClicks = campaigns.reduce((s, c) => s + (c.clicks || 0), 0);
    const globalAcos = totalSales > 0 ? (totalSpend / totalSales) * 100 : 0;
    const globalRoas = totalSpend > 0 ? totalSales / totalSpend : 0;

    // Campanhas com problemas
    const noSpend = active.filter(c => (c.spend || 0) === 0);
    const highAcos = active.filter(c => (c.acos || 0) > 40 && (c.spend || 0) > 0);
    const noOrders = active.filter(c => (c.spend || 0) > 5 && (c.orders || 0) === 0);

    // Por ASIN
    const byAsin = new Map();
    for (const c of campaigns) {
      if (!c.asin) continue;
      if (!byAsin.has(c.asin)) {
        const prod = products.find(p => p.asin === c.asin);
        byAsin.set(c.asin, { asin: c.asin, name: prod?.display_name || prod?.product_name || c.asin, spend: 0, sales: 0, orders: 0 });
      }
      const e = byAsin.get(c.asin);
      e.spend += c.spend || 0;
      e.sales += c.sales || 0;
      e.orders += c.orders || 0;
    }
    const asinList = Array.from(byAsin.values())
      .map(e => ({ ...e, acos: e.sales > 0 ? (e.spend / e.sales) * 100 : 0 }))
      .filter(e => e.spend > 0)
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 8);

    return {
      total: campaigns.length, active: active.length, paused: paused.length,
      auto: auto.length, manual: manual.length,
      totalSpend, totalSales, totalOrders, totalClicks,
      globalAcos, globalRoas,
      noSpend: noSpend.length, highAcos: highAcos.length, noOrders: noOrders.length,
      asinList,
      highAcosList: highAcos.slice(0, 3),
      noSpendList: noSpend.slice(0, 3),
    };
  }, [campaigns, products]);

  const acosColor = stats.globalAcos === 0 ? 'default' : stats.globalAcos <= 15 ? 'good' : stats.globalAcos <= 30 ? 'warn' : 'bad';
  const issues = stats.noSpend + stats.highAcos + stats.noOrders;

  return (
    <div className="p-6 space-y-6 overflow-y-auto scrollbar-thin">
      {/* Header */}
      <div>
        <h2 className="text-base font-bold text-white">Painel de Saúde das Campanhas</h2>
        <p className="text-xs text-slate-500 mt-0.5">Resumo operacional · {stats.total} campanhas carregadas</p>
      </div>

      {/* Status rápido */}
      {issues > 0 ? (
        <div className="flex flex-wrap gap-2">
          {stats.highAcos > 0 ? (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-300">
              <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
              <span><strong>{stats.highAcos}</strong> campanha{stats.highAcos > 1 ? 's' : ''} com ACoS &gt; 40%</span>
            </div>
          ) : null}
          {stats.noOrders > 0 ? (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300">
              <ShoppingCart className="w-3.5 h-3.5 text-amber-400" />
              <span><strong>{stats.noOrders}</strong> campanha{stats.noOrders > 1 ? 's' : ''} com gasto sem conversão</span>
            </div>
          ) : null}
          {stats.noSpend > 0 ? (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-2 border border-surface-3 text-xs text-slate-400">
              <PauseCircle className="w-3.5 h-3.5 text-slate-500" />
              <span><strong>{stats.noSpend}</strong> campanha{stats.noSpend > 1 ? 's' : ''} ativa{stats.noSpend > 1 ? 's' : ''} sem gasto</span>
            </div>
          ) : null}
          {issues === 0 ? (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-300">
              <CheckCircle className="w-3.5 h-3.5" /> Todas as campanhas saudáveis
            </div>
          ) : null}
        </div>
      ) : null}

      {/* KPIs principais */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetricCard label="Gasto Total" value={`R$${stats.totalSpend.toFixed(0)}`} sub={`${stats.totalClicks.toLocaleString('pt-BR')} cliques`} tone="cyan" />
        <MetricCard label="Vendas Ads" value={`R$${stats.totalSales.toFixed(0)}`} sub={`${stats.totalOrders} pedidos`} tone={stats.totalSales > 0 ? 'good' : 'default'} />
        <MetricCard label="ACoS Geral" value={stats.globalAcos > 0 ? `${stats.globalAcos.toFixed(1)}%` : '—'} sub="Spend / Vendas" tone={acosColor} />
        <MetricCard label="ROAS Geral" value={stats.globalRoas > 0 ? `${stats.globalRoas.toFixed(2)}x` : '—'} sub="Vendas / Spend" tone={stats.globalRoas >= 4 ? 'good' : stats.globalRoas >= 2 ? 'warn' : 'default'} />
      </div>

      {/* Tipo de campanha */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-4 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center flex-shrink-0">
            <Activity className="w-4 h-4 text-emerald-400" />
          </div>
          <div>
            <p className="text-xl font-bold text-white">{stats.active}</p>
            <p className="text-[10px] text-slate-500">Ativas</p>
          </div>
        </div>
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-4 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-slate-500/10 flex items-center justify-center flex-shrink-0">
            <PauseCircle className="w-4 h-4 text-slate-400" />
          </div>
          <div>
            <p className="text-xl font-bold text-white">{stats.paused}</p>
            <p className="text-[10px] text-slate-500">Pausadas</p>
          </div>
        </div>
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-4 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-amber-400/10 flex items-center justify-center flex-shrink-0">
            <Zap className="w-4 h-4 text-amber-400" />
          </div>
          <div>
            <p className="text-xl font-bold text-white">{stats.auto}</p>
            <p className="text-[10px] text-slate-500">Automáticas</p>
          </div>
        </div>
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-4 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-cyan/10 flex items-center justify-center flex-shrink-0">
            <Sparkles className="w-4 h-4 text-cyan" />
          </div>
          <div>
            <p className="text-xl font-bold text-white">{stats.manual}</p>
            <p className="text-[10px] text-slate-500">Manuais</p>
          </div>
        </div>
      </div>

      {/* ACoS por ASIN */}
      {stats.asinList.length > 0 ? (
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
            <Target className="w-4 h-4 text-cyan" /> ACoS por Produto
          </h3>
          <div className="space-y-3">
            {stats.asinList.map(e => (
              <AcosBar key={e.asin} {...e} />
            ))}
          </div>
        </div>
      ) : null}

      {/* Campanhas com problema */}
      {(stats.highAcosList.length > 0 || stats.noSpendList.length > 0) ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {stats.highAcosList.length > 0 ? (
            <div className="bg-surface-1 border border-red-500/20 rounded-xl p-4">
              <h3 className="text-xs font-semibold text-red-400 mb-3 flex items-center gap-1.5">
                <TrendingDown className="w-3.5 h-3.5" /> ACoS crítico (&gt;40%)
              </h3>
              <div className="space-y-2">
                {stats.highAcosList.map(c => (
                  <div key={c.id} className="flex items-center justify-between">
                    <p className="text-xs text-slate-300 truncate flex-1 mr-2">{(c.name || c.campaign_name || '').replace(/AUTO \| /, '').slice(0, 30)}</p>
                    <span className="text-xs font-bold text-red-400 flex-shrink-0">{(c.acos || 0).toFixed(0)}%</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {stats.noSpendList.length > 0 ? (
            <div className="bg-surface-1 border border-slate-700/50 rounded-xl p-4">
              <h3 className="text-xs font-semibold text-slate-400 mb-3 flex items-center gap-1.5">
                <DollarSign className="w-3.5 h-3.5" /> Ativas sem gasto
              </h3>
              <div className="space-y-2">
                {stats.noSpendList.map(c => (
                  <div key={c.id} className="flex items-center justify-between">
                    <p className="text-xs text-slate-300 truncate flex-1 mr-2">{(c.name || c.campaign_name || '').replace(/AUTO \| /, '').slice(0, 30)}</p>
                    <span className="text-[10px] text-slate-500 flex-shrink-0">{c.targeting_type || 'MANUAL'}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <p className="text-[10px] text-slate-600 text-center">Selecione uma campanha na lista para ver detalhes e editar keywords</p>
    </div>
  );
}