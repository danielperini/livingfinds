import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Download, Loader2, RefreshCw, Search, Upload, X, Zap } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { loadAllCampaigns, campaignIsArchived } from '@/lib/campaignUtils';
import { Button } from '@/components/ui/button';
import PremiumDataTable from '@/components/ui/PremiumDataTable';

const CLASSIFICATION_CONFIG = {
  winner: { label: 'Vencedor', color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
  promising: { label: 'Promissor', color: 'text-blue-400 bg-blue-400/10 border-blue-400/20' },
  inefficient: { label: 'Ineficiente', color: 'text-amber-400 bg-amber-400/10 border-amber-400/20' },
  negate_candidate: { label: 'Negativar', color: 'text-red-400 bg-red-400/10 border-red-400/20' },
  no_data: { label: 'Sem dados', color: 'text-slate-400 bg-slate-400/10 border-slate-400/20' },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const idOfCampaign = (campaign) => String(campaign?.campaign_id || campaign?.amazon_campaign_id || campaign?.id || '').trim();
const idOfTermCampaign = (term) => String(term?.campaign_id || term?.amazon_campaign_id || '').trim();
const termText = (term) => String(term?.search_term || term?.keyword_text || term?.keyword || '').trim();
const suggestionKey = (item) => `${String(item?.campaign_id || '').trim()}::${String(item?.keyword_text || '').trim().toLocaleLowerCase('pt-BR')}::exact`;

function metricsOf(term) {
  return {
    clicks: Number(term?.clicks || 0),
    orders: Number(term?.orders_14d ?? term?.orders ?? 0),
    spend: Number(term?.spend || 0),
    sales: Number(term?.sales_14d ?? term?.sales ?? 0),
    acos: Number(term?.acos_14d ?? term?.acos ?? 0),
  };
}

function classifyTerm(term, acosTarget) {
  const { clicks, orders, spend, acos } = metricsOf(term);
  if (clicks < 5) return 'no_data';
  if (orders >= 2 && acos > 0 && acos <= acosTarget) return 'winner';
  if (orders === 0 && clicks >= 10 && spend > 2) return 'negate_candidate';
  if (orders === 0 || (acos > 0 && acos > acosTarget * 1.5)) return 'inefficient';
  return 'promising';
}

function campaignIsAutomatic(campaign, term) {
  const explicit = String(campaign?.amazon_targeting_type || campaign?.targeting_type || term?.targeting_type || '').toUpperCase();
  if (explicit) return explicit === 'AUTO' || explicit === 'AUTOMATIC';
  return /\bAUTO(?:MATIC[AO]?)?\b/i.test(String(campaign?.name || campaign?.campaign_name || term?.campaign_name || ''));
}

export default function KeywordManagement() {
  const [account, setAccount] = useState(null);
  const [keywords, setKeywords] = useState([]);
  const [negatives, setNegatives] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('search');
  const [actionMsg, setActionMsg] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);
  const [selectedNegatives, setSelectedNegatives] = useState(new Set());
  const [bulkApplying, setBulkApplying] = useState(false);
  const [importing, setImporting] = useState(false);
  const [fetchingApi, setFetchingApi] = useState(false);
  const [harvesting, setHarvesting] = useState(false);
  const [autoNegating, setAutoNegating] = useState(false);
  const [acosTarget, setAcosTarget] = useState(30);
  const fileInputRef = useRef(null);
  const autoRunKeyRef = useRef('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accounts[0] || (await base44.entities.AmazonAccount.list('-updated_date', 1))[0];
      setAccount(acc || null);
      if (!acc) return;

      const [rules, searchTerms, suggestions, loadedCampaigns] = await Promise.all([
        base44.entities.BudgetRule.filter({ amazon_account_id: acc.id }),
        base44.entities.SearchTerm.filter({ amazon_account_id: acc.id }, '-clicks', 2000),
        base44.entities.NegativeKeywordSuggestion.filter({ amazon_account_id: acc.id }, '-created_date', 1000),
        loadAllCampaigns(acc.id, {}, { includeExcluded: true }),
      ]);

      if (rules[0]?.target_acos) setAcosTarget(Number(rules[0].target_acos));
      setKeywords(searchTerms);
      setNegatives(suggestions);
      setCampaigns(loadedCampaigns.filter((campaign) => !campaignIsArchived(campaign)));
    } catch (error) {
      setActionMsg({ type: 'error', text: `Falha ao carregar Keywords: ${error?.message || 'erro desconhecido'}` });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const campaignById = useMemo(() => new Map(campaigns.map((campaign) => [idOfCampaign(campaign), campaign])), [campaigns]);
  const activeCampaignIds = useMemo(() => new Set(campaigns.map(idOfCampaign).filter(Boolean)), [campaigns]);

  const visibleKeywords = useMemo(() => keywords
    .filter((term) => {
      const campaignId = idOfTermCampaign(term);
      return !campaignId || activeCampaignIds.has(campaignId);
    })
    .map((term) => {
      const metrics = metricsOf(term);
      return { ...term, ...metrics, _displayTerm: termText(term), _class: classifyTerm(term, acosTarget) };
    }), [keywords, activeCampaignIds, acosTarget]);

  const visibleNegatives = useMemo(() => negatives.filter((item) => {
    const campaignId = String(item?.campaign_id || '').trim();
    return !campaignId || activeCampaignIds.has(campaignId);
  }), [negatives, activeCampaignIds]);

  const eligibleAutoNegatives = useMemo(() => {
    const existing = new Set(visibleNegatives.filter((item) => item.status !== 'rejected').map(suggestionKey));
    return visibleKeywords.filter((term) => {
      const campaignId = idOfTermCampaign(term);
      const campaign = campaignById.get(campaignId);
      if (!campaignId || !campaign || !campaignIsAutomatic(campaign, term)) return false;
      if (term._class !== 'negate_candidate' || term.orders > 0 || !term._displayTerm) return false;
      return !existing.has(`${campaignId}::${term._displayTerm.toLocaleLowerCase('pt-BR')}::exact`);
    });
  }, [visibleKeywords, visibleNegatives, campaignById]);

  const executeNegativeSuggestion = useCallback(async (suggestion) => {
    await base44.entities.NegativeKeywordSuggestion.update(suggestion.id, { status: 'approved' });
    await base44.functions.invoke('executeAgentAction', { action_id: suggestion.id, approve: true });
  }, []);

  const autoNegateEligible = useCallback(async (silent = false) => {
    if (!account || autoNegating || eligibleAutoNegatives.length === 0) return;
    setAutoNegating(true);
    let applied = 0;
    let conflicts = 0;
    let failed = 0;

    for (const term of eligibleAutoNegatives.slice(0, 20)) {
      try {
        const suggestion = await base44.entities.NegativeKeywordSuggestion.create({
          amazon_account_id: account.id,
          campaign_id: idOfTermCampaign(term),
          ad_group_id: term.ad_group_id,
          campaign_name: term.campaign_name,
          keyword_text: term._displayTerm,
          match_type: 'exact',
          clicks: term.clicks,
          spend: term.spend,
          sales: term.sales,
          acos: term.acos,
          reason: `Regra determinística: ${term.clicks} cliques, R$ ${term.spend.toFixed(2)} gastos e zero pedidos. Negativa exata em campanha automática.`,
          status: 'pending',
        });
        await executeNegativeSuggestion(suggestion);
        applied += 1;
        await sleep(350);
      } catch (error) {
        const status = Number(error?.response?.status || error?.status || 0);
        if (status === 409) conflicts += 1;
        else if (status === 429) { failed += 1; break; }
        else failed += 1;
      }
    }

    setAutoNegating(false);
    if (!silent || applied || failed) {
      setActionMsg({
        type: failed ? 'info' : 'success',
        text: `Negativação automática: ${applied} aplicadas, ${conflicts} já existentes, ${failed} falhas. Apenas campanhas automáticas ativas e termos sem pedidos foram processados.`,
      });
    }
    await load();
  }, [account, autoNegating, eligibleAutoNegatives, executeNegativeSuggestion, load]);

  useEffect(() => {
    if (loading || !account || eligibleAutoNegatives.length === 0) return;
    const key = `${account.id}:${eligibleAutoNegatives.map((item) => item.id).sort().join(',')}`;
    if (autoRunKeyRef.current === key) return;
    autoRunKeyRef.current = key;
    autoNegateEligible(true);
  }, [loading, account, eligibleAutoNegatives, autoNegateEligible]);

  const approveNegative = async (item) => {
    setActionLoading(item.id);
    try {
      await executeNegativeSuggestion(item);
      setActionMsg({ type: 'success', text: `“${item.keyword_text}” negativada como exata na Amazon.` });
      await load();
    } catch (error) {
      setActionMsg({ type: 'error', text: error?.message || 'Falha ao negativar termo.' });
    } finally { setActionLoading(null); }
  };

  const rejectNegative = async (item) => {
    setActionLoading(item.id);
    try {
      await base44.entities.NegativeKeywordSuggestion.update(item.id, { status: 'rejected' });
      await load();
    } finally { setActionLoading(null); }
  };

  const bulkApproveNegatives = async () => {
    setBulkApplying(true);
    let success = 0;
    for (const id of selectedNegatives) {
      const item = visibleNegatives.find((candidate) => candidate.id === id);
      if (!item || item.status !== 'pending') continue;
      try { await executeNegativeSuggestion(item); success += 1; await sleep(350); } catch {}
    }
    setSelectedNegatives(new Set());
    setBulkApplying(false);
    setActionMsg({ type: 'success', text: `${success} negativas exatas aplicadas.` });
    await load();
  };

  const fetchFromApi = async () => {
    if (!account) return;
    setFetchingApi(true);
    try {
      const response = await base44.functions.invoke('fetchSearchTermsFromApi', { amazon_account_id: account.id, days: 30, manual: true });
      const data = response.data;
      setActionMsg({ type: data?.ok ? 'success' : 'info', text: data?.ok ? `${data.imported || 0} novos termos e ${data.updated || 0} atualizados.` : (data?.error || data?.message || 'Relatório solicitado à Amazon.') });
      await load();
    } catch (error) { setActionMsg({ type: 'error', text: error?.message || 'Falha ao buscar termos.' }); }
    finally { setFetchingApi(false); }
  };

  const runHarvest = async () => {
    if (!account) return;
    setHarvesting(true);
    try {
      const response = await base44.functions.invoke('harvestConvertedSearchTerms', { amazon_account_id: account.id });
      setActionMsg({ type: response.data?.ok ? 'success' : 'error', text: response.data?.ok ? `${response.data.harvested || 0} termos promovidos para campanhas manuais.` : (response.data?.error || 'Falha na colheita.') });
      await load();
    } catch (error) { setActionMsg({ type: 'error', text: error?.message || 'Falha na colheita.' }); }
    finally { setHarvesting(false); }
  };

  const handleImportFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file || !account) return;
    setImporting(true);
    try {
      const upload = await base44.integrations.Core.UploadFile({ file });
      await base44.functions.invoke('importSearchTermReport', { file_url: upload.file_url, amazon_account_id: account.id });
      await load();
    } catch (error) { setActionMsg({ type: 'error', text: error?.message || 'Falha ao importar arquivo.' }); }
    finally { setImporting(false); if (fileInputRef.current) fileInputRef.current.value = ''; }
  };

  const keywordColumns = useMemo(() => [
    { id: 'term', header: 'Termo', sortValue: (row) => row._displayTerm, cell: (row) => <div className="max-w-[300px]"><p className="font-medium text-white truncate">{row._displayTerm}</p><p className="text-[10px] text-slate-400 truncate">{row.campaign_name || 'Campanha ativa'}</p></div> },
    { id: 'class', header: 'Classe', sortValue: (row) => CLASSIFICATION_CONFIG[row._class]?.label, cell: (row) => { const cfg = CLASSIFICATION_CONFIG[row._class]; return <span className={`rounded-full border px-2 py-1 text-xs font-medium ${cfg.color}`}>{cfg.label}</span>; } },
    { id: 'clicks', header: 'Cliques', sortValue: (row) => row.clicks, cell: (row) => row.clicks.toLocaleString('pt-BR') },
    { id: 'spend', header: 'Gasto', sortValue: (row) => row.spend, cell: (row) => row.spend.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) },
    { id: 'sales', header: 'Vendas', sortValue: (row) => row.sales, cell: (row) => <span className="text-emerald-400">{row.sales.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</span> },
    { id: 'acos', header: 'ACoS', sortValue: (row) => row.acos, cell: (row) => row.acos > 0 ? `${row.acos.toFixed(1)}%` : '—' },
    { id: 'action', header: 'Ação', sortValue: (row) => row._class, cell: (row) => row._class === 'negate_candidate' ? <span className="text-xs text-red-400">Automática exata</span> : '—' },
  ], []);

  const negativeColumns = useMemo(() => [
    { id: 'select', header: 'Sel.', sortValue: (row) => selectedNegatives.has(row.id) ? 1 : 0, cell: (row) => row.status === 'pending' ? <input type="checkbox" checked={selectedNegatives.has(row.id)} onChange={() => setSelectedNegatives((current) => { const next = new Set(current); next.has(row.id) ? next.delete(row.id) : next.add(row.id); return next; })} /> : null },
    { id: 'term', header: 'Termo', sortValue: (row) => row.keyword_text, cell: (row) => <span className="font-medium text-white">{row.keyword_text}</span> },
    { id: 'status', header: 'Status', sortValue: (row) => row.status, cell: (row) => <span className={row.status === 'approved' ? 'text-emerald-400' : row.status === 'rejected' ? 'text-red-400' : 'text-amber-400'}>{row.status || 'pending'}</span> },
    { id: 'campaign', header: 'Campanha', sortValue: (row) => row.campaign_name, cell: (row) => row.campaign_name || '—' },
    { id: 'clicks', header: 'Cliques', sortValue: (row) => Number(row.clicks || 0), cell: (row) => Number(row.clicks || 0).toLocaleString('pt-BR') },
    { id: 'spend', header: 'Gasto', sortValue: (row) => Number(row.spend || 0), cell: (row) => Number(row.spend || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) },
    { id: 'acos', header: 'ACoS', sortValue: (row) => Number(row.acos || 0), cell: (row) => Number(row.acos || 0) > 0 ? `${Number(row.acos).toFixed(1)}%` : '—' },
    { id: 'actions', header: 'Ações', sortValue: (row) => row.status, cell: (row) => row.status === 'pending' ? <div className="flex gap-2"><Button size="sm" variant="outline" disabled={actionLoading === row.id} onClick={() => approveNegative(row)}><Check className="h-3 w-3" /> Aprovar</Button><Button size="sm" variant="outline" disabled={actionLoading === row.id} onClick={() => rejectNegative(row)}><X className="h-3 w-3" /> Rejeitar</Button></div> : '—' },
  ], [selectedNegatives, actionLoading]);

  const pendingNegatives = visibleNegatives.filter((item) => item.status === 'pending').length;

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div><h1 className="text-lg font-bold text-white">Gestão de Palavras-chave</h1><p className="text-xs text-slate-400">{visibleKeywords.length} termos de campanhas atuais · {pendingNegatives} negativas pendentes · campanhas arquivadas ocultadas</p></div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" variant="outline" onClick={fetchFromApi} disabled={fetchingApi || !account}><Download className={`h-4 w-4 ${fetchingApi ? 'animate-spin' : ''}`} /> Buscar Amazon</Button>
          <Button size="sm" variant="outline" onClick={runHarvest} disabled={harvesting || !account}><Zap className={`h-4 w-4 ${harvesting ? 'animate-spin' : ''}`} /> Promover convertidos</Button>
          <Button size="sm" onClick={() => autoNegateEligible(false)} disabled={autoNegating || eligibleAutoNegatives.length === 0}><X className={`h-4 w-4 ${autoNegating ? 'animate-spin' : ''}`} /> Negativar elegíveis ({eligibleAutoNegatives.length})</Button>
          <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleImportFile} className="hidden" />
          <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={importing}><Upload className="h-4 w-4" /> Importar</Button>
          <Button size="sm" variant="outline" onClick={load} disabled={loading}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></Button>
        </div>
      </div>

      {actionMsg && <div className={`rounded-xl border px-4 py-3 text-sm ${actionMsg.type === 'error' ? 'border-red-500/30 bg-red-500/10 text-red-300' : actionMsg.type === 'success' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-blue-500/30 bg-blue-500/10 text-blue-300'}`}>{actionMsg.text}</div>}

      <div className="flex gap-2 border-b border-[#24324F]">
        <button className={`px-4 py-2 text-sm font-semibold ${activeTab === 'search' ? 'border-b-2 border-[#5B8CFF] text-white' : 'text-slate-400'}`} onClick={() => setActiveTab('search')}>Search Terms</button>
        <button className={`px-4 py-2 text-sm font-semibold ${activeTab === 'negatives' ? 'border-b-2 border-[#FF5D5D] text-white' : 'text-slate-400'}`} onClick={() => setActiveTab('negatives')}>Palavras negativas ({pendingNegatives})</button>
      </div>

      {loading ? <div className="flex justify-center py-20"><Loader2 className="h-7 w-7 animate-spin text-[#5B8CFF]" /></div> : activeTab === 'search' ? (
        <PremiumDataTable columns={keywordColumns} data={visibleKeywords} searchable searchPlaceholder="Pesquisar termo ou campanha..." initialSort={{ id: 'clicks', direction: 'desc' }} emptyMessage="Nenhum termo de campanha atual encontrado." />
      ) : (
        <div className="space-y-3">
          {selectedNegatives.size > 0 && <div className="flex items-center justify-between rounded-xl border border-[#24324F] bg-[#0B1224] p-3"><span>{selectedNegatives.size} selecionadas</span><Button size="sm" onClick={bulkApproveNegatives} disabled={bulkApplying}>{bulkApplying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Aplicar negativas exatas</Button></div>}
          <PremiumDataTable columns={negativeColumns} data={visibleNegatives} searchable searchPlaceholder="Pesquisar negativa ou campanha..." initialSort={{ id: 'status', direction: 'asc' }} emptyMessage="Nenhuma negativa de campanha atual encontrada." />
        </div>
      )}
    </div>
  );
}
