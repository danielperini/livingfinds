import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { FileText, Search, Filter, Loader2, TrendingUp, TrendingDown, Minus } from 'lucide-react';

export default function BidLogs() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all'); // all | increase | decrease | unchanged
  const [search, setSearch] = useState('');

  useEffect(() => {
    load();
  }, []);

  const load = async () => {
    setLoading(true);
    try {
      const allLogs = await base44.entities.CampaignCreationLog.filter(
        { operation_type: 'update_bid' },
        '-created_at',
        200
      );
      setLogs(allLogs);
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