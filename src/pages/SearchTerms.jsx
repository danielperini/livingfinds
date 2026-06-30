import { useState, useEffect, useCallback, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Search, Filter, RefreshCw, Loader2, TrendingUp, TrendingDown,
  ArrowUpRight, X, CheckCircle, AlertCircle, Brain, Upload
} from 'lucide-react';

const CLASSIFICATION_CONFIG = {
  winner: { label: 'Vencedor', color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
  emerging: { label: 'Emergente', color: 'text-cyan bg-cyan/10 border-cyan/20' },
  promising: { label: 'Promissor', color: 'text-blue-400 bg-blue-400/10 border-blue-400/20' },
  exploratory: { label: 'Exploratório', color: 'text-slate-400 bg-slate-400/10 border-slate-400/20' },
  inefficient: { label: 'Ineficiente', color: 'text-amber-400 bg-amber-400/10 border-amber-400/20' },
  irrelevant: { label: 'Irrelevante', color: 'text-red-400 bg-red-400/10 border-red-400/20' },
  negate_candidate: { label: 'Negativar', color: 'text-red-400 bg-red-400/10 border-red-400/20' },
  migrate_exact: { label: 'Migrar → EXACT', color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
  no_data: { label: 'Sem Dados', color: 'text-slate-500 bg-slate-500/10 border-slate-500/20' },
};

function classifyTerm(kw, acosTarget = 30) {
  const clicks = kw.clicks || 0;
  const orders = kw.orders || 0;
  const spend = kw.spend || 0;
  const sales = kw.sales || 0;
  const acos = kw.acos || 0;
  const cvr = clicks > 0 ? (orders / clicks) * 100 : 0;

  if (clicks < 5) return 'no_data';
  if (orders >= 2 && acos > 0 && acos <= acosTarget) return 'winner';
  if (orders === 1 && acos > 0 && acos <= acosTarget) return 'migrate_exact';
  if (orders === 1 && acos > acosTarget) return 'emerging';
  if (clicks >= 10 && spend > 2 && orders === 0) return 'negate_candidate';
  if (clicks >= 5 && orders === 0 && cvr === 0) return 'inefficient';
  if (orders === 0 && clicks < 10) return 'exploratory';
  if (acos > acosTarget * 1.5) return 'inefficient';
  return 'promising';
}

function calcScore(kw, acosTarget = 30) {
  const clicks = kw.clicks || 0;
  const orders = kw.orders || 0;
  const acos = kw.acos || 0;
  const roas = kw.roas || 0;
  const ctr = kw.ctr || 0;

  let score = 0;
  score += Math.min(orders * 20, 40);
  score += Math.min(clicks / 5, 15);
  if (acos > 0 && acos <= acosTarget) score += 20;
  else if (acos > acosTarget) score -= 10;
  if (roas >= 4) score += 10;
  score += Math.min(ctr, 5);
  return Math.max(0, Math.min(100, Math.round(score)));
}

export default function SearchTerms() {
  const [account, setAccount] = useState(null);
  const [keywords, setKeywords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterClass, setFilterClass] = useState('all');
  const [sortBy, setSortBy] = useState('score');
  const [actionMsg, setActionMsg] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);
  const [acosTarget, setAcosTarget] = useState(30);
  const [importing, setImporting] = useState(false);
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

      const kws = await base44.entities.Keyword.filter({
        amazon_account_id: acc.id,
        source: 'search_term',
      }, '-spend', 1000);
      setKeywords(kws);
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
        reason: `${kw.clicks} cliques, $${(kw.spend || 0).toFixed(2)} gasto, ${kw.orders || 0} pedidos — classificado como ${classifyTerm(kw, acosTarget)}`,
        status: 'pending',
      });
      setActionMsg({ type: 'success', text: `✓ Sugestão de negativação criada para "${kw.keyword_text || kw.keyword}"` });
    } catch (e) {
      setActionMsg({ type: 'error', text: e.message });
    } finally {
      setActionLoading(null);
      setTimeout(() => setActionMsg(null), 8000);
    }
  };

  const migrateToExact = async (kw) => {
    setActionLoading(kw.id);
    try {
      await base44.entities.Decision.create({
        amazon_account_id: account.id,
        decision_type: 'add_keyword',
        entity_type: 'keyword',
        entity_id: kw.keyword_id,
        entity_name: kw.keyword_text || kw.keyword,
        rationale: `Termo com ${kw.orders || 0} pedido(s) atribuído(s). CPC médio histórico: $${(kw.cpc || 0).toFixed(2)}. ACoS: ${(kw.acos || 0).toFixed(1)}%. Candidato à migração para campanha MANUAL-EXACT.`,
        current_value: kw.cpc || 0.25,
        proposed_value: Math.min((kw.cpc || 0.25) * 1.10, 5.0),
        change_pct: 10,
        confidence: kw.orders >= 2 ? 0.85 : 0.65,
        priority: kw.orders >= 2 ? 'high' : 'medium',
        status: 'pending',
        metrics_used: JSON.stringify({ clicks: kw.clicks, spend: kw.spend, sales: kw.sales, orders: kw.orders, acos: kw.acos, cpc: kw.cpc }),
        formula: 'Bid inicial = CPC médio × 1,10',
        data_maturity: 'mature',
        expected_impact: `Criar keyword "${kw.keyword_text || kw.keyword}" em correspondência exata na campanha MANUAL-EXACT`,
      });
      setActionMsg({ type: 'success', text: `✓ Recomendação de migração criada. Acesse Recomendações para aprovar.` });
    } catch (e) {
      setActionMsg({ type: 'error', text: e.message });
    } finally {
      setActionLoading(null);
      setTimeout(() => setActionMsg(null), 8000);
    }
  };

  const enrichWithAI = async () => {
    if (!account) return;
    setActionMsg({ type: 'info', text: 'Analisando search terms com IA...' });
    try {
      const res = await base44.functions.invoke('monitorSearchTerms', { amazon_account_id: account.id });
      const d = res.data;
      setActionMsg({ type: 'success', text: `✓ ${d?.processed || 0} termos analisados · ${d?.to_negate || 0} para negativar · ${d?.to_promote || 0} para promover` });
      await load();
    } catch (e) {
      setActionMsg({ type: 'error', text: e.message });
    }
    setTimeout(() => setActionMsg(null), 10000);
  };

  const handleImportFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !account) return;
    
    setImporting(true);
    setActionMsg({ type: 'info', text: 'Importando arquivo...' });
    
    try {
      const uploadRes = await base44.integrations.Core.UploadFile({ file });
      const fileUrl = uploadRes.file_url;
      
      const importRes = await base44.functions.invoke('importSearchTermReport', {
        file_url: fileUrl,
        amazon_account_id: account.id,
      });
      
      if (importRes.data?.ok) {
        setActionMsg({ 
          type: 'success', 
          text: `✓ ${importRes.data.imported || 0} termos importados · ${importRes.data.deleted || 0} antigos removidos` 
        });
        await load();
      } else {
        setActionMsg({ type: 'error', text: importRes.data?.error || 'Falha na importação' });
      }
    } catch (err) {
      setActionMsg({ type: 'error', text: err.message });
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
      setTimeout(() => setActionMsg(null), 10000);
    }
  };

  const classified = keywords.map(kw => ({
    ...kw,
    _class: classifyTerm(kw, acosTarget),
    _score: calcScore(kw, acosTarget),
  }));

  const filtered = classified.filter(kw => {
    const matchSearch = !search || (kw.keyword_text || kw.keyword || '').toLowerCase().includes(search.toLowerCase());
    const matchClass = filterClass === 'all' || kw._class === filterClass;
    return matchSearch && matchClass;
  }).sort((a, b) => {
    if (sortBy === 'score') return b._score - a._score;
    if (sortBy === 'spend') return (b.spend || 0) - (a.spend || 0);
    if (sortBy === 'sales') return (b.sales || 0) - (a.sales || 0);
    if (sortBy === 'acos') return (a.acos || 0) - (b.acos || 0);
    if (sortBy === 'clicks') return (b.clicks || 0) - (a.clicks || 0);
    return 0;
  });

  const classCounts = classified.reduce((acc, kw) => {
    acc[kw._class] = (acc[kw._class] || 0) + 1;
    return acc;
  }, {});

  const toMigrate = classified.filter(kw => kw._class === 'migrate_exact' || kw._class === 'winner').length;
  const toNegate = classified.filter(kw => kw._class === 'negate_candidate').length;

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
            <Search className="w-5 h-5 text-cyan" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Search Terms</h1>
            <p className="text-xs text-slate-400">{keywords.length} termos · {toMigrate} para migrar · {toNegate} para negativar</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input ref={fileInputRef} type="file" accept=".xlsx,.csv" onChange={handleImportFile} className="hidden" />
          <button onClick={() => fileInputRef.current?.click()} disabled={importing || !account}
            className="flex items-center gap-2 px-3 py-2 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60">
            <Upload className={`w-4 h-4 ${importing ? 'animate-spin' : ''}`} />
            {importing ? 'Importando...' : 'Importar Excel'}
          </button>
          <button onClick={enrichWithAI} disabled={loading || !account}
            className="flex items-center gap-2 px-3 py-2 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60">
            <Brain className="w-4 h-4 text-cyan" /> Analisar com IA
          </button>
          <button onClick={load} disabled={loading} className="p-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {actionMsg && (
        <div className={`px-4 py-3 rounded-xl border text-sm font-medium ${
          actionMsg.type === 'success' ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300' :
          actionMsg.type === 'error' ? 'bg-red-400/10 border-red-400/20 text-red-400' :
          'bg-cyan/10 border-cyan/20 text-cyan'
        }`}>{actionMsg.text}</div>
      )}

      {/* KPIs rápidos por classificação */}
      <div className="grid grid-cols-3 lg:grid-cols-5 gap-2">
        {[
          { key: 'winner', count: (classCounts.winner || 0) + (classCounts.migrate_exact || 0) },
          { key: 'inefficient', count: (classCounts.inefficient || 0) },
          { key: 'negate_candidate', count: classCounts.negate_candidate || 0 },
          { key: 'exploratory', count: classCounts.exploratory || 0 },
          { key: 'no_data', count: classCounts.no_data || 0 },
        ].map(({ key, count }) => {
          const cfg = CLASSIFICATION_CONFIG[key] || CLASSIFICATION_CONFIG.no_data;
          return (
            <button key={key} onClick={() => setFilterClass(filterClass === key ? 'all' : key)}
              className={`p-3 rounded-xl border transition-all ${filterClass === key ? 'ring-1 ring-cyan/40' : ''} ${cfg.color.split(' ').filter(c => c.startsWith('bg') || c.startsWith('border')).join(' ')} bg-opacity-10`}>
              <p className={`text-lg font-bold ${cfg.color.split(' ')[0]}`}>{count}</p>
              <p className="text-xs text-slate-500 mt-0.5">{cfg.label}</p>
            </button>
          );
        })}
      </div>

      {/* Filtros */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-shrink-0 sm:w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Pesquisar termo..."
            className="w-full pl-10 pr-4 py-2.5 bg-surface-1 border border-surface-2 rounded-lg text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan/50" />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Filter className="w-3.5 h-3.5 text-slate-500" />
          {[
            { key: 'all', label: `Todos (${keywords.length})` },
            ...Object.entries(classCounts).map(([key, cnt]) => ({
              key,
              label: `${CLASSIFICATION_CONFIG[key]?.label || key} (${cnt})`,
            }))
          ].map(f => (
            <button key={f.key} onClick={() => setFilterClass(f.key)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors whitespace-nowrap ${filterClass === f.key ? 'bg-cyan/20 text-cyan border-cyan/30' : 'bg-surface-2 text-slate-500 border-surface-3 hover:text-slate-300'}`}>
              {f.label}
            </button>
          ))}
        </div>
        <select value={sortBy} onChange={e => setSortBy(e.target.value)}
          className="ml-auto text-xs bg-surface-2 border border-surface-3 text-slate-300 rounded-lg px-2 py-1.5 focus:outline-none">
          <option value="score">Ordenar: Score</option>
          <option value="spend">Ordenar: Spend</option>
          <option value="sales">Ordenar: Vendas</option>
          <option value="acos">Ordenar: ACoS</option>
          <option value="clicks">Ordenar: Cliques</option>
        </select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-7 h-7 text-cyan animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
          <Search className="w-12 h-12 text-slate-600" />
          <p className="text-sm text-slate-400">Sem search terms. Execute um Sync no Dashboard.</p>
        </div>
      ) : (
        <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-surface-2">
            <p className="text-xs text-slate-500">{filtered.length} termos · ACoS alvo: {acosTarget}%</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-2 bg-surface-2/40">
                  {['Search Term', 'Score', 'Classe', 'Cliques', 'Spend', 'Vendas', 'Pedidos', 'ACoS', 'CPC', 'CTR', 'Ação'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(kw => {
                  const cfg = CLASSIFICATION_CONFIG[kw._class] || CLASSIFICATION_CONFIG.no_data;
                  const acosColor = (kw.acos || 0) > acosTarget * 1.5 ? 'text-red-400' : (kw.acos || 0) > acosTarget ? 'text-amber-400' : (kw.acos || 0) > 0 ? 'text-emerald-400' : 'text-slate-600';
                  const isLoading = actionLoading === kw.id;
                  const canMigrate = kw._class === 'migrate_exact' || kw._class === 'winner';
                  const canNegate = kw._class === 'negate_candidate' || kw._class === 'irrelevant';

                  return (
                    <tr key={kw.id} className="border-b border-surface-2/40 hover:bg-surface-2/30 transition-colors">
                      <td className="px-4 py-2.5 max-w-[200px]">
                        <p className="text-xs text-slate-200 truncate font-medium" title={kw.keyword_text || kw.keyword}>
                          {kw.keyword_text || kw.keyword || '—'}
                        </p>
                        {kw.campaign_id && <p className="text-xs text-slate-600 font-mono mt-0.5 truncate">camp ...{kw.campaign_id.slice(-6)}</p>}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <div className="w-8 h-1.5 bg-surface-3 rounded-full overflow-hidden">
                            <div className="h-full bg-cyan rounded-full" style={{ width: `${kw._score}%` }} />
                          </div>
                          <span className="text-xs text-slate-400">{kw._score}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${cfg.color}`}>
                          {cfg.label}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-slate-400">{(kw.clicks || 0).toLocaleString()}</td>
                      <td className="px-4 py-2.5 text-xs text-slate-400">${(kw.spend || 0).toFixed(2)}</td>
                      <td className="px-4 py-2.5 text-xs text-emerald-400">${(kw.sales || 0).toFixed(2)}</td>
                      <td className="px-4 py-2.5 text-xs text-slate-300">{kw.orders || 0}</td>
                      <td className="px-4 py-2.5">
                        <span className={`text-xs font-semibold ${acosColor}`}>
                          {(kw.acos || 0) > 0 ? `${(kw.acos || 0).toFixed(1)}%` : <span className="text-slate-600">—</span>}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-slate-400">${(kw.cpc || 0).toFixed(2)}</td>
                      <td className="px-4 py-2.5 text-xs text-slate-400">{(kw.ctr || 0).toFixed(2)}%</td>
                      <td className="px-4 py-2.5 pr-5">
                        <div className="flex items-center gap-1.5">
                          {canMigrate && (
                            <button onClick={() => migrateToExact(kw)} disabled={isLoading}
                              className="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded-lg hover:bg-emerald-500/30 transition-colors disabled:opacity-50 whitespace-nowrap">
                              {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowUpRight className="w-3 h-3" />}
                              Migrar
                            </button>
                          )}
                          {canNegate && (
                            <button onClick={() => negateKeyword(kw)} disabled={isLoading}
                              className="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold bg-red-500/20 text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/30 transition-colors disabled:opacity-50 whitespace-nowrap">
                              {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                              Negativar
                            </button>
                          )}
                          {!canMigrate && !canNegate && (
                            <span className="text-xs text-slate-600">Observar</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}