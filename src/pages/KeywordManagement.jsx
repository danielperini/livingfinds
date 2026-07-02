import { useState, useEffect, useCallback, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Search, RefreshCw, Loader2, X,
  Brain, Upload, Check, Square, Download, Zap
} from 'lucide-react';
import { Button } from '@/components/ui/button';

const CLASSIFICATION_CONFIG = {
  winner: { label: 'Vencedor', color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
  emerging: { label: 'Emergente', color: 'text-cyan bg-cyan/10 border-cyan/20' },
  promising: { label: 'Promissor', color: 'text-blue-400 bg-blue-400/10 border-blue-400/20' },
  exploratory: { label: 'Exploratório', color: 'text-slate-400 bg-slate-400/10 border-slate-400/20' },
  inefficient: { label: 'Ineficiente', color: 'text-amber-400 bg-amber-400/10 border-amber-400/20' },
  negate_candidate: { label: 'Negativar', color: 'text-red-400 bg-red-400/10 border-red-400/20' },
  no_data: { label: 'Sem Dados', color: 'text-slate-500 bg-slate-500/10 border-slate-500/20' },
};

function classifyTerm(kw, acosTarget = 30) {
  const clicks = kw.clicks || 0;
  const orders = kw.orders || 0;
  const spend = kw.spend || 0;
  const sales = kw.sales || 0;
  const acos = kw.acos || 0;

  if (clicks < 5) return 'no_data';
  if (orders >= 2 && acos > 0 && acos <= acosTarget) return 'winner';
  if (clicks >= 10 && spend > 2 && orders === 0) return 'negate_candidate';
  if (clicks >= 5 && orders === 0) return 'inefficient';
  if (acos > acosTarget * 1.5) return 'inefficient';
  return 'promising';
}

export default function KeywordManagement() {
  const [account, setAccount] = useState(null);
  const [keywords, setKeywords] = useState([]);
  const [negatives, setNegatives] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState('search'); // 'search' | 'negatives'
  const [actionMsg, setActionMsg] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);
  const [selectedNegatives, setSelectedNegatives] = useState(new Set());
  const [bulkApplying, setBulkApplying] = useState(false);
  const [importing, setImporting] = useState(false);
  const [fetchingApi, setFetchingApi] = useState(false);
  const [harvesting, setHarvesting] = useState(false);
  const [acosTarget, setAcosTarget] = useState(30);
  const fileInputRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accounts[0] || (await base44.entities.AmazonAccount.list())[0];
      setAccount(acc);
      if (!acc) return;

      const rules = await base44.entities.BudgetRule.filter({ amazon_account_id: acc.id });
      if (rules[0]?.target_acos) setAcosTarget(rules[0].target_acos);

      const [searchTerms, negs] = await Promise.all([
        base44.entities.SearchTerm.filter({ amazon_account_id: acc.id }, '-clicks', 2000),
        base44.entities.NegativeKeywordSuggestion.filter({ amazon_account_id: acc.id }, '-created_date', 500),
      ]);
      setKeywords(searchTerms);
      setNegatives(negs);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const negateKeyword = async (kw) => {
    setActionLoading(kw.id);
    try {
      await base44.entities.NegativeKeywordSuggestion.create({
        amazon_account_id: account.id,
        campaign_id: kw.campaign_id,
        ad_group_id: kw.ad_group_id,
        keyword_text: kw.keyword_text || kw.keyword,
        match_type: 'exact',
        clicks: kw.clicks,
        spend: kw.spend,
        sales: kw.sales,
        acos: kw.acos,
        reason: `${kw.clicks} cliques, $${(kw.spend || 0).toFixed(2)} gasto, ${kw.orders || 0} pedidos`,
        status: 'pending',
      });
      setActionMsg({ type: 'success', text: `✓ Sugestão criada para "${kw.keyword_text}"` });
      await load();
    } catch (e) {
      setActionMsg({ type: 'error', text: e.message });
    } finally {
      setActionLoading(null);
      setTimeout(() => setActionMsg(null), 8000);
    }
  };

  const approveNegative = async (s) => {
    setActionLoading(s.id);
    try {
      await base44.entities.NegativeKeywordSuggestion.update(s.id, { status: 'approved' });
      await base44.functions.invoke('executeAgentAction', { action_id: s.id, approve: true });
      setActionMsg({ type: 'success', text: `✓ "${s.keyword_text}" negativada` });
      await load();
    } catch (e) {
      setActionMsg({ type: 'error', text: e.message });
    } finally {
      setActionLoading(null);
      setTimeout(() => setActionMsg(null), 8000);
    }
  };

  const rejectNegative = async (s) => {
    setActionLoading(s.id);
    try {
      await base44.entities.NegativeKeywordSuggestion.update(s.id, { status: 'rejected' });
      setActionMsg({ type: 'info', text: `✕ "${s.keyword_text}" rejeitada` });
      await load();
    } catch (e) {
      setActionMsg({ type: 'error', text: e.message });
    } finally {
      setActionLoading(null);
      setTimeout(() => setActionMsg(null), 8000);
    }
  };

  const bulkApproveNegatives = async () => {
    if (selectedNegatives.size === 0) return;
    setBulkApplying(true);
    let success = 0;
    for (const id of selectedNegatives) {
      try {
        await base44.entities.NegativeKeywordSuggestion.update(id, { status: 'approved' });
        await base44.functions.invoke('executeAgentAction', { action_id: id, approve: true });
        success++;
      } catch {}
    }
    setBulkApplying(false);
    setSelectedNegatives(new Set());
    setActionMsg({ type: 'success', text: `✓ ${success} termos negativados` });
    await load();
    setTimeout(() => setActionMsg(null), 10000);
  };

  const fetchFromApi = async () => {
    if (!account || fetchingApi) return;
    setFetchingApi(true);
    try {
      const res = await base44.functions.invoke('fetchSearchTermsFromApi', {
        amazon_account_id: account.id,
        days: 30,
        manual: true,
      });
      const d = res.data;
      if (d?.skipped) {
        setActionMsg({ type: 'info', text: '✓ Busca já realizada hoje. Use reimportação para forçar.' });
      } else if (d?.pending) {
        setActionMsg({ type: 'info', text: `⏳ Relatório em processamento (ID: ${d.report_id}). Tente novamente em 1–2 min.` });
      } else if (d?.ok) {
        setActionMsg({ type: 'success', text: `✓ ${d.imported} novos termos · ${d.updated} atualizados · Período: ${d.period}` });
        await load();
      } else {
        setActionMsg({ type: 'error', text: d?.error || d?.message || 'Falha ao buscar termos' });
      }
    } catch (e) {
      setActionMsg({ type: 'error', text: e.message });
    } finally {
      setFetchingApi(false);
      setTimeout(() => setActionMsg(null), 15000);
    }
  };

  const runHarvest = async () => {
    if (!account || harvesting) return;
    setHarvesting(true);
    try {
      const res = await base44.functions.invoke('harvestConvertedSearchTerms', { amazon_account_id: account.id });
      const d = res.data;
      if (d?.ok) {
        setActionMsg({ type: 'success', text: `🌾 ${d.harvested} termos colhidos para campanha manual · Safe cutoff: ${d.safe_cutoff}` });
        await load();
      } else {
        setActionMsg({ type: 'error', text: d?.error || 'Falha na colheita' });
      }
    } catch (e) {
      setActionMsg({ type: 'error', text: e.message });
    } finally {
      setHarvesting(false);
      setTimeout(() => setActionMsg(null), 12000);
    }
  };

  const handleImportFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !account) return;
    setImporting(true);
    try {
      const uploadRes = await base44.integrations.Core.UploadFile({ file });
      const importRes = await base44.functions.invoke('importSearchTermReport', {
        file_url: uploadRes.file_url,
        amazon_account_id: account.id,
      });
      if (importRes.data?.ok) {
        setActionMsg({ type: 'success', text: `✓ ${importRes.data.imported} termos importados` });
        await load();
      }
    } catch (err) {
      setActionMsg({ type: 'error', text: err.message });
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
      setTimeout(() => setActionMsg(null), 10000);
    }
  };

  const classifiedKeywords = keywords.map(kw => ({
    ...kw,
    // SearchTerm usa search_term, Keyword usa keyword_text
    _displayTerm: kw.search_term || kw.keyword_text || kw.keyword || '',
    // Normalizar campos de métricas: SearchTerm usa orders_14d, Keyword usa orders
    _orders: kw.orders_14d ?? kw.orders ?? 0,
    _sales: kw.sales_14d ?? kw.sales ?? 0,
    _acos: kw.acos_14d ?? kw.acos ?? 0,
    _class: classifyTerm({
      clicks: kw.clicks,
      orders: kw.orders_14d ?? kw.orders ?? 0,
      spend: kw.spend,
      sales: kw.sales_14d ?? kw.sales ?? 0,
      acos: kw.acos_14d ?? kw.acos ?? 0,
    }, acosTarget),
  })).filter(kw => {
    const matchSearch = !search || kw._displayTerm.toLowerCase().includes(search.toLowerCase());
    return matchSearch;
  });

  const filteredNegatives = negatives.filter(s => {
    const matchSearch = !search || (s.keyword_text || '').toLowerCase().includes(search.toLowerCase());
    return matchSearch;
  });

  const pendingNegatives = negatives.filter(s => s.status === 'pending').length;
  const approvedNegatives = negatives.filter(s => s.status === 'approved').length;

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
            <Search className="w-5 h-5 text-cyan" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Gestão de Palavras-chave</h1>
            <p className="text-xs text-slate-400">
              {keywords.length} search terms · {pendingNegatives} negativas pendentes
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={fetchFromApi}
            disabled={fetchingApi || !account}
            className="flex items-center gap-2 px-3 py-2 bg-cyan/10 border border-cyan/20 text-cyan hover:bg-cyan/20 text-xs font-semibold rounded-lg transition-colors disabled:opacity-50"
          >
            <Download className={`w-4 h-4 ${fetchingApi ? 'animate-spin' : ''}`} />
            {fetchingApi ? 'Buscando...' : 'Buscar Termos via API'}
          </button>
          <button
            onClick={runHarvest}
            disabled={harvesting || !account}
            className="flex items-center gap-2 px-3 py-2 bg-emerald-400/10 border border-emerald-400/20 text-emerald-400 hover:bg-emerald-400/20 text-xs font-semibold rounded-lg transition-colors disabled:opacity-50"
          >
            <Zap className={`w-4 h-4 ${harvesting ? 'animate-spin' : ''}`} />
            {harvesting ? 'Analisando...' : 'Analisar → Campanha Manual'}
          </button>
          <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleImportFile} className="hidden" />
          <Button onClick={() => fileInputRef.current?.click()} disabled={importing} variant="outline" size="sm">
            <Upload className={`w-4 h-4 ${importing ? 'animate-spin' : ''}`} />
            {importing ? 'Importando...' : 'Importar CSV'}
          </Button>
          <Button onClick={load} disabled={loading} variant="outline" size="sm">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {actionMsg && (
        <div className={`px-4 py-3 rounded-xl border text-sm font-medium ${
          actionMsg.type === 'success' ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300' :
          actionMsg.type === 'error' ? 'bg-red-400/10 border-red-400/20 text-red-400' :
          'bg-cyan/10 border-cyan/20 text-cyan'
        }`}>{actionMsg.text}</div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-2 border-b border-surface-2">
        <button
          onClick={() => setActiveTab('search')}
          className={`px-4 py-2 text-sm font-semibold border-b-2 transition-colors ${
            activeTab === 'search'
              ? 'border-cyan text-cyan'
              : 'border-transparent text-slate-500 hover:text-slate-300'
          }`}
        >
          Search Terms
        </button>
        <button
          onClick={() => setActiveTab('negatives')}
          className={`px-4 py-2 text-sm font-semibold border-b-2 transition-colors ${
            activeTab === 'negatives'
              ? 'border-red-500 text-red-400'
              : 'border-transparent text-slate-500 hover:text-slate-300'
          }`}
        >
          Palavras Negativas {pendingNegatives > 0 && `(${pendingNegatives})`}
        </button>
      </div>

      {/* Search Bar */}
      <div className="relative sm:w-64">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Pesquisar..."
          className="w-full pl-10 pr-4 py-2.5 bg-surface-1 border border-surface-2 rounded-lg text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan/50"
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-7 h-7 text-cyan animate-spin" /></div>
      ) : (
        <>
          {/* Search Terms Tab */}
          {activeTab === 'search' && (
            <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-surface-2 bg-surface-2/40">
                      {['Termo', 'Classe', 'Cliques', 'Spend', 'Vendas', 'ACoS', 'Ação'].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {classifiedKeywords.length === 0 ? (
                      <tr><td colSpan={7} className="px-4 py-12 text-center text-sm text-slate-500">
                        Nenhum search term encontrado. Use "Buscar Termos via API" para importar dados da Amazon.
                      </td></tr>
                    ) : classifiedKeywords.map(kw => {
                      const cfg = CLASSIFICATION_CONFIG[kw._class];
                      const isLoading = actionLoading === kw.id;
                      const canNegate = kw._class === 'negate_candidate' || kw._class === 'inefficient';

                      return (
                        <tr key={kw.id} className="border-b border-surface-2/40 hover:bg-surface-2/30">
                          <td className="px-4 py-2.5 max-w-[220px]">
                            <p className="text-xs text-slate-200 truncate font-medium">{kw._displayTerm}</p>
                            {kw.campaign_name && <p className="text-[10px] text-slate-500 truncate">{kw.campaign_name}</p>}
                          </td>
                          <td className="px-4 py-2.5">
                            <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${cfg.color}`}>{cfg.label}</span>
                          </td>
                          <td className="px-4 py-2.5 text-xs text-slate-400">{(kw.clicks || 0).toLocaleString()}</td>
                          <td className="px-4 py-2.5 text-xs text-slate-400">R${(kw.spend || 0).toFixed(2)}</td>
                          <td className="px-4 py-2.5 text-xs text-emerald-400">R${(kw._sales || 0).toFixed(2)}</td>
                          <td className="px-4 py-2.5">
                            <span className={`text-xs font-semibold ${(kw._acos || 0) > 50 ? 'text-red-400' : (kw._acos || 0) > 30 ? 'text-amber-400' : (kw._acos || 0) > 0 ? 'text-emerald-400' : 'text-slate-600'}`}>
                              {(kw._acos || 0) > 0 ? `${(kw._acos || 0).toFixed(1)}%` : '—'}
                            </span>
                          </td>
                          <td className="px-4 py-2.5">
                            {canNegate && (
                              <Button
                                onClick={() => negateKeyword(kw)}
                                disabled={isLoading}
                                variant="outline"
                                size="sm"
                                className="text-red-400 border-red-500/30 hover:bg-red-500/10"
                              >
                                <X className="w-3 h-3 mr-1" />
                                Negativar
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Negative Keywords Tab */}
          {activeTab === 'negatives' && (
            <>
              {selectedNegatives.size > 0 && (
                <div className="bg-surface-2 border border-surface-3 rounded-xl p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Check className="w-5 h-5 text-cyan" />
                    <p className="text-sm text-slate-300"><strong className="text-white">{selectedNegatives.size}</strong> selecionados</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button onClick={bulkApproveNegatives} disabled={bulkApplying} size="sm" className="bg-emerald-500 hover:bg-emerald-600 text-white">
                      <Check className="w-4 h-4 mr-1" />
                      Negativar ({selectedNegatives.size})
                    </Button>
                    <Button onClick={() => setSelectedNegatives(new Set())} variant="ghost" size="sm">Limpar</Button>
                  </div>
                </div>
              )}

              <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-surface-2 bg-surface-2/40">
                        <th className="px-4 py-3 w-10"></th>
                        {['Termo', 'Status', 'Campanha', 'Cliques', 'Spend', 'Vendas', 'ACoS', 'Ações'].map(h => (
                          <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredNegatives.map(s => {
                        const isSelected = selectedNegatives.has(s.id);
                        const isLoading = actionLoading === s.id;
                        const statusConfig = {
                          pending: { label: 'Pendente', color: 'text-amber-400 bg-amber-400/10 border-amber-400/20' },
                          approved: { label: 'Aprovado', color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
                          rejected: { label: 'Rejeitado', color: 'text-red-400 bg-red-400/10 border-red-400/20' },
                        }[s.status || 'pending'];

                        return (
                          <tr key={s.id} className={`border-b border-surface-2/40 hover:bg-surface-2/30 ${isSelected ? 'bg-cyan/5' : ''}`}>
                            <td className="px-4 py-3">
                              {s.status === 'pending' && (
                                <button
                                  onClick={() => setSelectedNegatives(prev => {
                                    const next = new Set(prev);
                                    if (next.has(s.id)) next.delete(s.id);
                                    else next.add(s.id);
                                    return next;
                                  })}
                                  className={`flex items-center justify-center w-5 h-5 rounded ${isSelected ? 'bg-cyan text-white' : 'bg-surface-3 hover:bg-surface-2'}`}
                                >
                                  {isSelected ? <Check className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5 text-slate-500" />}
                                </button>
                              )}
                            </td>
                            <td className="px-4 py-3 max-w-[200px]">
                              <p className="text-xs text-slate-200 truncate font-medium">{s.keyword_text}</p>
                            </td>
                            <td className="px-4 py-3">
                              <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${statusConfig.color}`}>{statusConfig.label}</span>
                            </td>
                            <td className="px-4 py-3">
                              <p className="text-xs text-slate-400 truncate max-w-[150px]">{s.campaign_name || '—'}</p>
                            </td>
                            <td className="px-4 py-3 text-xs text-slate-400">{(s.clicks || 0).toLocaleString()}</td>
                            <td className="px-4 py-3 text-xs text-slate-400">${(s.spend || 0).toFixed(2)}</td>
                            <td className="px-4 py-3 text-xs text-emerald-400">${(s.sales || 0).toFixed(2)}</td>
                            <td className="px-4 py-3">
                              <span className={`text-xs font-semibold ${(s.acos || 0) > 50 ? 'text-red-400' : (s.acos || 0) > 30 ? 'text-amber-400' : (s.acos || 0) > 0 ? 'text-emerald-400' : 'text-slate-600'}`}>
                                {(s.acos || 0) > 0 ? `${(s.acos || 0).toFixed(1)}%` : '—'}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              {s.status === 'pending' ? (
                                <div className="flex items-center gap-1.5">
                                  <Button onClick={() => approveNegative(s)} disabled={isLoading} variant="outline" size="sm" className="text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/10">
                                    {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                                    Aprovar
                                  </Button>
                                  <Button onClick={() => rejectNegative(s)} disabled={isLoading} variant="outline" size="sm" className="text-red-400 border-red-500/30 hover:bg-red-500/10">
                                    {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                                    Rejeitar
                                  </Button>
                                </div>
                              ) : (
                                <span className={`text-xs ${statusConfig.color.split(' ')[0]}`}>{statusConfig.label}</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}