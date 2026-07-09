import { useState } from 'react';
import { PackageCheck, ChevronDown, ChevronUp } from 'lucide-react';

export default function RestockedAlert({ products }) {
  const [expanded, setExpanded] = useState(true);

  if (!products || products.length === 0) return null;

  const withCampaign = products.filter(p =>
    p.has_campaign || p.campaign_status === 'paused' || p.linked_campaign_id
  );
  const withoutCampaign = products.filter(p =>
    !p.has_campaign && p.campaign_status !== 'paused' && !p.linked_campaign_id
  );

  return (
    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 overflow-hidden animate-fade-in">
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
        {expanded ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
      </button>

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