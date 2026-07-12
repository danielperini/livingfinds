import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { History, Loader2, RotateCcw } from 'lucide-react';

export default function ListingHistoryPanel({ asin, accountId }) {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!asin || !accountId) return;
    setLoading(true);
    base44.entities.ListingEnhancementHistory
      .filter({ amazon_account_id: accountId, asin }, '-created_at', 50)
      .then(setHistory)
      .catch(() => setHistory([]))
      .finally(() => setLoading(false));
  }, [asin, accountId]);

  if (loading) return <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 text-violet-400 animate-spin" /></div>;

  if (!history.length) {
    return (
      <div className="text-center py-10 text-slate-500 text-sm">
        <History className="w-8 h-8 text-slate-600 mx-auto mb-3" />
        <p>Nenhum histórico de alterações para este produto.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-500 mb-3">{history.length} alteração{history.length !== 1 ? 'ões' : ''} registrada{history.length !== 1 ? 's' : ''}</p>
      {history.map(entry => (
        <div key={entry.id} className="bg-surface-2 rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] bg-surface-3 px-2 py-0.5 rounded text-slate-400">{entry.field_name}</span>
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                entry.amazon_status === 'confirmed' ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
                : entry.amazon_status === 'processing' ? 'text-amber-400 bg-amber-500/10 border-amber-500/20'
                : entry.amazon_status === 'failed' ? 'text-red-400 bg-red-500/10 border-red-500/20'
                : 'text-slate-400 bg-slate-500/10 border-slate-500/20'
              }`}>
                {entry.amazon_status || 'submitted'}
              </span>
              {entry.rollback_status === 'eligible' && (
                <span className="text-[10px] text-slate-500 flex items-center gap-1">
                  <RotateCcw className="w-3 h-3" /> Rollback disponível (manual)
                </span>
              )}
            </div>
            <span className="text-[10px] text-slate-600">
              {entry.submitted_at ? new Date(entry.submitted_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="bg-red-500/5 border border-red-500/10 rounded p-2">
              <p className="text-[9px] text-slate-500 mb-1">Antes</p>
              <p className="text-[10px] text-slate-400 break-words line-clamp-3">{(entry.value_before || '(vazio)').slice(0, 150)}</p>
            </div>
            <div className="bg-emerald-500/5 border border-emerald-500/10 rounded p-2">
              <p className="text-[9px] text-slate-500 mb-1">Depois</p>
              <p className="text-[10px] text-emerald-300 break-words line-clamp-3">{(entry.value_after || '(vazio)').slice(0, 150)}</p>
            </div>
          </div>

          {entry.confirmed_at && (
            <p className="text-[10px] text-emerald-400">✅ Confirmado pela Amazon em {new Date(entry.confirmed_at).toLocaleString('pt-BR')}</p>
          )}
          {entry.amazon_issues && entry.amazon_issues !== '[]' && (
            <div className="text-[10px] text-red-400 bg-red-500/5 border border-red-500/10 rounded p-2">
              Issues: {entry.amazon_issues.slice(0, 200)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}