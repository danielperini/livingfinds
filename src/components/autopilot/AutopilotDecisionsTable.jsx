import { useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { CheckCircle, XCircle, Loader2, TrendingUp, TrendingDown, ChevronDown, ChevronUp, Play, AlertCircle } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';

const DECISION_LABELS = {
  bid_change: '💰 Ajuste de Bid', budget_change: '📊 Ajuste de Orçamento', pause: '⏸️ Pausar',
  enable: '▶️ Ativar', negative_keyword: '🚫 Negativar', create_keyword: '➕ Criar Keyword',
  harvest_search_term: '🌱 Colher Termo', dayparting_rule: '🕐 Horário',
  placement_change: '📍 Placement', create_campaign: '📣 Criar Campanha',
};
const ACTION_LABELS = {
  reduce_bid: '↓ Reduzir Bid', increase_bid: '↑ Aumentar Bid', pause_campaign: '⏸ Pausar Campanha',
  enable_campaign: '▶ Ativar Campanha', negative_exact: '🚫 Negativar Exato', create_keyword: '➕ Keyword Exact',
  update_bid: '💰 Atualizar Bid', update_budget: '📊 Atualizar Budget',
};
const RISK_COLORS = {
  very_low: 'text-emerald-300 bg-emerald-400/10 border-emerald-400/20',
  low: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
  medium: 'text-amber-400 bg-amber-400/10 border-amber-400/20',
  high: 'text-red-400 bg-red-400/10 border-red-400/20',
  very_high: 'text-red-600 bg-red-500/10 border-red-500/20',
};
const RISK_LABELS = { very_low: 'Muito Baixo', low: 'Baixo', medium: 'Médio', high: 'Alto', very_high: 'Muito Alto' };

function outcomeFromResult(result) {
  if (!result) return { status: 'failed', text: 'A API não retornou resultado individual.' };
  if (result.skipped || result.status === 'blocked') return { status: 'blocked', text: result.reason || result.error || 'Ação bloqueada.' };
  if (result.status === 'failed' || result.ok === false) return { status: 'failed', text: result.error || result.reason || 'Falha informada pela API.' };
  if (result.status === 'confirming' || result.confirmation_status === 'pending' || result.confirmation_required) {
    return { status: 'confirming', text: 'Enviada; aguardando confirmação do estado na Amazon.' };
  }
  if (result.status === 'executed' || result.ok === true) {
    return { status: 'sent', text: 'Solicitação aceita/enviada; confirmação do estado não informada.' };
  }
  return { status: 'failed', text: result.error || result.reason || 'Estado da resposta não reconhecido.' };
}

function DecisionRow({ d, onUpdate }) {
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [executionOutcome, setExecutionOutcome] = useState(null);
  const currencySymbol = d.currency_symbol || 'R$';
  const changePct = Number(d.change_pct || 0);
  const isIncrease = changePct > 0;
  const isCritical = ['pause', 'enable', 'negative_keyword', 'create_campaign'].includes(d.decision_type);

  if (!['pending', 'approved', 'failed', 'confirming', 'executed'].includes(d.status)) return null;

  const saveStatus = async (nextStatus) => {
    setLoading(true);
    try {
      await base44.entities.OptimizationDecision.update(d.id, { status: nextStatus });
      onUpdate(d.id, nextStatus, null);
    } catch (error) {
      onUpdate(d.id, d.status, error?.message || 'Falha ao salvar decisão.');
    } finally { setLoading(false); }
  };

  const execute = async () => {
    if (isCritical && !window.confirm(`Confirma enviar à Amazon “${DECISION_LABELS[d.decision_type] || d.decision_type}” — ${d.keyword_text || d.entity_id}?`)) return;
    setLoading(true);
    setExecutionOutcome(null);
    try {
      const response = await base44.functions.invoke('executeAutopilotDecision', { decision_ids: [d.id] });
      const payload = response?.data || response || {};
      const item = (payload.results || []).find((row) => String(row.id || row.decision_id) === String(d.id)) || (payload.results || [])[0];
      const outcome = outcomeFromResult(item);
      setExecutionOutcome({ ...outcome, requestId: item?.request_id || item?.amazon_request_id || null });
      const persistedStatus = outcome.status === 'sent' ? 'confirming' : outcome.status;
      onUpdate(d.id, persistedStatus, outcome.status === 'failed' || outcome.status === 'blocked' ? outcome.text : null);
    } catch (error) {
      const message = error?.message || 'Falha de integração ao enviar a decisão.';
      setExecutionOutcome({ status: 'failed', text: message });
      onUpdate(d.id, 'failed', message);
    } finally { setLoading(false); }
  };

  const shownStatus = executionOutcome?.status === 'sent' ? 'confirming' : executionOutcome?.status || d.status;
  return (
    <>
      <tr className="border-b border-surface-2/40 hover:bg-surface-2/50 transition-colors">
        <td className="px-4 py-3">
          <div className="text-xs font-semibold text-white truncate max-w-[180px]">{d.keyword_text || d.entity_id || '—'}</div>
          <div className="text-xs text-slate-500 mt-0.5">{DECISION_LABELS[d.decision_type] || d.decision_type} · {ACTION_LABELS[d.action] || d.action}</div>
          {d.asin && <div className="text-[10px] font-mono text-cyan mt-0.5">{d.asin}</div>}
        </td>
        <td className="px-3 py-3"><span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${RISK_COLORS[d.risk] || RISK_COLORS.medium}`}>{RISK_LABELS[d.risk] || d.risk || '—'}</span></td>
        <td className="px-3 py-3">
          {d.value_before != null || d.value_after != null ? <div className="flex items-center gap-1.5">
            <span className="text-xs font-mono text-slate-400">{d.value_before == null ? '—' : `${currencySymbol}${Number(d.value_before).toFixed(2)}`}</span>
            <span className={`text-xs font-bold flex items-center gap-0.5 ${isIncrease ? 'text-emerald-400' : 'text-red-400'}`}>
              {isIncrease ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}{isIncrease ? '+' : ''}{changePct.toFixed(1)}%
            </span>
            <span className="text-xs font-mono text-white">{d.value_after == null ? '—' : `${currencySymbol}${Number(d.value_after).toFixed(2)}`}</span>
          </div> : <span className="text-xs text-slate-500">{ACTION_LABELS[d.action] || d.action || '—'}</span>}
        </td>
        <td className="px-3 py-3">
          <div className="flex items-center gap-2 mb-1">
            {d.confidence != null && <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${d.confidence >= 75 ? 'bg-emerald-400/15 text-emerald-400' : d.confidence >= 60 ? 'bg-amber-400/15 text-amber-400' : 'bg-red-400/15 text-red-400'}`}>{d.confidence}% conf.</span>}
            {d.evaluation_due_at && <span className="text-[10px] text-slate-500">Rev. {new Date(d.evaluation_due_at).toLocaleDateString('pt-BR')}</span>}
          </div>
          <button onClick={() => setExpanded(v => !v)} className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300">
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}<span className="truncate max-w-[200px]">{(d.rationale || d.reason || '').split('\n')[0]}</span>
          </button>
        </td>
        <td className="px-3 py-3">
          <StatusBadge status={shownStatus} size="xs" />
          {(executionOutcome || d.error_message) && <div className={`mt-1 max-w-[240px] text-[10px] ${shownStatus === 'failed' || shownStatus === 'blocked' ? 'text-red-300' : 'text-amber-300'}`}>
            {executionOutcome?.text || d.error_message}{executionOutcome?.requestId ? ` · Req. ${executionOutcome.requestId}` : ''}
          </div>}
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-1.5">
            {d.status === 'pending' && <>
              <button onClick={() => saveStatus('approved')} disabled={loading} className="flex items-center gap-1 px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-lg disabled:opacity-50">
                {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />} Aprovar
              </button>
              <button onClick={() => saveStatus('rejected')} disabled={loading} title="Rejeitar" className="p-1.5 bg-surface-2 hover:bg-red-500/20 border border-surface-3 text-slate-400 hover:text-red-400 rounded-lg disabled:opacity-50"><XCircle className="w-3.5 h-3.5" /></button>
            </>}
            {d.status === 'approved' && <button onClick={execute} disabled={loading} className="flex items-center gap-1 px-2.5 py-1.5 bg-cyan hover:bg-cyan/90 text-white text-xs font-bold rounded-lg disabled:opacity-50">
              {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />} Enviar
            </button>}
            {['failed', 'blocked'].includes(d.status) && <button onClick={() => saveStatus('pending')} disabled={loading} className="text-xs text-cyan hover:underline">Reabrir revisão</button>}
          </div>
        </td>
      </tr>
      {expanded && <tr className="border-b border-surface-2/40 bg-surface-2/20"><td colSpan={6} className="px-8 py-2.5 space-y-1">
        {d.rationale && <p className="text-xs text-slate-400">💡 {d.rationale}</p>}
        {d.data_used && <p className="text-xs text-slate-500">📊 {d.data_used}</p>}
        {d.settings_source && <p className="text-xs text-slate-500">Configuração: {d.settings_source}</p>}
        {d.idempotency_key && <p className="text-[10px] font-mono text-slate-600">🔑 {d.idempotency_key}</p>}
      </td></tr>}
    </>
  );
}

export default function AutopilotDecisionsTable({ decisions, onRefresh }) {
  const [filter, setFilter] = useState('pending');
  const [localDecisions, setLocalDecisions] = useState(decisions);
  const [bulkReviewOpen, setBulkReviewOpen] = useState(false);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkResults, setBulkResults] = useState([]);

  if (decisions !== localDecisions && decisions.length !== localDecisions.length) setLocalDecisions(decisions);

  const updateDecision = (id, status, error_message = null) => setLocalDecisions((prev) => prev.map((item) =>
    item.id === id ? { ...item, status, error_message } : item
  ));

  const pending = localDecisions.filter((item) => item.status === 'pending');
  const lowRisk = pending.filter((item) => ['low', 'very_low'].includes(item.risk));
  const blocked = pending.filter((item) => !['low', 'very_low'].includes(item.risk));
  const filtered = localDecisions.filter((item) =>
    filter === 'all' ? true :
    filter === 'pending' ? item.status === 'pending' :
    filter === 'approved' ? item.status === 'approved' :
    filter === 'executed' ? item.status === 'executed' :
    filter === 'sent' ? item.status === 'confirming' :
    ['rejected', 'failed', 'blocked', 'skipped'].includes(item.status)
  );
  const counts = {
    pending: pending.length,
    approved: localDecisions.filter(item => item.status === 'approved').length,
    executed: localDecisions.filter(item => item.status === 'executed').length,
    sent: localDecisions.filter(item => item.status === 'confirming').length,
    failures: localDecisions.filter(item => ['rejected', 'failed', 'blocked', 'skipped'].includes(item.status)).length,
  };

  const reviewSummary = useMemo(() => lowRisk.map((item) => ({
    id: item.id,
    name: item.keyword_text || item.entity_name || item.entity_id || '—',
    action: ACTION_LABELS[item.action] || item.action || '—',
    before: item.value_before,
    after: item.value_after,
  })), [localDecisions]);

  const approveAll = async () => {
    if (!bulkReviewOpen || lowRisk.length === 0 || bulkLoading) return;
    setBulkLoading(true);
    const outcomes = [];
    for (const item of lowRisk) {
      try {
        await base44.entities.OptimizationDecision.update(item.id, { status: 'approved' });
        updateDecision(item.id, 'approved', null);
        outcomes.push({ id: item.id, status: 'approved', name: item.keyword_text || item.entity_name || item.entity_id });
      } catch (error) {
        outcomes.push({ id: item.id, status: 'failed', name: item.keyword_text || item.entity_name || item.entity_id, error: error?.message || 'Falha ao aprovar.' });
      }
    }
    setBulkResults(outcomes);
    setBulkLoading(false);
    setBulkReviewOpen(false);
    onRefresh?.();
  };

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-surface-2 flex-wrap gap-2">
        <div className="flex gap-1 flex-wrap">
          {[
            { k: 'pending', label: `Pendentes (${counts.pending})` },
            { k: 'approved', label: `Aprovadas (${counts.approved})` },
            { k: 'sent', label: `Enviadas · aguardando confirmação (${counts.sent})` },
            { k: 'executed', label: `Confirmadas (${counts.executed})` },
            { k: 'rejected', label: `Rejeitadas/Falhas (${counts.failures})` },
            { k: 'all', label: 'Todas' },
          ].map(tab => <button key={tab.k} onClick={() => setFilter(tab.k)} className={`px-3 py-1.5 text-xs font-medium rounded-lg ${filter === tab.k ? 'bg-cyan/20 text-cyan' : 'text-slate-500 hover:text-slate-300'}`}>{tab.label}</button>)}
        </div>
        {pending.length > 0 && <button onClick={() => setBulkReviewOpen((value) => !value)} className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg">
          <CheckCircle className="w-3.5 h-3.5" /> Revisar aprovações de baixo risco ({lowRisk.length})
        </button>}
      </div>
      {bulkReviewOpen && <div className="m-4 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3 space-y-3">
        <div className="flex items-center gap-2 text-sm text-white"><AlertCircle className="h-4 w-4 text-amber-300" /> Lote de aprovação — não envia alterações à Amazon.</div>
        <p className="text-xs text-slate-400">Escopo: decisões carregadas nesta tabela; não inclui páginas ou registros que não foram carregados. {lowRisk.length} elegíveis por risco baixo/muito baixo · {blocked.length} retidas para revisão individual.</p>
        <div className="max-h-64 overflow-auto">
          <table className="w-full text-xs"><thead><tr className="text-slate-500"><th className="p-2 text-left">Item / ação</th><th className="p-2 text-left">Valor anterior</th><th className="p-2 text-left">Proposto</th><th className="p-2 text-left">Risco</th><th className="p-2 text-left">Motivo</th></tr></thead>
            <tbody>{reviewSummary.map((item) => <tr key={item.id} className="border-t border-surface-2/50"><td className="p-2 text-slate-200">{item.name}<div className="text-slate-500">{item.action}</div></td><td className="p-2 text-slate-400">{item.before == null ? '—' : Number(item.before).toLocaleString('pt-BR')}</td><td className="p-2 text-white">{item.after == null ? '—' : Number(item.after).toLocaleString('pt-BR')}</td><td className="p-2">Baixo</td><td className="p-2 text-slate-400">{localDecisions.find(row => row.id === item.id)?.rationale || 'Sem justificativa registrada'}</td></tr>)}</tbody>
          </table>
        </div>
        {blocked.length > 0 && <div className="text-xs text-amber-300">Bloqueados/retidos: {blocked.map(item => item.keyword_text || item.entity_name || item.entity_id || item.id).join(', ')} — risco médio/alto não entra na aprovação em lote.</div>}
        <div className="flex justify-end gap-2"><button onClick={() => setBulkReviewOpen(false)} className="px-3 py-1.5 text-xs text-slate-300">Cancelar</button><button onClick={approveAll} disabled={bulkLoading || lowRisk.length === 0} className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50">{bulkLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />} Confirmar aprovação ({lowRisk.length})</button></div>
      </div>}
      {bulkResults.length > 0 && <div className="px-5 py-2 text-xs space-y-1 border-b border-surface-2">{bulkResults.map(item => <div key={item.id} className={item.status === 'approved' ? 'text-emerald-300' : 'text-red-300'}>{item.name || item.id}: {item.status === 'approved' ? 'aprovada' : `falha — ${item.error}`}</div>)}</div>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-surface-2 bg-surface-2/50">{['Entidade / Termo', 'Risco', 'Valor Atual → Novo', 'Justificativa', 'Status', 'Ação'].map(header => <th key={header} className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{header}</th>)}</tr></thead>
          <tbody>{filtered.length === 0 ? <tr><td colSpan={6} className="px-5 py-10 text-center text-sm text-slate-500">Nenhuma decisão neste filtro</td></tr> : filtered.map(item => <DecisionRow key={item.id} d={item} onUpdate={updateDecision} />)}</tbody>
        </table>
      </div>
    </div>
  );
}
