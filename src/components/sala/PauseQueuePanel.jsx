import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Pause, RefreshCw, Loader2, Clock, CheckCircle, XCircle,
  AlertTriangle, Play, Trash2, ChevronDown, ChevronRight, Zap, Filter
} from 'lucide-react';

// Janela operacional: 03:00–06:00 BRT = 06:00–09:00 UTC
const WINDOW_START_UTC = 6;
const WINDOW_END_UTC = 9;

function getBRTHour() {
  return (new Date().getUTCHours() - 3 + 24) % 24;
}

function isInOperationalWindow() {
  const utcH = new Date().getUTCHours();
  return utcH >= WINDOW_START_UTC && utcH < WINDOW_END_UTC;
}

function getNextWindowBRT() {
  const now = new Date();
  const brtH = getBRTHour();
  if (brtH < 3) return `hoje às 03:00`;
  return `amanhã às 03:00`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const STATUS_CFG = {
  pending:    { label: 'Pendente',    color: 'text-amber-400',   bg: 'bg-amber-500/10 border-amber-500/25' },
  running:    { label: 'Executando',  color: 'text-cyan',        bg: 'bg-cyan/10 border-cyan/25' },
  completed:  { label: 'Executado',   color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/25' },
  failed:     { label: 'Erro',        color: 'text-red-400',     bg: 'bg-red-500/10 border-red-500/25' },
  skipped:    { label: 'Ignorado',    color: 'text-slate-400',   bg: 'bg-slate-500/10 border-slate-500/20' },
  cancelled:  { label: 'Cancelado',   color: 'text-slate-500',   bg: 'bg-slate-500/5 border-slate-500/15' },
};

const PRIORITY_CFG = {
  critical:   { label: 'Crítica',    color: 'text-red-400',     bg: 'bg-red-500/15 border-red-500/25' },
  high:       { label: 'Alta',       color: 'text-orange-400',  bg: 'bg-orange-500/15 border-orange-500/25' },
  normal:     { label: 'Normal',     color: 'text-slate-300',   bg: 'bg-surface-3 border-surface-3' },
  low:        { label: 'Baixa',      color: 'text-slate-500',   bg: 'bg-surface-2 border-surface-2' },
  background: { label: 'Background', color: 'text-slate-600',   bg: 'bg-surface-2 border-surface-2' },
};

function StatusBadge({ status }) {
  const cfg = STATUS_CFG[status] || STATUS_CFG.pending;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold rounded-lg border ${cfg.bg} ${cfg.color} whitespace-nowrap`}>
      {cfg.label}
    </span>
  );
}

function PriorityBadge({ priority }) {
  const cfg = PRIORITY_CFG[priority] || PRIORITY_CFG.normal;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold rounded border ${cfg.bg} ${cfg.color} whitespace-nowrap`}>
      {cfg.label}
    </span>
  );
}

function QueueRow({ item, onCancel, onRetry, cancelling, retrying }) {
  const [expanded, setExpanded] = useState(false);
  const isPause = item.operation === 'pause_campaign' || item.operation === 'PAUSE' || item.entity_type === 'campaign';
  const isFailed = item.status === 'failed';
  const isPending = item.status === 'pending';

  const campaignName = item.payload?.name || item.payload?.campaign_name || item.payload?.campaignId || item.entity_id || '—';
  const reason = item.payload?.reason || item.source || '—';

  return (
    <div className={`border-b border-surface-2/50 last:border-0 ${isFailed ? 'bg-red-500/3' : isPending ? 'bg-amber-500/2' : ''}`}>
      <div className="flex items-start gap-3 px-4 py-3">
        {/* Expand */}
        <button onClick={() => setExpanded(v => !v)} className="mt-0.5 text-slate-600 hover:text-slate-400 flex-shrink-0">
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>

        {/* Ícone de operação */}
        <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${isPause ? 'bg-amber-500/15 border border-amber-500/25' : 'bg-surface-2 border border-surface-3'}`}>
          <Pause className={`w-3.5 h-3.5 ${isPause ? 'text-amber-400' : 'text-slate-400'}`} />
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-white truncate max-w-[220px]">{campaignName}</span>
            <span className="text-[10px] font-mono text-cyan bg-cyan/10 px-1.5 py-0.5 rounded border border-cyan/20">{item.operation || item.entity_type}</span>
            <PriorityBadge priority={item.priority} />
          </div>
          <div className="flex items-center gap-3 mt-1 text-[10px] text-slate-500 flex-wrap">
            {item.scheduled_at && (
              <span className="flex items-center gap-1">
                <Clock className="w-2.5 h-2.5" />
                Agendado: {fmtDate(item.scheduled_at)}
              </span>
            )}
            {(item.attempt_count || 0) > 0 && (
              <span className={item.attempt_count >= (item.max_attempts || 3) ? 'text-red-400' : 'text-amber-400'}>
                {item.attempt_count}/{item.max_attempts || 3} tentativas
              </span>
            )}
            {item.source && <span className="text-slate-600">Fonte: {item.source}</span>}
          </div>

          {/* Expandido: payload + erro */}
          {expanded && (
            <div className="mt-2 space-y-1.5">
              {item.payload && (
                <div className="rounded-lg border border-surface-3 bg-surface-2/50 px-3 py-2">
                  <p className="text-[9px] text-slate-500 font-semibold uppercase mb-1">Payload</p>
                  <pre className="text-[9px] text-slate-400 whitespace-pre-wrap break-all font-mono max-h-28 overflow-y-auto scrollbar-thin">
                    {JSON.stringify(item.payload, null, 2)}
                  </pre>
                </div>
              )}
              {item.last_error && (
                <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2">
                  <p className="text-[10px] font-bold text-red-400 mb-0.5">Erro</p>
                  <p className="text-[10px] text-red-300/80 break-all">{item.last_error}</p>
                </div>
              )}
              {item.result && (
                <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2">
                  <p className="text-[10px] text-emerald-400 break-all">{item.result}</p>
                </div>
              )}
              {item.completed_at && (
                <p className="text-[9px] text-slate-600">Executado em: {fmtDate(item.completed_at)}</p>
              )}
            </div>
          )}
        </div>

        {/* Ações */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <StatusBadge status={item.status} />
          {isFailed && (
            <button onClick={() => onRetry(item)} disabled={retrying === item.id}
              title="Retentar"
              className="p-1.5 rounded-lg text-amber-400 hover:bg-amber-500/15 transition-colors disabled:opacity-30">
              {retrying === item.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            </button>
          )}
          {isPending && (
            <button onClick={() => onCancel(item)} disabled={cancelling === item.id}
              title="Cancelar"
              className="p-1.5 rounded-lg text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-30">
              {cancelling === item.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}
            </button>
          )}
          {['completed', 'cancelled', 'skipped', 'failed'].includes(item.status) && (
            <button onClick={() => onCancel(item, true)} title="Remover"
              className="p-1.5 rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-500/10 transition-colors">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function PauseQueuePanel({ accountId }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState(null);
  const [cancelling, setCancelling] = useState(null);
  const [retrying, setRetrying] = useState(null);
  const inWindow = isInOperationalWindow();
  const brtHour = getBRTHour();

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      // Buscar tudo da AmazonActionQueue para esta conta
      const all = await base44.entities.AmazonActionQueue.filter(
        { amazon_account_id: accountId },
        '-scheduled_at',
        200
      );
      setItems(all);
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => { load(); }, [load]);

  // Apenas ações de pausa de campanha
  const pauseItems = items.filter(i =>
    (i.operation || '').toLowerCase().includes('pause') ||
    (i.entity_type === 'campaign' && (i.operation || '').toLowerCase().includes('update'))
  );

  const allItems = statusFilter === 'all' ? pauseItems
    : pauseItems.filter(i => i.status === statusFilter);

  // Counters
  const counts = {
    pending:   pauseItems.filter(i => i.status === 'pending').length,
    running:   pauseItems.filter(i => i.status === 'running').length,
    completed: pauseItems.filter(i => i.status === 'completed').length,
    failed:    pauseItems.filter(i => i.status === 'failed').length,
    cancelled: pauseItems.filter(i => i.status === 'cancelled').length,
  };

  const executeNow = async () => {
    if (!accountId || running) return;
    setRunning(true);
    setRunMsg(null);
    try {
      const res = await base44.functions.invoke('runDailyAmazonActionQueue', { amazon_account_id: accountId, force: true });
      const d = res?.data;
      setRunMsg(d?.ok
        ? { type: 'success', text: `✓ ${d.executed || 0} ações executadas${d.failed ? ` · ${d.failed} falhas` : ''}` }
        : { type: 'error', text: d?.error || 'Falha ao executar fila.' }
      );
      await load();
    } catch (e) {
      setRunMsg({ type: 'error', text: e.message });
    } finally {
      setRunning(false);
      setTimeout(() => setRunMsg(null), 10000);
    }
  };

  const cancelItem = async (item, del = false) => {
    setCancelling(item.id);
    try {
      if (del) {
        await base44.entities.AmazonActionQueue.delete(item.id);
        setItems(prev => prev.filter(i => i.id !== item.id));
      } else {
        await base44.entities.AmazonActionQueue.update(item.id, { status: 'cancelled' });
        setItems(prev => prev.map(i => i.id === item.id ? { ...i, status: 'cancelled' } : i));
      }
    } finally {
      setCancelling(null);
    }
  };

  const retryItem = async (item) => {
    setRetrying(item.id);
    try {
      await base44.entities.AmazonActionQueue.update(item.id, {
        status: 'pending',
        last_error: null,
        attempt_count: 0,
        scheduled_at: new Date().toISOString(),
      });
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, status: 'pending', last_error: null, attempt_count: 0 } : i));
    } finally {
      setRetrying(null);
    }
  };

  const clearCompleted = async () => {
    const done = pauseItems.filter(i => ['completed', 'cancelled', 'skipped'].includes(i.status));
    await Promise.all(done.map(i => base44.entities.AmazonActionQueue.delete(i.id)));
    setItems(prev => prev.filter(i => !done.find(d => d.id === i.id)));
  };

  return (
    <div className="space-y-4">

      {/* Janela operacional */}
      <div className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-xs ${inWindow ? 'bg-emerald-500/8 border-emerald-500/20' : 'bg-surface-1 border-surface-2'}`}>
        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${inWindow ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`} />
        {inWindow ? (
          <span className="text-emerald-300 font-medium">
            Janela operacional <strong>ATIVA</strong> — pausas estão sendo processadas agora (03:00–06:00 BRT)
          </span>
        ) : (
          <span className="text-slate-400">
            Fora da janela operacional · São {String(brtHour).padStart(2, '0')}h BRT · Próxima execução: <strong className="text-slate-300">{getNextWindowBRT()}</strong>
          </span>
        )}
        <span className="ml-auto text-slate-500">Amazon exige janela de baixo tráfego para encerramento de campanhas</span>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-5 gap-2">
        {[
          { label: 'Pendentes',  value: counts.pending,   color: counts.pending > 0 ? 'text-amber-400' : 'text-slate-400', bg: counts.pending > 0 ? 'border-amber-500/20' : 'border-surface-2' },
          { label: 'Executando', value: counts.running,   color: counts.running > 0 ? 'text-cyan' : 'text-slate-400',      bg: counts.running > 0 ? 'border-cyan/20' : 'border-surface-2' },
          { label: 'Concluídas', value: counts.completed, color: 'text-emerald-400',                                       bg: 'border-surface-2' },
          { label: 'Com Erro',   value: counts.failed,    color: counts.failed > 0 ? 'text-red-400' : 'text-slate-400',    bg: counts.failed > 0 ? 'border-red-500/20' : 'border-surface-2' },
          { label: 'Canceladas', value: counts.cancelled, color: 'text-slate-500',                                         bg: 'border-surface-2' },
        ].map(k => (
          <div key={k.label} className={`bg-surface-1 border ${k.bg} rounded-xl px-3 py-3 text-center`}>
            <p className="text-[10px] text-slate-500 mb-0.5">{k.label}</p>
            <p className={`text-xl font-bold ${k.color}`}>{k.value}</p>
          </div>
        ))}
      </div>

      {/* Ações */}
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={executeNow} disabled={running || !inWindow}
          title={!inWindow ? 'Disponível apenas na janela 03:00–06:00 BRT' : ''}
          className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg border transition-colors disabled:opacity-40 ${inWindow ? 'bg-cyan/15 border-cyan/30 text-cyan hover:bg-cyan/25' : 'bg-surface-2 border-surface-3 text-slate-500 cursor-not-allowed'}`}>
          {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          {running ? 'Executando...' : 'Processar Fila Agora'}
        </button>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white text-xs rounded-lg disabled:opacity-50">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Atualizar
        </button>
        {(counts.completed + counts.cancelled) > 0 && (
          <button onClick={clearCompleted}
            className="flex items-center gap-1.5 px-3 py-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white text-xs rounded-lg">
            <Trash2 className="w-3.5 h-3.5" />
            Limpar Concluídas
          </button>
        )}
        {!inWindow && counts.pending > 0 && (
          <div className="flex items-center gap-1.5 px-3 py-2 bg-amber-500/8 border border-amber-500/20 rounded-lg text-[10px] text-amber-400">
            <Clock className="w-3.5 h-3.5 flex-shrink-0" />
            {counts.pending} pausa(s) aguardando janela operacional
          </div>
        )}
      </div>

      {runMsg && (
        <div className={`px-4 py-2.5 rounded-xl border text-xs font-medium ${runMsg.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300' : 'bg-red-500/10 border-red-500/20 text-red-400'}`}>
          {runMsg.text}
        </div>
      )}

      {/* Filtros de status */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <Filter className="w-3.5 h-3.5 text-slate-500" />
        {[
          { key: 'pending',   label: `Pendentes (${counts.pending})` },
          { key: 'failed',    label: `Erros (${counts.failed})` },
          { key: 'completed', label: `Concluídas (${counts.completed})` },
          { key: 'all',       label: `Todas (${pauseItems.length})` },
        ].map(f => (
          <button key={f.key} onClick={() => setStatusFilter(f.key)}
            className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${statusFilter === f.key ? 'bg-cyan/20 text-cyan border-cyan/30' : 'bg-surface-2 text-slate-500 border-surface-3 hover:text-slate-300'}`}>
            {f.label}
          </button>
        ))}
      </div>

      {/* Regras operacionais */}
      <div className="px-4 py-3 bg-surface-1 border border-surface-2 rounded-xl">
        <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-2">Regras Operacionais Amazon</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[10px] text-slate-500">
          <div className="flex items-start gap-1.5"><CheckCircle className="w-3 h-3 text-emerald-400 flex-shrink-0 mt-0.5" />Pausas executadas na janela 03:00–06:00 BRT (baixo tráfego)</div>
          <div className="flex items-start gap-1.5"><CheckCircle className="w-3 h-3 text-emerald-400 flex-shrink-0 mt-0.5" />Máx. 3 tentativas antes de marcar como falha permanente</div>
          <div className="flex items-start gap-1.5"><CheckCircle className="w-3 h-3 text-emerald-400 flex-shrink-0 mt-0.5" />Campanha com estoque zero tem pausa automática de prioridade crítica</div>
        </div>
      </div>

      {/* Lista */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-surface-2 flex items-center justify-between">
          <p className="text-sm font-semibold text-white flex items-center gap-2">
            <Pause className="w-4 h-4 text-amber-400" />
            Fila de Pausas de Campanhas
            {counts.pending > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 bg-amber-500/20 text-amber-400 rounded-full border border-amber-500/30">
                {counts.pending} pendente{counts.pending !== 1 ? 's' : ''}
              </span>
            )}
          </p>
          <span className="text-[10px] text-slate-500">{allItems.length} itens</span>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-5 h-5 text-cyan animate-spin" />
          </div>
        ) : allItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-14 gap-3">
            <div className="w-12 h-12 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
              <CheckCircle className="w-6 h-6 text-emerald-400" />
            </div>
            <div className="text-center">
              <p className="text-sm font-semibold text-slate-300">
                {statusFilter === 'pending' ? 'Nenhuma pausa pendente' : 'Sem itens neste filtro'}
              </p>
              <p className="text-xs text-slate-500 mt-0.5">
                {statusFilter === 'pending' ? 'Todas as campanhas estão em conformidade com as regras de estoque.' : 'Mude o filtro para ver outros itens.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="max-h-[480px] overflow-y-auto scrollbar-thin divide-y divide-surface-2/30">
            {/* Erros primeiro */}
            {allItems.filter(i => i.status === 'failed').map(i => (
              <QueueRow key={i.id} item={i} onCancel={cancelItem} onRetry={retryItem} cancelling={cancelling} retrying={retrying} />
            ))}
            {/* Pendentes */}
            {allItems.filter(i => i.status === 'pending').map(i => (
              <QueueRow key={i.id} item={i} onCancel={cancelItem} onRetry={retryItem} cancelling={cancelling} retrying={retrying} />
            ))}
            {/* Executando */}
            {allItems.filter(i => i.status === 'running').map(i => (
              <QueueRow key={i.id} item={i} onCancel={cancelItem} onRetry={retryItem} cancelling={cancelling} retrying={retrying} />
            ))}
            {/* Resto */}
            {allItems.filter(i => !['failed', 'pending', 'running'].includes(i.status)).map(i => (
              <QueueRow key={i.id} item={i} onCancel={cancelItem} onRetry={retryItem} cancelling={cancelling} retrying={retrying} />
            ))}
          </div>
        )}
      </div>

      {/* Total da fila geral */}
      {items.length > pauseItems.length && (
        <p className="text-[10px] text-slate-600 text-center">
          Mostrando {pauseItems.length} de {items.length} ações na fila total · Outros tipos: bids, budgets, keywords
        </p>
      )}
    </div>
  );
}