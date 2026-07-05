import { Loader2, Check, Trash2, ExternalLink } from 'lucide-react';

const CAMP_STATUS_CONFIG = {
  enabled:    { label: 'Campanha Ativa',      color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
  active:     { label: 'Campanha Ativa',      color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
  incomplete: { label: 'Incompleta',          color: 'text-amber-400 bg-amber-400/10 border-amber-400/20' },
  paused:     { label: 'Pausada',             color: 'text-slate-400 bg-slate-400/10 border-slate-400/20' },
  archived:   { label: 'Arquivada',           color: 'text-slate-500 bg-slate-500/10 border-slate-500/20' },
  failed:     { label: 'Falha ao criar',      color: 'text-red-400 bg-red-400/10 border-red-400/20' },
  created:    { label: 'Campanha Criada',     color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
  approved:   { label: 'Criando campanha…',  color: 'text-cyan bg-cyan/10 border-cyan/20' },
  unknown:    { label: 'Verificando…',        color: 'text-slate-400 bg-slate-400/10 border-slate-400/20' },
};

function CampaignStatusBadge({ status }) {
  const cfg = CAMP_STATUS_CONFIG[status] || CAMP_STATUS_CONFIG.unknown;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${cfg.color}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {cfg.label}
    </span>
  );
}

export default function SuggestionsPanel({ suggestions, products, workingId, onReview }) {
  const productMap = Object.fromEntries(products.map((p) => [p.asin, p]));

  return (
    <div className="overflow-hidden rounded-xl border border-surface-2 bg-surface-1">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-surface-2 bg-surface-2/40">
              {['Palavra-chave', 'Produto / ASIN', 'Confiança', 'Status Campanha', 'Ações'].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-xs uppercase text-slate-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {suggestions.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-sm text-slate-500">Nenhuma sugestão encontrada.</td></tr>
            )}
            {suggestions.map((s) => {
              const p = productMap[s.asin];
              const name = p?.product_name || p?.display_name || s.product_name || 'Produto não identificado';
              const busy = workingId === s.id;

              // Status da campanha criada (campo campaign_status) ou status da sugestão
              const campStatus = s.campaign_status || (
                s.status === 'created' ? 'enabled'
                : s.status === 'approved' ? 'approved'
                : s.status === 'failed' ? 'failed'
                : null
              );

              const isDone = ['created', 'approved'].includes(s.status) || campStatus;
              const isFailed = s.status === 'failed' || campStatus === 'failed';

              return (
                <tr key={s.id} className="border-b border-surface-2/40 hover:bg-surface-2/30 transition-colors">
                  <td className="px-4 py-3">
                    <p className="font-semibold text-white">{s.keyword}</p>
                    <p className="text-[10px] text-slate-500 mt-0.5">{s.reason || s.source || 'Sugestão automática'}</p>
                    {s.error && <p className="text-[10px] text-red-400 mt-0.5 max-w-[220px] truncate" title={s.error}>⚠ {s.error}</p>}
                  </td>
                  <td className="px-4 py-3">
                    <p className="max-w-[240px] truncate text-xs text-slate-200" title={name}>{name}</p>
                    <p className="font-mono text-[10px] text-cyan mt-0.5">{s.asin || 'Sem ASIN'}{s.sku ? ` · ${s.sku}` : ''}</p>
                    {s.amazon_campaign_id && (
                      <p className="font-mono text-[10px] text-slate-500 mt-0.5">Camp: {s.amazon_campaign_id}</p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs font-semibold text-violet-400">
                      {Math.round((s.confidence || s.relevance_score || 0) * 100)}%
                    </span>
                    <p className="text-[10px] text-slate-500 mt-0.5">{s.match_type || 'exact'}</p>
                  </td>
                  <td className="px-4 py-3">
                    {campStatus ? (
                      <CampaignStatusBadge status={campStatus} />
                    ) : (
                      <span className="text-xs text-slate-500">{s.status || 'suggested'}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      {!isDone && !busy && (
                        <button
                          onClick={() => onReview(s, 'approve')}
                          className="flex items-center gap-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/20 px-3 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/25 transition-colors"
                        >
                          <Check className="h-3 w-3" />
                          Aprovar
                        </button>
                      )}
                      {busy && (
                        <button disabled className="flex items-center gap-1.5 rounded-lg bg-cyan/10 border border-cyan/20 px-3 py-1.5 text-xs font-semibold text-cyan opacity-80">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Criando…
                        </button>
                      )}
                      {isDone && !busy && !isFailed && (
                        <span className="flex items-center gap-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-400">
                          <Check className="h-3 w-3" />
                          Criada
                        </span>
                      )}
                      {isFailed && !busy && (
                        <button
                          onClick={() => onReview(s, 'approve')}
                          className="flex items-center gap-1.5 rounded-lg bg-amber-500/15 border border-amber-500/20 px-3 py-1.5 text-xs font-semibold text-amber-300 hover:bg-amber-500/25 transition-colors"
                        >
                          Tentar novamente
                        </button>
                      )}
                      {!['created', 'approved'].includes(s.status) && !busy && (
                        <button
                          onClick={() => onReview(s, 'delete')}
                          disabled={busy}
                          className="flex items-center gap-1 rounded-lg bg-red-500/10 border border-red-500/15 px-2.5 py-1.5 text-xs font-semibold text-red-400 hover:bg-red-500/20 transition-colors disabled:opacity-40"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}