import React, { useState, useEffect, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { RefreshCw, AlertTriangle, CheckCircle, Clock, Zap, TrendingUp, Shield } from 'lucide-react';

const STATUS_META = {
  launch_0_48h:             { label: 'Fase inicial 0–48h', color: 'bg-blue-500/15 text-blue-400', icon: Clock },
  emergency_reduction:      { label: 'Contenção emergencial', color: 'bg-red-500/15 text-red-400', icon: AlertTriangle },
  waiting_48h_review:       { label: 'Aguardando revisão 48h', color: 'bg-yellow-500/15 text-yellow-400', icon: Clock },
  amazon_bid_applied:       { label: 'Sugestão Amazon aplicada', color: 'bg-emerald-500/15 text-emerald-400', icon: CheckCircle },
  amazon_bid_limited:       { label: 'Sugestão limitada (guardrail)', color: 'bg-orange-500/15 text-orange-400', icon: Shield },
  no_amazon_suggestion:     { label: 'Sem sugestão Amazon', color: 'bg-slate-500/15 text-slate-400', icon: TrendingUp },
  unified_engine_management:{ label: 'Motor unificado', color: 'bg-violet-500/15 text-violet-400', icon: Zap },
  waiting_72h_review:       { label: 'Revisão 72h', color: 'bg-amber-500/15 text-amber-400', icon: Clock },
  stabilized:               { label: 'Estabilizado', color: 'bg-green-500/15 text-green-400', icon: CheckCircle },
  failed:                   { label: 'Falha', color: 'bg-red-500/15 text-red-400', icon: AlertTriangle },
  pending_confirmation:     { label: 'Confirmação pendente', color: 'bg-orange-500/15 text-orange-400', icon: Clock },
  paused_no_stock:          { label: 'Pausado s/ estoque', color: 'bg-slate-500/15 text-slate-400', icon: Shield },
};

const fmtBRL = v => v != null ? `R$${Number(v).toFixed(2)}` : '—';
const fmtPct = v => v > 0 ? `${Number(v).toFixed(1)}%` : '—';

function AgeChip({ createdAt }) {
  if (!createdAt) return <span className="text-slate-600">—</span>;
  const h = Math.round((Date.now() - new Date(createdAt).getTime()) / 3600000);
  const color = h < 24 ? 'text-blue-400' : h < 48 ? 'text-yellow-400' : h < 72 ? 'text-orange-400' : 'text-slate-400';
  return <span className={`text-xs font-mono ${color}`}>{h < 24 ? `${h}h` : `${Math.floor(h/24)}d${h%24>0?` ${h%24}h`:''}`}</span>;
}

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || { label: status, color: 'bg-slate-500/15 text-slate-400', icon: Clock };
  const Icon = meta.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${meta.color}`}>
      <Icon className="w-3 h-3 flex-shrink-0" />
      {meta.label}
    </span>
  );
}

function AlertRow({ lc }) {
  const alerts = [];
  if (lc.amazon_suggestion_limited_by_guardrail) alerts.push('Sugestão Amazon limitada por guardrail');
  if (lc.ad_group_keywords_count > 1) alerts.push(`Grupo com ${lc.ad_group_keywords_count} keywords — default bid não alinhado`);
  if (lc.status === 'pending_confirmation') alerts.push('Confirmação Amazon pendente');
  if (lc.emergency_triggered) alerts.push(`Contenção emergencial: ${lc.emergency_reason || ''}`);
  if (!alerts.length) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {alerts.map((a, i) => (
        <span key={i} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] bg-amber-500/10 text-amber-400 border border-amber-500/20">
          <AlertTriangle className="w-2.5 h-2.5" />{a}
        </span>
      ))}
    </div>
  );
}

export default function ManualBidLifecyclePanel({ amazonAccountId }) {
  const [lifecycles, setLifecycles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState(null);
  const [filter, setFilter] = useState('all');

  const load = async () => {
    setLoading(true);
    try {
      const data = await base44.entities.ManualCampaignBidLifecycle.filter(
        { amazon_account_id: amazonAccountId }, '-created_date', 200
      );
      setLifecycles(data || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (amazonAccountId) load(); }, [amazonAccountId]);

  const runCycle = async () => {
    setRunning(true);
    setRunResult(null);
    try {
      const res = await base44.functions.invoke('runManualCampaignBidLifecycle', { _service_role: true });
      setRunResult(res?.data?.summary || null);
      await load();
    } catch (e) {
      setRunResult({ error: e.message });
    } finally {
      setRunning(false);
    }
  };

  const filtered = useMemo(() => {
    if (filter === 'all') return lifecycles;
    if (filter === 'active') return lifecycles.filter(lc => ['launch_0_48h', 'emergency_reduction', 'waiting_48h_review', 'waiting_72h_review'].includes(lc.status));
    if (filter === 'engine') return lifecycles.filter(lc => lc.management_source === 'unified_decision_engine');
    if (filter === 'alert') return lifecycles.filter(lc => lc.emergency_triggered || lc.status === 'pending_confirmation' || lc.amazon_suggestion_limited_by_guardrail);
    return lifecycles;
  }, [lifecycles, filter]);

  const stats = useMemo(() => ({
    total: lifecycles.length,
    in_48h: lifecycles.filter(lc => lc.status === 'launch_0_48h').length,
    emergency: lifecycles.filter(lc => lc.status === 'emergency_reduction' || lc.emergency_triggered).length,
    waiting_48h: lifecycles.filter(lc => lc.status === 'waiting_48h_review').length,
    amazon_applied: lifecycles.filter(lc => ['amazon_bid_applied', 'amazon_bid_limited'].includes(lc.status)).length,
    engine: lifecycles.filter(lc => lc.management_source === 'unified_decision_engine').length,
  }), [lifecycles]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-300">Campanhas Manuais — Ciclo Inicial de Bids</h3>
          <p className="text-[10px] text-slate-500 mt-0.5">Gestão automática: 0-48h lance inicial · 48h sugestão Amazon · 72h revisão · motor unificado</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} disabled={loading} className="p-1.5 bg-surface-2 border border-surface-3 rounded-lg text-slate-400 hover:text-white">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={runCycle} disabled={running}
            className="px-3 py-1.5 bg-cyan/10 border border-cyan/30 text-cyan text-xs font-medium rounded-lg hover:bg-cyan/15 disabled:opacity-50 flex items-center gap-1.5">
            {running ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
            {running ? 'Executando...' : 'Executar ciclo agora'}
          </button>
        </div>
      </div>

      {runResult ? (
        <div className={`px-4 py-3 rounded-xl border text-xs ${runResult.error ? 'bg-red-500/10 border-red-500/20 text-red-400' : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'}`}>
          {runResult.error ? `Erro: ${runResult.error}` : (
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <span>Campanhas: <b>{runResult.campaigns_analyzed}</b></span>
              <span>Keywords: <b>{runResult.keywords_found}</b></span>
              <span>Criados: <b>{runResult.lifecycles_created}</b></span>
              <span>Bids aplicados: <b>{runResult.bids_applied_to_amazon}</b></span>
              {runResult.emergency_reductions > 0 ? <span className="text-red-400">⚠ Emergências: <b>{runResult.emergency_reductions}</b></span> : null}
              {runResult.post_48h_adjustments > 0 ? <span>48h ajustes: <b>{runResult.post_48h_adjustments}</b></span> : null}
              {runResult.delivered_to_engine > 0 ? <span>→ Motor: <b>{runResult.delivered_to_engine}</b></span> : null}
            </div>
          )}
        </div>
      ) : null}

      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        {[
          { label: 'Total', value: stats.total, color: 'text-slate-300' },
          { label: 'Fase 0-48h', value: stats.in_48h, color: 'text-blue-400' },
          { label: '⚠ Emergência', value: stats.emergency, color: 'text-red-400' },
          { label: 'Aguard. 48h', value: stats.waiting_48h, color: 'text-yellow-400' },
          { label: 'Amazon OK', value: stats.amazon_applied, color: 'text-emerald-400' },
          { label: 'No Motor', value: stats.engine, color: 'text-violet-400' },
        ].map(s => (
          <div key={s.label} className="bg-surface-2 rounded-lg px-3 py-2 text-center">
            <p className={`text-lg font-bold ${s.color}`}>{s.value}</p>
            <p className="text-[9px] text-slate-500">{s.label}</p>
          </div>
        ))}
      </div>

      <div className="flex gap-1.5 flex-wrap">
        {[
          { key: 'all', label: 'Todos' },
          { key: 'active', label: 'Ativos (0-72h)' },
          { key: 'engine', label: 'No Motor' },
          { key: 'alert', label: '⚠ Alertas' },
        ].map(f => (
          <button key={f.key} onClick={() => setFilter(f.key)}
            className={`px-2.5 py-1 rounded text-[11px] font-medium transition-all ${filter === f.key ? 'bg-cyan text-white' : 'bg-surface-2 border border-surface-3 text-slate-400 hover:text-slate-200'}`}>
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="h-32 flex items-center justify-center text-slate-500 text-xs">Carregando...</div>
      ) : filtered.length === 0 ? (
        <div className="h-24 flex items-center justify-center text-slate-600 text-xs">
          {lifecycles.length === 0 ? 'Nenhum lifecycle registrado. Execute o ciclo para auditar as campanhas.' : 'Nenhum item para o filtro selecionado.'}
        </div>
      ) : (
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full text-xs min-w-[900px]">
            <thead>
              <tr className="border-b border-surface-2">
                {['Campanha', 'Grupo / ASIN', 'Keyword', 'Idade', 'Default Bid', 'Bid KW', 'Sugestão Amazon', 'Próx. bid', 'ACoS', 'Gasto', 'Estágio', 'Próx. revisão'].map(h => (
                  <th key={h} className="text-left py-2 px-2 text-[10px] font-medium text-slate-500 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(lc => {
                const nextReview = lc.next_review_at ? new Date(lc.next_review_at) : null;
                const reviewIn = nextReview ? Math.round((nextReview.getTime() - Date.now()) / 3600000) : null;

                return (
                  <tr key={lc.id} className="border-b border-surface-2/50 hover:bg-surface-2/30 transition-colors">
                    <td className="py-2 px-2">
                      <p className="text-slate-300 truncate max-w-[140px]" title={lc.campaign_name}>
                        {(lc.campaign_name || '').replace('SP | MANUAL | EXACT | ', '').slice(0, 30)}
                      </p>
                      <AlertRow lc={lc} />
                    </td>
                    <td className="py-2 px-2">
                      <p className="text-slate-400 text-[10px] truncate max-w-[100px]">{lc.ad_group_name || lc.ad_group_id?.slice(-8)}</p>
                      {lc.asin ? <p className="text-slate-600 text-[9px]">{lc.asin}</p> : null}
                    </td>
                    <td className="py-2 px-2 max-w-[120px]">
                      <p className="text-slate-300 truncate" title={lc.keyword_text}>{lc.keyword_text || '—'}</p>
                      <p className="text-slate-600 text-[9px]">{lc.match_type || ''}</p>
                    </td>
                    <td className="py-2 px-2 whitespace-nowrap"><AgeChip createdAt={lc.campaign_created_at} /></td>
                    <td className="py-2 px-2 text-slate-300 font-mono whitespace-nowrap">{fmtBRL(lc.current_ad_group_default_bid)}</td>
                    <td className="py-2 px-2 text-cyan font-mono font-semibold whitespace-nowrap">{fmtBRL(lc.current_keyword_bid)}</td>
                    <td className="py-2 px-2 whitespace-nowrap">
                      {lc.amazon_suggested_bid ? (
                        <div>
                          <p className="text-emerald-400 font-mono">{fmtBRL(lc.amazon_suggested_bid)}</p>
                          <p className="text-slate-600 text-[9px]">{fmtBRL(lc.amazon_suggested_bid_lower)} – {fmtBRL(lc.amazon_suggested_bid_upper)}</p>
                        </div>
                      ) : <span className="text-slate-600">{lc.amazon_suggestion_fetched_at ? 'Sem sugestão' : '—'}</span>}
                    </td>
                    <td className="py-2 px-2 whitespace-nowrap">
                      {lc.post_48h_bid
                        ? <span className="text-amber-400 font-mono font-semibold">{fmtBRL(lc.post_48h_bid)}</span>
                        : <span className="text-slate-600">—</span>}
                      {lc.amazon_suggestion_limited_by_guardrail ? <span className="text-[9px] text-orange-400 ml-1">⚠</span> : null}
                    </td>
                    <td className="py-2 px-2 whitespace-nowrap">
                      <span className={lc.current_acos > 0 ? (lc.current_acos > (lc.target_acos || 15) ? 'text-red-400' : 'text-emerald-400') : 'text-slate-600'}>
                        {fmtPct(lc.current_acos)}
                      </span>
                    </td>
                    <td className="py-2 px-2 text-slate-400 whitespace-nowrap font-mono">{fmtBRL(lc.current_spend)}</td>
                    <td className="py-2 px-2"><StatusBadge status={lc.status} /></td>
                    <td className="py-2 px-2 whitespace-nowrap">
                      {reviewIn != null ? (
                        <span className={`text-[10px] font-mono ${reviewIn < 0 ? 'text-red-400' : reviewIn < 12 ? 'text-amber-400' : 'text-slate-500'}`}>
                          {reviewIn < 0 ? `vencido ${Math.abs(reviewIn)}h` : `em ${reviewIn}h`}
                        </span>
                      ) : <span className="text-slate-600">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}