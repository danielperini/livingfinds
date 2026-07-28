import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { AlertTriangle, Loader2, Rocket, Trash2, X } from 'lucide-react';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
  if (hour < 4) return { hour, window: `${String(hour).padStart(2,'0')}:00-${String(hour+1).padStart(2,'0')}:00`, at: new Date() };
  if (hour < 13) return { hour: 13, window: '13:00-14:00', at: new Date(`${day}T13:00:00-03:00`) };
  const tomorrow = new Date(`${day}T12:00:00-03:00`);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const np = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(tomorrow);
  const np2 = Object.fromEntries(np.map(x => [x.type, x.value]));
  const nextDay = `${np2.year}-${np2.month}-${np2.day}`;
  return { hour: 0, window: '00:00-01:00', at: new Date(`${nextDay}T00:00:00-03:00`) };
}

function formatDate(iso) {
  if (!iso) return '?';
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function daysSince(iso) {
  if (!iso) return null;
  const diff = (Date.now() - new Date(iso).getTime()) / 86400000;
  return Math.floor(diff);
}

// ── STEP 1: Aviso de fila travada ────────────────────────────────────────────
function StuckQueueWarning({ stuckItems, onClean, onCancel, cleaning }) {
  const oldest = stuckItems.reduce((a, b) =>
    new Date(a.scheduled_at || a.created_date || 0) < new Date(b.scheduled_at || b.created_date || 0) ? a : b
  , stuckItems[0]);
  const since = oldest?.scheduled_at || oldest?.created_date;
  const days = daysSince(since);

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 p-4 rounded-xl border border-amber-500/30 bg-amber-500/10">
        <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-amber-300">
            {stuckItems.length} kick-off{stuckItems.length > 1 ? 's' : ''} agendado{stuckItems.length > 1 ? 's' : ''} — nunca executado{stuckItems.length > 1 ? 's' : ''}
          </p>
          <p className="text-xs text-amber-400/80 mt-1">
            Mais antigo agendado em {formatDate(since)}{days !== null ? ` (há ${days} dia${days !== 1 ? 's' : ''})` : ''}.
            Estes itens estão travados na fila e nunca foram processados.
          </p>
          {stuckItems.length > 1 && (
            <div className="mt-2 space-y-1">
              {stuckItems.slice(0, 5).map((item, i) => (
                <p key={item.id || i} className="text-[10px] text-amber-400/60 font-mono">
                  {item.mode === 'manual_only' && item.keyword ? `"${item.keyword}"` : item.mode} · janela {item.queue_window || '?'}
                </p>
              ))}
              {stuckItems.length > 5 && (
                <p className="text-[10px] text-amber-400/50">+{stuckItems.length - 5} mais</p>
              )}
            </div>
          )}
        </div>
      </div>

      <p className="text-xs text-slate-400">
        Deseja cancelar esses itens travados e iniciar um novo kick-off com keywords escolhidas por você?
      </p>

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={cleaning}
          className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors disabled:opacity-50"
        >
          Fechar
        </button>
        <button
          type="button"
          onClick={onClean}
          disabled={cleaning}
          className="flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg border border-amber-500/40 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 disabled:opacity-50 transition-colors"
        >
          {cleaning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
          {cleaning ? 'Limpando fila...' : 'Limpar fila e reiniciar'}
        </button>
      </div>
    </div>
  );
}

// ── STEP 2: Seleção de keywords ───────────────────────────────────────────────
function KeywordSelector({ product, account, onClose, onDone }) {
  const [term, setTerm] = useState('');
  const [terms, setTerms] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const addTerm = () => {
    const t = term.trim();
    if (!t || terms.includes(t)) return;
    setTerms(prev => [...prev, t]);
    setTerm('');
  };

  const removeTerm = (t) => setTerms(prev => prev.filter(x => x !== t));

  const handleKey = (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTerm(); }
  };

  const scheduleAll = async () => {
    if (!terms.length) return;
    setLoading(true);
    setError('');
    const slot = nextSlot();
    const scheduled = [];
    const failed = [];

    for (const keyword of terms) {
      const payload = {
        amazon_account_id: account.id,
        asin: product.asin,
        sku: product.sku || null,
        product_name: product.product_name || product.display_name || product.asin,
        mode: 'manual_only',
        keyword,
      };
      try {
        let response;
        try {
          response = await base44.functions.invoke('scheduleProductKickoff', payload);
        } catch (firstError) {
          if (!isRateLimit(firstError)) throw firstError;
          await wait(14000);
          response = await base44.functions.invoke('scheduleProductKickoff', payload);
        }
        if (response?.data?.ok) {
          scheduled.push(keyword);
        } else {
          // fallback direto
          await base44.entities.ProductKickoffQueue.create({
            amazon_account_id: account.id,
            asin: product.asin,
            sku: product.sku || null,
            product_name: product.product_name || product.display_name || product.asin,
            mode: 'manual_only',
            keyword,
            status: 'scheduled',
            queue_hour: slot.hour,
            queue_window: slot.window,
            scheduled_at: slot.at.toISOString(),
            attempt_count: 0,
            max_attempts: 5,
          });
          scheduled.push(keyword);
        }
      } catch {
        failed.push(keyword);
      }
    }

    setLoading(false);

    if (scheduled.length > 0) {
      setMessage(
        `${scheduled.length} keyword${scheduled.length > 1 ? 's' : ''} agendada${scheduled.length > 1 ? 's' : ''} para a janela ${slot.window}.` +
        (failed.length ? ` ${failed.length} falharam: ${failed.join(', ')}.` : '')
      );
      onDone?.();
    } else {
      setError(`Falha ao agendar: ${failed.join(', ')}`);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-400">
        Fila limpa. Digite as keywords para o novo kick-off manual (uma por vez) e clique em Adicionar ou pressione Enter.
      </p>

      <div className="flex gap-2">
        <input
          value={term}
          onChange={e => setTerm(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Ex: lixeira automatica sensor 10l"
          className="flex-1 rounded-lg border border-surface-3 bg-surface-2 px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-cyan/50"
        />
        <button
          type="button"
          onClick={addTerm}
          disabled={!term.trim()}
          className="px-3 py-2 text-sm font-semibold rounded-lg border border-cyan/30 bg-cyan/15 text-cyan hover:bg-cyan/25 disabled:opacity-40 transition-colors whitespace-nowrap"
        >
          Adicionar
        </button>
      </div>

      {terms.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {terms.map(t => (
            <span key={t} className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-cyan/20 bg-cyan/10 text-xs text-cyan">
              {t}
              <button type="button" onClick={() => removeTerm(t)} className="text-cyan/60 hover:text-cyan">
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <p className="rounded-lg bg-cyan/5 p-3 text-xs text-slate-300">
        Execução nas janelas 00:00–04:00 e 13:00–14:00, com intervalo de 14 segundos entre chamadas.
      </p>

      {message && <p className="rounded-lg bg-emerald-400/10 p-3 text-xs text-emerald-300">{message}</p>}
      {error && <p className="rounded-lg bg-red-400/10 p-3 text-xs text-red-300">{error}</p>}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={loading}
          className="rounded-lg border border-surface-3 px-4 py-2 text-sm text-slate-300 hover:text-white disabled:opacity-50 transition-colors"
        >
          {message ? 'Fechar' : 'Cancelar'}
        </button>
        {!message && (
          <button
            type="button"
            onClick={scheduleAll}
            disabled={loading || !terms.length}
            className="flex items-center gap-2 rounded-lg bg-cyan px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 transition-colors"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Rocket className="w-4 h-4" />}
            {loading ? 'Agendando...' : `Confirmar ${terms.length} keyword${terms.length !== 1 ? 's' : ''}`}
          </button>
        )}
      </div>
    </div>
  );
}

// ── MODAL PRINCIPAL ───────────────────────────────────────────────────────────
export default function KickoffWithQueueCleanModal({ product, account, stuckItems, onClose, onDone }) {
  const [step, setStep] = useState('warning'); // 'warning' | 'keywords'
  const [cleaning, setCleaning] = useState(false);

  const handleClean = async () => {
    setCleaning(true);
    try {
      for (const item of stuckItems) {
        await base44.entities.ProductKickoffQueue.update(item.id, { status: 'cancelled' });
      }
      setStep('keywords');
    } catch {
      // mesmo com erro parcial, avança
      setStep('keywords');
    } finally {
      setCleaning(false);
    }
  };

  const handleDone = () => {
    window.dispatchEvent(new CustomEvent('product-kickoff-queued', { detail: { asin: product?.asin || null } }));
    onDone?.();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-lg rounded-2xl border border-surface-2 bg-surface-1 p-6 space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-sm font-bold text-white">Kick-off de Produto</h2>
            <p className="text-xs text-slate-400">{product.asin}{product.sku ? ` · ${product.sku}` : ''}</p>
          </div>
          <button type="button" onClick={onClose} disabled={cleaning}>
            <X className="h-5 w-5 text-slate-500" />
          </button>
        </div>

        {step === 'warning' && (
          <StuckQueueWarning
            stuckItems={stuckItems}
            onClean={handleClean}
            onCancel={onClose}
            cleaning={cleaning}
          />
        )}

        {step === 'keywords' && (
          <KeywordSelector
            product={product}
            account={account}
            onClose={onClose}
            onDone={handleDone}
          />
        )}
      </div>
    </div>
  );
}