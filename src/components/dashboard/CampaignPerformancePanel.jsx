import React, { useState } from 'react';
import { TrendingUp, TrendingDown, Search, ChevronUp, ChevronDown, Target } from 'lucide-react';

function StatusDot({ value, target, lowerIsBetter }) {
  if (!value || !target) return <span className="w-2 h-2 rounded-full bg-slate-600 inline-block" />;
  const ok = lowerIsBetter ? value <= target : value >= target;
  const warn = lowerIsBetter ? value <= target * 1.3 : value >= target * 0.8;
  const color = ok ? 'bg-emerald-400' : warn ? 'bg-amber-400' : 'bg-red-400';
  return <span className={`w-2 h-2 rounded-full inline-block ${color}`} />;
}

function AcosBar({ value, target, max }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  const isOk = target > 0 ? value <= target : true;
  const isWarn = target > 0 ? value > target && value <= target * 1.3 : false;
  const color = isOk ? 'bg-emerald-500' : isWarn ? 'bg-amber-500' : 'bg-red-500';
  const targetPct = target > 0 && max > 0 ? Math.min((target / max) * 100, 100) : null;
  return (
    <div className="relative w-full h-1.5 bg-surface-3 rounded-full overflow-visible">
      <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      {targetPct !== null && (
        <div className="absolute top-1/2 -translate-y-1/2 w-0.5 h-3 bg-white/40 rounded-full" style={{ left: `${targetPct}%` }} />
      )}
    </div>
  );
}

export default function CampaignPerformancePanel({ campaigns, autopilotConfig, loading }) {
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('spend');
  const [sortDir, setSortDir] = useState('desc');
  const [filter, setFilter] = useState('all');

  const targetAcos = autopilotConfig?.target_acos || 0;
  const targetRoas = autopilotConfig?.target_roas || 0;

  const activeCampaigns = (campaigns || []).filter(c =>
    (c.state === 'enabled' || c.status === 'enabled') &&
    c.state !== 'archived' && c.status !== 'archived'
  );

  const filtered = activeCampaigns.filter(c => {
    const name = (c.name || c.campaign_name || '').toLowerCase();
    if (search && !name.includes(search.toLowerCase()) && !(c.asin || '').toLowerCase().includes(search.toLowerCase())) return false;
    if (filter === 'ok') {
      const acosOk = targetAcos > 0 ? (c.acos || 0) <= targetAcos : true;
      const roasOk = targetRoas > 0 ? (c.roas || 0) >= targetRoas : true;
      return acosOk && roasOk;
    }
    if (filter === 'warn') {
      const acosOk = targetAcos > 0 ? (c.acos || 0) <= targetAcos : true;
      const roasOk = targetRoas > 0 ? (c.roas || 0) >= targetRoas : true;
      return !acosOk || !roasOk;
    }
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    let va = a[sortBy] || 0;
    let vb = b[sortBy] || 0;
    return sortDir === 'desc' ? vb - va : va - vb;
  });

  const maxAcos = Math.max(...activeCampaigns.map(c => c.acos || 0), targetAcos * 1.5, 10);

  function toggleSort(col) {
    if (sortBy === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortBy(col); setSortDir('desc'); }
  }

  function SortIcon({ col }) {
    if (sortBy !== col) return <ChevronUp className="w-3 h-3 text-slate-600" />;
    return sortDir === 'desc'
      ? <ChevronDown className="w-3 h-3 text-cyan" />
      : <ChevronUp className="w-3 h-3 text-cyan" />;
  }

  // KPIs consolidados
  const totalSpend = activeCampaigns.reduce((s, c) => s + (c.spend || 0), 0);
  const totalSales = activeCampaigns.reduce((s, c) => s + (c.sales || 0), 0);
  const consolidatedAcos = totalSales > 0 ? (totalSpend / totalSales) * 100 : 0;
  const consolidatedRoas = totalSpend > 0 ? totalSales / totalSpend : 0;
  const onTarget = activeCampaigns.filter(c => {
    const acosOk = targetAcos > 0 ? (c.acos || 0) <= targetAcos || (c.acos || 0) === 0 : true;
    const roasOk = targetRoas > 0 ? (c.roas || 0) >= targetRoas || (c.roas || 0) === 0 : true;
    return acosOk && roasOk;
  }).length;

  if (loading) {
    return (
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-5 animate-pulse">
        <div className="h-4 w-48 bg-surface-3 rounded mb-4" />
        <div className="space-y-2">
          {[1, 2, 3, 4].map(i => <div key={i} className="h-10 bg-surface-2 rounded" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-surface-2">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Target className="w-4 h-4 text-cyan" />
            <h2 className="text-sm font-semibold text-slate-300">Performance por Campanha</h2>
            <span className="text-xs text-slate-500">({activeCampaigns.length} ativas)</span>
          </div>
          {(targetAcos > 0 || targetRoas > 0) && (
            <div className="flex items-center gap-3 text-xs text-slate-400">
              {targetAcos > 0 && <span>Meta ACoS: <span className="text-white font-semibold">{targetAcos}%</span></span>}
              {targetRoas > 0 && <span>Meta ROAS: <span className="text-white font-semibold">{targetRoas}x</span></span>}
              <span className="text-emerald-400 font-semibold">{onTarget}/{activeCampaigns.length} na meta</span>
            </div>
          )}
        </div>

        {/* KPIs consolidados */}
        <div className="grid grid-cols-4 gap-3 mt-3">
          {[
            { label: 'ACoS Consolidado', value: consolidatedAcos > 0 ? `${consolidatedAcos.toFixed(1)}%` : '—', ok: targetAcos > 0 ? consolidatedAcos <= targetAcos : null, lowerBetter: true },
            { label: 'ROAS Consolidado', value: consolidatedRoas > 0 ? `${consolidatedRoas.toFixed(2)}x` : '—', ok: targetRoas > 0 ? consolidatedRoas >= targetRoas : null, lowerBetter: false },
            { label: 'Spend Total', value: `R$${totalSpend.toFixed(2)}`, ok: null },
            { label: 'Vendas Ads', value: `R$${totalSales.toFixed(2)}`, ok: null },
          ].map((kpi, i) => (
            <div key={i} className="bg-surface-2 rounded-lg p-3">
              <p className="text-[10px] text-slate-500 mb-1">{kpi.label}</p>
              <p className={`text-base font-bold ${
                kpi.ok === null ? 'text-white' :
                kpi.ok ? 'text-emerald-400' : 'text-red-400'
              }`}>{kpi.value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Filtros e busca */}
      <div className="px-5 py-3 border-b border-surface-2 flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
          <input
            type="text"
            placeholder="Buscar por nome ou ASIN..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 bg-surface-2 border border-surface-3 rounded-lg text-xs text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan/50"
          />
        </div>
        <div className="flex gap-1">
          {[
            { key: 'all', label: 'Todas' },
            { key: 'ok', label: '✓ Na meta' },
            { key: 'warn', label: '⚠ Fora da meta' },
          ].map(f => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${filter === f.key ? 'bg-cyan/20 text-cyan border border-cyan/30' : 'bg-surface-2 text-slate-500 border border-surface-3 hover:text-slate-300'}`}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tabela */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-surface-2">
              <th className="px-4 py-2.5 text-left text-[10px] font-semibold text-slate-500 uppercase">Campanha</th>
              <th className="px-4 py-2.5 text-left text-[10px] font-semibold text-slate-500 uppercase w-20">ASIN</th>
              <th className="px-3 py-2.5 text-left text-[10px] font-semibold text-slate-500 uppercase cursor-pointer hover:text-slate-300 select-none"
                onClick={() => toggleSort('acos')}>
                <span className="flex items-center gap-1">ACoS <SortIcon col="acos" /></span>
              </th>
              <th className="px-3 py-2.5 text-left text-[10px] font-semibold text-slate-500 uppercase cursor-pointer hover:text-slate-300 select-none"
                onClick={() => toggleSort('roas')}>
                <span className="flex items-center gap-1">ROAS <SortIcon col="roas" /></span>
              </th>
              <th className="px-3 py-2.5 text-left text-[10px] font-semibold text-slate-500 uppercase cursor-pointer hover:text-slate-300 select-none"
                onClick={() => toggleSort('spend')}>
                <span className="flex items-center gap-1">Spend <SortIcon col="spend" /></span>
              </th>
              <th className="px-3 py-2.5 text-left text-[10px] font-semibold text-slate-500 uppercase cursor-pointer hover:text-slate-300 select-none"
                onClick={() => toggleSort('sales')}>
                <span className="flex items-center gap-1">Vendas <SortIcon col="sales" /></span>
              </th>
              <th className="px-3 py-2.5 text-left text-[10px] font-semibold text-slate-500 uppercase cursor-pointer hover:text-slate-300 select-none"
                onClick={() => toggleSort('clicks')}>
                <span className="flex items-center gap-1">Cliques <SortIcon col="clicks" /></span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-slate-500">Nenhuma campanha encontrada</td>
              </tr>
            ) : sorted.map(c => {
              const acos = c.acos || 0;
              const roas = c.roas || 0;
              const spend = c.spend || 0;
              const sales = c.sales || 0;
              const acosOk = targetAcos > 0 && acos > 0 ? acos <= targetAcos : null;
              const acosWarn = targetAcos > 0 && acos > 0 ? acos > targetAcos && acos <= targetAcos * 1.3 : false;
              const roasOk = targetRoas > 0 && roas > 0 ? roas >= targetRoas : null;
              const acosColor = acosOk === null ? 'text-slate-400' : acosOk ? 'text-emerald-400' : acosWarn ? 'text-amber-400' : 'text-red-400';
              const roasColor = roasOk === null ? 'text-slate-400' : roasOk ? 'text-emerald-400' : 'text-red-400';
              const name = c.name || c.campaign_name || `Campanha ${c.campaign_id?.slice(-6)}`;
              const isManual = name.includes('MANUAL') || name.includes('EXACT');
              const isAuto = name.includes('AUTO') && !isManual;

              return (
                <tr key={c.id} className="border-b border-surface-2/40 hover:bg-surface-2/50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <StatusDot value={acos > 0 ? acos : null} target={targetAcos} lowerIsBetter />
                      <div>
                        <p className="text-slate-200 font-medium truncate max-w-[220px]" title={name}>{name}</p>
                        <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded ${isAuto ? 'bg-cyan/15 text-cyan' : isManual ? 'bg-purple-500/15 text-purple-400' : 'bg-surface-3 text-slate-500'}`}>
                          {isAuto ? 'AUTO' : isManual ? 'MANUAL' : 'SP'}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-[10px] text-slate-400">{c.asin || '—'}</td>
                  <td className="px-3 py-3">
                    <div className="space-y-1">
                      <span className={`font-bold ${acosColor}`}>{acos > 0 ? `${acos.toFixed(1)}%` : '—'}</span>
                      {acos > 0 && <AcosBar value={acos} target={targetAcos} max={maxAcos} />}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-1">
                      <span className={`font-bold ${roasColor}`}>{roas > 0 ? `${roas.toFixed(2)}x` : '—'}</span>
                      {roas > 0 && (roasOk
                        ? <TrendingUp className="w-3 h-3 text-emerald-400" />
                        : <TrendingDown className="w-3 h-3 text-red-400" />
                      )}
                    </div>
                    {targetRoas > 0 && roas > 0 && (
                      <p className="text-[9px] text-slate-600 mt-0.5">meta: {targetRoas}x</p>
                    )}
                  </td>
                  <td className="px-3 py-3 text-slate-300 font-semibold">{spend > 0 ? `R$${spend.toFixed(2)}` : '—'}</td>
                  <td className="px-3 py-3 text-emerald-400 font-semibold">{sales > 0 ? `R$${sales.toFixed(2)}` : '—'}</td>
                  <td className="px-3 py-3 text-slate-400">{(c.clicks || 0).toLocaleString('pt-BR')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {sorted.length > 0 && (
        <div className="px-5 py-2.5 border-t border-surface-2 text-[10px] text-slate-600">
          {sorted.length} campanhas exibidas · A barra de ACoS mostra o valor atual em relação ao máximo · A linha vertical indica a meta
        </div>
      )}
    </div>
  );
}