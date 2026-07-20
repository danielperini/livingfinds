/**
 * FinanceAuditPanel — Painel de Aferição Econômica D-1
 * Compara dados da SP-API Finance Events com referência do Seller Central.
 * Colapsável por padrão.
 */
import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { ChevronDown, ChevronUp, RefreshCw, Loader2, CheckCircle, AlertTriangle, XCircle } from 'lucide-react';

// Referência fixa do Seller Central (conforme PRD — 19/jul)
const SELLER_CENTRAL_REF = {
  date: '2026-07-19',
  gross_revenue: 1001.56,
  net_revenue: 825.08,
  amazon_fees: 176.48,
  gross_profit: 250.33,
  gross_margin_pct: 24.99,
  ads_spend: 95.74,
  tacos_pct: 9.56,
  profit_after_ads: 154.59,
  mpa_pct: 15.43,
  units: 12,
  orders: 10,
  ticket_medio: 100.16,
  roi_pct: 49.55,
};

function fmtBRL(v) {
  if (v == null || isNaN(Number(v))) return '—';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v));
}
function fmtPct(v, decimals = 2) {
  if (v == null || isNaN(Number(v))) return '—';
  return `${Number(v).toFixed(decimals)}%`;
}

function DeltaBadge({ spApi, ref, unit = 'brl', lowerIsBetter = false }) {
  if (spApi == null || !ref) return <span className="text-[10px] text-slate-600">—</span>;
  const delta = ref > 0 ? Math.abs((spApi - ref) / ref) * 100 : 0;
  if (delta <= 3) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-400">
        <CheckCircle className="w-2.5 h-2.5" /> OK
      </span>
    );
  }
  if (delta <= 15) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/15 text-amber-400">
        <AlertTriangle className="w-2.5 h-2.5" /> ⚠ {delta.toFixed(1)}%
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-500/15 text-red-400">
      <XCircle className="w-2.5 h-2.5" /> {delta.toFixed(1)}%
    </span>
  );
}

function AuditRow({ label, spApiValue, refValue, format = 'brl' }) {
  const fmt = format === 'pct' ? fmtPct : fmtBRL;
  const hasSpApi = spApiValue != null && Number(spApiValue) !== 0;
  return (
    <div className="grid grid-cols-3 items-center py-2 border-b border-surface-2/50 last:border-0 gap-2">
      <span className="text-[11px] text-slate-400">{label}</span>
      <span className={`text-[11px] font-semibold ${hasSpApi ? 'text-white' : 'text-slate-600 italic'}`}>
        {hasSpApi ? fmt(spApiValue) : 'Aguardando sync'}
      </span>
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-slate-500">{fmt(refValue)}</span>
        <DeltaBadge spApi={hasSpApi ? Number(spApiValue) : null} ref={Number(refValue)} />
      </div>
    </div>
  );
}

export default function FinanceAuditPanel({ accountId }) {
  const [open, setOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [financeData, setFinanceData] = useState(null);
  const [loadingData, setLoadingData] = useState(false);

  // Carregar dados do SalesDaily para a data de referência
  useEffect(() => {
    if (!open || !accountId) return;
    setLoadingData(true);
    base44.asServiceRole.entities.SalesDaily.filter(
      { amazon_account_id: accountId, date: SELLER_CENTRAL_REF.date }, null, 10
    ).then(records => {
      // Preferir registro sem ASIN (agregado do dia)
      const agg = records.find(r => !r.asin) || records[0] || null;
      setFinanceData(agg);
    }).catch(() => setFinanceData(null))
    .finally(() => setLoadingData(false));
  }, [open, accountId, syncResult]);

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
    } catch (e) {
      setSyncResult({ ok: false, error: e.message });
    } finally {
      setSyncing(false);
    }
  };

  const fd = financeData;
  const syncedAt = fd?.finance_synced_at
    ? new Date(fd.finance_synced_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
      {/* Header colapsável */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-surface-2/40 transition-colors"
      >
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-amber-400" />
          <h2 className="text-sm font-semibold text-slate-300">Aferição Econômica · D-1</h2>
          <span className="text-[10px] text-slate-500 bg-surface-2 px-2 py-0.5 rounded">
            Ref: {SELLER_CENTRAL_REF.date}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!open && (
            <span className="text-[10px] text-slate-500">
              Clique para expandir a comparação SP-API vs Seller Central
            </span>
          )}
          {open ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
        </div>
      </button>

      {open && (
        <div className="px-5 pb-5">
          {/* Legenda das colunas */}
          <div className="grid grid-cols-3 gap-2 py-2 mb-1 border-b border-surface-3">
            <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Métrica</span>
            <span className="text-[10px] font-semibold text-cyan uppercase tracking-wide">SP-API (synced)</span>
            <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Seller Central + badge</span>
          </div>

          {loadingData ? (
            <div className="py-6 flex items-center justify-center gap-2 text-xs text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin" /> Carregando dados financeiros...
            </div>
          ) : (
            <div>
              <AuditRow label="Faturamento Bruto" spApiValue={fd?.gross_revenue} refValue={SELLER_CENTRAL_REF.gross_revenue} />
              <AuditRow label="Faturamento Líquido" spApiValue={fd?.net_revenue} refValue={SELLER_CENTRAL_REF.net_revenue} />
              <AuditRow label="Taxas Amazon (total)" spApiValue={fd?.amazon_fees} refValue={SELLER_CENTRAL_REF.amazon_fees} />
              <AuditRow label="Lucro Bruto" spApiValue={fd?.gross_profit} refValue={SELLER_CENTRAL_REF.gross_profit} />
              <AuditRow label="Margem Bruta" spApiValue={fd?.gross_margin_pct} refValue={SELLER_CENTRAL_REF.gross_margin_pct} format="pct" />
              <AuditRow label="MPA %" spApiValue={fd?.mpa_pct} refValue={SELLER_CENTRAL_REF.mpa_pct} format="pct" />
              <AuditRow label="Gasto Ads" spApiValue={fd?.ads_spend} refValue={SELLER_CENTRAL_REF.ads_spend} />
              <AuditRow label="TACoS" spApiValue={fd?.ads_spend && fd?.gross_revenue ? (fd.ads_spend / fd.gross_revenue * 100) : null} refValue={SELLER_CENTRAL_REF.tacos_pct} format="pct" />
              <AuditRow label="Lucro pós-ADS" spApiValue={fd?.profit_after_ads} refValue={SELLER_CENTRAL_REF.profit_after_ads} />
            </div>
          )}

          {/* Itens de referência sem equivalente SP-API (estáticos) */}
          <div className="mt-3 grid grid-cols-4 gap-2">
            {[
              { label: 'Vendas', value: SELLER_CENTRAL_REF.orders },
              { label: 'Unidades', value: SELLER_CENTRAL_REF.units },
              { label: 'Ticket Médio', value: fmtBRL(SELLER_CENTRAL_REF.ticket_medio) },
              { label: 'ROI', value: fmtPct(SELLER_CENTRAL_REF.roi_pct) },
            ].map(({ label, value }) => (
              <div key={label} className="bg-surface-2 rounded-lg p-2.5 text-center">
                <p className="text-[9px] text-slate-500 uppercase tracking-wide">{label}</p>
                <p className="text-sm font-bold text-slate-300 mt-0.5">{value}</p>
                <p className="text-[9px] text-slate-600">Seller Central</p>
              </div>
            ))}
          </div>

          {/* Resultado do sync */}
          {syncResult && (
            <div className={`mt-3 px-3 py-2 rounded-lg text-[11px] border ${
              syncResult.ok
                ? 'bg-emerald-500/8 border-emerald-500/20 text-emerald-400'
                : 'bg-red-500/8 border-red-500/20 text-red-400'
            }`}>
              {syncResult.ok
                ? `✓ Sync concluído — ${syncResult.days_processed || 0} dias processados, ${syncResult.total_events || 0} eventos`
                : `✗ Erro: ${syncResult.error || 'Falha no sync'}`
              }
            </div>
          )}

          {/* Rodapé */}
          <div className="flex items-center justify-between mt-4 pt-3 border-t border-surface-2/50">
            <div className="text-[10px] text-slate-600">
              {syncedAt
                ? `Último sync: ${syncedAt} · ${fd?.finance_events_count || 0} eventos processados`
                : 'Nenhum sync financeiro realizado ainda'
              }
              {fd?.finance_sync_status === 'synced' && (
                <span className="ml-2 text-emerald-400/70">● synced</span>
              )}
            </div>
            <button
              onClick={handleSync}
              disabled={syncing}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-2 border border-surface-3 hover:border-cyan/30 hover:bg-cyan/5 rounded-lg text-xs text-slate-300 hover:text-white transition-colors disabled:opacity-50"
            >
              {syncing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              {syncing ? 'Sincronizando...' : 'Sincronizar agora'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}