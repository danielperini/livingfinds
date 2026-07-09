import { useState } from 'react';
import { PackageCheck, Zap, Loader2, X, ChevronDown, ChevronUp } from 'lucide-react';

/**
 * RestockedAlert
 *
 * Exibe um banner destacado quando há produtos que voltaram ao estoque
 * (previous_inventory_status === 'out_of_stock' e fba_inventory > 0).
 * Permite reativar campanhas pausadas ou agendar kick-off em massa.
 */
export default function RestockedAlert({ products, account, onDone }) {
  const [expanded, setExpanded] = useState(true);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  if (!products || products.length === 0) return null;

  const withCampaign = products.filter(p =>
    p.has_campaign || p.campaign_status === 'paused' || p.linked_campaign_id
  );
  const withoutCampaign = products.filter(p =>
    !p.has_campaign && p.campaign_status !== 'paused' && !p.linked_campaign_id
  );

  const handleReactivate = async () => {
    if (!account || loading) return;
    setLoading(true);
    setResult(null);
    let reactivated = 0, queued = 0, failed = 0;

    // Reativar campanhas pausadas
    for (const p of withCampaign) {
      const campaignId = p.linked_campaign_id || p.campaign_id || p.amazon_campaign_id;
      if (!campaignId) continue;
      try {
        const { base44 } = await import('@/api/base44Client');
        const agentAction = await base44.entities.AgentAction.create({
          amazon_account_id: account.id,
          action: 'enable_campaign',
          asin: p.asin,
          campaign_id: campaignId,
          reason: 'Reabastecimento detectado — reativação automática',
          evidence: `Produto ${p.asin} voltou ao estoque com ${p.fba_inventory} unidades`,
          risk_level: 'low',
          requires_approval: false,
        });
        await base44.functions.invoke('executeAgentAction', { action_id: agentAction.id, approve: true });
        reactivated++;
      } catch {
        failed++;
      }
    }

    // Agendar kick-off para quem não tem campanha
    for (const p of withoutCampaign) {
      try {
        const { base44 } = await import('@/api/base44Client');
        const r = await base44.functions.invoke('scheduleProductKickoff', {
          amazon_account_id: account.id,
          asin: p.asin,
          sku: p.sku,
          product_name: p.product_name,
          mode: 'auto_plus_four',
        });
        r?.data?.ok ? queued++ : failed++;
      } catch {
        failed++;
      }
    }

    setLoading(false);
    setResult({ reactivated, queued, failed });
    if (reactivated + queued > 0) {
      setTimeout(() => { onDone?.(); }, 3000);
    }
  };

  return (
    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 overflow-hidden animate-fade-in">
      {/* Header clicável */}
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-emerald-500/10 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center flex-shrink-0">
            <PackageCheck className="w-3.5 h-3.5 text-emerald-400" />
          </div>
          <div className="text-left">
            <p className="text-sm font-semibold text-emerald-300">
              {products.length} produto{products.length > 1 ? 's' : ''} voltou ao estoque!
            </p>
            <p className="text-[11px] text-slate-400 mt-0.5">
              {withCampaign.length > 0 && `${withCampaign.length} com campanha pausada`}
              {withCampaign.length > 0 && withoutCampaign.length > 0 && ' · '}
              {withoutCampaign.length > 0 && `${withoutCampaign.length} sem campanha — aguardam kick-off`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {!result && (
            <button
              type="button"
              onClick={e => { e.stopPropagation(); handleReactivate(); }}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-60 transition-colors"
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
              {loading ? 'Reativando...' : 'Reativar tudo'}
            </button>
          )}
          {result && (
            <span className="text-xs text-emerald-400 font-semibold">
              {result.reactivated + result.queued} reativado{result.reactivated + result.queued !== 1 ? 's' : ''}
              {result.failed > 0 && ` · ${result.failed} falhou`}
            </span>
          )}
          {expanded ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
        </div>
      </button>

      {/* Lista expandida */}
      {expanded && (
        <div className="border-t border-emerald-500/20 px-4 py-3 space-y-1.5 max-h-52 overflow-y-auto scrollbar-thin">
          {products.map(p => {
            const hasCamp = p.has_campaign || p.campaign_status === 'paused' || p.linked_campaign_id;
            return (
              <div key={p.id} className="flex items-center gap-3 py-1.5">
                <span className="text-xs font-mono text-cyan w-28 flex-shrink-0">{p.asin}</span>
                <span className="text-xs text-slate-400 flex-1 truncate">{p.product_name || p.display_name || '—'}</span>
                <span className="text-xs font-semibold text-emerald-400 flex-shrink-0">{p.fba_inventory} un.</span>
                <span className={`text-[10px] px-2 py-0.5 rounded-full border flex-shrink-0 ${hasCamp ? 'bg-amber-500/10 border-amber-500/20 text-amber-400' : 'bg-violet-500/10 border-violet-500/20 text-violet-400'}`}>
                  {hasCamp ? 'reativar campanha' : 'kick-off pendente'}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}