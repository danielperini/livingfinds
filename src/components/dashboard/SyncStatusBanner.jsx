import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { AlertTriangle, WifiOff, Clock, CheckCircle, RefreshCw, X, ChevronDown, ChevronUp, Play, Loader2 } from 'lucide-react';

const STATUS_CONFIG = {
  ok:         { icon: CheckCircle,  color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20', label: 'Sincronização OK' },
  stale:      { icon: Clock,        color: 'text-amber-400',   bg: 'bg-amber-500/10 border-amber-500/25',    label: 'Dados desatualizados' },
  error:      { icon: AlertTriangle,color: 'text-red-400',     bg: 'bg-red-500/10 border-red-500/25',        label: 'Falha na sincronização' },
  rate_limit: { icon: WifiOff,      color: 'text-orange-400',  bg: 'bg-orange-500/10 border-orange-500/25',  label: 'Limite de chamadas atingido' },
};

// Mapeia operation do log → função de sync a invocar
const OPERATION_SYNC_FN = {
  ads_sync:     'syncAdsQuick',
  quick_sync:   'syncAdsQuick',
  full_sync:    'syncAdsQuick',
  metrics_sync: 'syncAdsQuick',
  product_sync: 'syncAdsQuick',
};

function timeAgo(dateStr) {
  if (!dateStr) return null;
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 60) return `${diff}s atrás`;
  if (diff < 3600) return `${Math.floor(diff / 60)}min atrás`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h atrás`;
  return `${Math.floor(diff / 86400)}d atrás`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export default function SyncStatusBanner({ accountId }) {
  const [status, setStatus]       = useState(null);
  const [logs, setLogs]           = useState([]);
  const [expanded, setExpanded]   = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [selected, setSelected]   = useState(new Set()); // IDs dos logs selecionados
  const [reprocessing, setReprocessing] = useState(false);
  const [reprocessResults, setReprocessResults] = useState([]); // { logId, ok, message }

  useEffect(() => {
    if (!accountId) return;
    loadStatus();
    const interval = setInterval(loadStatus, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [accountId]);

  async function loadStatus() {
    try {
      const recentLogs = await base44.entities.SyncExecutionLog.filter(
        { amazon_account_id: accountId },
        '-started_at',
        10
      );
      setLogs(recentLogs);
      setSelected(new Set()); // limpa seleção ao recarregar
      setReprocessResults([]);

      if (recentLogs.length === 0) { setStatus('stale'); return; }

      const hasRateLimit = recentLogs.slice(0, 3).some(
        l => l.status === 'error' && /rate.?limit|429|too many/i.test(l.error_message || '')
      );
      if (hasRateLimit) { setStatus('rate_limit'); return; }

      if (recentLogs[0].status === 'error') { setStatus('error'); return; }

      const lastSuccess = recentLogs.find(l => l.status === 'success' || l.status === 'skipped_limit');
      if (!lastSuccess) { setStatus('error'); return; }

      const ageHours = (Date.now() - new Date(lastSuccess.started_at || lastSuccess.created_date).getTime()) / 3600000;
      setStatus(ageHours > 3 ? 'stale' : 'ok');
    } catch {
      setStatus(null);
    }
  }

  async function reprocessSelected() {
    if (selected.size === 0 || reprocessing) return;
    setReprocessing(true);
    setReprocessResults([]);

    const targets = errorLogs.filter(l => selected.has(l.id));
    const results = [];

    for (const log of targets) {
      const fn = OPERATION_SYNC_FN[log.operation] || 'syncAdsQuick';
      try {
        const res = await base44.functions.invoke(fn, { amazon_account_id: accountId });
        const ok = res?.data?.ok !== false;
        results.push({ logId: log.id, ok, message: ok ? 'Reprocessado com sucesso' : (res?.data?.error || 'Falhou') });
      } catch (e) {
        results.push({ logId: log.id, ok: false, message: e.message || 'Erro ao invocar função' });
      }
      // Pausa entre chamadas para evitar rate limit
      if (targets.indexOf(log) < targets.length - 1) await sleep(1500);
    }

    setReprocessResults(results);
    setReprocessing(false);

    // Se todos OK, recarrega status após 2s
    if (results.every(r => r.ok)) setTimeout(loadStatus, 2000);
  }

  function toggleSelect(id) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selected.size === errorLogs.length) setSelected(new Set());
    else setSelected(new Set(errorLogs.map(l => l.id)));
  }

  if (status === null || dismissed || status === 'ok') return null;

  const cfg = STATUS_CONFIG[status];
  const Icon = cfg.icon;
  const lastSuccess = logs.find(l => l.status === 'success' || l.status === 'skipped_limit');
  const errorLogs = logs.filter(l => l.status === 'error');
  const allSelected = errorLogs.length > 0 && selected.size === errorLogs.length;

  return (
    <div className={`rounded-xl border px-4 py-3 ${cfg.bg}`}>
      {/* Header row */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <Icon className={`w-4 h-4 flex-shrink-0 ${cfg.color}`} />
          <div className="min-w-0">
            <span className={`text-sm font-semibold ${cfg.color}`}>{cfg.label}</span>
            {lastSuccess ? (
              <span className="ml-2 text-xs text-slate-500">
                Último sync OK: {timeAgo(lastSuccess.started_at || lastSuccess.created_date)}
              </span>
            ) : (
              <span className="ml-2 text-xs text-slate-500">Nenhum sync bem-sucedido encontrado</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          {errorLogs.length > 0 && (
            <button
              onClick={() => { setExpanded(v => !v); setReprocessResults([]); }}
              className="flex items-center gap-1 px-2 py-1 text-xs text-slate-400 hover:text-slate-200 rounded-lg bg-white/5 hover:bg-white/10 transition-colors"
            >
              {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              {errorLogs.length} erro{errorLogs.length > 1 ? 's' : ''}
            </button>
          )}
          <button onClick={loadStatus} title="Verificar novamente"
            className="p-1.5 text-slate-400 hover:text-slate-200 rounded-lg bg-white/5 hover:bg-white/10 transition-colors">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => setDismissed(true)} title="Dispensar"
            className="p-1.5 text-slate-400 hover:text-slate-200 rounded-lg bg-white/5 hover:bg-white/10 transition-colors">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Lista de erros com seleção */}
      {expanded && errorLogs.length > 0 && (
        <div className="mt-3 border-t border-white/10 pt-3 space-y-2">

          {/* Barra de ações */}
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleSelectAll}
                className="w-3.5 h-3.5 rounded accent-red-400 cursor-pointer"
              />
              <span className="text-xs text-slate-400">
                {allSelected ? 'Desmarcar todos' : 'Selecionar todos'}
              </span>
            </label>

            <button
              onClick={reprocessSelected}
              disabled={selected.size === 0 || reprocessing}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors
                bg-red-500/20 border border-red-500/30 text-red-300
                hover:bg-red-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {reprocessing
                ? <><Loader2 className="w-3 h-3 animate-spin" /> Reprocessando...</>
                : <><Play className="w-3 h-3" /> Reprocessar Selecionados ({selected.size})</>
              }
            </button>
          </div>

          {/* Linhas de erro */}
          {errorLogs.slice(0, 5).map((log) => {
            const result = reprocessResults.find(r => r.logId === log.id);
            return (
              <div key={log.id}
                className={`flex items-start gap-2.5 p-2 rounded-lg text-xs transition-colors
                  ${selected.has(log.id) ? 'bg-white/5' : 'bg-transparent'}
                  ${result?.ok ? 'border border-emerald-500/20' : result ? 'border border-red-500/20' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={selected.has(log.id)}
                  onChange={() => toggleSelect(log.id)}
                  className="w-3.5 h-3.5 mt-0.5 rounded accent-red-400 cursor-pointer flex-shrink-0"
                />
                <div className="flex-1 min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-slate-500 font-mono">{timeAgo(log.started_at || log.created_date)}</span>
                    <span className="text-slate-300 font-semibold uppercase tracking-wide">{log.operation}</span>
                    {result && (
                      <span className={`font-semibold ${result.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                        {result.ok ? '✓ OK' : `✗ ${result.message}`}
                      </span>
                    )}
                  </div>
                  <p className="text-red-400 truncate">{log.error_message || 'Erro desconhecido'}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}