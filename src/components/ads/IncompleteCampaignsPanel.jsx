import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import {
  AlertTriangle, RefreshCw, Loader2, Wrench, CheckCircle,
  XCircle, ChevronDown, ChevronRight, Package, Zap, Sparkles
} from 'lucide-react';

function IssueTag({ label, color }) {
  const colors = {
    red: 'bg-red-500/10 border-red-500/20 text-red-400',
    amber: 'bg-amber-500/10 border-amber-500/20 text-amber-400',
    slate: 'bg-slate-500/10 border-slate-500/20 text-slate-400',
  };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold rounded border ${colors[color] || colors.slate}`}>
      {label}
    </span>
  );
}

function CampaignIssueRow({ campaign, keywords, onRepair, repairing }) {
  const [expanded, setExpanded] = useState(false);
  const kwCount = keywords.filter(k => k.campaign_id === campaign.campaign_id).length;
  const isManual = (campaign.targeting_type || '').toUpperCase() === 'MANUAL';
  const isAuto = (campaign.targeting_type || '').toUpperCase() === 'AUTO';

  const issues = [];
  if (String(campaign.state || campaign.status || '').toLowerCase() === 'incomplete') {
    issues.push({ label: 'INCOMPLETA', color: 'red' });
  }
  if (isManual && kwCount === 0) issues.push({ label: 'SEM KEYWORDS', color: 'red' });
  if (isManual && kwCount > 0 && kwCount < 2) issues.push({ label: `${kwCount} keyword`, color: 'amber' });
  if (!campaign.asin) issues.push({ label: 'SEM ASIN', color: 'amber' });
  if (campaign.api_missing) issues.push({ label: 'AUSENTE NA API', color: 'red' });

  return (
    <div className="border border-surface-3 rounded-xl overflow-hidden">
      <div
        className="flex items-center gap-3 px-4 py-3 bg-surface-2 cursor-pointer hover:bg-surface-3 transition-colors"
        onClick={() => setExpanded(v => !v)}
      >
        <div className="flex-shrink-0">
          {isAuto
            ? <Zap className="w-4 h-4 text-amber-400" />
            : <Sparkles className="w-4 h-4 text-cyan" />}
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-white truncate">{campaign.name || campaign.campaign_name}</p>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            {campaign.asin && <span className="text-[10px] font-mono text-cyan">{campaign.asin}</span>}
            <span className="text-[10px] text-slate-500">{isAuto ? 'AUTO' : 'MANUAL'}</span>
            <span className="text-[10px] text-slate-500">R${(campaign.daily_budget || 0).toFixed(0)}/dia</span>
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap flex-shrink-0">
          {issues.map((issue, i) => <IssueTag key={i} {...issue} />)}
        </div>

        <button
          onClick={e => { e.stopPropagation(); onRepair(campaign); }}
          disabled={repairing === campaign.id}
          className="flex-shrink-0 flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold bg-cyan/15 border border-cyan/30 text-cyan hover:bg-cyan/25 rounded-lg transition-colors disabled:opacity-50"
        >
          {repairing === campaign.id
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : <Wrench className="w-3 h-3" />}
          Reparar
        </button>

        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />}
      </div>

      {expanded && (
        <div className="px-4 py-3 bg-surface-1 border-t border-surface-3 space-y-2 text-xs">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1">
            <div><span className="text-slate-500">Campaign ID:</span> <span className="font-mono text-slate-300">{campaign.campaign_id || '—'}</span></div>
            <div><span className="text-slate-500">Estado Amazon:</span> <span className="text-slate-300">{campaign.state || campaign.status || '—'}</span></div>
            <div><span className="text-slate-500">Tipo:</span> <span className="text-slate-300">{campaign.targeting_type || '—'}</span></div>
            <div><span className="text-slate-500">Keywords no banco:</span> <span className={kwCount === 0 ? 'text-red-400 font-semibold' : 'text-emerald-400'}>{kwCount}</span></div>
            <div><span className="text-slate-500">Criado pelo app:</span> <span className={campaign.created_by_app ? 'text-emerald-400' : 'text-slate-500'}>{campaign.created_by_app ? 'Sim' : 'Não'}</span></div>
            <div><span className="text-slate-500">Reconciliação:</span> <span className="text-slate-300">{campaign.reconciliation_status || '—'}</span></div>
          </div>
          {campaign.reconciliation_notes && (
            <p className="text-[10px] text-amber-300 bg-amber-500/5 border border-amber-500/15 rounded px-2 py-1">{campaign.reconciliation_notes}</p>
          )}
          <div className="pt-1">
            <p className="text-[10px] font-semibold text-slate-400 mb-1">Diagnóstico dos problemas:</p>
            <ul className="space-y-0.5">
              {issues.map((issue, i) => (
                <li key={i} className="flex items-center gap-1.5 text-[10px] text-slate-400">
                  <XCircle className="w-3 h-3 text-red-400 flex-shrink-0" />
                  {issue.label === 'INCOMPLETA' && 'Campanha marcada como INCOMPLETE na Amazon — faltam AdGroups ou ProductAds.'}
                  {issue.label === 'SEM KEYWORDS' && 'Campanha MANUAL sem nenhuma keyword no banco — não está a segmentar.'}
                  {issue.label.startsWith('1 keyword') && 'Apenas 1 keyword — recomendado pelo menos 3–5 para otimização.'}
                  {issue.label === 'SEM ASIN' && 'Campanha sem ASIN associado — não é possível vincular ao produto.'}
                  {issue.label === 'AUSENTE NA API' && 'Campanha não encontrada na Amazon Ads API — pode ter sido removida externamente.'}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

export default function IncompleteCampaignsPanel({ account, onDone }) {
  const [campaigns, setCampaigns] = useState([]);
  const [keywords, setKeywords] = useState([]);
  const [loading, setLoading] = useState(false);
  const [repairing, setRepairing] = useState(null);
  const [repairResults, setRepairResults] = useState({});

  const load = async () => {
    if (!account) return;
    setLoading(true);
    try {
      const [allCamps, allKws] = await Promise.all([
        base44.entities.Campaign.filter({ amazon_account_id: account.id }, '-created_date', 500),
        base44.entities.Keyword.filter({ amazon_account_id: account.id }, null, 2000),
      ]);

      const kwCampaignIds = new Set(allKws.map(k => k.campaign_id));

      const problemCampaigns = allCamps.filter(c => {
        const state = String(c.state || c.status || '').toLowerCase();
        const isIncomplete = state === 'incomplete';
        const isManualNoKw = (c.targeting_type || '').toUpperCase() === 'MANUAL'
          && !kwCampaignIds.has(c.campaign_id)
          && !['archived', 'incomplete'].includes(state)
          && !c.archived;
        return isIncomplete || isManualNoKw;
      });

      setCampaigns(problemCampaigns);
      setKeywords(allKws);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [account?.id]);

  const repairOne = async (campaign) => {
    setRepairing(campaign.id);
    try {
      const res = await base44.functions.invoke('repairIncompleteAutoCampaignById', {
        amazon_account_id: account.id,
        campaign_id: campaign.campaign_id,
      });
      setRepairResults(prev => ({ ...prev, [campaign.id]: res?.data }));
      if (res?.data?.ok) {
        await load();
        onDone?.();
      }
    } catch (e) {
      setRepairResults(prev => ({ ...prev, [campaign.id]: { ok: false, error: e.message } }));
    } finally {
      setRepairing(null);
    }
  };

  const repairAll = async () => {
    if (!account || campaigns.length === 0) return;
    setRepairing('all');
    try {
      const res = await base44.functions.invoke('repairIncompleteAutoCampaigns', {
        amazon_account_id: account.id,
      });
      setRepairResults({ all: res?.data });
      await load();
      onDone?.();
    } catch (e) {
      setRepairResults({ all: { ok: false, error: e.message } });
    } finally {
      setRepairing(null);
    }
  };

  const incomplete = campaigns.filter(c => String(c.state || c.status || '').toLowerCase() === 'incomplete');
  const missingKw = campaigns.filter(c => String(c.state || c.status || '').toLowerCase() !== 'incomplete');

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-red-500/15 border border-red-500/20 flex items-center justify-center">
            <AlertTriangle className="w-5 h-5 text-red-400" />
          </div>
          <div>
            <h2 className="text-base font-bold text-white">Campanhas com Problemas</h2>
            <p className="text-xs text-slate-400">
              {campaigns.length === 0 ? 'Tudo OK — nenhuma campanha com problemas' : `${campaigns.length} campanha${campaigns.length > 1 ? 's' : ''} precisam de atenção`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {campaigns.length > 0 && (
            <button
              onClick={repairAll}
              disabled={!!repairing}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-cyan/15 border border-cyan/30 text-cyan hover:bg-cyan/25 rounded-lg transition-colors disabled:opacity-50"
            >
              {repairing === 'all' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wrench className="w-3.5 h-3.5" />}
              Reparar todas ({campaigns.length})
            </button>
          )}
          <button
            onClick={load}
            disabled={loading}
            className="p-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors disabled:opacity-60"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Resultado global de reparo */}
      {repairResults.all && (
        <div className={`px-4 py-3 rounded-xl border text-sm ${repairResults.all.ok ? 'bg-emerald-400/5 border-emerald-400/20 text-emerald-300' : 'bg-red-400/5 border-red-400/20 text-red-400'}`}>
          {repairResults.all.ok
            ? `✓ Reparo concluído — ${repairResults.all.repaired || 0} campanhas reparadas`
            : `Erro: ${repairResults.all.error}`}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 text-cyan animate-spin" />
        </div>
      ) : campaigns.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <CheckCircle className="w-12 h-12 text-emerald-400/40" />
          <p className="text-sm font-semibold text-emerald-300">Tudo em ordem!</p>
          <p className="text-xs text-slate-500">Nenhuma campanha incompleta ou sem keywords encontrada.</p>
        </div>
      ) : (
        <div className="space-y-5">
          {/* Incompletas */}
          {incomplete.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-red-400" />
                <p className="text-xs font-bold text-red-400 uppercase tracking-wider">Incompletas na Amazon ({incomplete.length})</p>
                <span className="text-[10px] text-slate-500">— faltam AdGroups ou ProductAds</span>
              </div>
              {incomplete.map(c => (
                <div key={c.id}>
                  <CampaignIssueRow
                    campaign={c}
                    keywords={keywords}
                    onRepair={repairOne}
                    repairing={repairing}
                  />
                  {repairResults[c.id] && (
                    <p className={`text-[10px] mt-1 px-2 ${repairResults[c.id].ok ? 'text-emerald-400' : 'text-red-400'}`}>
                      {repairResults[c.id].ok ? '✓ Reparada com sucesso' : `Erro: ${repairResults[c.id].error}`}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Sem keywords */}
          {missingKw.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-amber-400" />
                <p className="text-xs font-bold text-amber-400 uppercase tracking-wider">Manuais sem Keywords ({missingKw.length})</p>
                <span className="text-[10px] text-slate-500">— ativas mas sem segmentação</span>
              </div>
              {missingKw.map(c => (
                <div key={c.id}>
                  <CampaignIssueRow
                    campaign={c}
                    keywords={keywords}
                    onRepair={repairOne}
                    repairing={repairing}
                  />
                  {repairResults[c.id] && (
                    <p className={`text-[10px] mt-1 px-2 ${repairResults[c.id].ok ? 'text-emerald-400' : 'text-red-400'}`}>
                      {repairResults[c.id].ok ? '✓ Reparada com sucesso' : `Erro: ${repairResults[c.id].error}`}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}