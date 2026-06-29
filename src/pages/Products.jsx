import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Package, Search, RefreshCw, Loader2, AlertTriangle, Play, Pause,
  Plus, Tag, ChevronDown, ChevronUp, Filter, Zap, CheckCircle, XCircle, Radio,
  TrendingUp, TrendingDown, MinusCircle
} from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';

function CampaignStatusCell({ product }) {
  if (!product.has_campaign) {
    return (
      <div className="flex items-center gap-1.5">
        <XCircle className="w-3.5 h-3.5 text-slate-600" />
        <span className="text-xs text-slate-500">Sem campanha</span>
      </div>
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

function AdsActionButton({ product, onCreateCampaign, onToggleCampaign, loading }) {
  const hasStock = (product.fba_inventory || 0) > 0;
  if (!product.has_campaign) {
    return (
      <button
        onClick={() => onCreateCampaign(product)}
        disabled={loading || !hasStock}
        title={!hasStock ? 'Sem estoque — não pode criar campanha' : 'Criar campanha AUTO para este produto'}
        className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg border transition-all disabled:opacity-40 whitespace-nowrap ${
          hasStock
            ? 'bg-cyan/15 border-cyan/30 text-cyan hover:bg-cyan/25'
            : 'bg-surface-3 border-surface-3 text-slate-600'
        }`}
      >
        {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
        {hasStock ? 'Ativar Ads' : 'Sem Stock'}
      </button>
    );
  }
  const isActive = product.campaign_status === 'active';
  return (
    <button
      onClick={() => onToggleCampaign(product)}
      disabled={loading}
      className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg border transition-all disabled:opacity-40 whitespace-nowrap ${
        isActive
          ? 'bg-amber-500/10 border-amber-500/20 text-amber-400 hover:bg-amber-500/20'
          : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20'
      }`}
    >
      {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : isActive ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
      {isActive ? 'Pausar' : 'Ativar'}
    </button>
  );
}

function ProductRow({ product, onToggleCampaign, onCreateCampaign, actionLoading }) {
  const [expanded, setExpanded] = useState(false);
  const [keywords, setKeywords] = useState([]);
  const [negSuggestions, setNegSuggestions] = useState([]);
  const [kwLoading, setKwLoading] = useState(false);

  const toggleKeywords = async () => {
    if (!expanded) {
      setKwLoading(true);
      try {
        const [kws, negs] = await Promise.all([
          base44.entities.Keyword.filter({ campaign_id: product.linked_campaign_id || '' }, '-spend', 50),
          base44.entities.NegativeKeywordSuggestion.filter({ campaign_id: product.linked_campaign_id || '', status: 'pending' }, '-created_date', 20),
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
  const isLoading = actionLoading === product.id;
  const hasStock = (product.fba_inventory || 0) > 0;

  return (
    <>
      <tr className="border-b border-surface-2/40 hover:bg-surface-2/30 transition-colors">
        {/* Produto */}
        <td className="px-4 py-3 min-w-[200px]">
          <div className="flex items-center gap-2.5">
            {product.product_image_url ? (
              <img src={product.product_image_url} alt={product.asin} className="w-9 h-9 rounded-lg object-cover bg-surface-3 flex-shrink-0" />
            ) : (
              <div className="w-9 h-9 rounded-lg bg-surface-3 flex items-center justify-center flex-shrink-0">
                <Package className="w-4 h-4 text-slate-600" />
              </div>
            )}
            <div className="min-w-0">
              <p className="text-xs font-mono font-semibold text-cyan">{product.asin}</p>
              {product.sku && <p className="text-xs text-slate-500 font-mono">{product.sku}</p>}
              {product.product_name && <p className="text-xs text-slate-400 truncate max-w-[140px] mt-0.5">{product.product_name}</p>}
            </div>
          </div>
        </td>

        {/* Estoque */}
        <td className="px-4 py-3">
          <div className={`text-sm font-bold ${!hasStock ? 'text-red-400' : (product.fba_inventory || 0) < 10 ? 'text-amber-400' : 'text-white'}`}>
            {product.fba_inventory || 0}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            {!hasStock ? (
              <span className="flex items-center gap-1 text-red-400"><AlertTriangle className="w-3 h-3" />Sem stock</span>
            ) : (product.fba_inventory || 0) < 10 ? (
              <span className="flex items-center gap-1 text-amber-400"><AlertTriangle className="w-3 h-3" />Baixo</span>
            ) : 'FBA'}
          </div>
        </td>

        {/* Status Campanha */}
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
          ${(product.total_spend_30d || 0).toFixed(2)}
        </td>
        <td className="px-4 py-3 text-xs">
          <span className={acosColor}>{acos > 0 ? `${acos.toFixed(1)}%` : <span className="text-slate-600">—</span>}</span>
        </td>
        <td className="px-4 py-3 text-xs text-slate-400">
          {(product.units_sold_30d || product.total_units_30d || 0) || <span className="text-slate-600">—</span>}
        </td>

        {/* Ação */}
        <td className="px-4 py-3 pr-5">
          <div className="flex items-center gap-1.5">
            <AdsActionButton
              product={product}
              onCreateCampaign={onCreateCampaign}
              onToggleCampaign={onToggleCampaign}
              loading={isLoading}
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
          <td colSpan={8} className="px-6 py-4 space-y-4">
            {kwLoading ? (
              <div className="flex items-center gap-2 py-2">
                <Loader2 className="w-3.5 h-3.5 text-cyan animate-spin" />
                <span className="text-xs text-slate-400">Carregando search terms...</span>
              </div>
            ) : (
              <>
                {/* Sugestões de ação do monitor */}
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

                {/* Sugestões de promoção */}
                {(() => {
                  const toPromote = keywords.filter(kw => kw.source === 'suggested');
                  if (toPromote.length === 0) return null;
                  return (
                    <div className="space-y-1">
                      <p className="text-xs font-semibold text-emerald-400 flex items-center gap-1.5">
                        <TrendingUp className="w-3.5 h-3.5" /> {toPromote.length} termos rentáveis — promover a manual
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {toPromote.map(kw => (
                          <span key={kw.id} title={`ACoS: ${(kw.acos||0).toFixed(0)}% · Spend: $${(kw.spend||0).toFixed(2)}`}
                            className="text-xs px-2 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 cursor-help">
                            ↑ {kw.keyword_text} ({(kw.acos||0).toFixed(0)}% ACoS)
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {/* Tabela de search terms */}
                {keywords.filter(kw => kw.source === 'search_term').length === 0 ? (
                  <p className="text-xs text-slate-500 py-1">Sem search terms capturados ainda. Execute um sync após a campanha rodar por alguns dias.</p>
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
                                  ? <span className="flex items-center gap-1 text-emerald-400 text-xs"><TrendingUp className="w-3 h-3" />Promover</span>
                                  : isWasting
                                  ? <span className="flex items-center gap-1 text-red-400 text-xs"><TrendingDown className="w-3 h-3" />Negativar</span>
                                  : <span className="text-slate-600 text-xs">Observar</span>
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

  const createCampaign = async (product) => {
    setActionLoading(product.id);
    setActionMsg(null);
    try {
      const res = await base44.functions.invoke('createAutoCampaignForAsin', {
        amazon_account_id: account.id,
        asin: product.asin,
        sku: product.sku,
        product_name: product.product_name,
      });
      const d = res.data;
      if (d?.ok) {
        setActionMsg({ type: 'success', text: `✓ Campanha AUTO criada para ${product.asin}: ${d.campaign_name} — Budget: $${d.daily_budget}/dia` });
        await load();
      } else {
        setActionMsg({ type: 'error', text: d?.error || 'Erro ao criar campanha' });
      }
    } catch (e) {
      setActionMsg({ type: 'error', text: e.message });
    } finally {
      setActionLoading(null);
      setTimeout(() => setActionMsg(null), 10000);
    }
  };

  // Ativar ads em massa para todos os produtos com estoque e sem campanha
  const bulkActivateAll = async () => {
    const targets = products.filter(p => !p.has_campaign && (p.fba_inventory || 0) > 0);
    if (targets.length === 0) return;
    setBulkActivating(true);
    setActionMsg({ type: 'info', text: `Ativando ads para ${targets.length} produtos...` });
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

  const toggleCampaign = async (product) => {
    if (!product.linked_campaign_id) return;
    setActionLoading(product.id);
    const isActive = product.campaign_status === 'active';
    const action = isActive ? 'pause_campaign' : 'enable_campaign';
    try {
      const agentAction = await base44.entities.AgentAction.create({
        amazon_account_id: account.id,
        action,
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

  const filtered = products.filter(p => {
    const matchSearch = !search || (
      (p.asin || '').toLowerCase().includes(search.toLowerCase()) ||
      (p.product_name || '').toLowerCase().includes(search.toLowerCase()) ||
      (p.sku || '').toLowerCase().includes(search.toLowerCase())
    );
    const matchFilter =
      filter === 'all' ? true :
      filter === 'with_campaign' ? p.has_campaign :
      filter === 'no_campaign' ? !p.has_campaign :
      filter === 'active_ads' ? (p.has_campaign && p.campaign_status === 'active') :
      filter === 'needs_ads' ? (!p.has_campaign && (p.fba_inventory || 0) > 0) :
      filter === 'no_stock' ? (p.fba_inventory || 0) === 0 :
      true;
    return matchSearch && matchFilter;
  });

  const totalProducts = products.length;
  const withActiveAds = products.filter(p => p.has_campaign && p.campaign_status === 'active').length;
  const withPausedAds = products.filter(p => p.has_campaign && p.campaign_status !== 'active').length;
  const needsAds = products.filter(p => !p.has_campaign && (p.fba_inventory || 0) > 0).length;
  const noStock = products.filter(p => (p.fba_inventory || 0) === 0).length;

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
            <p className="text-xs text-slate-400">{totalProducts} ASINs · {withActiveAds} ads ativos · {needsAds} precisam de ads</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {needsAds > 0 && (
            <button onClick={bulkActivateAll} disabled={bulkActivating || !account}
              className="flex items-center gap-2 px-4 py-2 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60">
              {bulkActivating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
              {bulkActivating ? 'Ativando...' : `Ativar Ads (${needsAds} produtos)`}
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

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
          <p className="text-xs text-slate-500 mb-1">Total Produtos</p>
          <p className="text-xl font-bold text-white">{loading ? '—' : totalProducts}</p>
        </div>
        <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4">
          <p className="text-xs text-slate-500 mb-1">Ads Ativos</p>
          <p className="text-xl font-bold text-emerald-400">{loading ? '—' : withActiveAds}</p>
          {withPausedAds > 0 && <p className="text-xs text-amber-400 mt-0.5">{withPausedAds} pausados</p>}
        </div>
        <div className={`rounded-xl p-4 border ${needsAds > 0 ? 'bg-cyan/5 border-cyan/20' : 'bg-surface-1 border-surface-2'}`}>
          <p className="text-xs text-slate-500 mb-1">Precisam de Ads</p>
          <p className={`text-xl font-bold ${needsAds > 0 ? 'text-cyan' : 'text-slate-400'}`}>{loading ? '—' : needsAds}</p>
          {needsAds > 0 && <p className="text-xs text-slate-500 mt-0.5">com estoque, sem campanha</p>}
        </div>
        <div className={`rounded-xl p-4 border ${noStock > 0 ? 'bg-red-500/5 border-red-500/20' : 'bg-surface-1 border-surface-2'}`}>
          <p className="text-xs text-slate-500 mb-1">Sem Estoque</p>
          <p className={`text-xl font-bold ${noStock > 0 ? 'text-red-400' : 'text-slate-400'}`}>{loading ? '—' : noStock}</p>
        </div>
      </div>

      {/* Filtros + pesquisa */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-shrink-0 sm:w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Pesquisar ASIN, SKU..."
            className="w-full pl-10 pr-4 py-2.5 bg-surface-1 border border-surface-2 rounded-lg text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan/50" />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Filter className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
          {[
            { key: 'all', label: `Todos (${totalProducts})` },
            { key: 'active_ads', label: `Ads Ativos (${withActiveAds})` },
            { key: 'needs_ads', label: `Precisam de Ads (${needsAds})`, highlight: needsAds > 0 },
            { key: 'with_campaign', label: `Com Camp. (${withActiveAds + withPausedAds})` },
            { key: 'no_campaign', label: `Sem Camp. (${totalProducts - withActiveAds - withPausedAds})` },
            { key: 'no_stock', label: `Sem Stock (${noStock})` },
          ].map(f => (
            <button key={f.key} onClick={() => setFilter(f.key)}
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
            {products.length === 0
              ? 'Sem produtos. Execute um Sync no Dashboard.'
              : 'Nenhum produto encontrado com estes filtros.'}
          </p>
        </div>
      ) : (
        <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-surface-2 flex items-center justify-between">
            <p className="text-xs text-slate-500">{filtered.length} produtos</p>
            <select value={sortBy} onChange={e => setSortBy(e.target.value)}
              className="text-xs bg-surface-2 border border-surface-3 text-slate-300 rounded-lg px-2 py-1 focus:outline-none">
              <option value="total_sales_30d">Ordenar: Vendas 30d</option>
              <option value="total_spend_30d">Ordenar: Spend 30d</option>
              <option value="fba_inventory">Ordenar: Estoque</option>
              <option value="acos">Ordenar: ACoS</option>
            </select>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-2 bg-surface-2/40">
                  {['Produto', 'Estoque FBA', 'Status Ads', 'Vendas 30d', 'Spend 30d', 'ACoS', 'Units 30d', 'Ações'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(p => (
                  <ProductRow
                    key={p.id}
                    product={p}
                    onToggleCampaign={toggleCampaign}
                    onCreateCampaign={createCampaign}
                    actionLoading={actionLoading}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}