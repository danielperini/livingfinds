import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { loadAccountProducts, visibleCatalogProducts } from '@/lib/productCatalogVisibility';

export default function CopyProductKeywords({ product, campaign }) {
  const [open, setOpen] = useState(false);
  const [products, setProducts] = useState([]);
  const [destination, setDestination] = useState('');
  const [terms, setTerms] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function show() {
    setOpen(true); setBusy(true); setMessage(''); setTerms(''); setDestination('');
    try {
      const [catalog, keywords, searches] = await Promise.all([
        loadAccountProducts(base44.entities.Product, product.amazon_account_id),
        base44.entities.SearchTerm.filter({ amazon_account_id: product.amazon_account_id, campaign_id: campaign.campaign_id || campaign.amazon_campaign_id || campaign.id }, '-date', 1000),
        base44.entities.Keyword.filter({ amazon_account_id: product.amazon_account_id, campaign_id: campaign.campaign_id || campaign.amazon_campaign_id || campaign.id }, '-updated_date', 1000),
      ]);
      setProducts(visibleCatalogProducts(catalog).filter(p => p.id !== product.id && p.asin !== product.asin));
      setTerms([...new Set([...keywords,...searches].filter(k => String(k.state || k.status).toLowerCase() !== 'archived')
        .map(k => String(k.keyword_text || k.keyword || k.search_term || '').trim()).filter(Boolean))].join('\n'));
      if (keywords.length >= 1000) setMessage('Exibindo até 1.000 palavras desta campanha. Copie até 200 por operação.');
    } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }
  async function copy() {
    const target = products.find(p => p.id === destination);
    const words = [...new Set(terms.split('\n').map(t => t.trim().toLocaleLowerCase('pt-BR')).filter(Boolean))];
    if (!target || !words.length || words.length > 200) { setMessage('Escolha o destino e informe entre 1 e 200 palavras, uma por linha.'); return; }
    setBusy(true); setMessage('');
    try {
      let copied = 0;
      for (const keyword of words) {
        const where = { amazon_account_id: target.amazon_account_id, asin: target.asin, normalized_keyword: keyword, match_type: 'exact' };
        if ((await base44.entities.KeywordBank.filter(where, null, 1)).length) continue;
        await base44.entities.KeywordBank.create({ ...where, keyword, source_asin: product.asin,
          source_campaign_id: campaign.campaign_id || campaign.id, source_type: 'KEYWORD_BANK',
          campaign_job: 'VALIDATION', lifecycle_status: 'BANK_ONLY', confidence_score: 0,
          source_date: new Date().toISOString().slice(0, 10) });
        copied++;
      }
      setMessage(`${copied} palavras copiadas para o banco de ${target.sku}. Duplicadas foram ignoradas. Revise e valide no destino antes de ativar Ads.`);
    } catch (error) { setMessage(`Cópia interrompida: ${error.message}. Você pode tentar novamente; as palavras já copiadas serão ignoradas.`); }
    finally { setBusy(false); }
  }
  return <>
    <button type="button" onClick={show} className="text-blue-600 underline">Copiar palavras para outro produto</button>
    {open && <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Copiar palavras-chave">
      <div className="bg-white text-slate-900 rounded-xl p-5 max-w-xl w-full space-y-3">
        <h2 className="text-lg font-semibold">Copiar palavras de {product.sku}</h2>
        <p>As palavras serão sugestões no banco do destino. Vendas, classificação de vencedor e lances não são transferidos.</p>
        <label className="block">Produto de destino<select aria-label="Produto de destino" value={destination} onChange={e => setDestination(e.target.value)} className="block w-full border p-2" disabled={busy}>
          <option value="">Selecione…</option>{products.map(p => <option key={p.id} value={p.id}>{p.sku} — {p.display_name || p.product_name || p.asin}</option>)}
        </select></label>
        <label className="block">Revise a relevância; uma palavra por linha<textarea aria-label="Palavras para copiar" value={terms} onChange={e => setTerms(e.target.value)} rows={8} className="block w-full border p-2" disabled={busy} /></label>
        {message && <p role="status">{message}</p>}
        <div className="flex gap-3"><button type="button" onClick={copy} disabled={busy || !destination || !terms.trim()} className="rounded bg-blue-600 text-white p-2 disabled:opacity-50">{busy ? 'Processando…' : 'Copiar para o banco'}</button>
          <button type="button" onClick={() => setOpen(false)} disabled={busy}>Fechar</button></div>
      </div>
    </div>}
  </>;
}
