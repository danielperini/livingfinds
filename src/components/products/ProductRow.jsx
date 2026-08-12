import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import {
  AlertCircle, Check, CheckSquare, ChevronDown, ChevronRight, ExternalLink,
  Loader2, Megaphone, Package, Pause, Pencil, Play, Square, X, XCircle,
  Wifi, WifiOff,
} from 'lucide-react';

// ── Helpers ──────────────────────────────────────────────────────────────────

const STOCK_FRESH_HOURS = 24;
const STOCK_WITH_CAMPAIGN_FRESH_HOURS = 24;

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

// ── CampaignDropdown ─────────────────────────────────────────────────────────

function CampaignDropdown({ product }) {
  const [open, setOpen] = useState(false);
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const toggle = async () => {
    if (!open && !loaded) {
      setLoading(true);
      try {
        const asin = product?.asin;
        const accountId = product?.amazon_account_id;
        if (asin && accountId) {
          const results = await base44.entities.Campaign.filter(
            { amazon_account_id: accountId, asin },
            null, 30
          ).catch(() => []);
          const seen = new Set();
          const unique = [];
          for (const c of results) {
            const cid = c.campaign_id || c.id;
            if (!seen.has(cid)) { seen.add(cid); unique.push(c); }
          }
          setCampaigns(unique.filter(c => String(c.state || c.status || '').toLowerCase() !== 'archived'));
        }
      } finally {
        setLoading(false);
        setLoaded(true);
      }
    }
    setOpen(v => !v);
  };

  const statusLabel = (c) => {
    const st = String(c.state || c.status || '').toLowerCase();
    if (st === 'enabled' || st === 'active') return 'Ativa';
    if (st === 'paused') return 'Pausada';
    if (st === 'incomplete') return 'Incompleta';
    return st || '—';
  };

  const statusColor = (c) => {
    const st = String(c.state || c.status || '').toLowerCase();
    if (st === 'enabled' || st === 'active') return 'text-[#15803D]';
    if (st === 'paused') return 'text-[#B45309]';
    return 'text-[#6B7280]';
  };

  return (
    <div className="mt-1">
      <button type="button" onClick={toggle}
        className="flex items-center gap-1 text-xs text-[#6B7280] hover:text-[#2563EB] transition-colors">
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        <Megaphone className="w-4 h-4" />
        Campanhas
        {loaded && campaigns.length > 0 && <span className="ml-0.5 text-[#2563EB] font-semibold">({campaigns.length})</span>}
      </button>
      {open && (
        <div className="mt-1.5 ml-1 border-l border-[#E5E7EB] pl-2.5 space-y-1.5">
          {loading && <p className="text-xs text-[#6B7280] animate-pulse">Carregando...</p>}
          {!loading && campaigns.length === 0 && (
            <p className="text-xs text-[#6B7280] italic">Nenhuma campanha ativa encontrada para este ASIN.</p>
          )}
          {!loading && campaigns.map((c, i) => {
            const name = c.campaign_name || c.name || `Campanha ${c.campaign_id || c.id || i}`;
            const id = c.campaign_id || c.id;
            const spend = Number(c.spend || 0);
            const acos = Number(c.acos || 0);
            return (
              <div key={id || i} className="text-xs leading-snug">
                <p className="text-[#0D1117] font-medium truncate max-w-[260px]" title={name}>{name}</p>
                <div className="flex items-center gap-2 text-[11px] mt-0.5 flex-wrap">
                  <span className={`font-semibold ${statusColor(c)}`}>{statusLabel(c)}</span>
                  {id && <span className="font-mono text-[#6B7280]">...{String(id).slice(-8)}</span>}
                  {spend > 0 && <span className="text-[#4B5563]">Spend: R${spend.toFixed(2)}</span>}
                  {acos > 0 && <span className="text-[#4B5563]">ACoS: {acos.toFixed(1)}%</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Badges ────────────────────────────────────────────────────────────────────

export function OfferStatusBadge({ product }) {
  const status = offerStatus(product);
  const freshness = stockFreshness(product);
  const fba = Number(product?.fba_inventory ?? 0);

  const staleTag = freshness === 'stale' && (
    <span className="block text-[11px] text-[#B45309] mt-1">Desatualizado</span>
  );

  if (freshness === 'unknown') {
    return (
      <div>
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold badge-neutral">
          <AlertCircle className="w-3.5 h-3.5" />Desconhecido
        </span>
      </div>
    );
  }
  if (status === 'out_of_stock') return (
    <div>
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold badge-danger">
        <XCircle className="w-3.5 h-3.5" />Sem estoque
      </span>
      {staleTag}
    </div>
  );
  if (status === 'low_stock') return (
    <div>
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold badge-warning">
        <AlertCircle className="w-3.5 h-3.5" />Baixo ({fba})
      </span>
      {staleTag}
    </div>
  );
  if (status === 'active') return (
    <div>
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold badge-success">
        Em estoque ({fba > 0 ? fba : '?'})
      </span>
      {staleTag}
    </div>
  );
  if (status === 'archived') return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold badge-neutral">Arquivada</span>;
  return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold badge-warning">Inativa</span>;
}

export function CampaignStatusCell({ product }) {
  const hasCampaign = productHasCampaign(product);
  const campStatus = String(product?.campaign_status || '').toLowerCase();

  if (!hasCampaign) return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold badge-neutral">
      Sem campanha
    </span>
  );

  if (campStatus === 'archived' || campStatus === 'encerrada') {
    return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold badge-neutral">Encerrada</span>;
  }
  if (campStatus === 'paused' || campStatus === 'pausada') {
    return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold badge-warning"><Pause className="w-3.5 h-3.5" />Pausada</span>;
  }
  if (campStatus === 'active' || campStatus === 'enabled') {
    return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold badge-success"><span className="w-1.5 h-1.5 rounded-full bg-[#15803D]" />Ativa</span>;
  }
  if (campStatus === 'incomplete') {
    return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold badge-danger"><AlertCircle className="w-3.5 h-3.5" />Incompleta</span>;
  }
  return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold badge-neutral">Indisponível</span>;
}

function PropagationBadge({ result, propagating }) {
  if (propagating) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-[#2563EB] animate-pulse">
        <Loader2 className="w-4 h-4 animate-spin" />
        Sincronizando...
      </span>
    );
  }
  if (!result) return null;
  if (result.type === 'success') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-[#15803D] animate-fade-in">
        <Wifi className="w-4 h-4" />
        Sincronizado na Amazon
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-[#991B1B] animate-fade-in" title={result.text}>
      <WifiOff className="w-4 h-4" />
      {result.text}
    </span>
  );
}

// ── Botão de ação contextual único ───────────────────────────────────────────

function ContextualAction({ product, onKickoff, onToggleCampaign, loading, onCancelKickoff, amazonPropagating, amazonResult }) {
  const [cancelling, setCancelling] = useState(false);

  const handleCancel = async () => {
    setCancelling(true);
    try { await onCancelKickoff?.(product); }
    finally { setCancelling(false); }
  };

  const isLoading = loading === product.id || amazonPropagating;
  const hasCampaign = productHasCampaign(product);
  const active = isCampaignActiveFn(product);
  const incomplete = isCampaignIncomplete(product);
  const outOfStock = isConfirmedOutOfStock(product);
  const pausedByStock = productPausedByStock(product);
  const kickoffPending = !hasCampaign && !incomplete &&
    (String(product?.queue_status || '').toLowerCase() === 'scheduled' ||
     String(product?.kickoff_status || '').toLowerCase() === 'scheduled' ||
     product?.kickoff_queued === true);

  const primaryBtn = 'inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold rounded-lg bg-[#2563EB] text-white hover:bg-[#1D4ED8] disabled:opacity-50 transition-colors whitespace-nowrap';
  const secondaryBtn = 'inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold rounded-lg bg-white border border-[#E5E7EB] text-[#0D1117] hover:bg-[#F8FAFC] disabled:opacity-50 transition-colors whitespace-nowrap';

  if (!hasCampaign || incomplete) {
    if (outOfStock && kickoffPending) {
      return (
        <div className="space-y-1">
          <span className="flex items-center gap-1 text-xs font-semibold text-[#B45309]">
            <Loader2 className="w-4 h-4 animate-pulse" />
            Aguardando estoque
          </span>
          <button type="button" onClick={handleCancel} disabled={cancelling}
            className="flex items-center gap-1 text-xs font-semibold text-[#991B1B] hover:underline disabled:opacity-50">
            {cancelling ? <Loader2 className="w-3 h-3 animate-spin" /> : <XCircle className="w-3 h-3" />}
            Cancelar
          </button>
        </div>
      );
    }
    if (outOfStock) {
      return (
        <span className="text-xs text-[#991B1B] italic max-w-[160px] leading-tight block">
          Sem estoque — Kick-off bloqueado.
        </span>
      );
    }
    return (
      <button type="button" onClick={() => onKickoff(product)} disabled={isLoading}
        title={incomplete ? 'Reparar campanha incompleta' : 'Vincular e ativar campanha para este produto'}
        className={primaryBtn}>
        {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
        {incomplete ? 'Reparar' : 'Kick-off'}
      </button>
    );
  }

  return (
    <div className="space-y-1">
      {pausedByStock && <p className="text-[11px] text-[#991B1B] italic">Pausado por estoque zero</p>}
      <button type="button" onClick={() => onToggleCampaign(product)} disabled={isLoading}
        title={active ? 'Pausar campanha' : 'Ativar campanha'}
        className={active ? secondaryBtn : primaryBtn}>
        {isLoading
          ? <Loader2 className="w-4 h-4 animate-spin" />
          : active ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
        {active ? 'Pausar' : 'Ativar'}
      </button>
      <PropagationBadge result={amazonResult} propagating={amazonPropagating} />
    </div>
  );
}

// ── ProductRow ────────────────────────────────────────────────────────────────

export default function ProductRow({ product, onToggleCampaign, onKickoff, onCancelKickoff, actionLoading, amazonPropagating, amazonResult, onNameUpdate, selected, onToggleSelect, isFocused, productMessage }) {
  const [editingName, setEditingName] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [savingName, setSavingName] = useState(false);

  const name = visibleName(product);
  const fallback = !product?.display_name?.trim() && !product?.product_name?.trim();
  const acos = Number(product?.acos || 0);
  const acosColor = acos > 50 ? 'text-[#991B1B]' : acos > 30 ? 'text-[#B45309]' : acos > 0 ? 'text-[#15803D]' : 'text-[#6B7280]';

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
      className={`border-b border-[#E5E7EB] hover:bg-[#F8FAFC] transition-colors ${selected ? 'bg-[#EFF6FF]' : 'bg-white'} ${isFocused ? 'ring-2 ring-inset ring-[#2563EB]/40' : ''}`}
    >
      <td className="px-3 py-3 w-10">
        <button type="button" onClick={() => onToggleSelect(product.id)}
          className={`p-0.5 rounded transition-colors ${selected ? 'text-[#2563EB]' : 'text-[#9CA3AF] hover:text-[#4B5563]'}`}>
          {selected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
        </button>
      </td>
      <td className="px-4 py-3 min-w-[320px] max-w-[460px]">
        <div className="flex items-start gap-3">
          {product?.product_image_url ? (
            <img src={product.product_image_url} alt={product.asin} className="w-11 h-11 rounded-lg object-cover bg-[#F1F5F9] border border-[#E5E7EB] flex-shrink-0 mt-0.5" />
          ) : (
            <div className="w-11 h-11 rounded-lg bg-[#F1F5F9] border border-[#E5E7EB] flex items-center justify-center flex-shrink-0 mt-0.5">
              <Package className="w-5 h-5 text-[#9CA3AF]" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            {editingName ? (
              <div className="flex items-center gap-1">
                <input autoFocus value={editValue} onChange={e => setEditValue(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditingName(false); }}
                  className="flex-1 min-w-0 text-sm px-2 py-1 bg-white border border-[#2563EB]/50 rounded text-[#0D1117] focus:outline-none" />
                <button type="button" onClick={saveEdit} disabled={savingName} className="p-1 text-[#15803D] hover:opacity-80">
                  {savingName ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                </button>
                <button type="button" onClick={() => setEditingName(false)} className="p-1 text-[#6B7280] hover:text-[#0D1117]">
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="flex items-start gap-1 group">
                <p className={`text-[15px] leading-snug font-medium line-clamp-2 ${fallback ? 'text-[#6B7280] italic' : 'text-[#0D1117]'}`} title={name}>
                  {name}
                </p>
                <button type="button" onClick={startEdit} className="flex-shrink-0 opacity-0 group-hover:opacity-100 p-0.5 text-[#9CA3AF] hover:text-[#2563EB] transition-opacity mt-0.5" title="Editar nome">
                  <Pencil className="w-2.5 h-2.5" />
                </button>
              </div>
            )}
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <span className="text-[13px] font-mono text-[#2563EB]">{product?.asin}</span>
              {product?.sku && <span className="text-[13px] text-[#6B7280] font-mono">SKU: {product.sku}</span>}
              {product?.asin && (
                <a href={`https://www.amazon.com.br/dp/${product.asin}`} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 text-xs text-[#6B7280] hover:text-[#2563EB] transition-colors">
                  <ExternalLink className="w-2.5 h-2.5" />Ver na Amazon
                </a>
              )}
            </div>
            <CampaignDropdown product={product} />
          </div>
        </div>
      </td>
      <td className="px-4 py-3"><OfferStatusBadge product={product} /></td>
      <td className="px-4 py-3"><CampaignStatusCell product={product} /></td>
      <td className="px-4 py-3">
        <span className={`text-lg font-semibold tabular-nums ${acosColor}`}>{formatPercent(acos)}</span>
      </td>
      <td className="px-4 py-3 pr-5">
        <ContextualAction product={product} onKickoff={onKickoff}
          onToggleCampaign={onToggleCampaign} onCancelKickoff={onCancelKickoff}
          loading={actionLoading} amazonPropagating={amazonPropagating} amazonResult={amazonResult} />
        {productMessage && (
          <p className={`text-xs mt-1 font-medium ${productMessage.type === 'success' ? 'text-[#15803D]' : productMessage.type === 'error' ? 'text-[#991B1B]' : 'text-[#B45309]'}`}>
            {productMessage.text}
          </p>
        )}
      </td>
    </tr>
  );
}