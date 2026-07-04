import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import {
  AlertTriangle, RefreshCw, Loader2, Wrench, CheckCircle,
  XCircle, Zap, Sparkles, Play, ChevronDown, ChevronRight,
  ShieldAlert, Clock, BarChart2
} from 'lucide-react';

const ISSUE_COLORS = {
  red: 'bg-red-500/10 border-red-500/20 text-red-400',
  amber: 'bg-amber-500/10 border-amber-500/20 text-amber-400',
};

function IssueTag({ label, color }) {
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold rounded border ${ISSUE_COLORS[color] || ISSUE_COLORS.amber}`}>
      {label}
    </span>
  );
}

function StatusDot({ ok, loading }) {
  if (loading) return <Loader2 className="w-3.5 h-3.5 text-cyan animate-spin flex-shrink-0" />;
  if (ok === true) return <CheckCircle className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />;
  if (ok === false) return <XCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />;
  return null;
}

function CampaignRow({ campaign, keywords, result, repairing, onRepair }) {
  const [expanded, setExpanded] = useState(false);
  const state = String(campaign.state || campaign.status || '').toLowerCase();
  const isAuto = (campaign.targeting_type || '').toUpperCase() === 'AUTO';
  const kwCount = keywords.filter(k => k.campaign_id === campaign.campaign_id).length;

  const issues = [];
  if (state === 'incomplete') issues.push({ label: 'INCOMPLETA', color: 'red' });
  if (!isAuto && kwCount === 0) issues.push({ label: 'SEM KEYWORDS', color: 'red' });
  if (!campaign.asin) issues.push({ label: 'SEM ASIN', color: 'amber' });

  const isRepairing = repairing === campaign.id;
  const isDone = result?.ok === true;
  const hasFailed = result?.ok === false;

  return (
    <div className={`border rounded-xl overflow-hidden transition-all ${isDone ? 'border-emerald-500/30' : hasFailed ? 'border-red-500/30' : 'border-surface-3'}`}>
      <div
        className="flex items-center gap-3 px-4 py-3 bg-surface-2 cursor-pointer hover:bg-surface-3 transition-colors select-none"
        onClick={() => setExpanded(v => !v)}
      >
        {/* Tipo ícone */}
        <div className="flex-shrink-0">
          {isAuto
            ? <Zap className="w-4 h-4 text-amber-400" />
            : <Sparkles className="w-4 h-4 text-cyan" />}
        </div>

        {/* Nome + ASIN */}
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-white truncate">{campaign.name || campaign.campaign_name}</p>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            {campaign.asin && <span className="text-[10px] font-mono text-cyan">{campaign.asin}</span>}
            <span className="text-[10px] text-slate-500">{isAuto ? 'AUTO' : 'MANUAL'}</span>
            <span className="text-[10px] text-slate-500">R${(campaign.daily_budget || 0).toFixed(0)}/dia</span>
          </div>
        </div>

        {/* Tags de problemas */}
        <div className="flex items-center gap-1.5 flex-wrap flex-shrink-0 hidden sm:flex">
          {issues.map((issue, i) => <IssueTag key={i} {...issue} />)}
        </div>

        {/* Status resultado */}
        <StatusDot ok={isDone ? true : hasFailed ? false : undefined} loading={isRepairing} />

        {/* Botão reparar */}
        <button
          onClick={e => { e.stopPropagation(); onRepair(campaign); }}
          disabled={isRepairing || isDone || !!repairing}
          className={`flex-shrink-0 flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg transition-colors disabled:opacity-40 ${
            isDone
              ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
              : 'bg-cyan/15 border border-cyan/30 text-cyan hover:bg-cyan/25'
          }`}
        >
          {isDone ? <CheckCircle className="w-3 h-3" /> : isRepairing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wrench className="w-3 h-3" />}
          {isDone ? 'Reparada' : isRepairing ? '...' : 'Reparar'}
        </button>

        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />}
      </div>

      {expanded && (
        <div className="px-4 py-3 bg-surface-1 border-t border-surface-3 space-y-2 text-xs">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1">
            <div><span className="text-slate-500">Campaign ID:</span> <span className="font-mono text-slate-300">{campaign.campaign_id || '—'}</span></div>
            <div><span className="text-slate-500">Estado:</span> <span className="text-slate-300">{campaign.state || campaign.status || '—'}</span></div>
            <div><span className="text-slate-500">Tipo:</span> <span className="text-slate-300">{campaign.targeting_type || '—'}</span></div>
            <div><span className="text-slate-500">Keywords:</span> <span className={kwCount === 0 ? 'text-red-400 font-semibold' : 'text-emerald-400'}>{kwCount}</span></div>
          </div>
          {/* Problemas */}
          {issues.length > 0 && (
            <ul className="space-y-0.5 pt-1">
              {issues.map((issue, i) => (
                <li key={i} className="flex items-center gap-1.5 text-[10px] text-slate-400">
                  <XCircle className="w-3 h-3 text-red-400 flex-shrink-0" />
                  {issue.label === 'INCOMPLETA' && 'Campanha INCOMPLETE na Amazon — faltam AdGroups ou ProductAds.'}
                  {issue.label === 'SEM KEYWORDS' && 'Campanha MANUAL sem keywords — não está a segmentar tráfego.'}
                  {issue.label === 'SEM ASIN' && 'Sem ASIN associado — não é possível vincular ao produto.'}
                </li>
              ))}
            </ul>
          )}
          {/* Resultado do reparo */}
          {result && (
            <div className={`mt-2 px-2 py-1.5 rounded-lg border text-[10px] ${result.ok ? 'bg-emerald-500/5 border-emerald-500/20 text-emerald-300' : 'bg-red-500/5 border-red-500/20 text-red-400'}`}>
              {result.ok
                ? `✓ Reparada — ${(result.repaired || []).join(', ') || 'sem alterações necessárias'}`
                : `Erro: ${result.error}`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function IncompleteCampaigns() {
  const [account, setAccount] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [keywords, setKeywords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [repairing, setRepairing] = useState(null); // campaign.id | 'all'
  const [results, setResults] = useState({}); // { [campaign.id]: result }
  const [bulkResult, setBulkResult] = useState(null);
  const [repairProgress, setRepairProgress] = useState({ done: 0, total: 0 });

  const load = async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accounts[0] || null;
      setAccount(acc);
      if (!acc) return;

      const [allCamps, allKws] = await Promise.all([
        base44.entities.Campaign.filter({ amazon_account_id: acc.id }, '-created_date', 500),
        base44.entities.Keyword.filter({ amazon_account_id: acc.id }, null, 2000),
      ]);

      const kwCampaignIds = new Set(allKws.map(k => k.campaign_id));

      const problem = allCamps.filter(c => {
        const state = String(c.state || c.status || '').toLowerCase();
        const isIncomplete = state === 'incomplete';
        const isManualNoKw = (c.targeting_type || '').toUpperCase() === 'MANUAL'
          && !kwCampaignIds.has(c.campaign_id)
          && !['archived'].includes(state)
          && !c.archived;
        return isIncomplete || isManualNoKw;
      });

      setCampaigns(problem);
      setKeywords(allKws);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const repairOne = async (campaign) => {
    if (!account || repairing) return;
    setRepairing(campaign.id);
    try {
      const res = await base44.functions.invoke('repairIncompleteAutoCampaignById', {
        amazon_account_id: account.id,
        campaign_id: campaign.campaign_id,
      });
      const data = res?.data || {};
      setResults(prev => ({ ...prev, [campaign.id]: data }));
      if (data.ok) await load();
    } catch (e) {
      setResults(prev => ({ ...prev, [campaign.id]: { ok: false, error: e.message } }));
    } finally {
      setRepairing(null);
    }
  };

  // Reparar todas uma por uma com feedback de progresso
  const repairAll = async () => {
    if (!account || repairing || campaigns.length === 0) return;
    setBulkResult(null);
    setResults({});
    setRepairProgress({ done: 0, total: campaigns.length });
    setRepairing('all');

    let succeeded = 0;
    let failed = 0;
    const newResults = {};

    for (let i = 0; i < campaigns.length; i++) {
      const c = campaigns[i];
      setRepairProgress({ done: i, total: campaigns.length });
      try {
        const res = await base44.functions.invoke('repairIncompleteAutoCampaignById', {
          amazon_account_id: account.id,
          campaign_id: c.campaign_id,
        });
        const data = res?.data || {};
        newResults[c.id] = data;
        if (data.ok) succeeded++; else failed++;
      } catch (e) {
        newResults[c.id] = { ok: false, error: e.message };
        failed++;
      }
      setResults({ ...newResults });
    }

    setRepairProgress({ done: campaigns.length, total: campaigns.length });
    setBulkResult({ succeeded, failed, total: campaigns.length });
    setRepairing(null);
    await load();
  };

  const incomplete = campaigns.filter(c => String(c.state || c.status || '').toLowerCase() === 'incomplete');
  const missingKw = campaigns.filter(c => String(c.state || c.status || '').toLowerCase() !== 'incomplete');
  const repairedCount = Object.values(results).filter((r) => r?.ok).length;
  const isRunningAll = repairing === 'all';

  return (
    <div className="min-h-full p-6 space-y-6 max-w-4xl mx-auto">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-red-500/15 border border-red-500/20 flex items-center justify-center">
            <ShieldAlert className="w-5 h-5 text-red-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Campanhas Incompletas</h1>
            <p className="text-xs text-slate-400">
              {loading ? 'A carregar...' : campaigns.length === 0 ? 'Nenhuma campanha com problemas' : `${campaigns.length} campanha${campaigns.length !== 1 ? 's' : ''} precisam de atenção`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={load}
            disabled={loading || isRunningAll}
            className="p-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors disabled:opacity-50"
            title="Recarregar"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>

          {campaigns.length > 0 && (
            <button
              onClick={repairAll}
              disabled={!!repairing || campaigns.length === 0}
              className="flex items-center gap-2 px-4 py-2.5 text-sm font-bold bg-cyan hover:bg-cyan/90 text-white rounded-xl transition-colors disabled:opacity-50 shadow-lg shadow-cyan/20"
            >
              {isRunningAll
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <Play className="w-4 h-4" />}
              {isRunningAll
                ? `Reparando ${repairProgress.done}/${repairProgress.total}...`
                : `Ativar e reparar todas (${campaigns.length})`}
            </button>
          )}
        </div>
      </div>

      {/* ── KPI Strip ──────────────────────────────────────────────────── */}
      {!loading && (
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: 'Incompletas', value: incomplete.length, color: 'text-red-400', Icon: XCircle },
            { label: 'Sem Keywords', value: missingKw.length, color: 'text-amber-400', Icon: AlertTriangle },
            { label: 'Reparadas', value: repairedCount, color: 'text-emerald-400', Icon: CheckCircle },
          ].map(({ label, value, color, Icon }) => (
            <div key={label} className="bg-surface-1 border border-surface-2 rounded-xl p-4 flex items-center gap-3">
              <Icon className={`w-5 h-5 ${color} flex-shrink-0`} />
              <div>
                <p className={`text-xl font-bold ${color}`}>{value}</p>
                <p className="text-xs text-slate-500">{label}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Resultado do reparo em massa ───────────────────────────────── */}
      {bulkResult && (
        <div className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-sm font-semibold ${bulkResult.failed === 0 ? 'bg-emerald-500/8 border-emerald-500/20 text-emerald-300' : 'bg-amber-500/8 border-amber-500/20 text-amber-300'}`}>
          {bulkResult.failed === 0
            ? <CheckCircle className="w-4 h-4 text-emerald-400" />
            : <AlertTriangle className="w-4 h-4 text-amber-400" />}
          <span>
            {bulkResult.succeeded} de {bulkResult.total} campanhas reparadas com sucesso
            {bulkResult.failed > 0 && ` · ${bulkResult.failed} falharam (token Ads pode estar inválido)`}
          </span>
        </div>
      )}

      {/* ── Barra de progresso ─────────────────────────────────────────── */}
      {isRunningAll && repairProgress.total > 0 && (
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs text-slate-400">
            <span>A reparar campanhas...</span>
            <span>{repairProgress.done}/{repairProgress.total}</span>
          </div>
          <div className="h-1.5 bg-surface-3 rounded-full overflow-hidden">
            <div
              className="h-full bg-cyan rounded-full transition-all duration-300"
              style={{ width: `${repairProgress.total > 0 ? (repairProgress.done / repairProgress.total) * 100 : 0}%` }}
            />
          </div>
        </div>
      )}

      {/* ── Conteúdo principal ─────────────────────────────────────────── */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-24 gap-3">
          <Loader2 className="w-8 h-8 text-cyan animate-spin" />
          <p className="text-sm text-slate-500">A carregar campanhas...</p>
        </div>
      ) : campaigns.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
          <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
            <CheckCircle className="w-8 h-8 text-emerald-400" />
          </div>
          <p className="text-base font-semibold text-emerald-300">Tudo em ordem!</p>
          <p className="text-sm text-slate-500">Nenhuma campanha incompleta ou sem keywords encontrada.</p>
        </div>
      ) : (
        <div className="space-y-6">

          {/* Incompletas na Amazon */}
          {incomplete.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-red-400" />
                <h2 className="text-xs font-bold text-red-400 uppercase tracking-wider">
                  Incompletas na Amazon ({incomplete.length})
                </h2>
                <span className="text-[10px] text-slate-500">— faltam AdGroups ou ProductAds</span>
              </div>
              <div className="space-y-2">
                {incomplete.map(c => (
                  <CampaignRow
                    key={c.id}
                    campaign={c}
                    keywords={keywords}
                    result={results[c.id]}
                    repairing={repairing}
                    onRepair={repairOne}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Manuais sem Keywords */}
          {missingKw.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-amber-400" />
                <h2 className="text-xs font-bold text-amber-400 uppercase tracking-wider">
                  Manuais sem Keywords ({missingKw.length})
                </h2>
                <span className="text-[10px] text-slate-500">— ativas mas sem segmentação</span>
              </div>
              <div className="space-y-2">
                {missingKw.map(c => (
                  <CampaignRow
                    key={c.id}
                    campaign={c}
                    keywords={keywords}
                    result={results[c.id]}
                    repairing={repairing}
                    onRepair={repairOne}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {/* ── Nota de token ──────────────────────────────────────────────── */}
      {!loading && campaigns.length > 0 && (
        <div className="flex items-start gap-2.5 px-4 py-3 bg-surface-1 border border-amber-500/20 rounded-xl">
          <Clock className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-slate-400">
            <span className="text-amber-300 font-semibold">Atenção:</span> O reparo usa a Amazon Ads API.
            Se ocorrerem erros 403, o token Ads pode estar expirado — vá a{' '}
            <a href="/amazon-oauth-setup" className="text-cyan underline">Integrações → Amazon Ads</a>{' '}
            para reautorizar.
          </p>
        </div>
      )}
    </div>
  );
}