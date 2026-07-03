import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Clock, TrendingUp, TrendingDown, Activity, Loader2,
  Zap, CheckCircle, XCircle, AlertTriangle, BarChart2,
  RefreshCw, ChevronDown, ChevronUp, Database
} from 'lucide-react';

// ── Classificação horária: label, cor e ação esperada ──────────────────────────
const CLASS_CONFIG = {
  peak_high_profit: { label: 'Pico Alta Rentabilidade', badge: 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300', dot: 'bg-emerald-400', action: 'Aumentar bid +100% a +130%' },
  peak_conversion:  { label: 'Pico Conversão',          badge: 'bg-cyan/15 border-cyan/30 text-cyan',                      dot: 'bg-cyan',         action: 'Aumentar bid até +100%' },
  efficient:        { label: 'Eficiente',                badge: 'bg-blue-500/15 border-blue-500/30 text-blue-300',          dot: 'bg-blue-400',     action: 'Manter bid atual' },
  low_efficiency:   { label: 'Baixa Eficiência',         badge: 'bg-amber-500/15 border-amber-500/30 text-amber-300',       dot: 'bg-amber-400',    action: 'Reduzir para R$0,25' },
  deficit:          { label: 'Deficitário',               badge: 'bg-red-500/15 border-red-500/30 text-red-300',            dot: 'bg-red-400',      action: 'Reduzir para R$0,25' },
  discovery:        { label: 'Dados Insuficientes',       badge: 'bg-slate-600/15 border-slate-600/30 text-slate-400',      dot: 'bg-slate-500',    action: 'Manter bid, aguardar dados' },
  insufficient_data:{ label: 'Sem Dados',                 badge: 'bg-slate-700/15 border-slate-700/30 text-slate-500',      dot: 'bg-slate-600',    action: '—' },
};

function ClassBadge({ cls, size = 'sm' }) {
  const cfg = CLASS_CONFIG[cls] || CLASS_CONFIG.insufficient_data;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border font-medium ${cfg.badge} ${size === 'xs' ? 'text-[10px] px-1.5 py-0.5' : 'text-xs px-2 py-0.5'}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

// ── Mapa de calor 24h ──────────────────────────────────────────────────────────
function HeatMapRow({ schedule }) {
  if (!schedule?.length) return null;
  const byHour = {};
  for (const s of schedule) byHour[s.hour] = s;

  return (
    <div className="mt-3">
      <p className="text-xs text-slate-500 mb-1.5">Mapa de bids por hora (0h–23h)</p>
      <div className="flex gap-0.5 flex-wrap">
        {Array.from({ length: 24 }, (_, h) => {
          const slot = byHour[h];
          const cls = slot?.classification || 'insufficient_data';
          const cfg = CLASS_CONFIG[cls];
          const bid = slot?.recommendedBid;
          return (
            <div key={h} title={`${h}h — ${cfg.label}${bid ? ` — Bid: R$${bid}` : ''}`}
              className={`w-7 h-7 rounded flex items-center justify-center text-[9px] font-bold text-white/70 cursor-default border border-white/5 ${
                cls === 'peak_high_profit' ? 'bg-emerald-500' :
                cls === 'peak_conversion'  ? 'bg-cyan/80' :
                cls === 'efficient'        ? 'bg-blue-600/60' :
                cls === 'low_efficiency'   ? 'bg-amber-500/60' :
                cls === 'deficit'          ? 'bg-red-600/60' :
                'bg-slate-700/40'
              }`}>
              {h}
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-3 mt-2 flex-wrap">
        {['peak_high_profit', 'peak_conversion', 'efficient', 'low_efficiency', 'deficit'].map(c => (
          <div key={c} className="flex items-center gap-1 text-[10px] text-slate-400">
            <span className={`w-2 h-2 rounded-sm ${CLASS_CONFIG[c].dot}`} />
            {CLASS_CONFIG[c].label}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Tabela de regras gravadas no banco ─────────────────────────────────────────
function RulesTable({ rules, loading, onRefresh }) {
  const [expandedCampaign, setExpandedCampaign] = useState(null);

  // Agrupar por campaign_id
  const byCampaign = {};
  for (const r of rules) {
    const cid = r.campaign_id;
    if (!byCampaign[cid]) byCampaign[cid] = { campaign_id: cid, rules: [] };
    byCampaign[cid].rules.push(r);
  }
  const campaigns = Object.values(byCampaign);

  if (loading) return <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 text-cyan animate-spin" /></div>;

  if (!campaigns.length) return (
    <div className="flex flex-col items-center justify-center py-16 gap-2 text-center">
      <Database className="w-10 h-10 text-slate-600" />
      <p className="text-sm text-slate-400">Nenhuma regra de dayparting salva.</p>
      <p className="text-xs text-slate-500">Execute o Dayparting para gerar regras.</p>
    </div>
  );

  return (
    <div className="space-y-2">
      {campaigns.map(({ campaign_id, rules: cRules }) => {
        const open = expandedCampaign === campaign_id;
        const peakCount    = cRules.filter(r => ['peak_high_profit', 'peak_conversion'].includes(r.classification)).length;
        const deficitCount = cRules.filter(r => ['deficit', 'low_efficiency'].includes(r.classification)).length;
        const firstRule    = cRules[0];
        const conf         = firstRule?.confidence || 0;
        const active       = cRules.filter(r => r.status === 'active').length;

        return (
          <div key={campaign_id} className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
            <button onClick={() => setExpandedCampaign(open ? null : campaign_id)}
              className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-surface-2/50 transition-colors text-left">
              <div className="flex items-center gap-3 min-w-0">
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${active > 0 ? 'bg-emerald-400' : 'bg-slate-500'}`} />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white font-mono truncate">{campaign_id}</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {active} regras ativas · {peakCount} pico · {deficitCount} baixa
                    {firstRule?.created_at && ` · criado ${new Date(firstRule.created_at).toLocaleDateString('pt-BR')}`}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${conf >= 90 ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-400' : conf >= 70 ? 'bg-amber-400/10 border-amber-400/20 text-amber-400' : 'bg-slate-400/10 border-slate-400/20 text-slate-400'}`}>
                  {conf}% conf.
                </span>
                {open ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
              </div>
            </button>

            {open && (
              <div className="px-5 pb-5 border-t border-surface-2">
                {/* Mapa de calor */}
                <HeatMapRow schedule={cRules.map(r => ({
                  hour: r.start_hour,
                  classification: r.classification,
                  recommendedBid: r.recommended_bid,
                  bidChangePct: r.adjustment_value,
                }))} />

                {/* Tabela detalhada */}
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-surface-2">
                        {['Hora', 'Classificação', 'Bid Base', 'Bid Recomendado', 'Variação %', 'ROAS Hist.', 'Tipo Ajuste', 'Status', 'IA usa'].map(h => (
                          <th key={h} className="px-3 py-2 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {cRules
                        .sort((a, b) => a.start_hour - b.start_hour)
                        .map((r, i) => {
                          const isPeak    = ['peak_high_profit', 'peak_conversion'].includes(r.classification);
                          const isDeficit = ['deficit', 'low_efficiency'].includes(r.classification);
                          return (
                            <tr key={i} className="border-b border-surface-2/40 hover:bg-surface-2/40 transition-colors">
                              <td className="px-3 py-2 font-mono text-white font-bold">{String(r.start_hour).padStart(2,'0')}h</td>
                              <td className="px-3 py-2"><ClassBadge cls={r.classification} size="xs" /></td>
                              <td className="px-3 py-2 font-mono text-slate-400">R${(r.bid_base_before || 0).toFixed(2)}</td>
                              <td className={`px-3 py-2 font-mono font-bold ${isPeak ? 'text-emerald-400' : isDeficit ? 'text-amber-400' : 'text-slate-300'}`}>
                                R${(r.recommended_bid || r.bid_floor || 0).toFixed(2)}
                              </td>
                              <td className={`px-3 py-2 font-semibold ${r.adjustment_value >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                {r.adjustment_value >= 0 ? '+' : ''}{r.adjustment_value}%
                              </td>
                              <td className="px-3 py-2 text-slate-300">
                                {r.roas_at_creation > 0 ? `${r.roas_at_creation.toFixed(2)}x` : '—'}
                              </td>
                              <td className="px-3 py-2 text-slate-400 capitalize">{r.adjustment_type}</td>
                              <td className="px-3 py-2">
                                <span className={`text-[10px] px-1.5 py-0.5 rounded-full border font-medium ${r.status === 'active' ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-400' : 'bg-slate-400/10 border-slate-400/20 text-slate-400'}`}>
                                  {r.status}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-[10px] text-slate-500 max-w-[150px] truncate" title={CLASS_CONFIG[r.classification]?.action}>
                                {CLASS_CONFIG[r.classification]?.action}
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>

                {/* Rationale da primeira regra (contexto IA) */}
                {cRules[0]?.rationale && (
                  <div className="mt-3 p-3 bg-surface-2/60 rounded-lg border border-surface-3">
                    <p className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider mb-1">Contexto IA</p>
                    <p className="text-xs text-slate-400 leading-relaxed">{cRules[0].rationale}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Tabela de decisões pendentes de dayparting ─────────────────────────────────
function PendingDecisionsTable({ decisions, onApprove, onReject, loading }) {
  if (!decisions.length) return (
    <div className="flex flex-col items-center justify-center py-12 text-center gap-2">
      <CheckCircle className="w-8 h-8 text-emerald-400/30" />
      <p className="text-sm text-slate-400">Nenhuma decisão de dayparting pendente.</p>
    </div>
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-surface-2">
            {['Campanha', 'Confiança', 'Janelas Pico', 'Janelas Baixa', 'Bid Base', 'Risco', 'Gerado em', 'Ação'].map(h => (
              <th key={h} className="px-4 py-3 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {decisions.map(dec => {
            let dataUsed = {};
            try { dataUsed = JSON.parse(dec.data_used || '{}'); } catch {}
            const conf = dec.confidence || 0;
            const schedule = dataUsed.dayparting_schedule || [];
            const peakCount    = schedule.filter(s => ['peak_high_profit', 'peak_conversion'].includes(s.classification)).length;
            const deficitCount = schedule.filter(s => ['deficit', 'low_efficiency'].includes(s.classification)).length;
            const baseBid      = dataUsed.base_bid || 0;

            return (
              <tr key={dec.id} className="border-b border-surface-2/40 hover:bg-surface-2/40 transition-colors">
                <td className="px-4 py-3 font-mono text-white text-xs truncate max-w-[160px]">{dec.campaign_id}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1.5">
                    <div className="w-14 h-1.5 bg-surface-3 rounded-full overflow-hidden">
                      <div className="h-full bg-cyan rounded-full" style={{ width: `${conf}%` }} />
                    </div>
                    <span className={`font-semibold ${conf >= 90 ? 'text-emerald-400' : conf >= 70 ? 'text-amber-400' : 'text-slate-400'}`}>{conf}%</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-emerald-400 font-bold">{peakCount > 0 ? `${peakCount}h ↑` : '—'}</td>
                <td className="px-4 py-3 text-amber-400 font-bold">{deficitCount > 0 ? `${deficitCount}h R$0,25` : '—'}</td>
                <td className="px-4 py-3 font-mono text-slate-300">{baseBid > 0 ? `R$${baseBid.toFixed(2)}` : '—'}</td>
                <td className="px-4 py-3">
                  <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${dec.risk === 'low' ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-400' : 'bg-amber-400/10 border-amber-400/20 text-amber-400'}`}>
                    {dec.risk}
                  </span>
                </td>
                <td className="px-4 py-3 text-slate-500 whitespace-nowrap">
                  {dec.created_at ? new Date(dec.created_at).toLocaleDateString('pt-BR') : '—'}
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-1.5">
                    <button onClick={() => onApprove(dec)} disabled={loading}
                      className="flex items-center gap-1 px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold rounded-lg transition-colors disabled:opacity-50">
                      <CheckCircle className="w-3 h-3" /> Aprovar
                    </button>
                    <button onClick={() => onReject(dec)} disabled={loading}
                      className="px-2 py-1.5 bg-surface-2 border border-surface-3 text-slate-400 hover:text-red-400 text-[10px] rounded-lg transition-colors disabled:opacity-50">
                      <XCircle className="w-3 h-3" />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Página principal ───────────────────────────────────────────────────────────
export default function DaypartingDashboard() {
  const [account, setAccount]           = useState(null);
  const [loadingRules, setLoadingRules] = useState(true);
  const [runningAnalysis, setRunningAnalysis] = useState(false);
  const [activeRules, setActiveRules]   = useState([]);
  const [pendingDecs, setPendingDecs]   = useState([]);
  const [executedDecs, setExecutedDecs] = useState([]);
  const [applyingId, setApplyingId]     = useState(null);
  const [msg, setMsg]                   = useState(null);
  const [tab, setTab]                   = useState('rules');

  const loadData = useCallback(async () => {
    setLoadingRules(true);
    try {
      const me = await base44.auth.me();
      const accs = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accs[0] || null;
      setAccount(acc);
      if (!acc) return;

      const [rules, allDecs] = await Promise.all([
        base44.entities.DaypartingRule.filter({ amazon_account_id: acc.id }, '-created_at', 500),
        base44.entities.OptimizationDecision.filter(
          { amazon_account_id: acc.id, decision_type: 'dayparting_rule' }, '-created_at', 100
        ),
      ]);

      setActiveRules(rules.filter(r => r.status === 'active'));
      setPendingDecs(allDecs.filter(d => d.status === 'pending'));
      setExecutedDecs(allDecs.filter(d => ['executed', 'approved', 'failed'].includes(d.status)).slice(0, 50));
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setLoadingRules(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Rodar análise automática (runDailyDayparting) ─────────────────────────
  const runAnalysis = async () => {
    if (!account) return;
    setRunningAnalysis(true);
    setMsg(null);
    try {
      const res = await base44.functions.invoke('runDailyDayparting', { amazon_account_id: account.id });
      const d = res.data;
      if (d?.ok) {
        const { stats } = d;
        setMsg({ type: 'success', text: `✓ ${stats.analyzed} campanhas analisadas · ${stats.auto_applied} aplicadas automaticamente · ${stats.pending_review} aguardam revisão · ${stats.skipped_no_data} sem dados suficientes` });
        await loadData();
      } else {
        setMsg({ type: d?.skipped ? 'warn' : 'error', text: d?.reason || d?.error || 'Erro desconhecido' });
      }
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setRunningAnalysis(false);
      setTimeout(() => setMsg(null), 15000);
    }
  };

  // ── Aprovar decisão pendente ──────────────────────────────────────────────
  const approveDec = async (dec) => {
    setApplyingId(dec.id);
    try {
      const res = await base44.functions.invoke('applyDaypartingSchedule', {
        opportunity_id: dec.id,
        approve: true,
      });
      if (res.data?.ok) {
        setMsg({ type: 'success', text: `✓ Dayparting aplicado para campanha ${dec.campaign_id}` });
        await loadData();
      } else {
        setMsg({ type: 'error', text: res.data?.error || 'Falha ao aplicar' });
      }
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setApplyingId(null);
      setTimeout(() => setMsg(null), 10000);
    }
  };

  const rejectDec = async (dec) => {
    await base44.entities.OptimizationDecision.update(dec.id, { status: 'rejected' }).catch(() => {});
    setPendingDecs(prev => prev.filter(d => d.id !== dec.id));
  };

  // ── KPIs resumidos ────────────────────────────────────────────────────────
  const peakRulesCount    = activeRules.filter(r => ['peak_high_profit', 'peak_conversion'].includes(r.classification)).length;
  const deficitRulesCount = activeRules.filter(r => ['deficit', 'low_efficiency'].includes(r.classification)).length;
  const campaignsWithRules = new Set(activeRules.map(r => r.campaign_id)).size;

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
            <Clock className="w-5 h-5 text-cyan" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Dayparting por Frequência de Vendas</h1>
            <p className="text-xs text-slate-400">Bids ajustados por faixa horária via análise de HourlyMetrics · R$0,25 na baixa · +130% no pico</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={loadData} disabled={loadingRules}
            className="p-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors disabled:opacity-50">
            <RefreshCw className={`w-4 h-4 ${loadingRules ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={runAnalysis} disabled={runningAnalysis || !account}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold rounded-lg disabled:opacity-60 transition-colors">
            {runningAnalysis ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            {runningAnalysis ? 'Analisando...' : 'Executar Análise de Dayparting'}
          </button>
        </div>
      </div>

      {/* Mensagem de status */}
      {msg && (
        <div className={`p-3 rounded-xl border text-sm font-medium ${
          msg.type === 'success' ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300' :
          msg.type === 'warn'    ? 'bg-amber-400/10 border-amber-400/20 text-amber-300' :
                                   'bg-red-400/10 border-red-400/20 text-red-400'
        }`}>
          {msg.text}
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'Campanhas com Regras', value: campaignsWithRules, color: 'text-cyan', bg: 'bg-cyan/5 border-cyan/20' },
          { label: 'Janelas de Pico Ativas', value: peakRulesCount, color: 'text-emerald-400', bg: 'bg-emerald-500/5 border-emerald-500/20', sub: 'bid +100% a +130%' },
          { label: 'Janelas de Baixa Ativas', value: deficitRulesCount, color: 'text-amber-400', bg: 'bg-amber-500/5 border-amber-500/20', sub: 'bid = R$0,25' },
          { label: 'Pendentes Aprovação', value: pendingDecs.length, color: pendingDecs.length > 0 ? 'text-red-400' : 'text-slate-400', bg: 'bg-surface-1 border-surface-2' },
        ].map(k => (
          <div key={k.label} className={`rounded-xl border p-4 ${k.bg}`}>
            <p className="text-xs text-slate-500 mb-1">{k.label}</p>
            <p className={`text-2xl font-bold ${k.color}`}>{k.value}</p>
            {k.sub && <p className="text-[10px] text-slate-500 mt-0.5">{k.sub}</p>}
          </div>
        ))}
      </div>

      {/* Aviso sem conta */}
      {!loadingRules && !account && (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <AlertTriangle className="w-10 h-10 text-amber-400/40" />
          <p className="text-sm text-slate-400">Nenhuma conta Amazon configurada.</p>
        </div>
      )}

      {account && (
        <>
          {/* Tabs */}
          <div className="flex border-b border-surface-2">
            {[
              { id: 'rules',   label: `Regras Ativas (${activeRules.length > 0 ? new Set(activeRules.map(r=>r.campaign_id)).size : 0} camp.)`, icon: Database },
              { id: 'pending', label: `Aguardando Aprovação (${pendingDecs.length})`, icon: AlertTriangle },
              { id: 'history', label: `Histórico (${executedDecs.length})`, icon: BarChart2 },
            ].map(t => {
              const Icon = t.icon;
              return (
                <button key={t.id} onClick={() => setTab(t.id)}
                  className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${tab === t.id ? 'border-cyan text-cyan' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
                  <Icon className="w-3.5 h-3.5" />{t.label}
                </button>
              );
            })}
          </div>

          {/* Conteúdo das tabs */}
          {tab === 'rules' && (
            <RulesTable rules={activeRules} loading={loadingRules} onRefresh={loadData} />
          )}

          {tab === 'pending' && (
            <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b border-surface-2">
                <h3 className="text-sm font-semibold text-white">Decisões de Dayparting — Aguardando Aprovação</h3>
                <p className="text-xs text-slate-500 mt-0.5">Confiança abaixo de 90% ou nível de autonomia exige aprovação manual.</p>
              </div>
              <PendingDecisionsTable
                decisions={pendingDecs}
                onApprove={approveDec}
                onReject={rejectDec}
                loading={!!applyingId}
              />
            </div>
          )}

          {tab === 'history' && (
            <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b border-surface-2">
                <h3 className="text-sm font-semibold text-white">Histórico de Execuções de Dayparting</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-surface-2">
                      {['Campanha', 'Confiança', 'Status', 'Janelas Pico', 'Janelas Baixa', 'Executado em', 'Resposta Amazon'].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {!executedDecs.length ? (
                      <tr><td colSpan={7} className="px-5 py-10 text-center text-sm text-slate-500">Nenhum histórico de dayparting executado.</td></tr>
                    ) : executedDecs.map(dec => {
                      let dataUsed = {}; try { dataUsed = JSON.parse(dec.data_used || '{}'); } catch {}
                      let amazonResp = {}; try { amazonResp = JSON.parse(dec.amazon_response || '{}'); } catch {}
                      const schedule = dataUsed.dayparting_schedule || [];
                      const peakC = schedule.filter(s => ['peak_high_profit', 'peak_conversion'].includes(s.classification)).length;
                      const defC  = schedule.filter(s => ['deficit', 'low_efficiency'].includes(s.classification)).length;
                      const conf  = dec.confidence || 0;
                      return (
                        <tr key={dec.id} className="border-b border-surface-2/40 hover:bg-surface-2/40">
                          <td className="px-4 py-3 font-mono text-white text-xs truncate max-w-[160px]">{dec.campaign_id}</td>
                          <td className="px-4 py-3">
                            <span className={`font-semibold ${conf >= 90 ? 'text-emerald-400' : conf >= 70 ? 'text-amber-400' : 'text-slate-400'}`}>{conf}%</span>
                          </td>
                          <td className="px-4 py-3">
                            <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${
                              dec.status === 'executed' ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-400' :
                              dec.status === 'failed'   ? 'bg-red-400/10 border-red-400/20 text-red-400' :
                              'bg-amber-400/10 border-amber-400/20 text-amber-400'
                            }`}>{dec.status}</span>
                          </td>
                          <td className="px-4 py-3 text-emerald-400 font-bold">{peakC > 0 ? `${peakC}h` : '—'}</td>
                          <td className="px-4 py-3 text-amber-400 font-bold">{defC > 0 ? `${defC}h` : '—'}</td>
                          <td className="px-4 py-3 text-slate-500 whitespace-nowrap">
                            {dec.executed_at ? new Date(dec.executed_at).toLocaleString('pt-BR') : '—'}
                          </td>
                          <td className="px-4 py-3 text-slate-500 text-[10px]">
                            {amazonResp.rules_created != null ? `${amazonResp.rules_created} regras criadas` : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Legenda IA */}
          <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Como a IA usa esses dados</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {Object.entries(CLASS_CONFIG).filter(([k]) => k !== 'insufficient_data').map(([cls, cfg]) => (
                <div key={cls} className="flex items-start gap-2 p-3 bg-surface-2/50 rounded-lg">
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 mt-1 ${cfg.dot}`} />
                  <div>
                    <p className="text-xs font-semibold text-white">{cfg.label}</p>
                    <p className="text-[10px] text-slate-400 mt-0.5">{cfg.action}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}