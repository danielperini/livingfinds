import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Loader2, Rocket, X } from 'lucide-react';

export default function KickoffScheduledModal({ product, account, onClose, onDone }) {
  const [mode, setMode] = useState('auto_plus_four');
  const [term, setTerm] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function schedule() {
    setLoading(true);
    setError('');
    try {
      const response = await base44.functions.invoke('scheduleProductKickoff', {
        amazon_account_id: account.id,
        asin: product.asin,
        sku: product.sku || null,
        product_name: product.product_name || product.display_name || product.asin,
        mode,
        keyword: mode === 'manual_only' ? term.trim() : null,
      });
      const data = response?.data || {};
      if (!data.ok) throw new Error(data.error || 'Falha ao programar o Kick-off.');
      setMessage(data.message || `Kick-off programado para ${data.queue_window || 'a próxima janela'}.`);
      onDone?.();
    } catch (e) {
      setError(e?.response?.data?.error || e?.message || 'Falha ao programar o Kick-off.');
    } finally {
      setLoading(false);
    }
  }

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
    <div className="w-full max-w-lg rounded-2xl border border-surface-2 bg-surface-1 p-6 space-y-3">
      <div className="flex items-start justify-between"><div><h2 className="text-sm font-bold text-white">Kick-off de Produto</h2><p className="text-xs text-slate-400">{product.asin}{product.sku ? ` · ${product.sku}` : ''}</p></div><button onClick={onClose} disabled={loading}><X className="h-5 w-5 text-slate-500" /></button></div>
      <label className="block rounded-xl border border-surface-3 p-3 text-sm text-white"><input className="mr-2" type="radio" checked={mode === 'auto_plus_four'} onChange={() => setMode('auto_plus_four')} />Campanha automática + 4 campanhas manuais sugeridas<span className="mt-1 block text-xs text-slate-400">Será executado na próxima janela Amazon.</span></label>
      <label className="block rounded-xl border border-surface-3 p-3 text-sm text-white"><input className="mr-2" type="radio" checked={mode === 'manual_only'} onChange={() => setMode('manual_only')} />Criar apenas campanha manual<span className="mt-1 block text-xs text-slate-400">Será executada com correspondência exata.</span></label>
      {mode === 'manual_only' && <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Novo termo exato" className="w-full rounded-lg border border-surface-3 bg-surface-2 px-3 py-2 text-sm text-white" />}
      <p className="rounded-lg bg-cyan/5 p-3 text-xs text-slate-300">Execução nas janelas 00:00–04:00 e 13:00–14:00, com intervalo de 14 segundos. Pausas continuam imediatas.</p>
      {message && <p className="rounded-lg bg-emerald-400/10 p-3 text-xs text-emerald-300">{message}</p>}
      {error && <p className="rounded-lg bg-red-400/10 p-3 text-xs text-red-300">{error}</p>}
      <div className="flex justify-end gap-2"><button onClick={onClose} disabled={loading} className="rounded-lg border border-surface-3 px-4 py-2 text-sm text-slate-300">Fechar</button>{!message && <button onClick={schedule} disabled={loading || !account || (mode === 'manual_only' && !term.trim())} className="flex items-center gap-2 rounded-lg bg-cyan px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}{loading ? 'Programando...' : 'Programar Kick-off'}</button>}</div>
    </div>
  </div>;
}