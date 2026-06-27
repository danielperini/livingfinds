import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { xanoCampaigns, xanoKeywords, xanoBids, isXanoAuthenticated } from '@/lib/xanoClient';
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
  const [budgetEdit, setBudgetEdit] = useState(null); // { campaignId, value }
  const [budgetSaving, setBudgetSaving] = useState(false);
  const [toggling, setToggling] = useState(null);
  const xanoConnected = isXanoAuthenticated();

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        if (xanoConnected) {
          const data = await xanoCampaigns.list();
          setCampaigns(Array.isArray(data) ? data : (data?.campaigns || []));
        } else {
          setCampaigns(await base44.entities.Campaign.list('-spend', 200));
        }
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [xanoConnected]);

  const selectCampaign = async (campaign) => {
    setSelectedCampaign(campaign);
    setPendingBids({});
    setBudgetEdit(null);
    setKwLoading(true);
    try {
      if (xanoConnected) {
        const kwData = await xanoKeywords.list();
        const all = Array.isArray(kwData) ? kwData : (kwData?.keywords || []);
        const campaignId = campaign.campaign_id || campaign.campaignId || campaign.id;
        setKeywords(all.filter(k => (k.campaign_id || k.campaignId) === campaignId));
      } else {
        const campaignId = campaign.campaign_id || campaign.campaignId;
        setKeywords(await base44.entities.Keyword.filter({ campaign_id: campaignId }));
      }
    } catch (err) {
      console.error(err);
    } finally {
      setKwLoading(false);
    }
  };

  // Toggle pausar/ativar campanha via Xano
  const toggleCampaignState = async (campaign) => {
    if (!xanoConnected) return;
    const id = campaign.campaign_id || campaign.id;
    const newState = campaign.state === 'enabled' ? 'paused' : 'enabled';
    setToggling(id);
    try {
      await xanoCampaigns.toggleState(id, newState);
      setCampaigns(prev => prev.map(c =>
        (c.campaign_id || c.id) === id ? { ...c, state: newState } : c
      ));
      if (selectedCampaign && (selectedCampaign.campaign_id || selectedCampaign.id) === id) {
        setSelectedCampaign(prev => ({ ...prev, state: newState }));
      }
    } catch (err) {
      alert(`Erro: ${err.message}`);
    } finally {
      setToggling(null);
    }
  };

  // Salvar budget via Xano
  const saveBudget = async () => {
    if (!budgetEdit || !xanoConnected) return;
    setBudgetSaving(true);
    try {
      await xanoCampaigns.updateBudget(budgetEdit.campaignId, parseFloat(budgetEdit.value));
      setCampaigns(prev => prev.map(c =>
        (c.campaign_id || c.id) === budgetEdit.campaignId
          ? { ...c, daily_budget: parseFloat(budgetEdit.value) }
          : c
      ));
      if (selectedCampaign && (selectedCampaign.campaign_id || selectedCampaign.id) === budgetEdit.campaignId) {
        setSelectedCampaign(prev => ({ ...prev, daily_budget: parseFloat(budgetEdit.value) }));
      }
      setBudgetEdit(null);
    } catch (err) {
      alert(`Erro ao salvar budget: ${err.message}`);
    } finally {
      setBudgetSaving(false);
    }
  };

  // Aplicar bids via Xano
  const applyBids = async () => {
    if (Object.keys(pendingBids).length === 0) return;
    setSaveState('loading');
    setSaveError(null);
    try {
      if (xanoConnected) {
        const bids = Object.entries(pendingBids).map(([keyword_id, bid]) => ({ keyword_id, bid }));
        await xanoBids.apply({ bids });
      } else {
        // Sem Xano: criar decisões para aprovação
        for (const [keywordId, newBid] of Object.entries(pendingBids)) {
          const kw = keywords.find(k => (k.keyword_id || k.id) === keywordId);
          if (!kw) continue;
          await base44.entities.Decision.create({
            amazon_account_id: kw.amazon_account_id,
            decision_type: 'bid_adjust',
            entity_type: 'keyword',
            entity_id: keywordId,
            entity_name: `${kw.keyword_text || kw.keywordText} (${kw.match_type || kw.matchType})`,
            rationale: 'Ajuste manual de bid',
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
      setPendingBids({});
      setTimeout(() => setSaveState('idle'), 3000);
    } catch (err) {
      setSaveState('error');
      setSaveError(err.message || 'Erro ao guardar');
      setTimeout(() => setSaveState('idle'), 4000);
    }
  };

  const hasPending = Object.keys(pendingBids).length > 0;
  const filtered = campaigns.filter(c => (c.name || '').toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="flex h-full">
      {/* Sidebar de campanhas */}
      <div className="w-72 flex-shrink-0 border-r border-surface-2 bg-[#0D0F14] flex flex-col">
        <div className="p-4 border-b border-surface-2">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-white">Campanhas</h2>
            {xanoConnected && <span className="text-xs text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded-full">Xano Live</span>}
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
            <p className="text-xs text-slate-500 text-center py-8 px-4">Sem campanhas. {xanoConnected ? 'Executa um Sync.' : 'Liga o Xano.'}</p>
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
                    {xanoConnected && (
                      <button
                        onClick={e => { e.stopPropagation(); toggleCampaignState(campaign); }}
                        disabled={isToggling}
                        className="flex-shrink-0 p-1 rounded hover:bg-surface-3 text-slate-400 hover:text-white transition-colors"
                        title={campaign.state === 'enabled' ? 'Pausar' : 'Ativar'}
                      >
                        {isToggling ? <Loader2 className="w-3 h-3 animate-spin" /> : campaign.state === 'enabled' ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <StatusBadge status={campaign.state} size="xs" />
                    <span className="text-xs text-slate-500">R${(campaign.spend || 0).toFixed(0)}</span>
                    <span className={`text-xs font-semibold ${(campaign.acos || 0) > 40 ? 'text-red-400' : 'text-emerald-400'}`}>
                      {(campaign.acos || 0).toFixed(0)}%
                    </span>
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
                    {/* Budget inline edit */}
                    {xanoConnected ? (
                      budgetEdit?.campaignId === (selectedCampaign.campaign_id || selectedCampaign.id) ? (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-slate-400">Orç:</span>
                          <input
                            type="number"
                            value={budgetEdit.value}
                            onChange={e => setBudgetEdit(prev => ({ ...prev, value: e.target.value }))}
                            className="w-24 px-2 py-1 bg-surface-3 border border-cyan/40 rounded text-xs text-white focus:outline-none"
                          />
                          <button onClick={saveBudget} disabled={budgetSaving} className="text-xs text-emerald-400 hover:text-emerald-300">
                            {budgetSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Salvar'}
                          </button>
                          <button onClick={() => setBudgetEdit(null)} className="text-xs text-slate-500 hover:text-slate-300">✕</button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setBudgetEdit({ campaignId: selectedCampaign.campaign_id || selectedCampaign.id, value: selectedCampaign.daily_budget || 0 })}
                          className="text-xs text-slate-400 hover:text-cyan underline"
                        >
                          Orç: R${(selectedCampaign.daily_budget || selectedCampaign.dailyBudget || 0).toFixed(2)}
                        </button>
                      )
                    ) : (
                      <span className="text-xs text-slate-400">Orç: R${(selectedCampaign.daily_budget || selectedCampaign.dailyBudget || 0).toFixed(2)}</span>
                    )}
                    <span className="text-xs text-slate-400">ACoS: <span className={`font-semibold ${(selectedCampaign.acos || 0) > 40 ? 'text-red-400' : 'text-emerald-400'}`}>{(selectedCampaign.acos || 0).toFixed(1)}%</span></span>
                    <span className="text-xs text-slate-400">ROAS: <span className="font-semibold text-cyan">{(selectedCampaign.roas || 0).toFixed(2)}x</span></span>
                  </div>
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
                        <tr key={kwId || i} className={`border-b border-surface-2/50 transition-colors duration-150 ${changed ? 'bg-cyan/5 border-l-2 border-l-cyan' : 'hover:bg-surface-2'}`}>
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