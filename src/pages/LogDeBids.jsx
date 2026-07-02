import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  FileText, Search, RefreshCw, Loader2,
  Minus, XCircle, Filter, TrendingUp, TrendingDown, Download
} from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';

export default function LogDeBids() {
  const [account, setAccount] = useState(null);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ direction: 'all', status: 'all', date: '' });
  const [error, setError] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accounts[0] || (await base44.entities.AmazonAccount.list())[0];
      setAccount(acc);
      if (!acc) return;

      // Buscar de 3 fontes: AdsBidChangeLog, OptimizationDecision e CampaignChangeHistory
      const [apiLogs, autopilotDecs, campaignHistory] = await Promise.all([
        base44.entities.AdsBidChangeLog.filter({ amazon_account_id: acc.id }, '-created_at', 300),
        base44.entities.OptimizationDecision.filter(
          { amazon_account_id: acc.id, decision_type: 'bid_change' }, '-created_at', 300
        ),
        base44.entities.CampaignChangeHistory.filter(
          { amazon_account_id: acc.id, change_type: 'BASE_BID' }, '-changed_at', 300
        ),
      ]);

      // Normalizar OptimizationDecision
      const decLogs = autopilotDecs.map(d => ({
        id: `dec_${d.id}`,
        date: d.executed_at?.slice(0, 10) || d.created_at?.slice(0, 10) || '',
        campaign_id: d.campaign_id || '',
        campaign_name: '',
        keyword_id: d.keyword_id || d.entity_id || '',
        keyword: d.keyword_text || '',
        asin: d.asin || '',
        old_bid: d.value_before || 0,
        new_bid: d.value_after || 0,
        change_amount: (d.value_after || 0) - (d.value_before || 0),
        change_percent: d.change_pct || 0,
        direction: d.action?.includes('increase') ? 'increase' : d.action?.includes('reduce') ? 'decrease' : 'unchanged',
        reason: d.rationale?.slice(0, 120) || d.action || '',
        ai_confidence: d.confidence ? d.confidence / 100 : 0,
        risk_level: d.risk || 'low',
        status: d.status === 'executed' ? 'executed' : d.status === 'approved' ? 'pending' : d.status || 'pending',
        created_at: d.created_at || '',
        _source: 'autopilot',
      }));

      // Normalizar CampaignChangeHistory (BASE_BID)
      const histLogs = campaignHistory.map(h => {
        const oldVal = parseFloat(h.old_value) || 0;
        const newVal = parseFloat(h.new_value) || 0;
        const diff = newVal - oldVal;
        return {
          id: `hist_${h.id}`,
          date: h.changed_at?.slice(0, 10) || h.created_date?.slice(0, 10) || '',
          campaign_id: h.campaign_id || '',
          campaign_name: h.campaign_id || '',
          keyword_id: h.keyword_id || '',
          keyword: h.keyword_id || '',
          asin: '',
          old_bid: oldVal,
          new_bid: newVal,
          change_amount: diff,
          change_percent: oldVal > 0 ? ((diff / oldVal) * 100) : 0,
          direction: diff > 0.001 ? 'increase' : diff < -0.001 ? 'decrease' : 'unchanged',
          reason: h.reason || h.source || '',
          ai_confidence: 0,
          risk_level: 'low',
          status: h.status === 'executed' ? 'executed' : h.status || 'executed',
          created_at: h.changed_at || h.created_date || '',
          _source: 'history',
        };
      });

      // Unir e ordenar por data desc, deduplicar por keyword_id+date+direction
      const seen = new Set();
      const allLogs = [
        ...apiLogs.map(l => ({ ...l, _source: 'api' })),
        ...decLogs,
        ...histLogs,
      ]
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
        .filter(l => {
          const key = `${l.keyword_id}|${l.date}|${l.direction}|${l._source}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

      setLogs(allLogs);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  const syncFromApi = async () => {
    if (!account || syncing) return;
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await base44.functions.invoke('syncBidChangesFromApi', { amazon_account_id: account.id });
      const d = res.data;
      if (d?.ok) {
        setSyncMsg({ type: 'success', text: `✓ ${d.keywords_synced} keywords sincronizadas · ${d.changes} alterações detectadas (↑${d.increases} ↓${d.decreases})` });
        await load();
      } else {
        setSyncMsg({ type: 'error', text: d?.error || 'Falha na sincronização' });
      }
    } catch (e) {
      setSyncMsg({ type: 'error', text: e.message });
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMsg(null), 12000);
    }
  };

  useEffect(() => { load(); }, [load]);

  const filtered = logs.filter(l => {
    const matchSearch = !search || (
      (l.keyword || '').toLowerCase().includes(search.toLowerCase()) ||
      (l.asin || '').toLowerCase().includes(search.toLowerCase()) ||
      (l.campaign_name || l.campaign_id || '').toLowerCase().includes(search.toLowerCase())
    );
    const matchDirection = filters.direction === 'all' || l.direction === filters.direction;
    const matchStatus = filters.status === 'all' || l.status === filters.status;
    const matchDate = !filters.date || l.date === filters.date;
    return matchSearch && matchDirection && matchStatus && matchDate;
  });

  // KPIs
  const total = filtered.length;
  const aumento = filtered.filter(l => l.direction === 'increase').length;
  const reducao = filtered.filter(l => l.direction === 'decrease').length;
  const erros = filtered.filter(l => l.status === 'failed').length;
  const executed = filtered.filter(l => l.status === 'executed').length;
  const pctChange = total > 0 ? ((aumento - reducao) / total * 100).toFixed(1) : 0;

  // Filtrar apenas as alterações executadas para impacto em ACOS
  const executedChanges = filtered.filter(l => l.status === 'executed' && l.direction !== 'unchanged');
  const savingsEstimate = executedChanges.reduce((s, l) => {
    const diff = (l.old_bid || 0) - (l.new_bid || 0);
    return s + (diff > 0 ? diff : 0);
  }, 0);
  const increaseEstimate = executedChanges.reduce((s, l) => {
    const diff = (l.new_bid || 0) - (l.old_bid || 0);
    return s + (diff > 0 ? diff : 0);
  }, 0);

  const filterButtons = [
    { key: 'all', label: 'Todos' },
    { key: 'increase', label: '↑ Aumentos', icon: TrendingUp },
    { key: 'decrease', label: '↓ Reduções', icon: TrendingDown },
    { key: 'unchanged', label: '— iguais', icon: Minus },
  ];

  const statusFilterButtons = [
    { key: 'all', label: 'Todos' },
    { key: 'executed', label: '✓ Executadas' },
    { key: 'failed', label: '⚠ Falhas' },
    { key: 'pending', label: '⌛ Pendentes' },
    { key: 'skipped', label: '↷ Ignoradas' },
  ];

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
            <FileText className="w-5 h-5 text-cyan" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Log de Bids</h1>
            <p className="text-xs text-slate-400">{total} alterações · {aumento} aumentos · {reducao} reduções</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={syncFromApi} disabled={syncing || loading || !account}
            className="flex items-center gap-2 px-3 py-2 bg-cyan/10 border border-cyan/20 text-cyan hover:bg-cyan/20 text-xs font-semibold rounded-lg transition-colors disabled:opacity-50">
            <Download className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Sincronizando...' : 'Sincronizar via API'}
          </button>
          <button onClick={load} disabled={loading}
            className="flex items-center gap-2 px-3 py-2 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-sm rounded-lg transition-colors">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>
      {syncMsg && (
        <div className={`px-4 py-3 rounded-xl border text-sm font-medium ${syncMsg.type === 'success' ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300' : 'bg-red-400/10 border-red-400/20 text-red-400'}`}>
          {syncMsg.text}
        </div>
      )}

      {/* Filtros */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-shrink-0 sm:w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Pesquisar keyword, ASIN ou campanha..."
              className="w-full pl-10 pr-4 py-2 bg-surface-1 border border-surface-2 rounded-lg text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan/50" />
          </div>
          <input type="date" value={filters.date} onChange={e => setFilters(p => ({ ...p, date: e.target.value }))}
            className="px-3 py-2 bg-surface-1 border border-surface-2 rounded-lg text-sm text-slate-300 focus:outline-none focus:border-cyan/50 accent-cyan" />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Filter className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
          {filterButtons.map(f => (
            <button key={f.key} onClick={() => setFilters(p => ({ ...p, direction: f.key }))}
              className={`flex items-center gap-1 text-xs px-3 py-1.5 rounded-full border transition-colors ${filters.direction === f.key ? 'bg-cyan/20 text-cyan border-cyan/30' : 'bg-surface-2 text-slate-500 border-surface-3 hover:text-slate-300'}`}>
              {f.label}
            </button>
          ))}
          <span className="mx-1 w-px h-5 bg-surface-2" />
          {statusFilterButtons.map(f => (
            <button key={f.key} onClick={() => setFilters(p => ({ ...p, status: f.key }))}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${filters.status === f.key ? 'bg-cyan/20 text-cyan border-cyan/30' : 'bg-surface-2 text-slate-500 border-surface-3 hover:text-slate-300'}`}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-sm text-red-400">{error}</div>}

      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
      ) : (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { label: 'Total Alterações', value: total, color: 'text-white', sub: `${pctChange > 0 ? '+' : ''}${pctChange}%' direção` },
              { label: 'Aumentos', value: aumento, color: 'text-emerald-400', icon: TrendingUp },
              { label: 'Reduções', value: reducao, color: 'text-red-400', icon: TrendingDown },
              { label: 'Falhas', value: erros, color: erros > 0 ? 'text-red-400' : 'text-emerald-400', icon: XCircle },
            ].map(k => (
              <div key={k.label} className="bg-surface-1 border border-surface-2 rounded-xl p-4">
                <p className="text-xs text-slate-500 mb-1">{k.label}</p>
                <p className={`text-xl font-bold ${k.color}`}>{k.value}</p>
                {k.sub && <p className="text-xs text-slate-500 mt-1">{k.sub}</p>}
              </div>
            ))}
            {[
              { label: 'Executadas', value: executed, color: 'text-emerald-400' },
              { label: 'Aumento total (bid)', value: `R$${increaseEstimate.toFixed(2)}`, color: 'text-emerald-400' },
              { label: 'Redução total (bid)', value: `R$${savingsEstimate.toFixed(2)}`, color: 'text-red-400' },
            ].map(k => (
              <div key={k.label} className="bg-surface-1 border border-surface-2 rounded-xl p-4">
                <p className="text-xs text-slate-500 mb-1">{k.label}</p>
                <p className={`text-xl font-bold ${k.color}`}>{k.value}</p>
              </div>
            ))}
          </div>

          {/* Tabela */}
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
              <FileText className="w-12 h-12 text-slate-600" />
              <p className="text-sm text-slate-400">{logs.length === 0 ? 'Sem logs. Use "Sincronizar via API" para detectar alterações de bid, ou execute o Autopilot para gerar novas decisões.' : 'Nenhum resultado com estes filtros.'}</p>
            </div>
          ) : (
            <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-surface-2 bg-surface-2/40">
                      {['Data', 'Keyword', 'ASIN', 'Bid Antes', 'Bid Depois', 'Diferença', 'Variação', 'Direção', 'Motivo', 'Fonte', 'Estado'].map(h => (
                        <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(l => {
                      const isAu = l.direction === 'increase';
                      const isDown = l.direction === 'decrease';
                      const amount = (l.new_bid || 0) - (l.old_bid || 0);
                      const pct = l.change_percent || ((l.old_bid && l.new_bid) ? ((l.new_bid - l.old_bid) / l.old_bid * 100) : 0);
                      return (
                        <tr key={l.id} className="border-b border-surface-2/40 hover:bg-surface-2/30 transition-colors">
                          <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{l.date || l.created_at?.slice(0, 10) || '—'}</td>
                          <td className="px-4 py-3 text-xs text-white font-medium max-w-[180px]">
                            <p className="truncate">{l.keyword || '—'}</p>
                            {l.campaign_name && <p className="text-[10px] text-slate-500 truncate">{l.campaign_name}</p>}
                          </td>
                          <td className="px-4 py-3 font-mono text-xs text-cyan">{l.asin || '—'}</td>
                          <td className="px-4 py-3 font-mono text-xs text-slate-400">R${(l.old_bid || 0).toFixed(2)}</td>
                          <td className="px-4 py-3 font-mono text-xs text-white">R${(l.new_bid || 0).toFixed(2)}</td>
                          <td className={`px-4 py-3 font-mono text-xs font-semibold ${isAu ? 'text-emerald-400' : isDown ? 'text-red-400' : 'text-slate-500'}`}>
                            {isAu ? '+' : ''}R${Math.abs(amount).toFixed(2)}
                          </td>
                          <td className={`px-4 py-3 text-xs font-semibold ${isAu ? 'text-emerald-400' : isDown ? 'text-red-400' : 'text-slate-500'}`}>
                            {isAu ? '+' : ''}{Number(pct).toFixed(1)}%
                          </td>
                          <td className="px-4 py-3">
                            {isAu ? <TrendingUp className="w-4 h-4 text-emerald-400" /> : isDown ? <TrendingDown className="w-4 h-4 text-red-400" /> : <Minus className="w-4 h-4 text-slate-500" />}
                          </td>
                          <td className="px-4 py-3 text-xs text-slate-500 max-w-[180px] truncate" title={l.reason}>{l.reason || '—'}</td>
                          <td className="px-4 py-3">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${
                              l._source === 'autopilot' ? 'text-purple-400 bg-purple-400/10 border-purple-400/20' :
                              l._source === 'history'   ? 'text-amber-400 bg-amber-400/10 border-amber-400/20' :
                                                          'text-cyan bg-cyan/10 border-cyan/20'
                            }`}>
                              {l._source === 'autopilot' ? 'Autopilot' : l._source === 'history' ? 'Histórico' : 'API'}
                            </span>
                          </td>
                          <td className="px-4 py-3"><StatusBadge status={l.status || 'pending'} size="xs" /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}