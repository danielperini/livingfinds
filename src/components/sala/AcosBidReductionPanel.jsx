import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  TrendingDown, RefreshCw, Loader2, CheckCircle2, Clock, AlertTriangle,
  XCircle, Eye, Play, Filter, ChevronDown, ChevronUp, Zap
} from 'lucide-react';

const STATUS_CFG = {
  detected:                { label: 'Detectado',       color: 'text-slate-400', bg: 'bg-slate-500/10 border-slate-500/20' },
  suggestion_checked:      { label: 'Sugestão OK',     color: 'text-cyan',      bg: 'bg-cyan/10 border-cyan/20' },
  executed:                { label: 'Executado',        color: 'text-cyan',      bg: 'bg-cyan/10 border-cyan/20' },
  waiting_48h_evaluation:  { label: 'Aguard. 48h',     color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/20' },
  reevaluating:            { label: 'Reavaliando',      color: 'text-violet-400',bg: 'bg-violet-500/10 border-violet-500/20' },
  reduced_again:           { label: 'Redução 2ª',      color: 'text-orange-400',bg: 'bg-orange-500/10 border-orange-500/20' },
  stabilized:              { label: 'Meta atingida ✓',  color: 'text-emerald-400',bg: 'bg-emerald-500/10 border-emerald-500/20' },
  visibility_drop:         { label: 'Queda impressões',color: 'text-red-400',   bg: 'bg-red-500/10 border-red-500/20' },
  zero_impressions:        { label: 'Zero impressões', color: 'text-red-400',   bg: 'bg-red-500/10 border-red-500/20' },
  no_sales_after_reduction:{ label: 'Sem vendas',      color: 'text-red-400',   bg: 'bg-red-500/10 border-red-500/20' },
  insufficient_data:       { label: 'Dados insufic.',  color: 'text-slate-500', bg: 'bg-slate-500/5 border-slate-500/10' },
  cancelled:               { label: 'Cancelado',       color: 'text-slate-600', bg: 'bg-slate-500/5 border-slate-500/10' },
  failed:                  { label: 'Falhou',           color: 'text-red-500',   bg: 'bg-red-500/10 border-red-500/20' },
  requires_approval:       { label: 'Aprovação req.',  color: 'text-amber-300', bg: 'bg-amber-500/10 border-amber-500/20' },
};

function StatusBadge({ status }) {
  const cfg = STATUS_CFG[status] || { label: status, color: 'text-slate-400', bg: 'bg-slate-500/10 border-slate-500/20' };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-bold ${cfg.bg} ${cfg.color}`}>
      {cfg.label}
    </span>
  );
}

function AcosBar({ current, target }) {
  if (!target || !current) return <span className="text-slate-600 text-xs">—</span>;
  const pct = Math.min(200, (current / target) * 100);
  const color = pct > 150 ? 'bg-red-500' : pct > 110 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div className="flex items-center gap-2 min-w-[80px]">
      <div className="flex-1 h-1.5 bg-surface-3 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, pct / 2)}%` }} />
      </div>
      <span className={`text-xs font-bold ${pct > 150 ? 'text-red-400' : pct > 110 ? 'text-amber-400' : 'text-emerald-400'}`}>
        {current.toFixed(1)}%
      </span>
    </div>
  );
}

const FILTER_OPTS = [
  { key: 'all', label: 'Todos' },
  { key: 'waiting_48h_evaluation', label: 'Aguard. 48h' },
  { key: 'executed', label: 'Executados' },
  { key: 'stabilized', label: 'Meta atingida' },
  { key: 'visibility_drop', label: 'Queda impressões' },
  { key: 'requires_approval', label: 'Aprovação pendente' },
  { key: 'failed', label: 'Falhas' },
];

export default function AcosBidReductionPanel({ account }) {
  const [cycles, setCycles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState(null);
  const [filter, setFilter] = useState('all');
  const [expandedId, setExpandedId] = useState(null);

  const load = useCallback(async () => {
    if (!account) return;
    setLoading(true);
    try {
      const data = await base44.entities.KeywordBidOptimizationCycle.filter(
        { amazon_account_id: account.id }, '-created_at', 200
      ).catch(() => []);
      setCycles(data || []);
    } finally {
      setLoading(false);
    }
  }, [account]);

  useEffect(() => { load(); }, [load]);

  const showMsg = (text, type = 'success') => {
    setMsg({ text, type });
    setTimeout(() => setMsg(null), 8000);
  };

  const runEngine = async (dryRun = false) => {
    if (!account || running) return;
    setRunning(true);
    try {
      const res = await base44.functions.invoke('runAcosBidReductionEngine', {
        amazon_account_id: account.id,
        dry_run: dryRun,
      });
      const d = res?.data;
      if (d?.ok) {
        showMsg(
          dryRun
            ? `Simulação: ${d.reductions_applied} keyword(s) identificadas acima da meta.`
            : `Motor executado: ${d.stats?.first_reduction_10pct || 0} reduções de 10%, ${d.stats?.second_reduction_5pct || 0} de 5%, ${d.stats?.stabilized || 0} estabilizadas.`
        );
        if (!dryRun) await load();
      } else {
        showMsg(d?.error || d?.reason || 'Erro ao executar motor.', 'error');
      }
    } catch (e) { showMsg(e.message, 'error'); }
    finally { setRunning(false); }
  };

  // KPIs
  const kpis = {
    total: cycles.length,
    waiting: cycles.filter(c => c.cycle_status === 'waiting_48h_evaluation').length,
    stabilized: cycles.filter(c => c.cycle_status === 'stabilized').length,
    reduce_10: cycles.filter(c => (c.first_reduction_pct || 0) >= 9).length,
    reduce_5: cycles.filter(c => (c.second_reduction_pct || 0) > 0).length,
    visibility_drop: cycles.filter(c => c.cycle_status === 'visibility_drop').length,
    requires_approval: cycles.filter(c => c.cycle_status === 'requires_approval').length,
  };

  const filtered = filter === 'all' ? cycles : cycles.filter(c => c.cycle_status === filter);

  return (
    <div className="space-y-4 p-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-red-500/15 border border-red-500/20 flex items-center justify-center">
            <TrendingDown className="w-4 h-4 text-red-400" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-white">Otimização de ACoS por Keyword</h3>
            <p className="text-[10px] text-slate-500">Redução gradual determinística: -10% → aguardar 48h → -5% → estabilizar</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => runEngine(true)} disabled={running || !account}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold bg-surface-2 border border-surface-3 text-slate-300 hover:text-white rounded-lg disabled:opacity-40 transition-colors">
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
            Simular
          </button>
          <button onClick={() => runEngine(false)} disabled={running || !account}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold bg-red-500/15 border border-red-500/30 text-red-300 hover:bg-red-500/25 rounded-lg disabled:opacity-40 transition-colors">
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            Executar
          </button>
          <button onClick={load} disabled={loading}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg disabled:opacity-40 transition-colors">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Msg */}
      {msg && (
        <div className={`px-4 py-2.5 rounded-xl border text-xs font-medium ${msg.type === 'error' ? 'bg-red-500/10 border-red-500/20 text-red-300' : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'}`}>
          {msg.text}
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-3 sm:grid-cols-7 gap-2">
        {[
          { label: 'Ciclos', value: kpis.total, color: 'text-white' },
          { label: 'Aguard. 48h', value: kpis.waiting, color: 'text-amber-400' },
          { label: 'Redução -10%', value: kpis.reduce_10, color: 'text-cyan' },
          { label: 'Redução -5%', value: kpis.reduce_5, color: 'text-orange-400' },
          { label: 'Meta atingida', value: kpis.stabilized, color: 'text-emerald-400' },
          { label: 'Queda Impr.', value: kpis.visibility_drop, color: kpis.visibility_drop > 0 ? 'text-red-400' : 'text-slate-600' },
          { label: 'Aprovação', value: kpis.requires_approval, color: kpis.requires_approval > 0 ? 'text-amber-300' : 'text-slate-600' },
        ].map(k => (
          <div key={k.label} className="bg-surface-1 border border-surface-2 rounded-xl px-3 py-2 text-center">
            <p className="text-[9px] text-slate-500 mb-0.5 leading-tight">{k.label}</p>
            <p className={`text-lg font-bold ${k.color}`}>{k.value}</p>
          </div>
        ))}
      </div>

      {/* Filtros */}
      <div className="flex items-center gap-1 overflow-x-auto pb-1 scrollbar-thin">
        {FILTER_OPTS.map(f => (
          <button key={f.key} onClick={() => setFilter(f.key)}
            className={`flex items-center gap-1 px-2.5 py-1 text-[10px] rounded-full border whitespace-nowrap transition-colors ${
              filter === f.key ? 'bg-cyan/15 text-cyan border-cyan/30' : 'bg-surface-2 text-slate-500 border-surface-3 hover:text-slate-300'
            }`}>
            {f.label}
            <span className="font-bold">{f.key === 'all' ? cycles.length : cycles.filter(c => c.cycle_status === f.key).length}</span>
          </button>
        ))}
      </div>

      {/* Tabela */}
      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 text-cyan animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 bg-surface-1 border border-surface-2 rounded-xl gap-3">
          <TrendingDown className="w-8 h-8 text-slate-600" />
          <p className="text-sm text-slate-400">Nenhum ciclo encontrado.</p>
          <p className="text-xs text-slate-600">Execute o motor para detectar keywords acima da meta de ACoS.</p>
        </div>
      ) : (
        <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-surface-2 bg-surface-2/50">
                  <th className="px-3 py-2.5 text-left text-slate-500 font-semibold uppercase tracking-wider w-6" />
                  <th className="px-3 py-2.5 text-left text-slate-500 font-semibold uppercase tracking-wider">Keyword</th>
                  <th className="px-3 py-2.5 text-left text-slate-500 font-semibold uppercase tracking-wider">ACoS atual / meta</th>
                  <th className="px-3 py-2.5 text-left text-slate-500 font-semibold uppercase tracking-wider">Bid anterior</th>
                  <th className="px-3 py-2.5 text-left text-slate-500 font-semibold uppercase tracking-wider">Sugestão Amazon</th>
                  <th className="px-3 py-2.5 text-left text-slate-500 font-semibold uppercase tracking-wider">Novo bid</th>
                  <th className="px-3 py-2.5 text-left text-slate-500 font-semibold uppercase tracking-wider">Alteração</th>
                  <th className="px-3 py-2.5 text-left text-slate-500 font-semibold uppercase tracking-wider">Status</th>
                  <th className="px-3 py-2.5 text-left text-slate-500 font-semibold uppercase tracking-wider">Próxima checagem</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(cyc => {
                  const isExpanded = expandedId === cyc.id;
                  const impChangePct = cyc.impression_change_pct || 0;
                  const nextCheck = cyc.evaluation_due_at
                    ? new Date(cyc.evaluation_due_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
                    : cyc.cycle_status === 'stabilized' ? '—' : '—';

                  return [
                    <tr key={cyc.id}
                      className="border-b border-surface-2/40 hover:bg-surface-2/20 transition-colors cursor-pointer"
                      onClick={() => setExpandedId(isExpanded ? null : cyc.id)}>
                      <td className="px-3 py-2.5 text-slate-600">
                        {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                      </td>
                      <td className="px-3 py-2.5 max-w-[160px]">
                        <p className="text-slate-200 font-medium truncate" title={cyc.keyword_text}>{cyc.keyword_text || '—'}</p>
                        <p className="text-[10px] text-slate-500 font-mono">{cyc.match_type || ''} · {cyc.asin || ''}</p>
                      </td>
                      <td className="px-3 py-2.5">
                        <AcosBar current={cyc.current_acos} target={cyc.target_acos} />
                        <p className="text-[10px] text-slate-600 mt-0.5">meta: {cyc.target_acos}% ({cyc.target_acos_source})</p>
                      </td>
                      <td className="px-3 py-2.5 text-slate-300 font-mono">R${(cyc.initial_bid || 0).toFixed(2)}</td>
                      <td className="px-3 py-2.5">
                        {cyc.amazon_suggested_bid
                          ? <span className={`font-mono text-slate-300 ${cyc.amazon_suggestion_used ? 'text-cyan' : ''}`}>
                              R${cyc.amazon_suggested_bid.toFixed(2)}
                              {cyc.amazon_suggestion_used && <span className="ml-1 text-[9px] text-cyan">usada</span>}
                              {cyc.amazon_suggestion_limited && <span className="ml-1 text-[9px] text-amber-400">limitada</span>}
                            </span>
                          : <span className="text-slate-600">—</span>}
                      </td>
                      <td className="px-3 py-2.5 font-mono font-bold text-white">R${(cyc.current_bid || 0).toFixed(2)}</td>
                      <td className="px-3 py-2.5">
                        {cyc.cycle_status === 'stabilized'
                          ? <span className="text-emerald-400 text-[10px] font-bold">Estável</span>
                          : <span className="text-red-400 text-[10px] font-bold">
                              -{cyc.total_reduction_pct?.toFixed(1) || '0'}%
                            </span>}
                      </td>
                      <td className="px-3 py-2.5"><StatusBadge status={cyc.cycle_status} /></td>
                      <td className="px-3 py-2.5 text-slate-500 text-[10px]">{nextCheck}</td>
                    </tr>,
                    isExpanded && (
                      <tr key={`${cyc.id}-exp`} className="border-b border-surface-2/40 bg-surface-2/10">
                        <td colSpan={9} className="px-6 py-3">
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[10px]">
                            <div>
                              <p className="text-slate-500 mb-0.5">Impressões antes/depois</p>
                              <p className="text-slate-300">
                                {cyc.pre_change_impressions} → {cyc.post_change_impressions || '—'}
                                {cyc.impression_change_pct !== 0 && (
                                  <span className={`ml-1 ${impChangePct < -30 ? 'text-red-400' : impChangePct > 0 ? 'text-emerald-400' : 'text-slate-400'}`}>
                                    ({impChangePct > 0 ? '+' : ''}{impChangePct.toFixed(1)}%)
                                  </span>
                                )}
                              </p>
                            </div>
                            <div>
                              <p className="text-slate-500 mb-0.5">Pedidos antes/depois</p>
                              <p className="text-slate-300">{cyc.pre_change_orders} → {cyc.post_change_orders ?? '—'}</p>
                            </div>
                            <div>
                              <p className="text-slate-500 mb-0.5">ACoS antes/depois</p>
                              <p className="text-slate-300">
                                {cyc.pre_change_acos?.toFixed(1)}% → {cyc.post_change_acos ? `${cyc.post_change_acos.toFixed(1)}%` : '—'}
                                {cyc.acos_change_pct ? <span className="ml-1 text-emerald-400">({cyc.acos_change_pct > 0 ? '+' : ''}{cyc.acos_change_pct.toFixed(1)}%)</span> : null}
                              </p>
                            </div>
                            <div>
                              <p className="text-slate-500 mb-0.5">Ciclo / redução acumulada</p>
                              <p className="text-slate-300">#{cyc.cycle_number} · -{cyc.total_reduction_pct?.toFixed(1) || 0}%</p>
                            </div>
                            {cyc.stop_reason && (
                              <div className="col-span-2 sm:col-span-4">
                                <p className="text-slate-500 mb-0.5">Motivo</p>
                                <p className="text-slate-400">{cyc.stop_reason}</p>
                              </div>
                            )}
                            {cyc.requires_human_approval && (
                              <div className="col-span-2 sm:col-span-4">
                                <p className="text-amber-300 font-semibold">⚠️ Exige aprovação humana — redução acumulada {'>'} 25%</p>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  ];
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Info box */}
      <div className="px-4 py-3 rounded-xl border border-surface-2 bg-surface-1 text-[10px] text-slate-500 space-y-1">
        <p><span className="text-slate-300 font-semibold">Fluxo:</span> Keyword ativa acima da meta → verificar sugestão Amazon → redução -10% (ou sugestão se 5–15%) → aguardar 48h → reavaliar → -5% se ainda acima → estabilizar.</p>
        <p><span className="text-slate-300 font-semibold">Guardrails:</span> Mín. 5 cliques · gasto {'>'} 0 · keywords com vendas apenas · campanhas ativas · escopo autorizado · sem duplicatas dentro de 48h · exige aprovação humana se redução acumulada {'>'} 25%.</p>
        <p><span className="text-slate-300 font-semibold">Automação:</span> Executado automaticamente pelo runUnifiedDecisionEngine a cada ciclo de otimização.</p>
      </div>
    </div>
  );
}