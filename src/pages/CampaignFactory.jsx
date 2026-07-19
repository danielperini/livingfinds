import { useState, useEffect, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Factory, TrendingUp, TrendingDown, Search, RefreshCw, Loader2,
  CheckCircle, XCircle, Clock, Zap, Sparkles, Target, BarChart2,
  AlertCircle, Play, Eye, ChevronRight, Package, BookOpen
} from 'lucide-react';

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

// ── Abas ────────────────────────────────────────────────────────────────
const TABS = [
  { key: 'overview',  label: 'Visão Geral',    icon: BarChart2 },
  { key: 'winners',   label: 'Winners',        icon: TrendingUp },
  { key: 'harvest',   label: 'Harvest Ready',  icon: Zap },
  { key: 'plans',     label: 'Planos',         icon: Factory },
  { key: 'bank',      label: 'Keyword Bank',   icon: BookOpen },
];

export default function CampaignFactory() {
  const [account, setAccount]     = useState(null);
  const [tab, setTab]             = useState('overview');
  const [bankEntries, setBankEntries] = useState([]);
  const [plans, setPlans]         = useState([]);
  const [loading, setLoading]     = useState(true);
  const [running, setRunning]     = useState(false);
  const [runResult, setRunResult] = useState(null);
  const [runError, setRunError]   = useState(null);
  const [search, setSearch]       = useState('');
  const [lifecycleFilter, setLifecycleFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');

  const loadData = async () => {
    setLoading(true);
    try {
      const me    = await base44.auth.me();
      const accs  = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc   = accs[0] || null;
      setAccount(acc);
      if (!acc) return;

      const [bankData, plansData] = await Promise.all([
        base44.entities.KeywordBank.filter({ amazon_account_id: acc.id }, '-promotion_score', 500).catch(() => []),
        base44.entities.CampaignFactoryPlan.filter({ amazon_account_id: acc.id }, '-proposed_at', 100).catch(() => []),
      ]);
      setBankEntries(bankData);
      setPlans(plansData);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  const runFactory = async (dryRun = true) => {
    if (!account || running) return;
    setRunning(true);
    setRunResult(null);
    setRunError(null);
    try {
      const res = await base44.functions.invoke('runCampaignFactory', {
        amazon_account_id: account.id,
        dry_run: dryRun,
      });
      setRunResult(res?.data);
      if (!dryRun) await loadData();
    } catch (e) {
      setRunError(e.message);
    } finally {
      setRunning(false);
    }
  };

  const approvePlan = async (plan) => {
    await base44.entities.CampaignFactoryPlan.update(plan.id, { status: 'APPROVED', approved_at: new Date().toISOString() }).catch(() => {});
    setPlans(prev => prev.map(p => p.id === plan.id ? { ...p, status: 'APPROVED' } : p));
  };

  const rejectPlan = async (plan) => {
    await base44.entities.CampaignFactoryPlan.update(plan.id, { status: 'REJECTED' }).catch(() => {});
    setPlans(prev => prev.map(p => p.id === plan.id ? { ...p, status: 'REJECTED' } : p));
  };

  // ── Métricas ────────────────────────────────────────────────────────
  const stats = useMemo(() => ({
    total:        bankEntries.length,
    winners:      bankEntries.filter(e => e.lifecycle_status === 'WINNER').length,
    strong:       bankEntries.filter(e => e.winner_tier === 'STRONG_WINNER').length,
    harvest:      bankEntries.filter(e => e.harvest_candidate).length,
    candidates:   bankEntries.filter(e => e.lifecycle_status === 'CANDIDATE').length,
    validating:   bankEntries.filter(e => e.lifecycle_status === 'VALIDATING').length,
    failed:       bankEntries.filter(e => e.lifecycle_status === 'FAILED').length,
    proposed:     plans.filter(p => p.status === 'PROPOSED').length,
    amazon_sug:   bankEntries.filter(e => e.source_type === 'AMAZON_KEYWORD_SUGGESTION').length,
  }), [bankEntries, plans]);

  // ── Filtros Bank ────────────────────────────────────────────────────
  const filteredBank = useMemo(() => {
    let list = bankEntries;
    if (search) {
      const s = search.toLowerCase();
      list = list.filter(e => (e.keyword || '').toLowerCase().includes(s) || (e.asin || '').toLowerCase().includes(s));
    }
    if (lifecycleFilter !== 'all') {
      list = list.filter(e => e.lifecycle_status === lifecycleFilter || e.winner_tier === lifecycleFilter);
    }
    if (sourceFilter !== 'all') {
      list = list.filter(e => e.source_type === sourceFilter);
    }
    return list;
  }, [bankEntries, search, lifecycleFilter, sourceFilter]);

  const winners   = useMemo(() => bankEntries.filter(e => e.lifecycle_status === 'WINNER').sort((a,b) => b.promotion_score - a.promotion_score), [bankEntries]);
  const harvests  = useMemo(() => bankEntries.filter(e => e.harvest_candidate).sort((a,b) => b.promotion_score - a.promotion_score), [bankEntries]);
  const proposed  = useMemo(() => plans.filter(p => p.status === 'PROPOSED'), [plans]);

  // ── Winner Funnel ───────────────────────────────────────────────────
  const funnel = useMemo(() => {
    const total     = bankEntries.length;
    const relevant  = bankEntries.filter(e => e.intent_score >= 60).length;
    const tested    = bankEntries.filter(e => (e.clicks || 0) >= 5).length;
    const converted = bankEntries.filter(e => (e.orders || 0) >= 1).length;
    const onTarget  = bankEntries.filter(e => e.acos > 0 && e.acos <= (e.target_acos || 15)).length;
    const strong    = stats.strong;
    return [
      { label: 'Descobertos',      value: total },
      { label: 'Relevantes',       value: relevant },
      { label: 'Testados',         value: tested },
      { label: 'Converteram',      value: converted },
      { label: 'Bateram meta ACoS',value: onTarget },
      { label: 'Strong Winners',   value: strong },
    ];
  }, [bankEntries, stats]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 text-cyan animate-spin" />
      </div>
    );
  }

  if (!account) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-slate-400">Nenhuma conta Amazon configurada.</p>
      </div>
    );
  }

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
            <p className="text-[11px] text-slate-500">Motor de aprendizado · {stats.total} termos · {stats.winners} winners</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => runFactory(true)} disabled={running}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-surface-2 border border-surface-3 text-slate-300 hover:text-white rounded-lg transition-colors disabled:opacity-50">
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
            Simular
          </button>
          <button onClick={() => runFactory(false)} disabled={running}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-violet-500/15 border border-violet-500/30 text-violet-400 hover:bg-violet-500/25 rounded-lg transition-colors disabled:opacity-50">
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            Executar Ciclo
          </button>
          <button onClick={loadData} disabled={loading}
            className="p-1.5 rounded-lg bg-surface-2 border border-surface-3 text-slate-400 hover:text-white transition-colors">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Run result banner */}
      {runResult ? (
        <div className={`px-6 py-2 flex items-center gap-3 flex-shrink-0 text-xs border-b ${runResult.ok ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300' : 'bg-red-500/10 border-red-500/20 text-red-300'}`}>
          {runResult.ok ? <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" /> : <XCircle className="w-3.5 h-3.5 flex-shrink-0" />}
          <span>
            {runResult.dry_run ? '[Simulação] ' : ''}
            {runResult.terms_processed} termos processados · {runResult.bank_created} criados · {runResult.bank_updated} atualizados · {runResult.plans_generated} planos gerados · {runResult.duplicates_blocked} duplicatas bloqueadas · {runResult.duration_ms}ms
          </span>
          <button onClick={() => setRunResult(null)} className="ml-auto text-slate-400 hover:text-white">×</button>
        </div>
      ) : null}
      {runError ? (
        <div className="px-6 py-2 flex items-center gap-2 bg-red-500/10 border-b border-red-500/20 text-xs text-red-300 flex-shrink-0">
          <AlertCircle className="w-3.5 h-3.5" /> {runError}
          <button onClick={() => setRunError(null)} className="ml-auto">×</button>
        </div>
      ) : null}

      {/* Tabs */}
      <div className="flex border-b border-surface-2 bg-[#0D0F14] flex-shrink-0">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-5 py-3 text-xs font-semibold border-b-2 transition-colors ${tab === t.key ? 'border-violet-400 text-violet-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
            <t.icon className="w-3.5 h-3.5" />
            {t.label}
            {t.key === 'harvest' && stats.harvest > 0 ? (
              <span className="ml-1 px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 text-[9px] font-bold">{stats.harvest}</span>
            ) : null}
            {t.key === 'plans' && stats.proposed > 0 ? (
              <span className="ml-1 px-1.5 py-0.5 rounded-full bg-violet-500/20 text-violet-400 text-[9px] font-bold">{stats.proposed}</span>
            ) : null}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-6">

        {/* ── VISÃO GERAL ── */}
        {tab === 'overview' ? (
          <div className="space-y-6">
            {/* KPIs */}
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
              <StatCard icon={BookOpen}    label="No Bank"       value={stats.total}      color="text-slate-300" />
              <StatCard icon={TrendingUp}  label="Winners"       value={stats.winners}     color="text-emerald-400" sub={`${stats.strong} strong`} />
              <StatCard icon={Zap}         label="Harvest Ready" value={stats.harvest}     color="text-violet-400" />
              <StatCard icon={Target}      label="Candidatos"    value={stats.candidates}  color="text-cyan" />
              <StatCard icon={Clock}       label="Validando"     value={stats.validating}  color="text-amber-400" />
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard icon={Factory}     label="Planos propostos" value={stats.proposed}   color="text-violet-400" />
              <StatCard icon={Sparkles}    label="Amazon Sugestões" value={stats.amazon_sug} color="text-cyan" />
              <StatCard icon={XCircle}     label="Falharam"         value={stats.failed}     color="text-red-400" />
              <StatCard icon={CheckCircle} label="Ativas no ciclo"  value={plans.filter(p => p.status === 'EXECUTED').length} color="text-emerald-400" />
            </div>

            {/* Winner Funnel */}
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
                      {i < funnel.length - 1 ? (
                        <ChevronRight className="w-3 h-3 text-slate-600 absolute" style={{ right: 0 }} />
                      ) : null}
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
                  if (entries.length === 0) return null;
                  const wins = entries.filter(e => e.lifecycle_status === 'WINNER').length;
                  const pct  = entries.length > 0 ? Math.round((wins / entries.length) * 100) : 0;
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
        ) : null}

        {/* ── WINNERS ── */}
        {tab === 'winners' ? (
          <div className="space-y-2">
            <p className="text-xs text-slate-500 mb-3">{winners.length} keywords com performance comprovada</p>
            {winners.length === 0 ? (
              <div className="text-center py-16 text-slate-500">
                <TrendingUp className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p>Nenhum winner identificado ainda. Execute o ciclo para processar os dados.</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-[#0D0F14] z-10">
                  <tr className="border-b border-surface-2">
                    {['Keyword','ASIN','Fonte','Intent','Promo Score','Pedidos','ACoS','Ação'].map(h => (
                      <th key={h} className="px-4 py-2.5 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {winners.map((e, i) => (
                    <tr key={e.id || i} className="border-b border-surface-2/40 hover:bg-surface-2/30">
                      <td className="px-4 py-2.5">
                        <div>
                          <p className="text-xs font-medium text-white truncate max-w-[200px]">{e.keyword}</p>
                          <p className="text-[10px] text-slate-500">{e.match_type}</p>
                        </div>
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
                      <td className="px-4 py-2.5">
                        <LifecycleBadge status={e.lifecycle_status} winnerTier={e.winner_tier} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : null}

        {/* ── HARVEST READY ── */}
        {tab === 'harvest' ? (
          <div className="space-y-3">
            <p className="text-xs text-slate-500 mb-3">{harvests.length} termos prontos para colheita — aguardando criação de campanha</p>
            {harvests.length === 0 ? (
              <div className="text-center py-16 text-slate-500">
                <Zap className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p>Nenhum termo pronto para harvest. Execute o ciclo para identificar vencedores.</p>
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
                    <span>CPC sustentável R${(e.sustainable_cpc || 0).toFixed(2)}</span>
                  </div>
                </div>
                <div className="flex-shrink-0">
                  <span className={`text-[10px] font-bold px-2 py-1 rounded-lg border ${
                    e.harvest_action === 'SCALE' ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400' :
                    e.harvest_action === 'CREATE_EXACT' ? 'bg-violet-500/15 border-violet-500/30 text-violet-400' :
                    'bg-cyan/15 border-cyan/30 text-cyan'
                  }`}>
                    {e.harvest_action || 'CREATE_EXACT'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {/* ── PLANOS ── */}
        {tab === 'plans' ? (
          <div className="space-y-3">
            <p className="text-xs text-slate-500 mb-3">{plans.length} planos de campanha · {stats.proposed} aguardando aprovação</p>
            {plans.length === 0 ? (
              <div className="text-center py-16 text-slate-500">
                <Factory className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p>Nenhum plano gerado. Execute o ciclo para gerar propostas.</p>
              </div>
            ) : plans.map((p, i) => {
              const statusCfg = PLAN_STATUS_CONFIG[p.status] || PLAN_STATUS_CONFIG.PROPOSED;
              return (
                <div key={p.id || i} className="bg-surface-1 border border-surface-2 rounded-xl p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="text-xs font-bold text-white">{p.target_campaign_name}</span>
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${statusCfg.bg} ${statusCfg.color}`}>
                          {statusCfg.label}
                        </span>
                        <SourceBadge source={p.source_type} />
                      </div>
                      <p className="text-[10px] text-slate-500 mb-2">{p.why_created}</p>
                      <div className="flex items-center gap-4 text-[10px] flex-wrap">
                        <span className="font-mono text-cyan">{p.asin}</span>
                        <span className="text-slate-400">Keyword: <span className="text-white">{p.keyword}</span></span>
                        <span className="text-slate-400">Bid inicial: <span className="text-emerald-400">R${(p.initial_bid || 0).toFixed(2)}</span></span>
                        <span className="text-slate-400">CPC sustentável: <span className="text-white">R${(p.sustainable_cpc || 0).toFixed(2)}</span></span>
                        <span className="text-slate-400">Budget: <span className="text-white">R${p.initial_budget}/dia</span></span>
                        <span className="text-slate-400">Strategy: <span className="text-amber-400">{p.bidding_strategy}</span></span>
                      </div>
                      <p className="text-[10px] text-slate-600 mt-1">✓ {p.success_criteria}</p>
                      <p className="text-[10px] text-slate-600">✗ {p.failure_criteria}</p>
                    </div>
                    {p.status === 'PROPOSED' ? (
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
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}

        {/* ── KEYWORD BANK ── */}
        {tab === 'bank' ? (
          <div className="space-y-3">
            {/* Filtros */}
            <div className="flex items-center gap-3 flex-wrap">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Pesquisar keyword ou ASIN..."
                  className="w-full pl-7 pr-3 py-1.5 bg-surface-2 border border-surface-3 rounded-lg text-xs text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan/50" />
              </div>
              <select value={lifecycleFilter} onChange={e => setLifecycleFilter(e.target.value)}
                className="px-2 py-1.5 bg-surface-2 border border-surface-3 rounded-lg text-xs text-slate-300 focus:outline-none">
                <option value="all">Todos status</option>
                {Object.entries(LIFECYCLE_CONFIG).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
              <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}
                className="px-2 py-1.5 bg-surface-2 border border-surface-3 rounded-lg text-xs text-slate-300 focus:outline-none">
                <option value="all">Todas fontes</option>
                {Object.entries(SOURCE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
              <span className="text-xs text-slate-500">{filteredBank.length} termos</span>
            </div>

            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-[#0D0F14] z-10">
                <tr className="border-b border-surface-2">
                  {['Keyword','ASIN','Fonte','Status','Intent','Promo','Pedidos','ACoS','CPC','Colheita'].map(h => (
                    <th key={h} className="px-3 py-2.5 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredBank.slice(0, 200).map((e, i) => (
                  <tr key={e.id || i} className="border-b border-surface-2/40 hover:bg-surface-2/30">
                    <td className="px-3 py-2 max-w-[180px]">
                      <p className="text-[11px] font-medium text-white truncate">{e.keyword}</p>
                      <p className="text-[9px] text-slate-600">{e.match_type}</p>
                    </td>
                    <td className="px-3 py-2 font-mono text-[10px] text-cyan">{e.asin}</td>
                    <td className="px-3 py-2"><SourceBadge source={e.source_type} /></td>
                    <td className="px-3 py-2"><LifecycleBadge status={e.lifecycle_status} winnerTier={e.winner_tier} /></td>
                    <td className="px-3 py-2"><IntentBar score={e.intent_score || 0} /></td>
                    <td className="px-3 py-2 text-[10px] text-violet-400">{e.promotion_score || 0}</td>
                    <td className="px-3 py-2 text-emerald-400 font-semibold text-[11px]">{e.orders || 0}</td>
                    <td className="px-3 py-2">
                      <span className={`text-[10px] font-semibold ${(e.acos || 0) > (e.target_acos || 15) ? 'text-red-400' : (e.acos || 0) > 0 ? 'text-emerald-400' : 'text-slate-600'}`}>
                        {(e.acos || 0) > 0 ? `${(e.acos || 0).toFixed(1)}%` : '—'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-[10px] text-slate-400">R${(e.cpc || 0).toFixed(2)}</td>
                    <td className="px-3 py-2">
                      {e.harvest_candidate ? (
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400 border border-violet-500/25">
                          {e.harvest_action || 'HARVEST'}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filteredBank.length > 200 ? (
              <p className="text-[10px] text-slate-500 text-center py-2">Mostrando 200 de {filteredBank.length} — use filtros para refinar</p>
            ) : null}
          </div>
        ) : null}

      </div>
    </div>
  );
}