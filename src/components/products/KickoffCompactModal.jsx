import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Loader2, Rocket, X } from 'lucide-react';

export default function KickoffCompactModal({ product, account, onClose, onDone }) {
  const [mode, setMode] = useState('auto_only');
  const [term, setTerm] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function send() {
    setLoading(true); setError(''); setMessage('');
    try {
      const r = await base44.functions.invoke('kickoffProductV2', {
        amazon_account_id: account.id,
        asin: product.asin,
        sku: product.sku || null,
        product_name: product.product_name || product.display_name || product.asin,
        mode,
        manual_term: mode === 'auto_plus_manual' ? term.trim() : '',
      });
      if (!r?.data?.ok) throw new Error(r?.data?.error || 'Falha no Kick-off');
      setMessage(`Kick-off enviado com sucesso. ${r.data.manual_campaigns_created || 0} manuais criadas e ${r.data.pending_approval || 0} sugestões aguardando aprovação.`);
      onDone?.();
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
    <div className="w-full max-w-lg rounded-2xl border border-surface-2 bg-surface-1 p-6">
      <div className="mb-5 flex items-start justify-between"><div><h2 className="text-sm font-bold text-white">Kick-off de Produto</h2><p className="text-xs text-slate-400">{product.asin}</p></div><button onClick={onClose}><X className="h-5 w-5 text-slate-500" /></button></div>
      <div className="space-y-3">
        <label className="block rounded-xl border border-surface-3 p-3 text-sm text-white"><input className="mr-2" type="radio" checked={mode === 'auto_only'} onChange={() => setMode('auto_only')} />Somente campanha automática</label>
        <label className="block rounded-xl border border-surface-3 p-3 text-sm text-white"><input className="mr-2" type="radio" checked={mode === 'auto_plus_manual'} onChange={() => setMode('auto_plus_manual')} />Automática + um termo manual</label>
        {mode === 'auto_plus_manual' && <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Novo termo exato" className="w-full rounded-lg border border-surface-3 bg-surface-2 px-3 py-2 text-sm text-white" />}
        <p className="rounded-lg bg-cyan/5 p-3 text-xs text-slate-300">IA cria manuais automaticamente apenas com confiança ≥ 95%. As demais ficam para aprovação. Limite: 25 campanhas por produto.</p>
        {message && <p className="rounded-lg bg-emerald-400/10 p-3 text-xs text-emerald-300">{message}</p>}
        {error && <p className="rounded-lg bg-red-400/10 p-3 text-xs text-red-300">{error}</p>}
        <div className="flex justify-end gap-2"><button onClick={onClose} className="rounded-lg border border-surface-3 px-4 py-2 text-sm text-slate-300">Fechar</button>{!message && <button onClick={send} disabled={loading || !account || (mode === 'auto_plus_manual' && !term.trim())} className="flex items-center gap-2 rounded-lg bg-cyan px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}Enviar Kick-off</button>}</div>
      </div>
    </div>
  </div>;
}
