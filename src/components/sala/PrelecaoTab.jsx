import React, { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Brain, RefreshCw, CheckCircle, AlertTriangle, XCircle, Clock,
  Target, TrendingUp, Zap, Shield, ChevronDown, ChevronRight, Loader2 } from
'lucide-react';

const fmt = (v, d = 2) => Number(v || 0).toFixed(d);
const fmtBRL = (v) => `R$${fmt(v)}`;
const fmtPct = (v) => `${fmt(v, 1)}%`;

function GoalBadge({ status }) {
  if (!status || status === 'no_data') return <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-700 text-slate-400">Sem dados</span>;
  const map = { ok: 'bg-emerald-500/15 text-emerald-400', warning: 'bg-amber-500/15 text-amber-400', critical: 'bg-red-500/15 text-red-400' };
  const label = { ok: '✓ OK', warning: '⚠ Atenção', critical: '✗ Crítico' };
  return <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${map[status] || 'bg-slate-700 text-slate-400'}`}>{label[status] || status}</span>;
}

function TermRow({ term, idx }) {
  const [expanded, setExpanded] = useState(false);
  const acosColor = term.acos <= 10 ? 'text-emerald-400' : term.acos <= 15 ? 'text-amber-400' : 'text-red-400';
  return (
    <>
      <tr className="border-b border-surface-2/40 hover:bg-surface-2/30 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <td className="px-3 py-2.5 text-[10px] text-slate-500">{idx + 1}</td>
        <td className="px-3 py-2.5 font-mono text-[10px] text-cyan">{term.asin || '—'}</td>
        <td className="px-3 py-2.5 text-xs font-semibold text-white">{term.search_term || term.keyword || '—'}</td>
        <td className="px-3 py-2.5 text-[10px] text-slate-400">{term.campaign_type || 'AUTO'}</td>
        <td className="px-3 py-2.5 text-xs text-cyan">{term.orders || 0}</td>
        <td className="px-3 py-2.5 text-xs text-emerald-400">{fmtBRL(term.sales)}</td>
        <td className="px-3 py-2.5 text-xs"><span className={acosColor}>{term.acos ? fmtPct(term.acos) : '—'}</span></td>
        <td className="px-3 py-2.5 text-xs text-slate-300">{term.roas ? `${fmt(term.roas)}x` : '—'}</td>
        <td className="px-3 py-2.5 text-slate-500">{expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}</td>
      </tr>
      {expanded &&
      <tr className="bg-surface-2/20">
          <td colSpan={9} className="px-4 py-2 text-[10px] text-slate-400">{term.reason || 'Sem detalhes.'}</td>
        </tr>
      }
    </>);

}

export default function PrelecaoTab({ account }) {
  const [prelections, setPrelections] = useState([]);
  const [selected, setSelected] = useState(null);
  const [proposals, setProposals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState(null);
  const [tab, setTab] = useState('overview');

  const load = useCallback(async () => {
    if (!account) return;
    setLoading(true);
    try {
      const [preList, propList] = await Promise.all([
      base44.entities.WeeklyMotorPrelection.filter({ amazon_account_id: account.id }, '-created_at', 10),
      base44.entities.MotorRuleChangeProposal.filter({ amazon_account_id: account.id }, '-created_at', 50)]
      );
      setPrelections(preList);
      setProposals(propList);
      if (preList.length > 0) setSelected(preList[0]);
    } finally {setLoading(false);}
  }, [account]);

  useEffect(() => {load();}, [load]);

  const runPrelection = async (dryRun = false) => {
    if (!account || running) return;
    setRunning(true);
    setRunMsg({ type: 'info', text: dryRun ? 'Simulando preleção...' : 'Executando preleção semanal — pode levar 1–2 minutos...' });
    try {
      const res = await base44.functions.invoke('runWeeklyMotorPrelection', { amazon_account_id: account.id, dry_run: dryRun, force: true });
      const d = res?.data;
      if (d?.ok) {
        setRunMsg({ type: 'success', text: `${dryRun ? '[Simulação] ' : ''}Preleção concluída — ${d.winning_terms_found} termos vencedores · ${d.campaigns_created} campanhas criadas` });
        await load();
      } else if (d?.skipped) {
        setRunMsg({ type: 'info', text: d.reason });
      } else {
        setRunMsg({ type: 'error', text: d?.error || 'Erro na preleção.' });
      }
    } catch (e) {
      setRunMsg({ type: 'error', text: e.message });
    } finally {
      setRunning(false);
      setTimeout(() => setRunMsg(null), 12000);
    }
  };

  const nextRun = (() => {
    const now = new Date();
    const brt = new Date(now.getTime() - 3 * 3600000);
    const dow = brt.getUTCDay();
    const daysUntilMonday = (8 - dow) % 7 || 7;
    const next = new Date(brt.getTime() + daysUntilMonday * 86400000);
    next.setUTCHours(9, 0, 0, 0);
    return next.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }) + ' às 06h00';
  })();

  const s = selected;
  const goalStatus = s?.goal_status || {};
  const winningTerms = s?.winning_terms || [];
  const losingCampaigns = s?.losing_campaigns || [];
  const manualCampaignsCreated = s?.manual_campaigns_created || [];
  const selProposals = s ? proposals.filter((p) => p.weekly_prelection_id === s.id) : proposals.slice(0, 20);

  const TABS = [
  { id: 'overview', label: 'Visão Geral' },
  { id: 'terms', label: `Termos Vencedores (${winningTerms.length})` },
  { id: 'losing', label: `Campanhas Ruins (${losingCampaigns.length})` },
  { id: 'rules', label: `Regras (${selProposals.length})` },
  { id: 'campaigns', label: `Campanhas Criadas (${manualCampaignsCreated.length})` },
  { id: 'history', label: `Histórico (${prelections.length})` }];


  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-violet-500/20 border border-violet-500/30 flex items-center justify-center">
            <Brain className="w-5 h-5 text-violet-400" />
          </div>
          <div>
            <h2 className="text-base font-bold text-white">Preleção Semanal do Motor</h2>
            <p className="text-xs text-slate-500">Claude analisa a semana e propõe melhorias · próxima automática: <span className="text-slate-300">{nextRun}</span></p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {prelections.length > 0 && prelections[0].completed_at &&
          <span className="flex items-center gap-1 text-[10px] text-slate-400">
              <CheckCircle className="w-3 h-3 text-emerald-400" />
              Último: {new Date(prelections[0].completed_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
            </span>
          }
          <button onClick={load} disabled={loading} className="p-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={() => runPrelection(true)} disabled={running || !account}
          className="flex items-center gap-1.5 px-3 py-2 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-xs font-semibold rounded-lg disabled:opacity-50 hidden">
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
            Simular
          </button>
          <button onClick={() => runPrelection(false)} disabled={running || !account}
          className="flex items-center gap-1.5 px-3 py-2 bg-violet-500/20 border border-violet-500/30 text-violet-300 hover:bg-violet-500/30 text-xs font-semibold rounded-lg disabled:opacity-50 hidden">
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Brain className="w-3.5 h-3.5" />}
            Executar Preleção
          </button>
        </div>
      </div>

      {runMsg &&
      <div className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border text-xs ${runMsg.type === 'success' ? 'bg-emerald-500/8 border-emerald-500/20 text-emerald-300' : runMsg.type === 'error' ? 'bg-red-500/8 border-red-500/20 text-red-300' : 'bg-cyan/8 border-cyan/20 text-cyan'}`}>
          {runMsg.type === 'success' ? <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" /> : runMsg.type === 'error' ? <XCircle className="w-3.5 h-3.5 flex-shrink-0" /> : <Clock className="w-3.5 h-3.5 flex-shrink-0" />}
          {runMsg.text}
        </div>
      }

      {loading ?
      <div className="flex justify-center py-16"><Loader2 className="w-5 h-5 text-violet-400 animate-spin" /></div> :
      prelections.length === 0 ?
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-10 text-center">
          <Brain className="w-8 h-8 text-violet-400/50 mx-auto mb-3" />
          <p className="text-sm text-slate-400">Nenhuma preleção realizada ainda.</p>
        </div> :
      s &&
      <>
          <div className="flex items-center justify-between px-4 py-2.5 bg-surface-1 border border-surface-2 rounded-xl text-xs flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${s.status === 'completed' ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'}`} />
              <span className="text-slate-400">Semana {s.week_start} – {s.week_end}</span>
              <span className="text-slate-600">·</span>
              <span className="text-slate-500">Confiança: <span className="text-white font-semibold">{s.confidence ? `${(s.confidence * 100).toFixed(0)}%` : '—'}</span></span>
            </div>
            {s.requires_manual_review &&
          <span className="flex items-center gap-1 text-amber-400 text-[10px] border border-amber-500/20 bg-amber-500/8 px-2 py-1 rounded-lg">
                <AlertTriangle className="w-3 h-3" /> Revisão manual necessária
              </span>
          }
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {[
          { label: 'ACoS', value: fmtPct(s.acos), target: `${s.target_acos}%`, status: goalStatus.acos },
          { label: 'ROAS', value: `${fmt(s.roas)}x`, target: `${s.target_roas}x`, status: goalStatus.roas },
          { label: 'CPC Médio', value: fmtBRL(s.avg_cpc), status: goalStatus.cpc },
          { label: 'Gasto', value: fmtBRL(s.total_spend), sub: `R$${s.daily_budget_cap}/dia` },
          { label: 'Vendas', value: fmtBRL(s.total_sales), sub: `${s.total_orders} pedidos` }].
          map((c, i) =>
          <div key={i} className="bg-surface-1 border border-surface-2 rounded-xl p-4">
                <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-1">{c.label}</p>
                <p className="text-xl font-bold text-white">{c.value}</p>
                {c.target && <p className="text-[10px] text-slate-500">Meta: {c.target}</p>}
                {c.status && <GoalBadge status={c.status} />}
                {c.sub && <p className="text-[10px] text-slate-500 mt-0.5">{c.sub}</p>}
              </div>
          )}
          </div>

          {s.executive_summary &&
        <div className="bg-violet-500/5 border border-violet-500/15 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2"><Brain className="w-4 h-4 text-violet-400" /><span className="text-xs font-semibold text-violet-300">Resumo do Claude</span></div>
              <p className="text-xs text-slate-300 leading-relaxed">{s.executive_summary}</p>
            </div>
        }

          <div className="flex gap-1 border-b border-surface-2 overflow-x-auto scrollbar-thin">
            {TABS.map((t) =>
          <button key={t.id} onClick={() => setTab(t.id)}
          className={`px-3 py-2.5 text-xs whitespace-nowrap transition-colors ${tab === t.id ? 'border-b-2 border-violet-400 text-violet-300' : 'text-slate-500 hover:text-slate-300'}`}>
                {t.label}
              </button>
          )}
          </div>

          {tab === 'overview' &&
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
                <h3 className="text-xs font-semibold text-slate-300 mb-3">Status das Metas</h3>
                <div className="space-y-2">
                  {[
              { label: 'ACoS', real: fmtPct(s.acos), meta: `${s.target_acos}%`, status: goalStatus.acos },
              { label: 'ROAS', real: `${fmt(s.roas)}x`, meta: `${s.target_roas}x`, status: goalStatus.roas },
              { label: 'Budget/dia', real: fmtBRL(s.total_spend / 7), meta: `R$${s.daily_budget_cap}`, status: goalStatus.budget }].
              map((m) =>
              <div key={m.label} className="flex items-center justify-between py-2 border-b border-surface-2/40 last:border-0">
                      <span className="text-xs text-slate-400">{m.label}</span>
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-bold text-white">{m.real}</span>
                        <span className="text-[10px] text-slate-600">Meta: {m.meta}</span>
                        <GoalBadge status={m.status} />
                      </div>
                    </div>
              )}
                </div>
              </div>
              <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
                <h3 className="text-xs font-semibold text-slate-300 mb-3">Resumo da Análise</h3>
                <p className="text-xs text-slate-400 leading-relaxed">{s.summary || 'Sem resumo disponível.'}</p>
              </div>
            </div>
        }

          {tab === 'terms' &&
        <div className="overflow-hidden rounded-xl border border-surface-2 bg-surface-1">
              {winningTerms.length === 0 ?
          <div className="py-10 text-center text-xs text-slate-600">Nenhum termo vencedor identificado.</div> :

          <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="border-b border-surface-2 bg-surface-2/40">
                      {['#', 'ASIN', 'Search Term', 'Tipo', 'Pedidos', 'Vendas', 'ACoS', 'ROAS', ''].map((h) =>
                  <th key={h} className="px-3 py-2.5 text-left text-[10px] uppercase text-slate-500">{h}</th>
                  )}
                    </tr></thead>
                    <tbody>{winningTerms.map((t, i) => <TermRow key={i} term={t} idx={i} />)}</tbody>
                  </table>
                </div>
          }
            </div>
        }

          {tab === 'losing' &&
        <div className="overflow-hidden rounded-xl border border-surface-2 bg-surface-1">
              {losingCampaigns.length === 0 ?
          <div className="py-10 text-center text-xs text-slate-600">Nenhuma campanha problemática.</div> :

          <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="border-b border-surface-2 bg-surface-2/40">
                      {['Campaign ID', 'Motivo', 'Confiança', 'Ação Recomendada'].map((h) =>
                  <th key={h} className="px-3 py-2.5 text-left text-[10px] uppercase text-slate-500">{h}</th>
                  )}
                    </tr></thead>
                    <tbody>
                      {losingCampaigns.map((c, i) =>
                <tr key={i} className="border-b border-surface-2/40">
                          <td className="px-3 py-2.5 font-mono text-[10px] text-cyan">{(c.campaign_id || '').slice(0, 20)}</td>
                          <td className="px-3 py-2.5 text-xs text-slate-300 max-w-xs">{c.reason}</td>
                          <td className="px-3 py-2.5 text-xs font-bold text-amber-400">{c.confidence ? `${(c.confidence * 100).toFixed(0)}%` : '—'}</td>
                          <td className="px-3 py-2.5 text-xs text-amber-400">{(c.recommended_action || '').replace(/_/g, ' ')}</td>
                        </tr>
                )}
                    </tbody>
                  </table>
                </div>
          }
            </div>
        }

          {tab === 'rules' &&
        <div className="overflow-hidden rounded-xl border border-surface-2 bg-surface-1">
              {selProposals.length === 0 ?
          <div className="py-10 text-center text-xs text-slate-600">Nenhuma proposta de regra.</div> :

          <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="border-b border-surface-2 bg-surface-2/40">
                      {['Regra', 'Atual', 'Proposta', 'Confiança', 'Risco', 'Status'].map((h) =>
                  <th key={h} className="px-3 py-2.5 text-left text-[10px] uppercase text-slate-500">{h}</th>
                  )}
                    </tr></thead>
                    <tbody>
                      {selProposals.map((p, i) =>
                <tr key={i} className="border-b border-surface-2/40 hover:bg-surface-2/30">
                          <td className="px-3 py-2.5 text-xs font-semibold text-white">{p.rule_name}</td>
                          <td className="px-3 py-2.5 text-[10px] text-slate-400 max-w-[150px] truncate">{p.current_rule}</td>
                          <td className="px-3 py-2.5 text-[10px] text-cyan max-w-[150px] truncate">{p.proposed_rule}</td>
                          <td className="px-3 py-2.5 text-[10px] font-bold text-emerald-400">{(p.confidence * 100).toFixed(0)}%</td>
                          <td className="px-3 py-2.5">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${p.risk_level === 'low' ? 'bg-emerald-500/10 text-emerald-400' : p.risk_level === 'medium' ? 'bg-amber-500/10 text-amber-400' : 'bg-red-500/10 text-red-400'}`}>{p.risk_level}</span>
                          </td>
                          <td className="px-3 py-2.5">
                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${{ proposed: 'bg-amber-500/10 text-amber-400', approved: 'bg-emerald-500/10 text-emerald-400', rejected: 'bg-red-500/10 text-red-400', implemented: 'bg-cyan/10 text-cyan' }[p.status] || 'bg-slate-700 text-slate-400'}`}>{p.status}</span>
                          </td>
                        </tr>
                )}
                    </tbody>
                  </table>
                </div>
          }
            </div>
        }

          {tab === 'campaigns' &&
        <div className="overflow-hidden rounded-xl border border-surface-2 bg-surface-1">
              {manualCampaignsCreated.length === 0 ?
          <div className="py-10 text-center text-xs text-slate-600">Nenhuma campanha criada nesta preleção.</div> :

          <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="border-b border-surface-2 bg-surface-2/40">
                      {['ASIN', 'Keyword', 'Status', 'CampaignId', 'Erro'].map((h) =>
                  <th key={h} className="px-3 py-2.5 text-left text-[10px] uppercase text-slate-500">{h}</th>
                  )}
                    </tr></thead>
                    <tbody>
                      {manualCampaignsCreated.map((c, i) =>
                <tr key={i} className="border-b border-surface-2/40">
                          <td className="px-3 py-2.5 font-mono text-[10px] text-cyan">{c.asin}</td>
                          <td className="px-3 py-2.5 text-xs text-white">{c.keyword}</td>
                          <td className="px-3 py-2.5"><span className={`text-[10px] px-2 py-0.5 rounded-full ${c.status === 'created' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>{c.status}</span></td>
                          <td className="px-3 py-2.5 font-mono text-[10px] text-slate-400">{c.campaign_id || '—'}</td>
                          <td className="px-3 py-2.5 text-[10px] text-red-400">{c.error || '—'}</td>
                        </tr>
                )}
                    </tbody>
                  </table>
                </div>
          }
            </div>
        }

          {tab === 'history' &&
        <div className="space-y-2">
              {prelections.map((p) =>
          <div key={p.id} onClick={() => setSelected(p)}
          className={`flex items-center justify-between px-4 py-3 rounded-xl border cursor-pointer transition-colors ${selected?.id === p.id ? 'border-violet-500/40 bg-violet-500/8' : 'border-surface-2 bg-surface-1 hover:border-surface-3'}`}>
                  <div className="flex items-center gap-3">
                    <span className={`w-2 h-2 rounded-full ${p.status === 'completed' ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'}`} />
                    <div>
                      <p className="text-xs font-semibold text-slate-200">{p.week_start} – {p.week_end}</p>
                      <p className="text-[10px] text-slate-500">{p.campaigns_analyzed} campanhas · {p.winning_terms_count || 0} termos vencedores</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <p className="text-xs font-bold text-white">ACoS {fmtPct(p.acos)}</p>
                    <GoalBadge status={p.goal_status?.acos} />
                  </div>
                </div>
          )}
            </div>
        }
        </>
      }
    </div>);

}