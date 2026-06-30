import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Package, Search, RefreshCw, Loader2, Play, Pause,
  Plus, Tag, ChevronUp, Filter, Zap, XCircle, Radio,
  TrendingUp, TrendingDown, Rocket, ShoppingBag, AlertCircle
} from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import KickoffModal from '@/components/products/KickoffModal';

// Oferta ativa = produto com status 'active' na Amazon
// Oferta inativa = produto arquivado, inativo ou sem listing ativo
function offerStatus(product) {
  const s = (product.status || 'active').toLowerCase();
  if (s === 'active') return 'active';
  if (s === 'archived') return 'archived';
  return 'inactive';
}

function OfferStatusBadge({ product }) {
  const s = offerStatus(product);
  if (s === 'active') return (
    <span className="flex items-center gap-1 text-xs text-emerald-400 font-semibold">
      <ShoppingBag className="w-3.5 h-3.5" /> Ativa
    </span>
  );
  if (s === 'archived') return (
    <span className="flex items-center gap-1 text-xs text-slate-500">
      <XCircle className="w-3.5 h-3.5" /> Arquivada
    </span>
  );
  return (
    <span className="flex items-center gap-1 text-xs text-amber-400">
      <AlertCircle className="w-3.5 h-3.5" /> Inativa
    </span>
  );
}

function CampaignStatusCell({ product }) {
  if (!product.has_campaign) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-slate-500">
        <XCircle className="w-3.5 h-3.5 text-slate-600" /> Sem campanha
      </span>
    );
  }
  const active = product.campaign_status === 'active';
  return (
    <div>
      <div className={`flex items-center gap-1.5 ${active ? 'text-emerald-400' : 'text-amber-400'}`}>
        {active
          ? <><Radio className="w-3.5 h-3.5" /><span className="text-xs font-semibold">Ads Ativo</span></>
          : <><Pause className="w-3.5 h-3.5" /><span className="text-xs font-semibold">Ads Pausado</span></>
        }
      </div>
      {product.linked_campaign_id && (
        <p className="text-xs text-slate-600 font-mono mt-0.5 truncate max-w-[100px]">
          ...{product.linked_campaign_id.slice(-8)}
        </p>
      )}
    </div>
  );
}

function ActionButtons({ product, onKickoff, onToggleCampaign, loading }) {
  const isLoading = loading === product.id;

  if (!product.has_campaign) {
    return (
      <button
        onClick={() => onKickoff(product)}
        disabled={isLoading}
        title="Kick-off: cria campanha AUTO + manuais"
        className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg border transition-all disabled:opacity-50 bg-cyan/15 border-cyan/30 text-cyan hover:bg-cyan/25 whitespace-nowrap"
      >
        {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Rocket className="w-3 h-3" />}
        Kick-off
      </button>
    );
  }

  const isActive = product.campaign_status === 'active';
  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={() => onToggleCampaign(product)}
        disabled={isLoading}
        className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg border transition-all disabled:opacity-50 whitespace-nowrap ${
          isActive
            ? 'bg-amber-500/10 border-amber-500/20 text-amber-400 hover:bg-amber-500/20'
            : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20'
        }`}
      >
        {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : isActive ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
        {isActive ? 'Pausar' : 'Ativar'}
      </button>
      {/* Botão para criar nova campanha adicional */}
      <button
        onClick={() => onKickoff(product)}
        disabled={isLoading}
        title="Criar nova campanha para este produto"
        className="flex items-center gap-1 px-2 py-1.5 text-xs text-slate-500 hover:text-cyan border border-surface-3 hover:border-cyan/30 rounded-lg transition-all whitespace-nowrap"
      >
        <Plus className="w-3 h-3" />
      </button>
    </div>
  );
}

function ProductRow({ product, onToggleCampaign, onKickoff, actionLoading }) {
  const [expanded, setExpanded] = useState(false);
  const [keywords, setKeywords] = useState([]);
  const [negSuggestions, setNegSuggestions] = useState([]);
  const [kwLoading, setKwLoading] = useState(false);

  const toggleKeywords = async () => {
    if (!expanded && product.linked_campaign_id) {
      setKwLoading(true);
      try {
        const [kws, negs] = await Promise.all([
          base44.entities.Keyword.filter({ campaign_id: product.linked_campaign_id }, '-spend', 50),
          base44.entities.NegativeKeywordSuggestion.filter({ campaign_id: product.linked_campaign_id, status: 'pending' }, '-created_date', 20),
        ]);
        setKeywords(kws);
        setNegSuggestions(negs);
      } finally {
        setKwLoading(false);
      }
    }
    setExpanded(v => !v);
  };

  const acos = product.acos || 0;
  const acosColor = acos > 50 ? 'text-red-400' : acos > 30 ? 'text-amber-400' : acos > 0 ? 'text-emerald-400' : 'text-slate-500';

  return (
    <>
      <tr className="border-b border-surface-2/40 hover:bg-surface-2/30 transition-colors">
        {/* ASIN + Nome do Produto (coluna unificada com imagem) */}
        <td className="px-4 py-3 min-w-[260px] max-w-[320px]">
          <div className="flex items-center gap-2.5">
            {product.product_image_url ? (
              <img src={product.product_image_url} alt={product.asin} className="w-9 h-9 rounded-lg object-cover bg-surface-3 flex-shrink-0" />
            ) : (
              <div className="w-9 h-9 rounded-lg bg-surface-3 flex items-center justify-center flex-shrink-0">
                <Package className="w-4 h-4 text-slate-600" />
              </div>
            )}
            <div className="min-w-0">
              <p className="text-xs font-mono font-semibold text-cyan leading-none">{product.asin}</p>
              {product.product_name ? (
                <p className="text-xs text-slate-200 truncate mt-1 leading-tight" title={product.product_name}>{product.product_name}</p>
              ) : (
                <p className="text-xs text-slate-500 italic mt-1 leading-tight">Sem nome</p>
              )}
            </div>
          </div>
        </td>

        {/* Oferta */}
        <td className="px-4 py-3">
          <OfferStatusBadge product={product} />
        </td>

        {/* Status Ads */}
        <td className="px-4 py-3">
          <CampaignStatusCell product={product} />
        </td>

        {/* Métricas 30d */}
        <td className="px-4 py-3 text-xs text-emerald-400 font-semibold">
          {(product.total_sales_30d || product.total_revenue_30d || 0) > 0
            ? `$${(product.total_sales_30d || product.total_revenue_30d || 0).toFixed(2)}`
            : <span className="text-slate-600">—</span>}
        </td>
        <td className="px-4 py-3 text-xs text-slate-400">
          {(product.total_spend_30d || 0) > 0 ? `$${(product.total_spend_30d || 0).toFixed(2)}` : <span className="text-slate-600">—</span>}
        </td>
        <td className="px-4 py-3 text-xs">
          <span className={acosColor}>{acos > 0 ? `${acos.toFixed(1)}%` : <span className="text-slate-600">—</span>}</span>
        </td>
        <td className="px-4 py-3 text-xs text-slate-400">
          {(product.units_sold_30d || product.total_units_30d || 0) || <span className="text-slate-600">—</span>}
        </td>

        {/* Ação */}
        <td className="px-4 py-3 pr-5">
          <div className="flex items-center gap-1.5 flex-wrap">
            <ActionButtons
              product={product}
              onKickoff={onKickoff}
              onToggleCampaign={onToggleCampaign}
              loading={actionLoading}
            />
            {product.linked_campaign_id && (
              <button onClick={toggleKeywords} className="p-1.5 text-slate-500 hover:text-slate-300 transition-colors" title="Ver search terms">
                {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <Tag className="w-3.5 h-3.5" />}
              </button>
            )}
          </div>
        </td>
      </tr>

      {/* Keywords expandido */}
      {expanded && (
        <tr className="border-b border-surface-2/40 bg-surface-2/20">
          <td colSpan={9} className="px-6 py-4 space-y-4">
            {kwLoading ? (
              <div className="flex items-center gap-2 py-2">
                <Loader2 className="w-3.5 h-3.5 text-cyan animate-spin" />
                <span className="text-xs text-slate-400">Carregando search terms...</span>
              </div>
            ) : (
              <>
                {negSuggestions.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs font-semibold text-red-400 flex items-center gap-1.5">
                      <TrendingDown className="w-3.5 h-3.5" /> {negSuggestions.length} termos para negativar
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {negSuggestions.map(n => (
                        <span key={n.id} title={n.reason}
                          className="text-xs px-2 py-1 rounded-full bg-red-500/10 border border-red-500/20 text-red-300 cursor-help">
                          ✕ {n.keyword_text} (${(n.spend||0).toFixed(2)}, {n.sales > 0 ? `${(n.acos||0).toFixed(0)}% ACoS` : '0 vendas'})
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {keywords.filter(kw => kw.source === 'suggested').length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs font-semibold text-emerald-400 flex items-center gap-1.5">
                      <TrendingUp className="w-3.5 h-3.5" /> {keywords.filter(kw => kw.source === 'suggested').length} termos rentáveis — promover a manual
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {keywords.filter(kw => kw.source === 'suggested').map(kw => (
                        <span key={kw.id} title={`ACoS: ${(kw.acos||0).toFixed(0)}% · Spend: $${(kw.spend||0).toFixed(2)}`}
                          className="text-xs px-2 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 cursor-help">
                          ↑ {kw.keyword_text} ({(kw.acos||0).toFixed(0)}% ACoS)
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {keywords.filter(kw => kw.source === 'search_term').length === 0 ? (
                  <p className="text-xs text-slate-500 py-1">Sem search terms capturados ainda.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <p className="text-xs text-slate-500 mb-2 font-semibold">Search Terms Capturados</p>
                    <table className="w-full text-xs">
                      <thead>
                        <tr>
                          {['Search Term', 'Clicks', 'Spend', 'Vendas', 'ACoS', 'Sinal'].map(h => (
                            <th key={h} className="pr-5 py-1.5 text-left text-slate-500 font-semibold uppercase tracking-wider whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {keywords.filter(kw => kw.source === 'search_term').map(kw => {
                          const kwAcos = kw.acos || 0;
                          const isWasting = (kw.clicks || 0) >= 5 && (kw.spend || 0) >= 2 && (kw.sales || 0) === 0;
                          const isGood = (kw.sales || 0) > 0 && kwAcos > 0 && kwAcos < 40;
                          return (
                            <tr key={kw.id} className="border-t border-surface-2/30">
                              <td className="pr-5 py-1.5 text-slate-300 max-w-[180px] truncate">{kw.keyword_text || kw.keyword || '—'}</td>
                              <td className="pr-5 py-1.5 text-slate-400">{(kw.clicks || 0).toLocaleString()}</td>
                              <td className="pr-5 py-1.5 text-slate-400">${(kw.spend || 0).toFixed(2)}</td>
                              <td className="pr-5 py-1.5 text-emerald-400">${(kw.sales || 0).toFixed(2)}</td>
                              <td className={`pr-5 py-1.5 font-semibold ${kwAcos > 50 ? 'text-red-400' : kwAcos > 30 ? 'text-amber-400' : kwAcos > 0 ? 'text-emerald-400' : 'text-slate-600'}`}>
                                {kwAcos > 0 ? `${kwAcos.toFixed(1)}%` : '—'}
                              </td>
                              <td className="pr-5 py-1.5">
                                {isGood
                                  ? <span className="flex items-center gap-1 text-emerald-400"><TrendingUp className="w-3 h-3" />Promover</span>
                                  : isWasting
                                  ? <span className="flex items-center gap-1 text-red-400"><TrendingDown className="w-3 h-3" />Negativar</span>
                                  : <span className="text-slate-600">Observar</span>
                                }
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export default function Products() {
  const [account, setAccount] = useState(null);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [actionLoading, setActionLoading] = useState(null);
  const [actionMsg, setActionMsg] = useState(null);
  const [sortBy, setSortBy] = useState('total_sales_30d');
  const [bulkActivating, setBulkActivating] = useState(false);
  const [kickoffProduct, setKickoffProduct] = useState(null);
  const [enriching, setEnriching] = useState(false);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 20;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      let accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      if (!accounts.length) accounts = await base44.entities.AmazonAccount.list();
      const acc = accounts[0] || null;
      setAccount(acc);
      if (!acc) return;
      const prods = await base44.entities.Product.filter({ amazon_account_id: acc.id }, `-${sortBy}`, 500);
      setProducts(prods);
    } finally {
      setLoading(false);
    }
  }, [sortBy]);

  useEffect(() => { load(); }, [load]);

  const toggleCampaign = async (product) => {
    if (!product.linked_campaign_id) return;
    setActionLoading(product.id);
    const isActive = product.campaign_status === 'active';
    try {
      const agentAction = await base44.entities.AgentAction.create({
        amazon_account_id: account.id,
        action: isActive ? 'pause_campaign' : 'enable_campaign',
        asin: product.asin,
        campaign_id: product.linked_campaign_id,
        reason: isActive ? 'Pausa manual' : 'Ativação manual',
        evidence: `Produto: ${product.asin}`,
        risk_level: isActive ? 'high' : 'medium',
        requires_approval: isActive,
      });
      if (!isActive) {
        await base44.functions.invoke('executeAgentAction', { action_id: agentAction.id, approve: true });
        setActionMsg({ type: 'success', text: `✓ Campanha ativada para ${product.asin}` });
        await load();
      } else {
        setActionMsg({ type: 'info', text: `⏳ Pedido de pausa criado para aprovação.` });
      }
    } catch (e) {
      setActionMsg({ type: 'error', text: e.message });
    } finally {
      setActionLoading(null);
      setTimeout(() => setActionMsg(null), 8000);
    }
  };

  const enrichNames = async () => {
    if (!account) return;
    setEnriching(true);
    setActionMsg({ type: 'info', text: 'A buscar nomes dos produtos na Amazon...' });
    try {
      const res = await base44.functions.invoke('enrichProductNames', { amazon_account_id: account.id });
      const d = res.data;
      if (d?.ok) {
        setActionMsg({ type: 'success', text: `✓ ${d.enriched} nomes obtidos (${d.fallback || 0} sem nome na Amazon)` });
        await load();
      } else {
        setActionMsg({ type: 'error', text: d?.message || 'Erro ao buscar nomes' });
      }
    } catch (e) {
      setActionMsg({ type: 'error', text: e.message });
    } finally {
      setEnriching(false);
      setTimeout(() => setActionMsg(null), 10000);
    }
  };

  // Bulk kick-off para produtos sem campanha
  const bulkKickoff = async () => {
    const targets = filtered.filter(p => !p.has_campaign);
    if (!targets.length) return;
    setBulkActivating(true);
    setActionMsg({ type: 'info', text: `Criando campanhas para ${targets.length} produtos...` });
    let success = 0, failed = 0;
    for (const p of targets) {
      try {
        const res = await base44.functions.invoke('createAutoCampaignForAsin', {
          amazon_account_id: account.id,
          asin: p.asin,
          sku: p.sku,
          product_name: p.product_name,
        });
        if (res.data?.ok) success++;
        else failed++;
      } catch { failed++; }
    }
    setBulkActivating(false);
    setActionMsg({ type: success > 0 ? 'success' : 'error', text: `✓ ${success} campanhas criadas${failed > 0 ? ` · ${failed} falharam` : ''}` });
    await load();
    setTimeout(() => setActionMsg(null), 10000);
  };

  // Classificação por oferta
  const activeOffers = products.filter(p => offerStatus(p) === 'active');
  const inactiveOffers = products.filter(p => offerStatus(p) !== 'active');
  const withActiveAds = products.filter(p => p.has_campaign && p.campaign_status === 'active').length;
  const withPausedAds = products.filter(p => p.has_campaign && p.campaign_status !== 'active').length;
  const withoutCampaign = products.filter(p => !p.has_campaign).length;
  const totalProducts = products.length;

  const filtered = products.filter(p => {
    const matchSearch = !search || (
      (p.asin || '').toLowerCase().includes(search.toLowerCase()) ||
      (p.product_name || '').toLowerCase().includes(search.toLowerCase()) ||
      (p.sku || '').toLowerCase().includes(search.toLowerCase())
    );
    const matchFilter =
      filter === 'all' ? true :
      filter === 'offer_active' ? offerStatus(p) === 'active' :
      filter === 'offer_inactive' ? offerStatus(p) !== 'active' :
      filter === 'ads_active' ? (p.has_campaign && p.campaign_status === 'active') :
      filter === 'ads_paused' ? (p.has_campaign && p.campaign_status !== 'active') :
      filter === 'no_campaign' ? !p.has_campaign :
      true;
    return matchSearch && matchFilter;
  });

  const noCampaignInFiltered = filtered.filter(p => !p.has_campaign).length;
  const productsWithoutName = products.filter(p => !p.product_name).length;
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
            <Package className="w-5 h-5 text-cyan" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Produtos & Ads</h1>
            <p className="text-xs text-slate-400">{totalProducts} ASINs · {withActiveAds} ads ativos · {withoutCampaign} sem campanha</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {noCampaignInFiltered > 0 && (
            <button onClick={bulkKickoff} disabled={bulkActivating || !account}
              className="flex items-center gap-2 px-4 py-2 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60">
              {bulkActivating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
              {bulkActivating ? 'Criando...' : `Kick-off em massa (${noCampaignInFiltered})`}
            </button>
          )}
          {productsWithoutName > 0 && (
            <button onClick={enrichNames} disabled={enriching || !account}
              className="flex items-center gap-2 px-3 py-2 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60">
              {enriching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Tag className="w-4 h-4" />}
              {enriching ? 'Buscando nomes...' : `Buscar Nomes (${productsWithoutName})`}
            </button>
          )}
          <button onClick={load} disabled={loading}
            className="p-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {actionMsg && (
        <div className={`px-4 py-3 rounded-xl border text-sm font-medium ${
          actionMsg.type === 'success' ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300' :
          actionMsg.type === 'error' ? 'bg-red-400/10 border-red-400/20 text-red-400' :
          'bg-cyan/10 border-cyan/20 text-cyan'
        }`}>{actionMsg.text}</div>
      )}

      {/* KPIs — classificação por oferta */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4">
          <p className="text-xs text-slate-500 mb-1">Ofertas Ativas</p>
          <p className="text-xl font-bold text-emerald-400">{loading ? '—' : activeOffers.length}</p>
          <p className="text-xs text-slate-500 mt-0.5">listings ativos na Amazon</p>
        </div>
        <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4">
          <p className="text-xs text-slate-500 mb-1">Ofertas Inativas</p>
          <p className="text-xl font-bold text-amber-400">{loading ? '—' : inactiveOffers.length}</p>
          <p className="text-xs text-slate-500 mt-0.5">pausadas ou arquivadas</p>
        </div>
        <div className="bg-cyan/5 border border-cyan/20 rounded-xl p-4">
          <p className="text-xs text-slate-500 mb-1">Ads Ativos</p>
          <p className="text-xl font-bold text-cyan">{loading ? '—' : withActiveAds}</p>
          {withPausedAds > 0 && <p className="text-xs text-amber-400 mt-0.5">{withPausedAds} pausados</p>}
        </div>
        <div className={`rounded-xl p-4 border ${withoutCampaign > 0 ? 'bg-red-500/5 border-red-500/20' : 'bg-surface-1 border-surface-2'}`}>
          <p className="text-xs text-slate-500 mb-1">Sem Campanha</p>
          <p className={`text-xl font-bold ${withoutCampaign > 0 ? 'text-red-400' : 'text-slate-400'}`}>{loading ? '—' : withoutCampaign}</p>
          {withoutCampaign > 0 && <p className="text-xs text-slate-500 mt-0.5">precisam de Kick-off</p>}
        </div>
      </div>

      {/* Filtros + pesquisa */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-shrink-0 sm:w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="Pesquisar ASIN, SKU..."
            className="w-full pl-10 pr-4 py-2.5 bg-surface-1 border border-surface-2 rounded-lg text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan/50" />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Filter className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
          {[
            { key: 'all', label: `Todos (${totalProducts})` },
            { key: 'offer_active', label: `Oferta Ativa (${activeOffers.length})` },
            { key: 'offer_inactive', label: `Oferta Inativa (${inactiveOffers.length})` },
            { key: 'ads_active', label: `Ads Ativos (${withActiveAds})` },
            { key: 'ads_paused', label: `Ads Pausados (${withPausedAds})` },
            { key: 'no_campaign', label: `Sem Campanha (${withoutCampaign})`, highlight: withoutCampaign > 0 },
          ].map(f => (
            <button key={f.key} onClick={() => { setFilter(f.key); setPage(1); }}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors whitespace-nowrap ${
                filter === f.key
                  ? 'bg-cyan/20 text-cyan border-cyan/30'
                  : f.highlight
                  ? 'bg-cyan/5 text-cyan/70 border-cyan/20 hover:border-cyan/30'
                  : 'bg-surface-2 text-slate-500 border-surface-3 hover:text-slate-300'
              }`}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tabela */}
      {loading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-7 h-7 text-cyan animate-spin" /></div>
      ) : !account ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
          <Package className="w-12 h-12 text-slate-600" />
          <p className="text-sm text-slate-400">Nenhuma conta Amazon configurada.</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
          <Package className="w-12 h-12 text-slate-600" />
          <p className="text-sm text-slate-400">
            {products.length === 0 ? 'Sem produtos. Execute um Sync no Dashboard.' : 'Nenhum produto encontrado com estes filtros.'}
          </p>
        </div>
      ) : (
        <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-surface-2 flex items-center justify-between">
            <p className="text-xs text-slate-500">{filtered.length} produtos · página {page} de {totalPages}</p>
            <select value={sortBy} onChange={e => setSortBy(e.target.value)}
              className="text-xs bg-surface-2 border border-surface-3 text-slate-300 rounded-lg px-2 py-1 focus:outline-none">
              <option value="total_sales_30d">Ordenar: Vendas 30d</option>
              <option value="total_spend_30d">Ordenar: Spend 30d</option>
              <option value="acos">Ordenar: ACoS</option>
            </select>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-2 bg-surface-2/40">
                  {['ASIN / Nome do Produto', 'SKU', 'Oferta', 'Status Ads', 'Vendas 30d', 'Spend 30d', 'ACoS', 'Units 30d', 'Ações'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {paginated.map(p => (
                  <ProductRow
                    key={p.id}
                    product={p}
                    onToggleCampaign={toggleCampaign}
                    onKickoff={setKickoffProduct}
                    actionLoading={actionLoading}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 px-4 py-3 border-t border-surface-2">
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                className="px-3 py-1.5 text-xs rounded-lg bg-surface-2 border border-surface-3 text-slate-400 hover:text-white disabled:opacity-40 transition-colors">
                ← Anterior
              </button>
              <div className="flex items-center gap-1">
                {Array.from({ length: totalPages }, (_, i) => i + 1).map(n => (
                  <button key={n} onClick={() => setPage(n)}
                    className={`w-7 h-7 text-xs rounded-lg transition-colors ${n === page ? 'bg-cyan text-white' : 'bg-surface-2 border border-surface-3 text-slate-400 hover:text-white'}`}>
                    {n}
                  </button>
                ))}
              </div>
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                className="px-3 py-1.5 text-xs rounded-lg bg-surface-2 border border-surface-3 text-slate-400 hover:text-white disabled:opacity-40 transition-colors">
                Próxima →
              </button>
            </div>
          )}
        </div>
      )}

      {kickoffProduct && (
        <KickoffModal
          product={kickoffProduct}
          account={account}
          onClose={() => setKickoffProduct(null)}
          onDone={() => { setKickoffProduct(null); load(); }}
        />
      )}
    </div>
  );
}