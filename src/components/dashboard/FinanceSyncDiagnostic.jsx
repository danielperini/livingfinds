/**
 * FinanceSyncDiagnostic — Painel de diagnóstico do sync de Finance Events
 * Mostra o que foi sincronizado vs o que o Seller Central deveria mostrar.
 * Colapsável, fechado por padrão.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { ChevronDown, ChevronUp, RefreshCw, Loader2, CheckCircle, AlertTriangle, XCircle, Wifi, WifiOff } from 'lucide-react';

function brlFmt(v) {
  if (v == null || v === 0) return null;
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v));
}

function pctFmt(v, d = 2) {
  if (v == null) return null;
  return `${Number(v).toFixed(d)}%`;
}

function StatusBadge({ value, isOk, isWarn }) {
  if (value == null) {
    return <span className="text-[10px] text-slate-600 italic">Aguardando sync</span>;
  }
  if (isOk) return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-400">
      <CheckCircle className="w-2.5 h-2.5" /> OK
    </span>
  );
  if (isWarn) return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/15 text-amber-400">
      <AlertTriangle className="w-2.5 h-2.5" /> Verificar
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-500/15 text-red-400">
      <XCircle className="w-2.5 h-2.5" /> Divergente
    </span>
  );
}

function Row({ label, synced, formatted, isOk, isWarn }) {
  const hasData = synced != null && synced !== 0;
  return (
    <div className="grid grid-cols-[1fr_1fr_auto] items-center py-2 border-b border-surface-2/40 last:border-0 gap-3">
      <span className="text-[11px] text-slate-400">{label}</span>
      <span className={`text-[11px] font-semibold ${hasData ? 'text-white' : 'text-slate-600 italic'}`}>
        {hasData ? formatted : '—'}
      </span>
      <StatusBadge value={hasData ? synced : null} isOk={isOk} isWarn={isWarn} />
    </div>
  );
}

export default function FinanceSyncDiagnostic({ accountId }) {
  const [open, setOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [data, setData] = useState(null);    // SalesDaily record
  const [syncLog, setSyncLog] = useState(null); // último SyncExecutionLog
  const [loading, setLoading] = useState(false);
  const [syncResult, setSyncResult] = useState(null);

  // D-1 em BRT
  const yesterday = (() => {
    const d = new Date(Date.now() - 3 * 3600000 - 86400000);
    return d.toISOString().slice(0, 10);
  })();

  const loadData = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    const [records, logs] = await Promise.all([
      base44.asServiceRole.entities.SalesDaily.filter(
        { amazon_account_id: accountId, date: yesterday }, null, 10
      ).catch(() => []),
      base44.asServiceRole.entities.SyncExecutionLog.filter(
        { amazon_account_id: accountId, operation: 'syncFinanceEventsFromSpApi' }, '-created_date', 1
      ).catch(() => []),
    ]);
    // Preferir registro sem asin (agregado)
    const aggRec = records.find(r => !r.asin) || records[0] || null;
    setData(aggRec);
    setSyncLog(logs[0] || null);
    setLoading(false);
  }, [accountId, yesterday]);

  useEffect(() => {
    if (open) loadData();
  }, [open, loadData]);

  const handleSync = async () => {
    if (!accountId || syncing) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await base44.functions.invoke('syncFinanceEventsFromSpApi', {
        amazon_account_id: accountId,
        _service_role: true,
      });
      setSyncResult(res?.data || {});
      if (res?.data?.ok) await loadData();
    } catch (e) {
      setSyncResult({ ok: false, error: e.message });
    } finally {
      setSyncing(false);
    }
  };

  const isSynced = data?.finance_sync_status === 'synced';
  const syncedAt = data?.finance_synced_at
    ? new Date(data.finance_synced_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : null;
  const lastSyncStatus = syncLog?.status;
  const lastSyncError  = syncLog?.error_message;
  const isAuthError    = lastSyncError && (lastSyncError.includes('invalid_client') || lastSyncError.includes('auth_error') || lastSyncError.includes('credenciais'));

  // Helpers de validação (sem referência fixa — compara com a lógica interna)
  const gr  = Number(data?.gross_revenue || 0);
  const nr  = Number(data?.net_revenue || 0);
  const fees= Number(data?.amazon_fees || 0);
  const ads = Number(data?.ads_spend || 0);
  const mpa = Number(data?.mpa_pct || 0);
  const tacos = gr > 0 ? (ads / gr) * 100 : 0;

  // Consistência interna: net_revenue ≈ gross_revenue - amazon_fees (±1%)
  const netConsistent = gr > 0 ? Math.abs((gr - fees - nr) / gr) < 0.02 : true;
  const tacosConsistent = tacos < 50; // TACoS acima de 50% é sinal de problema

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-surface-2/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${isSynced ? 'bg-emerald-400' : lastSyncStatus === 'error' ? 'bg-red-400' : 'bg-amber-400'}`} />
          <h2 className="text-sm font-semibold text-slate-300">Diagnóstico · Finance Events SP-API</h2>
          <span className="text-[10px] text-slate-500 bg-surface-2 px-2 py-0.5 rounded">D-1: {yesterday}</span>
          {isSynced && <span className="text-[10px] text-emerald-400/80 flex items-center gap-1"><Wifi className="w-3 h-3" /> Sincronizado</span>}
          {!isSynced && lastSyncStatus === 'error' && <span className="text-[10px] text-red-400/80 flex items-center gap-1"><WifiOff className="w-3 h-3" /> Erro no sync</span>}
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
      </button>

      {open && (
        <div className="px-5 pb-5">
          {loading ? (
            <div className="py-8 flex items-center justify-center gap-2 text-xs text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin" /> Carregando dados...
            </div>
          ) : (
            <>
              {/* Alerta de credenciais */}
              {isAuthError && (
                <div className="mb-3 flex items-start gap-2 px-3 py-2.5 rounded-lg bg-red-500/8 border border-red-500/20 text-[11px] text-red-300">
                  <XCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-red-400" />
                  <div>
                    <p className="font-semibold text-red-400 mb-0.5">Credenciais SP-API inválidas</p>
                    <p>Verifique <code className="bg-red-500/10 px-1 rounded">AMAZON_LWA_CLIENT_ID</code>, <code className="bg-red-500/10 px-1 rounded">AMAZON_LWA_CLIENT_SECRET</code> e <code className="bg-red-500/10 px-1 rounded">AMAZON_SP_REFRESH_TOKEN</code> nas configurações → Variáveis de ambiente.</p>
                  </div>
                </div>
              )}

              {/* Cabeçalho das colunas */}
              <div className="grid grid-cols-[1fr_1fr_auto] gap-3 py-1.5 mb-1 border-b border-surface-3">
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Métrica</span>
                <span className="text-[10px] font-semibold text-cyan uppercase tracking-wide">Sincronizado (SP-API)</span>
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Status</span>
              </div>

              <Row label="Faturamento Bruto" synced={gr || null} formatted={brlFmt(gr)} isOk={gr > 0} isWarn={false} />
              <Row label="Líq. do Marketplace" synced={nr || null} formatted={brlFmt(nr)} isOk={nr > 0 && netConsistent} isWarn={nr > 0 && !netConsistent} />
              <Row label="Taxas Amazon (total)" synced={fees || null} formatted={brlFmt(fees)} isOk={fees > 0} isWarn={false} />
              <Row label="MPA %" synced={mpa || null} formatted={pctFmt(mpa)} isOk={mpa > 5 && mpa < 30} isWarn={mpa >= 30} />
              <Row label="Gasto em Ads (D-1)" synced={ads || null} formatted={brlFmt(ads)} isOk={ads > 0} isWarn={false} />
              <Row label="TACoS (real)" synced={tacos || null} formatted={pctFmt(tacos)} isOk={tacos > 0 && tacosConsistent} isWarn={tacos >= 50} />
              <Row label="Pedidos" synced={data?.orders || null} formatted={String(data?.orders || '—')} isOk={(data?.orders || 0) > 0} isWarn={false} />
              <Row label="Unidades" synced={data?.units_ordered || null} formatted={String(data?.units_ordered || '—')} isOk={(data?.units_ordered || 0) > 0} isWarn={false} />

              {/* Detalhamento de taxas */}
              {isSynced && (
                <div className="mt-3 grid grid-cols-3 gap-2">
                  {[
                    { label: 'Referral Fee', value: brlFmt(data?.referral_fee) },
                    { label: 'FBA Fee', value: brlFmt(data?.fba_fee) },
                    { label: 'Tax retido', value: brlFmt(data?.tax_withheld) },
                  ].map(({ label, value }) => (
                    <div key={label} className="bg-surface-2 rounded-lg p-2 text-center">
                      <p className="text-[9px] text-slate-500 uppercase tracking-wide">{label}</p>
                      <p className="text-xs font-bold text-slate-300 mt-0.5">{value || '—'}</p>
                    </div>
                  ))}
                </div>
              )}

              {/* Resultado do sync manual */}
              {syncResult && (
                <div className={`mt-3 px-3 py-2 rounded-lg text-[11px] border ${
                  syncResult.ok
                    ? 'bg-emerald-500/8 border-emerald-500/20 text-emerald-400'
                    : 'bg-red-500/8 border-red-500/20 text-red-400'
                }`}>
                  {syncResult.ok
                    ? `✓ Sync concluído — ${syncResult.days_processed || 0} dias, ${syncResult.total_events || 0} eventos (credencial: ${syncResult.token_source || '?'})`
                    : `✗ ${syncResult.error || syncResult.error_type || 'Falha no sync'}${syncResult.help ? ` — ${syncResult.help}` : ''}`
                  }
                </div>
              )}

              {/* Rodapé */}
              <div className="flex items-center justify-between mt-4 pt-3 border-t border-surface-2/40">
                <div className="text-[10px] text-slate-600">
                  {syncedAt
                    ? `Último sync: ${syncedAt} · ${data?.finance_events_count || 0} eventos`
                    : 'Nenhum sync realizado ainda para esta data'
                  }
                </div>
                <button
                  onClick={handleSync}
                  disabled={syncing}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-2 border border-surface-3 hover:border-cyan/30 rounded-lg text-xs text-slate-300 hover:text-white transition-colors disabled:opacity-50"
                >
                  {syncing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                  {syncing ? 'Sincronizando...' : 'Sincronizar agora'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}