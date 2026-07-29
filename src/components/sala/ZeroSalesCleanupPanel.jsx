import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Loader2, Search, Trash2, Play, CheckCircle, AlertCircle,
  TrendingDown, TrendingUp, RefreshCw, Shield, Eye, Package,
  ChevronDown, ChevronUp, Zap, Clock, Archive, RotateCcw
} from 'lucide-react';

function ActionBadge({ action }) {
  if (action === 'archive') return (
    <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border bg-red-500/10 border-red-500/20 text-red-400 font-semibold">
      <Archive className="w-2.5 h-2.5" /> Arquivar
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border bg-amber-500/10 border-amber-500/20 text-amber-400 font-semibold">
      <Clock className="w-2.5 h-2.5" /> Pausar
    </span>
  );
}

export default function ZeroSalesCleanupPanel({ account }) {
  const [phase, setPhase] = useState('idle'); // idle | scanning | preview | confirming | executing | done
  const [candidates, setCandidates] = useState([]);
  const [protected_list, setProtectedList] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [monitorResult, setMonitorResult] = useState(null);
  const [monitorLoading, setMonitorLoading] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [activeTab, setActiveTab] = useState('candidates'); // candidates | log | terms | monitoring

  // Histórico de execuções limpeza
  const [cleanupLogs, setCleanupLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);

  // Keywords em monitoramento
  const [monitoringKws, setMonitoringKws] = useState([]);
  const [monitoringLoading, setMonitoringLoading] = useState(false);

  // Promoted terms
  const [promotedTerms, setPromotedTerms] = useState([]);
  const [promotedLoading, setPromotedLoading] = useState(false);

  useEffect(() => {
    if (account) {
      loadCleanupLogs();
      loadMonitoringKws();
      loadPromotedTerms();
      runPreview();
      runMonitor();
    }
  }, [account]);

  const loadCleanupLogs = async () => {
    setLogsLoading(true);
    try {
      const logs = await base44.entities.SyncExecutionLog.filter(
        { amazon_account_id: account.id, operation: 'zero_sales_cleanup' },
        '-started_at',
        20
      );
      setCleanupLogs(logs);
    } catch {}
    finally { setLogsLoading(false); }
  };

  const loadMonitoringKws = async () => {
    setMonitoringLoading(true);
    try {
      const kws = await base44.entities.Keyword.filter(
        { amazon_account_id: account.id, archive_reason: 'archived_from_zero_sales' },
        '-archived_at',
        100
      );
      setMonitoringKws(kws);
    } catch {}
    finally { setMonitoringLoading(false); }
  };

  const loadPromotedTerms = async () => {
    setPromotedLoading(true);
    try {
      const promos = await base44.entities.ProductKickoffQueue.filter(
        { amazon_account_id: account.id, queue_window: 'cleanup_promotion' },
        '-scheduled_at',
        50
      );
      setPromotedTerms(promos);
    } catch {}
    finally { setPromotedLoading(false); }
  };

  const runPreview = async () => {
    if (!account) return;
    setPhase('scanning');
    setError(null);
    setCandidates([]);
    setSelected(new Set());
    try {
      const res = await base44.functions.invoke('runZeroSalesCleanupPipeline', {
        amazon_account_id: account.id,
        phase: 'preview',
        spend_threshold: 5,
        days_window: 7,
        min_age_days: 14,
      });
      const d = res?.data;
      if (d?.ok) {
        setCandidates(d.candidates || []);
        setProtectedList(d.protected || []);
        // Pre-select all candidates
        setSelected(new Set((d.candidates || []).map(c => c.campaign_id)));
        setPhase('preview');
      } else {
        setError(d?.error || 'Erro ao gerar preview');
        setPhase('idle');
      }
    } catch (e) {
      setError(e.message);
      setPhase('idle');
    }
  };

  const runExecute = async () => {
    if (!account || selected.size === 0) return;
    setPhase('executing');
    setError(null);
    try {
      const res = await base44.functions.invoke('runZeroSalesCleanupPipeline', {
        amazon_account_id: account.id,
        phase: 'execute',
        campaign_ids_to_archive: Array.from(selected),
      });
      const d = res?.data;
      if (d?.ok) {
        setResult(d);
        setPhase('done');
        loadCleanupLogs();
        loadMonitoringKws();
        loadPromotedTerms();
      } else {
        setError(d?.error || 'Erro ao executar');
        setPhase('preview');
      }
    } catch (e) {
      setError(e.message);
      setPhase('preview');
    }
  };

  const runMonitor = async () => {
    if (!account || monitorLoading) return;
    setMonitorLoading(true);
    setMonitorResult(null);
    try {
      const res = await base44.functions.invoke('monitorZeroSalesReactivation', {
        amazon_account_id: account.id,
      });
      const d = res?.data;
      setMonitorResult(d);
      if (d?.ok) {
        await loadMonitoringKws();
      }
      if (d?.reactivated > 0) {
        loadPromotedTerms();
      }
    } catch (e) {
      setMonitorResult({ error: e.message });
    } finally {
      setMonitorLoading(false);
    }
  };

  const toggleSelect = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(candidates.map(c => c.campaign_id)));
  const deselectAll = () => setSelected(new Set());

  const filteredCandidates = candidates.filter(c => {
    if (searchText && !(c.name || '').toLowerCase().includes(searchText.toLowerCase()) && !(c.asin || '').includes(searchText)) return false;
    if (filterType !== 'all' && c.targeting_type !== filterType) return false;
    return true;
  });

  const archiveCount = Array.from(selected).filter(id => {
    const c = candidates.find(x => x.campaign_id === id);
    return c?.suggested_action === 'archive';
  }).length;
  const pauseCount = selected.size - archiveCount;

  const totalSpend = candidates.reduce((s, c) => s + (c.spend_7d || 0), 0);
  const selectedSpend = candidates
    .filter(c => selected.has(c.campaign_id))
    .reduce((s, c) => s + (c.spend_7d || 0), 0);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            <TrendingDown className="w-5 h-5 text-red-400" />
            Limpeza & Expansão
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Arquiva campanhas com spend ≥ R$5 e zero vendas em 7 dias · promove termos lucrativos · monitora reativações automáticas
          </p>
        </div>
        <div className="flex items-center gap-2">
          {phase === 'idle' || phase === 'done' ? (
            <button
              onClick={runPreview}
              className="flex items-center gap-2 px-4 py-2 bg-cyan/15 border border-cyan/30 text-cyan hover:bg-cyan/25 text-sm font-semibold rounded-lg transition-colors"
            >
              <Search className="w-4 h-4" />
              Escanear Candidatos
            </button>
          ) : phase === 'scanning' ? (
            <div className="flex items-center gap-2 px-4 py-2 bg-surface-2 border border-surface-3 text-slate-400 rounded-lg text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              Escaneando...
            </div>
          ) : null}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-surface-2 overflow-x-auto scrollbar-thin">
        {[
          { id: 'candidates', label: `Candidatos${candidates.length > 0 ? ` (${candidates.length})` : ''}` },
          { id: 'log', label: `Log de Execuções${cleanupLogs.length > 0 ? ` (${cleanupLogs.length})` : ''}` },
          { id: 'terms', label: `Termos Promovidos${promotedTerms.length > 0 ? ` (${promotedTerms.length})` : ''}` },
          { id: 'monitoring', label: `Monitoramento${monitoringKws.length > 0 ? ` (${monitoringKws.length})` : ''}` },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`px-4 py-2.5 text-xs font-semibold border-b-2 whitespace-nowrap transition-colors ${activeTab === t.id ? 'border-cyan text-cyan' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 px-4 py-3 bg-red-500/10 border border-red-500/25 rounded-xl text-sm text-red-400">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* ── TAB: CANDIDATOS ── */}
      {activeTab === 'candidates' && (
        <div className="space-y-4">
          {/* Summary KPIs */}
          {candidates.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Candidatos', value: candidates.length, color: 'text-amber-400' },
                { label: 'Selecionados', value: selected.size, color: 'text-white' },
                { label: 'Gasto total 7d', value: `R$${totalSpend.toFixed(2)}`, color: 'text-red-400' },
                { label: 'Gasto selecionados', value: `R$${selectedSpend.toFixed(2)}`, color: selected.size > 0 ? 'text-red-400' : 'text-slate-500' },
              ].map(k => (
                <div key={k.label} className="bg-surface-1 border border-surface-2 rounded-xl px-4 py-3 text-center">
                  <p className="text-[10px] text-slate-500 mb-0.5">{k.label}</p>
                  <p className={`text-xl font-bold ${k.color}`}>{k.value}</p>
                </div>
              ))}
            </div>
          )}

          {/* Protected */}
          {protected_list.length > 0 && (
            <div className="flex items-start gap-3 p-3 bg-emerald-500/5 border border-emerald-500/20 rounded-xl">
              <Shield className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-semibold text-emerald-300">{protected_list.length} campanha(s) protegida(s) — winner protection ativa</p>
                <p className="text-[10px] text-slate-500 mt-0.5">Campanhas com pedidos nos últimos 14 dias nunca são arquivadas.</p>
              </div>
            </div>
          )}

          {/* Scanning placeholder */}
          {phase === 'scanning' && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <Loader2 className="w-8 h-8 text-cyan animate-spin" />
              <p className="text-sm text-slate-400">Analisando métricas de 7 dias...</p>
            </div>
          )}

          {/* Idle placeholder */}
          {phase === 'idle' && candidates.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <TrendingDown className="w-10 h-10 text-slate-700" />
              <p className="text-sm text-slate-500">Clique em "Escanear Candidatos" para identificar campanhas com gasto sem conversão.</p>
            </div>
          )}

          {/* Done result */}
          {phase === 'done' && result && (
            <div className="p-4 bg-emerald-500/5 border border-emerald-500/20 rounded-xl space-y-2">
              <div className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-emerald-400" />
                <p className="text-sm font-semibold text-emerald-300">Limpeza executada com sucesso!</p>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  { label: 'Arquivadas', value: result.archived, color: 'text-red-400' },
                  { label: 'Pausadas', value: result.paused, color: 'text-amber-400' },
                  { label: 'Keywords marcadas', value: result.keywords_marked, color: 'text-slate-300' },
                  { label: 'Termos promovidos', value: result.terms_promoted, color: 'text-emerald-400' },
                ].map(k => (
                  <div key={k.label} className="bg-surface-2 rounded-lg px-3 py-2 text-center">
                    <p className="text-[10px] text-slate-500">{k.label}</p>
                    <p className={`text-lg font-bold ${k.color}`}>{k.value}</p>
                  </div>
                ))}
              </div>
              {result.errors?.length > 0 && (
                <p className="text-xs text-red-400">{result.failed} falha(s) — verifique o log para detalhes.</p>
              )}
            </div>
          )}

          {/* Preview table */}
          {(phase === 'preview' || phase === 'confirming' || phase === 'executing') && candidates.length > 0 && (
            <div className="space-y-3">
              {/* Filters + selection controls */}
              <div className="flex items-center gap-2 flex-wrap">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500" />
                  <input
                    value={searchText}
                    onChange={e => setSearchText(e.target.value)}
                    placeholder="Buscar campanha ou ASIN..."
                    className="pl-7 pr-3 py-1.5 bg-surface-2 border border-surface-3 rounded-lg text-xs text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan/50 w-52"
                  />
                </div>
                {['all', 'AUTO', 'MANUAL'].map(f => (
                  <button
                    key={f}
                    onClick={() => setFilterType(f)}
                    className={`text-xs px-2.5 py-1.5 rounded-full border transition-colors ${filterType === f ? 'bg-cyan/20 text-cyan border-cyan/30' : 'bg-surface-2 text-slate-500 border-surface-3 hover:text-slate-300'}`}
                  >
                    {f === 'all' ? 'Todos' : f}
                  </button>
                ))}
                <div className="flex-1" />
                <button onClick={selectAll} className="text-xs text-cyan hover:underline">Todos</button>
                <span className="text-slate-600">·</span>
                <button onClick={deselectAll} className="text-xs text-slate-500 hover:text-slate-300">Nenhum</button>
              </div>

              {/* Table */}
              <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-surface-2 bg-surface-2/40">
                        <th className="px-3 py-2.5 text-left w-8">
                          <input
                            type="checkbox"
                            checked={selected.size === filteredCandidates.length && filteredCandidates.length > 0}
                            onChange={e => e.target.checked ? setSelected(new Set(filteredCandidates.map(c => c.campaign_id))) : deselectAll()}
                            className="rounded"
                          />
                        </th>
                        {['Campanha', 'ASIN', 'Tipo', 'Gasto 7d', 'Cliques', 'Dias ativo', 'Estoque', 'Status sugerido'].map(h => (
                          <th key={h} className="px-3 py-2.5 text-left font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredCandidates.map(c => (
                        <tr
                          key={c.campaign_id}
                          onClick={() => toggleSelect(c.campaign_id)}
                          className={`border-b border-surface-2/40 cursor-pointer transition-colors ${selected.has(c.campaign_id) ? 'bg-red-500/5 hover:bg-red-500/8' : 'hover:bg-surface-2/30'}`}
                        >
                          <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={selected.has(c.campaign_id)}
                              onChange={() => toggleSelect(c.campaign_id)}
                              className="rounded"
                            />
                          </td>
                          <td className="px-3 py-2.5 text-white font-medium max-w-[180px] truncate">{c.name || '—'}</td>
                          <td className="px-3 py-2.5 font-mono text-cyan">{c.asin || '—'}</td>
                          <td className="px-3 py-2.5">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${c.targeting_type === 'AUTO' ? 'bg-amber-400/10 text-amber-400' : 'bg-cyan/10 text-cyan'}`}>
                              {c.targeting_type || '?'}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-red-400 font-semibold">R${(c.spend_7d || 0).toFixed(2)}</td>
                          <td className="px-3 py-2.5 text-slate-400">{c.clicks_7d || 0}</td>
                          <td className="px-3 py-2.5 text-slate-400">{c.active_days || 0}d</td>
                          <td className="px-3 py-2.5">
                            {c.has_stock === null ? (
                              <span className="text-[10px] text-slate-600">—</span>
                            ) : c.has_stock ? (
                              <span className="text-[10px] text-emerald-400 flex items-center gap-1"><Package className="w-2.5 h-2.5" /> Com estoque</span>
                            ) : (
                              <span className="text-[10px] text-red-400 flex items-center gap-1"><Package className="w-2.5 h-2.5" /> Sem estoque</span>
                            )}
                          </td>
                          <td className="px-3 py-2.5">
                            <ActionBadge action={c.suggested_action} />
                          </td>
                        </tr>
                      ))}
                      {filteredCandidates.length === 0 && (
                        <tr><td colSpan={9} className="px-4 py-10 text-center text-slate-500">Nenhuma campanha com este filtro</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Confirm button */}
              <div className="flex items-center justify-between flex-wrap gap-3 pt-1">
                <p className="text-xs text-slate-500">
                  {selected.size} selecionada(s): <span className="text-red-400">{archiveCount} arquivar</span> · <span className="text-amber-400">{pauseCount} pausar</span>
                </p>
                <button
                  onClick={runExecute}
                  disabled={selected.size === 0 || phase === 'executing'}
                  className="flex items-center gap-2 px-5 py-2.5 bg-red-600/80 hover:bg-red-600 border border-red-500/40 text-white font-bold text-sm rounded-xl transition-colors disabled:opacity-50"
                >
                  {phase === 'executing' ? (
                    <><Loader2 className="w-4 h-4 animate-spin" /> Executando...</>
                  ) : (
                    <><Trash2 className="w-4 h-4" /> Confirmar arquivamento ({selected.size})</>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── TAB: LOG ── */}
      {activeTab === 'log' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-500">Histórico de execuções do pipeline de limpeza</p>
            <button onClick={loadCleanupLogs} className="text-xs text-cyan hover:underline flex items-center gap-1">
              <RefreshCw className="w-3 h-3" /> Atualizar
            </button>
          </div>
          {logsLoading ? (
            <div className="flex items-center justify-center py-10"><Loader2 className="w-5 h-5 text-cyan animate-spin" /></div>
          ) : cleanupLogs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-2">
              <Clock className="w-8 h-8 text-slate-700" />
              <p className="text-sm text-slate-500">Nenhuma execução registrada</p>
            </div>
          ) : (
            <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-surface-2 bg-surface-2/40">
                    {['Data/Hora', 'Status', 'Registros', 'Resumo'].map(h => (
                      <th key={h} className="px-4 py-2.5 text-left font-semibold text-slate-500 uppercase whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {cleanupLogs.map(log => (
                    <tr key={log.id} className="border-b border-surface-2/40 hover:bg-surface-2/30">
                      <td className="px-4 py-3 text-slate-500 whitespace-nowrap">
                        {log.started_at ? new Date(log.started_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold ${log.status === 'completed' || log.status === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border-red-500/20 text-red-400'}`}>
                          {log.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-400">{log.records_processed ?? '—'}</td>
                      <td className="px-4 py-3 text-slate-400 max-w-xs truncate">{log.result_summary || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── TAB: TERMOS PROMOVIDOS ── */}
      {activeTab === 'terms' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-500">Termos lucrativos promovidos para nova campanha MANUAL EXACT</p>
            <button onClick={loadPromotedTerms} className="text-xs text-cyan hover:underline flex items-center gap-1">
              <RefreshCw className="w-3 h-3" /> Atualizar
            </button>
          </div>
          {promotedLoading ? (
            <div className="flex items-center justify-center py-10"><Loader2 className="w-5 h-5 text-cyan animate-spin" /></div>
          ) : promotedTerms.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-2">
              <TrendingUp className="w-8 h-8 text-slate-700" />
              <p className="text-sm text-slate-500">Nenhum termo promovido ainda</p>
              <p className="text-xs text-slate-600">Termos lucrativos (ACoS ≤ meta) são promovidos automaticamente durante a execução</p>
            </div>
          ) : (
            <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-surface-2 bg-surface-2/40">
                    {['ASIN', 'Keyword', 'Modo', 'Status', 'Agendado', 'Janela'].map(h => (
                      <th key={h} className="px-4 py-2.5 text-left font-semibold text-slate-500 uppercase whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {promotedTerms.map(t => (
                    <tr key={t.id} className="border-b border-surface-2/40 hover:bg-surface-2/30">
                      <td className="px-4 py-3 font-mono text-cyan">{t.asin || '—'}</td>
                      <td className="px-4 py-3 text-white font-medium max-w-[180px] truncate">{t.keyword || '—'}</td>
                      <td className="px-4 py-3">
                        <span className="text-[10px] px-2 py-0.5 rounded border bg-emerald-500/10 border-emerald-500/20 text-emerald-400 font-semibold">{t.mode || 'manual_only'}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold ${t.status === 'completed' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : t.status === 'failed' ? 'bg-red-500/10 border-red-500/20 text-red-400' : 'bg-amber-500/10 border-amber-500/20 text-amber-400'}`}>
                          {t.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-500 whitespace-nowrap">
                        {t.scheduled_at ? new Date(t.scheduled_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                      </td>
                      <td className="px-4 py-3 text-slate-600 text-[10px]">{t.queue_window || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── TAB: MONITORAMENTO / REATIVAÇÃO ── */}
      {activeTab === 'monitoring' && (
        <div className="space-y-4">
          {/* Monitor action */}
          <div className="flex items-start gap-3 p-4 bg-surface-1 border border-amber-500/20 rounded-xl">
            <RotateCcw className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-white">Gate de Reaprovação Automática</p>
              <p className="text-xs text-slate-400 mt-0.5">
                Verifica se algum termo arquivado por zero vendas voltou a converter em campanhas ativas (14 dias). Se sim, agenda nova campanha MANUAL EXACT automaticamente.
              </p>
              {monitorResult && (
                <div className={`mt-2 text-xs font-semibold ${monitorResult.error ? 'text-red-400' : 'text-emerald-400'}`}>
                  {monitorResult.error
                    ? `Erro: ${monitorResult.error}`
                    : `✓ ${monitorResult.monitored} termos verificados · ${monitorResult.reconstructed || 0} recuperados do histórico · ${monitorResult.reactivated} reativados`}
                </div>
              )}
            </div>
            <button
              onClick={runMonitor}
              disabled={monitorLoading}
              className="flex items-center gap-2 px-4 py-2 bg-amber-500/15 border border-amber-500/30 text-amber-300 hover:bg-amber-500/25 text-xs font-semibold rounded-lg transition-colors disabled:opacity-50 flex-shrink-0"
            >
              {monitorLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
              {monitorLoading ? 'Verificando...' : 'Verificar Agora'}
            </button>
          </div>

          {/* Keywords em monitoramento */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-slate-300">
                Keywords em Monitoramento — Aguardando Reaprovação
              </p>
              <button onClick={loadMonitoringKws} className="text-xs text-cyan hover:underline flex items-center gap-1">
                <RefreshCw className="w-3 h-3" /> Atualizar
              </button>
            </div>
            {monitoringLoading ? (
              <div className="flex items-center justify-center py-10"><Loader2 className="w-5 h-5 text-cyan animate-spin" /></div>
            ) : monitoringKws.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 gap-2">
                <Eye className="w-8 h-8 text-slate-700" />
                <p className="text-sm text-slate-500">Nenhuma keyword em monitoramento</p>
              </div>
            ) : (
              <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-surface-2 bg-surface-2/40">
                      {['ASIN', 'Keyword', 'Match', 'Arquivada em', 'Status'].map(h => (
                        <th key={h} className="px-4 py-2.5 text-left font-semibold text-slate-500 uppercase whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {monitoringKws.map(kw => (
                      <tr key={kw.id} className="border-b border-surface-2/40 hover:bg-surface-2/30">
                        <td className="px-4 py-3 font-mono text-cyan">{kw.asin || '—'}</td>
                        <td className="px-4 py-3 text-white font-medium max-w-[200px] truncate">{kw.keyword_text || '—'}</td>
                        <td className="px-4 py-3">
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-3 text-slate-400">{kw.match_type || '—'}</span>
                        </td>
                        <td className="px-4 py-3 text-slate-500 whitespace-nowrap">
                          {kw.archived_at ? new Date(kw.archived_at).toLocaleDateString('pt-BR') : '—'}
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border bg-amber-500/10 border-amber-500/20 text-amber-400 font-semibold">
                            <Clock className="w-2.5 h-2.5" /> Aguardando reaprovação
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
