import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { Bot, Play, RefreshCw, Loader2, Settings, AlertTriangle, History, Zap, TrendingDown, Search, Unlock } from 'lucide-react';
import AutopilotKPIBar from '@/components/autopilot/AutopilotKPIBar';
import AutopilotConfigPanel from '@/components/autopilot/AutopilotConfigPanel';
import AutopilotDecisionsTable from '@/components/autopilot/AutopilotDecisionsTable';
import AutopilotAlertsPanel from '@/components/autopilot/AutopilotAlertsPanel';

const TABS = [
  { id: 'decisions', label: 'Decisões', icon: Zap },
  { id: 'converted', label: 'Termos Convertidos', icon: Search },
  { id: 'alerts', label: 'Alertas', icon: AlertTriangle },
  { id: 'negatives', label: 'Negativas', icon: TrendingDown },
  { id: 'history', label: 'Histórico de Bids', icon: History },
  { id: 'config', label: 'Configuração', icon: Settings },
];

const CLASSIFICATION_COLORS = {
  FIRST_SALE: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
  WINNER: 'text-cyan bg-cyan/10 border-cyan/20',
  HIGH_ACOS: 'text-amber-400 bg-amber-400/10 border-amber-400/20',
  WASTING: 'text-red-400 bg-red-400/10 border-red-400/20',
  PROMOTED_EXACT: 'text-purple-400 bg-purple-400/10 border-purple-400/20',
  NEGATED: 'text-slate-400 bg-slate-400/10 border-slate-400/20',
  LEARNING: 'text-blue-400 bg-blue-400/10 border-blue-400/20',
  INSUFFICIENT_DATA: 'text-slate-500 bg-slate-500/10 border-slate-500/20',
};

export default function AdsAutopilot() {
  const [account, setAccount] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [decisions, setDecisions] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [negatives, setNegatives] = useState([]);
  const [bidHistory, setBidHistory] = useState([]);
  const [runs, setRuns] = useState([]);
  const [config, setConfig] = useState(null);
  const [searchTerms, setSearchTerms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState('');
  const [tab, setTab] = useState('decisions');
  const [error, setError] = useState(null);
  const [showExecuteConfirm, setShowExecuteConfirm] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [stTermFilter, setStTermFilter] = useState('all');

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
      const [cams, decs, als, negs, hist, rs, cfgs, sts] = await Promise.all([
        base44.entities.Campaign.filter({ amazon_account_id: aid }, '-spend', 200),
        base44.entities.OptimizationDecision.filter({ amazon_account_id: aid }, '-created_at', 300),
        base44.entities.AutopilotAlert.filter({ amazon_account_id: aid, is_read: false }, '-created_date', 50),
        base44.entities.NegativeKeywordSuggestion.filter({ amazon_account_id: aid, status: 'pending' }, '-spend', 100),
        base44.entities.BidHistory.filter({ amazon_account_id: aid }, '-created_date', 50),
        base44.entities.AutopilotRun.filter({ amazon_account_id: aid }, '-started_at', 10),
        base44.entities.AutopilotConfig.filter({ amazon_account_id: aid }),
        base44.entities.SearchTerm.filter({ amazon_account_id: aid }, '-orders_14d', 500),
      ]);
      setCampaigns(cams);
      setDecisions(decs);
      setAlerts(als);
      setNegatives(negs);
      setBidHistory(hist);
      setRuns(rs);
      setConfig(cfgs[0] || null);
      setSearchTerms(sts);
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
    setRunMsg('Analisando campanhas, keywords e search terms...');
    try {
      const res = await base44.functions.invoke('runDailyAdsOptimization', {
        amazon_account_id: account.id,
        trigger: 'manual',
      });
      const d = res.data;
      if (d?.ok) {
        const b = d.breakdown || {};
        setRunMsg(`✓ ${d.decisions_created || 0} decisões geradas · ${b.harvest || 0} termos colhidos · ${b.bid_decrease || 0} bids reduzidos · ${b.bid_increase || 0} bids aumentados`);
        await loadData();
      } else if (d?.skipped) {
        setRunMsg(`⚠ ${d.reason}`);
      } else {
        setRunMsg(`❌ ${d?.error || 'Erro desconhecido'}`);
      }
    } catch (e) {
      setRunMsg(`❌ ${e.message}`);
    } finally {
      setRunning(false);
      setTimeout(() => setRunMsg(''), 10000);
    }
  };

  const executeApproved = async () => {
    const approvedIds = decisions.filter(d => d.status === 'approved').map(d => d.id);
    if (!approvedIds.length) return;
    setExecuting(true);
    await base44.functions.invoke('executeAutopilotDecision', { decision_ids: approvedIds });
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

  const unlockStuck = async () => {
    if (!account) return;
    setUnlocking(true);
    try {
      const res = await base44.functions.invoke('unlockStuckSyncs', { amazon_account_id: account.id });
      if (res.data?.ok) {
        await loadData();
      }
    } catch {}
    setUnlocking(false);
  };

  const approvedCount = decisions.filter(d => d.status === 'approved').length;
  const lastRun = runs[0];
  const isRunning = lastRun?.status === 'running';
  const currencySymbol = config?.currency_symbol || account?.currency_symbol || 'R$';

  // Detectar run travado
  const stuckRunAge = isRunning && lastRun?.started_at
    ? Math.round((Date.now() - new Date(lastRun.started_at).getTime()) / 60000)
    : 0;
  const isStuck = isRunning && stuckRunAge > 60;

  // Termos convertidos: agrupados por search_term + asin
  const stMap = new Map();
  for (const st of searchTerms) {
    const key = `${st.search_term || st.keyword_text}|${st.advertised_asin}`;
    const ex = stMap.get(key);
    if (!ex || (st.orders_14d || 0) > (ex.orders_14d || 0)) stMap.set(key, st);
  }
  const allSearchTerms = Array.from(stMap.values());
  const convertedTerms = allSearchTerms.filter(st =>
    stTermFilter === 'all' ? true :
    stTermFilter === 'promoted' ? st.promoted_to_manual :
    stTermFilter === 'first_sale' ? st.classification === 'FIRST_SALE' :
    stTermFilter === 'winner' ? st.classification === 'WINNER' :
    stTermFilter === 'wasting' ? st.classification === 'WASTING' :
    true
  );

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
              {isRunning && !isStuck ? <span className="text-amber-400 animate-pulse">⚡ Análise em andamento...</span> :
               isStuck ? <span className="text-red-400">⚠ Run travado há {stuckRunAge} min</span> :
               lastRun ? `Último ciclo: ${new Date(lastRun.started_at).toLocaleString('pt-BR')}` : 'Nenhuma análise executada'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {isStuck && (
            <button onClick={unlockStuck} disabled={unlocking}
              className="flex items-center gap-2 px-3 py-2 bg-red-500/15 border border-red-500/30 text-red-400 hover:bg-red-500/25 text-sm font-semibold rounded-lg disabled:opacity-50 transition-colors">
              {unlocking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Unlock className="w-4 h-4" />}
              Liberar run travado
            </button>
          )}
          {approvedCount > 0 && (
            <button onClick={() => setShowExecuteConfirm(true)}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold rounded-lg transition-colors">
              <Play className="w-4 h-4" /> Executar Aprovadas ({approvedCount})
            </button>
          )}
          <button onClick={runAnalysis} disabled={running || (isRunning && !isStuck)}
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

      {runMsg && (
        <div className={`p-3 rounded-xl border text-sm font-medium ${runMsg.startsWith('✓') ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300' : runMsg.startsWith('⚠') ? 'bg-amber-400/10 border-amber-400/20 text-amber-300' : 'bg-red-400/10 border-red-400/20 text-red-400'}`}>
          {runMsg}
        </div>
      )}

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-sm text-red-400">{error}</div>
      )}

      {!loading && !account && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-6 text-center">
          <p className="text-amber-400 font-semibold">Nenhuma conta Amazon conectada.</p>
          <p className="text-sm text-slate-400 mt-1">Configure sua conta Amazon nas Configurações antes de usar o Autopilot.</p>
        </div>
      )}

      {account && (
        <>
          <AutopilotKPIBar runs={runs} decisions={decisions} alerts={alerts} campaigns={campaigns} config={config} loading={loading} searchTerms={searchTerms} />

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
              {/* Decisões */}
              {tab === 'decisions' && (
                <AutopilotDecisionsTable decisions={decisions} onRefresh={loadData} />
              )}

              {/* Termos Convertidos */}
              {tab === 'converted' && (
                <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
                  <div className="px-5 py-3 border-b border-surface-2 flex items-center justify-between flex-wrap gap-2">
                    <div>
                      <h3 className="text-sm font-semibold text-white">Search Terms com Performance</h3>
                      <p className="text-xs text-slate-500 mt-0.5">{allSearchTerms.length} termos únicos analisados</p>
                    </div>
                    <div className="flex gap-1 flex-wrap">
                      {[
                        { k: 'all', label: `Todos (${allSearchTerms.length})` },
                        { k: 'first_sale', label: `1ª Venda (${allSearchTerms.filter(s => s.classification === 'FIRST_SALE').length})` },
                        { k: 'winner', label: `Vencedores (${allSearchTerms.filter(s => s.classification === 'WINNER').length})` },
                        { k: 'wasting', label: `Desperdiçando (${allSearchTerms.filter(s => s.classification === 'WASTING').length})` },
                        { k: 'promoted', label: `Promovidos (${allSearchTerms.filter(s => s.promoted_to_manual).length})` },
                      ].map(f => (
                        <button key={f.k} onClick={() => setStTermFilter(f.k)}
                          className={`px-2.5 py-1 text-xs rounded-lg transition-colors ${stTermFilter === f.k ? 'bg-cyan/20 text-cyan' : 'bg-surface-2 text-slate-500 hover:text-slate-300'}`}>
                          {f.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-surface-2 bg-surface-2/50">
                          {['Search Term', 'ASIN', 'Classificação', 'Pedidos 14d', 'Vendas 14d', 'Spend', 'ACoS 14d', 'Promovido', 'Última Ação'].map(h => (
                            <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {convertedTerms.length === 0 ? (
                          <tr><td colSpan={9} className="px-5 py-10 text-center text-sm text-slate-500">Nenhum termo neste filtro</td></tr>
                        ) : convertedTerms.slice(0, 200).map(st => {
                          const acos = st.acos_14d || 0;
                          const acosColor = acos > (config?.target_acos || 25) ? 'text-red-400' : acos > 0 ? 'text-emerald-400' : 'text-slate-500';
                          return (
                            <tr key={st.id} className="border-b border-surface-2/40 hover:bg-surface-2/50">
                              <td className="px-4 py-2.5 font-mono text-xs text-white max-w-[200px] truncate">{st.search_term || st.keyword_text || '—'}</td>
                              <td className="px-3 py-2.5 text-xs font-mono text-cyan">{st.advertised_asin || '—'}</td>
                              <td className="px-3 py-2.5">
                                {st.classification ? (
                                  <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${CLASSIFICATION_COLORS[st.classification] || 'text-slate-400 bg-slate-400/10 border-slate-400/20'}`}>
                                    {st.classification}
                                  </span>
                                ) : <span className="text-xs text-slate-600">—</span>}
                              </td>
                              <td className="px-3 py-2.5 text-xs text-white font-semibold">{st.orders_14d || 0}</td>
                              <td className="px-3 py-2.5 text-xs text-emerald-400">{currencySymbol}{(st.sales_14d || 0).toFixed(2)}</td>
                              <td className="px-3 py-2.5 text-xs text-slate-400">{currencySymbol}{(st.spend || 0).toFixed(2)}</td>
                              <td className={`px-3 py-2.5 text-xs font-semibold ${acosColor}`}>{acos > 0 ? `${acos.toFixed(1)}%` : '—'}</td>
                              <td className="px-3 py-2.5">
                                {st.promoted_to_manual ? (
                                  <span className="text-xs text-purple-400">✓ {st.promoted_at ? new Date(st.promoted_at).toLocaleDateString('pt-BR') : 'Sim'}</span>
                                ) : (
                                  <span className="text-xs text-slate-600">—</span>
                                )}
                              </td>
                              <td className="px-3 py-2.5 text-xs text-slate-500 max-w-[140px] truncate">
                                {st.last_action || '—'}
                                {st.last_action_at && <span className="text-slate-600 ml-1">{new Date(st.last_action_at).toLocaleDateString('pt-BR')}</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Alertas */}
              {tab === 'alerts' && (
                <AutopilotAlertsPanel alerts={alerts} onDismiss={dismissAlert} />
              )}

              {/* Negativas */}
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
                            <td className="px-3 py-3 text-xs text-red-400">{currencySymbol}{(n.spend || 0).toFixed(2)}</td>
                            <td className="px-3 py-3 text-xs text-slate-400">{currencySymbol}{(n.sales || 0).toFixed(2)}</td>
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

              {/* Histórico */}
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
                          <tr><td colSpan={8} className="px-5 py-8 text-center text-sm text-slate-500">Nenhuma alteração de bid registrada</td></tr>
                        ) : bidHistory.map(h => {
                          const before = h.bid_before ?? h.budget_before;
                          const after = h.bid_after ?? h.budget_after;
                          const pct = h.change_pct || 0;
                          return (
                            <tr key={h.id} className="border-b border-surface-2/40 hover:bg-surface-2/50">
                              <td className="px-4 py-3 text-xs text-white font-medium truncate max-w-[160px]">{h.entity_name}</td>
                              <td className="px-3 py-3 text-xs text-slate-400">{h.entity_type}</td>
                              <td className="px-3 py-3 font-mono text-xs text-slate-400">{currencySymbol}{(before || 0).toFixed(2)}</td>
                              <td className="px-3 py-3 font-mono text-xs text-white">{currencySymbol}{(after || 0).toFixed(2)}</td>
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