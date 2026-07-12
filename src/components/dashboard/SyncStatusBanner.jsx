import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { AlertTriangle, WifiOff, Clock, CheckCircle, RefreshCw, X, ChevronDown, ChevronUp, Play, Loader2, ShieldAlert, Zap } from 'lucide-react';
import { Link } from 'react-router-dom';

const STATUS_CONFIG = {
  ok:         { icon: CheckCircle,  color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20', label: 'Sincronização OK' },
  stale:      { icon: Clock,        color: 'text-amber-400',   bg: 'bg-amber-500/10 border-amber-500/25',    label: 'Dados desatualizados' },
  error:      { icon: AlertTriangle,color: 'text-red-400',     bg: 'bg-red-500/10 border-red-500/25',        label: 'Falha na sincronização' },
  rate_limit: { icon: WifiOff,      color: 'text-orange-400',  bg: 'bg-orange-500/10 border-orange-500/25',  label: 'Limite de chamadas atingido' },
};

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
  const [selected, setSelected]   = useState(new Set());
  const [reprocessing, setReprocessing] = useState(false);
  const [reprocessResults, setReprocessResults] = useState([]);
  const [tokenInvalid, setTokenInvalid] = useState(false);
  const [tokenDismissed, setTokenDismissed] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    loadStatus();
    checkToken();
    const interval = setInterval(loadStatus, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [accountId]);

  async function checkToken() {
    try {
      const res = await base44.functions.invoke('getOAuthSetupInfo', {});
      const d = res?.data;
      if (d && d.token_status && d.token_status !== 'valid' && d.token_status !== 'not_configured') {
        setTokenInvalid(true);
      }
    } catch { /* silencioso */ }
  }

  async function loadStatus() {
    try {
      const [recentLogs, accounts] = await Promise.all([
        base44.entities.SyncExecutionLog.filter({ amazon_account_id: accountId }, '-started_at', 10),
        base44.entities.AmazonAccount.filter({ id: accountId }),
      ]);
      setLogs(recentLogs);
      setSelected(new Set());
      setReprocessResults([]);

      const account = accounts[0];
      const accountSyncAt = account?.last_sync_at;

      const hasRateLimit = recentLogs.slice(0, 3).some(
        l => l.status === 'error' && /rate.?limit|429|too many/i.test(l.error_message || '')
      );
      if (hasRateLimit) { setStatus('rate_limit'); return; }

      // Calcular idade do último sync: priorizar last_sync_at da conta (mais confiável)
      let ageHours = 999;
      if (accountSyncAt) {
        ageHours = (Date.now() - new Date(accountSyncAt).getTime()) / 3600000;
      } else {
        const lastSuccess = recentLogs.find(l => l.status === 'success' || l.status === 'skipped_limit');
        if (lastSuccess) {
          ageHours = (Date.now() - new Date(lastSuccess.started_at || lastSuccess.created_date).getTime()) / 3600000;
        }
      }

      // Se dados estão atualizados (< 26h = dentro do ciclo diário), mostrar OK
      if (ageHours < 26) { setStatus('ok'); return; }

      // Verificar erros recentes apenas quando dados estão desatualizados
      if (recentLogs.length > 0 && recentLogs[0].status === 'error') { setStatus('error'); return; }

      setStatus(ageHours < 999 ? 'stale' : (recentLogs.length === 0 ? 'stale' : 'ok'));
    } catch {
      setStatus(null);
    }
  }

  async function reprocessSelected() {
    if (selected.size === 0 || reprocessing) return;
    setReprocessing(true);
    setReprocessResults([]);

    const errorLogs = logs.filter(l => l.status === 'error');
    const targets = errorLogs.filter(l => selected.has(l.id));
    const results = [];

    for (const log of targets) {
      const fn = OPERATION_SYNC_FN[log.operation] || 'syncAdsQuick';
      try {
        const res = await base44.functions.invoke(fn, { amazon_account_id: accountId });
        const ok = res?.data?.ok !== false;
        const errMsg = res?.data?.error || res?.data?.message || 'Falhou';
        results.push({ logId: log.id, ok, message: ok ? 'Sincronizado com sucesso' : errMsg });
      } catch (e) {
        const errMsg = e?.response?.data?.error || e?.response?.data?.message || e.message || 'Erro ao invocar função';
        results.push({ logId: log.id, ok: false, message: errMsg });
      }
      if (targets.indexOf(log) < targets.length - 1) await sleep(1500);
    }

    setReprocessResults(results);
    setReprocessing(false);
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
    const errorLogs = logs.filter(l => l.status === 'error');
    if (selected.size === errorLogs.length) setSelected(new Set());
    else setSelected(new Set(errorLogs.map(l => l.id)));
  }

  const showSyncBanner = status !== null && !dismissed && status !== 'ok';
  const showTokenBanner = tokenInvalid && !tokenDismissed;

  const cfg = showSyncBanner ? STATUS_CONFIG[status] : null;
  const Icon = cfg?.icon;
  const lastSuccess = logs.find(l => l.status === 'success' || l.status === 'skipped_limit');
  const errorLogs = logs.filter(l => l.status === 'error');
  const allSelected = errorLogs.length > 0 && selected.size === errorLogs.length;

  if (!showTokenBanner && !showSyncBanner) return null;

  return (
    <div className="space-y-2">
      {showTokenBanner ? (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <ShieldAlert className="w-5 h-5 text-red-400 flex-shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-bold text-red-300">Token Amazon Ads inválido ou expirado</p>
              <p className="text-xs text-red-400/70 mt-0.5">Todas as operações de campanhas falham com "Not authorized". Reautorize para restaurar o funcionamento.</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Link to="/amazon-oauth-setup"
              className="flex items-center gap-1.5 px-3 py-2 bg-red-500 hover:bg-red-400 text-white text-xs font-bold rounded-lg transition-colors whitespace-nowrap">
              <Zap className="w-3.5 h-3.5" /> Reautorizar agora
            </Link>
            <button onClick={() => setTokenDismissed(true)} className="p-1.5 text-slate-500 hover:text-slate-300">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      ) : null}

      {showSyncBanner ? (
        <div className={`rounded-xl border px-4 py-3 ${cfg.bg}`}>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <Icon className={`w-4 h-4 flex-shrink-0 ${cfg.color}`} />
              <div className="min-w-0">
                <span className={`text-sm font-semibold ${cfg.color}`}>{cfg.label}</span>
                {status === 'rate_limit' ? (
                  <span className="ml-2 text-xs text-slate-500">Detalhes na Sala de Controle</span>
                ) : null}
              </div>
            </div>

            <div className="flex items-center gap-1.5 flex-shrink-0">
              {errorLogs.length > 0 ? (
                <button
                  onClick={() => { setExpanded(v => !v); setReprocessResults([]); }}
                  className="flex items-center gap-1 px-2 py-1 text-xs text-slate-400 hover:text-slate-200 rounded-lg bg-white/5 hover:bg-white/10 transition-colors"
                >
                  {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  {errorLogs.length} erro{errorLogs.length > 1 ? 's' : ''}
                </button>
              ) : null}
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

          {expanded && errorLogs.length > 0 ? (
            <div className="mt-3 border-t border-white/10 pt-3 space-y-2">
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
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors bg-red-500/20 border border-red-500/30 text-red-300 hover:bg-red-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {reprocessing ? (
                    <span className="flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Reprocessando...</span>
                  ) : (
                    <span className="flex items-center gap-1.5"><Play className="w-3 h-3" /> Reprocessar Selecionados ({selected.size})</span>
                  )}
                </button>
              </div>

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
                        {result ? (
                          <span className={`font-semibold ${result.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                            {result.ok ? '✓ OK' : `✗ ${result.message}`}
                          </span>
                        ) : null}
                      </div>
                      <p className="text-red-400 truncate">{log.error_message || 'Erro desconhecido'}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}