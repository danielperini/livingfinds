import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Search, Save, Loader2, CheckCircle, AlertCircle, Megaphone, Pause, Play, Brain, RefreshCw, TrendingUp, TrendingDown } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';

export default function AdsManagement() {
  const [account, setAccount] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [selectedCampaign, setSelectedCampaign] = useState(null);
  const [keywords, setKeywords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [kwLoading, setKwLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [pendingBids, setPendingBids] = useState({});
  const [saveState, setSaveState] = useState('idle');
  const [saveError, setSaveError] = useState(null);
  const [stateFilter, setStateFilter] = useState('all');

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const me = await base44.auth.me();
        const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
        const acc = accounts[0] || null;
        setAccount(acc);
        if (!acc) return;
        const cams = await base44.entities.Campaign.filter({ amazon_account_id: acc.id }, '-spend', 2000);
        setCampaigns(cams);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const selectCampaign = async (campaign) => {
    setSelectedCampaign(campaign);
    setPendingBids({});
    setKwLoading(true);
    try {
      const kws = await base44.entities.Keyword.filter({
        amazon_account_id: campaign.amazon_account_id,
        campaign_id: campaign.campaign_id,
      }, '-spend', 500);
      setKeywords(kws);
    } catch {
      setKeywords([]);
    } finally {
      setKwLoading(false);
    }
  };

  const applyBids = async () => {
    if (Object.keys(pendingBids).length === 0) return;
    setSaveState('loading');
    setSaveError(null);
    try {
      // Atualizar bids na entidade Keyword localmente
      const updates = Object.entries(pendingBids).map(([id, bid]) => ({ id, bid }));
      await base44.entities.Keyword.bulkUpdate(updates);
      // Refletir na lista
      setKeywords(prev => prev.map(kw => pendingBids[kw.id] !== undefined ? { ...kw, bid: pendingBids[kw.id] } : kw));
      setSaveState('success');
      setPendingBids({});
      setTimeout(() => setSaveState('idle'), 3000);
    } catch (err) {
      setSaveState('error');
      setSaveError(err.message || 'Erro ao aplicar bids');
      setTimeout(() => setSaveState('idle'), 4000);
    }
  };

  const hasPending = Object.keys(pendingBids).length > 0;

  const filtered = campaigns.filter(c => {
    const matchSearch = (c.name || '').toLowerCase().includes(search.toLowerCase());
    const matchState = stateFilter === 'all' || c.state === stateFilter;
    return matchSearch && matchState;
  });

  const totalSpend = campaigns.reduce((s, c) => s + (c.spend || 0), 0);
  const totalSales = campaigns.reduce((s, c) => s + (c.sales || 0), 0);
  const activeCount = campaigns.filter(c => c.state === 'enabled').length;
  const pausedCount = campaigns.filter(c => c.state === 'paused').length;

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div className="w-72 flex-shrink-0 border-r border-surface-2 bg-[#0D0F14] flex flex-col">
        <div className="p-4 border-b border-surface-2">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-white">Campanhas</h2>
            <span className="text-xs text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded-full">{campaigns.length} total</span>
          </div>

          {/* Filtros de estado */}
          <div className="flex gap-1 mb-3">
            {[
              { key: 'all', label: 'Todas' },
              { key: 'enabled', label: `Ativas (${activeCount})` },
              { key: 'paused', label: `Pausadas (${pausedCount})` },
            ].map(f => (
              <button key={f.key} onClick={() => setStateFilter(f.key)}
                className={`flex-1 text-xs py-1 rounded-lg transition-colors ${stateFilter === f.key ? 'bg-cyan/20 text-cyan border border-cyan/30' : 'bg-surface-2 text-slate-500 hover:text-slate-300'}`}>
                {f.label}
              </button>
            ))}
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Pesquisar..."
              className="w-full pl-8 pr-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-xs text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan/50" />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {loading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 text-cyan animate-spin" /></div>
          ) : filtered.length === 0 ? (
            <p className="text-xs text-slate-500 text-center py-8 px-4">Sem campanhas. Execute um Sync no Dashboard.</p>
          ) : (
            filtered.map((c, i) => {
              const isSelected = selectedCampaign?.id === c.id;
              const acosColor = (c.acos || 0) > 40 ? 'text-red-400' : (c.acos || 0) > 25 ? 'text-amber-400' : 'text-emerald-400';
              return (
                <div key={c.id || i} onClick={() => selectCampaign(c)}
                  className={`w-full text-left px-4 py-3 border-b border-surface-2/50 transition-all cursor-pointer ${isSelected ? 'bg-surface-2 border-l-2 border-l-cyan' : 'hover:bg-surface-1/50 border-l-2 border-l-transparent'}`}>
                  <p className="text-xs font-medium text-white truncate">{c.name}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <StatusBadge status={c.state} size="xs" />
                    <span className="text-xs text-slate-500">${(c.spend || 0).toFixed(0)}</span>
                    <span className={`text-xs font-semibold ${acosColor}`}>{(c.acos || 0).toFixed(0)}% ACoS</span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* KPIs sidebar bottom */}
        <div className="p-4 border-t border-surface-2 grid grid-cols-2 gap-2">
          <div className="bg-surface-2 rounded-lg p-2.5">
            <p className="text-xs text-slate-500 mb-0.5">Spend Total</p>
            <p className="text-sm font-bold text-white">${totalSpend.toFixed(0)}</p>
          </div>
          <div className="bg-surface-2 rounded-lg p-2.5">
            <p className="text-xs text-slate-500 mb-0.5">Vendas Total</p>
            <p className="text-sm font-bold text-emerald-400">${totalSales.toFixed(0)}</p>
          </div>
        </div>
      </div>

      {/* Painel de detalhes */}
      <div className="flex-1 flex flex-col min-w-0">
        {!selectedCampaign ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center p-8">
            <div className="w-16 h-16 rounded-2xl bg-cyan/10 border border-cyan/20 flex items-center justify-center">
              <Megaphone className="w-8 h-8 text-cyan/50" />
            </div>
            <div>
              <p className="text-base font-semibold text-slate-300">Seleciona uma campanha</p>
              <p className="text-sm text-slate-500 mt-1">Escolhe uma campanha à esquerda para ver keywords e gerir bids.</p>
            </div>
          </div>
        ) : (
          <>
            {/* Header campanha */}
            <div className="px-6 py-4 border-b border-surface-2 bg-surface-1 flex-shrink-0">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <h2 className="text-base font-bold text-white">{selectedCampaign.name}</h2>
                  <div className="flex items-center gap-3 mt-2 flex-wrap">
                    <StatusBadge status={selectedCampaign.state} />
                    <span className="text-xs text-slate-400">Orçamento: <span className="text-white">${(selectedCampaign.daily_budget || 0).toFixed(2)}/dia</span></span>
                    <span className="text-xs text-slate-400">Spend: <span className="text-white">${(selectedCampaign.spend || 0).toFixed(2)}</span></span>
                    <span className="text-xs text-slate-400">Vendas: <span className="text-emerald-400">${(selectedCampaign.sales || 0).toFixed(2)}</span></span>
                    <span className="text-xs text-slate-400">ACoS: <span className={`font-semibold ${(selectedCampaign.acos || 0) > 40 ? 'text-red-400' : 'text-emerald-400'}`}>{(selectedCampaign.acos || 0).toFixed(1)}%</span></span>
                    <span className="text-xs text-slate-400">ROAS: <span className="text-cyan">{(selectedCampaign.roas || 0).toFixed(2)}x</span></span>
                    <span className="text-xs text-slate-400">CPC: <span className="text-white">${(selectedCampaign.cpc || 0).toFixed(2)}</span></span>
                    <span className="text-xs text-slate-400">Cliques: <span className="text-white">{(selectedCampaign.clicks || 0).toLocaleString()}</span></span>
                    <span className="text-xs text-slate-400">Pedidos: <span className="text-white">{selectedCampaign.orders || 0}</span></span>
                  </div>
                </div>
                {hasPending && (
                  <button onClick={applyBids} disabled={saveState === 'loading'}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all flex-shrink-0 ${saveState === 'success' ? 'bg-emerald-600 text-white' : saveState === 'error' ? 'bg-red-600 text-white' : 'bg-cyan hover:bg-cyan/90 text-white'}`}>
                    {saveState === 'loading' ? <Loader2 className="w-4 h-4 animate-spin" /> : saveState === 'success' ? <CheckCircle className="w-4 h-4" /> : saveState === 'error' ? <AlertCircle className="w-4 h-4" /> : <Save className="w-4 h-4" />}
                    {saveState === 'loading' ? 'Guardando...' : saveState === 'success' ? 'Bids guardados!' : saveState === 'error' ? (saveError || 'Erro') : `Guardar ${Object.keys(pendingBids).length} bid(s)`}
                  </button>
                )}
              </div>
            </div>

            {/* Tabela de keywords */}
            <div className="flex-1 overflow-y-auto scrollbar-thin">
              {kwLoading ? (
                <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
              ) : keywords.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
                  <Search className="w-8 h-8 text-slate-600" />
                  <p className="text-sm text-slate-400">Sem keywords para esta campanha.</p>
                  <p className="text-xs text-slate-600">Execute um Sync completo para importar keywords.</p>
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-[#0D0F14] z-10">
                    <tr className="border-b border-surface-2">
                      {['Keyword / Search Term', 'Match', 'Estado', 'Bid Atual', 'Novo Bid', 'ACoS', 'Cliques', 'Spend', 'Vendas'].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {keywords.map((kw, i) => {
                      const changed = kw.id in pendingBids;
                      const acosColor = (kw.acos || 0) > 50 ? 'text-red-400' : (kw.acos || 0) > 30 ? 'text-amber-400' : 'text-emerald-400';
                      return (
                        <tr key={kw.id || i} className={`border-b border-surface-2/50 transition-colors ${changed ? 'bg-cyan/5' : 'hover:bg-surface-2'}`}>
                          <td className="px-4 py-2.5 font-medium text-white max-w-[200px] truncate">{kw.keyword_text || '—'}</td>
                          <td className="px-4 py-2.5"><span className="text-xs px-2 py-0.5 bg-surface-3 text-slate-400 rounded">{kw.match_type || '—'}</span></td>
                          <td className="px-4 py-2.5"><StatusBadge status={kw.state || 'enabled'} size="xs" /></td>
                          <td className="px-4 py-2.5 text-slate-300">${(kw.bid || 0).toFixed(2)}</td>
                          <td className="px-4 py-2.5">
                            <input type="number" step="0.01" min="0.02"
                              defaultValue={(kw.bid || 0).toFixed(2)}
                              onChange={e => setPendingBids(prev => ({ ...prev, [kw.id]: parseFloat(e.target.value) || 0 }))}
                              className="w-24 px-2 py-1.5 bg-surface-3 border border-surface-3 rounded text-xs text-white focus:outline-none focus:border-cyan/50" />
                          </td>
                          <td className="px-4 py-2.5"><span className={`font-semibold text-xs ${acosColor}`}>{(kw.acos || 0).toFixed(1)}%</span></td>
                          <td className="px-4 py-2.5 text-slate-400">{(kw.clicks || 0).toLocaleString()}</td>
                          <td className="px-4 py-2.5 text-slate-400">${(kw.spend || 0).toFixed(2)}</td>
                          <td className="px-4 py-2.5 text-emerald-400">${(kw.sales || 0).toFixed(2)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}