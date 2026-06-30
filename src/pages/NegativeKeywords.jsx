import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Shield, Search, Filter, RefreshCw, Loader2, X, Check, Trash2, Upload,
  AlertCircle, TrendingDown, Eye, EyeOff, CheckSquare, Square, CheckCircle
} from 'lucide-react';
import { Button } from '@/components/ui/button';

const NEGATIVE_MATCH_TYPES = [
  { value: 'exact', label: 'Exata' },
  { value: 'phrase', label: 'Frase' },
];

export default function NegativeKeywords() {
  const [account, setAccount] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [sortBy, setSortBy] = useState('spend');
  const [actionMsg, setActionMsg] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);
  const [selectedTerms, setSelectedTerms] = useState(new Set());
  const [bulkApplying, setBulkApplying] = useState(false);
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accounts[0] || (await base44.entities.AmazonAccount.list())[0];
      setAccount(acc);
      if (!acc) return;

      const negs = await base44.entities.NegativeKeywordSuggestion.filter(
        { amazon_account_id: acc.id },
        '-created_date',
        500
      );
      setSuggestions(negs);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const approveSuggestion = async (suggestion) => {
    setActionLoading(suggestion.id);
    try {
      await base44.entities.NegativeKeywordSuggestion.update(suggestion.id, {
        status: 'approved',
        reviewed_by: (await base44.auth.me()).id,
        reviewed_at: new Date().toISOString(),
      });

      const res = await base44.functions.invoke('executeAgentAction', {
        action_id: suggestion.id,
        approve: true,
      });

      if (res.data?.ok) {
        setActionMsg({ type: 'success', text: `✓ "${suggestion.keyword_text}" negativada com sucesso` });
        await load();
      } else {
        throw new Error(res.data?.error || 'Falha ao negativar');
      }
    } catch (e) {
      setActionMsg({ type: 'error', text: e.message });
    } finally {
      setActionLoading(null);
      setTimeout(() => setActionMsg(null), 8000);
    }
  };

  const rejectSuggestion = async (suggestion) => {
    setActionLoading(suggestion.id);
    try {
      await base44.entities.NegativeKeywordSuggestion.update(suggestion.id, {
        status: 'rejected',
        reviewed_by: (await base44.auth.me()).id,
        reviewed_at: new Date().toISOString(),
      });
      setActionMsg({ type: 'info', text: `✕ "${suggestion.keyword_text}" rejeitada` });
      await load();
    } catch (e) {
      setActionMsg({ type: 'error', text: e.message });
    } finally {
      setActionLoading(null);
      setTimeout(() => setActionMsg(null), 8000);
    }
  };

  const bulkApprove = async () => {
    if (selectedTerms.size === 0) return;
    setBulkApplying(true);
    let success = 0, failed = 0;

    for (const id of selectedTerms) {
      try {
        const suggestion = suggestions.find(s => s.id === id);
        if (!suggestion) continue;

        await base44.entities.NegativeKeywordSuggestion.update(id, {
          status: 'approved',
          reviewed_by: (await base44.auth.me()).id,
          reviewed_at: new Date().toISOString(),
        });

        await base44.functions.invoke('executeAgentAction', {
          action_id: id,
          approve: true,
        });
        success++;
      } catch {
        failed++;
      }
    }

    setBulkApplying(false);
    setSelectedTerms(new Set());
    setActionMsg({
      type: success > 0 ? 'success' : 'error',
      text: `✓ ${success} termos negativados${failed > 0 ? ` · ${failed} falharam` : ''}`,
    });
    await load();
    setTimeout(() => setActionMsg(null), 10000);
  };

  const bulkReject = async () => {
    if (selectedTerms.size === 0) return;
    setBulkApplying(true);
    let success = 0, failed = 0;

    for (const id of selectedTerms) {
      try {
        await base44.entities.NegativeKeywordSuggestion.update(id, {
          status: 'rejected',
          reviewed_by: (await base44.auth.me()).id,
          reviewed_at: new Date().toISOString(),
        });
        success++;
      } catch {
        failed++;
      }
    }

    setBulkApplying(false);
    setSelectedTerms(new Set());
    setActionMsg({
      type: success > 0 ? 'info' : 'error',
      text: `✕ ${success} termos rejeitados${failed > 0 ? ` · ${failed} falharam` : ''}`,
    });
    await load();
    setTimeout(() => setActionMsg(null), 10000);
  };

  const toggleSelect = (id) => {
    setSelectedTerms(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedTerms.size === filtered.length) {
      setSelectedTerms(new Set());
    } else {
      setSelectedTerms(new Set(filtered.map(s => s.id)));
    }
  };

  const filtered = suggestions.filter(s => {
    const matchSearch = !search || (s.keyword_text || '').toLowerCase().includes(search.toLowerCase());
    const matchStatus = filterStatus === 'all' || s.status === filterStatus;
    return matchSearch && matchStatus;
  }).sort((a, b) => {
    if (sortBy === 'spend') return (b.spend || 0) - (a.spend || 0);
    if (sortBy === 'clicks') return (b.clicks || 0) - (a.clicks || 0);
    if (sortBy === 'acos') return (b.acos || 0) - (a.acos || 0);
    if (sortBy === 'created') return new Date(b.created_date || 0) - new Date(a.created_date || 0);
    return 0;
  });

  const statusCounts = suggestions.reduce((acc, s) => {
    acc[s.status || 'pending'] = (acc[s.status || 'pending'] || 0) + 1;
    return acc;
  }, {});

  const pendingCount = statusCounts.pending || 0;
  const approvedCount = statusCounts.approved || 0;
  const rejectedCount = statusCounts.rejected || 0;

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-red-500/15 border border-red-500/20 flex items-center justify-center">
            <Shield className="w-5 h-5 text-red-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Palavras-chave Negativas</h1>
            <p className="text-xs text-slate-400">
              {suggestions.length} sugestões · {pendingCount} pendentes · {approvedCount} aprovadas
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={load} disabled={loading} variant="outline" size="sm">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {actionMsg && (
        <div className={`px-4 py-3 rounded-xl border text-sm font-medium ${
          actionMsg.type === 'success' ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300' :
          actionMsg.type === 'error' ? 'bg-red-400/10 border-red-400/20 text-red-400' :
          'bg-cyan/10 border-cyan/20 text-cyan'
        }`}>{actionMsg.text}</div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-3 gap-3">
        <div className={`rounded-xl p-4 border ${pendingCount > 0 ? 'bg-amber-500/5 border-amber-500/20' : 'bg-surface-1 border-surface-2'}`}>
          <p className="text-xs text-slate-500 mb-1">Pendentes</p>
          <p className={`text-xl font-bold ${pendingCount > 0 ? 'text-amber-400' : 'text-slate-400'}`}>{pendingCount}</p>
          <p className="text-xs text-slate-500 mt-0.5">aguardando revisão</p>
        </div>
        <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4">
          <p className="text-xs text-slate-500 mb-1">Aprovadas</p>
          <p className="text-xl font-bold text-emerald-400">{approvedCount}</p>
          <p className="text-xs text-slate-500 mt-0.5">negativadas com sucesso</p>
        </div>
        <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-4">
          <p className="text-xs text-slate-500 mb-1">Rejeitadas</p>
          <p className="text-xl font-bold text-red-400">{rejectedCount}</p>
          <p className="text-xs text-slate-500 mt-0.5">descartadas</p>
        </div>
      </div>

      {/* Bulk Actions */}
      {selectedTerms.size > 0 && (
        <div className="bg-surface-2 border border-surface-3 rounded-xl p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <CheckSquare className="w-5 h-5 text-cyan" />
            <p className="text-sm text-slate-300">
              <strong className="text-white">{selectedTerms.size}</strong> termos selecionados
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              onClick={bulkReject}
              disabled={bulkApplying}
              variant="outline"
              size="sm"
              className="text-red-400 border-red-500/30 hover:bg-red-500/10"
            >
              <X className="w-4 h-4 mr-1" />
              Rejeitar ({selectedTerms.size})
            </Button>
            <Button
              onClick={bulkApprove}
              disabled={bulkApplying}
              size="sm"
              className="bg-emerald-500 hover:bg-emerald-600 text-white"
            >
              <Check className="w-4 h-4 mr-1" />
              Negativar ({selectedTerms.size})
            </Button>
          </div>
        </div>
      )}

      {/* Filtros */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-shrink-0 sm:w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Pesquisar termo..."
            className="w-full pl-10 pr-4 py-2.5 bg-surface-1 border border-surface-2 rounded-lg text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan/50"
          />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Filter className="w-3.5 h-3.5 text-slate-500" />
          {[
            { key: 'all', label: `Todos (${suggestions.length})` },
            { key: 'pending', label: `Pendentes (${pendingCount})`, highlight: pendingCount > 0 },
            { key: 'approved', label: `Aprovadas (${approvedCount})` },
            { key: 'rejected', label: `Rejeitadas (${rejectedCount})` },
          ].map(f => (
            <button
              key={f.key}
              onClick={() => setFilterStatus(f.key)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors whitespace-nowrap ${
                filterStatus === f.key
                  ? 'bg-cyan/20 text-cyan border-cyan/30'
                  : f.highlight
                  ? 'bg-amber-500/10 text-amber-400 border-amber-500/20 hover:border-amber-500/30'
                  : 'bg-surface-2 text-slate-500 border-surface-3 hover:text-slate-300'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <select
          value={sortBy}
          onChange={e => setSortBy(e.target.value)}
          className="ml-auto text-xs bg-surface-2 border border-surface-3 text-slate-300 rounded-lg px-2 py-1.5 focus:outline-none"
        >
          <option value="spend">Ordenar: Spend</option>
          <option value="clicks">Ordenar: Cliques</option>
          <option value="acos">Ordenar: ACoS</option>
          <option value="created">Ordenar: Data</option>
        </select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-7 h-7 text-cyan animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
          <Shield className="w-12 h-12 text-slate-600" />
          <p className="text-sm text-slate-400">
            {suggestions.length === 0
              ? 'Sem sugestões de palavras negativas. Importe um relatório ou execute análise com IA.'
              : 'Nenhum termo encontrado com estes filtros.'}
          </p>
        </div>
      ) : (
        <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-2 bg-surface-2/40">
                  <th className="px-4 py-3 w-10">
                    <button
                      onClick={toggleSelectAll}
                      className="flex items-center justify-center w-5 h-5 rounded bg-surface-3 hover:bg-surface-2 transition-colors"
                    >
                      {selectedTerms.size === filtered.length && filtered.length > 0 ? (
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <Square className="w-3.5 h-3.5 text-slate-500" />
                      )}
                    </button>
                  </th>
                  {['Termo', 'Campanha', 'Tipo', 'Cliques', 'Spend', 'Vendas', 'ACoS', 'Motivo', 'Status', 'Ação'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(s => {
                  const isSelected = selectedTerms.has(s.id);
                  const isLoading = actionLoading === s.id;
                  const statusConfig = {
                    pending: { label: 'Pendente', color: 'text-amber-400 bg-amber-400/10 border-amber-400/20' },
                    approved: { label: 'Aprovado', color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
                    rejected: { label: 'Rejeitado', color: 'text-red-400 bg-red-400/10 border-red-400/20' },
                    executed: { label: 'Executado', color: 'text-cyan bg-cyan/10 border-cyan/20' },
                  }[s.status || 'pending'];

                  return (
                    <tr
                      key={s.id}
                      className={`border-b border-surface-2/40 hover:bg-surface-2/30 transition-colors ${
                        isSelected ? 'bg-cyan/5' : ''
                      }`}
                    >
                      <td className="px-4 py-3">
                        <button
                          onClick={() => toggleSelect(s.id)}
                          className={`flex items-center justify-center w-5 h-5 rounded transition-colors ${
                            isSelected
                              ? 'bg-cyan text-white'
                              : 'bg-surface-3 hover:bg-surface-2'
                          }`}
                        >
                          {isSelected ? <Check className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5 text-slate-500" />}
                        </button>
                      </td>
                      <td className="px-4 py-3 max-w-[200px]">
                        <p className="text-xs text-slate-200 truncate font-medium" title={s.keyword_text}>
                          {s.keyword_text}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-xs text-slate-400 truncate max-w-[150px]" title={s.campaign_name}>
                          {s.campaign_name || '—'}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs text-slate-400 capitalize">
                          {s.match_type === 'exact' ? 'Exata' : 'Frase'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-400">
                        {(s.clicks || 0).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-400">
                        ${(s.spend || 0).toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-xs text-emerald-400">
                        ${(s.sales || 0).toFixed(2)}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs font-semibold ${(s.acos || 0) > 50 ? 'text-red-400' : (s.acos || 0) > 30 ? 'text-amber-400' : (s.acos || 0) > 0 ? 'text-emerald-400' : 'text-slate-600'}`}>
                          {(s.acos || 0) > 0 ? `${(s.acos || 0).toFixed(1)}%` : '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3 max-w-[200px]">
                        <p className="text-xs text-slate-500 truncate" title={s.reason}>
                          {s.reason || '—'}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${statusConfig.color}`}>
                          {statusConfig.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 pr-5">
                        {s.status === 'pending' && (
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => approveSuggestion(s)}
                              disabled={isLoading}
                              className="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded-lg hover:bg-emerald-500/30 transition-colors disabled:opacity-50 whitespace-nowrap"
                            >
                              {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                              Aprovar
                            </button>
                            <button
                              onClick={() => rejectSuggestion(s)}
                              disabled={isLoading}
                              className="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold bg-red-500/20 text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/30 transition-colors disabled:opacity-50 whitespace-nowrap"
                            >
                              {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                              Rejeitar
                            </button>
                          </div>
                        )}
                        {s.status === 'approved' && (
                          <span className="flex items-center gap-1 text-xs text-emerald-400">
                            <CheckCircle className="w-3.5 h-3.5" />
                            Negativada
                          </span>
                        )}
                        {s.status === 'rejected' && (
                          <span className="flex items-center gap-1 text-xs text-red-400">
                            <X className="w-3.5 h-3.5" />
                            Descartada
                          </span>
                        )}
                        {s.status === 'executed' && (
                          <span className="flex items-center gap-1 text-xs text-cyan">
                            <CheckCircle className="w-3.5 h-3.5" />
                            Executada
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}