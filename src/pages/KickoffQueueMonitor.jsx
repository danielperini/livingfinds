import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { RefreshCw, Loader2, AlertTriangle, Package, RotateCcw, Ban, CheckCircle2, Megaphone } from 'lucide-react';

// Classifica o motivo do travamento
function diagnose(item, product) {
  const err = item.last_error || '';
  const attempts = item.attempt_count || 0;
  const maxAttempts = item.max_attempts || 5;

  // Sem estoque
  const stock = product?.fba_inventory || 0;
  const outOfStock = stock === 0 || product?.inventory_status === 'out_of_stock';
  if (outOfStock) {
    return {
      type: 'no_stock',
      label: 'Sem estoque',
      hint: 'Aguardando reposição. Kick-off desabilitado até ter estoque.',
      color: 'amber',
      canRetry: false,
    };
  }

  // Excedeu tentativas
  if (attempts >= maxAttempts) {
    // Erro de anúncio / token
    if (err.includes('403') || err.includes('Forbidden') || err.includes('token') || err.includes('Unauthorized')) {
      return {
        type: 'auth_error',
        label: 'Token inválido',
        hint: 'Token Amazon Ads expirado. Reautorize em Integrações → Amazon.',
        color: 'red',
        canRetry: false,
      };
    }
    if (err.includes('campaign') || err.includes('adGroup') || err.includes('keyword') || err.includes('ad group')) {
      return {
        type: 'campaign_error',
        label: 'Erro de anúncio',
        hint: 'Falha ao criar campanha/ad group na Amazon. Reiniciar pode resolver.',
        color: 'orange',
        canRetry: true,
      };
    }
    if (err.includes('429') || err.includes('rate') || err.includes('throttl')) {
      return {
        type: 'rate_limit',
        label: 'Rate limit',
        hint: 'Amazon rejeitou por excesso de requisições. Reiniciar tentará novamente.',
        color: 'orange',
        canRetry: true,
      };
    }
    return {
      type: 'max_attempts',
      label: `Máx. tentativas (${attempts}/${maxAttempts})`,
      hint: err || 'Esgotou o limite de tentativas sem sucesso.',
      color: 'red',
      canRetry: true,
    };
  }

  // Travado em processing há muito tempo
  if (item.status === 'processing' && item.started_at) {
    const minutesStuck = (Date.now() - new Date(item.started_at).getTime()) / 60000;
    if (minutesStuck > 30) {
      return {
        type: 'stuck',
        label: `Travado há ${Math.round(minutesStuck)}min`,
        hint: 'Processo parou sem resposta. Reiniciar vai reagendar.',
        color: 'amber',
        canRetry: true,
      };
    }
  }

  return null;
}

const COLOR = {
  red:    { badge: 'bg-red-500/10 border-red-500/25 text-red-300',    icon: 'text-red-400' },
  amber:  { badge: 'bg-amber-500/10 border-amber-500/25 text-amber-300', icon: 'text-amber-400' },
  orange: { badge: 'bg-orange-500/10 border-orange-500/25 text-orange-300', icon: 'text-orange-400' },
};

function StuckRow({ item, product, onRestart, restarting, onDisable }) {
  const diag = diagnose(item, product);
  if (!diag) return null;

  const c = COLOR[diag.color] || COLOR.red;
  const name = product?.product_name || product?.display_name || item.product_name || item.asin;
  const stock = product?.fba_inventory ?? '—';

  return (
    <div className="flex items-start gap-4 px-5 py-4 border-b border-surface-2/50 last:border-0">
      {/* ASIN + nome */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-xs font-bold text-cyan">{item.asin}</span>
          {item.sku && <span className="text-[10px] text-slate-500">{item.sku}</span>}
        </div>
        <p className="text-xs text-slate-300 mt-0.5 truncate max-w-xs">{name}</p>
        <div className="flex items-center gap-3 mt-1.5 flex-wrap">
          {/* Badge diagnóstico */}
          <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg border text-[10px] font-semibold ${c.badge}`}>
            {diag.type === 'no_stock' && <Package className={`w-3 h-3 ${c.icon}`} />}
            {diag.type === 'auth_error' && <Ban className={`w-3 h-3 ${c.icon}`} />}
            {(diag.type === 'campaign_error' || diag.type === 'rate_limit') && <Megaphone className={`w-3 h-3 ${c.icon}`} />}
            {(diag.type === 'max_attempts' || diag.type === 'stuck') && <AlertTriangle className={`w-3 h-3 ${c.icon}`} />}
            {diag.label}
          </span>
          {/* Estoque */}
          <span className={`text-[10px] ${diag.type === 'no_stock' ? 'text-amber-400 font-semibold' : 'text-slate-500'}`}>
            Estoque: {stock} un
          </span>
          {/* Tentativas */}
          <span className="text-[10px] text-slate-500">
            {item.attempt_count || 0}/{item.max_attempts || 5} tentativas
          </span>
          {/* Agendado em */}
          {item.scheduled_at && (
            <span className="text-[10px] text-slate-600">
              {new Date(item.scheduled_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
        {/* Hint */}
        <p className="text-[10px] text-slate-500 mt-1">{diag.hint}</p>
        {/* Erro bruto (compacto) */}
        {item.last_error && diag.type !== 'no_stock' && (
          <p className="text-[10px] font-mono text-red-400/50 mt-0.5 truncate max-w-sm">{item.last_error.slice(0, 120)}</p>
        )}
      </div>

      {/* Ações */}
      <div className="flex flex-col gap-2 flex-shrink-0 items-end">
        {diag.canRetry && (
          <button
            onClick={() => onRestart(item)}
            disabled={restarting === item.id}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-cyan/10 border border-cyan/25 text-cyan hover:bg-cyan/20 rounded-lg transition-colors disabled:opacity-40 font-semibold whitespace-nowrap"
          >
            {restarting === item.id
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <RotateCcw className="w-3.5 h-3.5" />}
            Reiniciar
          </button>
        )}
        {diag.type === 'no_stock' && (
          <button
            onClick={() => onDisable(item)}
            disabled={restarting === item.id}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-amber-500/10 border border-amber-500/25 text-amber-300 hover:bg-amber-500/20 rounded-lg transition-colors disabled:opacity-40 font-semibold whitespace-nowrap"
          >
            {restarting === item.id
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <Ban className="w-3.5 h-3.5" />}
            Desativar kick-off
          </button>
        )}
      </div>
    </div>
  );
}

export default function KickoffQueueMonitor() {
  const [account, setAccount] = useState(null);
  const [items, setItems] = useState([]);
  const [productMap, setProductMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [restarting, setRestarting] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      const accs = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accs[0];
      if (!acc) return;
      setAccount(acc);

      // Buscar itens da fila que não estão concluídos/cancelados
      const queue = await base44.entities.ProductKickoffQueue.filter(
        { amazon_account_id: acc.id }, '-scheduled_at', 200
      );

      // Filtrar: travados = failed, processing há muito tempo, ou scheduled expirado (> 4h)
      const now = Date.now();
      const stuck = queue.filter(item => {
        if (item.status === 'completed' || item.status === 'cancelled') return false;
        if (item.status === 'failed') return true;
        if (item.status === 'processing' && item.started_at) {
          return (now - new Date(item.started_at).getTime()) > 30 * 60 * 1000;
        }
        if (item.status === 'scheduled' && item.scheduled_at) {
          const overdue = (now - new Date(item.scheduled_at).getTime()) > 4 * 3600 * 1000;
          const maxed = (item.attempt_count || 0) >= (item.max_attempts || 5);
          return overdue || maxed;
        }
        return false;
      });

      setItems(stuck);

      // Buscar produtos para enriquecer
      if (stuck.length > 0) {
        const asins = [...new Set(stuck.map(i => i.asin).filter(Boolean))];
        const products = await base44.entities.Product.filter({ amazon_account_id: acc.id }, null, 200);
        const map = {};
        for (const p of products) {
          if (p.asin) map[p.asin] = p;
        }
        setProductMap(map);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const showMsg = (text, type = 'success') => {
    setMsg({ text, type });
    setTimeout(() => setMsg(null), 6000);
  };

  const handleRestart = async (item) => {
    setRestarting(item.id);
    try {
      await base44.entities.ProductKickoffQueue.update(item.id, {
        status: 'scheduled',
        last_error: null,
        attempt_count: 0,
        scheduled_at: new Date().toISOString(),
      });
      await base44.functions.invoke('processProductKickoffQueueV2', {
        amazon_account_id: item.amazon_account_id,
        _service_role: true,
        force: true,
      });
      showMsg(`Reiniciado: ${item.asin}`);
      await load();
    } catch (e) {
      showMsg(e.message, 'error');
    } finally {
      setRestarting(null);
    }
  };

  const handleDisable = async (item) => {
    setRestarting(item.id);
    try {
      // Cancela o item da fila
      await base44.entities.ProductKickoffQueue.update(item.id, {
        status: 'cancelled',
        last_error: 'Desabilitado: sem estoque. Aguardando reposição.',
      });
      // Marca produto como não elegível para kick-off
      const product = productMap[item.asin];
      if (product?.id) {
        await base44.entities.Product.update(product.id, {
          auto_campaign_eligible: false,
        });
      }
      showMsg(`Kick-off desabilitado para ${item.asin} até reposição de estoque.`);
      await load();
    } catch (e) {
      showMsg(e.message, 'error');
    } finally {
      setRestarting(null);
    }
  };

  // Agrupar por diagnóstico
  const noStock = items.filter(i => {
    const p = productMap[i.asin];
    return (p?.fba_inventory || 0) === 0 || p?.inventory_status === 'out_of_stock';
  });
  const withError = items.filter(i => {
    const p = productMap[i.asin];
    const d = diagnose(i, p);
    return d && d.type !== 'no_stock';
  });

  const restartAll = async () => {
    for (const item of withError) {
      const d = diagnose(item, productMap[item.asin]);
      if (d?.canRetry) await handleRestart(item);
    }
  };

  return (
    <div className="p-6 space-y-5 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-white flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-400" />
            Fila de Kick-off — Itens Travados
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">
            {loading ? 'Carregando...' : `${items.length} item(s) travado(s) · ${noStock.length} sem estoque · ${withError.length} com erro`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {withError.filter(i => diagnose(i, productMap[i.asin])?.canRetry).length > 1 && (
            <button
              onClick={restartAll}
              disabled={!!restarting}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-cyan/10 border border-cyan/25 text-cyan hover:bg-cyan/20 rounded-lg font-semibold transition-colors disabled:opacity-40"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reiniciar todos
            </button>
          )}
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-surface-2 border border-surface-3 text-slate-300 hover:text-white rounded-lg transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Atualizar
          </button>
        </div>
      </div>

      {/* Mensagem de feedback */}
      {msg && (
        <div className={`px-4 py-3 rounded-xl text-sm ${msg.type === 'error' ? 'bg-red-500/10 border border-red-500/20 text-red-300' : 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-300'}`}>
          {msg.text}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-6 h-6 text-cyan animate-spin" />
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 bg-surface-1 border border-surface-2 rounded-2xl">
          <CheckCircle2 className="w-10 h-10 text-emerald-500/40" />
          <p className="text-sm text-slate-400">Nenhum item travado na fila</p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Com erro (reiniciáveis) */}
          {withError.length > 0 && (
            <div className="bg-surface-1 border border-surface-2 rounded-2xl overflow-hidden">
              <div className="px-5 py-3 border-b border-surface-2 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-red-400" />
                <h2 className="text-sm font-semibold text-white">Erros de processamento</h2>
                <span className="ml-auto text-xs text-red-400 font-bold">{withError.length}</span>
              </div>
              {withError.map(item => (
                <StuckRow
                  key={item.id}
                  item={item}
                  product={productMap[item.asin]}
                  onRestart={handleRestart}
                  restarting={restarting}
                  onDisable={handleDisable}
                />
              ))}
            </div>
          )}

          {/* Sem estoque (aguardando) */}
          {noStock.length > 0 && (
            <div className="bg-surface-1 border border-surface-2 rounded-2xl overflow-hidden">
              <div className="px-5 py-3 border-b border-surface-2 flex items-center gap-2">
                <Package className="w-4 h-4 text-amber-400" />
                <h2 className="text-sm font-semibold text-white">Aguardando estoque</h2>
                <span className="ml-auto text-xs text-amber-400 font-bold">{noStock.length}</span>
              </div>
              <p className="px-5 py-2 text-xs text-slate-500 border-b border-surface-2/50">
                Estes produtos serão reativados automaticamente quando o estoque FBA for reposto. Até lá o kick-off está desabilitado.
              </p>
              {noStock.map(item => (
                <StuckRow
                  key={item.id}
                  item={item}
                  product={productMap[item.asin]}
                  onRestart={handleRestart}
                  restarting={restarting}
                  onDisable={handleDisable}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}