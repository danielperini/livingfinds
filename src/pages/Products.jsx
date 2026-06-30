import { useCallback, useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import {
  AlertCircle,
  Check,
  ExternalLink,
  Filter,
  Loader2,
  Package,
  Pause,
  Pencil,
  Play,
  Radio,
  RefreshCw,
  Rocket,
  Search,
  ShoppingBag,
  X,
  XCircle,
  Zap,
} from 'lucide-react';
import KickoffModal from '@/components/products/KickoffModal';
import AcceleratorModal from '@/components/products/AcceleratorModal';

const PAGE_SIZE = 20;

function offerStatus(product) {
  const status = String(product?.status || 'active').toLowerCase();
  if (status === 'active') return 'active';
  if (status === 'archived') return 'archived';
  return 'inactive';
}

function productHasCampaign(product) {
  return Boolean(
    product?.linked_campaign_id ||
      product?.campaign_id ||
      product?.amazon_campaign_id ||
      product?.has_campaign ||
      ['active', 'enabled', 'paused'].includes(
        String(product?.campaign_status || '').toLowerCase()
      )
  );
}

function campaignIdOf(product) {
  return (
    product?.linked_campaign_id ||
    product?.campaign_id ||
    product?.amazon_campaign_id ||
    null
  );
}

function isCampaignActive(product) {
  return ['active', 'enabled'].includes(
    String(product?.campaign_status || '').toLowerCase()
  );
}

function formatBRL(value) {
  return Number(value || 0).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

function formatPercent(value) {
  return `${Number(value || 0).toLocaleString('pt-BR', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
}

function visibleName(product) {
  if (product?.display_name?.trim()) return product.display_name.trim();
  if (product?.product_name?.trim()) return product.product_name.trim();
  return `Produto ${product?.asin || ''}`.trim();
}

function OfferStatusBadge({ product }) {
  const status = offerStatus(product);

  if (status === 'active') {
    return (
      <span className="flex items-center gap-1 text-xs text-emerald-400 font-semibold">
        <ShoppingBag className="w-3.5 h-3.5" />
        Ativa
      </span>
    );
  }

  if (status === 'archived') {
    return (
      <span className="flex items-center gap-1 text-xs text-slate-500">
        <XCircle className="w-3.5 h-3.5" />
        Arquivada
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1 text-xs text-amber-400">
      <AlertCircle className="w-3.5 h-3.5" />
      Inativa
    </span>
  );
}

function CampaignStatusCell({ product }) {
  const hasCampaign = productHasCampaign(product);

  if (!hasCampaign) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-slate-500">
        <XCircle className="w-3.5 h-3.5 text-slate-600" />
        0 campanhas
      </span>
    );
  }

  const active = isCampaignActive(product);
  const campaignId = campaignIdOf(product);

  return (
    <div>
      <div
        className={`flex items-center gap-1.5 ${
          active ? 'text-emerald-400' : 'text-amber-400'
        }`}
      >
        {active ? (
          <>
            <Radio className="w-3.5 h-3.5" />
            <span className="text-xs font-semibold">Ads Ativo</span>
          </>
        ) : (
          <>
            <Pause className="w-3.5 h-3.5" />
            <span className="text-xs font-semibold">Ads Pausado</span>
          </>
        )}
      </div>

      {campaignId && (
        <p className="text-xs text-slate-600 font-mono mt-0.5 truncate max-w-[100px]">
          ...{String(campaignId).slice(-8)}
        </p>
      )}
    </div>
  );
}

function ActionButtons({
  product,
  onKickoff,
  onAccelerator,
  onToggleCampaign,
  onArchiveCampaign,
  loading,
}) {
  const isLoading = loading === product.id;
  const hasCampaign = productHasCampaign(product);
  const active = isCampaignActive(product);

  if (!hasCampaign) {
    return (
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onKickoff(product)}
          disabled={isLoading}
          title="Criar campanha para este produto"
          className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg border transition-all disabled:opacity-50 bg-cyan/15 border-cyan/30 text-cyan hover:bg-cyan/25 whitespace-nowrap"
        >
          {isLoading ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Rocket className="w-3 h-3" />
          )}
          Kick-off
        </button>

        <button
          type="button"
          onClick={() => onAccelerator(product)}
          disabled={isLoading}
          title="Criar campanha manual com palavras-chave exatas"
          className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg border transition-all disabled:opacity-50 bg-emerald-500/15 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25 whitespace-nowrap"
        >
          {isLoading ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Zap className="w-3 h-3" />
          )}
          Acelerar
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => onToggleCampaign(product)}
        disabled={isLoading}
        title={active ? 'Pausar campanha' : 'Ativar campanha'}
        className={`flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all disabled:opacity-50 whitespace-nowrap ${
          active
            ? 'bg-amber-500/20 border-amber-500/30 text-amber-400 hover:bg-amber-500/30'
            : 'bg-emerald-500/20 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/30'
        }`}
      >
        {isLoading ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : active ? (
          <Pause className="w-3 h-3" />
        ) : (
          <Play className="w-3 h-3" />
        )}
        {active ? 'Pausar' : 'Ativar'}
      </button>

      <button
        type="button"
        onClick={() => onArchiveCampaign(product)}
        disabled={isLoading}
        title="Arquivar campanha permanentemente"
        className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg border transition-all disabled:opacity-50 whitespace-nowrap bg-red-500/10 border-red-500/20 text-red-400 hover:bg-red-500/20"
      >
        {isLoading ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : (
          <XCircle className="w-3 h-3" />
        )}
        Arquivar
      </button>
    </div>
  );
}

function ProductRow({
  product,
  onToggleCampaign,
  onArchiveCampaign,
  onKickoff,
  onAccelerator,
  actionLoading,
  onNameUpdate,
}) {
  const [editingName, setEditingName] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [savingName, setSavingName] = useState(false);

  const name = visibleName(product);
  const fallback = !product?.display_name?.trim() && !product?.product_name?.trim();
  const acos = Number(product?.acos || 0);
  const acosColor =
    acos > 50
      ? 'text-red-400'
      : acos > 30
        ? 'text-amber-400'
        : acos > 0
          ? 'text-emerald-400'
          : 'text-slate-500';

  const startEdit = () => {
    setEditValue(product?.display_name || product?.product_name || '');
    setEditingName(true);
  };

  const saveEdit = async () => {
    if (!editValue.trim()) return;

    setSavingName(true);
    try {
      await base44.entities.Product.update(product.id, {
        display_name: editValue.trim(),
      });
      onNameUpdate?.(product.id, editValue.trim());
      setEditingName(false);
    } finally {
      setSavingName(false);
    }
  };

  return (
    <tr className="border-b border-surface-2/40 hover:bg-surface-2/30 transition-colors">
      <td className="px-4 py-3 min-w-[340px] max-w-[440px]">
        <div className="flex items-start gap-3">
          {product?.product_image_url ? (
            <img
              src={product.product_image_url}
              alt={product.asin}
              className="w-12 h-12 rounded-lg object-cover bg-surface-3 flex-shrink-0 mt-0.5"
            />
          ) : (
            <div className="w-12 h-12 rounded-lg bg-surface-3 flex items-center justify-center flex-shrink-0 mt-0.5">
              <Package className="w-5 h-5 text-slate-600" />
            </div>
          )}

          <div className="min-w-0 flex-1">
            {editingName ? (
              <div className="flex items-center gap-1">
                <input
                  autoFocus
                  value={editValue}
                  onChange={(event) => setEditValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') saveEdit();
                    if (event.key === 'Escape') setEditingName(false);
                  }}
                  className="flex-1 min-w-0 text-xs px-2 py-1 bg-surface-3 border border-cyan/40 rounded text-white focus:outline-none"
                />

                <button
                  type="button"
                  onClick={saveEdit}
                  disabled={savingName}
                  className="p-1 text-emerald-400 hover:text-emerald-300"
                >
                  {savingName ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Check className="w-3 h-3" />
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => setEditingName(false)}
                  className="p-1 text-slate-500 hover:text-slate-300"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ) : (
              <div className="flex items-start gap-1 group">
                <p
                  className={`text-xs leading-snug font-medium line-clamp-2 ${
                    fallback ? 'text-slate-500 italic' : 'text-slate-100'
                  }`}
                  title={name}
                >
                  {name}
                  {product?.display_name?.trim() && (
                    <span className="ml-1 text-cyan/60 text-[10px]">(editado)</span>
                  )}
                </p>

                <button
                  type="button"
                  onClick={startEdit}
                  className="flex-shrink-0 opacity-0 group-hover:opacity-100 p-0.5 text-slate-500 hover:text-cyan transition-opacity mt-0.5"
                  title="Editar nome"
                >
                  <Pencil className="w-2.5 h-2.5" />
                </button>
              </div>
            )}

            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <span className="text-xs font-mono text-cyan">{product?.asin}</span>
              {product?.sku && (
                <span className="text-xs text-slate-500 font-mono">
                  SKU: {product.sku}
                </span>
              )}
            </div>

            {product?.asin && (
              <a
                href={`https://www.amazon.com.br/dp/${product.asin}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 text-[10px] text-slate-600 hover:text-cyan mt-0.5 transition-colors"
              >
                <ExternalLink className="w-2.5 h-2.5" />
                Ver na Amazon
              </a>
            )}
          </div>
        </div>
      </td>

      <td className="px-4 py-3">
        <OfferStatusBadge product={product} />
      </td>

      <td className="px-4 py-3">
        <CampaignStatusCell product={product} />
      </td>

      <td className="px-4 py-3 text-xs text-emerald-400 font-semibold">
        {formatBRL(product?.total_sales_30d || product?.total_revenue_30d || 0)}
      </td>

      <td className="px-4 py-3 text-xs text-slate-400">
        {formatBRL(product?.total_spend_30d || 0)}
      </td>

      <td className="px-4 py-3 text-xs">
        <span className={acosColor}>{formatPercent(acos)}</span>
      </td>

      <td className="px-4 py-3 text-xs text-slate-400">
        {Number(product?.units_sold_30d || product?.total_units_30d || 0).toLocaleString(
          'pt-BR'
        )}
      </td>

      <td className="px-4 py-3 pr-5">
        <ActionButtons
          product={product}
          onKickoff={onKickoff}
          onAccelerator={onAccelerator}
          onToggleCampaign={onToggleCampaign}
          onArchiveCampaign={onArchiveCampaign}
          loading={actionLoading}
        />
      </td>
    </tr>
  );
}

function KpiCard({ label, value, detail, tone = 'default' }) {
  const tones = {
    default: 'bg-surface-1 border-surface-2 text-slate-300',
    success: 'bg-emerald-500/5 border-emerald-500/20 text-emerald-400',
    warning: 'bg-amber-500/5 border-amber-500/20 text-amber-400',
    danger: 'bg-red-500/5 border-red-500/20 text-red-400',
    cyan: 'bg-cyan/5 border-cyan/20 text-cyan',
  };

  return (
    <div className={`rounded-xl p-4 border ${tones[tone]}`}>
      <p className="text-xs text-slate-500 mb-1">{label}</p>
      <p className="text-xl font-bold">{value}</p>
      {detail && <p className="text-xs text-slate-500 mt-0.5">{detail}</p>}
    </div>
  );
}

export default function Products() {
  const [account, setAccount] = useState(null);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [sortBy, setSortBy] = useState('total_sales_30d');
  const [page, setPage] = useState(1);
  const [actionLoading, setActionLoading] = useState(null);
  const [actionMsg, setActionMsg] = useState(null);
  const [bulkActivating, setBulkActivating] = useState(false);
  const [fixingLinks, setFixingLinks] = useState(false);
  const [kickoffProduct, setKickoffProduct] = useState(null);
  const [acceleratorProduct, setAcceleratorProduct] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);

    try {
      const me = await base44.auth.me();
      let accounts = await base44.entities.AmazonAccount.filter({
        user_id: me.id,
      });

      if (!accounts.length) {
        accounts = await base44.entities.AmazonAccount.list();
      }

      const currentAccount = accounts[0] || null;
      setAccount(currentAccount);

      if (!currentAccount) {
        setProducts([]);
        return;
      }

      const records = await base44.entities.Product.filter(
        { amazon_account_id: currentAccount.id },
        `-${sortBy}`,
        500
      );

      setProducts(records || []);
    } catch (error) {
      setActionMsg({
        type: 'error',
        text: error?.message || 'Erro ao carregar produtos.',
      });
    } finally {
      setLoading(false);
    }
  }, [sortBy]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleCampaign = async (product) => {
    const campaignId = campaignIdOf(product);
    if (!campaignId || !account) return;

    const active = isCampaignActive(product);
    setActionLoading(product.id);

    try {
      if (active) {
        // Pausar: usar função dedicada que usa credenciais da conta corretamente
        const response = await base44.functions.invoke('pauseCampaign', {
          amazon_account_id: account.id,
          campaign_id: campaignId,
        });
        if (!response?.data?.ok) {
          throw new Error(response?.data?.error || JSON.stringify(response?.data?.amazon_response) || 'Falha ao pausar campanha');
        }
      } else {
        // Ativar: via AgentAction
        const agentAction = await base44.entities.AgentAction.create({
          amazon_account_id: account.id,
          action: 'enable_campaign',
          asin: product.asin,
          campaign_id: campaignId,
          reason: 'Ativação manual',
          evidence: `Produto: ${product.asin}`,
          risk_level: 'medium',
          requires_approval: false,
        });
        await base44.functions.invoke('executeAgentAction', {
          action_id: agentAction.id,
          approve: true,
        });
      }

      setActionMsg({
        type: 'success',
        text: active ? `Campanha pausada para ${product.asin}.` : `Campanha ativada para ${product.asin}.`,
      });

      await load();
    } catch (error) {
      setActionMsg({
        type: 'error',
        text: error?.message || 'Erro ao alterar campanha.',
      });
    } finally {
      setActionLoading(null);
      setTimeout(() => setActionMsg(null), 8000);
    }
  };

  const archiveCampaign = async (product) => {
    const campaignId = campaignIdOf(product);
    if (!campaignId || !account) return;

    const confirmed = window.confirm(
      `Tem certeza que deseja arquivar a campanha de ${product.asin}?`
    );

    if (!confirmed) return;

    setActionLoading(product.id);

    try {
      const response = await base44.functions.invoke('archiveCampaign', {
        amazon_account_id: account.id,
        campaign_id: campaignId,
        archive_reason: `Arquivamento manual via interface - ${new Date().toLocaleDateString(
          'pt-BR'
        )}`,
      });

      if (!response?.data?.ok) {
        throw new Error(response?.data?.error || 'Falha ao arquivar campanha.');
      }

      setActionMsg({
        type: 'success',
        text: `Campanha arquivada para ${product.asin}.`,
      });

      await load();
    } catch (error) {
      setActionMsg({
        type: 'error',
        text: error?.message || 'Erro ao arquivar campanha.',
      });
    } finally {
      setActionLoading(null);
      setTimeout(() => setActionMsg(null), 8000);
    }
  };

  const fixCampaignLinks = async () => {
    if (!account) return;

    setFixingLinks(true);
    setActionMsg({
      type: 'info',
      text: 'Corrigindo vínculos de campanhas...',
    });

    try {
      const response = await base44.functions.invoke('fixProductCampaignLinks', {
        amazon_account_id: account.id,
      });

      if (!response?.data?.ok) {
        throw new Error(
          response?.data?.error || 'Erro ao corrigir vínculos.'
        );
      }

      setActionMsg({
        type: 'success',
        text: `${response.data.updated || 0} produtos corrigidos.`,
      });

      await load();
    } catch (error) {
      setActionMsg({
        type: 'error',
        text: error?.message || 'Erro ao corrigir vínculos.',
      });
    } finally {
      setFixingLinks(false);
      setTimeout(() => setActionMsg(null), 10000);
    }
  };

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();

    return products.filter((product) => {
      const matchesSearch =
        !term ||
        String(product?.asin || '').toLowerCase().includes(term) ||
        String(product?.sku || '').toLowerCase().includes(term) ||
        String(product?.product_name || '').toLowerCase().includes(term) ||
        String(product?.display_name || '').toLowerCase().includes(term);

      const hasCampaign = productHasCampaign(product);
      const active = isCampaignActive(product);

      const matchesFilter =
        filter === 'all' ||
        (filter === 'offer_active' && offerStatus(product) === 'active') ||
        (filter === 'offer_inactive' && offerStatus(product) !== 'active') ||
        (filter === 'ads_active' && hasCampaign && active) ||
        (filter === 'ads_paused' && hasCampaign && !active) ||
        (filter === 'no_campaign' && !hasCampaign);

      return matchesSearch && matchesFilter;
    });
  }, [products, search, filter]);

  const activeOffers = products.filter(
    (product) => offerStatus(product) === 'active'
  ).length;

  const inactiveOffers = products.length - activeOffers;

  const activeAds = products.filter(
    (product) => productHasCampaign(product) && isCampaignActive(product)
  ).length;

  const pausedAds = products.filter(
    (product) => productHasCampaign(product) && !isCampaignActive(product)
  ).length;

  const withoutCampaign = products.filter(
    (product) => !productHasCampaign(product)
  ).length;

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = filtered.slice(
    (safePage - 1) * PAGE_SIZE,
    safePage * PAGE_SIZE
  );

  const bulkKickoff = async () => {
    if (!account) return;

    const targets = filtered.filter((product) => !productHasCampaign(product));
    if (!targets.length) return;

    setBulkActivating(true);
    setActionMsg({
      type: 'info',
      text: `Criando campanhas para ${targets.length} produtos...`,
    });

    let success = 0;
    let failed = 0;

    for (const product of targets) {
      try {
        const response = await base44.functions.invoke(
          'createAutoCampaignForAsin',
          {
            amazon_account_id: account.id,
            asin: product.asin,
            sku: product.sku,
            product_name: product.product_name,
          }
        );

        if (response?.data?.ok) success += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }

    setBulkActivating(false);
    setActionMsg({
      type: success > 0 ? 'success' : 'error',
      text: `${success} campanhas criadas${
        failed > 0 ? ` · ${failed} falharam` : ''
      }`,
    });

    await load();
    setTimeout(() => setActionMsg(null), 10000);
  };

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
            <Package className="w-5 h-5 text-cyan" />
          </div>

          <div>
            <h1 className="text-lg font-bold text-white">Produtos & Ads</h1>
            <p className="text-xs text-slate-400">
              {products.length} ASINs · {activeAds} ads ativos ·{' '}
              {withoutCampaign} sem campanha
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {withoutCampaign > 0 && (
            <button
              type="button"
              onClick={bulkKickoff}
              disabled={bulkActivating || !account}
              className="flex items-center gap-2 px-4 py-2 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60"
            >
              {bulkActivating ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Zap className="w-4 h-4" />
              )}
              {bulkActivating
                ? 'Criando...'
                : `Kick-off em massa (${withoutCampaign})`}
            </button>
          )}

          <button
            type="button"
            onClick={fixCampaignLinks}
            disabled={fixingLinks || !account}
            className="flex items-center gap-2 px-3 py-2 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60"
          >
            {fixingLinks ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Check className="w-4 h-4" />
            )}
            {fixingLinks ? 'Corrigindo...' : 'Corrigir Vínculos'}
          </button>

          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="p-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors"
          >
            <RefreshCw
              className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`}
            />
          </button>
        </div>
      </div>

      {actionMsg && (
        <div
          className={`px-4 py-3 rounded-xl border text-sm font-medium ${
            actionMsg.type === 'success'
              ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300'
              : actionMsg.type === 'error'
                ? 'bg-red-400/10 border-red-400/20 text-red-400'
                : 'bg-cyan/10 border-cyan/20 text-cyan'
          }`}
        >
          {actionMsg.text}
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label="Ofertas Ativas"
          value={loading ? '0' : activeOffers}
          detail="listings ativos na Amazon"
          tone="success"
        />

        <KpiCard
          label="Ofertas Inativas"
          value={loading ? '0' : inactiveOffers}
          detail="pausadas ou arquivadas"
          tone="warning"
        />

        <KpiCard
          label="Ads Ativos"
          value={loading ? '0' : activeAds}
          detail={`${pausedAds} pausados`}
          tone="cyan"
        />

        <KpiCard
          label="Sem Campanha"
          value={loading ? '0' : withoutCampaign}
          detail={withoutCampaign > 0 ? 'precisam de Kick-off' : 'nenhum produto pendente'}
          tone={withoutCampaign > 0 ? 'danger' : 'default'}
        />
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-shrink-0 sm:w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />

          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Pesquisar ASIN, SKU, nome ou título..."
            className="w-full pl-10 pr-4 py-2.5 bg-surface-1 border border-surface-2 rounded-lg text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan/50"
          />
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          <Filter className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />

          {[
            { key: 'all', label: `Todos (${products.length})` },
            { key: 'offer_active', label: `Oferta Ativa (${activeOffers})` },
            {
              key: 'offer_inactive',
              label: `Oferta Inativa (${inactiveOffers})`,
            },
            { key: 'ads_active', label: `Ads Ativos (${activeAds})` },
            { key: 'ads_paused', label: `Ads Pausados (${pausedAds})` },
            {
              key: 'no_campaign',
              label: `Sem Campanha (${withoutCampaign})`,
            },
          ].map((item) => (
            <button
              type="button"
              key={item.key}
              onClick={() => {
                setFilter(item.key);
                setPage(1);
              }}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors whitespace-nowrap ${
                filter === item.key
                  ? 'bg-cyan/20 text-cyan border-cyan/30'
                  : 'bg-surface-2 text-slate-500 border-surface-3 hover:text-slate-300'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-7 h-7 text-cyan animate-spin" />
        </div>
      ) : !account ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
          <Package className="w-12 h-12 text-slate-600" />
          <p className="text-sm text-slate-400">
            Nenhuma conta Amazon configurada.
          </p>
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
            <p className="text-xs text-slate-500">
              {filtered.length} produtos · página {safePage} de {totalPages}
            </p>

            <select
              value={sortBy}
              onChange={(event) => setSortBy(event.target.value)}
              className="text-xs bg-surface-2 border border-surface-3 text-slate-300 rounded-lg px-2 py-1 focus:outline-none"
            >
              <option value="total_sales_30d">Ordenar: Vendas 30d</option>
              <option value="total_spend_30d">Ordenar: Spend 30d</option>
              <option value="acos">Ordenar: ACoS</option>
            </select>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-2 bg-surface-2/40">
                  {[
                    'Produto',
                    'Oferta',
                    'Status Ads',
                    'Vendas 30d',
                    'Spend 30d',
                    'ACoS',
                    'Units 30d',
                    'Ações',
                  ].map((heading) => (
                    <th
                      key={heading}
                      className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap"
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {paginated.map((product) => (
                  <ProductRow
                    key={product.id}
                    product={product}
                    onToggleCampaign={toggleCampaign}
                    onArchiveCampaign={archiveCampaign}
                    onKickoff={setKickoffProduct}
                    onAccelerator={setAcceleratorProduct}
                    actionLoading={actionLoading}
                    onNameUpdate={(id, name) =>
                      setProducts((current) =>
                        current.map((item) =>
                          item.id === id
                            ? { ...item, display_name: name }
                            : item
                        )
                      )
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 px-4 py-3 border-t border-surface-2">
              <button
                type="button"
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                disabled={safePage === 1}
                className="px-3 py-1.5 text-xs rounded-lg bg-surface-2 border border-surface-3 text-slate-400 hover:text-white disabled:opacity-40 transition-colors"
              >
                ← Anterior
              </button>

              <span className="text-xs text-slate-500">
                {safePage} / {totalPages}
              </span>

              <button
                type="button"
                onClick={() =>
                  setPage((current) => Math.min(totalPages, current + 1))
                }
                disabled={safePage === totalPages}
                className="px-3 py-1.5 text-xs rounded-lg bg-surface-2 border border-surface-3 text-slate-400 hover:text-white disabled:opacity-40 transition-colors"
              >
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
          onDone={() => {
            setKickoffProduct(null);
            load();
          }}
        />
      )}

      {acceleratorProduct && (
        <AcceleratorModal
          product={acceleratorProduct}
          account={account}
          onClose={() => setAcceleratorProduct(null)}
          onDone={() => {
            setAcceleratorProduct(null);
            load();
          }}
        />
      )}
    </div>
  );
}