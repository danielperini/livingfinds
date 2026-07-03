import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Loader2, Rocket, X } from 'lucide-react';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRateLimit(error) {
  const text = JSON.stringify(error || '').toLowerCase();
  return text.includes('429') || text.includes('rate limit') || text.includes('too many requests') || text.includes('throttl');
}

function nextSlot() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(p.hour || 0);
  const day = `${p.year}-${p.month}-${p.day}`;

  if (hour < 3) {
    const nextHour = hour + 1;
    return {
      hour: nextHour,
      window: `${String(nextHour).padStart(2, '0')}:00-${String(nextHour + 1).padStart(2, '0')}:00`,
      at: new Date(`${day}T${String(nextHour).padStart(2, '0')}:00:00-03:00`),
    };
  }

  if (hour < 13) {
    return { hour: 13, window: '13:00-14:00', at: new Date(`${day}T13:00:00-03:00`) };
  }

  const tomorrow = new Date(`${day}T12:00:00-03:00`);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const nextDay = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(tomorrow);
  return { hour: 0, window: '00:00-01:00', at: new Date(`${nextDay}T00:00:00-03:00`) };
}

export default function KickoffScheduledModal({ product, account, onClose, onDone }) {
  const [mode, setMode] = useState('auto_plus_four');
  const [term, setTerm] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function queueDirectly() {
    const slot = nextSlot();
    const existing = await base44.entities.ProductKickoffQueue.filter({
      amazon_account_id: account.id,
      asin: product.asin,
      mode,
      status: 'scheduled',
    }, '-created_date', 1).catch(() => []);

    if (!existing.length) {
      await base44.entities.ProductKickoffQueue.create({
        amazon_account_id: account.id,
        asin: product.asin,
        sku: product.sku || null,
        product_name: product.product_name || product.display_name || product.asin,
        mode,
        keyword: mode === 'manual_only' ? term.trim() : null,
        status: 'scheduled',
        queue_hour: slot.hour,
        queue_window: slot.window,
        scheduled_at: slot.at.toISOString(),
        attempt_count: 0,
        max_attempts: 5,
      });
    }

    return slot;
  }

  async function schedule() {
    setLoading(true);
    setError('');

    try {
      const payload = {
        amazon_account_id: account.id,
        asin: product.asin,
        sku: product.sku || null,
        product_name: product.product_name || product.display_name || product.asin,
        mode,
        keyword: mode === 'manual_only' ? term.trim() : null,
      };

      let response;
      try {
        response = await base44.functions.invoke('scheduleProductKickoff', payload);
      } catch (firstError) {
        if (!isRateLimit(firstError)) throw firstError;
        await wait(14000);
        try {
          response = await base44.functions.invoke('scheduleProductKickoff', payload);
        } catch (secondError) {
          if (!isRateLimit(secondError)) throw secondError;
          const slot = await queueDirectly();
          setMessage(`Kick-off programado para ${slot.window}. A execução ocorrerá automaticamente com intervalo de 14 segundos.`);
          onDone?.();
          return;
        }
      }

      const data = response?.data || {};
      if (!data.ok) {
        if (isRateLimit(data)) {
          const slot = await queueDirectly();
          setMessage(`Kick-off programado para ${slot.window}. A execução ocorrerá automaticamente com intervalo de 14 segundos.`);
          onDone?.();
          return;
        }
        throw new Error(data.error || 'Falha ao programar o Kick-off.');
      }

      setMessage(data.message || `Kick-off programado para ${data.queue_window || 'a próxima janela'}.`);
      onDone?.();
    } catch (error) {
      if (isRateLimit(error)) {
        try {
          const slot = await queueDirectly();
          setMessage(`Kick-off programado para ${slot.window}. A execução ocorrerá automaticamente com intervalo de 14 segundos.`);
          onDone?.();
        } catch {
          setError('A Amazon limitou temporariamente as chamadas. Aguarde 14 segundos e tente novamente.');
        }
      } else {
        setError(error?.response?.data?.error || error?.message || 'Falha ao programar o Kick-off.');
      }
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