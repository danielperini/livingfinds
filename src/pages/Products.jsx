import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Package, Search, RefreshCw, Loader2, AlertTriangle, Play, Pause,
  Plus, ChevronDown, ChevronUp, Tag, TrendingUp, TrendingDown, Zap, Filter
} from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';

function InventoryBadge({ status }) {
  const cfg = {
    in_stock: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
    low_stock: 'text-amber-400 bg-amber-400/10 border-amber-400/20',
    out_of_stock: 'text-red-400 bg-red-400/10 border-red-400/20',
  };
  const labels = { in_stock: 'Em Stock', low_stock: 'Stock Baixo', out_of_stock: 'Sem Stock' };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-medium ${cfg[status] || cfg.in_stock}`}>
      {labels[status] || status}
    </span>
  );
}

function ProductRow({ product, onToggleCampaign, onCreateCampaign, actionLoading }) {
  const [expanded, setExpanded] = useState(false);
  const [keywords, setKeywords] = useState([]);
  const [kwLoading, setKwLoading] = useState(false);

  const loadKeywords = async () => {
    if (!expanded) {
      setKwLoading(true);
      try {
        const kws = await base44.entities.Keyword.filter({ asin: product.asin }, '-spend', 50);
        setKeywords(kws);
      } finally {
        setKwLoading(false);
      }
    }
    setExpanded(v => !v);
  };

  const acos = product.acos || 0;
  const acosColor = acos > 50 ? 'text-red-400' : acos > 30 ? 'text-amber-400' : acos > 0 ? 'text-emerald-400' : 'text-slate-500';
  const isLoading = actionLoading === product.id;

  return (
    <>
      <tr className="border-b border-surface-2/40 hover:bg-surface-2/30 transition-colors">
        {/* Produto */}
        <td className="px-4 py-3 min-w-[220px]">
          <div className="flex items-center gap-3">
            {product.product_image_url ? (
              <img src={product.product_image_url} alt={product.product_name} className="w-10 h-10 rounded-lg object-cover bg-surface-3 flex-shrink-0" />
            ) : (
              <div className="w-10 h-10 rounded-lg bg-surface-3 flex items-center justify-center flex-shrink-0">
                <Package className="w-4 h-4 text-slate-600" />
              </div>
            )}
            <div className="min-w-0">
              <p className="text-xs font-semibold text-white truncate max-w-[160px]">{product.product_name || product.asin}</p>
              <p className="text-xs font-mono text-cyan mt-0.5">{product.asin}</p>
              {product.sku && <p className="text-xs text-slate-600 font-mono">{product.sku}</p>}
            </div>
          </div>
        </td>

        {/* Inventário */}
        <td className="px-4 py-3">
          <InventoryBadge status={product.inventory_status || 'in_stock'} />
          <p className="text-xs text-slate-500 mt-1">{product.fba_inventory || 0} un.</p>
        </td>

        {/* Status */}
        <td className="px-4 py-3">
          <StatusBadge status={product.status || 'active'} size="xs" />
          {product.is_new_asin && (
            <span className="ml-1 text-xs px-1.5 py-0.5 bg-cyan/15 text-cyan border border-cyan/20 rounded-full font-medium">Novo</span>
          )}
        </td>

        {/* Disponível desde */}
        <td className="px-4 py-3 text-xs text-slate-400 whitespace-nowrap">
          {product.first_available_date || '—'}
        </td>

        {/* Campanha */}
        <td className="px-4 py-3">
          {product.has_campaign ? (
            <div>
              <StatusBadge status={product.campaign_status === 'active' ? 'enabled' : product.campaign_status || 'paused'} size="xs" />
              {product.linked_campaign_id && (
                <p className="text-xs text-slate-600 font-mono mt-0.5 truncate max-w-[100px]">{product.linked_campaign_id.slice(-8)}</p>
              )}
            </div>
          ) : (
            <span className="text-xs text-slate-600">Sem campanha</span>
          )}
        </td>

        {/* Métricas */}
        <td className="px-4 py-3 text-xs">
          <span className={`font-semibold ${acosColor}`}>{acos > 0 ? `${acos.toFixed(1)}%` : '—'}</span>
        </td>
        <td className="px-4 py-3 text-xs text-cyan">
          {(product.roas || 0) > 0 ? `${(product.roas).toFixed(2)}x` : '—'}
        </td>
        <td className="px-4 py-3 text-xs text-slate-300">
          ${(product.total_spend_30d || 0).toFixed(2)}
        </td>
        <td className="px-4 py-3 text-xs text-emerald-400">
          ${(product.total_sales_30d || 0).toFixed(2)}
        </td>

        {/* Ações */}
        <td className="px-4 py-3 pr-5">
          <div className="flex items-center gap-1.5">
            {!product.has_campaign ? (
              <button
                onClick={() => onCreateCampaign(product)}
                disabled={isLoading || product.inventory_status === 'out_of_stock'}
                title={product.inventory_status === 'out_of_stock' ? 'Sem estoque — não pode criar campanha' : 'Criar campanha AUTO'}
                className="flex items-center gap-1 px-2.5 py-1.5 bg-cyan hover:bg-cyan/90 text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-40 whitespace-nowrap"
              >
                {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                Criar Camp.
              </button>
            ) : (
              <button
                onClick={() => onToggleCampaign(product)}
                disabled={isLoading}
                className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg transition-colors disabled:opacity-40 whitespace-nowrap ${
                  product.campaign_status === 'active'
                    ? 'bg-amber-500/15 border border-amber-500/20 text-amber-400 hover:bg-amber-500/25'
                    : 'bg-emerald-500/15 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/25'
                }`}
              >
                {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : product.campaign_status === 'active' ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                {product.campaign_status === 'active' ? 'Pausar' : 'Ativar'}
              </button>
            )}

            <button onClick={loadKeywords} className="p-1.5 text-slate-500 hover:text-slate-300 transition-colors" title="Ver keywords">
              <Tag className="w-3.5 h-3.5" />
              {expanded ? <ChevronUp className="w-3 h-3 inline ml-0.5" /> : <ChevronDown className="w-3 h-3 inline ml-0.5" />}
            </button>
          </div>
        </td>
      </tr>

      {/* Keywords expandido */}
      {expanded && (
        <tr className="border-b border-surface-2/40 bg-surface-2/20">
          <td colSpan={10} className="px-6 py-3">
            {kwLoading ? (
              <div className="flex items-center gap-2 py-2">
                <Loader2 className="w-3.5 h-3.5 text-cyan animate-spin" />
                <span className="text-xs text-slate-400">Carregando keywords...</span>
              </div>
            ) : keywords.length === 0 ? (
              <p className="text-xs text-slate-500 py-1">Sem keywords registadas para este ASIN.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr>
                      {['Keyword', 'Match', 'Bid', 'ACoS', 'ROAS', 'Cliques', 'Spend', 'Vendas', 'Estado'].map(h => (
                        <th key={h} className="pr-4 py-1.5 text-left text-slate-500 font-semibold uppercase tracking-wider whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {keywords.map(kw => {
                      const kwAcos = kw.acos || 0;
                      const kwAcosColor = kwAcos > 50 ? 'text-red-400' : kwAcos > 30 ? 'text-amber-400' : kwAcos > 0 ? 'text-emerald-400' : 'text-slate-500';
                      return (
                        <tr key={kw.id} className="border-t border-surface-2/30">
                          <td className="pr-4 py-1.5 text-slate-300 font-medium max-w-[180px] truncate">{kw.keyword || kw.keyword_text || '—'}</td>
                          <td className="pr-4 py-1.5"><span className="px-1.5 py-0.5 bg-surface-3 text-slate-400 rounded text-xs">{kw.match_type}</span></td>
                          <td className="pr-4 py-1.5 font-mono text-slate-300">${(kw.current_bid || kw.bid || 0).toFixed(2)}</td>
                          <td className={`pr-4 py-1.5 font-semibold ${kwAcosColor}`}>{kwAcos > 0 ? `${kwAcos.toFixed(1)}%` : '—'}</td>
                          <td className="pr-4 py-1.5 text-cyan">{(kw.roas || 0) > 0 ? `${kw.roas.toFixed(2)}x` : '—'}</td>
                          <td className="pr-4 py-1.5 text-slate-400">{(kw.clicks || 0).toLocaleString()}</td>
                          <td className="pr-4 py-1.5 text-slate-400">${(kw.spend || 0).toFixed(2)}</td>
                          <td className="pr-4 py-1.5 text-emerald-400">${(kw.sales || 0).toFixed(2)}</td>
                          <td className="pr-4 py-1.5"><StatusBadge status={kw.state || kw.status || 'enabled'} size="xs" /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
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
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [actionLoading, setActionLoading] = useState(null);
  const [actionMsg, setActionMsg] = useState(null);
  const [sortBy, setSortBy] = useState('total_sales_30d');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
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

  const syncInventory = async () => {
    if (!account) return;
    setSyncing(true);
    setSyncMsg('Sincronizando inventário...');
    try {
      const res = await base44.functions.invoke('syncProductsFromInventory', { amazon_account_id: account.id });
      const d = res.data;
      if (d?.ok) {
        setSyncMsg(`✓ ${d.imported} produtos importados${d.new_asins > 0 ? ` · ${d.new_asins} novos ASINs` : ''}`);
        await load();
      } else {
        setSyncMsg(`⚠ ${d?.error || 'Erro ao sincronizar'}`);
      }
    } catch (e) {
      setSyncMsg(`Erro: ${e.message}`);
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMsg(''), 8000);
    }
  };

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
        setActionMsg({ type: 'success', text: `✓ Campanha criada para ${product.asin}: ${d.campaign_name}` });
        await load();
      } else {
        setActionMsg({ type: 'error', text: d?.error || 'Erro ao criar campanha' });
      }
    } catch (e) {
      setActionMsg({ type: 'error', text: e.message });
    } finally {
      setActionLoading(null);
      setTimeout(() => setActionMsg(null), 8000);
    }
  };

  const toggleCampaign = async (product) => {
    if (!product.linked_campaign_id) return;
    setActionLoading(product.id);
    const isActive = product.campaign_status === 'active';
    const action = isActive ? 'pause_campaign' : 'enable_campaign';
    try {
      // Criar ação no agente (requer aprovação para pause)
      const agentAction = await base44.entities.AgentAction.create({
        amazon_account_id: account.id,
        action,
        asin: product.asin,
        campaign_id: product.linked_campaign_id,
        reason: isActive ? 'Pausa manual solicitada pelo utilizador' : 'Ativação manual solicitada pelo utilizador',
        evidence: `Produto: ${product.product_name || product.asin}`,
        risk_level: isActive ? 'high' : 'medium',
        requires_approval: isActive,
        current_value: null,
        new_value: null,
      });

      if (!isActive) {
        // Ativar não requer aprovação — executar imediatamente
        await base44.functions.invoke('executeAgentAction', { action_id: agentAction.id, approve: true });
        setActionMsg({ type: 'success', text: `✓ Campanha ativada para ${product.asin}` });
        await load();
      } else {
        setActionMsg({ type: 'info', text: `⏳ Pedido de pausa criado para aprovação. Aceda ao Painel de Ações para aprovar.` });
      }
    } catch (e) {
      setActionMsg({ type: 'error', text: e.message });
    } finally {
      setActionLoading(null);
      setTimeout(() => setActionMsg(null), 8000);
    }
  };

  // Filtros e pesquisa
  const filtered = products
    .filter(p => {
      const matchSearch = !search || (
        (p.asin || '').toLowerCase().includes(search.toLowerCase()) ||
        (p.product_name || '').toLowerCase().includes(search.toLowerCase()) ||
        (p.sku || '').toLowerCase().includes(search.toLowerCase())
      );
      const matchFilter =
        filter === 'all' ? true :
        filter === 'active' ? p.status === 'active' :
        filter === 'with_campaign' ? p.has_campaign :
        filter === 'no_campaign' ? !p.has_campaign :
        filter === 'new' ? p.is_new_asin :
        filter === 'out_of_stock' ? p.inventory_status === 'out_of_stock' :
        true;
      return matchSearch && matchFilter;
    });

  // KPIs
  const totalProducts = products.length;
  const withCampaign = products.filter(p => p.has_campaign).length;
  const newAsins = products.filter(p => p.is_new_asin).length;
  const outOfStock = products.filter(p => p.inventory_status === 'out_of_stock').length;
  const totalSpend = products.reduce((s, p) => s + (p.total_spend_30d || 0), 0);
  const totalSales = products.reduce((s, p) => s + (p.total_sales_30d || 0), 0);

  const filterButtons = [
    { key: 'all', label: `Todos (${totalProducts})` },
    { key: 'active', label: 'Ativos' },
    { key: 'with_campaign', label: `Com Camp. (${withCampaign})` },
    { key: 'no_campaign', label: `Sem Camp. (${totalProducts - withCampaign})` },
    { key: 'new', label: `Novos (${newAsins})` },
    { key: 'out_of_stock', label: `Sem Stock (${outOfStock})` },
  ];

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
            <Package className="w-5 h-5 text-cyan" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Produtos</h1>
            <p className="text-xs text-slate-400">{totalProducts} ASINs · {withCampaign} com campanha</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={syncInventory} disabled={syncing || !account}
            className="flex items-center gap-2 px-4 py-2 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60">
            {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {syncing ? 'Sincronizando...' : 'Sync Inventário'}
          </button>
          <button onClick={load} disabled={loading}
            className="p-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {syncMsg && (
        <div className={`px-4 py-3 rounded-xl border text-sm font-medium ${syncMsg.startsWith('✓') ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300' : 'bg-amber-400/10 border-amber-400/20 text-amber-300'}`}>
          {syncMsg}
        </div>
      )}

      {actionMsg && (
        <div className={`px-4 py-3 rounded-xl border text-sm font-medium ${
          actionMsg.type === 'success' ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300' :
          actionMsg.type === 'error' ? 'bg-red-400/10 border-red-400/20 text-red-400' :
          'bg-cyan/10 border-cyan/20 text-cyan'
        }`}>{actionMsg.text}</div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'Produtos Ativos', value: totalProducts, color: 'text-white' },
          { label: 'Com Campanha', value: withCampaign, color: 'text-cyan' },
          { label: 'Spend 30d', value: `$${totalSpend.toFixed(0)}`, color: 'text-slate-300' },
          { label: 'Vendas 30d', value: `$${totalSales.toFixed(0)}`, color: 'text-emerald-400' },
        ].map(k => (
          <div key={k.label} className="bg-surface-1 border border-surface-2 rounded-xl p-4">
            <p className="text-xs text-slate-500 mb-1">{k.label}</p>
            <p className={`text-xl font-bold ${k.color}`}>{loading ? '—' : k.value}</p>
          </div>
        ))}
      </div>

      {/* Filtros + pesquisa */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-shrink-0 sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Pesquisar ASIN, nome ou SKU..."
            className="w-full pl-10 pr-4 py-2.5 bg-surface-1 border border-surface-2 rounded-lg text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan/50" />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Filter className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
          {filterButtons.map(f => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors whitespace-nowrap ${filter === f.key ? 'bg-cyan/20 text-cyan border-cyan/30' : 'bg-surface-2 text-slate-500 border-surface-3 hover:text-slate-300'}`}>
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
          <p className="text-sm text-slate-400">Nenhuma conta Amazon configurada.<br/>Aceda às Configurações para conectar.</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
          <Package className="w-12 h-12 text-slate-600" />
          <p className="text-sm text-slate-400">
            {products.length === 0 ? 'Sem produtos. Execute "Sync Inventário" para importar.' : 'Nenhum produto encontrado com estes filtros.'}
          </p>
          {products.length === 0 && (
            <button onClick={syncInventory} disabled={syncing}
              className="flex items-center gap-2 px-4 py-2 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors">
              <Zap className="w-4 h-4" /> Sync Inventário
            </button>
          )}
        </div>
      ) : (
        <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-surface-2 flex items-center justify-between">
            <p className="text-xs text-slate-500">{filtered.length} produtos</p>
            <select value={sortBy} onChange={e => setSortBy(e.target.value)}
              className="text-xs bg-surface-2 border border-surface-3 text-slate-300 rounded-lg px-2 py-1 focus:outline-none">
              <option value="total_sales_30d">Ordenar: Vendas</option>
              <option value="total_spend_30d">Ordenar: Spend</option>
              <option value="acos">Ordenar: ACoS</option>
              <option value="fba_inventory">Ordenar: Stock</option>
            </select>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-2 bg-surface-2/40">
                  {['Produto', 'Inventário', 'Status', 'Disponível desde', 'Campanha', 'ACoS', 'ROAS', 'Spend 30d', 'Vendas 30d', 'Ações'].map(h => (
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