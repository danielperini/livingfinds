import { useState, useEffect, useCallback, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { Link } from 'react-router-dom';
import {
  Sparkles, RefreshCw, Search, AlertCircle, CheckCircle2,
  Clock, ChevronRight, Loader2, ShieldAlert, FileText, Send, RotateCcw,
  Database, WifiOff, Info, Package
} from 'lucide-react';
import ListingEnhancementDrawer from '@/components/listing/ListingEnhancementDrawer';

function ProposalCountBadge({ count, type = 'default' }) {
  if (!count) return <span className="text-slate-600 text-xs">—</span>;
  const color = type === 'pending' ? 'text-amber-400 bg-amber-500/10 border-amber-500/20'
    : type === 'approved' ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
    : 'text-slate-400 bg-slate-500/10 border-slate-500/20';
  return (
    <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold border ${color}`}>
      {count}
    </span>
  );
}

function parseJsonSafe(str, fallback) {
  try { return JSON.parse(str || ''); } catch { return fallback; }
}

export default function ListingEnhancementPage() {
  const [account, setAccount] = useState(null);
  const [products, setProducts] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [proposals, setProposals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(null); // null | '__all__' | '__poll__' | '<asin>' | '<asin>_gen'
  const [syncQueue, setSyncQueue] = useState([]);
  const [search, setSearch] = useState('');
  const [filterIssues, setFilterIssues] = useState(false);
  const [filterProposals, setFilterProposals] = useState(false);
  const [selectedProductAsin, setSelectedProduct] = useState(null);
  const [msg, setMsg] = useState(null);
  const [spApiStatus, setSpApiStatus] = useState('unknown'); // 'ok' | 'error' | 'unknown'

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      let accs = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      if (!accs.length) accs = await base44.entities.AmazonAccount.filter({ status: 'connected' });
      const acc = accs[0] || null;
      setAccount(acc);
      if (!acc) return;

      const [prods, snaps, props] = await Promise.all([
        base44.entities.Product.filter({ amazon_account_id: acc.id, status: 'active' }, '-created_date', 200),
        base44.entities.ListingSnapshot.filter({ amazon_account_id: acc.id }, '-synced_at', 200).catch(() => []),
        base44.entities.ListingEnhancementProposal.filter({ amazon_account_id: acc.id }, '-created_at', 500).catch(() => []),
      ]);
      setProducts(prods || []);
      setSnapshots(snaps || []);
      setProposals(props || []);
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Enfileira todos os produtos não-sincronizados para sync sequencial
  const queueAllForSync = useCallback(() => {
    if (!account) return;
    const snapByAsinLocal = new Map(snapshots.map(s => [s.asin, s]));
    const prodByAsinLocal = new Map();
    for (const p of products) { if (!prodByAsinLocal.has(p.asin)) prodByAsinLocal.set(p.asin, p); }
    const unsynced = Array.from(prodByAsinLocal.keys()).filter(asin => !snapByAsinLocal.has(asin));
    const toQueue = unsynced.length > 0 ? unsynced : Array.from(prodByAsinLocal.keys());
    setSyncQueue(toQueue);
    setMsg({ type: 'info', text: `${toQueue.length} produto(s) adicionados à fila de sincronização. O processo ocorre em background.` });
    setTimeout(() => setMsg(null), 8000);
  }, [account, products, snapshots]);

  const pollAllProcessing = useCallback(async () => {
    if (!account) return;
    setSyncing('__poll__');
    setMsg(null);
    try {
      const res = await base44.functions.invoke('pollListingSubmissionStatus', { amazon_account_id: account.id });
      if (res?.data?.ok) {
        setMsg({ type: 'success', text: `${res.data.confirmed} confirmados, ${res.data.still_processing} ainda processando.` });
        if (res.data.confirmed > 0) await load();
      } else {
        setMsg({ type: 'error', text: res?.data?.error || 'Erro ao verificar status.' });
      }
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setSyncing(null);
      setTimeout(() => setMsg(null), 8000);
    }
  }, [account, load]);

  // Processa a fila de sync sequencialmente (um por vez para evitar rate limit)
  useEffect(() => {
    if (syncQueue.length === 0 || syncing || !account) return;
    const [nextAsin, ...rest] = syncQueue;
    const prod = products.find(p => p.asin === nextAsin);
    if (!prod) { setSyncQueue(rest); return; }

    setSyncing(nextAsin);
    base44.functions.invoke('syncListingEnhancementData', { amazon_account_id: account.id, asin: nextAsin })
      .then(res => {
        if (res?.data?.ok) {
          setSpApiStatus('ok');
        } else {
          const errText = res?.data?.error || '';
          if (errText.includes('503') || errText.includes('token') || errText.includes('SP-API')) setSpApiStatus('error');
        }
        return load();
      })
      .catch(e => {
        if (e.message?.includes('503') || e.message?.includes('token')) setSpApiStatus('error');
      })
      .finally(() => {
        setSyncing(null);
        setSyncQueue(rest);
      });
  }, [syncQueue, syncing, account, products, load]);

  const syncProduct = useCallback(async (product) => {
    if (!account) return;
    setSyncing(product.asin);
    setMsg(null);
    try {
      const res = await base44.functions.invoke('syncListingEnhancementData', {
        amazon_account_id: account.id, asin: product.asin,
      });
      if (res?.data?.ok) {
        setSpApiStatus('ok');
        setMsg({ type: 'success', text: `Sincronizado: ${product.asin}` });
        await load();
      } else {
        const errText = res?.data?.error || 'Erro ao sincronizar.';
        const isSpError = errText.includes('503') || errText.includes('SP-API') || errText.includes('token') || errText.includes('seller_id');
        if (isSpError) {
          setSpApiStatus('error');
        }
        setMsg({ type: 'error', text: errText });
      }
    } catch (e) {
      const errText = e.message || '';
      if (errText.includes('503') || errText.includes('token')) setSpApiStatus('error');
      setMsg({ type: 'error', text: `Erro: ${errText}` });
    } finally {
      setSyncing(null);
      setTimeout(() => setMsg(null), 10000);
    }
  }, [account, load]);

  const generateSuggestions = useCallback(async (product) => {
    if (!account) return;
    setSyncing(product.asin + '_gen');
    setMsg(null);
    try {
      const res = await base44.functions.invoke('generateListingEnhancementSuggestions', {
        amazon_account_id: account.id, asin: product.asin,
      });
      if (res?.data?.ok) {
        setMsg({ type: 'success', text: `${res.data.proposals_created} propostas criadas para ${product.asin}` });
        await load();
      } else {
        setMsg({ type: 'error', text: res?.data?.error || 'Erro ao gerar sugestões.' });
      }
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setSyncing(null);
      setTimeout(() => setMsg(null), 6000);
    }
  }, [account, load]);

  const snapByAsin = useMemo(() => new Map(snapshots.map(s => [s.asin, s])), [snapshots]);
  const proposalsByAsin = useMemo(() => {
    const map = new Map();
    for (const p of proposals) {
      if (!map.has(p.asin)) map.set(p.asin, []);
      map.get(p.asin).push(p);
    }
    return map;
  }, [proposals]);



  const prodByAsin = useMemo(() => {
    const map = new Map();
    for (const p of products) { if (!map.has(p.asin)) map.set(p.asin, p); }
    return map;
  }, [products]);
  const uniqueProducts = useMemo(() => Array.from(prodByAsin.values()), [prodByAsin]);

  const term = search.trim().toLowerCase();
  const filtered = uniqueProducts.filter(p => {
    const snap = snapByAsin.get(p.asin);
    const props = proposalsByAsin.get(p.asin) || [];
    const matchSearch = !term ||
      (p.asin || '').toLowerCase().includes(term) ||
      (p.sku || '').toLowerCase().includes(term) ||
      (p.product_name || '').toLowerCase().includes(term);
    const issues = parseJsonSafe(snap?.amazon_issues, []);
    const matchIssues = !filterIssues || issues.length > 0;
    const matchProposals = !filterProposals || props.length > 0;
    return matchSearch && matchIssues && matchProposals;
  });

  const stats = {
    total: uniqueProducts.length,
    synced: uniqueProducts.filter(p => snapByAsin.has(p.asin)).length,
    withIssues: uniqueProducts.filter(p => parseJsonSafe(snapByAsin.get(p.asin)?.amazon_issues, []).length > 0).length,
    pendingProposals: proposals.filter(p => p.approval_status === 'pending_review').length,
    approvedProposals: proposals.filter(p => p.approval_status === 'approved').length,
  };

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-violet-500/15 border border-violet-500/20 flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-violet-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <Link to="/products" className="text-xs text-slate-500 hover:text-slate-300 transition-colors">Produtos</Link>
              <ChevronRight className="w-3 h-3 text-slate-600" />
              <h1 className="text-lg font-bold text-white">Aprimoramento de Listings</h1>
            </div>
            <p className="text-xs text-slate-400">Sincronize, analise, sugira e publique melhorias nas suas ofertas Amazon via SP-API</p>
          </div>
        </div>

      </div>

      {msg && (
        <div className={`px-4 py-3 rounded-xl border text-sm font-medium ${
          msg.type === 'success' ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300'
          : msg.type === 'info' ? 'bg-cyan/10 border-cyan/20 text-cyan'
          : 'bg-red-400/10 border-red-400/20 text-red-400'}`}>
          {msg.text}
        </div>
      )}

      {spApiStatus === 'error' && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-xl border border-red-500/30 bg-red-500/8">
          <WifiOff className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-red-300 mb-0.5">Erro na sincronização via SP-API</p>
            <p className="text-xs text-red-400/80">
              Causas comuns: <strong>Seller ID não preenchido</strong> (campo seller_id na conta Amazon),
              credenciais SP-API inválidas/expiradas, ou serviço Amazon temporariamente indisponível.
              Os dados já no banco continuam visíveis. Verifique em{' '}
              <Link to="/integracoes/amazon" className="underline text-red-300">Integrações → Amazon</Link>.
            </p>
          </div>
          <button onClick={() => setSpApiStatus('unknown')} className="text-red-600 hover:text-red-400 text-xs flex-shrink-0">✕</button>
        </div>
      )}

      {syncQueue.length > 0 && (
        <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl border border-cyan/20 bg-cyan/5">
          <Loader2 className="w-3.5 h-3.5 text-cyan animate-spin flex-shrink-0" />
          <p className="text-xs text-cyan">
            Sincronizando em fila: {syncing && syncing !== '__poll__' ? <span className="font-mono font-bold">{syncing}</span> : '...'} · {syncQueue.length} restante(s)
          </p>
        </div>
      )}

      <div className="flex items-start gap-3 px-4 py-3 rounded-xl border border-amber-500/20 bg-amber-500/5">
        <ShieldAlert className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
        <p className="text-xs text-amber-300">
          <strong>Aprovação obrigatória.</strong> Nenhuma proposta é publicada automaticamente.
          Todo conteúdo passa por revisão humana antes de qualquer submissão à Amazon.
          Marcas de terceiros e atributos falsos são bloqueados automaticamente.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { label: 'Produtos', value: stats.total },
          { label: 'Sincronizados', value: stats.synced, tone: stats.synced === stats.total && stats.total > 0 ? 'success' : 'warn' },
          { label: 'Com Issues', value: stats.withIssues, tone: stats.withIssues > 0 ? 'danger' : 'default' },
          { label: 'Aguard. Revisão', value: stats.pendingProposals, tone: stats.pendingProposals > 0 ? 'warn' : 'default' },
          { label: 'Aprovadas', value: stats.approvedProposals, tone: stats.approvedProposals > 0 ? 'success' : 'default' },
        ].map(k => (
          <div key={k.label} className={`rounded-xl p-4 border ${k.tone === 'success' ? 'bg-emerald-500/5 border-emerald-500/20' : k.tone === 'warn' ? 'bg-amber-500/5 border-amber-500/20' : k.tone === 'danger' ? 'bg-red-500/5 border-red-500/20' : 'bg-surface-1 border-surface-2'}`}>
            <p className="text-xs text-slate-500 mb-1">{k.label}</p>
            <p className={`text-xl font-bold ${k.tone === 'success' ? 'text-emerald-400' : k.tone === 'warn' ? 'text-amber-400' : k.tone === 'danger' ? 'text-red-400' : 'text-white'}`}>{k.value}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="ASIN, SKU, nome..."
            className="w-full pl-9 pr-4 py-2 bg-surface-1 border border-surface-2 rounded-lg text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-violet-500/50" />
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setFilterIssues(v => !v)}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg border transition-colors ${filterIssues ? 'bg-red-500/15 border-red-500/30 text-red-400' : 'bg-surface-1 border-surface-2 text-slate-400 hover:text-slate-200'}`}>
            <AlertCircle className="w-3.5 h-3.5" /> Com Issues
          </button>
          <button onClick={() => setFilterProposals(v => !v)}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg border transition-colors ${filterProposals ? 'bg-violet-500/15 border-violet-500/30 text-violet-400' : 'bg-surface-1 border-surface-2 text-slate-400 hover:text-slate-200'}`}>
            <FileText className="w-3.5 h-3.5" /> Com Propostas
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 text-violet-400 animate-spin" /></div>
      ) : !account ? (
        <div className="text-center py-20 text-slate-400 text-sm">Nenhuma conta Amazon configurada.</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20 text-slate-400 text-sm">Nenhum produto encontrado.</div>
      ) : (
        <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-surface-2 bg-surface-2/40">
                  {['Produto', 'ASIN / SKU', 'Product Type', 'Issues', 'Termos', 'Título', 'Bullets', 'Desc.', 'Imgs', 'Propostas', 'Publicadas', 'Últ. Sync', 'Ações'].map(h => (
                    <th key={h} className="px-3 py-2.5 text-left font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(product => {
                  const snap = snapByAsin.get(product.asin);
                  const productProps = proposalsByAsin.get(product.asin) || [];
                  const issues = parseJsonSafe(snap?.amazon_issues, []);
                  const images = parseJsonSafe(snap?.images, []);
                  const bullets = parseJsonSafe(snap?.bullets, []);
                  const organicTerms = parseJsonSafe(snap?.organic_terms, []);
                  const pendingProps = productProps.filter(p => p.approval_status === 'pending_review').length;
                  const approvedProps = productProps.filter(p => p.approval_status === 'approved').length;
                  const draftProps = productProps.filter(p => p.approval_status === 'draft').length;
                  const confirmedProps = productProps.filter(p => p.submission_status === 'confirmed').length;
                  const processingProps = productProps.filter(p => p.submission_status === 'processing').length;
                  const isSyncing = syncing === product.asin;
                  const isGenerating = syncing === product.asin + '_gen';

                  return (
                    <tr key={product.id} className="border-b border-surface-2/40 hover:bg-surface-2/20 transition-colors">
                      <td className="px-3 py-2.5 max-w-[160px]">
                        <p className="text-slate-200 font-medium truncate" title={product.product_name}>
                          {product.display_name || product.product_name || '—'}
                        </p>
                      </td>
                      <td className="px-3 py-2.5">
                        <p className="font-mono text-cyan">{product.asin}</p>
                        <p className="font-mono text-slate-500 text-[10px]">{product.sku}</p>
                      </td>
                      <td className="px-3 py-2.5">
                        {snap?.product_type
                          ? <span className="px-2 py-0.5 bg-surface-2 rounded text-slate-400 text-[10px] font-mono">{snap.product_type}</span>
                          : <span className="text-slate-600">—</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        {issues.length > 0
                          ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border bg-red-500/10 border-red-500/20 text-red-400">{issues.length}</span>
                          : <span className="text-slate-600">—</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        {!snap ? <span className="text-slate-600">—</span>
                          : organicTerms.length > 0 ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                          : <AlertCircle className="w-3.5 h-3.5 text-amber-400" />}
                      </td>
                      <td className="px-3 py-2.5">
                        {!snap ? <span className="text-slate-600">—</span>
                          : snap.title ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                          : <AlertCircle className="w-3.5 h-3.5 text-red-400" />}
                      </td>
                      <td className="px-3 py-2.5">
                        {!snap ? <span className="text-slate-600">—</span>
                          : bullets.length >= 3 ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                          : <AlertCircle className="w-3.5 h-3.5 text-amber-400" />}
                      </td>
                      <td className="px-3 py-2.5">
                        {!snap ? <span className="text-slate-600">—</span>
                          : snap.description ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                          : <AlertCircle className="w-3.5 h-3.5 text-amber-400" />}
                      </td>
                      <td className="px-3 py-2.5">
                        {snap ? <span className="text-slate-300">{images.length}</span> : <span className="text-slate-600">—</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1 flex-wrap">
                          {draftProps > 0 && <ProposalCountBadge count={draftProps} />}
                          {pendingProps > 0 && <ProposalCountBadge count={pendingProps} type="pending" />}
                          {approvedProps > 0 && <ProposalCountBadge count={approvedProps} type="approved" />}
                          {!draftProps && !pendingProps && !approvedProps && <span className="text-slate-600">—</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        {confirmedProps > 0 ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border bg-emerald-500/10 border-emerald-500/20 text-emerald-400">
                            <CheckCircle2 className="w-2.5 h-2.5" />{confirmedProps}
                          </span>
                        ) : processingProps > 0 ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border bg-amber-500/10 border-amber-500/20 text-amber-400">
                            <Loader2 className="w-2.5 h-2.5 animate-spin" />{processingProps}
                          </span>
                        ) : <span className="text-slate-600">—</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        {snap?.synced_at
                          ? <span className="text-slate-500 text-[10px]">{new Date(snap.synced_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                          : <span className="text-amber-400 text-[10px]">Não sincronizado</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <button
                            onClick={() => syncProduct(product)}
                            disabled={!!syncing}
                            title="Sincronizar via SP-API (requer credenciais SP-API ativas)"
                            className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold rounded-lg border bg-surface-2 border-surface-3 text-slate-400 hover:text-white disabled:opacity-50 transition-colors">
                            {isSyncing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                            Sync SP-API
                          </button>
                          {snap && (
                            <button onClick={() => generateSuggestions(product)} disabled={!!syncing}
                              className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold rounded-lg border bg-violet-500/10 border-violet-500/20 text-violet-400 hover:bg-violet-500/20 disabled:opacity-50 transition-colors">
                              {isGenerating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                              Sugerir
                            </button>
                          )}
                          <button onClick={() => setSelectedProduct(product.asin)}
                            className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold rounded-lg border bg-cyan/10 border-cyan/20 text-cyan hover:bg-cyan/20 transition-colors">
                            <Package className="w-3 h-3" /> Abrir
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {selectedProductAsin && (() => {
        const selProd = prodByAsin.get(selectedProductAsin);
        if (!selProd) return null;
        return (
          <ListingEnhancementDrawer
            product={selProd}
            snapshot={snapByAsin.get(selectedProductAsin) || null}
            proposals={proposalsByAsin.get(selectedProductAsin) || []}
            account={account}
            onClose={() => setSelectedProduct(null)}
            onRefresh={load}
          />
        );
      })()}
    </div>
  );
}