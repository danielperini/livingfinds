import { useState, useEffect, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import {
  TrendingUp, TrendingDown, Minus, Search, Filter, Loader2,
  RefreshCw, ChevronDown, ChevronRight, BarChart2, List
} from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ReferenceLine, ResponsiveContainer
} from 'recharts';

const riskColor = { low: 'text-emerald-400', medium: 'text-amber-400', high: 'text-red-400' };
const riskBg   = { low: 'bg-emerald-500/10 border-emerald-500/20', medium: 'bg-amber-500/10 border-amber-500/20', high: 'bg-red-500/10 border-red-500/20' };
const statusBg = {
  executed: 'bg-emerald-500/10 text-emerald-400',
  pending:  'bg-amber-500/10 text-amber-400',
  failed:   'bg-red-500/10 text-red-400',
  skipped:  'bg-slate-500/10 text-slate-400',
};

function fmtBRL(v) { return `R$ ${Number(v || 0).toFixed(2)}`; }
function fmtDate(raw) {
  if (!raw) return '—';
  return new Date(raw).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function fmtDay(raw) {
  if (!raw) return '';
  return new Date(raw).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

// ── Linha da tabela agrupada por campanha ────────────────────────────────────
function CampaignGroup({ campaignName, items }) {
  const [open, setOpen] = useState(false);
  const increases = items.filter(i => i.direction === 'increase').length;
  const decreases = items.filter(i => i.direction === 'decrease').length;
  const avgNew = items.reduce((s, i) => s + (i.new_bid || 0), 0) / items.length;

  return (
    <div className="border border-surface-2 rounded-xl overflow-hidden mb-2">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 bg-surface-2/40 hover:bg-surface-2/70 transition-colors text-left"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />}
        <span className="flex-1 text-xs font-semibold text-slate-200 truncate">{campaignName || 'Campanha desconhecida'}</span>
        <span className="text-[10px] text-slate-500 flex-shrink-0">{items.length} ajuste{items.length !== 1 ? 's' : ''}</span>
        <span className="text-[10px] text-emerald-400 flex-shrink-0">↑{increases}</span>
        <span className="text-[10px] text-red-400 flex-shrink-0">↓{decreases}</span>
        <span className="text-[10px] text-cyan flex-shrink-0">Bid médio: {fmtBRL(avgNew)}</span>
      </button>

      {open && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-surface-2 bg-surface-1">
                {['Data', 'Keyword', 'ASIN', 'Bid Ant.', 'Novo Bid', 'Δ', 'Risco', 'Status', 'Motivo'].map(h => (
                  <th key={h} className="px-3 py-2 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map(log => {
                const delta = (log.new_bid || 0) - (log.old_bid || 0);
                return (
                  <tr key={log.id} className="border-b border-surface-2/30 hover:bg-surface-2/20 transition-colors">
                    <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{fmtDate(log.created_at || log.created_date)}</td>
                    <td className="px-3 py-2 text-slate-200 max-w-[160px] truncate" title={log.keyword}>{log.keyword || '—'}</td>
                    <td className="px-3 py-2 text-slate-400 font-mono">{log.asin || '—'}</td>
                    <td className="px-3 py-2 text-slate-400">{fmtBRL(log.old_bid)}</td>
                    <td className="px-3 py-2 font-semibold text-white">{fmtBRL(log.new_bid)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {log.direction === 'increase' ? (
                        <span className="flex items-center gap-1 text-emerald-400"><TrendingUp className="w-3 h-3" />+{fmtBRL(delta)}</span>
                      ) : log.direction === 'decrease' ? (
                        <span className="flex items-center gap-1 text-red-400"><TrendingDown className="w-3 h-3" />{fmtBRL(delta)}</span>
                      ) : (
                        <span className="flex items-center gap-1 text-slate-500"><Minus className="w-3 h-3" />—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {log.risk_level && (
                        <span className={`px-1.5 py-0.5 rounded text-[10px] border ${riskBg[log.risk_level]}`}>
                          {log.risk_level}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {log.status && (
                        <span className={`px-1.5 py-0.5 rounded text-[10px] ${statusBg[log.status] || 'text-slate-400'}`}>
                          {log.status}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-400 max-w-[220px] truncate" title={log.reason}>{log.reason || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Gráfico de evolução ──────────────────────────────────────────────────────
function BidEvolutionChart({ logs, targetAcos }) {
  const data = useMemo(() => {
    const byDay = {};
    for (const log of logs) {
      const raw = log.created_at || log.created_date;
      if (!raw) continue;
      const day = fmtDay(raw);
      const isoDay = new Date(raw).toISOString().slice(0, 10);
      if (!byDay[isoDay]) byDay[isoDay] = { date: day, newBids: [], oldBids: [] };
      if (log.new_bid > 0) byDay[isoDay].newBids.push(log.new_bid);
      if (log.old_bid > 0) byDay[isoDay].oldBids.push(log.old_bid);
    }
    return Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b)).slice(-30).map(([, d]) => ({
      date: d.date,
      'Bid Aplicado': d.newBids.length ? +(d.newBids.reduce((a, b) => a + b, 0) / d.newBids.length).toFixed(2) : null,
      'Bid Anterior': d.oldBids.length ? +(d.oldBids.reduce((a, b) => a + b, 0) / d.oldBids.length).toFixed(2) : null,
    }));
  }, [logs]);

  if (data.length < 2) return null;

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-slate-300">Evolução dos Lances pelo Motor</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Bid médio diário aplicado vs. bid anterior{targetAcos ? ` · Meta ACoS: ${targetAcos}%` : ''}
        </p>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={data} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
          <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} width={42} tickFormatter={v => `R$${v}`} />
          <Tooltip
            contentStyle={{ backgroundColor: '#111827', border: '1px solid #263244', borderRadius: 8, fontSize: 11 }}
            formatter={(v, n) => [`R$ ${v}`, n]}
          />
          <Legend wrapperStyle={{ fontSize: 10, color: '#94A3B8' }} />
          <Line type="monotone" dataKey="Bid Anterior" stroke="#475569" strokeWidth={1.5} dot={false} strokeDasharray="4 2" connectNulls />
          <Line type="monotone" dataKey="Bid Aplicado" stroke="#3B82F6" strokeWidth={2} dot={{ r: 3, fill: '#3B82F6' }} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Página principal ─────────────────────────────────────────────────────────
export default function BidLogs() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [dirFilter, setDirFilter] = useState('all');
  const [viewMode, setViewMode] = useState('campaign'); // campaign | flat
  const [targetAcos, setTargetAcos] = useState(null);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, null, 1);
      const aid = accounts[0]?.id;
      if (!aid) return;

      const [bidLogs, ps] = await Promise.all([
        base44.asServiceRole.entities.AdsBidChangeLog.filter({ amazon_account_id: aid }, '-created_date', 300),
        base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, '-updated_at', 1),
      ]);

      setLogs(bidLogs);
      if (ps[0]?.target_acos > 0) setTargetAcos(ps[0].target_acos);
    } finally {
      setLoading(false);
    }
  };

  const filtered = useMemo(() => logs.filter(log => {
    const matchDir = dirFilter === 'all' || log.direction === dirFilter;
    const q = search.toLowerCase();
    const matchSearch = !search || (
      (log.keyword || '').toLowerCase().includes(q) ||
      (log.asin || '').toLowerCase().includes(q) ||
      (log.campaign_name || '').toLowerCase().includes(q) ||
      (log.reason || '').toLowerCase().includes(q)
    );
    return matchDir && matchSearch;
  }), [logs, dirFilter, search]);

  const stats = useMemo(() => ({
    total: logs.length,
    increases: logs.filter(l => l.direction === 'increase').length,
    decreases: logs.filter(l => l.direction === 'decrease').length,
    executed: logs.filter(l => l.status === 'executed').length,
  }), [logs]);

  // Agrupado por campanha
  const byCampaign = useMemo(() => {
    const map = {};
    for (const log of filtered) {
      const key = log.campaign_id || log.campaign_name || 'sem_campanha';
      const label = log.campaign_name || log.campaign_id || 'Sem campanha';
      if (!map[key]) map[key] = { label, items: [] };
      map[key].items.push(log);
    }
    return Object.values(map).sort((a, b) => b.items.length - a.items.length);
  }, [filtered]);

  return (
    <div className="p-6 space-y-5 animate-fade-in">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
            <TrendingUp className="w-5 h-5 text-cyan" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Gestão de Lances do Motor</h1>
            <p className="text-xs text-slate-400">Histórico de ajustes automáticos por produto e campanha</p>
          </div>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-2 px-3 py-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors text-xs">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Atualizar
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
          <p className="text-xs text-slate-500 mb-1">Total de Ajustes</p>
          <p className="text-2xl font-bold text-white">{stats.total}</p>
        </div>
        <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4">
          <p className="text-xs text-emerald-400 mb-1">Aumentos</p>
          <p className="text-2xl font-bold text-emerald-400">{stats.increases}</p>
        </div>
        <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-4">
          <p className="text-xs text-red-400 mb-1">Reduções</p>
          <p className="text-2xl font-bold text-red-400">{stats.decreases}</p>
        </div>
        <div className="bg-cyan/5 border border-cyan/20 rounded-xl p-4">
          <p className="text-xs text-cyan mb-1">Executados</p>
          <p className="text-2xl font-bold text-cyan">{stats.executed}</p>
        </div>
      </div>

      {/* Gráfico */}
      {!loading && <BidEvolutionChart logs={logs} targetAcos={targetAcos} />}

      {/* Controles */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
        <div className="relative flex-shrink-0 sm:w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Keyword, ASIN, campanha..."
            className="w-full pl-10 pr-4 py-2.5 bg-surface-1 border border-surface-2 rounded-lg text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan/50" />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Filter className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
          {[
            { key: 'all', label: 'Todos' },
            { key: 'increase', label: '↑ Aumentos' },
            { key: 'decrease', label: '↓ Reduções' },
            { key: 'unchanged', label: '= Inalterados' },
          ].map(f => (
            <button key={f.key} onClick={() => setDirFilter(f.key)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors whitespace-nowrap ${
                dirFilter === f.key ? 'bg-cyan/20 text-cyan border-cyan/30' : 'bg-surface-2 text-slate-500 border-surface-3 hover:text-slate-300'
              }`}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1.5 bg-surface-2 border border-surface-3 rounded-lg p-0.5">
          <button onClick={() => setViewMode('campaign')}
            className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded transition-colors ${viewMode === 'campaign' ? 'bg-cyan/20 text-cyan' : 'text-slate-500 hover:text-slate-300'}`}>
            <BarChart2 className="w-3 h-3" /> Por Campanha
          </button>
          <button onClick={() => setViewMode('flat')}
            className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded transition-colors ${viewMode === 'flat' ? 'bg-cyan/20 text-cyan' : 'text-slate-500 hover:text-slate-300'}`}>
            <List className="w-3 h-3" /> Lista Plana
          </button>
        </div>
      </div>

      {/* Conteúdo */}
      {loading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-7 h-7 text-cyan animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
          <TrendingUp className="w-12 h-12 text-slate-600" />
          <p className="text-sm text-slate-400">Nenhum ajuste de lance encontrado.</p>
          <p className="text-xs text-slate-600">Os lances aplicados pelo motor aparecerão aqui.</p>
        </div>
      ) : viewMode === 'campaign' ? (
        <div>
          <p className="text-xs text-slate-500 mb-3">{byCampaign.length} campanha{byCampaign.length !== 1 ? 's' : ''} · {filtered.length} ajustes</p>
          {byCampaign.map(({ label, items }) => (
            <CampaignGroup key={label} campaignName={label} items={items} />
          ))}
        </div>
      ) : (
        <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-surface-2 bg-surface-2/40">
                  {['Data', 'Campanha', 'Keyword', 'ASIN', 'Bid Ant.', 'Novo Bid', 'Δ', 'Risco', 'Status', 'Motivo'].map(h => (
                    <th key={h} className="px-3 py-3 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(log => {
                  const delta = (log.new_bid || 0) - (log.old_bid || 0);
                  return (
                    <tr key={log.id} className="border-b border-surface-2/30 hover:bg-surface-2/20 transition-colors">
                      <td className="px-3 py-2.5 text-slate-400 whitespace-nowrap">{fmtDate(log.created_at || log.created_date)}</td>
                      <td className="px-3 py-2.5 text-slate-300 max-w-[140px] truncate" title={log.campaign_name}>{log.campaign_name || log.campaign_id || '—'}</td>
                      <td className="px-3 py-2.5 text-slate-200 max-w-[140px] truncate" title={log.keyword}>{log.keyword || '—'}</td>
                      <td className="px-3 py-2.5 text-slate-400 font-mono">{log.asin || '—'}</td>
                      <td className="px-3 py-2.5 text-slate-400">{fmtBRL(log.old_bid)}</td>
                      <td className="px-3 py-2.5 font-semibold text-white">{fmtBRL(log.new_bid)}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        {log.direction === 'increase' ? (
                          <span className="flex items-center gap-1 text-emerald-400"><TrendingUp className="w-3 h-3" />+{fmtBRL(delta)}</span>
                        ) : log.direction === 'decrease' ? (
                          <span className="flex items-center gap-1 text-red-400"><TrendingDown className="w-3 h-3" />{fmtBRL(delta)}</span>
                        ) : (
                          <span className="text-slate-500">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        {log.risk_level && (
                          <span className={`px-1.5 py-0.5 rounded text-[10px] border ${riskBg[log.risk_level] || ''}`}>{log.risk_level}</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        {log.status && (
                          <span className={`px-1.5 py-0.5 rounded text-[10px] ${statusBg[log.status] || 'text-slate-400'}`}>{log.status}</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-slate-400 max-w-[200px] truncate" title={log.reason}>{log.reason || '—'}</td>
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