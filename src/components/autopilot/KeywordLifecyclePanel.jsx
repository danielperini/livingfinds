/**
 * KeywordLifecyclePanel — Painel de ciclo de vida de keywords
 * Mostra origem, janela de 48h, status, substituição por termos reais
 */
import React, { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { Brain, Clock, CheckCircle, XCircle, ArrowRight, RefreshCw, Loader2, Zap, AlertTriangle, Play } from 'lucide-react';

const STATUS_CONFIG = {
  experimental:  { label: 'Experimental (IA)',            color: 'text-violet-400',  bg: 'bg-violet-500/15 border-violet-500/30' },
  learning:      { label: 'Em aprendizado',               color: 'text-blue-400',    bg: 'bg-blue-500/15 border-blue-500/30' },
  performing:    { label: 'Performando',                  color: 'text-emerald-400', bg: 'bg-emerald-500/15 border-emerald-500/30' },
  no_delivery:   { label: 'Sem entrega (observação)',     color: 'text-amber-400',   bg: 'bg-amber-500/15 border-amber-500/30' },
  paused:        { label: 'Pausado automaticamente',      color: 'text-red-400',     bg: 'bg-red-500/15 border-red-500/30' },
  replaced:      { label: 'Substituído por termo real',   color: 'text-slate-400',   bg: 'bg-slate-500/15 border-slate-500/30' },
  promoted:      { label: 'Promovido → Manual EXACT',     color: 'text-emerald-300', bg: 'bg-emerald-500/10 border-emerald-500/20' },
  blocked:       { label: 'Bloqueado',                    color: 'text-red-500',     bg: 'bg-red-500/20 border-red-500/40' },
};

const SOURCE_CONFIG = {
  ai_generated:           { label: 'IA',            color: 'text-violet-400',  bg: 'bg-violet-500/10' },
  amazon_suggested:       { label: 'Amazon',         color: 'text-amber-400',   bg: 'bg-amber-500/10' },
  automatic_search_term:  { label: 'Search Term Real', color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  manual:                 { label: 'Manual',         color: 'text-cyan',        bg: 'bg-cyan/10' },
};

function StatusBadge({ status }) {
  const c = STATUS_CONFIG[status] || { label: status, color: 'text-slate-400', bg: 'bg-slate-500/15 border-slate-500/30' };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${c.bg} ${c.color}`}>{c.label}</span>;
}

function SourceBadge({ source }) {
  const c = SOURCE_CONFIG[source] || { label: source, color: 'text-slate-400', bg: 'bg-slate-500/10' };
  return <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold ${c.bg} ${c.color}`}>{c.label}</span>;
}

function Window48h({ enabledAt, dueat }) {
  if (!enabledAt) return <span className="text-slate-600 text-[10px]">Não iniciado</span>;
  const due = new Date(dueat || new Date(new Date(enabledAt).getTime() + 48 * 60 * 60 * 1000));
  const now = new Date();
  const remaining = due - now;
  if (remaining <= 0) return <span className="text-red-400 text-[10px]">Janela encerrada</span>;
  const hrs = Math.floor(remaining / 3600000);
  const mins = Math.floor((remaining % 3600000) / 60000);
  return (
    <span className="text-amber-400 text-[10px] flex items-center gap-1">
      <Clock className="w-3 h-3" />
      {hrs}h {mins}m restantes
    </span>
  );
}

export default function KeywordLifecyclePanel({ account }) {
  const [lifecycles, setLifecycles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [msg, setMsg] = useState(null);
  const [tab, setTab] = useState('experimental');
  const [filterAsin, setFilterAsin] = useState('');

  const aid = account?.id;

  const load = useCallback(async () => {
    if (!aid) return;
    setLoading(true);
    const data = await base44.entities.KeywordLifecycle.filter({ amazon_account_id: aid }, '-created_at', 500);
    setLifecycles(data);
    setLoading(false);
  }, [aid]);

  useEffect(() => { load(); }, [load]);

  const runEvaluation = async () => {
    setRunning(true);
    setMsg(null);
    try {
      const res = await base44.functions.invoke('evaluateAIKeywordsAfter48Hours', { amazon_account_id: aid });
      const d = res.data || {};
      setMsg({ type: d.ok ? 'success' : 'error', text: d.ok ? `Avaliado: ${d.evaluated} · Pausadas: ${d.paused} · Promovidas: ${d.promoted_to_learning}` : d.error });
      if (d.ok) await load();
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    }
    setRunning(false);
    setTimeout(() => setMsg(null), 8000);
  };

  const runReplacement = async () => {
    setReplacing(true);
    setMsg(null);
    try {
      const res = await base44.functions.invoke('replaceAIKeywordsWithRealTerms', { amazon_account_id: aid });
      const d = res.data || {};
      setMsg({ type: d.ok ? 'success' : 'error', text: d.ok ? `Substituídas: ${d.replaced} · Candidatos à promoção: ${d.promotion_candidates_created}` : d.error });
      if (d.ok) await load();
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    }
    setReplacing(false);
    setTimeout(() => setMsg(null), 8000);
  };

  const byStatus = {
    experimental: lifecycles.filter(lc => lc.status === 'experimental'),
    learning:     lifecycles.filter(lc => lc.status === 'learning' || lc.status === 'no_delivery'),
    paused:       lifecycles.filter(lc => lc.status === 'paused'),
    replaced:     lifecycles.filter(lc => lc.status === 'replaced' || lc.status === 'promoted'),
  };

  const tabItems = {
    experimental: byStatus.experimental,
    learning: byStatus.learning,
    paused: byStatus.paused,
    replaced: byStatus.replaced,
  };

  const filtered = (tabItems[tab] || []).filter(lc =>
    !filterAsin || lc.asin?.toLowerCase().includes(filterAsin.toLowerCase()) ||
    lc.keyword_text?.toLowerCase().includes(filterAsin.toLowerCase())
  );

  // Estatísticas
  const dueForEval = byStatus.experimental.filter(lc =>
    lc.evaluation_due_at && new Date(lc.evaluation_due_at) <= new Date()
  ).length;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="bg-surface-1 border border-violet-500/20 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-violet-500/15 border border-violet-500/30 flex items-center justify-center">
              <Brain className="w-4 h-4 text-violet-400" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">Ciclo de Vida das Keywords</h2>
              <p className="text-[10px] text-slate-500">Termos de IA → 48h operacionais → substituição por termos reais</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={load} disabled={loading} className="p-1.5 text-slate-400 hover:text-slate-200">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={runReplacement}
              disabled={replacing || !aid}
              className="flex items-center gap-1.5 px-3 py-2 bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25 text-xs rounded-lg transition-colors disabled:opacity-50"
            >
              {replacing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}
              Substituir por Reais
            </button>
            <button
              onClick={runEvaluation}
              disabled={running || !aid}
              className="flex items-center gap-1.5 px-3 py-2 bg-violet-500/15 border border-violet-500/30 text-violet-300 hover:bg-violet-500/25 text-xs rounded-lg transition-colors disabled:opacity-50"
            >
              {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              Avaliar 48h
            </button>
          </div>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {[
            { label: 'Experimental (IA)', value: byStatus.experimental.length, color: 'text-violet-400' },
            { label: 'Vencimento hoje', value: dueForEval, color: dueForEval > 0 ? 'text-amber-400' : 'text-slate-500' },
            { label: 'Em aprendizado', value: byStatus.learning.length, color: 'text-blue-400' },
            { label: 'Pausadas auto.', value: byStatus.paused.length, color: 'text-red-400' },
            { label: 'Substituídas/Promovidas', value: byStatus.replaced.length, color: 'text-emerald-400' },
          ].map((kpi, i) => (
            <div key={i} className="bg-surface-2 rounded-lg p-3">
              <p className="text-[10px] text-slate-500 mb-1">{kpi.label}</p>
              <p className={`text-xl font-bold ${kpi.color}`}>{kpi.value}</p>
            </div>
          ))}
        </div>

        {dueForEval > 0 && (
          <div className="mt-3 flex items-center gap-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-400">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
            {dueForEval} keyword(s) com janela de 48h vencida aguardando avaliação. Clique em "Avaliar 48h".
          </div>
        )}

        {msg && (
          <div className={`mt-3 flex items-center gap-2 p-2.5 rounded-lg text-xs ${msg.type === 'success' ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border border-red-500/20 text-red-400'}`}>
            {msg.type === 'success' ? <CheckCircle className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
            {msg.text}
          </div>
        )}
      </div>

      {/* Filtro */}
      <input
        value={filterAsin}
        onChange={e => setFilterAsin(e.target.value)}
        placeholder="Filtrar por ASIN ou keyword..."
        className="w-full max-w-sm rounded-lg border border-surface-2 bg-surface-1 px-3 py-2 text-sm text-white placeholder-slate-500"
      />

      {/* Tabs */}
      <div className="flex border-b border-surface-2 gap-1 flex-wrap">
        {[
          { id: 'experimental', label: `Experimental IA (${byStatus.experimental.length})` },
          { id: 'learning',     label: `Aprendizado (${byStatus.learning.length})` },
          { id: 'paused',       label: `Pausados (${byStatus.paused.length})` },
          { id: 'replaced',     label: `Substituídos (${byStatus.replaced.length})` },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 text-xs font-medium border-b-2 transition-colors ${tab === t.id ? 'border-violet-400 text-violet-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 text-violet-400 animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-slate-500 text-sm">
          <Brain className="w-10 h-10 text-slate-600 mx-auto mb-3" />
          Nenhuma keyword nesta categoria.
        </div>
      ) : (
        <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-surface-2 bg-surface-2/50">
                  {['Keyword', 'ASIN', 'Origem', 'Janela 48h', 'Impr.', 'Clicks', 'Vendas', 'Status', 'Substituída por / Pausa'].map(h => (
                    <th key={h} className="px-3 py-2.5 text-left text-[10px] text-slate-500 uppercase whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(lc => (
                  <tr key={lc.id} className="border-b border-surface-2/50 hover:bg-surface-2/40 transition-colors">
                    <td className="px-3 py-2.5 font-semibold text-white max-w-[180px]">
                      <p className="truncate" title={lc.keyword_text}>{lc.keyword_text}</p>
                      <p className="text-[9px] text-slate-500 font-mono">{lc.match_type}</p>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-cyan text-[10px]">{lc.asin}</td>
                    <td className="px-3 py-2.5"><SourceBadge source={lc.source} /></td>
                    <td className="px-3 py-2.5">
                      {lc.source === 'ai_generated' && lc.status === 'experimental' ? (
                        <Window48h enabledAt={lc.enabled_at} dueat={lc.evaluation_due_at} />
                      ) : lc.enabled_at ? (
                        <span className="text-slate-500 text-[10px]">
                          Iniciado: {new Date(lc.enabled_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      ) : <span className="text-slate-600 text-[10px]">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-slate-300">{(lc.impressions || 0).toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-slate-300">{lc.clicks || 0}</td>
                    <td className="px-3 py-2.5 text-emerald-400">{lc.orders || 0}</td>
                    <td className="px-3 py-2.5"><StatusBadge status={lc.status} /></td>
                    <td className="px-3 py-2.5 max-w-[200px]">
                      {lc.source_search_term && (
                        <div className="flex items-center gap-1 text-[10px]">
                          <ArrowRight className="w-3 h-3 text-emerald-400 flex-shrink-0" />
                          <span className="text-emerald-300 truncate" title={lc.source_search_term}>{lc.source_search_term}</span>
                        </div>
                      )}
                      {lc.pause_reason && !lc.source_search_term && (
                        <p className="text-[10px] text-red-400 truncate" title={lc.pause_reason}>{lc.pause_reason}</p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}