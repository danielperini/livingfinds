import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { Link } from 'react-router-dom';
import {
  RefreshCw, Loader2, AlertTriangle, Package, RotateCcw, Ban,
  CheckCircle2, Megaphone, Clock, Play, Trash2, ChevronDown, ChevronRight,
  Zap, XCircle, CircleDot, Sparkles, Database
} from 'lucide-react';

// ── Diagnóstico de item travado ──────────────────────────────────────────────
function diagnose(item, product) {
  const err = item.last_error || '';
  const attempts = item.attempt_count || 0;
  const maxAttempts = item.max_attempts || 5;
  const stock = product?.fba_inventory || 0;

  if (stock === 0 || product?.inventory_status === 'out_of_stock') {
    return { type: 'no_stock', label: 'Sem estoque', hint: 'Aguardando reposição.', color: 'amber', canRetry: false };
  }
  if (attempts >= maxAttempts) {
    if (err.includes('403') || err.includes('token') || err.includes('Unauthorized'))
      return { type: 'auth_error', label: 'Token inválido', hint: 'Reautorize em Integrações → Amazon.', color: 'red', canRetry: false };
    if (err.includes('409'))
      return { type: 'conflict', label: 'Campanha já existe (409)', hint: 'Campanha já criada na Amazon. Pode marcar como concluído.', color: 'amber', canRetry: false };
    if (err.includes('campaign') || err.includes('adGroup') || err.includes('keyword'))
      return { type: 'campaign_error', label: 'Erro de anúncio', hint: 'Falha ao criar campanha. Reiniciar pode resolver.', color: 'orange', canRetry: true };
    if (err.includes('429') || err.includes('rate') || err.includes('throttl'))
      return { type: 'rate_limit', label: 'Rate limit', hint: 'Reiniciar tentará novamente.', color: 'orange', canRetry: true };
    return { type: 'max_attempts', label: `Máx. tentativas (${attempts}/${maxAttempts})`, hint: err || 'Esgotou o limite.', color: 'red', canRetry: true };
  }
  if (item.status === 'processing' && item.started_at) {
    const mins = (Date.now() - new Date(item.started_at).getTime()) / 60000;
    if (mins > 30)
      return { type: 'stuck', label: `Travado ${Math.round(mins)}min`, hint: 'Processo parou sem resposta.', color: 'amber', canRetry: true };
  }
  return null;
}

// ── Config visual por status ─────────────────────────────────────────────────
const STATUS_CFG = {
  scheduled:  { label: 'Agendado',    icon: Clock,         cls: 'text-slate-400 bg-slate-500/10 border-slate-500/20' },
  processing: { label: 'Processando', icon: Loader2,       cls: 'text-cyan bg-cyan/10 border-cyan/20', spin: true },
  completed:  { label: 'Concluído',   icon: CheckCircle2,  cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  failed:     { label: 'Erro',        icon: XCircle,       cls: 'text-red-400 bg-red-500/10 border-red-500/20' },
  cancelled:  { label: 'Cancelado',   icon: Ban,           cls: 'text-slate-500 bg-slate-500/5 border-slate-500/10' },
};

function StatusBadge({ status }) {
  const cfg = STATUS_CFG[status] || STATUS_CFG.scheduled;
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-bold ${cfg.cls}`}>
      <Icon className={`w-2.5 h-2.5 ${cfg.spin ? 'animate-spin' : ''}`} />
      {cfg.label}
    </span>
  );
}

// ── Linha de item ────────────────────────────────────────────────────────────
function QueueRow({ item, product, onRestart, onCancel, onMarkDone, restarting }) {
  const [expanded, setExpanded] = useState(item.status === 'failed');
  const diag = item.status === 'failed' || ((item.attempt_count || 0) >= (item.max_attempts || 5))
    ? diagnose(item, product)
    : null;

  const name = product?.product_name || product?.display_name || item.product_name || item.asin;
  const stock = product?.fba_inventory ?? '—';
  const hasCampaign = product?.has_campaign || product?.linked_campaign_id;
  const isBusy = restarting === item.id;

  return (
    <div className={`border-b border-surface-2/40 last:border-0 transition-colors ${
      item.status === 'completed' ? 'bg-emerald-500/2' :
      item.status === 'failed' ? 'bg-red-500/3' :
      item.status === 'processing' ? 'bg-cyan/2' : ''
    }`}>
      {/* Linha principal */}
      <div className="flex items-center gap-3 px-4 py-3">
        <button onClick={() => setExpanded(v => !v)} className="text-slate-600 hover:text-slate-400 flex-shrink-0">
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>

        {/* ASIN + nome */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-xs font-bold text-cyan">{item.asin}</span>
            {item.sku && <span className="text-[10px] text-slate-500">{item.sku}</span>}
            {hasCampaign && (
              <span className="text-[10px] px-1.5 py-0.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-full">
                ✓ Com campanha
              </span>
            )}
          </div>
          <p className="text-xs text-slate-400 truncate max-w-xs">{name}</p>
          <div className="flex items-center gap-3 mt-1 text-[10px] text-slate-500 flex-wrap">
            <span>Estoque: <span className={stock === 0 ? 'text-amber-400 font-semibold' : 'text-slate-300'}>{stock} un</span></span>
            <span>{item.attempt_count || 0}/{item.max_attempts || 5} tentativas</span>
            <span>Modo: {item.mode || '—'}</span>
            {item.scheduled_at && (
              <span>{new Date(item.scheduled_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
            )}
          </div>
          {/* Badge de diagnóstico inline */}
          {diag && (
            <span className={`mt-1 inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-lg border ${
              diag.color === 'red' ? 'bg-red-500/10 border-red-500/20 text-red-300' :
              diag.color === 'amber' ? 'bg-amber-500/10 border-amber-500/20 text-amber-300' :
              'bg-orange-500/10 border-orange-500/20 text-orange-300'
            }`}>
              <AlertTriangle className="w-2.5 h-2.5" />
              {diag.label}
            </span>
          )}
        </div>

        {/* Status badge */}
        <StatusBadge status={item.status} />

        {/* Ações */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {item.status === 'failed' && diag?.canRetry && (
            <button onClick={() => onRestart(item)} disabled={isBusy}
              className="flex items-center gap-1 px-2.5 py-1.5 text-[10px] font-semibold bg-cyan/10 border border-cyan/25 text-cyan hover:bg-cyan/20 rounded-lg disabled:opacity-40 transition-colors">
              {isBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
              Reiniciar
            </button>
          )}
          {item.status === 'failed' && diag?.type === 'conflict' && (
            <button onClick={() => onMarkDone(item)} disabled={isBusy}
              className="flex items-center gap-1 px-2.5 py-1.5 text-[10px] font-semibold bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 hover:bg-emerald-500/20 rounded-lg disabled:opacity-40 transition-colors">
              {isBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
              Marcar OK
            </button>
          )}
          {['failed', 'completed', 'cancelled'].includes(item.status) && (
            <button onClick={() => onCancel(item)} disabled={isBusy}
              className="p-1.5 text-slate-600 hover:text-red-400 rounded-lg transition-colors disabled:opacity-40" title="Remover">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Detalhe expandido */}
      {expanded && (
        <div className="px-10 pb-3 space-y-1.5">
          {diag && <p className="text-[10px] text-slate-400">{diag.hint}</p>}
          {item.last_error && (
            <p className="text-[10px] font-mono text-red-400/60 break-all max-h-12 overflow-hidden">{item.last_error.slice(0, 200)}</p>
          )}
          {item.completed_at && (
            <p className="text-[10px] text-slate-600">Concluído: {new Date(item.completed_at).toLocaleString('pt-BR')}</p>
          )}
          {product?.linked_campaign_id && (
            <p className="text-[10px] text-emerald-400/70">Campaign ID: {product.linked_campaign_id}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Painel de Sync de Listings ────────────────────────────────────────────────
function ListingSyncPanel({ account }) {
  const [snapshots, setSnapshots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    if (!account) return;
    setLoading(true);
    try {
      const [prods, snaps] = await Promise.all([
        base44.entities.Product.filter({ amazon_account_id: account.id, status: 'active' }, null, 200),
        base44.entities.ListingSnapshot.filter({ amazon_account_id: account.id }, '-synced_at', 200).catch(() => []),
      ]);
      const snapMap = new Map(snaps.map(s => [s.asin, s]));
      const uniq = new Map();
      for (const p of prods) if (!uniq.has(p.asin)) uniq.set(p.asin, p);
      setSnapshots(Array.from(uniq.values()).map(p => ({ product: p, snap: snapMap.get(p.asin) || null })));
    } finally { setLoading(false); }
  }, [account]);

  useEffect(() => { load(); }, [load]);

  const syncOne = async (product) => {
    setSyncing(product.asin);
    setMsg(null);
    try {
      const res = await base44.functions.invoke('syncListingEnhancementData', {
        amazon_account_id: account.id, asin: product.asin,
      });
      setMsg({ type: res?.data?.ok ? 'success' : 'error', text: res?.data?.ok ? `Sincronizado: ${product.asin}` : (res?.data?.error || 'Erro') });
      await load();
    } catch (e) { setMsg({ type: 'error', text: e.message }); }
    finally { setSyncing(null); setTimeout(() => setMsg(null), 6000); }
  };

  const synced = snapshots.filter(s => !!s.snap).length;
  const notSynced = snapshots.filter(s => !s.snap).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3 text-xs text-slate-400">
          <span className="text-emerald-400 font-semibold">{synced} sincronizados</span>
          <span>·</span>
          <span className={notSynced > 0 ? 'text-amber-400 font-semibold' : 'text-slate-500'}>{notSynced} sem snapshot</span>
          <span>·</span>
          <span>Sync automático: <strong className="text-white">06:00 BRT</strong></span>
        </div>
        <Link to="/products/listing-enhancement"
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border bg-violet-500/10 border-violet-500/25 text-violet-300 hover:bg-violet-500/20 transition-colors">
          <Sparkles className="w-3.5 h-3.5" /> Abrir Listings
        </Link>
      </div>

      {msg && (
        <div className={`px-4 py-2 rounded-xl border text-xs font-medium ${msg.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300' : 'bg-red-500/10 border-red-500/20 text-red-300'}`}>
          {msg.text}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 text-cyan animate-spin" /></div>
      ) : (
        <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-surface-2 bg-surface-2/40">
                  {['ASIN', 'Produto', 'Snapshot', 'Últ. Sync', 'Ação'].map(h => (
                    <th key={h} className="px-3 py-2 text-left font-semibold text-slate-500 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {snapshots.map(({ product, snap }) => (
                  <tr key={product.id} className="border-b border-surface-2/30 hover:bg-surface-2/20 transition-colors">
                    <td className="px-3 py-2 font-mono text-cyan">{product.asin}</td>
                    <td className="px-3 py-2 text-slate-300 max-w-[180px] truncate">{product.display_name || product.product_name || '—'}</td>
                    <td className="px-3 py-2">
                      {snap
                        ? <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-400"><CheckCircle2 className="w-3 h-3" />OK</span>
                        : <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-400"><AlertTriangle className="w-3 h-3" />Pendente</span>}
                    </td>
                    <td className="px-3 py-2 text-slate-500 text-[10px]">
                      {snap?.synced_at ? new Date(snap.synced_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                    </td>
                    <td className="px-3 py-2">
                      <button onClick={() => syncOne(product)} disabled={!!syncing}
                        className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold rounded-lg border bg-surface-2 border-surface-3 text-slate-400 hover:text-white disabled:opacity-50 transition-colors">
                        {syncing === product.asin ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                        Sync
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Página principal ─────────────────────────────────────────────────────────
export default function KickoffQueueMonitor() {
  const [account, setAccount] = useState(null);
  const [items, setItems] = useState([]);
  const [productMap, setProductMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [restarting, setRestarting] = useState(null);
  const [msg, setMsg] = useState(null);
  const [filter, setFilter] = useState('all');
  const [tab, setTab] = useState('kickoff');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      const accs = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accs[0] || (await base44.entities.AmazonAccount.list())[0];
      if (!acc) return;
      setAccount(acc);

      const [queue, products] = await Promise.all([
        base44.entities.ProductKickoffQueue.filter({ amazon_account_id: acc.id }, '-scheduled_at', 200),
        base44.entities.Product.filter({ amazon_account_id: acc.id }, null, 200),
      ]);

      setItems(queue);
      const map = {};
      for (const p of products) if (p.asin) map[p.asin] = p;
      setProductMap(map);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const showMsg = (text, type = 'success') => {
    setMsg({ text, type });
    setTimeout(() => setMsg(null), 6000);
  };

  const handleRunQueue = async () => {
    if (!account || running) return;
    setRunning(true);
    try {
      const res = await base44.functions.invoke('processProductKickoffQueueV2', {
        amazon_account_id: account.id, _service_role: true, force: true,
      });
      const d = res?.data;
      showMsg(d?.ok ? `✓ ${d.processed || 0} item(s) processados` : d?.error || 'Erro ao executar');
      await load();
    } catch (e) { showMsg(e.message, 'error'); }
    finally { setRunning(false); }
  };

  const handleRestart = async (item) => {
    setRestarting(item.id);
    try {
      await base44.entities.ProductKickoffQueue.update(item.id, {
        status: 'scheduled', last_error: null, attempt_count: 0,
        scheduled_at: new Date().toISOString(),
      });
      showMsg(`Reagendado: ${item.asin}`);
      await load();
    } catch (e) { showMsg(e.message, 'error'); }
    finally { setRestarting(null); }
  };

  const handleMarkDone = async (item) => {
    setRestarting(item.id);
    try {
      await base44.entities.ProductKickoffQueue.update(item.id, {
        status: 'completed', completed_at: new Date().toISOString(),
        last_error: null,
      });
      showMsg(`Marcado como concluído: ${item.asin}`);
      await load();
    } catch (e) { showMsg(e.message, 'error'); }
    finally { setRestarting(null); }
  };

  const handleCancel = async (item) => {
    setRestarting(item.id);
    try {
      await base44.entities.ProductKickoffQueue.delete(item.id);
      showMsg(`Removido: ${item.asin}`);
      setItems(prev => prev.filter(i => i.id !== item.id));
    } catch (e) { showMsg(e.message, 'error'); }
    finally { setRestarting(null); }
  };

  // Contadores
  const counts = {
    all: items.length,
    scheduled: items.filter(i => i.status === 'scheduled').length,
    processing: items.filter(i => i.status === 'processing').length,
    completed: items.filter(i => i.status === 'completed').length,
    failed: items.filter(i => i.status === 'failed').length,
  };

  const filtered = filter === 'all' ? items : items.filter(i => i.status === filter);

  const FILTERS = [
    { key: 'all', label: 'Todos', count: counts.all },
    { key: 'scheduled', label: 'Agendados', count: counts.scheduled },
    { key: 'processing', label: 'Processando', count: counts.processing },
    { key: 'completed', label: 'Concluídos', count: counts.completed },
    { key: 'failed', label: 'Erros', count: counts.failed },
  ];

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-white flex items-center gap-2">
            <Megaphone className="w-5 h-5 text-violet-400" />
            Fila de Kick-off — Verificação de Campanhas
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">
            {loading ? 'Carregando...' : `${counts.all} itens · ${counts.completed} concluídos · ${counts.failed} com erro · ${counts.scheduled} agendados`}
          </p>
        </div>
        {tab === 'kickoff' && (
          <div className="flex items-center gap-2">
            <button onClick={handleRunQueue} disabled={running || !account || counts.scheduled === 0}
              className="flex items-center gap-1.5 px-3 py-2 text-xs bg-violet-500/15 border border-violet-500/30 text-violet-300 hover:bg-violet-500/25 rounded-lg font-semibold disabled:opacity-40 transition-colors">
              {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              {running ? 'Executando...' : `Executar fila (${counts.scheduled})`}
            </button>
            <button onClick={load} disabled={loading}
              className="flex items-center gap-1.5 px-3 py-2 text-xs bg-surface-2 border border-surface-3 text-slate-300 hover:text-white rounded-lg disabled:opacity-50 transition-colors">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              Atualizar
            </button>
          </div>
        )}
      </div>

      {/* Abas */}
      <div className="flex items-center gap-1 border-b border-surface-2">
        {[
          { key: 'kickoff', label: 'Fila de Kick-off', icon: Megaphone },
          { key: 'listings', label: 'Sync de Listings', icon: Sparkles },
        ].map(({ key, label, icon: Icon }) => (
          <button key={key} onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold border-b-2 -mb-px transition-colors ${
              tab === key ? 'border-cyan text-cyan' : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}>
            <Icon className="w-3.5 h-3.5" />{label}
          </button>
        ))}
      </div>

      {tab === 'listings' ? <ListingSyncPanel account={account} /> : <>
        {/* KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {[
            { label: 'Total', value: counts.all, color: 'text-white' },
            { label: 'Agendados', value: counts.scheduled, color: 'text-slate-400' },
            { label: 'Processando', value: counts.processing, color: 'text-cyan' },
            { label: 'Concluídos', value: counts.completed, color: 'text-emerald-400' },
            { label: 'Erros', value: counts.failed, color: counts.failed > 0 ? 'text-red-400' : 'text-slate-500' },
          ].map(k => (
            <div key={k.label} className="bg-surface-1 border border-surface-2 rounded-xl px-4 py-3 text-center">
              <p className="text-[10px] text-slate-500 mb-1">{k.label}</p>
              <p className={`text-2xl font-bold ${k.color}`}>{k.value}</p>
            </div>
          ))}
        </div>

        {/* Feedback */}
        {msg && (
          <div className={`px-4 py-3 rounded-xl text-sm border ${msg.type === 'error' ? 'bg-red-500/10 border-red-500/20 text-red-300' : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'}`}>
            {msg.text}
          </div>
        )}

        {/* Filtros */}
        <div className="flex items-center gap-1 overflow-x-auto pb-1">
          {FILTERS.map(f => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-full border whitespace-nowrap transition-colors ${
                filter === f.key ? 'bg-cyan/20 text-cyan border-cyan/30' : 'bg-surface-2 text-slate-500 border-surface-3 hover:text-slate-300'
              }`}>
              {f.label}
              {f.count > 0 && <span className="font-bold">{f.count}</span>}
            </button>
          ))}
        </div>

        {/* Lista */}
        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-6 h-6 text-cyan animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3 bg-surface-1 border border-surface-2 rounded-2xl">
            <CheckCircle2 className="w-10 h-10 text-emerald-500/30" />
            <p className="text-sm text-slate-400">Nenhum item com este filtro</p>
          </div>
        ) : (
          <div className="bg-surface-1 border border-surface-2 rounded-2xl overflow-hidden">
            <div className="px-4 py-2.5 border-b border-surface-2 bg-surface-2/40 grid grid-cols-[auto_1fr_auto_auto] gap-3 items-center">
              <span className="w-4" />
              <span className="text-[10px] font-semibold text-slate-500 uppercase">ASIN / Produto</span>
              <span className="text-[10px] font-semibold text-slate-500 uppercase">Status</span>
              <span className="text-[10px] font-semibold text-slate-500 uppercase">Ações</span>
            </div>
            {filtered.filter(i => i.status === 'failed').map(item => (
              <QueueRow key={item.id} item={item} product={productMap[item.asin]}
                onRestart={handleRestart} onCancel={handleCancel} onMarkDone={handleMarkDone} restarting={restarting} />
            ))}
            {filtered.filter(i => i.status === 'processing').map(item => (
              <QueueRow key={item.id} item={item} product={productMap[item.asin]}
                onRestart={handleRestart} onCancel={handleCancel} onMarkDone={handleMarkDone} restarting={restarting} />
            ))}
            {filtered.filter(i => i.status === 'scheduled').map(item => (
              <QueueRow key={item.id} item={item} product={productMap[item.asin]}
                onRestart={handleRestart} onCancel={handleCancel} onMarkDone={handleMarkDone} restarting={restarting} />
            ))}
            {filtered.filter(i => i.status === 'completed').map(item => (
              <QueueRow key={item.id} item={item} product={productMap[item.asin]}
                onRestart={handleRestart} onCancel={handleCancel} onMarkDone={handleMarkDone} restarting={restarting} />
            ))}
            {filtered.filter(i => i.status === 'cancelled').map(item => (
              <QueueRow key={item.id} item={item} product={productMap[item.asin]}
                onRestart={handleRestart} onCancel={handleCancel} onMarkDone={handleMarkDone} restarting={restarting} />
            ))}
          </div>
        )}
      </>}
    </div>
  );
}