import { useState, useEffect, useRef, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  RefreshCw, Loader2, CheckCircle, XCircle, Clock, Zap,
  AlertTriangle, Play, Package, Key, Rocket, Trash2,
  ChevronDown, ChevronRight, Wrench, RotateCcw, AlertCircle,
  Activity, Filter
} from 'lucide-react';

// ── Configurações ────────────────────────────────────────────────────────────

const STATUS_CONFIG = {
  scheduled:  { label: 'Agendado',    color: 'text-amber-400',   bg: 'bg-amber-500/10 border-amber-500/20',   dot: 'bg-amber-400 animate-pulse' },
  processing: { label: 'Processando', color: 'text-cyan',        bg: 'bg-cyan/10 border-cyan/20',             dot: 'bg-cyan animate-pulse' },
  completed:  { label: 'Concluído',   color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20', dot: 'bg-emerald-400' },
  failed:     { label: 'Erro',        color: 'text-red-400',     bg: 'bg-red-500/10 border-red-500/20',       dot: 'bg-red-400' },
  cancelled:  { label: 'Cancelado',   color: 'text-slate-500',   bg: 'bg-slate-500/5 border-slate-500/15',    dot: 'bg-slate-500' },
};

// Mapeia mensagens de erro para dicas de resolução
function parseError(err) {
  if (!err) return null;
  if (err.includes('Dados insuficientes') || err.includes('campaignId=')) {
    return { type: 'no_campaign', short: 'Sem campaign_id', hint: 'Campanha não criada na Amazon. Use o Kickoff na página de Produtos.' };
  }
  if (err.includes('403') || err.includes('Forbidden') || err.includes('token')) {
    return { type: 'auth', short: 'Token expirado', hint: 'Token Amazon Ads inválido ou revogado. Reautorize em Integrações → Amazon.' };
  }
  if (err.includes('404') || err.includes('não encontrada') || err.includes('not found')) {
    return { type: 'not_found', short: 'Não encontrada', hint: 'Campanha não existe na Amazon. Verifique o campaign_id.' };
  }
  if (err.includes('429') || err.includes('Rate limit') || err.includes('rate limit')) {
    return { type: 'rate_limit', short: 'Rate limit', hint: 'Amazon rejeitou por excesso de requisições. Aguarde e tente novamente.' };
  }
  if (err.includes('timeout') || err.includes('TIMEOUT') || err.includes('abort')) {
    return { type: 'timeout', short: 'Timeout', hint: 'Requisição demorou demais. Tente novamente.' };
  }
  return { type: 'generic', short: 'Erro genérico', hint: err };
}

// ── Componentes base ─────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.scheduled;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-bold rounded-lg border ${cfg.bg} ${cfg.color} whitespace-nowrap`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

function ErrorPanel({ error, onRetry, retrying }) {
  const parsed = parseError(error);
  if (!parsed) return null;
  const canRetry = parsed.type !== 'no_campaign';
  return (
    <div className="mt-2 rounded-lg border border-red-500/20 bg-red-500/5 overflow-hidden">
      <div className="px-3 py-2 flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-1">
            <AlertCircle className="w-3 h-3 text-red-400 flex-shrink-0" />
            <span className="text-[10px] font-bold text-red-400">{parsed.short}</span>
          </div>
          <p className="text-[10px] text-red-300/80">{parsed.hint}</p>
          {parsed.type === 'generic' && (
            <p className="text-[10px] font-mono text-red-400/60 mt-1 break-all">{error}</p>
          )}
        </div>
        {canRetry && (
          <button
            onClick={onRetry}
            disabled={retrying}
            className="flex-shrink-0 flex items-center gap-1 px-2.5 py-1.5 text-[10px] font-bold bg-red-500/15 border border-red-500/30 text-red-300 hover:bg-red-500/25 rounded-lg transition-colors disabled:opacity-50 whitespace-nowrap"
          >
            {retrying ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
            {retrying ? 'Tentando...' : 'Resolver Erro'}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Linha de item da fila ────────────────────────────────────────────────────

function QueueRow({ item, entityName, onDelete, onRetry, retrying }) {
  const [expanded, setExpanded] = useState(item.status === 'failed');
  const isFailed = item.status === 'failed';
  const isProcessing = item.status === 'processing';
  const attempts = item.attempt_count || 0;
  const maxAttempts = item.max_attempts || 5;
  const pct = Math.round((attempts / maxAttempts) * 100);

  return (
    <div className={`border-b border-surface-2/50 transition-all ${isProcessing ? 'bg-cyan/3' : isFailed ? 'bg-red-500/4' : ''}`}>
      <div className="flex items-start gap-3 px-4 py-3">
        {/* Expand toggle */}
        <button
          onClick={() => setExpanded(v => !v)}
          className="mt-0.5 text-slate-600 hover:text-slate-400 transition-colors flex-shrink-0"
        >
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Title row */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-mono font-bold text-cyan">{item.asin || '—'}</span>
            {item.campaign_name && <span className="text-xs text-slate-400 truncate max-w-[200px]">{item.campaign_name}</span>}
            {item.campaign_id && (
              <span className="text-[10px] font-mono text-slate-600">{item.campaign_id}</span>
            )}
          </div>

          {/* Meta row */}
          <div className="flex items-center gap-3 mt-1 text-[10px] text-slate-500 flex-wrap">
            {attempts > 0 && (
              <span className={attempts >= maxAttempts ? 'text-red-400 font-semibold' : 'text-amber-400'}>
                {attempts}/{maxAttempts} tentativas
              </span>
            )}
            {item.scheduled_at && (
              <span>Agendado: {new Date(item.scheduled_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
            )}
            {item.started_at && (
              <span>Início: {new Date(item.started_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
            )}
            {item.completed_at && (
              <span className="text-emerald-400">
                Fim: {new Date(item.completed_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>

          {/* Progress bar de tentativas */}
          {attempts > 0 && item.status !== 'completed' && (
            <div className="mt-1.5 h-1 bg-surface-3 rounded-full w-32 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${attempts >= maxAttempts ? 'bg-red-400' : 'bg-amber-400'}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          )}

          {/* Erro expandido */}
          {expanded && isFailed && (
            <ErrorPanel
              error={item.last_error}
              onRetry={() => onRetry(item)}
              retrying={retrying === item.id}
            />
          )}

          {/* Erro compacto em linha (sem expand) quando não expandido */}
          {!expanded && isFailed && item.last_error && (
            <p className="text-[10px] text-red-400/70 mt-1 truncate">{parseError(item.last_error)?.short || 'Erro'}</p>
          )}
        </div>

        {/* Ações */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <StatusBadge status={item.status} />
          {isFailed && (
            <button
              onClick={() => onRetry(item)}
              disabled={retrying === item.id || parseError(item.last_error)?.type === 'no_campaign'}
              title="Resolver erro e reagendar"
              className="p-1.5 rounded-lg text-amber-400 hover:bg-amber-500/15 transition-colors disabled:opacity-30"
            >
              {retrying === item.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wrench className="w-3.5 h-3.5" />}
            </button>
          )}
          {(item.status === 'failed' || item.status === 'completed' || item.status === 'cancelled') && (
            <button
              onClick={() => onDelete(item.id)}
              title="Remover da fila"
              className="p-1.5 rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Seção de Fila ────────────────────────────────────────────────────────────

function QueueSection({ title, icon: Icon, colorClass, items, entityName, onDelete, onRetry, retrying, onRunNow, isRunning, runMsg, onClearDone, statusFilter, onFilterChange }) {
  const counts = {
    scheduled: items.filter(i => i.status === 'scheduled').length,
    processing: items.filter(i => i.status === 'processing').length,
    completed: items.filter(i => i.status === 'completed').length,
    failed: items.filter(i => i.status === 'failed').length,
  };

  const filtered = statusFilter === 'all' ? items
    : items.filter(i => i.status === statusFilter);

  const hasDone = counts.completed > 0 || items.some(i => i.status === 'cancelled' || i.status === 'failed');

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-surface-2">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded-xl flex items-center justify-center ${colorClass.iconBg}`}>
              <Icon className={`w-4 h-4 ${colorClass.icon}`} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">{title}</h2>
              <div className="flex items-center gap-3 text-[10px] mt-0.5">
                {counts.processing > 0 && <span className="text-cyan font-bold flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-cyan animate-pulse" />{counts.processing} proc.</span>}
                {counts.scheduled > 0 && <span className="text-amber-400 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-amber-400" />{counts.scheduled} ag.</span>}
                {counts.completed > 0 && <span className="text-emerald-400 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />{counts.completed} ok</span>}
                {counts.failed > 0 && <span className="text-red-400 font-bold flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-red-400" />{counts.failed} erro{counts.failed !== 1 ? 's' : ''}</span>}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* Filtro rápido */}
            <div className="flex bg-surface-2 border border-surface-3 rounded-lg p-0.5 gap-0.5">
              {['all', 'scheduled', 'failed', 'completed'].map(s => (
                <button key={s} onClick={() => onFilterChange(s)}
                  className={`text-[10px] px-2 py-1 rounded transition-colors ${statusFilter === s ? 'bg-surface-3 text-white' : 'text-slate-500 hover:text-slate-300'}`}>
                  {s === 'all' ? 'Todos' : s === 'scheduled' ? 'Ag.' : s === 'failed' ? 'Erros' : 'OK'}
                </button>
              ))}
            </div>

            {hasDone && (
              <button onClick={onClearDone} className="text-[10px] text-slate-500 hover:text-slate-300 px-2 py-1 border border-surface-3 rounded-lg transition-colors whitespace-nowrap">
                Limpar resolvidos
              </button>
            )}

            {runMsg && (
              <span className={`text-xs ${runMsg.type === 'error' ? 'text-red-400' : 'text-emerald-400'}`}>{runMsg.text}</span>
            )}

            <button
              onClick={onRunNow}
              disabled={isRunning || counts.scheduled === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-cyan/15 border border-cyan/30 text-cyan hover:bg-cyan/25 rounded-lg transition-colors disabled:opacity-40 font-semibold whitespace-nowrap"
            >
              {isRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              {isRunning ? 'Executando...' : 'Executar Agora'}
            </button>
          </div>
        </div>

        {/* Barra de progresso geral da fila */}
        {items.length > 0 && (
          <div className="mt-3 space-y-1">
            <div className="flex justify-between text-[10px] text-slate-500">
              <span>{counts.completed} de {items.length} concluídos</span>
              <span>{Math.round((counts.completed / items.length) * 100)}%</span>
            </div>
            <div className="h-1.5 bg-surface-3 rounded-full overflow-hidden flex gap-0.5">
              {counts.completed > 0 && <div className="h-full bg-emerald-400 rounded-full transition-all" style={{ width: `${(counts.completed / items.length) * 100}%` }} />}
              {counts.failed > 0 && <div className="h-full bg-red-400 rounded-full transition-all" style={{ width: `${(counts.failed / items.length) * 100}%` }} />}
              {counts.processing > 0 && <div className="h-full bg-cyan animate-pulse rounded-full transition-all" style={{ width: `${(counts.processing / items.length) * 100}%` }} />}
            </div>
            <div className="flex gap-4 text-[9px] text-slate-600">
              <span className="flex items-center gap-1"><span className="w-2 h-1.5 rounded-sm bg-emerald-400" /> Concluído</span>
              {counts.failed > 0 && <span className="flex items-center gap-1"><span className="w-2 h-1.5 rounded-sm bg-red-400" /> Erro</span>}
              {counts.processing > 0 && <span className="flex items-center gap-1"><span className="w-2 h-1.5 rounded-sm bg-cyan" /> Processando</span>}
              {counts.scheduled > 0 && <span className="flex items-center gap-1"><span className="w-2 h-1.5 rounded-sm bg-surface-3" /> Aguardando</span>}
            </div>
          </div>
        )}
      </div>

      {/* Rows */}
      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 gap-2">
          <CheckCircle className="w-8 h-8 text-slate-700" />
          <p className="text-sm text-slate-500">Fila vazia</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex items-center justify-center py-8 text-sm text-slate-500">Nenhum item com este filtro</div>
      ) : (
        <div className="max-h-96 overflow-y-auto scrollbar-thin">
          {/* Erros no topo */}
          {filtered.filter(i => i.status === 'failed').map(item => (
            <QueueRow key={item.id} item={item} entityName={entityName} onDelete={onDelete} onRetry={onRetry} retrying={retrying} />
          ))}
          {filtered.filter(i => i.status !== 'failed').map(item => (
            <QueueRow key={item.id} item={item} entityName={entityName} onDelete={onDelete} onRetry={onRetry} retrying={retrying} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Página Principal ─────────────────────────────────────────────────────────

export default function CampaignQueueMonitor() {
  const [account, setAccount] = useState(null);
  const [kickoffQueue, setKickoffQueue] = useState([]);
  const [repairQueue, setRepairQueue] = useState([]);
  const [keywordQueue, setKeywordQueue] = useState([]);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const intervalRef = useRef(null);
  const [running, setRunning] = useState({ kickoff: false, repair: false, keyword: false });
  const [runMsg, setRunMsg] = useState({ kickoff: null, repair: null, keyword: null });
  const [retrying, setRetrying] = useState(null); // item id being retried
  const [filters, setFilters] = useState({ kickoff: 'all', repair: 'failed', keyword: 'all' });

  const loadQueues = useCallback(async (isFirst = false) => {
    if (isFirst) setLoading(true);
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accounts[0];
      if (!acc) return;
      setAccount(acc);
      const kickoff = await base44.entities.ProductKickoffQueue.filter({ amazon_account_id: acc.id }, '-scheduled_at', 100);
      const repair = await base44.entities.AutoCampaignRepairQueue.filter({ amazon_account_id: acc.id }, '-scheduled_at', 100);
      const keyword = await base44.entities.KeywordRepairQueue.filter({ amazon_account_id: acc.id }, '-scheduled_at', 100);
      setKickoffQueue(kickoff);
      setRepairQueue(repair);
      setKeywordQueue(keyword);
      setLastRefresh(new Date());
    } finally {
      if (isFirst) setLoading(false);
    }
  }, []);

  useEffect(() => { loadQueues(true); }, [loadQueues]);

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(() => loadQueues(false), 30000);
    } else {
      clearInterval(intervalRef.current);
    }
    return () => clearInterval(intervalRef.current);
  }, [autoRefresh, loadQueues]);

  const deleteItem = async (entityName, id) => {
    await base44.entities[entityName].delete(id);
    loadQueues(false);
  };

  // Resolver erro: reagendar item e disparar processador
  const retryItem = async (item, entityName, runnerFn) => {
    if (retrying) return;
    setRetrying(item.id);
    try {
      // Reagendar
      await base44.entities[entityName].update(item.id, {
        status: 'scheduled',
        last_error: null,
        attempt_count: 0,
        scheduled_at: new Date().toISOString(),
      });
      // Disparar processador imediatamente
      await base44.functions.invoke(runnerFn, {
        amazon_account_id: item.amazon_account_id,
        _service_role: true,
        force: true,
      });
      await loadQueues(false);
    } catch (e) {
      console.error('Retry error:', e);
    } finally {
      setRetrying(null);
    }
  };

  const runNow = async (key, fnName) => {
    if (!account || running[key]) return;
    setRunning(r => ({ ...r, [key]: true }));
    setRunMsg(m => ({ ...m, [key]: null }));
    try {
      const res = await base44.functions.invoke(fnName, { amazon_account_id: account.id, _service_role: true, force: true });
      const d = res?.data || {};
      const msg = d.overdue_processed != null
        ? `✓ ${d.overdue_processed} processados`
        : d.processed != null
        ? `✓ ${d.processed} processados`
        : d.ok === false
        ? `Erro: ${d.error || 'falhou'}`
        : '✓ Executado';
      setRunMsg(m => ({ ...m, [key]: { type: d.ok === false ? 'error' : 'success', text: msg } }));
      setTimeout(() => setRunMsg(m => ({ ...m, [key]: null })), 8000);
      loadQueues(false);
    } catch (e) {
      setRunMsg(m => ({ ...m, [key]: { type: 'error', text: e.message } }));
      setTimeout(() => setRunMsg(m => ({ ...m, [key]: null })), 8000);
    } finally {
      setRunning(r => ({ ...r, [key]: false }));
    }
  };

  const clearDone = async (entityName, items) => {
    const done = items.filter(i => ['completed', 'cancelled', 'failed'].includes(i.status));
    await Promise.all(done.map(i => base44.entities[entityName].delete(i.id)));
    loadQueues(false);
  };

  // KPIs
  const allItems = [...kickoffQueue, ...repairQueue, ...keywordQueue];
  const totalProcessing = allItems.filter(i => i.status === 'processing').length;
  const totalScheduled  = allItems.filter(i => i.status === 'scheduled').length;
  const totalCompleted  = allItems.filter(i => i.status === 'completed').length;
  const totalFailed     = allItems.filter(i => i.status === 'failed').length;

  const QUEUES = [
    {
      key: 'kickoff', title: 'Kickoff de Produtos', icon: Rocket,
      colorClass: { icon: 'text-violet-400', iconBg: 'bg-violet-500/15 border border-violet-500/20' },
      items: kickoffQueue, entityName: 'ProductKickoffQueue',
      runnerFn: 'processProductKickoffQueueV2',
    },
    {
      key: 'repair', title: 'Reparo de Campanhas AUTO', icon: Zap,
      colorClass: { icon: 'text-amber-400', iconBg: 'bg-amber-500/15 border border-amber-500/20' },
      items: repairQueue, entityName: 'AutoCampaignRepairQueue',
      runnerFn: 'processAutoCampaignRepairQueueV2',
    },
    {
      key: 'keyword', title: 'Reparo de Keywords EXACT', icon: Key,
      colorClass: { icon: 'text-cyan', iconBg: 'bg-cyan/15 border border-cyan/20' },
      items: keywordQueue, entityName: 'KeywordRepairQueue',
      runnerFn: 'processKeywordRepairQueue',
    },
  ];

  return (
    <div className="p-6 space-y-6 animate-fade-in max-w-5xl mx-auto">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Activity className="w-5 h-5 text-cyan" />
            Monitor de Filas
          </h1>
          <p className="text-sm text-slate-400 mt-0.5">
            Status em tempo real · erros identificados com ação de resolução
          </p>
        </div>
        <div className="flex items-center gap-2">
          {lastRefresh && (
            <span className="text-[10px] text-slate-500">{lastRefresh.toLocaleTimeString('pt-BR')}</span>
          )}
          <button
            onClick={() => setAutoRefresh(v => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-colors ${autoRefresh ? 'bg-cyan/15 border-cyan/30 text-cyan' : 'bg-surface-2 border-surface-3 text-slate-400'}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${autoRefresh ? 'bg-cyan animate-pulse' : 'bg-slate-500'}`} />
            {autoRefresh ? 'Auto (15s)' : 'Pausado'}
          </button>
          <button
            onClick={() => loadQueues(false)}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-surface-2 border border-surface-3 text-slate-300 hover:text-white rounded-lg transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Atualizar
          </button>
        </div>
      </div>

      {/* ── KPI bar ─────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Processando', value: totalProcessing, color: 'text-cyan',         border: 'border-cyan/20',          pulse: true },
          { label: 'Agendados',   value: totalScheduled,  color: 'text-slate-300',    border: 'border-surface-3',        pulse: false },
          { label: 'Concluídos',  value: totalCompleted,  color: 'text-emerald-400',  border: 'border-emerald-500/20',   pulse: false },
          { label: 'Com Erro',    value: totalFailed,     color: 'text-red-400',      border: 'border-red-500/20',       pulse: false },
        ].map(({ label, value, color, border, pulse }) => (
          <div key={label} className={`bg-surface-1 rounded-xl border ${border} px-4 py-3 text-center`}>
            <p className="text-xs text-slate-500 mb-1">{label}</p>
            <p className={`text-2xl font-bold ${color} ${pulse && value > 0 ? 'animate-pulse' : ''}`}>{value}</p>
          </div>
        ))}
      </div>

      {/* ── Alertas ──────────────────────────────────────────────────────────── */}
      {totalProcessing > 0 && (
        <div className="flex items-center gap-3 px-4 py-3 bg-cyan/5 border border-cyan/20 rounded-xl">
          <Loader2 className="w-4 h-4 text-cyan animate-spin flex-shrink-0" />
          <p className="text-sm text-cyan">{totalProcessing} item(s) em processamento agora. {totalScheduled > 0 && `${totalScheduled} aguardando.`}</p>
        </div>
      )}
      {totalFailed > 0 && (
        <div className="flex items-center gap-3 px-4 py-3 bg-red-500/5 border border-red-500/20 rounded-xl">
          <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />
          <div>
            <p className="text-sm text-red-300 font-semibold">{totalFailed} item(s) com erro</p>
            <p className="text-xs text-red-400/70 mt-0.5">
              Clique em <span className="font-mono bg-red-500/15 px-1 rounded">Resolver Erro</span> em cada item ou use o botão "Executar Agora" para reprocessar a fila.
            </p>
          </div>
        </div>
      )}

      {/* ── Filas ────────────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 text-cyan animate-spin" />
        </div>
      ) : (
        <div className="space-y-4">
          {QUEUES.map(q => (
            <QueueSection
              key={q.key}
              title={q.title}
              icon={q.icon}
              colorClass={q.colorClass}
              items={q.items}
              entityName={q.entityName}
              onDelete={id => deleteItem(q.entityName, id)}
              onRetry={item => retryItem(item, q.entityName, q.runnerFn)}
              retrying={retrying}
              onRunNow={() => runNow(q.key, q.runnerFn)}
              isRunning={running[q.key]}
              runMsg={runMsg[q.key]}
              onClearDone={() => clearDone(q.entityName, q.items)}
              statusFilter={filters[q.key]}
              onFilterChange={v => setFilters(f => ({ ...f, [q.key]: v }))}
            />
          ))}
        </div>
      )}
    </div>
  );
}