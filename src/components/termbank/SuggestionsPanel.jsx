import { Loader2, Check, Trash2 } from 'lucide-react';

export default function SuggestionsPanel({ suggestions, products, workingId, onReview }) {
  const productMap = Object.fromEntries(products.map((p) => [p.asin, p]));
  return <div className="overflow-hidden rounded-xl border border-surface-2 bg-surface-1">
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="border-b border-surface-2 bg-surface-2/40">
          {['Palavra', 'Produto / ASIN', 'Confiança', 'Status', 'Ações'].map((h) => <th key={h} className="px-4 py-3 text-left text-xs uppercase text-slate-500">{h}</th>)}
        </tr></thead>
        <tbody>{suggestions.map((s) => {
          const p = productMap[s.asin];
          const name = p?.product_name || p?.display_name || s.product_name || 'Produto não identificado';
          const busy = workingId === s.id;
          return <tr key={s.id} className="border-b border-surface-2/40">
            <td className="px-4 py-3"><p className="font-semibold text-white">{s.keyword}</p><p className="text-[10px] text-slate-500">{s.reason || s.source || 'Sugestão IA'}</p></td>
            <td className="px-4 py-3"><p className="max-w-[260px] truncate text-xs text-slate-200" title={name}>{name}</p><p className="font-mono text-[10px] text-cyan">{s.asin || 'Sem ASIN'}{s.sku ? ` · ${s.sku}` : ''}</p></td>
            <td className="px-4 py-3 text-xs font-semibold text-violet-400">{Math.round((s.confidence || s.relevance_score || 0) * 100)}%</td>
            <td className="px-4 py-3 text-xs text-amber-400">{s.status || 'suggested'}</td>
            <td className="px-4 py-3"><div className="flex gap-2">
              <button disabled={busy || s.status === 'created'} onClick={() => onReview(s, 'approve')} className="flex items-center gap-1 rounded-lg bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-300 disabled:opacity-40">{busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}Aprovar</button>
              <button disabled={busy} onClick={() => onReview(s, 'delete')} className="flex items-center gap-1 rounded-lg bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-300 disabled:opacity-40"><Trash2 className="h-3 w-3" />Excluir</button>
            </div></td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  </div>;
}
