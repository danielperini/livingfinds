import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { BookOpen, Search, RefreshCw, Loader2, TrendingUp, TrendingDown, Award, Zap, XCircle, BarChart2 } from 'lucide-react';

const CLASS_CONFIG = {
  winner:            { label: 'Vencedor',   color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
  learning:          { label: 'Aprendendo', color: 'text-cyan bg-cyan/10 border-cyan/20' },
  wasting:           { label: 'Desperdício',color: 'text-red-400 bg-red-400/10 border-red-400/20' },
  negative:          { label: 'Negativo',   color: 'text-slate-400 bg-slate-400/10 border-slate-400/20' },
  new:               { label: 'Novo',       color: 'text-amber-400 bg-amber-400/10 border-amber-400/20' },
  insufficient_data: { label: 'Poucos dados', color: 'text-slate-500 bg-slate-500/10 border-slate-500/20' },
};

const SOURCE_LABELS = {
  search_term_auto: 'AUTO',
  manual_kickoff:   'Kick-off',
  user_input:       'Manual',
  cross_asin:       'Cross-ASIN',
  ai_suggestion:    'IA',
  csv_import:       'CSV',
};

export default function TermBankPage() {
  const [account, setAccount] = useState(null);
  const [terms, setTerms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterClass, setFilterClass] = useState('all');
  const [filterAsin, setFilterAsin] = useState('all');
  const [sortBy, setSortBy] = useState('performance_score');
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accounts[0] || (await base44.entities.AmazonAccount.list())[0];
      setAccount(acc);
      if (!acc) return;
      const data = await base44.entities.TermBank.filter({ amazon_account_id: acc.id }, '-performance_score', 500);
      setTerms(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Lista de ASINs únicos para o filtro
  const uniqueAsins = [...new Set(terms.map(t => t.asin).filter(Boolean))];

  const filtered = terms
    .filter(t => {
      const q = search.toLowerCase();
      const matchSearch = !q || t.term?.toLowerCase().includes(q) || t.asin?.toLowerCase().includes(q) || t.product_name?.toLowerCase().includes(q);
      const matchClass = filterClass === 'all' || t.classification === filterClass;
      const matchAsin = filterAsin === 'all' || t.asin === filterAsin;
      return matchSearch && matchClass && matchAsin;
    })
    .sort((a, b) => {
      if (sortBy === 'performance_score') return (b.performance_score || 0) - (a.performance_score || 0);
      if (sortBy === 'orders') return (b.orders || 0) - (a.orders || 0);
      if (sortBy === 'spend') return (b.spend || 0) - (a.spend || 0);
      if (sortBy === 'acos') return (a.acos || 0) - (b.acos || 0);
      if (sortBy === 'term') return (a.term || '').localeCompare(b.term || '');
      return 0;
    });

  // KPIs
  const winners = terms.filter(t => t.classification === 'winner').length;
  const wasting = terms.filter(t => t.classification === 'wasting').length;
  const totalOrders = terms.reduce((s, t) => s + (t.orders || 0), 0);
  const totalSpend = terms.reduce((s, t) => s + (t.spend || 0), 0);
  const avgScore = terms.length > 0 ? Math.round(terms.reduce((s, t) => s + (t.performance_score || 0), 0) / terms.length) : 0;

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-violet-500/15 border border-violet-500/20 flex items-center justify-center">
            <BookOpen className="w-5 h-5 text-violet-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Banco de Termos</h1>
            <p className="text-xs text-slate-400">{terms.length} termos · {winners} vencedores · {wasting} desperdício</p>
          </div>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-2 px-3 py-2 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-sm rounded-lg transition-colors">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {[
          { label: 'Total de Termos', value: terms.length, color: 'text-white' },
          { label: 'Vencedores', value: winners, color: 'text-emerald-400' },
          { label: 'Desperdício', value: wasting, color: 'text-red-400' },
          { label: 'Total Pedidos', value: totalOrders, color: 'text-cyan' },
          { label: 'Score Médio', value: `${avgScore}/100`, color: 'text-violet-400' },
        ].map(k => (
          <div key={k.label} className="bg-surface-1 border border-surface-2 rounded-xl p-4">
            <p className="text-xs text-slate-500 mb-1">{k.label}</p>
            <p className={`text-xl font-bold ${k.color}`}>{k.value}</p>
          </div>
        ))}
      </div>

      {/* Filtros */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1 min-w-0 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Pesquisar termo, ASIN..."
            className="w-full pl-10 pr-4 py-2 bg-surface-1 border border-surface-2 rounded-lg text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan/50" />
        </div>
        <select value={filterClass} onChange={e => setFilterClass(e.target.value)}
          className="px-3 py-2 bg-surface-1 border border-surface-2 rounded-lg text-sm text-slate-300 focus:outline-none focus:border-cyan/50">
          <option value="all">Todas as classificações</option>
          {Object.entries(CLASS_CONFIG).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
        {uniqueAsins.length > 1 && (
          <select value={filterAsin} onChange={e => setFilterAsin(e.target.value)}
            className="px-3 py-2 bg-surface-1 border border-surface-2 rounded-lg text-sm text-slate-300 focus:outline-none focus:border-cyan/50">
            <option value="all">Todos os ASINs</option>
            {uniqueAsins.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        )}
        <select value={sortBy} onChange={e => setSortBy(e.target.value)}
          className="px-3 py-2 bg-surface-1 border border-surface-2 rounded-lg text-sm text-slate-300 focus:outline-none focus:border-cyan/50">
          <option value="performance_score">Score</option>
          <option value="orders">Pedidos</option>
          <option value="spend">Gasto</option>
          <option value="acos">ACoS</option>
          <option value="term">Termo A-Z</option>
        </select>
      </div>

      {error && <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-sm text-red-400">{error}</div>}

      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-violet-400 animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <BookOpen className="w-12 h-12 text-slate-600" />
          <p className="text-sm text-slate-400">
            {terms.length === 0
              ? 'O banco de termos está vazio. Os termos são adicionados automaticamente ao fazer kick-off de produtos ou quando a IA detecta termos convertidos.'
              : 'Nenhum resultado com estes filtros.'}
          </p>
        </div>
      ) : (
        <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-2 bg-surface-2/40">
                  {['Termo', 'ASIN / Produto', 'Classe', 'Score', 'Pedidos', 'Gasto', 'ACoS', 'ROAS', 'CPC', 'Bid Atual', 'Fonte', 'Cross-ASIN'].map(h => (
                    <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(t => {
                  const cls = CLASS_CONFIG[t.classification] || CLASS_CONFIG.new;
                  return (
                    <tr key={t.id} className="border-b border-surface-2/40 hover:bg-surface-2/30 transition-colors">
                      <td className="px-4 py-3">
                        <p className="text-white font-medium text-sm">{t.term}</p>
                        <p className="text-[10px] text-slate-500">{t.match_type}</p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-mono text-xs text-cyan">{t.asin}</p>
                        <p className="text-[10px] text-slate-500 truncate max-w-[140px]">{t.product_name || '—'}</p>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-semibold ${cls.color}`}>
                          {cls.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-16 h-1.5 bg-surface-3 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${(t.performance_score || 0) >= 60 ? 'bg-emerald-400' : (t.performance_score || 0) >= 30 ? 'bg-amber-400' : 'bg-red-400'}`}
                              style={{ width: `${t.performance_score || 0}%` }} />
                          </div>
                          <span className="text-xs text-white font-semibold">{t.performance_score || 0}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-cyan font-semibold text-sm">{t.orders || 0}</td>
                      <td className="px-4 py-3 text-slate-300 text-xs">R${(t.spend || 0).toFixed(2)}</td>
                      <td className={`px-4 py-3 text-xs font-semibold ${(t.acos || 0) === 0 ? 'text-slate-500' : (t.acos || 0) > 40 ? 'text-red-400' : (t.acos || 0) > 25 ? 'text-amber-400' : 'text-emerald-400'}`}>
                        {(t.acos || 0) > 0 ? `${(t.acos).toFixed(1)}%` : '—'}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-300">{(t.roas || 0) > 0 ? `${(t.roas).toFixed(2)}x` : '—'}</td>
                      <td className="px-4 py-3 text-xs text-slate-300">{(t.cpc || 0) > 0 ? `R$${(t.cpc).toFixed(2)}` : '—'}</td>
                      <td className="px-4 py-3 text-xs text-white font-mono">R${(t.bid_current || t.bid_initial || 0.50).toFixed(2)}</td>
                      <td className="px-4 py-3">
                        <span className="text-[10px] px-1.5 py-0.5 rounded border text-slate-400 bg-surface-2 border-surface-3">
                          {SOURCE_LABELS[t.source] || t.source}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {(t.compatible_asins || []).length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {(t.compatible_asins || []).slice(0, 3).map(a => (
                              <span key={a} className="text-[9px] px-1.5 py-0.5 rounded bg-violet-500/10 border border-violet-500/20 text-violet-400 font-mono">{a}</span>
                            ))}
                            {(t.compatible_asins || []).length > 3 && (
                              <span className="text-[9px] text-slate-500">+{(t.compatible_asins).length - 3}</span>
                            )}
                          </div>
                        ) : <span className="text-slate-600 text-xs">—</span>}
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