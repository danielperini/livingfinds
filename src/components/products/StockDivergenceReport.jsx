import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react';

export default function StockDivergenceReport({ accountId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  const check = async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const res = await base44.functions.invoke('checkStockDivergences', { amazon_account_id: accountId });
      setData(res?.data || null);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    check();
    // Re-checa a cada 60 min automaticamente
    const timer = setInterval(check, 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, [accountId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="mx-6 flex items-center gap-2 text-xs text-slate-500 py-2">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Verificando divergências de estoque...
      </div>
    );
  }

  if (!data) return null;

  const { divergences = [], total = 0, auto_fixed = 0, checked_at } = data;
  const checkedLabel = checked_at
    ? new Date(checked_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : null;

  if (total === 0) {
    return (
      <div className="mx-6 flex items-center gap-2 text-xs text-emerald-400 py-1">
        <CheckCircle2 className="w-3.5 h-3.5" />
        Estoque sincronizado com a Amazon{checkedLabel ? ` · verificado às ${checkedLabel}` : ''}
      </div>
    );
  }

  return (
    <div className="mx-6 rounded-xl border border-amber-500/30 bg-amber-500/5 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-amber-500/10 transition-colors text-left"
      >
        <div className="flex items-center gap-3">
          <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
          <div>
            <p className="text-sm font-semibold text-amber-300">
              {total} produto{total > 1 ? 's' : ''} com estoque divergente da Amazon
            </p>
            <p className="text-[11px] text-slate-400 mt-0.5">
              {auto_fixed} já corrigido{auto_fixed !== 1 ? 's' : ''} automaticamente
              {checkedLabel ? ` · verificado às ${checkedLabel}` : ''}
            </p>
          </div>
        </div>
        <span className="text-xs text-slate-500">{expanded ? '▲ ocultar' : '▼ ver lista'}</span>
      </button>

      {expanded && (
        <div className="border-t border-amber-500/20 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-amber-500/10 text-amber-400/70">
                <th className="px-4 py-2 text-left font-semibold">ASIN</th>
                <th className="px-4 py-2 text-left font-semibold">Produto</th>
                <th className="px-4 py-2 text-right font-semibold">Banco</th>
                <th className="px-4 py-2 text-right font-semibold">Amazon</th>
                <th className="px-4 py-2 text-left font-semibold">Diferença</th>
                <th className="px-4 py-2 text-left font-semibold">Ads</th>
              </tr>
            </thead>
            <tbody>
              {divergences.map((d, i) => {
                const diff = d.amazon_stock - d.local_stock;
                const diffColor = diff > 0 ? 'text-emerald-400' : 'text-red-400';
                return (
                  <tr key={i} className="border-t border-amber-500/10 hover:bg-amber-500/5">
                    <td className="px-4 py-2 font-mono text-cyan">{d.asin}</td>
                    <td className="px-4 py-2 text-slate-300 max-w-[200px] truncate">{d.product_name}</td>
                    <td className="px-4 py-2 text-right text-slate-400">{d.local_stock}</td>
                    <td className="px-4 py-2 text-right text-white font-semibold">{d.amazon_stock}</td>
                    <td className={`px-4 py-2 font-semibold ${diffColor}`}>
                      {diff > 0 ? `+${diff}` : diff} un.
                    </td>
                    <td className="px-4 py-2">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                        d.campaign_status === 'active' || d.campaign_status === 'enabled'
                          ? 'bg-emerald-500/15 text-emerald-400'
                          : d.campaign_status === 'paused'
                          ? 'bg-amber-500/15 text-amber-400'
                          : 'bg-slate-500/15 text-slate-500'
                      }`}>
                        {d.campaign_status === 'active' || d.campaign_status === 'enabled' ? 'ativa'
                          : d.campaign_status === 'paused' ? 'pausada'
                          : d.campaign_status || 'sem ads'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}