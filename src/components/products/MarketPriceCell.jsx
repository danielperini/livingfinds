import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Loader2, RefreshCw, TrendingUp, AlertCircle, Info, ShieldAlert } from 'lucide-react';
import { Link } from 'react-router-dom';

function fmtBRL(v) {
  if (v == null || isNaN(Number(v))) return null;
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now - d;
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 0) return 'hoje';
  if (diffDays === 1) return 'ontem';
  if (diffDays < 7) return `há ${diffDays} dias`;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

/**
 * MarketPriceCell
 * Props:
 *   product        — objeto Product completo
 *   accountId      — amazon_account_id da conta
 *   onPriceUpdated — callback(productId, patch) para atualizar estado local
 */
export default function MarketPriceCell({ product, accountId, onPriceUpdated }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // product.amazon_account_id always takes priority (multi-account support)
  const effectiveAccountId = product?.amazon_account_id || accountId;

  const status = product?.market_price_status || 'not_checked';
  const avg = product?.market_price_average;
  const min = product?.market_price_minimum;
  const max = product?.market_price_maximum;
  const offerCount = product?.market_price_offer_count;
  const source = product?.market_price_source;
  const lastChecked = product?.market_price_last_checked_at;
  const priceError = product?.market_price_error;

  const isAuthError = (data, e) => {
    const msg = (data?.error || data?.message || e?.message || '').toLowerCase();
    const code = String(data?.http_status || data?.status_code || '');
    return code === '401' || msg.includes('401') || msg.includes('unauthorized') || msg.includes('auth_error') || msg.includes('invalid_client') || msg.includes('access denied');
  };

  const handleConsult = async () => {
    if (loading || !effectiveAccountId || !product?.id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await base44.functions.invoke('refreshProductMarketPrice', {
        amazon_account_id: effectiveAccountId,
        product_id: product.id,
        force: true,
      });
      const data = res?.data || res;
      if (data?.ok || data?.status === 'success' || data?.status === 'no_offers') {
        onPriceUpdated?.(product.id, {
          market_price_status: data.status || 'success',
          market_price_average: data.average,
          market_price_minimum: data.minimum,
          market_price_maximum: data.maximum,
          market_price_offer_count: data.offer_count,
          market_price_source: data.provider?.toLowerCase() || source,
          market_price_last_checked_at: data.checked_at || new Date().toISOString(),
          market_price_error: null,
        });
      } else if (isAuthError(data, null)) {
        setError('auth_error');
      } else {
        setError(data?.error || data?.message || 'Erro ao consultar preço');
      }
    } catch (e) {
      if (isAuthError(null, e)) {
        setError('auth_error');
      } else {
        setError(e?.message || 'Falha na consulta');
      }
    } finally {
      setLoading(false);
    }
  };

  // ── Estado: PROCESSING / QUEUED ──────────────────────────────────────────
  if (loading || status === 'processing' || status === 'queued') {
    return (
      <div className="flex items-center gap-1.5 text-cyan">
        <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
        <span className="text-[11px]">Consultando…</span>
      </div>
    );
  }

  // ── Estado: SUCCESS ──────────────────────────────────────────────────────
  if (status === 'success' && avg != null) {
    const sourceLabel = source === 'sp_api' ? 'Amazon SP-API' : source === 'zinc' ? 'Zinc' : source || '—';
    return (
      <div className="space-y-1 min-w-[140px]">
        {/* Preço médio em destaque */}
        <div className="text-center">
          <p className="text-base font-bold text-white leading-tight">{fmtBRL(avg)}</p>
          <p className="text-[9px] text-slate-500 uppercase tracking-wide">Preço médio</p>
        </div>
        {/* Min / Max */}
        {(min != null || max != null) && (
          <div className="flex items-center justify-between gap-1">
            {min != null && <span className="text-[10px] text-emerald-400">Mín. {fmtBRL(min)}</span>}
            {max != null && <span className="text-[10px] text-red-400">Máx. {fmtBRL(max)}</span>}
          </div>
        )}
        {/* Meta info + botão atualizar */}
        <div className="flex items-center justify-between gap-1">
          <span className="text-[9px] text-slate-600 leading-tight">
            {offerCount != null && `${offerCount} oferta${offerCount !== 1 ? 's' : ''} · `}{sourceLabel}
            {lastChecked && ` · ${fmtDate(lastChecked)}`}
          </span>
          <button
            type="button"
            onClick={handleConsult}
            title="Atualizar preço de mercado"
            className="p-0.5 text-slate-600 hover:text-cyan transition-colors flex-shrink-0"
          >
            <RefreshCw className="w-3 h-3" />
          </button>
        </div>
        {error && <p className="text-[9px] text-red-400">{error}</p>}
      </div>
    );
  }

  // ── Estado: NO_OFFERS ────────────────────────────────────────────────────
  if (status === 'no_offers') {
    return (
      <div className="space-y-1">
        <p className="text-[11px] text-slate-500 italic">Nenhuma oferta válida</p>
        <p className="text-[9px] text-slate-600">{lastChecked && fmtDate(lastChecked)}</p>
        <button
          type="button"
          onClick={handleConsult}
          className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-cyan transition-colors"
        >
          <RefreshCw className="w-2.5 h-2.5" />Tentar novamente
        </button>
        {error && <p className="text-[9px] text-red-400">{error}</p>}
      </div>
    );
  }

  // ── Estado: UNSUPPORTED_MARKETPLACE ─────────────────────────────────────
  if (status === 'unsupported_marketplace') {
    return (
      <div className="space-y-1">
        <p className="text-[10px] text-amber-400">Indisponível</p>
        <p className="text-[9px] text-slate-500">Marketplace não suportado</p>
      </div>
    );
  }

  // ── Estado: FAILED ───────────────────────────────────────────────────────
  if (status === 'failed' || status === 'rate_limited' || status === 'credit_limit_reached') {
    const statusLabel = status === 'rate_limited' ? 'Limite de requisições' : status === 'credit_limit_reached' ? 'Créditos esgotados' : 'Falha ao consultar';
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-1">
          <AlertCircle className="w-3 h-3 text-red-400 flex-shrink-0" />
          <p className="text-[10px] text-red-400">{statusLabel}</p>
        </div>
        {priceError && (
          <p className="text-[9px] text-slate-600 line-clamp-2 max-w-[160px]" title={priceError}>{priceError}</p>
        )}
        {status === 'failed' && (
          <button type="button" onClick={handleConsult}
            className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-cyan transition-colors">
            <RefreshCw className="w-2.5 h-2.5" />Tentar novamente
          </button>
        )}
        {error && <p className="text-[9px] text-red-400">{error}</p>}
      </div>
    );
  }

  // ── Banner de erro de autenticação SP-API ────────────────────────────────
  if (error === 'auth_error') {
    return (
      <div className="space-y-1.5 min-w-[180px]">
        <div className="flex items-start gap-1.5 p-2 rounded-lg bg-amber-500/10 border border-amber-500/30">
          <ShieldAlert className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-[10px] font-semibold text-amber-300 leading-tight">Falha de autenticação SP-API (401)</p>
            <p className="text-[9px] text-amber-400/80 mt-0.5 leading-tight">Verifique: <span className="font-mono">SP_REFRESH_TOKEN</span>, <span className="font-mono">SP_CLIENT_ID</span>, <span className="font-mono">SP_CLIENT_SECRET</span></p>
            <Link to="/settings" className="inline-flex items-center gap-0.5 text-[9px] text-cyan hover:text-cyan/80 mt-1 underline underline-offset-2">
              Ir para Configurações →
            </Link>
          </div>
        </div>
        <button type="button" onClick={() => setError(null)}
          className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-cyan transition-colors">
          <RefreshCw className="w-2.5 h-2.5" />Tentar novamente
        </button>
      </div>
    );
  }

  // ── Estado padrão: NOT_CHECKED ───────────────────────────────────────────
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] text-slate-500">Não consultado</p>
      <button
        type="button"
        onClick={handleConsult}
        disabled={loading}
        className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-semibold rounded-lg border border-cyan/30 bg-cyan/10 text-cyan hover:bg-cyan/20 disabled:opacity-50 transition-colors whitespace-nowrap"
      >
        {loading ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <TrendingUp className="w-2.5 h-2.5" />}
        Consultar preço
      </button>
      {error && <p className="text-[9px] text-red-400">{error}</p>}
    </div>
  );
}
