import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { Loader2, RefreshCw, TrendingUp, TrendingDown, AlertTriangle, CheckCircle, Clock, Play, FileText } from 'lucide-react';

const fmt = (v, type = 'currency') => {
  if (v == null || isNaN(v)) return '—';
  if (type === 'currency') return `R$${Number(v).toFixed(2)}`;
  if (type === 'pct') return `${Number(v).toFixed(1)}%`;
  if (type === 'num') return Number(v).toLocaleString('pt-BR');
  return String(v);
};

const STATUS_CONFIG = {
  profitable:          { label: 'Lucrativo',        color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' },
  low_profit:          { label: 'Lucro Baixo',       color: 'text-yellow-400',  bg: 'bg-yellow-500/10 border-yellow-500/20' },
  break_even:          { label: 'Break-even',        color: 'text-slate-400',   bg: 'bg-slate-500/10 border-slate-500/20' },
  unprofitable:        { label: 'Deficitário',       color: 'text-red-400',     bg: 'bg-red-500/10 border-red-500/20' },
  no_sales_with_spend: { label: 'Gasto sem Vendas',  color: 'text-orange-400',  bg: 'bg-orange-500/10 border-orange-500/20' },
  insufficient_data:   { label: 'Dados Insuf.',      color: 'text-slate-500',   bg: 'bg-slate-500/5 border-slate-500/10' },
  stock_blocked:       { label: 'Sem Estoque',       color: 'text-amber-400',   bg: 'bg-amber-500/10 border-amber-500/20' },
  listing_blocked:     { label: 'Listing Bloqueado', color: 'text-red-400',     bg: 'bg-red-500/10 border-red-500/20' },
};

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.insufficient_data;
  return (
    <span className={`inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full border ${cfg.bg} ${cfg.color}`}>
      {cfg.label}
    </span>
  );
}

function KPICard({ label, value, sub, color = 'text-white', alert = false }) {
  return (
    <div className={`bg-surface-1 border rounded-xl p-4 ${alert ? 'border-red-500/30' : 'border-surface-2'}`}>
      <p className="text-xs text-slate-400 mb-1">{label}</p>
      <p className={`text-xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-[10px] text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );
}

export default function WeeklyReportView({ account }) {
  const [report, setReport] = useState(null);
  const [products, setProducts] = useState([]);
  const [decisions, setDecisions] = useState([]);
  const [dailyToday, setDailyToday] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [runningAssessment, setRunningAssessment] = useState(false);
  const [msg, setMsg] = useState(null);
  const [activeTab, setActiveTab] = useState('produtos');

  const load = useCallback(async () => {
    if (!account) return;
    setLoading(true);
    try {
      const aid = account.id;
      const [reports, prods, decs, daily] = await Promise.all([
        base44.entities.WeeklyAdsPerformanceReport.filter({ amazon_account_id: aid }, '-week_end', 1).catch(() => []),
        base44.entities.WeeklyProductPerformance.filter({ amazon_account_id: aid }, '-spend_7d', 100).catch(() => []),
        base44.entities.OptimizationDecision.filter({ amazon_account_id: aid }, '-created_at', 50).catch(() => []),
        base44.entities.DailyProductAdsAssessment.filter({ amazon_account_id: aid }, '-assessment_date', 50).catch(() => []),
      ]);
      setReport(reports[0] || null);
      setProducts(prods);
      setDecisions(decs);

      // Aferição do dia mais recente
      const latestDate = daily[0]?.assessment_date;
      setDailyToday(latestDate ? daily.filter(d => d.assessment_date === latestDate) : []);
    } finally {
      setLoading(false);
    }
  }, [account]);

  useEffect(() => { load(); }, [load]);

  const runAssessment = async () => {
    if (!account || runningAssessment) return;
    setRunningAssessment(true);
    setMsg(null);
    try {
      const res = await base44.functions.invoke('runDailyEconomicAssessment', {
        amazon_account_id: account.id, force: true,
      });
      const d = res.data;
      setMsg(d?.ok
        ? { type: 'success', text: `✓ Aferição concluída: ${d.stats?.products_evaluated || 0} produtos, ${d.stats?.unprofitable || 0} deficitários, ${d.decisions_signals || 0} sinais` }
        : { type: 'error', text: d?.error || 'Erro na aferição' });
      await load();
    } catch (e) { setMsg({ type: 'error', text: e.message }); }
    finally { setRunningAssessment(false); setTimeout(() => setMsg(null), 12000); }
  };

  const runWeeklyReport = async () => {
    if (!account || generating) return;
    setGenerating(true);
    setMsg(null);
    try {
      const res = await base44.functions.invoke('runWeeklyAdsPerformanceReport', {
        amazon_account_id: account.id, force: true,
      });
      const d = res.data;
      setMsg(d?.ok
        ? { type: 'success', text: `✓ Relatório gerado: ${d.week_start} a ${d.week_end} · ${d.products_analyzed} produtos · cobertura ${d.data_coverage_percent?.toFixed(0)}%` }
        : { type: 'error', text: d?.error || 'Erro ao gerar relatório' });
      await load();
    } catch (e) { setMsg({ type: 'error', text: e.message }); }
    finally { setGenerating(false); setTimeout(() => setMsg(null), 12000); }
  };

  // ── Aferição de hoje ───────────────────────────────────────────────────────
  const latestAssessmentDate = dailyToday[0]?.assessment_date;
  const todayAlerts = dailyToday.filter(d => ['unprofitable', 'no_sales_with_spend'].includes(d.economic_status));
  const todayDecisions48h = decisions.filter(d => {
    const ts = new Date(d.created_at || 0).getTime();
    return Date.now() - ts < 48 * 3600000;
  });

  // Filtrar WeeklyProductPerformance pelo relatório atual
  const reportProducts = report ? products.filter(p => p.week_start === report.week_start && p.week_end === report.week_end) : products.slice(0, 50);
  const decisionsWeek = report ? decisions.filter(d =>
    d.created_at && d.created_at.slice(0, 10) >= (report.week_start || '') &&
    d.created_at.slice(0, 10) <= (report.week_end || '')
  ) : [];

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <Loader2 className="w-6 h-6 text-cyan animate-spin" />
    </div>
  );

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-base font-bold text-white">Aferição Econômica & Relatório Semanal</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            {report ? `Semana ${report.week_start} a ${report.week_end}` : 'Nenhum relatório gerado ainda'}
            {report?.data_coverage_percent != null && (
              <span className={`ml-2 ${report.data_coverage_percent < 70 ? 'text-amber-400' : 'text-emerald-400'}`}>
                · {report.data_coverage_percent.toFixed(0)}% cobertura
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={load} disabled={loading}
            className="p-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={runAssessment} disabled={runningAssessment || !account}
            className="flex items-center gap-2 px-3 py-2 bg-cyan/10 border border-cyan/20 text-cyan hover:bg-cyan/20 text-xs font-semibold rounded-lg disabled:opacity-50">
            {runningAssessment ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            {runningAssessment ? 'Aferindo...' : 'Aferir Hoje'}
          </button>
          <button onClick={runWeeklyReport} disabled={generating || !account}
            className="flex items-center gap-2 px-3 py-2 bg-violet-500/10 border border-violet-500/20 text-violet-300 hover:bg-violet-500/20 text-xs font-semibold rounded-lg disabled:opacity-50">
            {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
            {generating ? 'Gerando...' : 'Gerar Relatório Semanal'}
          </button>
        </div>
      </div>

      {msg && (
        <div className={`px-4 py-3 rounded-xl border text-sm font-medium ${msg.type === 'success' ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300' : 'bg-red-400/10 border-red-400/20 text-red-400'}`}>
          {msg.text}
        </div>
      )}

      {/* ── Aferição de Hoje ─────────────────────────────────────────────────── */}
      <div className="bg-surface-1 border border-cyan/20 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <Clock className="w-4 h-4 text-cyan" />
          <p className="text-sm font-semibold text-white">Aferição do Dia</p>
          {latestAssessmentDate && <span className="text-xs text-slate-500">{latestAssessmentDate}</span>}
        </div>
        {dailyToday.length === 0 ? (
          <p className="text-xs text-slate-500">Nenhuma aferição diária disponível. Clique em "Aferir Hoje" para processar.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-surface-2/50 rounded-lg p-3">
              <p className="text-[10px] text-slate-500 mb-1">Produtos Avaliados</p>
              <p className="text-lg font-bold text-white">{dailyToday.length}</p>
            </div>
            <div className="bg-red-500/8 border border-red-500/15 rounded-lg p-3">
              <p className="text-[10px] text-slate-500 mb-1">Alertas Econômicos</p>
              <p className="text-lg font-bold text-red-400">{todayAlerts.length}</p>
            </div>
            <div className="bg-surface-2/50 rounded-lg p-3">
              <p className="text-[10px] text-slate-500 mb-1">Decisões (48h)</p>
              <p className="text-lg font-bold text-amber-400">{todayDecisions48h.length}</p>
            </div>
            <div className="bg-surface-2/50 rounded-lg p-3">
              <p className="text-[10px] text-slate-500 mb-1">Reaval. em 48h</p>
              <p className="text-lg font-bold text-violet-400">
                {todayDecisions48h.filter(d => ['approved', 'scheduled'].includes(d.status)).length}
              </p>
            </div>
          </div>
        )}
        {todayAlerts.length > 0 && (
          <div className="mt-3 space-y-1">
            {todayAlerts.slice(0, 5).map((a, i) => (
              <div key={i} className="flex items-center justify-between text-xs py-1.5 px-3 bg-red-500/5 border border-red-500/15 rounded-lg">
                <span className="text-white font-mono">{a.asin}</span>
                <StatusBadge status={a.economic_status} />
                <span className="text-slate-400">{a.performance_status?.slice(0, 50) || '—'}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── KPIs Semanais ────────────────────────────────────────────────────── */}
      {report && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <KPICard label="Gasto Total" value={fmt(report.total_spend)} />
            <KPICard label="Vendas Ads" value={fmt(report.total_ads_sales)} color="text-emerald-400" />
            <KPICard label="Vendas Reais (SP-API)" value={fmt(report.total_real_sales)} color="text-cyan" sub={report.total_real_sales === 0 ? 'Aguardando SP-API' : undefined} />
            <KPICard label="ACoS" value={fmt(report.account_acos, 'pct')} color={report.account_acos > 30 ? 'text-red-400' : report.account_acos > 20 ? 'text-amber-400' : 'text-emerald-400'} alert={report.account_acos > 30} />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <KPICard label="TACoS" value={fmt(report.account_tacos, 'pct')} sub={report.account_tacos == null ? 'Dados SP-API parciais' : undefined} />
            <KPICard label="ROAS" value={report.account_roas ? `${report.account_roas.toFixed(2)}x` : '—'} />
            <KPICard label="Lucro Pós-Ads" value={fmt(report.total_profit_after_ads)} color={report.total_profit_after_ads < 0 ? 'text-red-400' : 'text-emerald-400'} />
            <KPICard label="Produtos Lucrativos" value={report.products_profitable} sub={`${report.products_unprofitable} deficitários`} color="text-emerald-400" />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <KPICard label="Campanhas Ajustadas" value={report.campaigns_adjusted} />
            <KPICard label="Keywords Ajustadas" value={report.keywords_adjusted} />
            <KPICard label="Decisões Executadas" value={report.decisions_executed} color="text-cyan" />
            <KPICard label="Aguardando Confirm." value={report.decisions_pending_confirmation} color="text-amber-400" />
          </div>

          {/* Resumo executivo */}
          {report.executive_summary && (
            <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
              <p className="text-xs font-semibold text-slate-400 uppercase mb-2">Resumo Executivo</p>
              <p className="text-sm text-slate-200 leading-relaxed">{report.executive_summary}</p>
            </div>
          )}
        </>
      )}

      {/* ── Tabs de detalhe ──────────────────────────────────────────────────── */}
      {report && (
        <>
          <div className="flex border-b border-surface-2 overflow-x-auto scrollbar-thin">
            {[
              { id: 'produtos', label: 'Produtos' },
              { id: 'campanhas', label: 'Campanhas Ajustadas' },
              { id: 'acoes', label: 'Ações do Motor' },
            ].map(t => (
              <button key={t.id} onClick={() => setActiveTab(t.id)}
                className={`px-4 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${activeTab === t.id ? 'border-cyan text-cyan' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
                {t.label}
              </button>
            ))}
          </div>

          {/* Tab Produtos */}
          {activeTab === 'produtos' && (
            <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-surface-2 bg-surface-2/40">
                      {['Produto / SKU', 'Spend 7d', 'Vendas Ads', 'Vendas Reais', 'ACoS', 'TACoS', 'Lucro Pós-Ads', 'Meta ACoS', 'Status', 'Ação Recomendada'].map(h => (
                        <th key={h} className="px-4 py-2.5 text-left text-[10px] font-semibold text-slate-500 uppercase whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {reportProducts.map((p, i) => {
                      const profitColor = p.profit_after_ads_7d == null ? 'text-slate-500'
                        : p.profit_after_ads_7d < 0 ? 'text-red-400'
                        : p.profit_after_ads_7d < 1 ? 'text-amber-400'
                        : 'text-emerald-400';
                      return (
                        <tr key={i} className="border-b border-surface-2/40 hover:bg-surface-2/30 transition-colors">
                          <td className="px-4 py-3">
                            <p className="font-mono text-cyan text-[10px]">{p.asin}</p>
                            <p className="text-slate-500 text-[10px]">{p.sku || '—'}</p>
                          </td>
                          <td className="px-4 py-3 text-slate-300">{fmt(p.spend_7d)}</td>
                          <td className="px-4 py-3 text-emerald-400">{fmt(p.ads_sales_7d)}</td>
                          <td className="px-4 py-3 text-cyan">{p.real_sales_7d > 0 ? fmt(p.real_sales_7d) : <span className="text-slate-500">—</span>}</td>
                          <td className="px-4 py-3">
                            {p.acos_7d != null
                              ? <span className={p.acos_7d > (p.break_even_acos || 30) ? 'text-red-400 font-bold' : p.acos_7d > (p.target_acos || 20) ? 'text-amber-400' : 'text-emerald-400'}>
                                  {fmt(p.acos_7d, 'pct')}
                                </span>
                              : <span className="text-slate-500">sem vendas</span>}
                          </td>
                          <td className="px-4 py-3">
                            {p.tacos_7d != null ? fmt(p.tacos_7d, 'pct') : <span className="text-slate-500 italic text-[9px]">parcial</span>}
                          </td>
                          <td className={`px-4 py-3 font-semibold ${profitColor}`}>
                            {p.profit_after_ads_7d != null ? fmt(p.profit_after_ads_7d) : '—'}
                          </td>
                          <td className="px-4 py-3 text-slate-400">{p.target_acos ? fmt(p.target_acos, 'pct') : '—'}</td>
                          <td className="px-4 py-3"><StatusBadge status={p.status} /></td>
                          <td className="px-4 py-3 text-slate-500 text-[10px] max-w-[150px] truncate" title={p.recommended_action}>{p.recommended_action || '—'}</td>
                        </tr>
                      );
                    })}
                    {reportProducts.length === 0 && (
                      <tr><td colSpan={10} className="px-4 py-10 text-center text-slate-500">Nenhum produto avaliado neste período. Execute "Gerar Relatório Semanal" após aferir os dados.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Tab Campanhas Ajustadas */}
          {activeTab === 'campanhas' && (
            <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-surface-2 bg-surface-2/40">
                      {['Campanha / Keyword', 'Tipo', 'Bid Antes', 'Bid Depois', 'Var.%', 'Motivo', 'Status', 'Horário', 'Confirmação Amazon'].map(h => (
                        <th key={h} className="px-4 py-2.5 text-left text-[10px] font-semibold text-slate-500 uppercase whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {decisionsWeek.length === 0 ? (
                      <tr><td colSpan={9} className="px-4 py-10 text-center text-slate-500">Nenhuma ação registrada neste período.</td></tr>
                    ) : decisionsWeek.slice(0, 100).map((d, i) => {
                      const changePct = d.value_before && d.value_after
                        ? ((d.value_after - d.value_before) / d.value_before * 100).toFixed(1)
                        : null;
                      const isUp = changePct !== null && Number(changePct) > 0;
                      return (
                        <tr key={i} className="border-b border-surface-2/40 hover:bg-surface-2/30 transition-colors">
                          <td className="px-4 py-3">
                            <p className="text-white max-w-[160px] truncate">{d.keyword_text || d.campaign_id || '—'}</p>
                            <p className="text-slate-500 text-[10px] font-mono">{d.asin || ''}</p>
                          </td>
                          <td className="px-4 py-3">
                            <span className="text-[10px] px-2 py-0.5 rounded border bg-slate-500/10 border-slate-500/20 text-slate-400">
                              {d.decision_type || d.action || '—'}
                            </span>
                          </td>
                          <td className="px-4 py-3 font-mono text-slate-400">{d.value_before != null ? fmt(d.value_before) : '—'}</td>
                          <td className="px-4 py-3 font-mono text-white">{d.value_after != null ? fmt(d.value_after) : '—'}</td>
                          <td className="px-4 py-3">
                            {changePct !== null ? (
                              <span className={`flex items-center gap-1 font-semibold ${isUp ? 'text-emerald-400' : 'text-red-400'}`}>
                                {isUp ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                                {isUp ? '+' : ''}{changePct}%
                              </span>
                            ) : '—'}
                          </td>
                          <td className="px-4 py-3 text-slate-500 max-w-[160px] truncate text-[10px]" title={d.rationale}>{d.rationale?.slice(0, 60) || '—'}</td>
                          <td className="px-4 py-3">
                            <span className={`text-[10px] px-2 py-0.5 rounded border font-medium ${
                              d.status === 'executed' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                              : d.status === 'failed' ? 'bg-red-500/10 border-red-500/20 text-red-400'
                              : 'bg-amber-500/10 border-amber-500/20 text-amber-400'
                            }`}>{d.status}</span>
                          </td>
                          <td className="px-4 py-3 text-slate-500 text-[10px] whitespace-nowrap">
                            {d.created_at ? new Date(d.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                          </td>
                          <td className="px-4 py-3 text-[10px]">
                            {d.amazon_response ? (
                              <span className="text-emerald-400">✓ Confirmado</span>
                            ) : d.status === 'executed' ? (
                              <span className="text-amber-400">Aguardando</span>
                            ) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Tab Ações do Motor */}
          {activeTab === 'acoes' && (
            <div className="space-y-3">
              {[
                { label: 'Decisões Criadas', value: report.decisions_created, color: 'text-white', icon: <FileText className="w-4 h-4 text-slate-400" /> },
                { label: 'Decisões Executadas', value: report.decisions_executed, color: 'text-emerald-400', icon: <CheckCircle className="w-4 h-4 text-emerald-400" /> },
                { label: 'Falhas', value: report.decisions_failed, color: 'text-red-400', icon: <AlertTriangle className="w-4 h-4 text-red-400" /> },
                { label: 'Aguardando Confirmação Amazon', value: report.decisions_pending_confirmation, color: 'text-amber-400', icon: <Clock className="w-4 h-4 text-amber-400" /> },
              ].map(item => (
                <div key={item.label} className="flex items-center justify-between p-3 bg-surface-1 border border-surface-2 rounded-xl">
                  <div className="flex items-center gap-3">
                    {item.icon}
                    <p className="text-sm text-slate-300">{item.label}</p>
                  </div>
                  <p className={`text-xl font-bold ${item.color}`}>{item.value}</p>
                </div>
              ))}
              <div className="p-4 bg-surface-1 border border-cyan/15 rounded-xl text-xs text-slate-400">
                <p className="font-semibold text-slate-300 mb-1">Motor de Decisão Soberano</p>
                <p>Todas as ações passam obrigatoriamente pelo <span className="text-cyan">runUnifiedDecisionEngine</span>. Ações de baixo risco (redução ≤10%, sugestão Amazon) são executadas automaticamente. Ações de alto risco (aumento &gt;10%, redução &gt;25% acumulada, pausa de campanha) exigem aprovação humana.</p>
              </div>
            </div>
          )}
        </>
      )}

      {!report && !loading && (
        <div className="flex flex-col items-center justify-center py-16 gap-3 bg-surface-1 border border-surface-2 rounded-xl">
          <FileText className="w-10 h-10 text-slate-700" />
          <p className="text-sm text-slate-400 text-center">Nenhum relatório semanal disponível.</p>
          <p className="text-xs text-slate-500 text-center">Clique em "Aferir Hoje" primeiro para processar os dados do último dia, depois "Gerar Relatório Semanal".</p>
        </div>
      )}
    </div>
  );
}