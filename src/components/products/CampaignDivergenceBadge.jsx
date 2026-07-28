import { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';

/**
 * CampaignDivergenceBadge
 * Exibe quando campanhas de um produto estão divergentes (paused no DB, enabled na Amazon).
 * Props: product, accountId, onFixed
 */
export default function CampaignDivergenceBadge({ product, accountId, onFixed }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  // Detectar divergência: precisa ter amazon_status=enabled mas state=paused
  const divergentCount = product?._divergent_count || 0;
  if (!divergentCount) return null;

  const handleForcePause = async (e) => {
    e.stopPropagation();
    if (loading) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await base44.functions.invoke('forcePauseCampaignsByAsin', {
        amazon_account_id: product.amazon_account_id || accountId,
        asin: product.asin,
      });
      const data = res?.data || res;
      setResult({
        ok: data?.ok,
        text: data?.ok
          ? `${data.paused_ok} pausadas${data.paused_failed > 0 ? `, ${data.paused_failed} falharam` : ''}`
          : data?.error || 'Erro',
      });
      if (data?.ok && data?.paused_ok > 0) {
        setTimeout(() => { onFixed?.(); }, 1500);
      }
    } catch (e) {
      setResult({ ok: false, text: e?.message || 'Falha' });
    } finally {
      setLoading(false);
      setTimeout(() => setResult(null), 10000);
    }
  };

  if (result) {
    return (
      <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-full border ${
        result.ok
          ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400'
          : 'bg-red-500/15 border-red-500/30 text-red-400'
      }`}>
        {result.text}
      </span>
    );
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-400 whitespace-nowrap">
        <AlertTriangle className="w-3 h-3 flex-shrink-0" />
        {divergentCount} ativa{divergentCount > 1 ? 's' : ''} na Amazon (divergência)
      </span>
      <button
        type="button"
        onClick={handleForcePause}
        disabled={loading}
        className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-full bg-red-500/20 border border-red-500/40 text-red-400 hover:bg-red-500/30 disabled:opacity-50 transition-colors whitespace-nowrap"
      >
        {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
        {loading ? 'Pausando...' : 'Forçar pausa'}
      </button>
    </div>
  );
}