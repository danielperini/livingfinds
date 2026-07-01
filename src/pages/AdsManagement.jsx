import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Search, Save, Loader2, CheckCircle, AlertCircle, Megaphone, Pause, Play, Brain, RefreshCw, TrendingUp, TrendingDown, X, Plus, ListFilter, Clock, Info } from 'lucide-react';
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
  const [activeTab, setActiveTab] = useState('keywords'); // 'keywords' | 'search-terms'
  const [searchTerms, setSearchTerms] = useState([]);
  const [negSuggestions, setNegSuggestions] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);

  const loadCampaigns = async () => {
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

  useEffect(() => { loadCampaigns(); }, []);

  const forceSync = async () => {
    if (!account || syncing) return;
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await base44.functions.invoke('syncAdsQuick', { amazon_account_id: account.id });
      if (res?.data?.ok) {
        setSyncMsg({ type: 'success', text: `Dados atualizados — ${res.data.campaigns_updated || 0} campanhas sincronizadas.` });
        await loadCampaigns();
      } else {
        setSyncMsg({ type: 'error', text: res?.data?.error || 'Falha ao sincronizar.' });
      }
    } catch (e) {
      setSyncMsg({ type: 'error', text: e.message });
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMsg(null), 8000);
    }
  };

  const selectCampaign = async (campaign) => {
    setSelectedCampaign(campaign);
    setPendingBids({});
    setActiveTab('keywords');
    setKwLoading(true);
    try {
      const [kws, st, negs] = await Promise.all([
        base44.entities.Keyword.filter({
          amazon_account_id: campaign.amazon_account_id,
          campaign_id: campaign.campaign_id,
        }, '-spend', 500),
        base44.entities.Keyword.filter({
          amazon_account_id: campaign.amazon_account_id,
          campaign_id: campaign.campaign_id,
          source: 'search_term',
        }, '-spend', 200),
        base44.entities.NegativeKeywordSuggestion.filter({
          amazon_account_id: campaign.amazon_account_id,
          campaign_id: campaign.campaign_id,
          status: 'pending',
        }, '-created_date', 50),
      ]);
      setKeywords(kws.filter(k => k.source !== 'search_term'));
      setSearchTerms(st);
      setNegSuggestions(negs);
      
      // Analisar desempenho horário se campanha tem 30+ dias
      const campaignAge = campaign.days_running || 0;
      if (campaignAge >= 30) {
        try {
          await base44.functions.invoke('analyzeKeywordHourlyPerformance', {
            amazon_account_id: campaign.amazon_account_id,
            campaign_id: campaign.campaign_id,
          });
          // Recarregar keywords com dados atualizados
          const updatedKws = await base44.entities.Keyword.filter({
            amazon_account_id: campaign.amazon_account_id,
            campaign_id: campaign.campaign_id,
          }, '-spend', 500);
          setKeywords(updatedKws.filter(k => k.source !== 'search_term'));
        } catch (e) {
          console.warn('Erro ao analisar horário:', e.message);
        }
      }
    } catch {
      setKeywords([]);
      setSearchTerms([]);
      setNegSuggestions([]);
    } finally {
      setKwLoading(false);
    }
  };

  const applyBids = async () => {
    if (Object.keys(pendingBids).length === 0) return;
    setSaveState('loading');
    setSaveError(null);
    try {
      const updates = Object.entries(pendingBids).map(([id, bid]) => ({ id, bid }));
      await base44.entities.Keyword.bulkUpdate(updates);
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

  const negateKeyword = async (suggestion) => {
    try {
      await base44.entities.NegativeKeywordSuggestion.update(suggestion.id, { status: 'approved' });
      setNegSuggestions(prev => prev.filter(s => s.id !== suggestion.id));
      // Criar ação para execução via agente
      await base44.entities.AgentAction.create({
        amazon_account_id: account.id,
        action: 'negative_keyword',
        campaign_id: suggestion.campaign_id,
        keyword: suggestion.keyword_text,
        reason: 'Negativação manual via dashboard',
        evidence: `Search term: ${suggestion.keyword_text}, Spend: $${(suggestion.spend||0).toFixed(2)}, Clicks: ${suggestion.clicks||0}`,
        risk_level: 'medium',
        requires_approval: false,
        status: 'pending',
      });
    } catch (err) {
      console.error('Erro ao negativar:', err);
    }
  };

  const promoteKeyword = async (searchTerm) => {
    try {
      // Verificar duplicidade antes de criar
      const existingKws = await base44.entities.Keyword.filter({
        amazon_account_id: account.id,
        campaign_id: searchTerm.campaign_id,
        keyword_text: searchTerm.keyword_text,
        source: 'manual',
      });
      
      if (existingKws.length > 0) {
        alert(`Keyword "${searchTerm.keyword_text}" já existe nesta campanha.`);
        return;
      }
      
      // Criar keyword manual com bid sugerido de $0.30
      await base44.entities.Keyword.create({
        amazon_account_id: account.id,
        campaign_id: searchTerm.campaign_id,
        ad_group_id: searchTerm.ad_group_id || '',
        keyword_id: `manual_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        keyword_text: searchTerm.keyword_text,
        match_type: 'exact',
        state: 'enabled',
        status: 'enabled',
        current_bid: 0.30,
        bid: 0.30,
        source: 'manual',
        first_seen_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        synced_at: new Date().toISOString(),
      });
      setSearchTerms(prev => prev.filter(st => st.id !== searchTerm.id));
    } catch (err) {
      console.error('Erro ao promover:', err);
      alert('Erro ao promover keyword: ' + err.message);
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
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-sm font-semibold text-white">Campanhas</h2>
            <button onClick={forceSync} disabled={syncing || !account}
              title="Forçar atualização dos dados da Amazon"
              className="flex items-center gap-1 px-2 py-1 text-xs font-semibold bg-cyan/10 border border-cyan/20 text-cyan hover:bg-cyan/20 rounded-lg transition-colors disabled:opacity-50">
              <RefreshCw className={`w-3 h-3 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Atualizando...' : 'Atualizar'}
            </button>
          </div>
          <p className="text-xs text-slate-500">{campaigns.length} campanhas</p>
          {syncMsg && (
            <p className={`text-xs mt-2 ${syncMsg.type === 'success' ? 'text-emerald-400' : 'text-red-400'}`}>{syncMsg.text}</p>
          )}
        </div>
        <div className="p-4 border-b border-surface-2">
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
                <div className="flex items-center gap-2">
                  <button onClick={async () => {
                    try {
                      await base44.functions.invoke('monitorSearchTerms', { amazon_account_id: account.id });
                    } catch (e) {
                      console.error('Erro ao executar monitor:', e);
                    }
                }}
                className="px-3 py-2 text-xs font-semibold bg-surface-2 border border-surface-3 text-slate-300 hover:text-white rounded-lg transition-colors flex items-center gap-1.5"
                title="Executar análise de search terms agora"
              >
                <Brain className="w-3.5 h-3.5" /> Analisar Search Terms
              </button>
                  {keywords.length > 0 && (
                    <button
                      onClick={() => {
                        const bulk = {};
                        keywords.forEach(kw => { bulk[kw.id] = 0.50; });
                        setPendingBids(bulk);
                      }}
                      className="px-3 py-2 text-xs font-semibold bg-amber-500/15 border border-amber-500/30 text-amber-400 hover:bg-amber-500/25 rounded-lg transition-colors flex items-center gap-1.5"
                      title="Definir bid de R$0,50 em todas as keywords"
                    >
                      <TrendingUp className="w-3.5 h-3.5" /> Bids → R$0,50
                    </button>
                  )}
                  {hasPending && (
                    <button onClick={applyBids} disabled={saveState === 'loading'}
                      className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all flex-shrink-0 ${saveState === 'success' ? 'bg-emerald-600 text-white' : saveState === 'error' ? 'bg-red-600 text-white' : 'bg-cyan hover:bg-cyan/90 text-white'}`}>
                      {saveState === 'loading' ? <Loader2 className="w-4 h-4 animate-spin" /> : saveState === 'success' ? <CheckCircle className="w-4 h-4" /> : saveState === 'error' ? <AlertCircle className="w-4 h-4" /> : <Save className="w-4 h-4" />}
                      {saveState === 'loading' ? 'Guardando...' : saveState === 'success' ? 'Bids guardados!' : saveState === 'error' ? (saveError || 'Erro') : `Guardar ${Object.keys(pendingBids).length} bid(s)`}
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Tab switcher */}
            <div className="flex border-b border-surface-2 bg-[#0D0F14] flex-shrink-0">
              {[
                { key: 'keywords', label: `Keywords (${keywords.length})` },
                { key: 'search-terms', label: `Search Terms ${searchTerms.length > 0 ? `(${searchTerms.length})` : ''}${negSuggestions.length > 0 ? ` · ${negSuggestions.length} neg.` : ''}` },
              ].map(tab => (
                <button key={tab.key} onClick={() => setActiveTab(tab.key)}
                  className={`px-5 py-3 text-xs font-semibold border-b-2 transition-colors ${
                    activeTab === tab.key
                      ? 'border-cyan text-cyan'
                      : 'border-transparent text-slate-500 hover:text-slate-300'
                  }`}>
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Tabs content */}
            <div className="flex-1 overflow-y-auto scrollbar-thin">
              {activeTab === 'keywords' ? (
                <>
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
                      {['Keyword / Search Term', 'Match', 'Estado', 'Melhor horário', 'Bid Atual', 'Novo Bid', 'ACoS', 'Cliques', 'Spend', 'Vendas'].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {keywords.map((kw, i) => {
                      const changed = kw.id in pendingBids;
                      const acosColor = (kw.acos || 0) > 50 ? 'text-red-400' : (kw.acos || 0) > 30 ? 'text-amber-400' : 'text-emerald-400';
                      
                      // Renderizar melhor horário
                      const renderBestHour = () => {
                        if (!kw.hourly_data_mature || kw.best_hour_start == null) {
                          return (
                            <div className="flex items-center gap-1.5 text-slate-500">
                              <Clock className="w-3.5 h-3.5" />
                              <span className="text-xs">Em aprendizado</span>
                            </div>
                          );
                        }
                        
                        const start = String(kw.best_hour_start).padStart(2, '0');
                        const end = String(kw.best_hour_end).padStart(2, '0');
                        const actionColors = {
                          increase_peak: 'text-emerald-400',
                          reduce_off_peak: 'text-amber-400',
                          maintain: 'text-cyan',
                          insufficient_data: 'text-slate-500',
                        };
                        const actionLabels = {
                          increase_peak: 'Aumentar no pico',
                          reduce_off_peak: 'Reduzir fora do pico',
                          maintain: 'Manter',
                          insufficient_data: 'Dados insuficientes',
                        };
                        
                        return (
                          <div className="space-y-1">
                            <div className="flex items-center gap-1.5">
                              <Clock className="w-3.5 h-3.5 text-cyan" />
                              <span className="text-xs font-semibold text-white">{start}h–{end}h</span>
                            </div>
                            {kw.best_hour_roas && (
                              <div className="text-[10px] text-slate-400">
                                ROAS {kw.best_hour_roas} · {kw.best_hour_sales} vendas
                              </div>
                            )}
                            {kw.hourly_action_suggestion && kw.hourly_action_suggestion !== 'insufficient_data' && (
                              <div className={`text-[10px] font-medium ${actionColors[kw.hourly_action_suggestion]}`}>
                                {actionLabels[kw.hourly_action_suggestion]}
                              </div>
                            )}
                          </div>
                        );
                      };
                      
                      return (
                        <tr key={kw.id || i} className={`border-b border-surface-2/50 transition-colors ${changed ? 'bg-cyan/5' : 'hover:bg-surface-2'}`}>
                          <td className="px-4 py-2.5 font-medium text-white max-w-[200px] truncate">{kw.keyword_text || '—'}</td>
                          <td className="px-4 py-2.5"><span className="text-xs px-2 py-0.5 bg-surface-3 text-slate-400 rounded">{kw.match_type || '—'}</span></td>
                          <td className="px-4 py-2.5"><StatusBadge status={kw.state || 'enabled'} size="xs" /></td>
                          <td className="px-4 py-2.5">{renderBestHour()}</td>
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
                </>
              ) : (
                /* Search Terms Tab */
                <div className="p-4 space-y-4">
                  {/* Sugestões de negativação */}
                  {negSuggestions.length > 0 && (
                    <div>
                      <h3 className="text-xs font-semibold text-red-400 mb-2 flex items-center gap-1.5">
                        <TrendingDown className="w-3.5 h-3.5" /> {negSuggestions.length} termos para negativar
                      </h3>
                      <div className="space-y-2">
                        {negSuggestions.map(neg => (
                          <div key={neg.id} className="flex items-center justify-between p-3 bg-red-500/5 border border-red-500/20 rounded-lg">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-white truncate">{neg.keyword_text}</p>
                              <p className="text-xs text-slate-400 mt-0.5">
                                {(neg.clicks||0)} clicks · ${(neg.spend||0).toFixed(2)} spend · {neg.sales > 0 ? `$${(neg.sales||0).toFixed(2)} vendas` : 'zero vendas'}
                                {neg.acos > 0 && ` · ${(neg.acos||0).toFixed(0)}% ACoS`}
                              </p>
                              <p className="text-xs text-red-400 mt-1">{neg.reason}</p>
                            </div>
                            <button onClick={() => negateKeyword(neg)}
                              className="ml-3 px-3 py-1.5 text-xs font-semibold bg-red-500/20 text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/30 transition-colors flex items-center gap-1.5">
                              <X className="w-3.5 h-3.5" /> Negativar
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Search terms capturados */}
                  <div>
                    <h3 className="text-xs font-semibold text-slate-300 mb-2 flex items-center gap-1.5">
                      <ListFilter className="w-3.5 h-3.5" /> {searchTerms.length} search terms capturados
                    </h3>
                    {searchTerms.length === 0 ? (
                      <p className="text-sm text-slate-500 text-center py-8">Sem search terms capturados ainda.</p>
                    ) : (
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-surface-2">
                            {['Search Term', 'Clicks', 'Spend', 'Vendas', 'ACoS', 'Ação'].map(h => (
                              <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {searchTerms.map(st => {
                            const isWasting = (st.clicks||0) >= 5 && (st.spend||0) >= 2 && (st.sales||0) === 0;
                            const isGood = (st.sales||0) > 0 && (st.acos||0) > 0 && (st.acos||0) < 40;
                            return (
                              <tr key={st.id} className="border-b border-surface-2/40 hover:bg-surface-2/30">
                                <td className="px-4 py-2.5 text-slate-300 max-w-[200px] truncate">{st.keyword_text || st.keyword || '—'}</td>
                                <td className="px-4 py-2.5 text-slate-400">{(st.clicks||0).toLocaleString()}</td>
                                <td className="px-4 py-2.5 text-slate-400">${(st.spend||0).toFixed(2)}</td>
                                <td className="px-4 py-2.5 text-emerald-400">${(st.sales||0).toFixed(2)}</td>
                                <td className={`px-4 py-2.5 font-semibold ${(st.acos||0) > 50 ? 'text-red-400' : (st.acos||0) > 30 ? 'text-amber-400' : (st.acos||0) > 0 ? 'text-emerald-400' : 'text-slate-600'}`}>
                                  {(st.acos||0) > 0 ? `${(st.acos||0).toFixed(1)}%` : '—'}
                                </td>
                                <td className="px-4 py-2.5">
                                  {isGood ? (
                                    <button onClick={() => promoteKeyword(st)}
                                      className="px-2.5 py-1 text-xs font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded-lg hover:bg-emerald-500/30 transition-colors flex items-center gap-1">
                                      <Plus className="w-3 h-3" /> Promover
                                    </button>
                                  ) : isWasting ? (
                                    <span className="text-xs text-red-400 flex items-center gap-1">
                                      <TrendingDown className="w-3 h-3" /> Desperdício
                                    </span>
                                  ) : (
                                    <span className="text-xs text-slate-500">Observar</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}