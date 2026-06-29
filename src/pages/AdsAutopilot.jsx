import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { Bot, Play, RefreshCw, Loader2, Settings, AlertTriangle, History, Zap, TrendingDown, ChevronDown, ChevronUp } from 'lucide-react';
import AutopilotKPIBar from '@/components/autopilot/AutopilotKPIBar';
import AutopilotConfigPanel from '@/components/autopilot/AutopilotConfigPanel';
import AutopilotDecisionsTable from '@/components/autopilot/AutopilotDecisionsTable';
import AutopilotAlertsPanel from '@/components/autopilot/AutopilotAlertsPanel';

const TABS = [
  { id: 'decisions', label: 'Decisões IA', icon: Zap },
  { id: 'alerts', label: 'Alertas de Risco', icon: AlertTriangle },
  { id: 'negatives', label: 'Sugestões Negativas', icon: TrendingDown },
  { id: 'history', label: 'Histórico de Bids', icon: History },
  { id: 'config', label: 'Configuração', icon: Settings },
];

export default function AdsAutopilot() {
  const [account, setAccount] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [decisions, setDecisions] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [negatives, setNegatives] = useState([]);
  const [bidHistory, setBidHistory] = useState([]);
  const [runs, setRuns] = useState([]);
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState('');
  const [tab, setTab] = useState('decisions');
  const [error, setError] = useState(null);
  const [showExecuteConfirm, setShowExecuteConfirm] = useState(false);
  const [executing, setExecuting] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accounts[0];
      setAccount(acc);
      if (!acc) { setLoading(false); return; }
      const aid = acc.id;
      const [cams, decs, als, negs, hist, rs, cfgs] = await Promise.all([
        base44.entities.Campaign.filter({ amazon_account_id: aid }, '-spend', 200),
        base44.entities.AutopilotDecision.filter({ amazon_account_id: aid }, '-created_date', 200),
        base44.entities.AutopilotAlert.filter({ amazon_account_id: aid, is_read: false }, '-created_date', 50),
        base44.entities.NegativeKeywordSuggestion.filter({ amazon_account_id: aid, status: 'pending' }, '-spend', 100),
        base44.entities.BidHistory.filter({ amazon_account_id: aid }, '-created_date', 50),
        base44.entities.AutopilotRun.filter({ amazon_account_id: aid }, '-started_at', 10),
        base44.entities.AutopilotConfig.filter({ amazon_account_id: aid }),
      ]);
      setCampaigns(cams);
      setDecisions(decs);
      setAlerts(als);
      setNegatives(negs);
      setBidHistory(hist);
      setRuns(rs);
      setConfig(cfgs[0] || null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const runAnalysis = async () => {
    if (!account) return;
    setRunning(true);
    setRunMsg('Analisando campanhas e keywords...');
    try {
      const res = await base44.functions.invoke('runAutopilot', {
        amazon_account_id: account.id,
        trigger: 'manual',
      });
      const d = res.data;
      if (d?.ok) {
        setRunMsg(`✓ ${d.decisions_generated} decisões geradas · ${d.alerts} alertas · ${d.negative_suggestions} negativas sugeridas`);
        await loadData();
      } else {
        setRunMsg(`❌ ${d?.error || 'Erro desconhecido'}`);
      }
    } catch (e) {
      setRunMsg(`❌ ${e.message}`);
    } finally {
      setRunning(false);
      setTimeout(() => setRunMsg(''), 8000);
    }
  };

  const executeApproved = async () => {
    const approvedIds = decisions.filter(d => d.status === 'approved').map(d => d.id);
    if (!approvedIds.length) return;
    setExecuting(true);
    const res = await base44.functions.invoke('executeAutopilotDecision', { decision_ids: approvedIds });
    setShowExecuteConfirm(false);
    await loadData();
    setExecuting(false);
  };

  const dismissAlert = async (id) => {
    await base44.entities.AutopilotAlert.update(id, { is_read: true });
    setAlerts(prev => prev.filter(a => a.id !== id));
  };

  const approveNegative = async (id) => {
    await base44.entities.NegativeKeywordSuggestion.update(id, { status: 'approved' });
    setNegatives(prev => prev.filter(n => n.id !== id));
  };

  const rejectNegative = async (id) => {
    await base44.entities.NegativeKeywordSuggestion.update(id, { status: 'rejected' });
    setNegatives(prev => prev.filter(n => n.id !== id));
  };

  const approvedCount = decisions.filter(d => d.status === 'approved').length;
  const lastRun = runs[0];
  const isRunning = lastRun?.status === 'running';

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
            <Bot className="w-6 h-6 text-cyan" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Ads Autopilot <span className="text-sm font-normal text-cyan">LivingFinds</span></h1>
            <p className="text-xs text-slate-400">
              {isRunning ? <span className="text-amber-400 animate-pulse">⚡ Análise em andamento...</span> :
                lastRun ? `Último ciclo: ${new Date(lastRun.started_at).toLocaleString('pt-BR')}` : 'Nenhuma análise executada'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {approvedCount > 0 && (
            <button onClick={() => setShowExecuteConfirm(true)}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold rounded-lg transition-colors">
              <Play className="w-4 h-4" /> Executar Aprovadas ({approvedCount})
            </button>
          )}
          <button onClick={runAnalysis} disabled={running || isRunning}
            className="flex items-center gap-2 px-4 py-2 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg disabled:opacity-60 transition-colors">
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            {running ? 'Analisando...' : 'Rodar Análise'}
          </button>
          <button onClick={loadData} disabled={loading}
            className="p-2.5 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Mensagem do run */}
      {runMsg && (
        <div className={`p-3 rounded-xl border text-sm font-medium ${runMsg.startsWith('✓') ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300' : 'bg-red-400/10 border-red-400/20 text-red-400'}`}>
          {runMsg}
        </div>
      )}

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-sm text-red-400">{error}</div>
      )}

      {/* Sem conta */}
      {!loading && !account && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-6 text-center">
          <p className="text-amber-400 font-semibold">Nenhuma conta Amazon conectada.</p>
          <p className="text-sm text-slate-400 mt-1">Configure sua conta Amazon nas Configurações antes de usar o Autopilot.</p>
        </div>
      )}

      {account && (
        <>
          {/* KPIs */}
          <AutopilotKPIBar runs={runs} decisions={decisions} alerts={alerts} campaigns={campaigns} config={config} loading={loading} />

          {/* Tabs */}
          <div className="flex border-b border-surface-2 overflow-x-auto">
            {TABS.map(t => {
              const Icon = t.icon;
              return (
                <button key={t.id} onClick={() => setTab(t.id)}
                  className={`flex items-center gap-1.5 px-5 py-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${tab === t.id ? 'border-cyan text-cyan' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
                  <Icon className="w-3.5 h-3.5" />{t.label}
                </button>
              );
            })}
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
          ) : (
            <>
              {tab === 'decisions' && (
                <AutopilotDecisionsTable decisions={decisions} onRefresh={loadData} />
              )}

              {tab === 'alerts' && (
                <AutopilotAlertsPanel alerts={alerts} onDismiss={dismissAlert} />
              )}

              {tab === 'negatives' && (
                <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
                  <div className="px-5 py-3 border-b border-surface-2">
                    <h3 className="text-sm font-semibold text-white">Sugestões de Palavras Negativas</h3>
                    <p className="text-xs text-slate-500 mt-0.5">Keywords com gasto e sem conversão</p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-surface-2 bg-surface-2/50">
                          {['Keyword', 'Tipo', 'Cliques', 'Spend', 'Vendas', 'Motivo', 'Ação'].map(h => (
                            <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {negatives.length === 0 ? (
                          <tr><td colSpan={7} className="px-5 py-8 text-center text-sm text-slate-500">Nenhuma sugestão de negativa pendente</td></tr>
                        ) : negatives.map(n => (
                          <tr key={n.id} className="border-b border-surface-2/40 hover:bg-surface-2/50">
                            <td className="px-4 py-3 font-mono text-xs text-white">{n.keyword_text}</td>
                            <td className="px-3 py-3 text-xs text-slate-400">{n.match_type}</td>
                            <td className="px-3 py-3 text-xs text-slate-300">{n.clicks}</td>
                            <td className="px-3 py-3 text-xs text-red-400">${(n.spend || 0).toFixed(2)}</td>
                            <td className="px-3 py-3 text-xs text-slate-400">${(n.sales || 0).toFixed(2)}</td>
                            <td className="px-3 py-3 text-xs text-slate-500 max-w-[180px] truncate">{n.reason}</td>
                            <td className="px-4 py-3">
                              <div className="flex gap-1.5">
                                <button onClick={() => approveNegative(n.id)}
                                  className="px-2.5 py-1.5 bg-red-600 hover:bg-red-500 text-white text-xs font-bold rounded-lg transition-colors">
                                  Negativar
                                </button>
                                <button onClick={() => rejectNegative(n.id)}
                                  className="px-2.5 py-1.5 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white text-xs rounded-lg transition-colors">
                                  Ignorar
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {tab === 'history' && (
                <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
                  <div className="px-5 py-3 border-b border-surface-2">
                    <h3 className="text-sm font-semibold text-white">Histórico de Alterações de Bid</h3>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-surface-2 bg-surface-2/50">
                          {['Entidade', 'Tipo', 'Antes', 'Depois', 'Variação', 'Motivo', 'Por', 'Data'].map(h => (
                            <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {bidHistory.length === 0 ? (
                          <tr><td colSpan={8} className="px-5 py-8 text-center text-sm text-slate-500">Nenhuma alteração de bid registada</td></tr>
                        ) : bidHistory.map(h => {
                          const before = h.bid_before ?? h.budget_before;
                          const after = h.bid_after ?? h.budget_after;
                          const pct = h.change_pct || 0;
                          return (
                            <tr key={h.id} className="border-b border-surface-2/40 hover:bg-surface-2/50">
                              <td className="px-4 py-3 text-xs text-white font-medium truncate max-w-[160px]">{h.entity_name}</td>
                              <td className="px-3 py-3 text-xs text-slate-400">{h.entity_type}</td>
                              <td className="px-3 py-3 font-mono text-xs text-slate-400">${(before || 0).toFixed(2)}</td>
                              <td className="px-3 py-3 font-mono text-xs text-white">${(after || 0).toFixed(2)}</td>
                              <td className="px-3 py-3">
                                <span className={`text-xs font-semibold ${pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                  {pct >= 0 ? '+' : ''}{pct.toFixed(1)}%
                                </span>
                              </td>
                              <td className="px-3 py-3 text-xs text-slate-500 max-w-[180px] truncate">{h.reason}</td>
                              <td className="px-3 py-3 text-xs text-slate-500">{h.applied_by}</td>
                              <td className="px-3 py-3 text-xs text-slate-600 whitespace-nowrap">
                                {h.created_date ? new Date(h.created_date).toLocaleDateString('pt-BR') : '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {tab === 'config' && (
                <AutopilotConfigPanel amazonAccountId={account?.id} onConfigSaved={loadData} />
              )}
            </>
          )}
        </>
      )}

      {/* Modal confirmar execução */}
      {showExecuteConfirm && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-surface-1 border border-surface-2 rounded-2xl p-6 max-w-md w-full space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center">
                <Play className="w-5 h-5 text-emerald-400" />
              </div>
              <h3 className="text-base font-bold text-white">Executar {approvedCount} decisões aprovadas?</h3>
            </div>
            <p className="text-sm text-slate-400">
              As decisões aprovadas serão enviadas à Amazon Ads API. Ações críticas (pausar campanha, negativar) precisam ser confirmadas individualmente.
            </p>
            <div className="flex gap-3">
              <button onClick={executeApproved} disabled={executing}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-lg disabled:opacity-50 transition-colors">
                {executing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                Confirmar Execução
              </button>
              <button onClick={() => setShowExecuteConfirm(false)}
                className="flex-1 py-2.5 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors">
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}