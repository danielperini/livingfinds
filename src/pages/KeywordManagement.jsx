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

async function loadAllRows(entity, filter) {
  const rows = [];
  const seen = new Set();
  for (let offset = 0; ; offset += 500) {
    const page = await entity.filter(filter, 'id', 500, offset);
    for (const row of page) {
      if (seen.has(row.id)) throw new Error('Dados alterados durante a leitura. Atualize a página.');
      seen.add(row.id);
      rows.push(row);
    }
    if (page.length < 500) return rows;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const idOfTermCampaign = (term) => String(term?.campaign_id || term?.amazon_campaign_id || '').trim();
const termText = (term) => String(term?.search_term || term?.keyword_text || term?.keyword || '').trim();
const suggestionKey = (item) => `${String(item?.campaign_id || '').trim()}::${String(item?.keyword_text || '').trim().toLocaleLowerCase('pt-BR')}::exact`;

function metricOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function metricsOf(term) {
  return {
    clicks: metricOrNull(term?.clicks),
    orders: metricOrNull(term?.orders_14d ?? term?.orders),
    spend: metricOrNull(term?.spend),
    sales: metricOrNull(term?.sales_14d ?? term?.sales),
    acos: metricOrNull(term?.acos_14d ?? term?.acos),
  };
}

function classifyTerm(term, acosTarget) {
  const { clicks, orders, spend, acos } = metricsOf(term);
  if (clicks === null && orders === null && spend === null) return 'no_data';
  if (orders === null) return 'no_data';
  if (orders >= 2 && acos !== null && acos > 0 && acos <= acosTarget) return 'winner';
  // A negative candidate requires a server-validated economic rule, not a universal click count.
  if (orders === 0 && term?.negative_review_eligible === true && clicks !== null && spend !== null && metricsOf(term).sales === 0) return 'negate_candidate';
  if (orders === 0 || (acos !== null && acos > 0 && acos > acosTarget * 1.5)) return 'inefficient';
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
  const [configuredKeywords, setConfiguredKeywords] = useState([]);
  const [negatives, setNegatives] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const campaignScope = new URLSearchParams(window.location.search).get('campaign_id') || '';
  const [activeTab, setActiveTab] = useState('search');
  const [actionMsg, setActionMsg] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);
  const [selectedNegatives, setSelectedNegatives] = useState(new Set());
  const [bulkResults, setBulkResults] = useState(null);
  const [bulkApplying, setBulkApplying] = useState(false);
  const [importing, setImporting] = useState(false);
  const [fetchingApi, setFetchingApi] = useState(false);
  const [harvesting, setHarvesting] = useState(false);
  const [autoNegating, setAutoNegating] = useState(false);
  const [acosTarget, setAcosTarget] = useState(30);
  const fileInputRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const requestedAccount = new URLSearchParams(window.location.search).get('account_id');
      const acc = accounts.find(a => a.id === requestedAccount) || accounts[0] || (await base44.entities.AmazonAccount.list('-updated_date', 1))[0];
      setAccount(acc || null);
      if (!acc) return;

      const [rules, searchTerms, suggestions, loadedCampaigns, configured] = await Promise.all([
        base44.entities.BudgetRule.filter({ amazon_account_id: acc.id }),
        loadAllRows(base44.entities.SearchTerm, { amazon_account_id: acc.id }),
        loadAllRows(base44.entities.NegativeKeywordSuggestion, { amazon_account_id: acc.id }),
        loadAllCampaigns(acc.id, {}, { includeExcluded: true }),
        campaignScope ? loadAllRows(base44.entities.Keyword, { amazon_account_id: acc.id, campaign_id: campaignScope }) : Promise.resolve([]),
      ]);

      if (rules[0]?.target_acos) setAcosTarget(Number(rules[0].target_acos));
      setKeywords(searchTerms);
      setConfiguredKeywords(configured.filter(k => String(k.state || k.status).toLowerCase() !== 'archived'));
      setNegatives(suggestions);
      setCampaigns(loadedCampaigns.filter((campaign) => !campaignIsArchived(campaign)));
    } catch (error) {
      setActionMsg({ type: 'error', text: `Falha ao carregar Keywords: ${error?.message || 'erro desconhecido'}` });
    } finally {
      setLoading(false);
    }
  }, [campaignScope]);

  useEffect(() => { load(); }, [load]);

  const campaignById = useMemo(() => new Map(campaigns.flatMap(campaign => [campaign.id, campaign.campaign_id, campaign.amazon_campaign_id].filter(Boolean).map(id => [String(id), campaign]))), [campaigns]);
  const activeCampaignIds = useMemo(() => new Set(campaignById.keys()), [campaignById]);

  const visibleKeywords = useMemo(() => keywords
    .filter((term) => {
      const campaignId = idOfTermCampaign(term);
      return (!campaignScope || campaignId === campaignScope || (campaignById.get(campaignId) && campaignById.get(campaignId) === campaignById.get(campaignScope))) && (!campaignId || activeCampaignIds.has(campaignId));
    })
    .map((term) => {
      const metrics = metricsOf(term);
      return { ...term, ...metrics, _displayTerm: termText(term), _class: classifyTerm(term, acosTarget) };
    }), [keywords, activeCampaignIds, acosTarget, campaignScope, campaignById]);

  const visibleNegatives = useMemo(() => negatives.filter((item) => {
    const campaignId = String(item?.campaign_id || '').trim();
    return (!campaignScope || campaignId === campaignScope || (campaignById.get(campaignId) && campaignById.get(campaignId) === campaignById.get(campaignScope))) && (!campaignId || activeCampaignIds.has(campaignId));
  }), [negatives, activeCampaignIds, campaignScope, campaignById]);

  const eligibleAutoNegatives = useMemo(() => {
    const existing = new Set(visibleNegatives.filter((item) => item.status !== 'rejected').map(suggestionKey));
    return visibleKeywords.filter((term) => {
      const campaignId = idOfTermCampaign(term);
      const campaign = campaignById.get(campaignId);
      if (!campaignId || !campaign || !campaignIsAutomatic(campaign, term)) return false;
      if (term._class !== 'negate_candidate' || term.orders !== 0 || term.sales !== 0 || term.clicks == null || term.spend == null || !term._displayTerm) return false;
      return !existing.has(`${campaignId}::${term._displayTerm.toLocaleLowerCase('pt-BR')}::exact`);
    });
  }, [visibleKeywords, visibleNegatives, campaignById]);

  const executeNegativeSuggestion = useCallback(async (suggestion) => {
    if (!account || suggestion.amazon_account_id !== account.id) throw new Error('Conta da sugestão difere da conta selecionada.');
    if (!suggestion.campaign_id || !suggestion.ad_group_id) throw new Error('Campanha ou grupo de anúncios ausente; item bloqueado para revisão manual.');
    if (!suggestion.keyword_text?.trim()) throw new Error('Termo ausente; item bloqueado.');
    if (suggestion.orders == null || suggestion.sales == null) throw new Error('Pedidos ou vendas ausentes; não é possível validar elegibilidade para negativação.');
    if (Number(suggestion.orders) > 0 || Number(suggestion.sales) > 0) throw new Error('Item bloqueado: há pedido ou venda atribuída na janela registrada.');
    if (!['pending', 'approved', 'failed'].includes(String(suggestion.status || 'pending'))) {
      throw new Error(`Status ${suggestion.status} não permite executar esta sugestão.`);
    }

    const created = await base44.entities.AgentAction.create({
      amazon_account_id: account.id,
      action: 'negative_keyword',
      campaign_id: String(suggestion.campaign_id),
      ad_group_id: String(suggestion.ad_group_id),
      keyword: suggestion.keyword_text.trim(),
      reason: suggestion.reason || 'Negativação exata revisada pelo usuário.',
      evidence: JSON.stringify({ clicks: suggestion.clicks, spend: suggestion.spend, sales: suggestion.sales, orders: suggestion.orders, suggestion_id: suggestion.id }),
      risk_level: 'medium',
      requires_approval: false,
      status: 'pending',
      source: 'KeywordManagement',
    });
    const actionId = created?.id || created?.data?.id;
    if (!actionId) throw new Error('A ação foi registrada sem identificador; nenhuma execução foi solicitada.');

    await base44.entities.NegativeKeywordSuggestion.update(suggestion.id, {
      execution_status: 'sending',
      execution_error: null,
      agent_action_id: actionId,
    });
    try {
      const response = await base44.functions.invoke('executeAgentAction', { action_id: actionId, approve: true });
      const result = response?.data || response || {};
      if (result.ok !== true || result.status !== 'executed') {
        throw new Error(result.error || result.message || 'A API não confirmou a execução.');
      }
      await base44.entities.NegativeKeywordSuggestion.update(suggestion.id, {
        status: 'sent',
        execution_status: 'sent',
        execution_error: null,
        amazon_request_id: result.request_id || null,
      });
      return { ok: true, status: 'sent', suggestion_id: suggestion.id, action_id: actionId, request_id: result.request_id || null };
    } catch (error) {
      await base44.entities.AgentAction.update(actionId, {
        status: 'failed',
        error_message: String(error?.message || error).slice(0, 500),
      }).catch(() => {});
      await base44.entities.NegativeKeywordSuggestion.update(suggestion.id, {
        execution_status: 'failed',
        execution_error: String(error?.message || error).slice(0, 500),
      }).catch(() => {});
      throw error;
    }
  }, [account]);

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
          orders: term.orders,
          acos: term.acos,
          reason: `Regra validada do motor: ${term.clicks ?? '—'} cliques, gasto ${term.spend == null ? '—' : `R$ ${term.spend.toFixed(2)}`} e zero pedidos na janela do registro; negativa exata em campanha automática.`,
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
        text: `Negativação automática: ${applied} solicitações enviadas (aguardando confirmação), ${conflicts} já existentes, ${failed} falhas. Apenas campanhas automáticas ativas e termos sem pedidos foram processados.`,
      });
    }
    await load();
  }, [account, autoNegating, eligibleAutoNegatives, executeNegativeSuggestion, load]);



  const approveNegative = async (item) => {
    if (!window.confirm(`Enviar negativa EXATA para “${item.keyword_text}” na campanha selecionada? A Amazon ainda precisará confirmar o estado.`)) return;
    setActionLoading(item.id);
    try {
      await executeNegativeSuggestion(item);
      setActionMsg({ type: 'info', text: `Solicitação de negativa exata enviada para “${item.keyword_text}”. A resposta ainda não confirma o estado final na Amazon.` });
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
    const selected = visibleNegatives.filter((item) => selectedNegatives.has(item.id));
    if (!selected.length || bulkApplying) return;
    if (!window.confirm(`Enviar ${selected.length} negativa(s) EXATA(s) à Amazon? Os resultados serão mostrados por item; envio não significa confirmação final.`)) return;
    setBulkApplying(true);
    const results = [];
    for (const item of selected) {
      try {
        const result = await executeNegativeSuggestion(item);
        results.push({ id: item.id, term: item.keyword_text, campaign: item.campaign_name || item.campaign_id, status: 'sent', request_id: result.request_id });
        await sleep(350);
      } catch (error) {
        results.push({ id: item.id, term: item.keyword_text, campaign: item.campaign_name || item.campaign_id, status: 'failed_or_blocked', error: error?.message || String(error) });
      }
    }
    setBulkResults(results);
    setSelectedNegatives(new Set(results.filter((item) => item.status === 'failed_or_blocked').map((item) => item.id)));
    setBulkApplying(false);
    const succeeded = results.filter((item) => item.status === 'sent').length;
    const failures = results.length - succeeded;
    setActionMsg({ type: failures ? 'info' : 'success', text: `Lote: ${succeeded} solicitações enviadas (aguardando confirmação), ${failures} falhas ou bloqueios. Cada item mantém seu próprio status; falhas permanecem para revisão.` });
    await load();
  };

  const fetchFromApi = async () => {
    if (!account) return;
    setFetchingApi(true);
    try {
      const response = await base44.functions.invoke('fetchSearchTermsFromApi', { amazon_account_id: account.id, days: 30, manual: true });
      const data = response.data;
      setActionMsg({ type: data?.ok ? 'success' : 'info', text: data?.ok ? (data.message || `${data.imported || 0} novos termos e ${data.updated || 0} atualizados.`) : (data?.error || data?.message || 'Relatório solicitado à Amazon.') });
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
    { id: 'sales', header: 'Vendas', sortValue: (row) => row.sales, cell: (row) => <span className="text-emerald-400">{row.sales == null ? '—' : row.sales.toLocaleString('pt-BR', { style: 'currency', currency: account?.currency_code || 'BRL' })}</span> },
    { id: 'acos', header: 'ACoS', sortValue: (row) => row.acos, cell: (row) => row.acos > 0 ? `${row.acos.toFixed(1)}%` : '—' },
    { id: 'action', header: 'Ação', sortValue: (row) => row._class, cell: (row) => row._class === 'negate_candidate' ? <span className="text-xs text-red-400">Automática exata</span> : '—' },
  ], []);

  const negativeColumns = useMemo(() => [
    { id: 'select', header: 'Sel.', sortValue: (row) => selectedNegatives.has(row.id) ? 1 : 0, cell: (row) => row.status === 'pending' ? <input type="checkbox" checked={selectedNegatives.has(row.id)} onChange={() => setSelectedNegatives((current) => { const next = new Set(current); next.has(row.id) ? next.delete(row.id) : next.add(row.id); return next; })} /> : null },
    { id: 'term', header: 'Termo', sortValue: (row) => row.keyword_text, cell: (row) => <span className="font-medium text-white">{row.keyword_text}</span> },
    { id: 'status', header: 'Status', sortValue: (row) => row.status, cell: (row) => <span className={row.status === 'approved' ? 'text-emerald-400' : row.status === 'rejected' ? 'text-red-400' : 'text-amber-400'}>{row.execution_status === 'sent' ? 'enviada · confirmar' : row.execution_status === 'confirmed' ? 'confirmada' : row.execution_status === 'failed' ? 'falhou · revisar' : row.status || 'pending'}</span> },
    { id: 'campaign', header: 'Campanha', sortValue: (row) => row.campaign_name, cell: (row) => row.campaign_name || '—' },
    { id: 'clicks', header: 'Cliques', sortValue: (row) => Number(row.clicks || 0), cell: (row) => Number(row.clicks || 0).toLocaleString('pt-BR') },
    { id: 'spend', header: 'Gasto', sortValue: (row) => Number(row.spend || 0), cell: (row) => Number(row.spend || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) },
    { id: 'acos', header: 'ACoS', sortValue: (row) => Number(row.acos || 0), cell: (row) => Number(row.acos || 0) > 0 ? `${Number(row.acos).toFixed(1)}%` : '—' },
    { id: 'actions', header: 'Ações', sortValue: (row) => row.status, cell: (row) => row.status === 'pending' ? <div className="flex gap-2"><Button size="sm" variant="outline" disabled={actionLoading === row.id} onClick={() => approveNegative(row)}><Check className="h-3 w-3" /> Aprovar</Button><Button size="sm" variant="outline" disabled={actionLoading === row.id} onClick={() => rejectNegative(row)}><X className="h-3 w-3" /> Rejeitar</Button></div> : '—' },
  ], [selectedNegatives, actionLoading]);

  const selectedNegativeItems = visibleNegatives.filter((item) => selectedNegatives.has(item.id));
  const selectedBlocked = selectedNegativeItems.filter((item) => {
    const campaign = campaignById.get(String(item.campaign_id || ''));
    return item.status !== 'pending' || item.amazon_account_id !== account?.id || !item.campaign_id || !item.ad_group_id || !item.keyword_text?.trim()
      || item.orders == null || item.sales == null || Number(item.orders || 0) > 0 || Number(item.sales || 0) > 0
      || !campaign || campaignIsArchived(campaign);
  });
  const canSelectAllPending = visibleNegatives.filter((item) => item.status === 'pending').map((item) => item.id);
  const toggleAllVisiblePending = () => setSelectedNegatives((current) => {
    const allSelected = canSelectAllPending.length > 0 && canSelectAllPending.every((id) => current.has(id));
    if (allSelected) return new Set([...current].filter((id) => !canSelectAllPending.includes(id)));
    return new Set([...current, ...canSelectAllPending]);
  });
  useEffect(() => {
    const pendingIds = new Set(visibleNegatives.filter((item) => item.status === 'pending').map((item) => item.id));
    setSelectedNegatives((current) => new Set([...current].filter((id) => pendingIds.has(id))));
  }, [visibleNegatives]);

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

      {campaignScope && <div className="rounded-xl border border-blue-500/30 p-3 text-sm text-slate-200">
        Campanha: {campaignById.get(campaignScope)?.name || campaignById.get(campaignScope)?.campaign_name || campaignScope}
        <a className="ml-3 text-blue-400 underline" href={`/keyword-management?account_id=${encodeURIComponent(account?.id || '')}`}>Ver todas as campanhas</a>
        {!loading && visibleKeywords.length === 0 && <p className="mt-2">Nenhum termo de pesquisa importado para esta campanha. Isso não significa ausência de palavras-chave configuradas. Consulte a aba abaixo ou use Buscar Amazon para atualizar o relatório.</p>}
      </div>}

      {actionMsg && <div className={`rounded-xl border px-4 py-3 text-sm ${actionMsg.type === 'error' ? 'border-red-500/30 bg-red-500/10 text-red-300' : actionMsg.type === 'success' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-blue-500/30 bg-blue-500/10 text-blue-300'}`}>{actionMsg.text}</div>}

      <div className="flex gap-2 border-b border-[#24324F]">
        <button className={`px-4 py-2 text-sm font-semibold ${activeTab === 'search' ? 'border-b-2 border-[#5B8CFF] text-white' : 'text-slate-400'}`} onClick={() => setActiveTab('search')}>Termos de pesquisa</button>
        {campaignScope && <button className="px-4 py-2 text-sm font-semibold text-slate-300" onClick={() => setActiveTab('configured')}>Palavras-chave configuradas ({configuredKeywords.length})</button>}
        <button className={`px-4 py-2 text-sm font-semibold ${activeTab === 'negatives' ? 'border-b-2 border-[#FF5D5D] text-white' : 'text-slate-400'}`} onClick={() => setActiveTab('negatives')}>Palavras negativas ({pendingNegatives})</button>
      </div>

      {loading ? <div className="flex justify-center py-20"><Loader2 className="h-7 w-7 animate-spin text-[#5B8CFF]" /></div> : activeTab === 'configured' ? (
        <PremiumDataTable data={configuredKeywords} searchable columns={[
          { id: 'keyword', header: 'Palavra-chave', sortValue: row => termText(row), cell: row => termText(row) },
          { id: 'match_type', header: 'Correspondência', accessor: 'match_type', cell: row => row.match_type || '—' },
          { id: 'state', header: 'Estado', accessor: 'state', cell: row => row.state || row.status || '—' },
          { id: 'bid', header: 'Lance', sortValue: row => Number(row.current_bid ?? row.bid ?? 0), cell: row => Number(row.current_bid ?? row.bid ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) },
        ]} emptyMessage="Nenhuma palavra-chave manual sincronizada. Campanhas automáticas utilizam segmentações automáticas." />
      ) : activeTab === 'search' ? (
        <PremiumDataTable columns={keywordColumns} data={visibleKeywords} searchable searchPlaceholder="Pesquisar termo ou campanha..." initialSort={{ id: 'clicks', direction: 'desc' }} emptyMessage="Nenhum termo de campanha atual encontrado." />
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#24324F] bg-[#0B1224] p-3">
            <div className="text-xs text-slate-300">
              <div>{selectedNegatives.size} selecionadas · {selectedBlocked.length} bloqueadas · {Math.max(0, selectedNegatives.size - selectedBlocked.length)} elegíveis</div>
              <div className="text-slate-500">A seleção abrange todos os resultados pendentes deste escopo, inclusive outras páginas da tabela.</div>
              <div className="text-slate-500">Proposta: status pendente → negativa exata na campanha/grupo selecionados. Só se executa após este comando e validação por item.</div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={toggleAllVisiblePending} disabled={canSelectAllPending.length === 0}>
                {canSelectAllPending.length > 0 && canSelectAllPending.every((id) => selectedNegatives.has(id)) ? 'Desmarcar pendentes' : `Selecionar pendentes (${canSelectAllPending.length})`}
              </Button>
              <Button size="sm" onClick={bulkApproveNegatives} disabled={bulkApplying || selectedNegatives.size === 0 || selectedBlocked.length > 0}>
                {bulkApplying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Aplicar lote
              </Button>
            </div>
            {selectedNegativeItems.length > 0 && <div className="w-full overflow-x-auto">
              <table className="w-full text-xs"><thead><tr><th className="p-2 text-left">Termo / campanha</th><th className="p-2 text-right">Cliques</th><th className="p-2 text-right">Gasto</th><th className="p-2 text-right">Pedidos / vendas</th><th className="p-2 text-left">Antes → proposta</th><th className="p-2 text-left">Elegibilidade</th></tr></thead>
                <tbody>{selectedNegativeItems.map((item) => {
                  const blocked = selectedBlocked.some((row) => row.id === item.id);
                  const campaign = campaignById.get(String(item.campaign_id || ''));
                  const reason = item.status !== 'pending' ? `Status ${item.status}` : item.amazon_account_id !== account?.id ? 'Conta divergente' : !campaign ? 'Campanha ausente/arquivada' : !item.ad_group_id ? 'Ad group ausente' : (item.orders == null || item.sales == null) ? 'Métricas incompletas' : (Number(item.orders) > 0 || Number(item.sales) > 0) ? 'Há conversão atribuída' : 'Elegível após validação da API';
                  return <tr key={item.id} className="border-t border-[#24324F]">
                    <td className="p-2">{item.keyword_text}<div className="text-slate-500">{campaign?.name || campaign?.campaign_name || item.campaign_name || item.campaign_id}</div></td>
                    <td className="p-2 text-right">{item.clicks == null ? '—' : Number(item.clicks).toLocaleString('pt-BR')}</td>
                    <td className="p-2 text-right">{item.spend == null ? '—' : Number(item.spend).toLocaleString('pt-BR', { style: 'currency', currency: account?.currency_code || 'BRL' })}</td>
                    <td className="p-2 text-right">{item.orders ?? '—'} / {item.sales == null ? '—' : Number(item.sales).toLocaleString('pt-BR', { style: 'currency', currency: account?.currency_code || 'BRL' })}</td>
                    <td className="p-2">Pendente → negativa EXATA</td>
                    <td className={blocked ? 'p-2 text-red-300' : 'p-2 text-emerald-300'}>{reason}</td>
                  </tr>;
                })}</tbody>
              </table>
            </div>}
            {bulkResults && <div className="w-full space-y-1 rounded-lg border border-[#24324F] p-2">
              <div className="font-semibold text-slate-200">Resultado individual do último lote</div>
              {bulkResults.map((item) => <div key={item.id} className={item.status === 'sent' ? 'text-amber-300' : 'text-red-300'}>
                {item.term || item.id}: {item.status === 'sent' ? `enviada, aguardando confirmação (request ${item.request_id || 'sem ID'})` : `falha/bloqueio — ${item.error}`}
              </div>)}
            </div>}
          </div>
          <PremiumDataTable columns={negativeColumns} data={visibleNegatives} searchable searchPlaceholder="Pesquisar negativa ou campanha..." initialSort={{ id: 'status', direction: 'asc' }} emptyMessage="Nenhuma negativa de campanha atual encontrada." />
        </div>
      )}
    </div>
  );
}
