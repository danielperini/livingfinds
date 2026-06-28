import { useState, useEffect } from 'react';
import { xanoRequest, toArray } from '@/lib/useXano';
import { Search, Save, Loader2, CheckCircle, AlertCircle, Megaphone, Pause, Play } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import EmptyState from '@/components/ui/EmptyState';

export default function AdsManagement() {
  const [campaigns, setCampaigns] = useState([]);
  const [selectedCampaign, setSelectedCampaign] = useState(null);
  const [keywords, setKeywords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [kwLoading, setKwLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [pendingBids, setPendingBids] = useState({});
  const [saveState, setSaveState] = useState('idle');
  const [saveError, setSaveError] = useState(null);
  const [toggling, setToggling] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await xanoRequest('GET', '/amazon/analysis/campaigns');
        setCampaigns(toArray(data, 'campaigns'));
      } catch (err) {
        setError(err.message);
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
      const campaignId = campaign.campaign_id || campaign.campaignId || campaign.id;
      const kwData = await xanoRequest('GET', '/amazon/keywords', null, { campaign_id: campaignId });
      setKeywords(toArray(kwData, 'keywords'));
    } catch (err) {
      setKeywords([]);
    } finally {
      setKwLoading(false);
    }
  };

  const toggleCampaignState = async (campaign) => {
    const id = campaign.campaign_id || campaign.id;
    const newState = campaign.state === 'enabled' ? 'paused' : 'enabled';
    setToggling(id);
    try {
      await xanoRequest('PATCH', `/campaigns/${id}`, { state: newState });
      setCampaigns(prev => prev.map(c => (c.campaign_id || c.id) === id ? { ...c, state: newState } : c));
      if (selectedCampaign && (selectedCampaign.campaign_id || selectedCampaign.id) === id) {
        setSelectedCampaign(prev => ({ ...prev, state: newState }));
      }
    } catch (err) {
      alert(`Erro: ${err.message}`);
    } finally {
      setToggling(null);
    }
  };

  // Aplicar bids: apenas se aprovado manualmente (pendingBids já são a aprovação do utilizador)
  const applyBids = async () => {
    if (Object.keys(pendingBids).length === 0) return;
    setSaveState('loading');
    setSaveError(null);
    try {
      const updates = Object.entries(pendingBids).map(([keyword_id, bid]) => ({ keyword_id, bid }));
      await xanoRequest('POST', '/bids/apply', { updates });
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
  const filtered = campaigns.filter(c => (c.name || '').toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div className="w-72 flex-shrink-0 border-r border-surface-2 bg-[#0D0F14] flex flex-col">
        <div className="p-4 border-b border-surface-2">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-white">Campanhas</h2>
            <span className="text-xs text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded-full">Xano Live</span>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Pesquisar..."
              className="w-full pl-8 pr-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-xs text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan/50"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {loading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 text-cyan animate-spin" /></div>
          ) : error ? (
            <p className="text-xs text-red-400 text-center py-8 px-4">{error}</p>
          ) : filtered.length === 0 ? (
            <p className="text-xs text-slate-500 text-center py-8 px-4">Sem campanhas. Execute um Sync.</p>
          ) : (
            filtered.map((campaign, i) => {
              const cId = campaign.campaign_id || campaign.id;
              const isToggling = toggling === cId;
              return (
                <div
                  key={cId || i}
                  className={`w-full text-left px-4 py-3 border-b border-surface-2/50 transition-all duration-150 cursor-pointer ${
                    (selectedCampaign?.campaign_id || selectedCampaign?.id) === cId
                      ? 'bg-surface-2 border-l-2 border-l-cyan'
                      : 'hover:bg-surface-1/50 border-l-2 border-l-transparent'
                  }`}
                  onClick={() => selectCampaign(campaign)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium text-white truncate flex-1">{campaign.name}</p>
                    <button
                      onClick={e => { e.stopPropagation(); toggleCampaignState(campaign); }}
                      disabled={isToggling}
                      className="flex-shrink-0 p-1 rounded hover:bg-surface-3 text-slate-400 hover:text-white transition-colors"
                      title={campaign.state === 'enabled' ? 'Pausar' : 'Ativar'}
                    >
                      {isToggling ? <Loader2 className="w-3 h-3 animate-spin" /> : campaign.state === 'enabled' ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                    </button>
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <StatusBadge status={campaign.state} size="xs" />
                    <span className="text-xs text-slate-500">R${(campaign.spend || 0).toFixed(0)}</span>
                    <span className={`text-xs font-semibold ${(campaign.acos || 0) > 40 ? 'text-red-400' : 'text-emerald-400'}`}>
                      {(campaign.acos || 0).toFixed(0)}%
                    </span>
                    {campaign.recommendation && (
                      <span className="text-xs text-cyan truncate">{campaign.recommendation}</span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Painel de detalhes */}
      <div className="flex-1 flex flex-col min-w-0">
        {!selectedCampaign ? (
          <EmptyState icon={Megaphone} title="Seleciona uma campanha" description="Escolhe uma campanha à esquerda para ver keywords e gerir bids." />
        ) : (
          <>
            <div className="px-6 py-4 border-b border-surface-2 bg-surface-1">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-base font-bold text-white">{selectedCampaign.name}</h2>
                  <div className="flex items-center gap-3 mt-1 flex-wrap">
                    <StatusBadge status={selectedCampaign.state} />
                    <span className="text-xs text-slate-400">Orç: R${(selectedCampaign.daily_budget || 0).toFixed(2)}</span>
                    <span className="text-xs text-slate-400">ACoS: <span className={`font-semibold ${(selectedCampaign.acos || 0) > 40 ? 'text-red-400' : 'text-emerald-400'}`}>{(selectedCampaign.acos || 0).toFixed(1)}%</span></span>
                    <span className="text-xs text-slate-400">ROAS: <span className="font-semibold text-cyan">{(selectedCampaign.roas || 0).toFixed(2)}x</span></span>
                    <span className="text-xs text-slate-400">CPC: <span className="text-white">R${(selectedCampaign.cpc || 0).toFixed(2)}</span></span>
                    <span className="text-xs text-slate-400">CTR: <span className="text-white">{(selectedCampaign.ctr || 0).toFixed(2)}%</span></span>
                    <span className="text-xs text-slate-400">Pedidos: <span className="text-white">{selectedCampaign.orders || 0}</span></span>
                    {selectedCampaign.risk && (
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${selectedCampaign.risk === 'high' ? 'bg-red-400/10 text-red-400' : selectedCampaign.risk === 'medium' ? 'bg-amber-400/10 text-amber-400' : 'bg-emerald-400/10 text-emerald-400'}`}>
                        Risco: {selectedCampaign.risk}
                      </span>
                    )}
                  </div>
                  {selectedCampaign.recommendation && (
                    <p className="text-xs text-cyan mt-2">💡 {selectedCampaign.recommendation}</p>
                  )}
                </div>
                {hasPending && (
                  <button
                    onClick={applyBids}
                    disabled={saveState === 'loading'}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all flex-shrink-0 ${
                      saveState === 'success' ? 'bg-emerald-600 text-white' :
                      saveState === 'error' ? 'bg-red-600 text-white' :
                      'bg-cyan hover:bg-cyan/90 text-white'
                    }`}
                  >
                    {saveState === 'loading' ? <Loader2 className="w-4 h-4 animate-spin" /> :
                     saveState === 'success' ? <CheckCircle className="w-4 h-4" /> :
                     saveState === 'error' ? <AlertCircle className="w-4 h-4" /> :
                     <Save className="w-4 h-4" />}
                    {saveState === 'loading' ? 'Aplicando...' :
                     saveState === 'success' ? 'Bids aplicados!' :
                     saveState === 'error' ? (saveError || 'Erro') :
                     `Aplicar ${Object.keys(pendingBids).length} bid(s)`}
                  </button>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto scrollbar-thin p-6">
              {kwLoading ? (
                <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
              ) : keywords.length === 0 ? (
                <EmptyState icon={Search} title="Sem keywords" description="Sem keywords para esta campanha." />
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-surface-2">
                      {['Keyword', 'Match', 'Estado', 'Bid Atual', 'Novo Bid', 'ACoS', 'Cliques', 'Spend'].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {keywords.map((kw, i) => {
                      const kwId = kw.keyword_id || kw.id;
                      const changed = kwId in pendingBids;
                      return (
                        <tr key={kwId || i} className={`border-b border-surface-2/50 transition-colors ${changed ? 'bg-cyan/5 border-l-2 border-l-cyan' : 'hover:bg-surface-2'}`}>
                          <td className="px-4 py-3 font-medium text-white">{kw.keyword_text || kw.keywordText}</td>
                          <td className="px-4 py-3"><span className="text-xs px-2 py-0.5 bg-surface-3 text-slate-400 rounded">{kw.match_type || kw.matchType}</span></td>
                          <td className="px-4 py-3"><StatusBadge status={kw.state} size="xs" /></td>
                          <td className="px-4 py-3 text-slate-300">R${(kw.bid || 0).toFixed(2)}</td>
                          <td className="px-4 py-3">
                            <input type="number" step="0.01" min="0.02" defaultValue={(kw.bid || 0).toFixed(2)}
                              onChange={e => setPendingBids(prev => ({ ...prev, [kwId]: parseFloat(e.target.value) || 0 }))}
                              className="w-24 px-2 py-1.5 bg-surface-3 border border-surface-3 rounded text-xs text-white focus:outline-none focus:border-cyan/50"
                            />
                          </td>
                          <td className="px-4 py-3">
                            <span className={`font-semibold text-xs ${(kw.acos || 0) > 50 ? 'text-red-400' : (kw.acos || 0) > 30 ? 'text-amber-400' : 'text-emerald-400'}`}>
                              {(kw.acos || 0).toFixed(1)}%
                            </span>
                          </td>
                          <td className="px-4 py-3 text-slate-400">{kw.clicks || 0}</td>
                          <td className="px-4 py-3 text-slate-400">R${(kw.spend || 0).toFixed(2)}</td>
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