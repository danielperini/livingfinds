import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Rocket, Clock, CheckCircle2, XCircle, Pause, RefreshCw,
  Loader2, AlertTriangle, ChevronDown, ChevronUp, Package, Ban
} from 'lucide-react';

const STATUS_CONFIG = {
  scheduled: {
    label: 'Agendado',
    icon: Clock,
    color: 'text-cyan',
    bg: 'bg-cyan/10 border-cyan/25',
    dot: 'bg-cyan',
  },
  processing: {
    label: 'Em andamento',
    icon: Loader2,
    color: 'text-amber-400',
    bg: 'bg-amber-400/10 border-amber-400/25',
    dot: 'bg-amber-400',
    spin: true,
  },
  completed: {
    label: 'Concluído',
    icon: CheckCircle2,
    color: 'text-emerald-400',
    bg: 'bg-emerald-400/10 border-emerald-400/25',
    dot: 'bg-emerald-400',
  },
  failed: {
    label: 'Falhou',
    icon: XCircle,
    color: 'text-red-400',
    bg: 'bg-red-400/10 border-red-400/25',
    dot: 'bg-red-400',
  },
  cancelled: {
    label: 'Cancelado',
    icon: Ban,
    color: 'text-slate-400',
    bg: 'bg-slate-400/10 border-slate-400/25',
    dot: 'bg-slate-400',
  },
  awaiting_stock: {
    label: 'Aguardando Estoque',
    icon: Package,
    color: 'text-orange-400',
    bg: 'bg-orange-400/10 border-orange-400/25',
    dot: 'bg-orange-400',
  },
};

function StatusTab({ status, count, active, onClick }) {
  const cfg = STATUS_CONFIG[status];
  const Icon = cfg.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors whitespace-nowrap ${
        active
          ? `${cfg.bg} ${cfg.color}`
          : 'bg-surface-2 border-surface-3 text-slate-500 hover:text-slate-300'
      }`}
    >
      <Icon className={`w-3.5 h-3.5 ${cfg.spin && active ? 'animate-spin' : ''}`} />
      {cfg.label}
      <span className={`ml-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
        active ? 'bg-white/10' : 'bg-surface-3'
      }`}>{count}</span>
    </button>
  );
}

function KickoffRow({ item, onRetry, onCancel, stockMap }) {
  const rawStatus = String(item?.status || '').toLowerCase();
  // Detectar se o produto está sem estoque → tratar como awaiting_stock
  const outOfStock = stockMap && item.asin && (
    stockMap[item.asin]?.inventory_status === 'out_of_stock' ||
    (stockMap[item.asin]?.fba_inventory ?? 1) === 0
  );
  const status = (rawStatus === 'failed' && outOfStock) ? 'awaiting_stock' : rawStatus;
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.scheduled;
  const Icon = cfg.icon;

  const formatDate = (val) => {
    if (!val) return null;
    return new Date(val).toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  };

  // Formatar mensagem de erro de forma mais legível
  const formatError = (err) => {
    if (!err) return null;
    if (err.toLowerCase().includes('out_of_stock') || err.toLowerCase().includes('sem estoque') || err.toLowerCase().includes('inventory')) return 'Produto sem estoque';
    if (err.toLowerCase().includes('token') || err.toLowerCase().includes('401') || err.toLowerCase().includes('unauthorized')) return 'Erro de autenticação Amazon';
    if (err.toLowerCase().includes('rate') || err.toLowerCase().includes('429') || err.toLowerCase().includes('throttl')) return 'Limite de requisições Amazon (será reintentado)';
    if (err.toLowerCase().includes('timeout') || err.toLowerCase().includes('524')) return 'Timeout — será reintentado automaticamente';
    if (err === 'Falha no Kick-off') return 'Erro na criação da campanha (verifique logs)';
    return err;
  };

  return (
    <div className={`flex items-center gap-3 px-4 py-3 rounded-lg border ${cfg.bg}`}>
      <Icon className={`w-4 h-4 flex-shrink-0 ${cfg.color} ${cfg.spin ? 'animate-spin' : ''}`} />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-mono font-bold text-white">{item.asin}</span>
          {item.sku && <span className="text-[11px] text-slate-500 font-mono">SKU: {item.sku}</span>}
          <span className={`text-[11px] font-semibold ${cfg.color}`}>{cfg.label}</span>
          {item.mode && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-3 text-slate-500 border border-surface-3">
              {item.mode === 'auto_plus_four' ? 'AUTO + Manual' : 'Manual Exact'}
            </span>
          )}
          {item.keyword && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 border border-violet-500/20 text-violet-300 font-mono">
              {item.keyword}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 mt-1 flex-wrap">
          {item.queue_window && (
            <span className="text-[11px] text-slate-500">
              Janela: <span className="text-slate-300">{item.queue_window}</span>
            </span>
          )}
          {item.attempt_count > 0 && (
            <span className="text-[11px] text-slate-500">
              Tentativas: <span className="text-slate-300">{item.attempt_count}/{item.max_attempts || 5}</span>
            </span>
          )}
          {item.completed_at && (
            <span className="text-[11px] text-slate-500">
              Concluído: <span className="text-slate-300">{formatDate(item.completed_at)}</span>
            </span>
          )}
          {item.scheduled_at && rawStatus === 'scheduled' && (
            <span className="text-[11px] text-slate-500">
              Agendado: <span className="text-slate-300">{formatDate(item.scheduled_at)}</span>
            </span>
          )}
        </div>

        {(rawStatus === 'failed' || status === 'awaiting_stock') && (
          <p className={`mt-1 text-[11px] truncate max-w-[380px] ${status === 'awaiting_stock' ? 'text-orange-400/90' : 'text-red-400/90'}`}>
            {status === 'awaiting_stock'
              ? 'Produto sem estoque FBA — o Kick-off será reativado quando o estoque for reposto'
              : formatError(item.last_error)}
          </p>
        )}
      </div>

      <div className="flex-shrink-0 flex items-center gap-1.5">
        {rawStatus === 'failed' && status !== 'awaiting_stock' && onRetry && (
          <button
            type="button"
            onClick={() => onRetry(item)}
            className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg border bg-cyan/10 border-cyan/25 text-cyan hover:bg-cyan/20 transition-colors"
          >
            <RefreshCw className="w-3 h-3" />
            Reagendar
          </button>
        )}
        {(rawStatus === 'failed' || rawStatus === 'scheduled') && onCancel && (
          <button
            type="button"
            onClick={() => onCancel(item)}
            className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg border bg-red-500/10 border-red-500/25 text-red-400 hover:bg-red-500/20 transition-colors"
          >
            <Ban className="w-3 h-3" />
            Cancelar
          </button>
        )}
      </div>
    </div>
  );
}

export default function KickoffControlPanel({ accountId, onRetry }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('all');
  const [collapsed, setCollapsed] = useState(false);
  const [stockMap, setStockMap] = useState({});
  const [cancelling, setCancelling] = useState(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const records = await base44.entities.ProductKickoffQueue.filter(
        { amazon_account_id: accountId },
        '-created_date',
        300
      );
      // Deduplicar por ASIN+keyword — manual_only com keyword diferente são itens distintos
      const seen = new Set();
      const deduped = [];
      for (const r of records) {
        const asin = String(r.asin || '').trim().toUpperCase();
        if (!asin) continue;
        const key = r.mode === 'manual_only' && r.keyword
          ? `${asin}|${String(r.keyword).toLowerCase().trim()}`
          : asin;
        if (!seen.has(key)) { seen.add(key); deduped.push(r); }
      }
      setItems(deduped);

      // Carregar estoque dos ASINs únicos que falharam
      const failedAsins = [...new Set(deduped.filter(i => i.status === 'failed').map(i => i.asin).filter(Boolean))];
      if (failedAsins.length > 0) {
        const products = await base44.entities.Product.filter(
          { amazon_account_id: accountId, asin: { $in: failedAsins } },
          null, failedAsins.length + 5
        );
        const map = {};
        for (const p of products) { if (p.asin) map[p.asin] = p; }
        setStockMap(map);
      }
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  const handleCancel = useCallback(async (item) => {
    if (!item?.id || cancelling) return;
    setCancelling(item.id);
    try {
      await base44.entities.ProductKickoffQueue.update(item.id, { status: 'cancelled' });
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, status: 'cancelled' } : i));
    } finally {
      setCancelling(null);
    }
  }, [cancelling]);

  useEffect(() => { load(); }, [load]);

  // Recarregar quando um kickoff for enfileirado (produtos ou TermBank)
  useEffect(() => {
    const handler = () => setTimeout(load, 800);
    window.addEventListener('product-kickoff-queued', handler);
    window.addEventListener('term-campaign-queued', handler);
    return () => {
      window.removeEventListener('product-kickoff-queued', handler);
      window.removeEventListener('term-campaign-queued', handler);
    };
  }, [load]);

  // Contar "awaiting_stock" separado de "failed" para a aba
  const awaitingStockAsins = new Set(
    items.filter(i => i.status === 'failed' && stockMap[i.asin] && (stockMap[i.asin].inventory_status === 'out_of_stock' || (stockMap[i.asin].fba_inventory ?? 1) === 0)).map(i => i.asin)
  );

  const counts = {
    all: items.length,
    scheduled: items.filter(i => i.status === 'scheduled').length,
    processing: items.filter(i => i.status === 'processing').length,
    completed: items.filter(i => i.status === 'completed').length,
    failed: items.filter(i => i.status === 'failed' && !awaitingStockAsins.has(i.asin)).length,
    awaiting_stock: items.filter(i => i.status === 'failed' && awaitingStockAsins.has(i.asin)).length,
    cancelled: items.filter(i => i.status === 'cancelled').length,
  };

  const filtered = activeTab === 'all' ? items : items.filter(i => i.status === activeTab);

  // Ordenar: failed (sem estoque) > failed > processing > scheduled > completed > cancelled
  const ORDER = { failed: 0, processing: 1, scheduled: 2, completed: 3, cancelled: 4, awaiting_stock: 0 };
  const sorted = [...filtered].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9));

  if (!accountId) return null;

  const hasActive = counts.scheduled + counts.processing + counts.failed > 0;

  return (
    <div className="mx-6 rounded-xl border border-violet-500/20 bg-[#0f0d1a] overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center justify-between px-5 py-3.5 cursor-pointer select-none"
        onClick={() => setCollapsed(v => !v)}
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-violet-500/20 border border-violet-500/30 flex items-center justify-center">
            <Rocket className="w-4 h-4 text-violet-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold text-white">Painel de Kick-off</p>
              {hasActive && (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-400/15 border border-amber-400/25 text-amber-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                  {counts.scheduled + counts.processing} em processo
                </span>
              )}
              {counts.failed > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-400/15 border border-red-400/25 text-red-400">
                  <AlertTriangle className="w-2.5 h-2.5" />
                  {counts.failed} falha{counts.failed > 1 ? 's' : ''}
                </span>
              )}
              {counts.awaiting_stock > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-orange-400/15 border border-orange-400/25 text-orange-400">
                  <Package className="w-2.5 h-2.5" />
                  {counts.awaiting_stock} sem estoque
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {counts.all} ASINs · {counts.completed} concluídos · {counts.cancelled} pausados
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); load(); }}
            className="p-1.5 rounded-lg hover:bg-surface-2 text-slate-500 hover:text-slate-300 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {collapsed ? <ChevronDown className="w-4 h-4 text-slate-500" /> : <ChevronUp className="w-4 h-4 text-slate-500" />}
        </div>
      </div>

      {!collapsed && (
        <>
          {/* Tabs */}
          <div className="flex items-center gap-1.5 px-5 pb-3 flex-wrap border-t border-violet-500/10 pt-3">
            <button
              type="button"
              onClick={() => setActiveTab('all')}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                activeTab === 'all'
                  ? 'bg-violet-500/15 border-violet-500/30 text-violet-400'
                  : 'bg-surface-2 border-surface-3 text-slate-500 hover:text-slate-300'
              }`}
            >
              Todos
              <span className={`ml-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${activeTab === 'all' ? 'bg-white/10' : 'bg-surface-3'}`}>
                {counts.all}
              </span>
            </button>

            {['scheduled', 'processing', 'failed', 'awaiting_stock', 'completed', 'cancelled'].map(s =>
              counts[s] > 0 ? (
                <StatusTab
                  key={s}
                  status={s}
                  count={counts[s]}
                  active={activeTab === s}
                  onClick={() => setActiveTab(s)}
                />
              ) : null
            )}
          </div>

          {/* List */}
          <div className="px-5 pb-4 space-y-2 max-h-80 overflow-y-auto scrollbar-thin">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 text-violet-400 animate-spin" />
              </div>
            ) : sorted.length === 0 ? (
              <div className="text-center py-8 text-sm text-slate-500">
                {counts.all === 0 ? 'Nenhum Kick-off registrado ainda.' : 'Nenhum item neste filtro.'}
              </div>
            ) : (
              sorted.map(item => (
                <KickoffRow
                  key={item.id || `${item.asin}-${item.keyword}`}
                  item={item}
                  onRetry={onRetry}
                  onCancel={handleCancel}
                  stockMap={stockMap}
                />
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}