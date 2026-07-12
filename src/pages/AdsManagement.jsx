import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { loadAllCampaigns, classifyCampaigns } from '@/lib/campaignUtils';
import {
  Search, Save, Loader2, CheckCircle, AlertCircle, Megaphone, Brain,
  RefreshCw, TrendingUp, TrendingDown, X, Plus, ListFilter, Clock,
  Settings, Package, History, Zap, Bot, Sparkles, ChevronDown, ChevronUp,
  Pause, Trash2, Rocket, Wifi, WifiOff, Shield } from
'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import CampaignConfigPanel from '@/components/ads/CampaignConfigPanel';
import CampaignHistoryTab from '@/components/ads/CampaignHistoryTab';
import ReconciliationPanel from '@/components/ads/ReconciliationPanel';
import KickoffModal from '@/components/products/KickoffModal';
import CreateCampaignWizard from '@/components/ads/CreateCampaignWizard';
import CampaignHealthPanel from '@/components/ads/CampaignHealthPanel';


const NOW_MS = Date.now();
const H24 = 24 * 60 * 60 * 1000;

function isNew24h(campaign) {
  const ts =
  campaign.created_at ||
  campaign.start_date ||
  campaign.synced_at ||
  campaign.last_sync_at;
  if (!ts) return false;
  return NOW_MS - new Date(ts).getTime() < H24;
}

function isAiManaged(campaign) {
  return campaign.created_by_app === true || campaign.learning_eligible !== false;
}

// Extrai ASIN do nome da campanha (ex: "AUTO | B0FCYPPG2M | ...")
function extractAsinFromName(name) {
  if (!name) return null;
  const m = name.match(/\b(B0[A-Z0-9]{8})\b/);
  return m ? m[1] : null;
}

// Retorna o ASIN canônico da campanha (campo ou extraído do nome)
function getCampaignAsin(c) {
  return c.asin || extractAsinFromName(c.name || c.campaign_name) || null;
}

const STATE_FILTERS = [
{ key: 'all', label: 'Todas' },
{ key: 'enabled', label: 'Ativas' },
{ key: 'paused', label: 'Pausadas' },
{ key: 'archived', label: 'Arquivadas' }];


function CampaignColumn({ title, icon: Icon, color, campaigns, products, selectedId, onSelect, loading, stateFilter, onStateFilter }) {
  return (
    <div className="flex-1 flex flex-col min-w-0 border-r border-surface-2 last:border-r-0">
      {/* Column header */}
      <div className={`px-3 py-2 border-b border-surface-2 flex items-center gap-2`}>
        <Icon className={`w-3.5 h-3.5 ${color}`} />
        <span className={`text-xs font-bold uppercase tracking-wider ${color}`}>{title}</span>
        <span className="ml-auto text-xs text-slate-600 font-mono">{campaigns.length}</span>
      </div>
      {/* State filter per column */}
      <div className="px-2 py-1.5 border-b border-surface-2 flex gap-1">
        {STATE_FILTERS.map((f) =>
        <button key={f.key} onClick={() => onStateFilter(f.key)}
        className={`px-1.5 py-0.5 text-[9px] rounded transition-colors font-medium ${stateFilter === f.key ? `bg-cyan/20 text-cyan border border-cyan/30` : 'text-slate-600 hover:text-slate-300'}`}>
            {f.label}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {loading ?
        <div className="flex items-center justify-center py-8">
            <Loader2 className="w-4 h-4 text-cyan animate-spin" />
          </div> :
        campaigns.length === 0 ?
        <p className="text-[10px] text-slate-600 text-center py-6 px-2">Nenhuma campanha</p> :

        campaigns.map((c, i) => {
          const isSelected = selectedId === c.id;
          const isNew = isNew24h(c);
          const aiManaged = isAiManaged(c);
          const acosColor = (c.acos || 0) > 40 ? 'text-red-400' : (c.acos || 0) > 25 ? 'text-amber-400' : 'text-emerald-400';
          const prod = c.asin ? products.find((p) => p.asin === c.asin) : null;

          return (
            <div
              key={c.id || i}
              onClick={() => onSelect(c)}
              className={`w-full text-left px-3 py-2.5 border-b border-surface-2/40 transition-all cursor-pointer ${
              isSelected ?
              'bg-surface-2 border-l-2 border-l-cyan' :
              'hover:bg-surface-1/60 border-l-2 border-l-transparent'}`
              }>
              
                {/* Name + badges */}
                <div className="flex items-start gap-1.5 mb-1">
                  <p className="text-[11px] font-medium text-white truncate flex-1 leading-tight">
                    {c._asin_resolved ? `AUTO | ${c._asin_resolved}` : (c.name || c.campaign_name)}
                  </p>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {c._group_count > 1 &&
                  <span title={`${c._group_count} campanhas para este ASIN`} className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-300 border border-orange-500/30 leading-none">
                        ×{c._group_count}
                      </span>
                  }
                    {isNew &&
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-400/20 text-amber-300 border border-amber-400/30 leading-none">
                        NEW
                      </span>
                  }
                    {aiManaged &&
                  <span title="Gerido pela IA" className="text-[9px] font-bold px-1 py-0.5 rounded bg-cyan/15 text-cyan border border-cyan/25 leading-none flex items-center gap-0.5">
                        <Bot className="w-2.5 h-2.5" />
                      </span>
                  }
                  </div>
                </div>

                {/* ASIN/SKU */}
                {prod ?
              <p className="text-[9px] text-slate-500 truncate mb-1">
                    <span className="text-cyan font-mono">{prod.asin}</span>
                    {prod.sku ? <span className="ml-1">· {prod.sku}</span> : null}
                  </p> :
              (c.asin || c._asin_resolved) ?
              <p className="text-[9px] font-mono text-slate-500 mb-1">{c.asin || c._asin_resolved}</p> :
              null}

                {/* Metrics row */}
                <div className="flex items-center gap-2 flex-wrap">
                  <StatusBadge status={c.state || c.status} size="xs" />
                  <span className="text-[10px] text-slate-500">R${(c.spend || 0).toFixed(0)}</span>
                  {(c.acos || 0) > 0 &&
                <span className={`text-[10px] font-semibold ${acosColor}`}>{(c.acos || 0).toFixed(0)}%</span>
                }
                </div>
              </div>);

        })
        }
      </div>
    </div>);

}

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
  const [stateFilterAuto, setStateFilterAuto] = useState('all');
  const [stateFilterManual, setStateFilterManual] = useState('all');
  const [activeTab, setActiveTab] = useState('keywords');
  const [searchTerms, setSearchTerms] = useState([]);
  const [negSuggestions, setNegSuggestions] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);
  const [products, setProducts] = useState([]);
  const [campaignAction, setCampaignAction] = useState(null); // 'pausing' | 'removing' | null
  const [campaignActionMsg, setCampaignActionMsg] = useState(null);
  const [kickoffProduct, setKickoffProduct] = useState(null);
  const [showCreateWizard, setShowCreateWizard] = useState(false);
  const [tokenCheck, setTokenCheck] = useState(null);
  const [pausingNoStock, setPausingNoStock] = useState(false);
  const [pauseNoStockMsg, setPauseNoStockMsg] = useState(null);

  const pauseNoStockCampaigns = async (dryRun = false) => {
    if (!account || pausingNoStock) return;
    if (!dryRun && !window.confirm('Pausar campanhas automáticas sem estoque ou kickoff? Esta ação será aplicada na Amazon Ads API.')) return;
    setPausingNoStock(true);
    setPauseNoStockMsg(null);
    try {
      const res = await base44.functions.invoke('pauseAutoCampaignsNoStock', {
        amazon_account_id: account.id, dry_run: dryRun,
      });
      const d = res?.data;
      if (d?.ok) {
        if (dryRun) {
          setPauseNoStockMsg({ type: 'info', text: `Simulação: ${d.would_pause} campanha(s) seriam pausadas.` });
        } else {
          setPauseNoStockMsg({ type: 'success', text: d.message });
          await loadCampaigns();
        }
      } else {
        setPauseNoStockMsg({ type: 'error', text: d?.error || 'Erro ao pausar.' });
      }
    } catch (e) {
      setPauseNoStockMsg({ type: 'error', text: e.message });
    } finally {
      setPausingNoStock(false);
      setTimeout(() => setPauseNoStockMsg(null), 10000);
    }
  };

  const checkToken = async () => {
    setTokenCheck('checking');
    const t0 = Date.now();
    try {
      const res = await base44.functions.invoke('listAdsProfiles', {});
      const latency = Date.now() - t0;
      const profiles = res?.data?.profiles || [];
      setTokenCheck({ ok: profiles.length > 0, profiles, latency, checkedAt: new Date().toLocaleTimeString('pt-BR') });
    } catch (e) {
      setTokenCheck({ ok: false, error: e.message, latency: Date.now() - t0, checkedAt: new Date().toLocaleTimeString('pt-BR') });
    }
    setTimeout(() => setTokenCheck(null), 15000);
  };

  const loadCampaigns = async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accounts[0] || null;
      setAccount(acc);
      if (!acc) return;
      const [cams, prods] = await Promise.all([
      loadAllCampaigns(acc.id),
      base44.entities.Product.filter({ amazon_account_id: acc.id }, null, 500)]
      );
      // Excluir apenas incompletas; arquivadas ficam para o filtro por coluna
      const operational = cams.filter((c) =>
      c.is_operational !== false &&
      c.state !== 'incomplete' &&
      !c.is_incomplete
      );

      // Garantir que campanhas externas (não criadas pelo app) também sejam marcadas como elegíveis para IA
      const toEnable = operational.filter((c) => !c.created_by_app && c.learning_eligible === false);
      if (toEnable.length > 0) {
        await Promise.all(
          toEnable.map((c) => base44.entities.Campaign.update(c.id, { learning_eligible: true }).catch(() => {}))
        );
        toEnable.forEach((c) => {c.learning_eligible = true;});
      }

      setCampaigns(operational);
      setProducts(prods);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {loadCampaigns();}, []);

  const forceSync = async () => {
    if (!account || syncing) return;
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await base44.functions.invoke('syncAdsQuick', { amazon_account_id: account.id });
      if (res?.data?.ok) {
        setSyncMsg({ type: 'success', text: `${res.data.campaigns_updated || 0} campanhas sincronizadas.` });
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

  const loadKeywordsForCampaign = async (campaign) => {
    setKwLoading(true);
    try {
      // Buscar por todos os IDs possíveis: campaign_id (Amazon ID), amazon_campaign_id, e o id interno Base44
      const possibleIds = [...new Set([
      campaign.campaign_id,
      campaign.amazon_campaign_id,
      campaign.id].
      filter(Boolean))];

      const kwBatches = await Promise.all(
        possibleIds.map((cid) =>
        base44.entities.Keyword.filter({ campaign_id: cid }, '-spend', 500).catch(() => [])
        )
      );
      // Também buscar por ASIN se disponível (fallback para campanhas sem campaign_id linkado)
      let asinKws = [];
      if (campaign.asin && account?.id) {
        asinKws = await base44.entities.Keyword.filter({ amazon_account_id: account.id, asin: campaign.asin }, '-spend', 200).catch(() => []);
      }

      const allKws = [...kwBatches.flat(), ...asinKws];
      const kwMap = new Map(allKws.map((k) => [k.id, k]));
      const dedupedKws = Array.from(kwMap.values());

      const negBatches = await Promise.all(
        possibleIds.map((cid) =>
        base44.entities.NegativeKeywordSuggestion.filter({ campaign_id: cid, status: 'pending' }, '-created_date', 50).catch(() => [])
        )
      );
      const negMap = new Map(negBatches.flat().map((n) => [n.id, n]));

      setKeywords(dedupedKws.filter((k) => k.source !== 'search_term'));
      setSearchTerms(dedupedKws.filter((k) => k.source === 'search_term'));
      setNegSuggestions(Array.from(negMap.values()));

      if ((campaign.days_running || 0) >= 30) {
        base44.functions.invoke('analyzeKeywordHourlyPerformance', {
          amazon_account_id: account?.id,
          campaign_id: campaign.amazon_campaign_id || campaign.campaign_id
        }).then(async () => {
          const updBatches = await Promise.all(
            possibleIds.map((cid) =>
            base44.entities.Keyword.filter({ campaign_id: cid }, '-spend', 500).catch(() => [])
            )
          );
          const updMap = new Map(updBatches.flat().map((k) => [k.id, k]));
          setKeywords(Array.from(updMap.values()).filter((k) => k.source !== 'search_term'));
        }).catch(() => {});
      }
    } catch {
      setKeywords([]);setSearchTerms([]);setNegSuggestions([]);
    } finally {
      setKwLoading(false);
    }
  };

  const selectCampaign = async (campaign) => {
    setSelectedCampaign(campaign);
    setPendingBids({});
    setActiveTab(campaign.state === 'paused' ? 'history' : 'keywords');
    await loadKeywordsForCampaign(campaign);
  };

  const applyBids = async () => {
    if (Object.keys(pendingBids).length === 0) return;
    setSaveState('loading');setSaveError(null);
    try {
      await base44.entities.Keyword.bulkUpdate(Object.entries(pendingBids).map(([id, bid]) => ({ id, bid })));
      setKeywords((prev) => prev.map((kw) => pendingBids[kw.id] !== undefined ? { ...kw, bid: pendingBids[kw.id] } : kw));
      setSaveState('success');setPendingBids({});
      setTimeout(() => setSaveState('idle'), 3000);
    } catch (err) {
      setSaveState('error');setSaveError(err.message || 'Erro ao aplicar bids');
      setTimeout(() => setSaveState('idle'), 4000);
    }
  };

  const negateKeyword = async (suggestion) => {
    try {
      await base44.entities.NegativeKeywordSuggestion.update(suggestion.id, { status: 'approved' });
      setNegSuggestions((prev) => prev.filter((s) => s.id !== suggestion.id));
      await base44.entities.AgentAction.create({
        amazon_account_id: account.id, action: 'negative_keyword',
        campaign_id: suggestion.campaign_id, keyword: suggestion.keyword_text,
        reason: 'Negativação manual via dashboard',
        evidence: `Search term: ${suggestion.keyword_text}, Spend: R$${(suggestion.spend || 0).toFixed(2)}, Clicks: ${suggestion.clicks || 0}`,
        risk_level: 'medium', requires_approval: false, status: 'pending'
      });
    } catch (err) {console.error('Erro ao negativar:', err);}
  };

  const promoteKeyword = async (searchTerm) => {
    try {
      const existing = await base44.entities.Keyword.filter({ amazon_account_id: account.id, campaign_id: searchTerm.campaign_id, keyword_text: searchTerm.keyword_text, source: 'manual' });
      if (existing.length > 0) {alert(`Keyword "${searchTerm.keyword_text}" já existe nesta campanha.`);return;}
      await base44.entities.Keyword.create({
        amazon_account_id: account.id, campaign_id: searchTerm.campaign_id,
        ad_group_id: searchTerm.ad_group_id || '',
        keyword_id: `manual_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        keyword_text: searchTerm.keyword_text, match_type: 'exact',
        state: 'enabled', status: 'enabled', current_bid: 0.30, bid: 0.30, source: 'manual',
        first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), synced_at: new Date().toISOString()
      });
      const asin = searchTerm.advertised_asin || selectedCampaign?.asin;
      if (asin && searchTerm.keyword_text) {
        base44.functions.invoke('negateKeywordInAutoCampaign', {
          amazon_account_id: account.id, asin,
          keyword_text: searchTerm.keyword_text,
          manual_campaign_id: searchTerm.campaign_id,
          triggered_by: 'user_promote'
        }).catch(() => {});
      }
      setSearchTerms((prev) => prev.filter((st) => st.id !== searchTerm.id));
    } catch (err) {console.error('Erro ao promover:', err);alert('Erro ao promover keyword: ' + err.message);}
  };

  const pauseCampaign = async () => {
    if (!selectedCampaign || campaignAction) return;
    setCampaignAction('pausing');
    setCampaignActionMsg(null);
    try {
      const response = await base44.functions.invoke('pauseCampaign', {
        amazon_account_id: account.id,
        campaign_id: selectedCampaign.campaign_id,
        asin: selectedCampaign.asin
      });
      if (!response?.data?.ok) throw new Error(response?.data?.error || 'Falha ao pausar campanha');
      // Atualizar estado local imediatamente
      setSelectedCampaign((prev) => ({ ...prev, state: 'paused', status: 'paused' }));
      setCampaigns((prev) => prev.map((c) => c.id === selectedCampaign.id ? { ...c, state: 'paused', status: 'paused' } : c));
      const msg = response.data.api_warning ?
      `Pausada localmente. Sincronização com Amazon pendente.` :
      'Campanha pausada com sucesso.';
      setCampaignActionMsg({ type: 'success', text: msg });
    } catch (e) {
      setCampaignActionMsg({ type: 'error', text: 'Erro ao pausar: ' + e.message });
    } finally {
      setCampaignAction(null);
      setTimeout(() => setCampaignActionMsg(null), 7000);
    }
  };

  const removeCampaign = async () => {
    if (!selectedCampaign || campaignAction) return;
    if (!window.confirm(`Remover a campanha "${selectedCampaign.name || selectedCampaign.campaign_name}" do painel? Ela será marcada como arquivada localmente.`)) return;
    setCampaignAction('removing');
    try {
      await base44.entities.Campaign.update(selectedCampaign.id, { archived: true, state: 'archived', status: 'archived' });
      setCampaigns((prev) => prev.filter((c) => c.id !== selectedCampaign.id));
      setSelectedCampaign(null);
    } catch (e) {
      setCampaignActionMsg({ type: 'error', text: 'Erro ao remover: ' + e.message });
    } finally {
      setCampaignAction(null);
    }
  };

  const hasPending = Object.keys(pendingBids).length > 0;

  // ── Separar AUTO / MANUAL ──────────────────────────────────────────────────
  const applySearch = (list) => list.filter((c) =>
  !search || (c.name || '').toLowerCase().includes(search.toLowerCase()) || (c.campaign_name || '').toLowerCase().includes(search.toLowerCase())
  );

  // Agrupar campanhas automáticas por ASIN: mostra a mais recente/ativa, com contagem
  const rawAuto = applySearch(campaigns.filter((c) => (c.targeting_type || '').toUpperCase() === 'AUTO'))
    .filter((c) => stateFilterAuto === 'all' || c.state === stateFilterAuto || c.status === stateFilterAuto);

  const autoByAsin = (() => {
    const map = new Map();
    for (const c of rawAuto) {
      const asin = getCampaignAsin(c) || c.id;
      if (!map.has(asin)) { map.set(asin, []); }
      map.get(asin).push(c);
    }
    return Array.from(map.values()).map(group => {
      // Priorizar enabled, depois mais recente
      const enabled = group.filter(c => (c.state || c.status) === 'enabled');
      const representative = enabled.length > 0 ? enabled[0] : group[0];
      return { ...representative, _asin_resolved: getCampaignAsin(representative) || representative.id, _group_count: group.length, _group_all: group };
    });
  })();

  const autoCampaigns = autoByAsin;
  const manualCampaigns = applySearch(campaigns.filter((c) => (c.targeting_type || '').toUpperCase() !== 'AUTO')).
  filter((c) => stateFilterManual === 'all' || c.state === stateFilterManual || c.status === stateFilterManual);

  const totalSpend = campaigns.reduce((s, c) => s + (c.spend || 0), 0);
  const totalSales = campaigns.reduce((s, c) => s + (c.sales || 0), 0);
  const { active_count: activeCount, paused_count: pausedCount, total_current } = classifyCampaigns(campaigns);
  const newCount = campaigns.filter(isNew24h).length;

  return (
    <div className="flex h-full">

      {/* ── Sidebar dupla coluna ──────────────────────────────────────────── */}
      <div className="w-[480px] flex-shrink-0 border-r border-surface-2 bg-[#0D0F14] flex flex-col">

        {/* Header */}
        <div className="p-3 border-b border-surface-2">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-bold text-slate-300">Campanhas</span>
            <div className="flex items-center gap-1.5">
              <button onClick={() => setShowCreateWizard(true)} disabled={!account}
              className="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25 rounded-lg transition-colors disabled:opacity-50">
                <Plus className="w-3 h-3" /> Criar
              </button>
              <button onClick={() => pauseNoStockCampaigns(false)} disabled={pausingNoStock || !account}
              title="Pausa campanhas AUTO cujo produto não tem estoque nem kickoff agendado"
              className="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold bg-amber-500/15 border border-amber-500/30 text-amber-400 hover:bg-amber-500/25 rounded-lg transition-colors disabled:opacity-50">
                {pausingNoStock ? <Loader2 className="w-3 h-3 animate-spin" /> : <Pause className="w-3 h-3" />}
                Pausar sem estoque
              </button>
              



              
              















              
              



              
            </div>
          </div>

          {/* Stats row */}
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-[10px] text-slate-500">{total_current} operacionais · {activeCount} ativas · {pausedCount} pausadas</span>
            {newCount > 0 &&
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-400/20 text-amber-300 border border-amber-400/30">
                {newCount} NEW (24h)
              </span>
            }
          </div>

          {syncMsg &&
          <p className={`text-[10px] mt-1.5 ${syncMsg.type === 'success' ? 'text-emerald-400' : 'text-red-400'}`}>{syncMsg.text}</p>
          }
          {pauseNoStockMsg &&
          <p className={`text-[10px] mt-1.5 ${pauseNoStockMsg.type === 'success' ? 'text-emerald-400' : pauseNoStockMsg.type === 'info' ? 'text-cyan' : 'text-red-400'}`}>{pauseNoStockMsg.text}</p>
          }
          {tokenCheck && tokenCheck !== 'checking' &&
          <div className={`mt-1.5 px-2.5 py-1.5 rounded-lg text-[10px] flex items-center gap-2 ${tokenCheck.ok ? 'bg-emerald-500/10 border border-emerald-500/20' : 'bg-red-500/10 border border-red-500/20'}`}>
              {tokenCheck.ok ?
            <><Wifi className="w-3 h-3 text-emerald-400 flex-shrink-0" /><span className="text-emerald-300">API OK · {tokenCheck.profiles?.length} profile(s) · {tokenCheck.latency}ms · {tokenCheck.checkedAt}</span></> :
            <><WifiOff className="w-3 h-3 text-red-400 flex-shrink-0" /><span className="text-red-300">Falha: {tokenCheck.error?.slice(0, 80)} · {tokenCheck.checkedAt}</span></>
            }
            </div>
          }

        </div>

        {/* Search filter */}
        <div className="px-3 py-2 border-b border-surface-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Pesquisar campanhas..."
            className="w-full pl-6 pr-2 py-1 bg-surface-2 border border-surface-3 rounded text-[10px] text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan/50" />
          </div>
        </div>

        {/* Two-column campaign list */}
        <div className="flex flex-1 min-h-0">
          <CampaignColumn
            title="Automáticas"
            icon={Zap}
            color="text-amber-400"
            campaigns={autoCampaigns}
            products={products}
            selectedId={selectedCampaign?.id}
            onSelect={selectCampaign}
            loading={loading}
            stateFilter={stateFilterAuto}
            onStateFilter={setStateFilterAuto} />
          
          <CampaignColumn
            title="Manuais"
            icon={Sparkles}
            color="text-cyan"
            campaigns={manualCampaigns}
            products={products}
            selectedId={selectedCampaign?.id}
            onSelect={selectCampaign}
            loading={loading}
            stateFilter={stateFilterManual}
            onStateFilter={setStateFilterManual} />
          
        </div>

        {/* KPI bottom */}
        <div className="p-3 border-t border-surface-2 grid grid-cols-2 gap-2">
          <div className="bg-surface-2 rounded-lg p-2">
            <p className="text-[10px] text-slate-500 mb-0.5">Spend Total</p>
            <p className="text-sm font-bold text-white">R${totalSpend.toFixed(0)}</p>
          </div>
          <div className="bg-surface-2 rounded-lg p-2">
            <p className="text-[10px] text-slate-500 mb-0.5">Vendas Total</p>
            <p className="text-sm font-bold text-emerald-400">R${totalSales.toFixed(0)}</p>
          </div>
        </div>

        {/* Reconciliation Panel */}
        <div className="p-3 border-t border-surface-2">
          <ReconciliationPanel account={account} onDone={loadCampaigns} />
        </div>
      </div>

      {/* ── Painel de detalhes ────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">
        {!selectedCampaign ?
        <CampaignHealthPanel campaigns={campaigns} products={products} /> :


        <>
            {/* Campaign header */}
            <div className="px-6 py-4 border-b border-surface-2 bg-surface-1 flex-shrink-0">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <h2 className="text-base font-bold text-white truncate">{selectedCampaign.name || selectedCampaign.campaign_name}</h2>
                    {isNew24h(selectedCampaign) &&
                  <span className="text-xs font-bold px-2 py-0.5 rounded bg-amber-400/20 text-amber-300 border border-amber-400/30">NEW</span>
                  }
                    {(selectedCampaign.targeting_type || '').toUpperCase() === 'AUTO' ?
                  <span className="text-xs font-semibold px-2 py-0.5 rounded bg-amber-400/10 text-amber-400 border border-amber-400/20 flex items-center gap-1">
                        <Zap className="w-3 h-3" /> AUTO
                      </span> :

                  <span className="text-xs font-semibold px-2 py-0.5 rounded bg-cyan/10 text-cyan border border-cyan/20 flex items-center gap-1">
                        <Sparkles className="w-3 h-3" /> MANUAL
                      </span>
                  }
                    {isAiManaged(selectedCampaign) &&
                  <span className="text-xs font-semibold px-2 py-0.5 rounded bg-violet-500/10 text-violet-400 border border-violet-500/20 flex items-center gap-1">
                        <Bot className="w-3 h-3" /> Gerida pela IA
                      </span>
                  }
                  </div>
                  <div className="flex items-center gap-3 mt-1 flex-wrap">
                    <StatusBadge status={selectedCampaign.state} />
                    <span className="text-xs text-slate-400">Orçamento: <span className="text-white">R${(selectedCampaign.daily_budget || 0).toFixed(2)}/dia</span></span>
                    <span className="text-xs text-slate-400">Spend: <span className="text-white">R${(selectedCampaign.spend || 0).toFixed(2)}</span></span>
                    <span className="text-xs text-slate-400">Vendas: <span className="text-emerald-400">R${(selectedCampaign.sales || 0).toFixed(2)}</span></span>
                    <span className="text-xs text-slate-400">ACoS: <span className={`font-semibold ${(selectedCampaign.acos || 0) > 40 ? 'text-red-400' : 'text-emerald-400'}`}>{(selectedCampaign.acos || 0).toFixed(1)}%</span></span>
                    <span className="text-xs text-slate-400">ROAS: <span className="text-cyan">{(selectedCampaign.roas || 0).toFixed(2)}x</span></span>
                    <span className="text-xs text-slate-400">CPC: <span className="text-white">R${(selectedCampaign.cpc || 0).toFixed(2)}</span></span>
                    <span className="text-xs text-slate-400">Cliques: <span className="text-white">{(selectedCampaign.clicks || 0).toLocaleString()}</span></span>
                    <span className="text-xs text-slate-400">Pedidos: <span className="text-white">{selectedCampaign.orders || 0}</span></span>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
                  {campaignActionMsg &&
                <span className={`text-xs px-2 py-1 rounded ${campaignActionMsg.type === 'success' ? 'text-emerald-400' : 'text-red-400'}`}>
                      {campaignActionMsg.text}
                    </span>
                }
                  {/* Kick-off manual para a campanha selecionada */}
                  {(() => {
                  const prod = selectedCampaign.asin ? products.find((p) => p.asin === selectedCampaign.asin) : null;
                  if (!prod) return null;
                  return (
                    <button onClick={() => setKickoffProduct(prod)}
                    className="px-3 py-2 text-xs font-semibold bg-violet-500/15 border border-violet-500/30 text-violet-400 hover:bg-violet-500/25 rounded-lg transition-colors flex items-center gap-1.5">
                        <Rocket className="w-3.5 h-3.5" /> Kick-off
                      </button>);

                })()}
                  {/* Pausar */}
                  {(selectedCampaign.state === 'enabled' || selectedCampaign.status === 'enabled') &&
                <button onClick={pauseCampaign} disabled={!!campaignAction}
                className="px-3 py-2 text-xs font-semibold bg-amber-500/15 border border-amber-500/30 text-amber-400 hover:bg-amber-500/25 rounded-lg transition-colors flex items-center gap-1.5 disabled:opacity-50">
                      {campaignAction === 'pausing' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Pause className="w-3.5 h-3.5" />}
                      Pausar
                    </button>
                }
                  {/* Remover do painel */}
                  <button onClick={removeCampaign} disabled={!!campaignAction}
                className="px-3 py-2 text-xs font-semibold bg-red-500/10 border border-red-500/25 text-red-400 hover:bg-red-500/20 rounded-lg transition-colors flex items-center gap-1.5 disabled:opacity-50">
                    {campaignAction === 'removing' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                    Remover
                  </button>
                  <button onClick={async () => {
                  try {await base44.functions.invoke('monitorSearchTerms', { amazon_account_id: account.id });}
                  catch (e) {console.error(e);}
                }} className="px-3 py-2 text-xs font-semibold bg-surface-2 border border-surface-3 text-slate-300 hover:text-white rounded-lg transition-colors flex items-center gap-1.5">
                    <Brain className="w-3.5 h-3.5" /> Analisar Search Terms
                  </button>
                  {keywords.length > 0 &&
                <button onClick={() => {const b = {};keywords.forEach((kw) => {b[kw.id] = 0.50;});setPendingBids(b);}}
                className="px-3 py-2 text-xs font-semibold bg-amber-500/15 border border-amber-500/30 text-amber-400 hover:bg-amber-500/25 rounded-lg transition-colors flex items-center gap-1.5">
                      <TrendingUp className="w-3.5 h-3.5" /> Bids → R$0,50
                    </button>
                }
                  {hasPending &&
                <button onClick={applyBids} disabled={saveState === 'loading'}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all ${saveState === 'success' ? 'bg-emerald-600 text-white' : saveState === 'error' ? 'bg-red-600 text-white' : 'bg-cyan hover:bg-cyan/90 text-white'}`}>
                      {saveState === 'loading' ? <Loader2 className="w-4 h-4 animate-spin" /> : saveState === 'success' ? <CheckCircle className="w-4 h-4" /> : saveState === 'error' ? <AlertCircle className="w-4 h-4" /> : <Save className="w-4 h-4" />}
                      {saveState === 'loading' ? 'Guardando...' : saveState === 'success' ? 'Bids guardados!' : saveState === 'error' ? saveError || 'Erro' : `Guardar ${Object.keys(pendingBids).length} bid(s)`}
                    </button>
                }
                </div>
              </div>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-surface-2 bg-[#0D0F14] flex-shrink-0">
              {[
            { key: 'keywords', label: `Keywords (${keywords.length})` },
            { key: 'search-terms', label: `Search Terms${searchTerms.length > 0 ? ` (${searchTerms.length})` : ''}${negSuggestions.length > 0 ? ` · ${negSuggestions.length} neg.` : ''}` },
            { key: 'config', label: 'Configurações', icon: Settings },
            { key: 'history', label: 'Histórico', icon: History }].
            map((tab) =>
            <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            className={`px-5 py-3 text-xs font-semibold border-b-2 transition-colors flex items-center gap-1.5 ${activeTab === tab.key ? 'border-cyan text-cyan' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
                  {tab.icon && <tab.icon className="w-3.5 h-3.5" />}
                  {tab.label}
                </button>
            )}
            </div>

            {/* Tab content */}
            <div className="flex-1 overflow-y-auto scrollbar-thin">
              {activeTab === 'config' ?
            <CampaignConfigPanel campaign={selectedCampaign} account={account} products={products}
            onSaved={(updated) => {setSelectedCampaign(updated);setCampaigns((prev) => prev.map((c) => c.id === updated.id ? updated : c));}} /> :
            activeTab === 'history' ?
            <CampaignHistoryTab campaign={selectedCampaign} account={account} /> :
            activeTab === 'keywords' ?
            <>
                  {kwLoading ?
              <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div> :
              keywords.length === 0 ?
              <div className="flex flex-col items-center justify-center py-16 gap-4 text-center">
                      <Search className="w-8 h-8 text-slate-600" />
                      <div>
                        <p className="text-sm text-slate-400">Sem keywords para esta campanha.</p>
                        <p className="text-xs text-slate-600 mt-1">Execute um Sync para importar keywords da Amazon.</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                    onClick={async () => {
                      setKwLoading(true);
                      try {
                        await base44.functions.invoke('syncAdGroupsAndKeywords', { amazon_account_id: account?.id, campaign_id: selectedCampaign?.campaign_id || selectedCampaign?.amazon_campaign_id });
                      } catch {}
                      await loadKeywordsForCampaign(selectedCampaign);
                    }}
                    className="flex items-center gap-2 px-4 py-2 bg-cyan/10 border border-cyan/20 text-cyan hover:bg-cyan/20 text-xs font-semibold rounded-lg transition-colors">
                    
                          <RefreshCw className="w-3.5 h-3.5" /> Sync Keywords
                        </button>
                        <button
                    onClick={() => loadKeywordsForCampaign(selectedCampaign)}
                    className="flex items-center gap-2 px-4 py-2 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-xs font-semibold rounded-lg transition-colors">
                    
                          <RefreshCw className="w-3.5 h-3.5" /> Recarregar
                        </button>
                      </div>
                    </div> :

              <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-[#0D0F14] z-10">
                        <tr className="border-b border-surface-2">
                          {['Produto / SKU', 'Keyword', 'Match', 'Estado', 'Melhor horário', 'Bid Atual', 'Novo Bid', 'ACoS', 'Cliques', 'Spend', 'Vendas'].map((h) =>
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                    )}
                        </tr>
                      </thead>
                      <tbody>
                        {keywords.map((kw, i) => {
                    const changed = kw.id in pendingBids;
                    const kwProduct = kw.asin ?
                    products.find((p) => p.asin === kw.asin) || products.find((p) => p.asin === selectedCampaign?.asin) :
                    products.find((p) => p.asin === selectedCampaign?.asin);
                    const acosColor = (kw.acos || 0) > 50 ? 'text-red-400' : (kw.acos || 0) > 30 ? 'text-amber-400' : 'text-emerald-400';
                    const renderBestHour = () => {
                      if (!kw.hourly_data_mature || kw.best_hour_start == null) {
                        return <div className="flex items-center gap-1 text-slate-500"><Clock className="w-3 h-3" /><span className="text-[10px]">Aprendendo</span></div>;
                      }
                      const s = String(kw.best_hour_start).padStart(2, '0');
                      const e = String(kw.best_hour_end).padStart(2, '0');
                      return (
                        <div className="space-y-0.5">
                                <div className="flex items-center gap-1"><Clock className="w-3 h-3 text-cyan" /><span className="text-xs font-semibold text-white">{s}h–{e}h</span></div>
                                {kw.best_hour_roas && <div className="text-[10px] text-slate-400">ROAS {kw.best_hour_roas} · {kw.best_hour_sales} vendas</div>}
                              </div>);

                    };
                    return (
                      <tr key={kw.id || i} className={`border-b border-surface-2/50 transition-colors ${changed ? 'bg-cyan/5' : 'hover:bg-surface-2'}`}>
                              <td className="px-4 py-2.5 min-w-[120px]">
                                {kwProduct ?
                          <div className="flex items-center gap-2">
                                    {kwProduct.product_image_url ?
                            <img src={kwProduct.product_image_url} alt="" className="w-7 h-7 rounded object-cover bg-surface-3 flex-shrink-0" /> :
                            <div className="w-7 h-7 rounded bg-surface-3 flex items-center justify-center flex-shrink-0"><Package className="w-3 h-3 text-slate-600" /></div>}
                                    <div className="min-w-0">
                                      <p className="text-[10px] font-mono text-cyan truncate">{kwProduct.asin}</p>
                                      {kwProduct.sku && <p className="text-[10px] text-slate-500 truncate">SKU: {kwProduct.sku}</p>}
                                    </div>
                                  </div> :
                          <span className="text-[10px] text-slate-600 font-mono">{kw.asin || selectedCampaign?.asin || '—'}</span>}
                              </td>
                              <td className="px-4 py-2.5 font-medium text-white max-w-[200px] truncate">{kw.keyword_text || '—'}</td>
                              <td className="px-4 py-2.5"><span className="text-xs px-2 py-0.5 bg-surface-3 text-slate-400 rounded">{kw.match_type || '—'}</span></td>
                              <td className="px-4 py-2.5"><StatusBadge status={kw.state || 'enabled'} size="xs" /></td>
                              <td className="px-4 py-2.5">{renderBestHour()}</td>
                              <td className="px-4 py-2.5 text-slate-300">R${(kw.bid || 0).toFixed(2)}</td>
                              <td className="px-4 py-2.5">
                                <input type="number" step="0.01" min="0.02" defaultValue={(kw.bid || 0).toFixed(2)}
                          onChange={(e) => setPendingBids((prev) => ({ ...prev, [kw.id]: parseFloat(e.target.value) || 0 }))}
                          className="w-20 px-2 py-1 bg-surface-3 border border-surface-3 rounded text-xs text-white focus:outline-none focus:border-cyan/50" />
                              </td>
                              <td className="px-4 py-2.5"><span className={`font-semibold text-xs ${acosColor}`}>{(kw.acos || 0).toFixed(1)}%</span></td>
                              <td className="px-4 py-2.5 text-slate-400">{(kw.clicks || 0).toLocaleString()}</td>
                              <td className="px-4 py-2.5 text-slate-400">R${(kw.spend || 0).toFixed(2)}</td>
                              <td className="px-4 py-2.5 text-emerald-400">R${(kw.sales || 0).toFixed(2)}</td>
                            </tr>);

                  })}
                      </tbody>
                    </table>
              }
                </> : (

            /* Search Terms Tab */
            <div className="p-4 space-y-4">
                  {negSuggestions.length > 0 &&
              <div>
                      <h3 className="text-xs font-semibold text-red-400 mb-2 flex items-center gap-1.5">
                        <TrendingDown className="w-3.5 h-3.5" /> {negSuggestions.length} termos para negativar
                      </h3>
                      <div className="space-y-2">
                        {negSuggestions.map((neg) =>
                  <div key={neg.id} className="flex items-center justify-between p-3 bg-red-500/5 border border-red-500/20 rounded-lg">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-white truncate">{neg.keyword_text}</p>
                              <p className="text-xs text-slate-400 mt-0.5">
                                {neg.clicks || 0} clicks · R${(neg.spend || 0).toFixed(2)} · {neg.sales > 0 ? `R$${(neg.sales || 0).toFixed(2)} vendas` : 'zero vendas'}
                              </p>
                              <p className="text-xs text-red-400 mt-0.5">{neg.reason}</p>
                            </div>
                            <button onClick={() => negateKeyword(neg)}
                    className="ml-3 px-3 py-1.5 text-xs font-semibold bg-red-500/20 text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/30 transition-colors flex items-center gap-1.5">
                              <X className="w-3.5 h-3.5" /> Negativar
                            </button>
                          </div>
                  )}
                      </div>
                    </div>
              }
                  <div>
                    <h3 className="text-xs font-semibold text-slate-300 mb-2 flex items-center gap-1.5">
                      <ListFilter className="w-3.5 h-3.5" /> {searchTerms.length} search terms capturados
                    </h3>
                    {searchTerms.length === 0 ?
                <p className="text-sm text-slate-500 text-center py-8">Sem search terms ainda.</p> :

                <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-surface-2">
                            {['Search Term', 'Clicks', 'Spend', 'Vendas', 'ACoS', 'Ação'].map((h) =>
                      <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                      )}
                          </tr>
                        </thead>
                        <tbody>
                          {searchTerms.map((st) => {
                      const isWasting = (st.clicks || 0) >= 5 && (st.spend || 0) >= 2 && (st.sales || 0) === 0;
                      const isGood = (st.sales || 0) > 0 && (st.acos || 0) > 0 && (st.acos || 0) < 40;
                      return (
                        <tr key={st.id} className="border-b border-surface-2/40 hover:bg-surface-2/30">
                                <td className="px-4 py-2.5 text-slate-300 max-w-[200px] truncate">{st.keyword_text || st.keyword || '—'}</td>
                                <td className="px-4 py-2.5 text-slate-400">{(st.clicks || 0).toLocaleString()}</td>
                                <td className="px-4 py-2.5 text-slate-400">R${(st.spend || 0).toFixed(2)}</td>
                                <td className="px-4 py-2.5 text-emerald-400">R${(st.sales || 0).toFixed(2)}</td>
                                <td className={`px-4 py-2.5 font-semibold ${(st.acos || 0) > 50 ? 'text-red-400' : (st.acos || 0) > 30 ? 'text-amber-400' : (st.acos || 0) > 0 ? 'text-emerald-400' : 'text-slate-600'}`}>
                                  {(st.acos || 0) > 0 ? `${(st.acos || 0).toFixed(1)}%` : '—'}
                                </td>
                                <td className="px-4 py-2.5">
                                  {isGood ?
                            <button onClick={() => promoteKeyword(st)}
                            className="px-2.5 py-1 text-xs font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded-lg hover:bg-emerald-500/30 transition-colors flex items-center gap-1">
                                      <Plus className="w-3 h-3" /> Promover
                                    </button> :
                            isWasting ?
                            <span className="text-xs text-red-400 flex items-center gap-1"><TrendingDown className="w-3 h-3" /> Desperdício</span> :

                            <span className="text-xs text-slate-500">Observar</span>
                            }
                                </td>
                              </tr>);

                    })}
                        </tbody>
                      </table>
                }
                  </div>
                </div>)
            }
            </div>
          </>
        }
      </div>

      {kickoffProduct && account &&
      <KickoffModal
        product={kickoffProduct}
        account={account}
        onClose={() => setKickoffProduct(null)}
        onDone={() => {setKickoffProduct(null);loadCampaigns();}} />

      }

      {showCreateWizard && account &&
      <CreateCampaignWizard
        account={account}
        products={products}
        onClose={() => setShowCreateWizard(false)}
        onDone={loadCampaigns} />

      }
    </div>);

}