import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Loader2, History, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';

const CHANGE_TYPE_LABELS = {
  CAMPAIGN_STATUS: '⚡ Status',
  CAMPAIGN_BUDGET: '💰 Orçamento',
  BUDGET_RULE: '📋 Regra de Budget',
  BIDDING_STRATEGY: '🎯 Estratégia',
  BASE_BID: '💲 Bid Base',
  PLACEMENT_ADJUSTMENT: '📍 Placement',
  SCHEDULE_RULE: '🕐 Agendamento',
  KEYWORD_CREATED: '🔑 Keyword Criada',
  KEYWORD_PAUSED: '⏸ Keyword Pausada',
  KEYWORD_ENABLED: '▶ Keyword Ativada',
  NEGATIVE_CREATED: '🚫 Negativa Criada',
  TARGET_CREATED: '🎯 Target Criado',
  TARGET_PAUSED: '⏸ Target Pausado',
  PRODUCT_AD_STATUS: '📦 Ad Status',
  AUTOPILOT_DECISION: '🤖 Autopilot',
  ROLLBACK: '↩ Rollback',
  SYNC_CORRECTION: '🔄 Correção Sync',
};

const SOURCE_COLORS = {
  AMAZON_CONSOLE: 'text-amber-400 bg-amber-400/10',
  USER: 'text-cyan bg-cyan/10',
  AUTOPILOT: 'text-purple-400 bg-purple-400/10',
  SCHEDULE_RULE: 'text-blue-400 bg-blue-400/10',
  PERFORMANCE_RULE: 'text-green-400 bg-green-400/10',
  SYNC: 'text-slate-400 bg-slate-400/10',
  API: 'text-slate-400 bg-slate-400/10',
  ROLLBACK: 'text-orange-400 bg-orange-400/10',
};

const OBJECTIVE_LABELS = {
  DISCOVERY: '🔍 Discovery',
  LAUNCH: '🚀 Launch',
  PROFITABILITY: '💹 Rentabilidade',
  GROWTH: '📈 Crescimento',
  ROAS_TARGET: '🎯 ROAS Target',
  ACOS_TARGET: '📊 ACoS Target',
  INVENTORY_CLEARANCE: '📦 Liquidação',
  BRAND_DEFENSE: '🛡 Defesa',
  BUDGET_CONTROL: '🔒 Controle',
};

function HistoryRow({ entry, sym }) {
  const [expanded, setExpanded] = useState(false);

  const metricsBefore = (() => { try { return JSON.parse(entry.metrics_before || '{}'); } catch { return {}; } })();
  const metricsAfter  = (() => { try { return JSON.parse(entry.metrics_after  || '{}'); } catch { return {}; } })();

  return (
    <>
      <tr className="border-b border-surface-2/40 hover:bg-surface-2/50 transition-colors">
        <td className="px-4 py-3 text-xs text-slate-400 whitespace-nowrap">
          {entry.changed_at ? new Date(entry.changed_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
        </td>
        <td className="px-3 py-3 text-xs text-slate-300 whitespace-nowrap">
          {CHANGE_TYPE_LABELS[entry.change_type] || entry.change_type}
        </td>
        <td className="px-3 py-3 text-xs text-slate-400 max-w-[130px] truncate">
          {entry.entity_type} · {entry.field_name || '—'}
        </td>
        <td className="px-3 py-3 font-mono text-xs whitespace-nowrap">
          <span className="text-slate-400">{entry.old_value ?? '—'}</span>
          <span className="text-slate-600 mx-1">→</span>
          <span className="text-white font-semibold">{entry.new_value ?? '—'}</span>
        </td>
        <td className="px-3 py-3">
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${SOURCE_COLORS[entry.source] || 'text-slate-500 bg-slate-500/10'}`}>
            {entry.source}
          </span>
        </td>
        <td className="px-3 py-3 text-xs text-slate-500 max-w-[160px] truncate" title={entry.reason}>
          {entry.reason?.split('\n')[0] || '—'}
        </td>
        <td className="px-3 py-3">
          {entry.status && <StatusBadge status={entry.status === 'executed' ? 'executed' : entry.status === 'pending' ? 'pending' : entry.status === 'failed' ? 'failed' : 'pending'} size="xs" />}
        </td>
        <td className="px-3 py-3 text-xs text-slate-500">{entry.changed_by || '—'}</td>
        <td className="px-3 py-3">
          <button onClick={() => setExpanded(v => !v)} className="text-slate-500 hover:text-slate-300">
            {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-surface-2/40 bg-surface-2/20">
          <td colSpan={9} className="px-8 py-4 space-y-3">
            {entry.reason && (
              <div className="p-3 bg-surface-1 rounded-lg border border-surface-2">
                <p className="text-xs font-semibold text-cyan mb-1.5">Justificativa Autopilot</p>
                <pre className="text-xs text-slate-300 whitespace-pre-wrap font-sans">{entry.reason}</pre>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              {Object.keys(metricsBefore).length > 0 && (
                <div className="p-2.5 bg-surface-1 rounded-lg border border-surface-2">
                  <p className="text-[10px] font-semibold text-slate-500 mb-2">Métricas Antes</p>
                  {Object.entries(metricsBefore).map(([k, v]) => (
                    <div key={k} className="flex justify-between text-xs py-0.5">
                      <span className="text-slate-500">{k}</span>
                      <span className="text-slate-300">{v}</span>
                    </div>
                  ))}
                </div>
              )}
              {Object.keys(metricsAfter).length > 0 && (
                <div className="p-2.5 bg-surface-1 rounded-lg border border-surface-2">
                  <p className="text-[10px] font-semibold text-slate-500 mb-2">Métricas Depois</p>
                  {Object.entries(metricsAfter).map(([k, v]) => (
                    <div key={k} className="flex justify-between text-xs py-0.5">
                      <span className="text-slate-500">{k}</span>
                      <span className="text-slate-300">{v}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 text-xs">
              {entry.amazon_request_id && (
                <div><span className="text-slate-500">Request ID: </span><span className="font-mono text-slate-300">{entry.amazon_request_id}</span></div>
              )}
              {entry.decision_id && (
                <div><span className="text-slate-500">Decision ID: </span><span className="font-mono text-slate-300">{entry.decision_id}</span></div>
              )}
              {entry.evaluation_due_at && (
                <div><span className="text-slate-500">Avaliação: </span><span className="text-slate-300">{new Date(entry.evaluation_due_at).toLocaleDateString('pt-BR')}</span></div>
              )}
              {entry.campaign_objective && (
                <div><span className="text-slate-500">Objetivo: </span><span className="text-slate-300">{OBJECTIVE_LABELS[entry.campaign_objective] || entry.campaign_objective}</span></div>
              )}
            </div>
            {entry.amazon_response && (
              <details>
                <summary className="text-[10px] text-slate-500 cursor-pointer">Ver resposta Amazon</summary>
                <pre className="mt-1 text-[10px] text-slate-600 font-mono overflow-auto max-h-24">{entry.amazon_response}</pre>
              </details>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export default function CampaignHistoryTab({ campaign, account }) {
  const [history, setHistory] = useState([]);
  const [decisions, setDecisions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeResult, setAnalyzeResult] = useState(null);

  const sym = account?.currency_symbol || 'R$';

  useEffect(() => {
    if (!campaign || !account) return;
    load();
  }, [campaign?.id]);

  const load = async () => {
    setLoading(true);
    const [hist, decs] = await Promise.all([
      base44.entities.CampaignChangeHistory.filter({
        amazon_account_id: account.id,
        campaign_id: campaign.id,
      }, '-changed_at', 200),
      base44.entities.OptimizationDecision.filter({
        amazon_account_id: account.id,
        campaign_id: campaign.campaign_id,
      }, '-created_at', 50),
    ]);
    setHistory(hist);
    setDecisions(decs);
    setLoading(false);
  };

  const runAnalysis = async () => {
    setAnalyzing(true);
    setAnalyzeResult(null);
    try {
      const res = await base44.functions.invoke('analyzeCampaignStrategy', {
        amazon_account_id: account.id,
        campaign_id: campaign.campaign_id,
      });
      const r = res.data?.results?.[0];
      if (r) setAnalyzeResult(r);
      await load();
    } catch (e) {
      setAnalyzeResult({ error: e.message });
    } finally {
      setAnalyzing(false);
    }
  };

  const filtered = history.filter(h => {
    if (typeFilter !== 'all' && h.change_type !== typeFilter) return false;
    if (sourceFilter !== 'all' && h.source !== sourceFilter) return false;
    return true;
  });

  const types   = ['all', ...new Set(history.map(h => h.change_type).filter(Boolean))];
  const sources = ['all', ...new Set(history.map(h => h.source).filter(Boolean))];

  return (
    <div className="p-5 space-y-4">
      {/* Cabeçalho da campanha */}
      <div className="bg-surface-2 rounded-xl p-4 grid grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
        <div><p className="text-slate-500 mb-0.5">Campaign ID</p><p className="font-mono text-cyan">{campaign.campaign_id}</p></div>
        <div><p className="text-slate-500 mb-0.5">Tipo</p><p className="text-white">{campaign.campaign_type} · {campaign.targeting_type}</p></div>
        <div><p className="text-slate-500 mb-0.5">Orçamento Atual</p><p className="text-white font-semibold">{sym}{(campaign.daily_budget||0).toFixed(2)}/dia</p></div>
        <div><p className="text-slate-500 mb-0.5">Estratégia</p><p className="text-white">{campaign.bidding_strategy || 'dynamicDownOnly'}</p></div>
        <div><p className="text-slate-500 mb-0.5">Início</p><p className="text-white">{campaign.start_date || '—'}</p></div>
        <div><p className="text-slate-500 mb-0.5">Status</p><StatusBadge status={campaign.state || campaign.status} size="xs" /></div>
        <div><p className="text-slate-500 mb-0.5">Top da Pesquisa</p><p className="text-white">{campaign.top_of_search_adjustment || 0}%</p></div>
        <div><p className="text-slate-500 mb-0.5">Último Sync</p><p className="text-slate-400">{campaign.last_sync_at ? new Date(campaign.last_sync_at).toLocaleDateString('pt-BR') : '—'}</p></div>
      </div>

      {/* Motor de Análise */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <button onClick={runAnalysis} disabled={analyzing}
            className="flex items-center gap-2 px-3 py-2 bg-cyan/10 border border-cyan/20 text-cyan hover:bg-cyan/20 text-xs font-semibold rounded-lg disabled:opacity-50 transition-colors">
            {analyzing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <History className="w-3.5 h-3.5" />}
            {analyzing ? 'Analisando...' : 'Analisar Estratégia'}
          </button>
          <span className="text-xs text-slate-500">{history.length} entradas no histórico</span>
        </div>
      </div>

      {/* Resultado da análise */}
      {analyzeResult && !analyzeResult.error && (
        <div className={`p-4 rounded-xl border text-xs space-y-2 ${
          analyzeResult.outcome === 'EXECUTE_NOW' ? 'bg-emerald-400/5 border-emerald-400/20' :
          analyzeResult.outcome === 'BLOCK' ? 'bg-red-400/5 border-red-400/20' :
          analyzeResult.outcome === 'WAIT_FOR_DATA' ? 'bg-slate-400/5 border-slate-400/20' :
          'bg-amber-400/5 border-amber-400/20'
        }`}>
          <div className="flex items-center gap-3 flex-wrap">
            <span className={`font-bold text-sm ${
              analyzeResult.outcome === 'EXECUTE_NOW' ? 'text-emerald-400' :
              analyzeResult.outcome === 'BLOCK' ? 'text-red-400' :
              analyzeResult.outcome === 'WAIT_FOR_DATA' ? 'text-slate-400' :
              'text-amber-400'
            }`}>{analyzeResult.outcome}</span>
            <span className="text-slate-400">Objetivo: {OBJECTIVE_LABELS[analyzeResult.objective] || analyzeResult.objective}</span>
            <span className="text-slate-400">Maturidade: {analyzeResult.maturity}</span>
            {analyzeResult.is_low_budget && (
              <span className="px-2 py-0.5 rounded bg-amber-400/10 text-amber-400 font-medium">LOW_BUDGET_LEARNING</span>
            )}
            {analyzeResult.channel_data_status?.status === 'PARTIAL' && (
              <span className="px-2 py-0.5 rounded bg-red-400/10 text-red-400 font-medium">PARTIAL DATA ({analyzeResult.channel_data_status.hoursOld}h)</span>
            )}
          </div>
          <pre className="text-slate-300 whitespace-pre-wrap font-sans leading-relaxed">{analyzeResult.rationale}</pre>
          {analyzeResult.max_bid_calc && (
            <div className="flex gap-4 pt-1 text-slate-500">
              <span>Bid pós-placement: <span className="text-white font-mono">{sym}{analyzeResult.max_bid_calc.after_placement}</span></span>
              <span>Bid máx. possível: <span className="text-red-400 font-mono">{sym}{analyzeResult.max_bid_calc.max_possible}</span></span>
            </div>
          )}
          {analyzeResult.estimated_clicks_per_day && (
            <p className="text-slate-500">Capacidade estimada: ~{analyzeResult.estimated_clicks_per_day} cliques/dia com orçamento atual</p>
          )}
        </div>
      )}
      {analyzeResult?.error && (
        <p className="text-xs text-red-400">Erro na análise: {analyzeResult.error}</p>
      )}

      {/* Filtros */}
      <div className="flex flex-wrap gap-2 text-xs">
        <div className="flex gap-1">
          {types.slice(0, 6).map(t => (
            <button key={t} onClick={() => setTypeFilter(t)}
              className={`px-2.5 py-1 rounded-lg transition-colors ${typeFilter === t ? 'bg-cyan/20 text-cyan' : 'bg-surface-2 text-slate-500 hover:text-slate-300'}`}>
              {t === 'all' ? 'Todos' : (CHANGE_TYPE_LABELS[t] || t)}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {sources.map(s => (
            <button key={s} onClick={() => setSourceFilter(s)}
              className={`px-2.5 py-1 rounded-lg transition-colors ${sourceFilter === s ? 'bg-cyan/20 text-cyan' : 'bg-surface-2 text-slate-500 hover:text-slate-300'}`}>
              {s === 'all' ? 'Todas origens' : s}
            </button>
          ))}
        </div>
      </div>

      {/* Decisões do Autopilot para esta campanha */}
      {decisions.length > 0 && (
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-3">
          <p className="text-xs font-semibold text-slate-400 mb-2">🤖 Decisões Autopilot ({decisions.length})</p>
          <div className="space-y-1.5">
            {decisions.slice(0, 5).map(d => (
              <div key={d.id} className="flex items-center justify-between text-xs p-2 bg-surface-2 rounded-lg">
                <div>
                  <span className="text-slate-300 font-medium">{d.action}</span>
                  {d.keyword_text && <span className="text-slate-500 ml-2">· {d.keyword_text}</span>}
                </div>
                <div className="flex items-center gap-2">
                  {d.value_before != null && <span className="font-mono text-slate-400">{sym}{(d.value_before||0).toFixed(2)} → {sym}{(d.value_after||0).toFixed(2)}</span>}
                  <StatusBadge status={d.status} size="xs" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tabela de histórico */}
      {loading ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 gap-2">
          <History className="w-8 h-8 text-slate-600" />
          <p className="text-sm text-slate-500">Nenhuma alteração registrada{typeFilter !== 'all' ? ' para este filtro' : ' ainda'}.</p>
          <p className="text-xs text-slate-600">Alterações do Autopilot e mudanças detectadas pelo sync aparecerão aqui.</p>
        </div>
      ) : (
        <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-2 bg-surface-2/50">
                  {['Data/Hora', 'Tipo', 'Entidade/Campo', 'De → Para', 'Origem', 'Motivo', 'Status', 'Por', ''].map(h => (
                    <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(entry => (
                  <HistoryRow key={entry.id} entry={entry} sym={sym} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}