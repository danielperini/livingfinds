import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { xanoCampaigns, xanoKeywords, xanoBids, isXanoAuthenticated } from '@/lib/xanoClient';
import { Search, Save, Loader2, CheckCircle, AlertCircle, Megaphone, Zap } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import EmptyState from '@/components/ui/EmptyState';

export default function AdsManagement() {
  const [campaigns, setCampaigns] = useState([]);
  const [selectedCampaign, setSelectedCampaign] = useState(null);
  const [keywords, setKeywords] = useState([]);
  const [adGroups, setAdGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [kwLoading, setKwLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('keywords');
  const [pendingChanges, setPendingChanges] = useState({});
  const [saveState, setSaveState] = useState('idle');
  const [saveError, setSaveError] = useState(null);
  const xanoConnected = isXanoAuthenticated();

  useEffect(() => {
    const loadCampaigns = async () => {
      setLoading(true);
      try {
        if (xanoConnected) {
          const data = await xanoCampaigns.list();
          const list = Array.isArray(data) ? data : (data?.campaigns || []);
          setCampaigns(list);
        } else {
          const data = await base44.entities.Campaign.list('-spend', 200);
          setCampaigns(data);
        }
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    loadCampaigns();
  }, [xanoConnected]);

  const selectCampaign = async (campaign) => {
    setSelectedCampaign(campaign);
    setPendingChanges({});
    setKwLoading(true);
    try {
      if (xanoConnected) {
        const kwData = await xanoKeywords.list();
        const allKws = Array.isArray(kwData) ? kwData : (kwData?.keywords || []);
        const campaignId = campaign.campaign_id || campaign.campaignId || campaign.id;
        setKeywords(allKws.filter(k => (k.campaign_id || k.campaignId) === campaignId));
        setAdGroups([]);
      } else {
        const campaignId = campaign.campaign_id || campaign.campaignId;
        const [kws, ags] = await Promise.all([
          base44.entities.Keyword.filter({ campaign_id: campaignId }),
          base44.entities.AdGroup.filter({ campaign_id: campaignId }),
        ]);
        setKeywords(kws);
        setAdGroups(ags);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setKwLoading(false);
    }
  };

  const handleBidChange = (keywordId, value) => {
    setPendingChanges(prev => ({ ...prev, [keywordId]: parseFloat(value) || 0 }));
  };

  const applyChanges = async () => {
    if (Object.keys(pendingChanges).length === 0) return;
    setSaveState('loading');
    setSaveError(null);
    try {
      if (xanoConnected) {
        // Use Xano bids/apply endpoint for real bid changes
        const bidUpdates = Object.entries(pendingChanges).map(([keywordId, bid]) => ({
          keyword_id: keywordId,
          bid,
        }));
        await xanoBids.apply({ bids: bidUpdates });
      } else {
        // Create decisions for manual approval
        for (const [keywordId, newBid] of Object.entries(pendingChanges)) {
          const kw = keywords.find(k => (k.keyword_id || k.keywordId) === keywordId);
          if (!kw) continue;
          await base44.entities.Decision.create({
            amazon_account_id: kw.amazon_account_id,
            decision_type: 'bid_adjust',
            entity_type: 'keyword',
            entity_id: keywordId,
            entity_name: `${kw.keyword_text || kw.keywordText} (${kw.match_type || kw.matchType})`,
            rationale: `Ajuste manual de bid`,
            current_value: kw.bid,
            proposed_value: newBid,
            change_pct: kw.bid > 0 ? ((newBid - kw.bid) / kw.bid) * 100 : 0,
            confidence: 1.0,
            priority: 'medium',
            status: 'pending',
          });
        }
      }
      setSaveState('success');
      setPendingChanges({});
      setTimeout(() => setSaveState('idle'), 3000);
    } catch (err) {
      setSaveState('error');
      setSaveError(err.message || 'Erro ao guardar');
      setTimeout(() => setSaveState('idle'), 4000);
    }
  };

  const hasPending = Object.keys(pendingChanges).length > 0;
  const filtered = campaigns.filter(c => (c.name || '').toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="flex h-full">
      {/* Campaign list sidebar */}
      <div className="w-72 flex-shrink-0 border-r border-surface-2 bg-[#0D0F14] flex flex-col">
        <div className="p-4 border-b border-surface-2">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-white">Campanhas</h2>
            {xanoConnected && <span className="text-xs text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded-full">Live</span>}
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
          ) : filtered.length === 0 ? (
            <p className="text-xs text-slate-500 text-center py-8 px-4">Sem campanhas. {xanoConnected ? 'Sincroniza dados.' : 'Liga o Xano ou executa Sync.'}</p>
          ) : (
            filtered.map((campaign, i) => (
              <button
                key={campaign.id || i}
                onClick={() => selectCampaign(campaign)}
                className={`w-full text-left px-4 py-3 border-b border-surface-2/50 transition-all duration-150 ${
                  selectedCampaign?.id === campaign.id
                    ? 'bg-surface-2 border-l-2 border-l-cyan'
                    : 'hover:bg-surface-1/50 border-l-2 border-l-transparent'
                }`}
              >
                <p className="text-xs font-medium text-white truncate">{campaign.name}</p>
                <div className="flex items-center gap-2 mt-1">
                  <StatusBadge status={campaign.state} size="xs" />
                  <span className="text-xs text-slate-500">${(campaign.spend || 0).toFixed(0)}</span>
                  <span className={`text-xs font-semibold ${(campaign.acos || 0) > 40 ? 'text-red-400' : 'text-emerald-400'}`}>
                    {(campaign.acos || 0).toFixed(0)}%
                  </span>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Detail panel */}
      <div className="flex-1 flex flex-col min-w-0">
        {!selectedCampaign ? (
          <EmptyState icon={Megaphone} title="Seleciona uma campanha" description="Escolhe uma campanha à esquerda para ver keywords e ad groups." />
        ) : (
          <>
            <div className="px-6 py-4 border-b border-surface-2 bg-surface-1 flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-white">{selectedCampaign.name}</h2>
                <div className="flex items-center gap-3 mt-1">
                  <StatusBadge status={selectedCampaign.state} />
                  <span className="text-xs text-slate-400">Orç: ${(selectedCampaign.daily_budget || selectedCampaign.dailyBudget || 0).toFixed(2)}</span>
                  <span className="text-xs text-slate-400">ACOS: <span className={`font-semibold ${(selectedCampaign.acos || 0) > 40 ? 'text-red-400' : 'text-emerald-400'}`}>{(selectedCampaign.acos || 0).toFixed(1)}%</span></span>
                  <span className="text-xs text-slate-400">ROAS: <span className="font-semibold text-cyan">{(selectedCampaign.roas || 0).toFixed(2)}x</span></span>
                </div>
              </div>
              {hasPending && (
                <button
                  onClick={applyChanges}
                  disabled={saveState === 'loading'}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
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
                   saveState === 'success' ? (xanoConnected ? 'Bids aplicados!' : 'Enviado para aprovação') :
                   saveState === 'error' ? (saveError || 'Erro') :
                   `Aplicar ${Object.keys(pendingChanges).length} alteração(ões)`}
                </button>
              )}
            </div>

            <div className="flex border-b border-surface-2 px-6 bg-surface-1">
              {['keywords', 'adgroups'].map(t => (
                <button key={t} onClick={() => setTab(t)}
                  className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${tab === t ? 'border-cyan text-cyan' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
                  {t === 'keywords' ? 'Keywords' : 'Ad Groups'}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto scrollbar-thin p-6">
              {kwLoading ? (
                <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
              ) : tab === 'keywords' ? (
                keywords.length === 0 ? (
                  <EmptyState icon={Search} title="Sem keywords" description="Sem dados para esta campanha." />
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-surface-2">
                        {['Keyword', 'Match', 'Estado', 'Bid Atual', 'Novo Bid', 'ACOS', 'Cliques', 'Spend'].map(h => (
                          <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {keywords.map((kw, i) => {
                        const kwId = kw.keyword_id || kw.keywordId || kw.id;
                        const changed = kwId in pendingChanges;
                        return (
                          <tr key={kwId || i} className={`border-b border-surface-2/50 transition-colors duration-150 ${changed ? 'bg-cyan/5 border-l-2 border-l-cyan' : 'hover:bg-surface-2'}`}>
                            <td className="px-4 py-3 font-medium text-white">{kw.keyword_text || kw.keywordText}</td>
                            <td className="px-4 py-3"><span className="text-xs px-2 py-0.5 bg-surface-3 text-slate-400 rounded">{kw.match_type || kw.matchType}</span></td>
                            <td className="px-4 py-3"><StatusBadge status={kw.state} size="xs" /></td>
                            <td className="px-4 py-3 text-slate-300">${(kw.bid || 0).toFixed(2)}</td>
                            <td className="px-4 py-3">
                              <input type="number" step="0.01" min="0.02" defaultValue={(kw.bid || 0).toFixed(2)}
                                onChange={e => handleBidChange(kwId, e.target.value)}
                                className="w-24 px-2 py-1.5 bg-surface-3 border border-surface-3 rounded text-xs text-white focus:outline-none focus:border-cyan/50"
                              />
                            </td>
                            <td className="px-4 py-3">
                              <span className={`font-semibold text-xs ${(kw.acos || 0) > 50 ? 'text-red-400' : (kw.acos || 0) > 30 ? 'text-amber-400' : 'text-emerald-400'}`}>
                                {(kw.acos || 0).toFixed(1)}%
                              </span>
                            </td>
                            <td className="px-4 py-3 text-slate-400">{kw.clicks || 0}</td>
                            <td className="px-4 py-3 text-slate-400">${(kw.spend || 0).toFixed(2)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )
              ) : (
                adGroups.length === 0 ? (
                  <EmptyState icon={Megaphone} title="Sem Ad Groups" description={xanoConnected ? 'Ad groups não retornados pela API Xano para esta campanha.' : 'Sem ad groups locais.'} />
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-surface-2">
                        {['Ad Group', 'Estado', 'Bid Padrão', 'Impressões', 'Cliques', 'ACOS'].map(h => (
                          <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {adGroups.map(ag => (
                        <tr key={ag.id} className="border-b border-surface-2/50 hover:bg-surface-2 transition-colors">
                          <td className="px-4 py-3 font-medium text-white">{ag.name}</td>
                          <td className="px-4 py-3"><StatusBadge status={ag.state} size="xs" /></td>
                          <td className="px-4 py-3 text-slate-300">${(ag.default_bid || 0).toFixed(2)}</td>
                          <td className="px-4 py-3 text-slate-400">{(ag.impressions || 0).toLocaleString()}</td>
                          <td className="px-4 py-3 text-slate-400">{ag.clicks || 0}</td>
                          <td className="px-4 py-3"><span className={`text-xs font-semibold ${(ag.acos || 0) > 40 ? 'text-red-400' : 'text-emerald-400'}`}>{(ag.acos || 0).toFixed(1)}%</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}