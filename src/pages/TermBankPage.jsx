import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { BookOpen, Search, RefreshCw, Loader2, Bot, ExternalLink, CheckCircle, XCircle, Clock, AlertTriangle } from 'lucide-react';
import { Link } from 'react-router-dom';

const CLASS_CONFIG = {
  winner:            { label: 'Vencedor',    color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
  learning:          { label: 'Aprendendo',  color: 'text-cyan bg-cyan/10 border-cyan/20' },
  wasting:           { label: 'Desperdício', color: 'text-red-400 bg-red-400/10 border-red-400/20' },
  negative:          { label: 'Negativo',    color: 'text-slate-400 bg-slate-400/10 border-slate-400/20' },
  new:               { label: 'Novo',        color: 'text-amber-400 bg-amber-400/10 border-amber-400/20' },
  insufficient_data: { label: 'Poucos dados',color: 'text-slate-500 bg-slate-500/10 border-slate-500/20' },
};

const SOURCE_LABELS = {
  search_term_auto: 'AUTO',
  manual_kickoff:   'Kick-off',
  user_input:       'Manual',
  cross_asin:       'Cross-ASIN',
  ai_suggestion:    'IA',
  csv_import:       'CSV',
};

const SUGGESTION_STATUS = {
  suggested:  { label: 'Sugerido',   icon: Clock,         color: 'text-amber-400 bg-amber-400/10 border-amber-400/20' },
  approved:   { label: 'Aprovado',   icon: CheckCircle,   color: 'text-cyan bg-cyan/10 border-cyan/20' },
  rejected:   { label: 'Rejeitado',  icon: XCircle,       color: 'text-slate-400 bg-slate-400/10 border-slate-400/20' },
  creating:   { label: 'Criando…',   icon: Loader2,       color: 'text-violet-400 bg-violet-400/10 border-violet-400/20' },
  created:    { label: 'Campanha OK',icon: CheckCircle,   color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
  failed:     { label: 'Falhou',     icon: AlertTriangle, color: 'text-red-400 bg-red-400/10 border-red-400/20' },
  duplicate:  { label: 'Duplicado',  icon: XCircle,       color: 'text-slate-500 bg-slate-500/10 border-slate-500/20' },
  blocked:    { label: 'Bloqueado',  icon: XCircle,       color: 'text-red-400/70 bg-red-400/5 border-red-400/15' },
};

const SOURCE_SUGGESTION_LABELS = {
  OPENAI_TITLE_ANALYSIS:       'Análise de título',
  AUTOMATIC_SEARCH_TERM:       'Search term AUTO',
  MANUAL_SEARCH_TERM:          'Search term Manual',
  CONVERTED_TERM_EXPANSION:    'Expansão convertida',
  USER:                        'Usuário',
};

function fmt(v, d = 2) {
  if (!v || !isFinite(v)) return '—';
  return v.toFixed(d).replace('.', ',');
}

export default function TermBankPage() {
  const [account, setAccount]   = useState(null);
  const [terms, setTerms]       = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [tab, setTab]           = useState('termbank');
  const [search, setSearch]     = useState('');
  const [filterClass, setFilterClass] = useState('all');
  const [filterAsin, setFilterAsin]   = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [sortBy, setSortBy]     = useState('performance_score');
  const [error, setError]       = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accounts[0] || (await base44.entities.AmazonAccount.list())[0];
      setAccount(acc);
      if (!acc) return;

      const [data, suggs, camps] = await Promise.all([
        base44.entities.TermBank.filter({ amazon_account_id: acc.id }, '-performance_score', 500),
        base44.entities.KeywordSuggestion.filter({ amazon_account_id: acc.id }, '-created_at', 500),
        base44.entities.Campaign.filter({ amazon_account_id: acc.id }, '-created_date', 500),
      ]);
      setTerms(data);
      setSuggestions(suggs);
      setCampaigns(camps);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Mapa campaignId → campaign para links rápidos
  const campaignMap = Object.fromEntries(
    campaigns.map(c => [c.campaign_id, c])
  );

  // ── Filtros TermBank ────────────────────────────────────────────────────────
  const uniqueAsins = [...new Set(terms.map(t => t.asin).filter(Boolean))];
  const filteredTerms = terms
    .filter(t => {
      const q = search.toLowerCase();
      const matchSearch = !q || t.term?.toLowerCase().includes(q) || t.asin?.toLowerCase().includes(q) || t.product_name?.toLowerCase().includes(q);
      const matchClass = filterClass === 'all' || t.classification === filterClass;
      const matchAsin  = filterAsin === 'all'  || t.asin === filterAsin;
      return matchSearch && matchClass && matchAsin;
    })
    .sort((a, b) => {
      if (sortBy === 'performance_score') return (b.performance_score || 0) - (a.performance_score || 0);
      if (sortBy === 'orders') return (b.orders || 0) - (a.orders || 0);
      if (sortBy === 'spend')  return (b.spend || 0) - (a.spend || 0);
      if (sortBy === 'acos')   return (a.acos || 0) - (b.acos || 0);
      if (sortBy === 'term')   return (a.term || '').localeCompare(b.term || '');
      return 0;
    });

  // ── Filtros Sugestões IA ───────────────────────────────────────────────────
  const uniqueSuggAsins = [...new Set(suggestions.map(s => s.asin).filter(Boolean))];
  const filteredSuggs = suggestions
    .filter(s => {
      const q = search.toLowerCase();
      const matchSearch = !q || s.keyword?.toLowerCase().includes(q) || s.asin?.toLowerCase().includes(q);
      const matchStatus = filterStatus === 'all' || s.status === filterStatus;
      const matchAsin   = filterAsin === 'all'   || s.asin === filterAsin;
      return matchSearch && matchStatus && matchAsin;
    })
    .sort((a, b) => {
      if (sortBy === 'performance_score') return (b.relevance_score || b.confidence || 0) - (a.relevance_score || a.confidence || 0);
      if (sortBy === 'term') return (a.keyword || '').localeCompare(b.keyword || '');
      return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    });

  // KPIs TermBank
  const winners    = terms.filter(t => t.classification === 'winner').length;
  const wasting    = terms.filter(t => t.classification === 'wasting').length;
  const totalOrders = terms.reduce((s, t) => s + (t.orders || 0), 0);
  const avgScore   = terms.length > 0 ? Math.round(terms.reduce((s, t) => s + (t.performance_score || 0), 0) / terms.length) : 0;

  // KPIs Sugestões
  const suggCreated  = suggestions.filter(s => s.status === 'created').length;
  const suggPending  = suggestions.filter(s => s.status === 'suggested' || s.status === 'approved').length;
  const suggFailed   = suggestions.filter(s => s.status === 'failed').length;
  const suggAi       = suggestions.filter(s => s.source === 'OPENAI_TITLE_ANALYSIS' || s.source === 'CONVERTED_TERM_EXPANSION').length;

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-violet-500/15 border border-violet-500/20 flex items-center justify-center">
            <BookOpen className="w-5 h-5 text-violet-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Banco de Termos</h1>
            <p className="text-xs text-slate-400">{terms.length} termos · {winners} vencedores · {suggestions.length} sugestões IA</p>
          </div>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-2 px-3 py-2 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-sm rounded-lg transition-colors">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-surface-2 gap-1">
        {[
          { id: 'termbank',    label: `📚 TermBank (${terms.length})` },
          { id: 'ai_suggestions', label: `🤖 Sugestões IA (${suggestions.length})` },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors ${tab === t.id ? 'border-violet-400 text-violet-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {error && <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-sm text-red-400">{error}</div>}

      {/* ── TAB: TERMBANK ────────────────────────────────────────────────────── */}
      {tab === 'termbank' && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            {[
              { label: 'Total de Termos', value: terms.length, color: 'text-white' },
              { label: 'Vencedores',      value: winners,      color: 'text-emerald-400' },
              { label: 'Desperdício',     value: wasting,      color: 'text-red-400' },
              { label: 'Total Pedidos',   value: totalOrders,  color: 'text-cyan' },
              { label: 'Score Médio',     value: `${avgScore}/100`, color: 'text-violet-400' },
            ].map(k => (
              <div key={k.label} className="bg-surface-1 border border-surface-2 rounded-xl p-4">
                <p className="text-xs text-slate-500 mb-1">{k.label}</p>
                <p className={`text-xl font-bold ${k.color}`}>{k.value}</p>
              </div>
            ))}
          </div>

          {/* Filtros */}
          <div className="flex flex-col sm:flex-row gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[180px] max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Pesquisar termo, ASIN..."
                className="w-full pl-10 pr-4 py-2 bg-surface-1 border border-surface-2 rounded-lg text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-violet-400/50" />
            </div>
            <select value={filterClass} onChange={e => setFilterClass(e.target.value)}
              className="px-3 py-2 bg-surface-1 border border-surface-2 rounded-lg text-sm text-slate-300 focus:outline-none">
              <option value="all">Todas as classes</option>
              {Object.entries(CLASS_CONFIG).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
            {uniqueAsins.length > 1 && (
              <select value={filterAsin} onChange={e => setFilterAsin(e.target.value)}
                className="px-3 py-2 bg-surface-1 border border-surface-2 rounded-lg text-sm text-slate-300 focus:outline-none">
                <option value="all">Todos os ASINs</option>
                {uniqueAsins.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            )}
            <select value={sortBy} onChange={e => setSortBy(e.target.value)}
              className="px-3 py-2 bg-surface-1 border border-surface-2 rounded-lg text-sm text-slate-300 focus:outline-none">
              <option value="performance_score">Score</option>
              <option value="orders">Pedidos</option>
              <option value="spend">Gasto</option>
              <option value="acos">ACoS</option>
              <option value="term">Termo A-Z</option>
            </select>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-violet-400 animate-spin" /></div>
          ) : filteredTerms.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
              <BookOpen className="w-12 h-12 text-slate-600" />
              <p className="text-sm text-slate-400">
                {terms.length === 0
                  ? 'O banco de termos está vazio. Os termos são adicionados automaticamente ao fazer kick-off de produtos ou quando a IA detecta termos convertidos.'
                  : 'Nenhum resultado com estes filtros.'}
              </p>
            </div>
          ) : (
            <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-surface-2 bg-surface-2/40">
                      {['Termo', 'ASIN / Produto', 'Classe', 'Score', 'Pedidos', 'Gasto', 'ACoS', 'ROAS', 'CPC', 'Bid Atual', 'Fonte', 'Campanha', 'Cross-ASIN'].map(h => (
                        <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTerms.map(t => {
                      const cls = CLASS_CONFIG[t.classification] || CLASS_CONFIG.new;
                      const linkedCampaign = t.amazon_campaign_id
                        ? campaignMap[t.amazon_campaign_id]
                        : t.campaign_id ? campaignMap[t.campaign_id] : null;
                      return (
                        <tr key={t.id} className="border-b border-surface-2/40 hover:bg-surface-2/30 transition-colors">
                          <td className="px-4 py-3">
                            <p className="text-white font-medium text-sm">{t.term}</p>
                            <p className="text-[10px] text-slate-500">{t.match_type}</p>
                          </td>
                          <td className="px-4 py-3">
                            <p className="font-mono text-xs text-cyan">{t.asin}</p>
                            <p className="text-[10px] text-slate-500 truncate max-w-[140px]">{t.product_name || '—'}</p>
                          </td>
                          <td className="px-4 py-3">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-semibold ${cls.color}`}>
                              {cls.label}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <div className="w-16 h-1.5 bg-surface-3 rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${(t.performance_score || 0) >= 60 ? 'bg-emerald-400' : (t.performance_score || 0) >= 30 ? 'bg-amber-400' : 'bg-red-400'}`}
                                  style={{ width: `${t.performance_score || 0}%` }} />
                              </div>
                              <span className="text-xs text-white font-semibold">{t.performance_score || 0}</span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-cyan font-semibold text-sm">{t.orders || 0}</td>
                          <td className="px-4 py-3 text-slate-300 text-xs">R${fmt(t.spend)}</td>
                          <td className={`px-4 py-3 text-xs font-semibold ${(t.acos || 0) === 0 ? 'text-slate-500' : (t.acos || 0) > 40 ? 'text-red-400' : (t.acos || 0) > 25 ? 'text-amber-400' : 'text-emerald-400'}`}>
                            {(t.acos || 0) > 0 ? `${fmt(t.acos, 1)}%` : '—'}
                          </td>
                          <td className="px-4 py-3 text-xs text-slate-300">{(t.roas || 0) > 0 ? `${fmt(t.roas)}x` : '—'}</td>
                          <td className="px-4 py-3 text-xs text-slate-300">{(t.cpc || 0) > 0 ? `R$${fmt(t.cpc)}` : '—'}</td>
                          <td className="px-4 py-3 text-xs text-white font-mono">R${fmt(t.bid_current || t.bid_initial || 0.50)}</td>
                          <td className="px-4 py-3">
                            <span className="text-[10px] px-1.5 py-0.5 rounded border text-slate-400 bg-surface-2 border-surface-3">
                              {SOURCE_LABELS[t.source] || t.source}
                            </span>
                          </td>
                          {/* Campanha linkada */}
                          <td className="px-4 py-3">
                            {linkedCampaign ? (
                              <Link to="/ads" className="flex items-center gap-1 text-[10px] text-cyan hover:text-cyan/80 transition-colors max-w-[160px]" title={linkedCampaign.name || linkedCampaign.campaign_name}>
                                <ExternalLink className="w-3 h-3 flex-shrink-0" />
                                <span className="truncate">{(linkedCampaign.name || linkedCampaign.campaign_name || '').slice(0, 28)}</span>
                              </Link>
                            ) : (t.amazon_campaign_id || t.campaign_id) ? (
                              <span className="text-[10px] text-slate-500 font-mono">{(t.amazon_campaign_id || t.campaign_id).toString().slice(-8)}</span>
                            ) : (
                              <span className="text-slate-600 text-xs">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {(t.compatible_asins || []).length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {(t.compatible_asins || []).slice(0, 3).map(a => (
                                  <span key={a} className="text-[9px] px-1.5 py-0.5 rounded bg-violet-500/10 border border-violet-500/20 text-violet-400 font-mono">{a}</span>
                                ))}
                                {(t.compatible_asins || []).length > 3 && (
                                  <span className="text-[9px] text-slate-500">+{(t.compatible_asins).length - 3}</span>
                                )}
                              </div>
                            ) : <span className="text-slate-600 text-xs">—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── TAB: SUGESTÕES IA ───────────────────────────────────────────────── */}
      {tab === 'ai_suggestions' && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { label: 'Total Sugestões',   value: suggestions.length, color: 'text-white' },
              { label: 'Campanhas criadas', value: suggCreated,        color: 'text-emerald-400' },
              { label: 'Pendentes',         value: suggPending,        color: 'text-amber-400' },
              { label: 'Com falha',         value: suggFailed,         color: 'text-red-400' },
            ].map(k => (
              <div key={k.label} className="bg-surface-1 border border-surface-2 rounded-xl p-4">
                <p className="text-xs text-slate-500 mb-1">{k.label}</p>
                <p className={`text-xl font-bold ${k.color}`}>{k.value}</p>
              </div>
            ))}
          </div>

          {/* Filtros */}
          <div className="flex flex-col sm:flex-row gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[180px] max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Pesquisar keyword, ASIN..."
                className="w-full pl-10 pr-4 py-2 bg-surface-1 border border-surface-2 rounded-lg text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-violet-400/50" />
            </div>
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
              className="px-3 py-2 bg-surface-1 border border-surface-2 rounded-lg text-sm text-slate-300 focus:outline-none">
              <option value="all">Todos os status</option>
              {Object.entries(SUGGESTION_STATUS).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
            {uniqueSuggAsins.length > 1 && (
              <select value={filterAsin} onChange={e => setFilterAsin(e.target.value)}
                className="px-3 py-2 bg-surface-1 border border-surface-2 rounded-lg text-sm text-slate-300 focus:outline-none">
                <option value="all">Todos os ASINs</option>
                {uniqueSuggAsins.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            )}
            <select value={sortBy} onChange={e => setSortBy(e.target.value)}
              className="px-3 py-2 bg-surface-1 border border-surface-2 rounded-lg text-sm text-slate-300 focus:outline-none">
              <option value="performance_score">Score / Confiança</option>
              <option value="term">Keyword A-Z</option>
            </select>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-violet-400 animate-spin" /></div>
          ) : filteredSuggs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
              <Bot className="w-12 h-12 text-slate-600" />
              <p className="text-sm text-slate-400">
                {suggestions.length === 0
                  ? 'Nenhuma sugestão de keyword gerada pela IA ainda. Execute um kick-off de produto para gerar sugestões.'
                  : 'Nenhum resultado com estes filtros.'}
              </p>
            </div>
          ) : (
            <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-surface-2 bg-surface-2/40">
                      {['Keyword', 'ASIN / SKU', 'Status Campanha', 'Confiança', 'Bid Sugerido', 'Match', 'Intenção', 'Campanha Criada', 'Performance', 'Origem', 'Data'].map(h => (
                        <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSuggs.map(s => {
                      const statusCfg = SUGGESTION_STATUS[s.status] || SUGGESTION_STATUS.suggested;
                      const StatusIcon = statusCfg.icon;
                      const linkedCamp = s.amazon_campaign_id
                        ? campaignMap[s.amazon_campaign_id]
                        : s.created_campaign_id ? campaignMap[s.created_campaign_id] : null;
                      const hasPerf = (s.recommended_bid || 0) > 0 || (s.maximum_profitable_cpc || 0) > 0;

                      return (
                        <tr key={s.id} className="border-b border-surface-2/40 hover:bg-surface-2/30 transition-colors">
                          {/* Keyword */}
                          <td className="px-4 py-3 min-w-[160px]">
                            <p className="text-white font-semibold text-sm">{s.keyword}</p>
                            {s.reason && <p className="text-[10px] text-slate-500 max-w-[200px] truncate" title={s.reason}>{s.reason}</p>}
                          </td>

                          {/* ASIN / SKU */}
                          <td className="px-4 py-3">
                            <p className="font-mono text-xs text-cyan">{s.asin}</p>
                            {s.sku && <p className="text-[10px] text-slate-500">{s.sku}</p>}
                          </td>

                          {/* Status */}
                          <td className="px-4 py-3">
                            <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] font-semibold ${statusCfg.color}`}>
                              <StatusIcon className={`w-3 h-3 ${s.status === 'creating' ? 'animate-spin' : ''}`} />
                              {statusCfg.label}
                            </span>
                            {s.error && (
                              <p className="text-[9px] text-red-400 mt-0.5 max-w-[160px] truncate" title={s.error}>{s.error}</p>
                            )}
                          </td>

                          {/* Confiança */}
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <div className="w-14 h-1.5 bg-surface-3 rounded-full overflow-hidden">
                                <div className="h-full rounded-full bg-violet-400"
                                  style={{ width: `${Math.round((s.confidence || s.relevance_score || 0) * 100)}%` }} />
                              </div>
                              <span className="text-xs text-violet-400 font-semibold">
                                {Math.round((s.confidence || s.relevance_score || 0) * 100)}%
                              </span>
                            </div>
                          </td>

                          {/* Bid sugerido */}
                          <td className="px-4 py-3 text-xs font-mono text-white">
                            {s.recommended_bid ? `R$${fmt(s.recommended_bid)}` : s.recommended_budget ? `R$${fmt(s.recommended_budget)} /dia` : '—'}
                          </td>

                          {/* Match */}
                          <td className="px-4 py-3">
                            <span className="text-[10px] px-1.5 py-0.5 rounded border text-slate-300 bg-surface-2 border-surface-3 uppercase">
                              {s.match_type || 'exact'}
                            </span>
                          </td>

                          {/* Intenção */}
                          <td className="px-4 py-3">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
                              s.intent === 'high_purchase_intent' ? 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20'
                              : s.intent === 'commercial' ? 'text-cyan bg-cyan/10 border-cyan/20'
                              : 'text-slate-400 bg-surface-2 border-surface-3'
                            }`}>
                              {s.intent === 'high_purchase_intent' ? 'Alta intenção'
                                : s.intent === 'commercial' ? 'Comercial'
                                : s.intent === 'informational' ? 'Informacional'
                                : s.intent || '—'}
                            </span>
                          </td>

                          {/* Campanha criada — link */}
                          <td className="px-4 py-3 min-w-[150px]">
                            {linkedCamp ? (
                              <Link to="/ads" className="flex items-center gap-1 text-[10px] text-cyan hover:text-cyan/80 transition-colors"
                                title={linkedCamp.name || linkedCamp.campaign_name}>
                                <ExternalLink className="w-3 h-3 flex-shrink-0" />
                                <span className="truncate max-w-[130px]">{(linkedCamp.name || linkedCamp.campaign_name || '').slice(0, 30)}</span>
                              </Link>
                            ) : (s.amazon_campaign_id || s.created_campaign_id) ? (
                              <span className="text-[10px] text-slate-500 font-mono">
                                ID: {(s.amazon_campaign_id || s.created_campaign_id).toString().slice(-10)}
                              </span>
                            ) : s.status === 'created' ? (
                              <span className="text-[10px] text-emerald-400">Criada ✓</span>
                            ) : (
                              <span className="text-slate-600 text-xs">—</span>
                            )}
                          </td>

                          {/* Performance do termo */}
                          <td className="px-4 py-3 min-w-[120px]">
                            {hasPerf ? (
                              <div className="space-y-0.5">
                                {s.recommended_bid > 0 && (
                                  <p className="text-[10px] text-slate-400">Bid: <span className="text-white">R${fmt(s.recommended_bid)}</span></p>
                                )}
                                {s.maximum_profitable_cpc > 0 && (
                                  <p className="text-[10px] text-slate-400">CPC max: <span className="text-amber-400">R${fmt(s.maximum_profitable_cpc)}</span></p>
                                )}
                                {s.bid_confidence && (
                                  <span className={`text-[9px] px-1 py-0.5 rounded border ${
                                    s.bid_confidence === 'high' ? 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20'
                                    : s.bid_confidence === 'medium' ? 'text-amber-400 bg-amber-400/10 border-amber-400/20'
                                    : 'text-slate-400 bg-surface-2 border-surface-3'
                                  }`}>{s.bid_confidence === 'high' ? 'Alta conf.' : s.bid_confidence === 'medium' ? 'Média conf.' : 'Baixa conf.'}</span>
                                )}
                              </div>
                            ) : <span className="text-slate-600 text-xs">—</span>}
                          </td>

                          {/* Origem */}
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1">
                              <Bot className="w-3 h-3 text-violet-400 flex-shrink-0" />
                              <span className="text-[10px] text-slate-400 truncate max-w-[100px]">
                                {SOURCE_SUGGESTION_LABELS[s.source] || s.source}
                              </span>
                            </div>
                          </td>

                          {/* Data */}
                          <td className="px-4 py-3 text-[10px] text-slate-500 whitespace-nowrap">
                            {s.created_at ? new Date(s.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '—'}
                            {s.executed_at && (
                              <p className="text-emerald-400">Exec: {new Date(s.executed_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}</p>
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
        </>
      )}
    </div>
  );
}