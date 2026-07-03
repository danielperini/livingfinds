import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Loader2, Rocket, X } from 'lucide-react';

export default function KickoffCompactModal({ product, account, onClose, onDone }) {
  const [mode, setMode] = useState('auto_plus_four');
  const [term, setTerm] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function send() {
    setLoading(true);
    setError('');
    setMessage('');

    try {
      const campaigns = await base44.entities.Campaign.filter({
        amazon_account_id: account.id,
        asin: product.asin,
      });
      const activeCampaigns = campaigns.filter((campaign) =>
        !['archived', 'ended'].includes(String(campaign.state || campaign.status).toLowerCase())
      );

      if (activeCampaigns.length >= 25) {
        throw new Error('Limite de 25 campanhas por produto atingido.');
      }

      if (mode === 'auto_plus_four') {
        const availableSlots = 25 - activeCampaigns.length;
        if (availableSlots < 5) {
          throw new Error(`São necessárias 5 vagas para criar 1 automática + 4 manuais. Restam apenas ${availableSlots}.`);
        }

        const response = await base44.functions.invoke('autoKickoffProduct', {
          amazon_account_id: account.id,
          asin: product.asin,
          sku: product.sku || null,
          product_name: product.product_name || product.display_name || product.asin,
          max_keywords: 4,
          minimum_ai_confidence: 0.95,
        });

        const data = response?.data;
        if (!data?.ok) {
          const details = [
            data?.error,
            ...(data?.errors || []),
          ].filter(Boolean).join(' — ');
          throw new Error(details || 'Falha ao criar a campanha automática e as 4 manuais.');
        }

        const manualCount = data?.manual_campaigns?.filter((item) => item?.ok !== false).length || 0;
        setMessage(
          `Kick-off concluído com sucesso. Campanha automática confirmada e ${manualCount} campanha(s) manual(is) sugerida(s) criada(s).`
        );
      } else {
        if (!term.trim()) throw new Error('Digite um termo para criar a campanha manual.');

        const response = await base44.functions.invoke('createManualCampaignFromKeywordSuggestion', {
          amazon_account_id: account.id,
          asin: product.asin,
          sku: product.sku || null,
          product_name: product.product_name || product.display_name || product.asin,
          keyword: term.trim(),
          match_type: 'exact',
          bid: 0.50,
        });

        const data = response?.data;
        if (!data?.ok) {
          throw new Error(data?.error || 'Falha ao criar a campanha manual.');
        }

        setMessage(`Campanha manual criada com sucesso para o termo exato “${term.trim()}”.`);
      }

      onDone?.();
    } catch (requestError) {
      const details = requestError?.response?.data;
      setError(
        details?.error ||
        details?.message ||
        requestError?.message ||
        'Falha ao executar o Kick-off.'
      );
    } finally {
      setLoading(false);
    }
  }

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
    <div className="w-full max-w-lg rounded-2xl border border-surface-2 bg-surface-1 p-6">
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h2 className="text-sm font-bold text-white">Kick-off de Produto</h2>
          <p className="text-xs text-slate-400">{product.asin}{product.sku ? ` · ${product.sku}` : ''}</p>
        </div>
        <button onClick={onClose} disabled={loading}><X className="h-5 w-5 text-slate-500" /></button>
      </div>

      <div className="space-y-3">
        <label className="block rounded-xl border border-surface-3 p-3 text-sm text-white">
          <input className="mr-2" type="radio" checked={mode === 'auto_plus_four'} onChange={() => setMode('auto_plus_four')} />
          Campanha automática + 4 campanhas manuais sugeridas
          <span className="mt-1 block text-xs text-slate-400">Cria ou confirma a AUTO e gera quatro campanhas manuais exatas com termos aderentes ao produto.</span>
        </label>

        <label className="block rounded-xl border border-surface-3 p-3 text-sm text-white">
          <input className="mr-2" type="radio" checked={mode === 'manual_only'} onChange={() => setMode('manual_only')} />
          Criar apenas campanha manual
          <span className="mt-1 block text-xs text-slate-400">Não cria campanha automática.</span>
        </label>

        {mode === 'manual_only' && (
          <input
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Novo termo exato"
            className="w-full rounded-lg border border-surface-3 bg-surface-2 px-3 py-2 text-sm text-white"
          />
        )}

        <p className="rounded-lg bg-cyan/5 p-3 text-xs text-slate-300">Campanhas manuais usam sempre correspondência exata. Limite máximo: 25 campanhas por produto.</p>
        {message && <p className="rounded-lg bg-emerald-400/10 p-3 text-xs text-emerald-300">{message}</p>}
        {error && <p className="rounded-lg bg-red-400/10 p-3 text-xs text-red-300">{error}</p>}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} disabled={loading} className="rounded-lg border border-surface-3 px-4 py-2 text-sm text-slate-300">Fechar</button>
          {!message && (
            <button
              onClick={send}
              disabled={loading || !account || (mode === 'manual_only' && !term.trim())}
              className="flex items-center gap-2 rounded-lg bg-cyan px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
              {loading ? 'Enviando...' : 'Enviar Kick-off'}
            </button>
          )}
        </div>
      </div>
    </div>
  </div>;
}
