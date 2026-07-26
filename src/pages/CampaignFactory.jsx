import { useState, useEffect, useMemo, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Factory, TrendingUp, Search, RefreshCw, Loader2,
  CheckCircle, XCircle, Clock, Zap, Sparkles, Target, BarChart2,
  BookOpen, Megaphone, ChevronUp, ChevronDown
} from 'lucide-react';
import AmazonSuggestionsTab from '@/components/termbank/AmazonSuggestionsTab';
import IASuggestionsTab from '@/components/factory/IASuggestionsTab';
import KeywordInvestigatorTab from '@/components/factory/KeywordInvestigatorTab';
import KeywordBankSection from '@/components/factory/KeywordBankSection';
import KeywordBankTab from '@/components/factory/KeywordBankTab';

// ── Configs ──────────────────────────────────────────────────────────────
const LIFECYCLE_CONFIG = {
  WINNER:       { label: 'Winner',       color: 'text-emerald-400', bg: 'bg-emerald-500/15 border-emerald-500/30' },
  STRONG_WINNER:{ label: 'Strong Winner',color: 'text-emerald-300', bg: 'bg-emerald-400/20 border-emerald-400/40' },
  CANDIDATE:    { label: 'Candidato',    color: 'text-cyan',        bg: 'bg-cyan/15 border-cyan/30' },
  VALIDATING:   { label: 'Validando',    color: 'text-amber-400',   bg: 'bg-amber-500/15 border-amber-500/30' },
  SUGGESTION:   { label: 'Sugestão',     color: 'text-slate-400',   bg: 'bg-slate-500/10 border-slate-500/20' },
  FAILED:       { label: 'Falhou',       color: 'text-red-400',     bg: 'bg-red-500/15 border-red-500/30' },
  BANK_ONLY:    { label: 'No Bank',      color: 'text-slate-500',   bg: 'bg-slate-500/10 border-slate-500/20' },
  RETIRED:      { label: 'Retirado',     color: 'text-slate-600',   bg: 'bg-slate-700/15 border-slate-600/20' },
  HARVESTED:    { label: 'Colhido',      color: 'text-violet-400',  bg: 'bg-violet-500/15 border-violet-500/30' },
  SCALED:       { label: 'Escalado',     color: 'text-blue-400',    bg: 'bg-blue-500/15 border-blue-500/30' },
};

const SOURCE_LABELS = {
  AUTO_SEARCH_TERM:        'Auto ST',
  BROAD_SEARCH_TERM:       'Broad ST',
  PHRASE_SEARCH_TERM:      'Phrase ST',
  EXACT_KEYWORD:           'Exact KW',
  AMAZON_KEYWORD_SUGGESTION:'Amazon Sug.',
  AMAZON_PRODUCT_SUGGESTION:'Amazon Prod.',
  PRODUCT_TARGET_WINNER:   'Prod. Target',
  KEYWORD_BANK:            'Bank',
  HISTORICAL_WINNER:       'Histórico',
};

const PLAN_STATUS_CONFIG = {
  PROPOSED:       { label: 'Proposto',   color: 'text-cyan',       bg: 'bg-cyan/10 border-cyan/25' },
  APPROVED:       { label: 'Aprovado',   color: 'text-emerald-400',bg: 'bg-emerald-500/10 border-emerald-500/25' },
  EXECUTING:      { label: 'Executando', color: 'text-amber-400',  bg: 'bg-amber-500/10 border-amber-500/25' },
  EXECUTED:       { label: 'Criada',     color: 'text-emerald-300',bg: 'bg-emerald-400/15 border-emerald-400/30' },
  FAILED:         { label: 'Falhou',     color: 'text-red-400',    bg: 'bg-red-500/10 border-red-500/25' },
  REJECTED:       { label: 'Rejeitado',  color: 'text-slate-500',  bg: 'bg-slate-500/10 border-slate-500/20' },
  DUPLICATE_FOUND:{ label: 'Duplicata',  color: 'text-slate-400',  bg: 'bg-slate-500/10 border-slate-500/20' },
  WAITING:        { label: 'Aguardando', color: 'text-slate-400',  bg: 'bg-slate-500/10 border-slate-500/20' },
};

// ── Sub-components ────────────────────────────────────────────────────────
function StatCard({ icon: Icon, label, value, color = 'text-white', sub }) {
  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-1">
        <Icon className={`w-3.5 h-3.5 ${color}`} />
        <span className="text-[10px] text-slate-500 uppercase tracking-wider">{label}</span>
      </div>
      <p className={`text-xl font-bold ${color}`}>{value}</p>
      {sub ? <p className="text-[10px] text-slate-500 mt-0.5">{sub}</p> : null}
    </div>
  );
}

function LifecycleBadge({ status, winnerTier }) {
  const key = winnerTier === 'STRONG_WINNER' ? 'STRONG_WINNER' : (status || 'BANK_ONLY');
  const cfg = LIFECYCLE_CONFIG[key] || LIFECYCLE_CONFIG.BANK_ONLY;
  return (
    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${cfg.bg} ${cfg.color}`}>
      {cfg.label}
    </span>
  );
}

function SourceBadge({ source }) {
  return (
    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-surface-3 text-slate-400 border border-surface-3">
      {SOURCE_LABELS[source] || source}
    </span>
  );
}

function IntentBar({ score }) {
  const color = score >= 85 ? 'bg-emerald-500' : score >= 60 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 bg-surface-3 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${score}%` }} />
      </div>
      <span className="text-[10px] text-slate-400">{score}</span>
    </div>
  );
}

// ── Abas ─────────────────────────────────────────────────────────────────
const TABS = [
  { key: 'overview',     label: 'Visão Geral',  icon: BarChart2 },
  { key: 'winners',      label: 'Winners',      icon: TrendingUp },
  { key: 'harvest',      label: 'Harvest Ready',icon: Zap },
  { key: 'plans',        label: 'Planos',       icon: Factory },
  { key: 'ia_sug',       label: 'Sugestões IA', icon: Sparkles },
  { key: 'keyword_bank', label: 'Keyword Bank', icon: BookOpen },
];

// ── TermBank sub-tab ──────────────────────────────────────────────────────
const fmt = (v, d = 2) => Number(v || 0).toFixed(d).replace('.', ',');
const toConf100 = (c) => c == null ? 0 : c <= 1 ? Math.round(c * 100) : Math.round(c);
const isTermIncomplete = (kw) => {
  if (!kw) return true;
  const k = kw.trim();
  if (k.length < 3) return true;
  if (/\.{2,}$|:\s*$/.test(k)) return true;
  const allowedShort = new Set(['de','do','da','dos','das','em','no','na','ao','os','as','e','a','o']);
  const lastWord = k.split(/\s+/).pop() || '';
  if (lastWord.length <= 2 && !allowedShort.has(lastWord.toLowerCase())) return true;
  if (/^[\d\s\W]+$/.test(k)) return true;
  return false;
};

function TermBankTab({ account, terms, schedulingId, scheduledIds, onSchedule, search }) {
  const [sortKey, setSortKey] = useState('confidence');
  const [sortDir, setSortDir] = useState('desc');

  const handleSort = (key) => {
    setSortKey(prev => {
      if (prev === key) { setSortDir(d => d === 'desc' ? 'asc' : 'desc'); return key; }
      setSortDir('desc');
      return key;
    });
  };

  const SORT_FIELDS = {
    confidence: t => toConf100(t.confidence),
    clicks: t => t.clicks || 0,
    impressions: t => t.impressions || 0,
    orders: t => t.orders || 0,
    sales: t => t.sales || 0,
    spend: t => t.spend || 0,
    acos: t => t.acos || 0,
    roas: t => t.roas || 0,
  };

  const filtered = terms
    .filter(t => `${t.term || ''} ${t.asin || ''} ${t.product_name || ''}`.toLowerCase().includes(search))
    .sort((a, b) => {
      const fn = SORT_FIELDS[sortKey];
      if (!fn) return 0;
      return sortDir === 'desc' ? fn(b) - fn(a) : fn(a) - fn(b);
    });

  const SortIcon = ({ k }) => sortKey === k
    ? (sortDir === 'desc' ? <ChevronDown className="w-3 h-3 text-cyan" /> : <ChevronUp className="w-3 h-3 text-cyan" />)
    : <ChevronDown className="w-3 h-3 opacity-25" />;

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">{filtered.length} termos validados com métricas reais de performance</p>
      <div className="overflow-hidden rounded-xl border border-surface-2 bg-surface-1">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-2 bg-surface-2/40">
                {[
                  { label: 'Termo', key: null },
                  { label: 'Conf.', key: 'confidence' },
                  { label: 'Produto / ASIN', key: null },
                  { label: 'Status', key: null },
                  { label: 'Cliques', key: 'clicks' },
                  { label: 'Impr.', key: 'impressions' },
                  { label: 'Pedidos', key: 'orders' },
                  { label: 'Vendas', key: 'sales' },
                  { label: 'Gasto', key: 'spend' },
                  { label: 'ACoS', key: 'acos' },
                  { label: 'ROAS', key: 'roas' },
                  { label: '', key: null },
                ].map(({ label, key }) => (
                  <th key={label || '_a'} onClick={key ? () => handleSort(key) : undefined}
                    className={`px-4 py-3 text-left text-xs uppercase text-slate-500 whitespace-nowrap select-none ${key ? 'cursor-pointer hover:text-slate-300 transition-colors' : ''}`}>
                    <span className="inline-flex items-center gap-1">
                      {label}{key && <SortIcon k={key} />}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(t => {
                const conf = toConf100(t.confidence);
                const confColor = conf >= 90 ? 'text-emerald-400' : conf >= 75 ? 'text-amber-400' : 'text-red-400';
                const acosNum = Number(t.acos || 0);
                const acosColor = acosNum === 0 ? 'text-slate-500' : acosNum <= 15 ? 'text-emerald-400' : acosNum <= 25 ? 'text-amber-400' : 'text-red-400';
                return (
                  <tr key={t.id} className="border-b border-surface-2/40 hover:bg-surface-2/20 transition-colors">
                    <td className="px-4 py-3">
                      <span className="font-semibold text-white">{t.term}</span>
                      {t._has_real_data && <span className="ml-1.5 text-[9px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1 py-0.5 rounded">real</span>}
                    </td>
                    <td className="px-4 py-3"><span className={`text-xs font-bold ${confColor}`}>{conf > 0 ? `${conf}%` : '—'}</span></td>
                    <td className="px-4 py-3">
                      <p className="max-w-[200px] truncate text-xs text-slate-200">{t.product_name || 'Produto não identificado'}</p>
                      <p className="font-mono text-[10px] text-cyan">{t.asin || 'Sem ASIN'}</p>
                    </td>
                    <td className="px-4 py-3 text-xs"><span className={t.status === 'active' ? 'text-emerald-400' : 'text-slate-500'}>{t.status || 'inactive'}</span></td>
                    <td className="px-4 py-3 text-xs text-slate-300">{(t.clicks || 0).toLocaleString('pt-BR')}</td>
                    <td className="px-4 py-3 text-xs text-slate-300">{(t.impressions || 0).toLocaleString('pt-BR')}</td>
                    <td className="px-4 py-3 text-cyan">{t.orders || 0}</td>
                    <td className="px-4 py-3 text-xs text-emerald-400">{Number(t.sales) > 0 ? `R$${fmt(t.sales)}` : '—'}</td>
                    <td className="px-4 py-3 text-xs text-slate-300">{Number(t.spend) > 0 ? `R$${fmt(t.spend)}` : '—'}</td>
                    <td className="px-4 py-3 text-xs"><span className={acosColor}>{acosNum > 0 ? `${fmt(t.acos, 1)}%` : '—'}</span></td>
                    <td className="px-4 py-3 text-xs text-slate-300">{Number(t.roas) > 0 ? `${fmt(t.roas)}x` : '—'}</td>
                    <td className="px-4 py-3">
                      {scheduledIds[t.id] === 'executed' ? (
                        <span className="flex items-center gap-1 text-[10px] text-emerald-400"><CheckCircle className="w-3 h-3" />Criada</span>
                      ) : scheduledIds[t.id] === 'queued' ? (
                        <span className="flex items-center gap-1 text-[10px] text-amber-400"><Clock className="w-3 h-3" />Agendada</span>
                      ) : scheduledIds[t.id] === 'exists' ? (
                        <span className="text-[10px] text-slate-500">Já existe</span>
                      ) : (
                        <button onClick={() => onSchedule(t)} disabled={schedulingId === t.id}
                          className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold rounded-lg border border-cyan/30 bg-cyan/10 text-cyan hover:bg-cyan/20 disabled:opacity-50 transition-colors whitespace-nowrap">
                          {schedulingId === t.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Megaphone className="w-3 h-3" />}
                          Criar campanha
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────
export default function CampaignFactory() {
  const [account, setAccount]       = useState(null);
  const [tab, setTab]               = useState('overview');
  const [bankEntries, setBankEntries] = useState([]);
  const [plans, setPlans]           = useState([]);
  const [terms, setTerms]           = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [products, setProducts]     = useState([]);
  const [loading, setLoading]       = useState(true);
  const [search, setSearch]         = useState('');
  const [lifecycleFilter, setLifecycleFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [schedulingId, setSchedulingId] = useState(null);
  const [scheduledIds, setScheduledIds] = useState({});
  const [termMsg, setTermMsg]       = useState(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const me   = await base44.auth.me();
      const accs = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc  = accs[0] || null;
      setAccount(acc);
      if (!acc) return;

      // Background tasks
      setTimeout(() => {
        base44.functions.invoke('updateTermBankFromAutomaticCampaigns', { amazon_account_id: acc.id }).catch(() => {});
        base44.functions.invoke('cleanupLegacySuggestions', { amazon_account_id: acc.id }).catch(() => {});
      }, 3000);

      const [bankData, plansData, termData, sugData, prodData, kwData, stData] = await Promise.all([
        base44.entities.KeywordBank.filter({ amazon_account_id: acc.id }, '-promotion_score', 500).catch(() => []),
        base44.entities.CampaignFactoryPlan.filter({ amazon_account_id: acc.id }, '-proposed_at', 100).catch(() => []),
        base44.entities.TermBank.filter({ amazon_account_id: acc.id }, '-confidence', 500).catch(() => []),
        base44.entities.KeywordSuggestion.filter({ amazon_account_id: acc.id }, '-created_at', 500).catch(() => []),
        base44.entities.Product.filter({ amazon_account_id: acc.id }, '-updated_at', 200).catch(() => []),
        base44.entities.Keyword.filter({ amazon_account_id: acc.id }, '-spend', 500).catch(() => []),
        base44.entities.SearchTerm.filter({ amazon_account_id: acc.id }, '-spend', 500).catch(() => []),
      ]);

      setBankEntries(bankData);
      setPlans(plansData);

      // Enriquecer TermBank com métricas reais
      const realMetrics = new Map();
      const addMetric = (text, m) => {
        const key = (text || '').toLowerCase().trim();
        if (!key) return;
        if (!realMetrics.has(key)) realMetrics.set(key, { spend: 0, sales: 0, clicks: 0, orders: 0, impressions: 0, bids: [] });
        const e = realMetrics.get(key);
        e.spend += m.spend || 0; e.sales += m.sales || 0; e.clicks += m.clicks || 0;
        e.orders += m.orders || 0; e.impressions += m.impressions || 0;
        if (m.bid > 0) e.bids.push(m.bid);
      };
      for (const kw of kwData) addMetric(kw.keyword_text, kw);
      for (const st of stData) addMetric(st.search_term || st.query, st);

      const activeAsins = new Set(prodData.filter(p => p.status !== 'archived' && p.status !== 'inactive').map(p => p.asin).filter(Boolean));
      const validTerms = termData
        .filter(t => !isTermIncomplete(t.term) && t.asin && activeAsins.has(t.asin))
        .map(t => {
          const key = (t.term || '').toLowerCase().trim();
          const real = realMetrics.get(key);
          if (!real) return t;
          const spend = real.spend, sales = real.sales;
          const acos = sales > 0 ? spend / sales * 100 : 0;
          const roas = spend > 0 ? sales / spend : 0;
          const avgBid = real.bids.length ? real.bids.reduce((a, b) => a + b, 0) / real.bids.length : (t.suggested_bid || 0);
          return { ...t, spend: spend > 0 ? spend : t.spend, sales: sales > 0 ? sales : t.sales, orders: real.orders > 0 ? real.orders : t.orders, clicks: real.clicks > 0 ? real.clicks : t.clicks, impressions: real.impressions > 0 ? real.impressions : t.impressions, acos: spend > 0 ? acos : t.acos, roas: spend > 0 ? roas : t.roas, suggested_bid: avgBid > 0 ? avgBid : t.suggested_bid, _has_real_data: spend > 0 || real.clicks > 0 };
        })
        .sort((a, b) => toConf100(b.confidence) - toConf100(a.confidence));
      setTerms(validTerms);

      const activeProducts = prodData.filter(p => p.status !== 'archived' && p.status !== 'inactive');
      setSuggestions(sugData.filter(s => s.status !== 'rejected' && s.deleted_by_user !== true && !isTermIncomplete(s.keyword) && s.asin && activeAsins.has(s.asin)));
      setProducts(activeProducts);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleScheduleTerm = useCallback(async (term) => {
    if (!account || schedulingId) return;
    setSchedulingId(term.id);
    setTermMsg(null);
    try {
      const res = await base44.functions.invoke('scheduleManualCampaignFromTerm', {
        amazon_account_id: account.id,
        asin: term.asin,
        keyword: term.term,
        product_name: term.product_name || term.asin,
        sku: term.sku || null,
      });
      const d = res?.data || {};
      if (d?.ok) {
        setTermMsg({ type: d.executed ? 'success' : 'info', text: d.message });
        setScheduledIds(prev => ({ ...prev, [term.id]: d.executed ? 'executed' : 'queued' }));
        window.dispatchEvent(new CustomEvent('term-campaign-queued', { detail: { asin: term.asin, keyword: term.term } }));
      } else if (d?.already_exists || d?.already_queued) {
        setTermMsg({ type: 'info', text: `Campanha já existe para "${term.term}".` });
        setScheduledIds(prev => ({ ...prev, [term.id]: 'exists' }));
      } else {
        setTermMsg({ type: 'error', text: d?.error || 'Erro ao agendar campanha' });
      }
    } catch (e) {
      setTermMsg({ type: 'error', text: e.message });
    } finally {
      setSchedulingId(null);
    }
  }, [account, schedulingId]);

  const approvePlan = async (plan) => {
    await base44.entities.CampaignFactoryPlan.update(plan.id, { status: 'APPROVED', approved_at: new Date().toISOString() }).catch(() => {});
    setPlans(prev => prev.map(p => p.id === plan.id ? { ...p, status: 'APPROVED' } : p));
  };

  const rejectPlan = async (plan) => {
    await base44.entities.CampaignFactoryPlan.update(plan.id, { status: 'REJECTED' }).catch(() => {});
    setPlans(prev => prev.map(p => p.id === plan.id ? { ...p, status: 'REJECTED' } : p));
  };

  // ── Métricas ─────────────────────────────────────────────────────────
  const stats = useMemo(() => ({
    total:      bankEntries.length,
    winners:    bankEntries.filter(e => e.lifecycle_status === 'WINNER').length,
    strong:     bankEntries.filter(e => e.winner_tier === 'STRONG_WINNER').length,
    harvest:    bankEntries.filter(e => e.harvest_candidate).length,
    candidates: bankEntries.filter(e => e.lifecycle_status === 'CANDIDATE').length,
    validating: bankEntries.filter(e => e.lifecycle_status === 'VALIDATING').length,
    failed:     bankEntries.filter(e => e.lifecycle_status === 'FAILED').length,
    proposed:   plans.filter(p => p.status === 'PROPOSED').length,
    amazon_sug: bankEntries.filter(e => e.source_type === 'AMAZON_KEYWORD_SUGGESTION').length,
  }), [bankEntries, plans]);

  const filteredBank = useMemo(() => {
    let list = bankEntries;
    if (search) {
      const s = search.toLowerCase();
      list = list.filter(e => (e.keyword || '').toLowerCase().includes(s) || (e.asin || '').toLowerCase().includes(s));
    }
    if (lifecycleFilter !== 'all') list = list.filter(e => e.lifecycle_status === lifecycleFilter || e.winner_tier === lifecycleFilter);
    if (sourceFilter !== 'all') list = list.filter(e => e.source_type === sourceFilter);
    return list;
  }, [bankEntries, search, lifecycleFilter, sourceFilter]);

  const winners  = useMemo(() => bankEntries.filter(e => e.lifecycle_status === 'WINNER').sort((a,b) => b.promotion_score - a.promotion_score), [bankEntries]);
  const harvests = useMemo(() => bankEntries.filter(e => e.harvest_candidate).sort((a,b) => b.promotion_score - a.promotion_score), [bankEntries]);

  const funnel = useMemo(() => {
    const total     = bankEntries.length;
    const relevant  = bankEntries.filter(e => e.intent_score >= 60).length;
    const tested    = bankEntries.filter(e => (e.clicks || 0) >= 5).length;
    const converted = bankEntries.filter(e => (e.orders || 0) >= 1).length;
    const onTarget  = bankEntries.filter(e => e.acos > 0 && e.acos <= (e.target_acos || 15)).length;
    return [
      { label: 'Descobertos', value: total },
      { label: 'Relevantes',  value: relevant },
      { label: 'Testados',    value: tested },
      { label: 'Converteram', value: converted },
      { label: 'Bateram ACoS',value: onTarget },
      { label: 'Strong Winners', value: stats.strong },
    ];
  }, [bankEntries, stats]);

  // Dados Amazon Sugestões (para aba)
  const amazonSuggestions = useMemo(() =>
    suggestions.filter(s => ['AMAZON_ADS_SUGGESTED_KEYWORD','AMAZON_ADS_SUGGESTED_TARGET','AMAZON_ADS_RECOMMENDATION'].includes(s.source)),
    [suggestions]
  );

  // Alta relevância para TermBank (para subpanel)
  const highRelevanceData = useMemo(() => {
    const grouped = new Map();
    for (const t of terms) {
      const conf = toConf100(t.confidence);
      if (conf < 80) continue;
      const key = (t.term || '').toLowerCase().trim();
      if (!key) continue;
      if (!grouped.has(key)) grouped.set(key, { term: t.term, conf, records: [], asins: new Set() });
      const g = grouped.get(key);
      g.records.push(t);
      if (t.asin) g.asins.add(t.asin);
      if (conf > g.conf) g.conf = conf;
    }
    return Array.from(grouped.values()).sort((a, b) => b.conf - a.conf);
  }, [terms]);
  const multiAsinTerms = useMemo(() => highRelevanceData.filter(g => g.conf >= 90 && g.asins.size > 1), [highRelevanceData]);

  const q = search.toLowerCase();

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <Loader2 className="w-6 h-6 text-cyan animate-spin" />
    </div>
  );

  if (!account) return (
    <div className="flex items-center justify-center h-full">
      <p className="text-slate-400">Nenhuma conta Amazon configurada.</p>
    </div>
  );

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-surface-2 bg-surface-1 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-violet-500/15 border border-violet-500/30 flex items-center justify-center">
            <Factory className="w-4 h-4 text-violet-400" />
          </div>
          <div>
            <h1 className="text-base font-bold text-white">Campaign Factory</h1>
            <p className="text-[11px] text-slate-500">Motor de aprendizado · {stats.total} termos · {stats.winners} winners · {terms.length} no Term Bank</p>
          </div>
        </div>
        <button onClick={loadData} disabled={loading}
          className="p-1.5 rounded-lg bg-surface-2 border border-surface-3 text-slate-400 hover:text-white transition-colors">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-surface-2 bg-[#0D0F14] flex-shrink-0 overflow-x-auto scrollbar-thin">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-4 py-3 text-xs font-semibold border-b-2 transition-colors whitespace-nowrap ${tab === t.key ? 'border-violet-400 text-violet-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
            <t.icon className="w-3.5 h-3.5" />
            {t.label}
            {t.key === 'harvest' && stats.harvest > 0 && <span className="ml-1 px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 text-[9px] font-bold">{stats.harvest}</span>}
            {t.key === 'plans' && stats.proposed > 0 && <span className="ml-1 px-1.5 py-0.5 rounded-full bg-violet-500/20 text-violet-400 text-[9px] font-bold">{stats.proposed}</span>}
            {t.key === 'keyword_bank' && (terms.length + bankEntries.length) > 0 && <span className="ml-1 px-1.5 py-0.5 rounded-full bg-cyan/20 text-cyan text-[9px] font-bold">{terms.length + bankEntries.length}</span>}
          </button>
        ))}
      </div>

      {/* Search bar for keyword bank sub-tabs */}
      {tab === 'keyword_bank' && (
        <div className="px-6 pt-4 pb-0 flex-shrink-0">
          <div className="relative max-w-sm">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Pesquisar keyword ou ASIN..."
              className="w-full pl-7 pr-3 py-1.5 bg-surface-2 border border-surface-3 rounded-lg text-xs text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan/50" />
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-6">

        {/* ── VISÃO GERAL ── */}
        {tab === 'overview' && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
              <StatCard icon={BookOpen}    label="Keyword Bank"  value={stats.total}      color="text-slate-300" />
              <StatCard icon={TrendingUp}  label="Winners"       value={stats.winners}    color="text-emerald-400" sub={`${stats.strong} strong`} />
              <StatCard icon={Zap}         label="Harvest Ready" value={stats.harvest}    color="text-violet-400" />
              <StatCard icon={Target}      label="Candidatos"    value={stats.candidates} color="text-cyan" />
              <StatCard icon={Clock}       label="Validando"     value={stats.validating} color="text-amber-400" />
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard icon={Factory}     label="Planos propostos" value={stats.proposed}  color="text-violet-400" />
              <StatCard icon={Sparkles}    label="Amazon Sugestões" value={stats.amazon_sug}color="text-cyan" />
              <StatCard icon={XCircle}     label="Falharam"         value={stats.failed}    color="text-red-400" />
              <StatCard icon={BookOpen}    label="Term Bank"         value={terms.length}    color="text-slate-300" />
            </div>
            {/* Funnel */}
            <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
              <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-emerald-400" /> Winner Funnel
              </h3>
              <div className="flex items-end gap-2">
                {funnel.map((step, i) => {
                  const maxVal = funnel[0].value || 1;
                  const height = Math.max(8, (step.value / maxVal) * 120);
                  const colors = ['bg-slate-600','bg-cyan/60','bg-amber-500/60','bg-emerald-600','bg-emerald-500','bg-emerald-400'];
                  return (
                    <div key={i} className="flex flex-col items-center gap-1 flex-1">
                      <span className="text-xs font-bold text-white">{step.value}</span>
                      <div className={`w-full rounded-t-md ${colors[i]}`} style={{ height }} />
                      <span className="text-[9px] text-slate-500 text-center leading-tight">{step.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            {/* Source Quality */}
            <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
              <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2">
                <BarChart2 className="w-4 h-4 text-cyan" /> Qualidade por Fonte
              </h3>
              <div className="space-y-2">
                {Object.entries(SOURCE_LABELS).map(([key, label]) => {
                  const entries = bankEntries.filter(e => e.source_type === key);
                  if (!entries.length) return null;
                  const wins = entries.filter(e => e.lifecycle_status === 'WINNER').length;
                  const pct  = Math.round((wins / entries.length) * 100);
                  return (
                    <div key={key} className="flex items-center gap-3">
                      <span className="text-[10px] text-slate-400 w-28 flex-shrink-0">{label}</span>
                      <div className="flex-1 h-2 bg-surface-3 rounded-full overflow-hidden">
                        <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-[10px] text-slate-400 w-16 text-right">{wins}/{entries.length} ({pct}%)</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ── WINNERS ── */}
        {tab === 'winners' && (
          <div className="space-y-2">
            <p className="text-xs text-slate-500 mb-3">{winners.length} keywords com performance comprovada</p>
            {winners.length === 0 ? (
              <div className="text-center py-16 text-slate-500">
                <TrendingUp className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p>Nenhum winner identificado ainda. O motor processa automaticamente a cada dia.</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-[#0D0F14] z-10">
                  <tr className="border-b border-surface-2">
                    {['Keyword','ASIN','Fonte','Intent','Promo Score','Pedidos','ACoS','Status'].map(h => (
                      <th key={h} className="px-4 py-2.5 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {winners.map((e, i) => (
                    <tr key={e.id || i} className="border-b border-surface-2/40 hover:bg-surface-2/30">
                      <td className="px-4 py-2.5">
                        <p className="text-xs font-medium text-white truncate max-w-[200px]">{e.keyword}</p>
                        <p className="text-[10px] text-slate-500">{e.match_type}</p>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-[10px] text-cyan">{e.asin}</td>
                      <td className="px-4 py-2.5"><SourceBadge source={e.source_type} /></td>
                      <td className="px-4 py-2.5"><IntentBar score={e.intent_score || 0} /></td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <div className="w-12 h-1.5 bg-surface-3 rounded-full overflow-hidden">
                            <div className="h-full bg-violet-500 rounded-full" style={{ width: `${e.promotion_score || 0}%` }} />
                          </div>
                          <span className="text-[10px] text-slate-400">{e.promotion_score || 0}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-emerald-400 font-semibold">{e.orders || 0}</td>
                      <td className="px-4 py-2.5">
                        <span className={`text-xs font-semibold ${(e.acos || 0) > (e.target_acos || 15) ? 'text-red-400' : 'text-emerald-400'}`}>
                          {(e.acos || 0).toFixed(1)}%
                        </span>
                      </td>
                      <td className="px-4 py-2.5"><LifecycleBadge status={e.lifecycle_status} winnerTier={e.winner_tier} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ── HARVEST READY ── */}
        {tab === 'harvest' && (
          <div className="space-y-3">
            <p className="text-xs text-slate-500 mb-3">{harvests.length} termos prontos para colheita — criação de campanha agendada automaticamente</p>
            {harvests.length === 0 ? (
              <div className="text-center py-16 text-slate-500">
                <Zap className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p>Nenhum termo pronto para harvest. O motor identifica vencedores diariamente.</p>
              </div>
            ) : harvests.map((e, i) => (
              <div key={e.id || i} className="bg-surface-1 border border-surface-2 rounded-xl p-4 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="text-sm font-bold text-white">{e.keyword}</span>
                    <SourceBadge source={e.source_type} />
                    <LifecycleBadge status={e.lifecycle_status} winnerTier={e.winner_tier} />
                  </div>
                  <div className="flex items-center gap-4 text-[10px] text-slate-400 flex-wrap">
                    <span className="font-mono text-cyan">{e.asin}</span>
                    <span>{e.orders || 0} pedidos</span>
                    <span>ACoS {(e.acos || 0).toFixed(1)}%</span>
                    <span>Intent {e.intent_score || 0}</span>
                    <span>CPC sust. R${(e.sustainable_cpc || 0).toFixed(2)}</span>
                  </div>
                </div>
                <span className={`text-[10px] font-bold px-2 py-1 rounded-lg border flex-shrink-0 ${
                  e.harvest_action === 'SCALE' ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400' :
                  e.harvest_action === 'CREATE_EXACT' ? 'bg-violet-500/15 border-violet-500/30 text-violet-400' :
                  'bg-cyan/15 border-cyan/30 text-cyan'
                }`}>{e.harvest_action || 'CREATE_EXACT'}</span>
              </div>
            ))}
          </div>
        )}

        {/* ── PLANOS ── */}
        {tab === 'plans' && (
          <div className="space-y-3">
            <p className="text-xs text-slate-500 mb-3">{plans.length} planos de campanha · {stats.proposed} aguardando aprovação</p>
            {plans.length === 0 ? (
              <div className="text-center py-16 text-slate-500">
                <Factory className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p>Nenhum plano gerado ainda. O motor gera planos automaticamente.</p>
              </div>
            ) : plans.map((p, i) => {
              const statusCfg = PLAN_STATUS_CONFIG[p.status] || PLAN_STATUS_CONFIG.PROPOSED;
              return (
                <div key={p.id || i} className="bg-surface-1 border border-surface-2 rounded-xl p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="text-xs font-bold text-white">{p.target_campaign_name}</span>
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${statusCfg.bg} ${statusCfg.color}`}>{statusCfg.label}</span>
                        <SourceBadge source={p.source_type} />
                      </div>
                      <p className="text-[10px] text-slate-500 mb-2">{p.why_created}</p>
                      <div className="flex items-center gap-4 text-[10px] flex-wrap">
                        <span className="font-mono text-cyan">{p.asin}</span>
                        <span className="text-slate-400">Keyword: <span className="text-white">{p.keyword}</span></span>
                        <span className="text-slate-400">Bid: <span className="text-emerald-400">R${(p.initial_bid || 0).toFixed(2)}</span></span>
                        <span className="text-slate-400">CPC sust.: <span className="text-white">R${(p.sustainable_cpc || 0).toFixed(2)}</span></span>
                        <span className="text-slate-400">Budget: <span className="text-white">R${p.initial_budget}/dia</span></span>
                        <span className="text-slate-400">Strategy: <span className="text-amber-400">{p.bidding_strategy}</span></span>
                      </div>
                      <p className="text-[10px] text-slate-600 mt-1">✓ {p.success_criteria}</p>
                      <p className="text-[10px] text-slate-600">✗ {p.failure_criteria}</p>
                    </div>
                    {p.status === 'PROPOSED' && (
                      <div className="flex flex-col gap-1.5 flex-shrink-0">
                        <button onClick={() => approvePlan(p)}
                          className="px-3 py-1.5 text-xs font-semibold bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25 rounded-lg transition-colors flex items-center gap-1">
                          <CheckCircle className="w-3 h-3" /> Aprovar
                        </button>
                        <button onClick={() => rejectPlan(p)}
                          className="px-3 py-1.5 text-xs font-semibold bg-red-500/10 border border-red-500/25 text-red-400 hover:bg-red-500/20 rounded-lg transition-colors flex items-center gap-1">
                          <XCircle className="w-3 h-3" /> Rejeitar
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}



        {/* ── SUGESTÕES IA ── */}
        {tab === 'ia_sug' && <IASuggestionsTab account={account} />}

        {/* ── KEYWORD BANK (seção hierárquica com 4 sub-tabs) ── */}
        {tab === 'keyword_bank' && (
          <KeywordBankSection
            counts={{
              terms: terms.length,
              suggested: amazonSuggestions.filter(s => !['archived_by_policy','superseded'].includes(s.status)).length,
              bank: bankEntries.length,
            }}
          >
            {(subTab) => (
              <>
                {/* Terms */}
                {subTab === 'terms' && (
                  <>
                    {termMsg && (
                      <div className={`mb-3 rounded-lg p-3 text-xs ${termMsg.type === 'success' ? 'bg-emerald-400/10 text-emerald-300' : termMsg.type === 'info' ? 'bg-amber-400/10 text-amber-300' : 'bg-red-400/10 text-red-300'}`}>
                        {termMsg.text}
                      </div>
                    )}
                    <TermBankTab
                      account={account}
                      terms={terms}
                      schedulingId={schedulingId}
                      scheduledIds={scheduledIds}
                      onSchedule={handleScheduleTerm}
                      search={q}
                    />
                  </>
                )}
                {/* Suggested */}
                {subTab === 'suggested' && (
                  <AmazonSuggestionsTab
                    suggestions={amazonSuggestions.filter(s => `${s.keyword || ''} ${s.asin || ''}`.toLowerCase().includes(q))}
                    products={products}
                    account={account}
                    onRefresh={loadData}
                  />
                )}
                {/* Keyword Bank */}
                {subTab === 'bank' && (
                  <KeywordBankTab
                    bankEntries={bankEntries}
                    filteredBank={filteredBank}
                    search={search}
                    setSearch={setSearch}
                    lifecycleFilter={lifecycleFilter}
                    setLifecycleFilter={setLifecycleFilter}
                    sourceFilter={sourceFilter}
                    setSourceFilter={setSourceFilter}
                  />
                )}
                {/* Keyword Investigator */}
                {subTab === 'investigator' && (
                  <KeywordInvestigatorTab account={account} products={products} />
                )}
              </>
            )}
          </KeywordBankSection>
        )}

      </div>
    </div>
  );
}