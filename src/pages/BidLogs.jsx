import { useState, useEffect, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { FileText, Search, Filter, Loader2, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ReferenceLine, ResponsiveContainer
} from 'recharts';

export default function BidLogs() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [targetAcos, setTargetAcos] = useState(null);

  useEffect(() => {
    load();
  }, []);

  const load = async () => {
    setLoading(true);
    try {
      const [allLogs, accounts] = await Promise.all([
        base44.entities.CampaignCreationLog.filter({ operation_type: 'update_bid' }, '-created_at', 200),
        base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, null, 1),
      ]);
      setLogs(allLogs);
      if (accounts[0]) {
        const ps = await base44.asServiceRole.entities.PerformanceSettings.filter(
          { amazon_account_id: accounts[0].id }, '-updated_at', 1
        );
        if (ps[0]?.target_acos > 0) setTargetAcos(ps[0].target_acos);
      }
    } finally {
      setLoading(false);
    }
  };

  const filtered = logs.filter(log => {
    const matchFilter =
      filter === 'all' ? true :
      filter === 'increase' ? (log.new_bid || 0) > (log.old_bid || 0) :
      filter === 'decrease' ? (log.new_bid || 0) < (log.old_bid || 0) :
      true;
    
    const matchSearch = !search || (
      (log.keyword_text || '').toLowerCase().includes(search.toLowerCase()) ||
      (log.asin || '').toLowerCase().includes(search.toLowerCase()) ||
      (log.rationale || '').toLowerCase().includes(search.toLowerCase())
    );
    
    return matchFilter && matchSearch;
  });

  // Agrupar por dia: bid médio novo, bid médio antigo, ACoS real médio
  const chartData = useMemo(() => {
    const byDate = {};
    for (const log of logs) {
      const raw = log.created_at;
      if (!raw) continue;
      const day = new Date(raw).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
      if (!byDate[day]) byDate[day] = { date: day, bids: [], oldBids: [], acos: [] };
      if (log.new_bid > 0) byDate[day].bids.push(log.new_bid);
      if (log.old_bid > 0) byDate[day].oldBids.push(log.old_bid);
      if (log.acos > 0) byDate[day].acos.push(log.acos);
    }
    return Object.values(byDate).slice(-30).map(d => ({
      date: d.date,
      'Bid Aplicado': d.bids.length ? +(d.bids.reduce((a, b) => a + b, 0) / d.bids.length).toFixed(2) : null,
      'Bid Anterior': d.oldBids.length ? +(d.oldBids.reduce((a, b) => a + b, 0) / d.oldBids.length).toFixed(2) : null,
      ...(d.acos.length ? { 'ACoS Real (%)': +(d.acos.reduce((a, b) => a + b, 0) / d.acos.length).toFixed(1) } : {}),
    }));
  }, [logs]);

  const stats = {
    total: logs.length,
    increases: logs.filter(l => (l.new_bid || 0) > (l.old_bid || 0)).length,
    decreases: logs.filter(l => (l.new_bid || 0) < (l.old_bid || 0)).length,
    unchanged: logs.filter(l => (l.new_bid || 0) === (l.old_bid || 0)).length,
  };

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
            <FileText className="w-5 h-5 text-cyan" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Histórico de Bids</h1>
            <p className="text-xs text-slate-400">Auditoria de alterações automáticas e manuais</p>
          </div>
        </div>
        <button onClick={load} disabled={loading}
          className="p-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors">
          <Loader2 className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3">
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
          <p className="text-xs text-slate-500 mb-1">Total</p>
          <p className="text-xl font-bold text-white">{stats.total}</p>
        </div>
        <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4">
          <p className="text-xs text-emerald-400 mb-1">Aumentos</p>
          <p className="text-xl font-bold text-emerald-400">{stats.increases}</p>
        </div>
        <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-4">
          <p className="text-xs text-red-400 mb-1">Reduções</p>
          <p className="text-xl font-bold text-red-400">{stats.decreases}</p>
        </div>
        <div className="bg-slate-500/5 border border-slate-500/20 rounded-xl p-4">
          <p className="text-xs text-slate-500 mb-1">Inalterados</p>
          <p className="text-xl font-bold text-slate-400">{stats.unchanged}</p>
        </div>
      </div>

      {/* Bid Evolution Chart */}
      {!loading && chartData.length > 1 && (
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
          <div className="mb-3">
            <h2 className="text-sm font-semibold text-slate-300">Evolução dos Lances</h2>
            <p className="text-xs text-slate-500 mt-0.5">Bid médio diário aplicado pelo motor vs. bid anterior{targetAcos ? ` · Meta ACoS: ${targetAcos}%` : ''}</p>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={chartData} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
              <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
              <YAxis yAxisId="bid" tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} width={40}
                tickFormatter={v => `R$${v}`} />
              {chartData.some(d => d['ACoS Real (%)'] != null) && (
                <YAxis yAxisId="acos" orientation="right" tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} width={36}
                  tickFormatter={v => `${v}%`} />
              )}
              <Tooltip
                contentStyle={{ backgroundColor: '#111827', border: '1px solid #263244', borderRadius: 8, fontSize: 11 }}
                labelStyle={{ color: '#CBD5E1' }}
                formatter={(val, name) => [name.includes('%') ? `${val}%` : `R$ ${val}`, name]}
              />
              <Legend wrapperStyle={{ fontSize: 10, color: '#94A3B8' }} />
              <Line yAxisId="bid" type="monotone" dataKey="Bid Anterior" stroke="#475569" strokeWidth={1.5} dot={false} strokeDasharray="4 2" connectNulls />
              <Line yAxisId="bid" type="monotone" dataKey="Bid Aplicado" stroke="#3B82F6" strokeWidth={2} dot={{ r: 3, fill: '#3B82F6' }} connectNulls />
              {chartData.some(d => d['ACoS Real (%)'] != null) && (
                <Line yAxisId="acos" type="monotone" dataKey="ACoS Real (%)" stroke="#F59E0B" strokeWidth={1.5} dot={false} connectNulls />
              )}
              {targetAcos && (
                <ReferenceLine yAxisId="acos" y={targetAcos} stroke="#10B981" strokeDasharray="5 3" strokeWidth={1.5}
                  label={{ value: `Meta ${targetAcos}%`, position: 'insideTopRight', fill: '#10B981', fontSize: 9 }} />
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-shrink-0 sm:w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Pesquisar keyword, ASIN..."
            className="w-full pl-10 pr-4 py-2.5 bg-surface-1 border border-surface-2 rounded-lg text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan/50" />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Filter className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
          {[
            { key: 'all', label: `Todos (${stats.total})` },
            { key: 'increase', label: `Aumentos (${stats.increases})` },
            { key: 'decrease', label: `Reduções (${stats.decreases})` },
            { key: 'unchanged', label: `Inalterados (${stats.unchanged})` },
          ].map(f => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors whitespace-nowrap ${
                filter === f.key
                  ? 'bg-cyan/20 text-cyan border-cyan/30'
                  : 'bg-surface-2 text-slate-500 border-surface-3 hover:text-slate-300'
              }`}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-7 h-7 text-cyan animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
          <FileText className="w-12 h-12 text-slate-600" />
          <p className="text-sm text-slate-400">Nenhum log encontrado.</p>
        </div>
      ) : (
        <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-2 bg-surface-2/40">
                  {['Data', 'Keyword', 'ASIN', 'Bid Anterior', 'Novo Bid', 'Direção', 'Justificativa'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(log => {
                  const oldBid = log.old_bid || 0;
                  const newBid = log.new_bid || 0;
                  const direction = newBid > oldBid ? 'increase' : newBid < oldBid ? 'decrease' : 'unchanged';
                  
                  return (
                    <tr key={log.id} className="border-b border-surface-2/40 hover:bg-surface-2/30 transition-colors">
                      <td className="px-4 py-3 text-xs text-slate-400 whitespace-nowrap">
                        {log.created_at ? new Date(log.created_at).toLocaleString('pt-BR') : '—'}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-200 max-w-[200px] truncate">
                        {log.keyword_text || log.keyword || '—'}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-400 font-mono">
                        {log.asin || '—'}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-400">
                        R$ {oldBid.toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-xs font-semibold">
                        R$ {newBid.toFixed(2)}
                      </td>
                      <td className="px-4 py-3">
                        {direction === 'increase' ? (
                          <span className="flex items-center gap-1 text-xs text-emerald-400">
                            <TrendingUp className="w-3 h-3" /> +R$ {(newBid - oldBid).toFixed(2)}
                          </span>
                        ) : direction === 'decrease' ? (
                          <span className="flex items-center gap-1 text-xs text-red-400">
                            <TrendingDown className="w-3 h-3" /> -R$ {(oldBid - newBid).toFixed(2)}
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-xs text-slate-500">
                            <Minus className="w-3 h-3" /> —
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-400 max-w-[300px] truncate" title={log.rationale}>
                        {log.rationale || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}