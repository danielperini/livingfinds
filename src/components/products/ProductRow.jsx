import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import {
  AlertCircle, Check, CheckSquare, ExternalLink, Loader2, Package,
  Pause, Pencil, Play, Rocket, ShoppingBag, Square, Tag, X, XCircle, Zap,
} from 'lucide-react';

// ── Helpers ──────────────────────────────────────────────────────────────────

const STOCK_FRESH_HOURS = 24;
const STOCK_WITH_CAMPAIGN_FRESH_HOURS = 6;

export function isCampaignActiveFn(product) {
  return ['active', 'enabled'].includes(String(product?.campaign_status || '').toLowerCase());
}

export function stockFreshness(product) {
  const syncAt = product?.last_sync_at || product?.last_catalog_sync_at || product?.synced_at || product?.updated_date || null;
  if (!syncAt) return 'unknown';
  const ageHours = (Date.now() - new Date(syncAt).getTime()) / 3600000;
  const limit = isCampaignActiveFn(product) ? STOCK_WITH_CAMPAIGN_FRESH_HOURS : STOCK_FRESH_HOURS;
  return ageHours <= limit ? 'fresh' : 'stale';
}

export function offerStatus(product) {
  const status = String(product?.status || 'active').toLowerCase();
  if (status === 'archived') return 'archived';
  if (status === 'inactive') return 'inactive';
  const inv = String(product?.inventory_status || '').toLowerCase();
  if (inv === 'out_of_stock') return 'out_of_stock';
  if (inv === 'low_stock') return 'low_stock';
  return 'active';
}

export function isConfirmedOutOfStock(product) {
  const inv = String(product?.inventory_status || '').toLowerCase();
  const fba = Number(product?.fba_inventory ?? -1);
  const fresh = stockFreshness(product) === 'fresh';
  return inv === 'out_of_stock' && fba === 0 && fresh;
}

export function productHasCampaign(product) {
  return Boolean(
    product?.linked_campaign_id || product?.campaign_id || product?.amazon_campaign_id ||
    product?.has_campaign ||
    ['active', 'enabled', 'paused', 'incomplete'].includes(String(product?.campaign_status || '').toLowerCase())
  );
}

export function isCampaignIncomplete(product) {
  return String(product?.campaign_status || '').toLowerCase() === 'incomplete';
}

export function campaignIdOf(product) {
  return product?.linked_campaign_id || product?.campaign_id || product?.amazon_campaign_id || null;
}

function productPausedByStock(product) {
  return product?.pause_reason === 'out_of_stock_confirmed' ||
    String(product?.pause_reason || '').includes('estoque zerado');
}

export function formatBRL(value) {
  return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatPercent(value) {
  return `${Number(value || 0).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

function visibleName(product) {
  if (product?.display_name?.trim()) return product.display_name.trim();
  if (product?.product_name?.trim()) return product.product_name.trim();
  return `Produto ${product?.asin || ''}`.trim();
}

// ── Sub-components ────────────────────────────────────────────────────────────

export function OfferStatusBadge({ product }) {
  const status = offerStatus(product);
  const freshness = stockFreshness(product);
  const fba = Number(product?.fba_inventory ?? 0);
  const syncAt = product?.last_sync_at || product?.last_catalog_sync_at || product?.synced_at || product?.updated_date;
  const syncLabel = syncAt
    ? new Date(syncAt).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : null;

  const staleTag = freshness === 'stale' && (
    <span className="block text-[9px] text-amber-400/70 mt-0.5">Desatualizado</span>
  );
  const dateTag = syncLabel && (
    <span className="block text-[9px] text-slate-600 mt-0.5">{syncLabel}</span>
  );

  if (freshness === 'unknown') {
    return (
      <div>
        <span className="flex items-center gap-1 text-xs text-slate-500 font-semibold">
          <AlertCircle className="w-3.5 h-3.5" />Desconhecido
        </span>
        <span className="block text-[9px] text-slate-600 mt-0.5">Sem dado de estoque</span>
      </div>
    );
  }
  if (status === 'out_of_stock') return (
    <div>
      <span className="flex items-center gap-1 text-xs text-red-400 font-semibold"><XCircle className="w-3.5 h-3.5" />Sem Estoque</span>
      {staleTag}{dateTag}
    </div>
  );
  if (status === 'low_stock') return (
    <div>
      <span className="flex items-center gap-1 text-xs text-amber-400 font-semibold">
        <AlertCircle className="w-3.5 h-3.5" />Estoque Baixo ({fba})
        {freshness === 'stale' && (
          <span className="ml-1 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-400/20 text-amber-300 border border-amber-400/30 leading-none">
            desatualizado
          </span>
        )}
      </span>
      {dateTag}
    </div>
  );
  if (status === 'active') return (
    <div>
      <span className="flex items-center gap-1 text-xs text-emerald-400 font-semibold">
        <ShoppingBag className="w-3.5 h-3.5" />Em Estoque ({fba > 0 ? fba : '?'})
        {freshness === 'stale' && (
          <span className="ml-1 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-400/20 text-amber-300 border border-amber-400/30 leading-none">
            desatualizado
          </span>
        )}
      </span>
      {dateTag}
    </div>
  );
  if (status === 'archived') return <span className="flex items-center gap-1 text-xs text-slate-500"><XCircle className="w-3.5 h-3.5" />Arquivada</span>;
  return <span className="flex items-center gap-1 text-xs text-amber-400"><AlertCircle className="w-3.5 h-3.5" />Inativa</span>;
}

export function CampaignStatusCell({ product }) {
  const hasCampaign = productHasCampaign(product);
  const campaignId = campaignIdOf(product);
  const campStatus = String(product?.campaign_status || '').toLowerCase();

  if (!hasCampaign) return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-500/10 text-slate-500 border border-slate-500/15">
      <XCircle className="w-3 h-3" />Sem campanha
    </span>
  );

  let badge;
  if (campStatus === 'archived' || campStatus === 'encerrada') {
    badge = <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-500/15 text-slate-400 border border-slate-500/20">Encerrada</span>;
  } else if (campStatus === 'paused' || campStatus === 'pausada') {
    badge = <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/20"><Pause className="w-3 h-3" />Pausada</span>;
  } else if (campStatus === 'active' || campStatus === 'enabled') {
    badge = <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />Ativa</span>;
  } else if (campStatus === 'incomplete') {
    badge = <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-500/15 text-red-400 border border-red-500/20"><AlertCircle className="w-3 h-3" />Incompleta</span>;
  } else {
    badge = <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-500/10 text-slate-500 border border-slate-500/15">Indisponível</span>;
  }
  return (
    <div className="space-y-1">
      {badge}
      {campaignId && <p className="text-[10px] text-slate-600 font-mono truncate max-w-[110px]">...{String(campaignId).slice(-8)}</p>}
    </div>
  );
}

function ActionButtons({ product, onKickoff, onAccelerator, onToggleCampaign, onArchiveCampaign, loading }) {
  const [pauseResult, setPauseResult] = useState(null); // 'success' | 'warning' | 'error'

  const handleToggle = async (p) => {
    setPauseResult(null);
    try {
      await onToggleCampaign(p);
      // Após retorno da função pai, verificar campaign_status para inferir resultado
      setPauseResult('success');
    } catch {
      setPauseResult('error');
    }
    setTimeout(() => setPauseResult(null), 4000);
  };

  const isLoading = loading === product.id;
  const hasCampaign = productHasCampaign(product);
  const active = isCampaignActiveFn(product);
  const incomplete = isCampaignIncomplete(product);
  const outOfStock = isConfirmedOutOfStock(product);
  const pausedByStock = productPausedByStock(product);

  if (!hasCampaign || incomplete) {
    if (outOfStock) {
      return (
        <span className="text-[10px] text-red-400/80 italic max-w-[160px] leading-tight">
          Sem estoque — Kick-off bloqueado até reposição.
        </span>
      );
    }
    return (
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={() => onKickoff(product)} disabled={isLoading}
          title={incomplete ? "Reparar campanha incompleta" : "Vincular e ativar campanha para este produto"}
          className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg border transition-all disabled:opacity-50 whitespace-nowrap ${incomplete ? 'bg-red-500/15 border-red-500/30 text-red-400 hover:bg-red-500/25' : 'bg-cyan/15 border-cyan/30 text-cyan hover:bg-cyan/25'}`}>
          {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
          {incomplete ? 'Reparar' : 'Vincular e Ativar'}
        </button>
        <button type="button" onClick={() => onAccelerator(product)} disabled={isLoading}
          className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg border transition-all disabled:opacity-50 bg-emerald-500/15 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25 whitespace-nowrap">
          {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
          Acelerar
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {pausedByStock && <p className="text-[9px] text-red-400/80 italic">Pausado por estoque zero</p>}
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={() => handleToggle(product)} disabled={isLoading}
          title={active ? 'Pausar campanha' : 'Ativar campanha'}
          className={`flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all disabled:opacity-50 whitespace-nowrap ${
            pauseResult === 'success' ? 'bg-emerald-500/25 border-emerald-500/40 text-emerald-300' :
            pauseResult === 'error'   ? 'bg-red-500/20 border-red-500/30 text-red-400' :
            active ? 'bg-amber-500/20 border-amber-500/30 text-amber-400 hover:bg-amber-500/30' :
                     'bg-emerald-500/20 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/30'
          }`}>
          {isLoading
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : pauseResult === 'success' ? <Check className="w-3 h-3" />
            : pauseResult === 'error'   ? <AlertCircle className="w-3 h-3" />
            : active ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />
          }
          {pauseResult === 'success' ? 'Pausada!' : pauseResult === 'error' ? 'Erro' : active ? 'Pausar' : 'Ativar'}
        </button>
        <button type="button" onClick={() => onArchiveCampaign(product)} disabled={isLoading}
          className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg border transition-all disabled:opacity-50 whitespace-nowrap bg-red-500/10 border-red-500/20 text-red-400 hover:bg-red-500/20">
          {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <XCircle className="w-3 h-3" />}
          Arquivar
        </button>
      </div>
    </div>
  );
}

// ── ProductRow ────────────────────────────────────────────────────────────────

export default function ProductRow({ product, onToggleCampaign, onArchiveCampaign, onKickoff, onAccelerator, actionLoading, onNameUpdate, selected, onToggleSelect, isFocused, productMessage }) {
  const [editingName, setEditingName] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [savingName, setSavingName] = useState(false);

  const name = visibleName(product);
  const fallback = !product?.display_name?.trim() && !product?.product_name?.trim();
  const acos = Number(product?.acos || 0);
  const acosColor = acos > 50 ? 'text-red-400' : acos > 30 ? 'text-amber-400' : acos > 0 ? 'text-emerald-400' : 'text-slate-500';

  const startEdit = () => { setEditValue(product?.display_name || product?.product_name || ''); setEditingName(true); };
  const saveEdit = async () => {
    if (!editValue.trim()) return;
    setSavingName(true);
    try {
      await base44.entities.Product.update(product.id, { display_name: editValue.trim() });
      onNameUpdate?.(product.id, editValue.trim());
      setEditingName(false);
    } finally { setSavingName(false); }
  };

  return (
    <tr
      data-product-id={product.id}
      className={`border-b border-surface-2/40 hover:bg-surface-2/30 transition-colors ${selected ? 'bg-cyan/5' : ''} ${isFocused ? 'ring-2 ring-inset ring-cyan/40' : ''}`}
    >
      <td className="px-3 py-3 w-10">
        <button type="button" onClick={() => onToggleSelect(product.id)}
          className={`p-0.5 rounded transition-colors ${selected ? 'text-cyan' : 'text-slate-600 hover:text-slate-400'}`}>
          {selected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
        </button>
      </td>
      <td className="px-4 py-3 min-w-[320px] max-w-[420px]">
        <div className="flex items-start gap-3">
          {product?.product_image_url ? (
            <img src={product.product_image_url} alt={product.asin} className="w-12 h-12 rounded-lg object-cover bg-surface-3 flex-shrink-0 mt-0.5" />
          ) : (
            <div className="w-12 h-12 rounded-lg bg-surface-3 flex items-center justify-center flex-shrink-0 mt-0.5">
              <Package className="w-5 h-5 text-slate-600" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            {editingName ? (
              <div className="flex items-center gap-1">
                <input autoFocus value={editValue} onChange={e => setEditValue(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditingName(false); }}
                  className="flex-1 min-w-0 text-xs px-2 py-1 bg-surface-3 border border-cyan/40 rounded text-white focus:outline-none" />
                <button type="button" onClick={saveEdit} disabled={savingName} className="p-1 text-emerald-400 hover:text-emerald-300">
                  {savingName ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                </button>
                <button type="button" onClick={() => setEditingName(false)} className="p-1 text-slate-500 hover:text-slate-300">
                  <X className="w-3 h-3" />
                </button>
              </div>
            ) : (
              <div className="flex items-start gap-1 group">
                <p className={`text-xs leading-snug font-medium line-clamp-2 ${fallback ? 'text-slate-500 italic' : 'text-slate-100'}`} title={name}>
                  {name}
                  {product?.display_name?.trim() && <span className="ml-1 text-cyan/60 text-[10px]">(editado)</span>}
                </p>
                <button type="button" onClick={startEdit} className="flex-shrink-0 opacity-0 group-hover:opacity-100 p-0.5 text-slate-500 hover:text-cyan transition-opacity mt-0.5" title="Editar nome">
                  <Pencil className="w-2.5 h-2.5" />
                </button>
              </div>
            )}
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <span className="text-xs font-mono text-cyan">{product?.asin}</span>
              {product?.sku && <span className="text-xs text-slate-500 font-mono">SKU: {product.sku}</span>}
            </div>
            {product?.asin && (
              <a href={`https://www.amazon.com.br/dp/${product.asin}`} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 text-[10px] text-slate-600 hover:text-cyan mt-0.5 transition-colors">
                <ExternalLink className="w-2.5 h-2.5" />Ver na Amazon
              </a>
            )}
          </div>
        </div>
      </td>
      <td className="px-4 py-3"><OfferStatusBadge product={product} /></td>
      <td className="px-4 py-3"><CampaignStatusCell product={product} /></td>
      <td className="px-4 py-3 text-xs text-emerald-400 font-semibold">{formatBRL(product?.total_sales_30d || product?.total_revenue_30d || 0)}</td>
      <td className="px-4 py-3 text-xs text-slate-400">{formatBRL(product?.total_spend_30d || 0)}</td>
      <td className="px-4 py-3 text-xs"><span className={acosColor}>{formatPercent(acos)}</span></td>
      <td className="px-4 py-3 text-xs text-slate-400">{Number(product?.units_sold_30d || product?.total_units_30d || 0).toLocaleString('pt-BR')}</td>
      <td className="px-4 py-3 pr-5">
        <ActionButtons product={product} onKickoff={onKickoff} onAccelerator={onAccelerator}
          onToggleCampaign={onToggleCampaign} onArchiveCampaign={onArchiveCampaign} loading={actionLoading} />
        {productMessage && (
          <p className={`text-[10px] mt-1 font-medium ${productMessage.type === 'success' ? 'text-emerald-400' : productMessage.type === 'error' ? 'text-red-400' : 'text-amber-400'}`}>
            {productMessage.text}
          </p>
        )}
      </td>
    </tr>
  );
}