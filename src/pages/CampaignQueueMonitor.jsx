import { useState, useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import {
  RefreshCw, Loader2, CheckCircle, XCircle, Clock, Zap,
  AlertTriangle, Play, Package, Key, Rocket, Trash2
} from 'lucide-react';

const STATUS_CONFIG = {
  scheduled: { label: 'Agendado',    color: 'text-amber-400',  bg: 'bg-amber-500/10 border-amber-500/20',  dot: 'bg-amber-400 animate-pulse',  icon: Clock },
  processing: { label: 'Processando', color: 'text-cyan',       bg: 'bg-cyan/10 border-cyan/20',            dot: 'bg-cyan animate-pulse', icon: Loader2 },
  completed:  { label: 'Concluído',   color: 'text-emerald-400',bg: 'bg-emerald-500/10 border-emerald-500/20', dot: 'bg-emerald-400', icon: CheckCircle },
  failed:     { label: 'Erro',        color: 'text-red-400',    bg: 'bg-red-500/10 border-red-500/20',      dot: 'bg-red-400',    icon: XCircle },
  cancelled:  { label: 'Cancelado',   color: 'text-slate-500',  bg: 'bg-slate-500/5 border-slate-500/15',   dot: 'bg-slate-500',  icon: XCircle },
};

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.scheduled;
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-1 text-[10px] font-bold rounded-lg border ${cfg.bg} ${cfg.color}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

function QueueRow({ item, queueType, onDelete }) {
  const isProcessing = item.status === 'processing';
  const isFailed = item.status === 'failed';

  return (
    <div className={`px-4 py-3 border-b border-surface-2/50 transition-all ${isProcessing ? 'bg-cyan/3' : isFailed ? 'bg-red-500/3' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          {/* Nome / ASIN */}
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-mono text-cyan flex-shrink-0">{item.asin || '—'}</span>
            {item.product_name && (
              <span className="text-xs text-slate-300 truncate">{item.product_name}</span>
            )}
            {item.campaign_name && !item.product_name && (
              <span className="text-xs text-slate-400 truncate">{item.campaign_name}</span>
            )}
            {item.keyword && (
              <span className="text-[10px] px-1.5 py-0.5 bg-violet-500/15 border border-violet-500/20 text-violet-400 rounded">
                "{item.keyword}"
              </span>
            )}
          </div>

          {/* Meta info */}
          <div className="flex items-center gap-3 text-[10px] text-slate-500 flex-wrap">
            {item.mode && (
              <span className="text-slate-400 font-medium">{item.mode === 'auto_plus_four' ? 'AUTO + 4 Manuais' : 'Manual Only'}</span>
            )}
            {item.queue_window && <span>Janela: {item.queue_window}</span>}
            {item.attempt_count > 0 && (
              <span className={item.attempt_count >= (item.max_attempts || 5) ? 'text-red-400' : 'text-amber-400'}>
                Tentativas: {item.attempt_count}/{item.max_attempts || 5}
              </span>
            )}
            {item.scheduled_at && (
              <span>Agendado: {new Date(item.scheduled_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
            )}
            {item.completed_at && (
              <span className="text-emerald-400">
                Concluído: {new Date(item.completed_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>

          {/* Erro */}
          {isFailed && item.last_error && item.status !== 'scheduled' && (
            <div className="mt-1.5 px-2.5 py-1.5 bg-red-500/8 border border-red-500/20 rounded-lg">
              <p className="text-[10px] text-red-300 font-mono break-all">{item.last_error}</p>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <StatusBadge status={item.status} />
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

function QueueSection({ title, icon: Icon, color, items, queueType, loading, onDelete, onClearDone }) {
  const counts = {
    scheduled: items.filter(i => i.status === 'scheduled').length,
    processing: items.filter(i => i.status === 'processing').length,
    completed: items.filter(i => i.status === 'completed').length,
    failed: items.filter(i => i.status === 'failed').length,
  };
  const hasCompleted = counts.completed > 0 || items.some(i => i.status === 'cancelled');

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-surface-2 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`w-8 h-8 rounded-xl flex items-center justify-center ${color === 'cyan' ? 'bg-cyan/15 border border-cyan/20' : color === 'amber' ? 'bg-amber-500/15 border border-amber-500/20' : 'bg-violet-500/15 border border-violet-500/20'}`}>
            <Icon className={`w-4 h-4 ${color === 'cyan' ? 'text-cyan' : color === 'amber' ? 'text-amber-400' : 'text-violet-400'}`} />
          </div>
          <div>
            <h2 className="text-sm font-bold text-white">{title}</h2>
            <p className="text-[10px] text-slate-500">{items.length} item{items.length !== 1 ? 's' : ''} na fila</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {/* Contadores */}
          <div className="flex items-center gap-3 text-[10px]">
            {counts.processing > 0 && (
              <span className="flex items-center gap-1 text-cyan font-bold">
                <span className="w-1.5 h-1.5 rounded-full bg-cyan animate-pulse" />{counts.processing} proc.
              </span>
            )}
            {counts.scheduled > 0 && (
              <span className="flex items-center gap-1 text-slate-400">
                <span className="w-1.5 h-1.5 rounded-full bg-slate-500" />{counts.scheduled} ag.
              </span>
            )}
            {counts.completed > 0 && (
              <span className="flex items-center gap-1 text-emerald-400 font-bold">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />{counts.completed} ok
              </span>
            )}
            {counts.failed > 0 && (
              <span className="flex items-center gap-1 text-red-400 font-bold">
                <span className="w-1.5 h-1.5 rounded-full bg-red-400" />{counts.failed} erro
              </span>
            )}
          </div>

          {hasCompleted && (
            <button
              onClick={onClearDone}
              className="text-[10px] text-slate-500 hover:text-slate-300 px-2 py-1 border border-surface-3 rounded-lg transition-colors"
            >
              Limpar concluídos
            </button>
          )}
        </div>
      </div>

      {/* Rows */}
      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="w-5 h-5 text-cyan animate-spin" />
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 gap-2">
          <CheckCircle className="w-8 h-8 text-slate-700" />
          <p className="text-sm text-slate-500">Fila vazia</p>
        </div>
      ) : (
        <div className="divide-y divide-surface-2/0 max-h-80 overflow-y-auto scrollbar-thin">
          {items.map(item => (
            <QueueRow key={item.id} item={item} queueType={queueType} onDelete={onDelete} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function CampaignQueueMonitor() {
  const [account, setAccount] = useState(null);
  const [kickoffQueue, setKickoffQueue] = useState([]);
  const [repairQueue, setRepairQueue] = useState([]);
  const [keywordQueue, setKeywordQueue] = useState([]);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const intervalRef = useRef(null);

  const loadQueues = async (isFirst = false) => {
    if (isFirst) setLoading(true);
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accounts[0];
      if (!acc) return;
      setAccount(acc);

      const [kickoff, repair, keyword] = await Promise.all([
        base44.entities.ProductKickoffQueue.filter({ amazon_account_id: acc.id }, '-scheduled_at', 200),
        base44.entities.AutoCampaignRepairQueue.filter({ amazon_account_id: acc.id }, '-scheduled_at', 200),
        base44.entities.KeywordRepairQueue.filter({ amazon_account_id: acc.id }, '-scheduled_at', 200),
      ]);

      setKickoffQueue(kickoff);
      setRepairQueue(repair);
      setKeywordQueue(keyword);
      setLastRefresh(new Date());
    } finally {
      if (isFirst) setLoading(false);
    }
  };

  useEffect(() => {
    loadQueues(true);
  }, []);

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(() => loadQueues(false), 15000);
    } else {
      clearInterval(intervalRef.current);
    }
    return () => clearInterval(intervalRef.current);
  }, [autoRefresh]);

  const deleteItem = async (entityName, id) => {
    await base44.entities[entityName].delete(id);
    loadQueues(false);
  };

  const clearDone = async (entityName, items) => {
    const done = items.filter(i => ['completed', 'cancelled', 'failed'].includes(i.status));
    await Promise.all(done.map(i => base44.entities[entityName].delete(i.id)));
    loadQueues(false);
  };

  // KPIs globais
  const allItems = [...kickoffQueue, ...repairQueue, ...keywordQueue];
  const totalProcessing = allItems.filter(i => i.status === 'processing').length;
  const totalScheduled = allItems.filter(i => i.status === 'scheduled').length;
  const totalCompleted = allItems.filter(i => i.status === 'completed').length;
  const totalFailed = allItems.filter(i => i.status === 'failed').length;

  const hasActivity = totalProcessing > 0 || totalScheduled > 0;

  return (
    <div className="p-6 space-y-6 animate-fade-in max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Play className="w-5 h-5 text-cyan" />
            Fila de Processamento
          </h1>
          <p className="text-sm text-slate-400 mt-0.5">
            Monitoramento em tempo real das filas de kickoff e reparo de campanhas
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastRefresh && (
            <span className="text-[10px] text-slate-500">
              Atualizado: {lastRefresh.toLocaleTimeString('pt-BR')}
            </span>
          )}
          <button
            onClick={() => setAutoRefresh(v => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-colors ${
              autoRefresh
                ? 'bg-cyan/15 border-cyan/30 text-cyan'
                : 'bg-surface-2 border-surface-3 text-slate-400'
            }`}
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

      {/* KPI bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Processando', value: totalProcessing, color: 'text-cyan', bg: 'border-cyan/20', pulse: true },
          { label: 'Agendados',   value: totalScheduled,  color: 'text-slate-300', bg: 'border-surface-3', pulse: false },
          { label: 'Concluídos',  value: totalCompleted,  color: 'text-emerald-400', bg: 'border-emerald-500/20', pulse: false },
          { label: 'Com Erro',    value: totalFailed,     color: 'text-red-400', bg: 'border-red-500/20', pulse: false },
        ].map(({ label, value, color, bg, pulse }) => (
          <div key={label} className={`bg-surface-1 rounded-xl border ${bg} px-4 py-3 text-center`}>
            <p className="text-xs text-slate-500 mb-1">{label}</p>
            <p className={`text-2xl font-bold ${color} ${pulse && value > 0 ? 'animate-pulse' : ''}`}>{value}</p>
          </div>
        ))}
      </div>

      {/* Alerta de atividade */}
      {hasActivity && (
        <div className="flex items-center gap-3 px-4 py-3 bg-cyan/5 border border-cyan/20 rounded-xl">
          <Loader2 className="w-4 h-4 text-cyan animate-spin flex-shrink-0" />
          <p className="text-sm text-cyan">
            {totalProcessing > 0 && `${totalProcessing} item(s) em processamento agora. `}
            {totalScheduled > 0 && `${totalScheduled} aguardando janela de execução.`}
          </p>
        </div>
      )}

      {totalFailed > 0 && (
        <div className="flex items-center gap-3 px-4 py-3 bg-red-500/5 border border-red-500/20 rounded-xl">
          <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />
          <p className="text-sm text-red-300">
            {totalFailed} item(s) falharam. Verifique os erros abaixo — o token Amazon Ads pode estar revogado.
          </p>
        </div>
      )}

      {/* Filas */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 text-cyan animate-spin" />
        </div>
      ) : (
        <div className="space-y-4">
          <QueueSection
            title="Kickoff de Produtos"
            icon={Rocket}
            color="violet"
            items={kickoffQueue}
            queueType="ProductKickoffQueue"
            loading={false}
            onDelete={id => deleteItem('ProductKickoffQueue', id)}
            onClearDone={() => clearDone('ProductKickoffQueue', kickoffQueue)}
          />
          <QueueSection
            title="Reparo de Campanhas AUTO"
            icon={Zap}
            color="amber"
            items={repairQueue}
            queueType="AutoCampaignRepairQueue"
            loading={false}
            onDelete={id => deleteItem('AutoCampaignRepairQueue', id)}
            onClearDone={() => clearDone('AutoCampaignRepairQueue', repairQueue)}
          />
          <QueueSection
            title="Reparo de Keywords EXACT"
            icon={Key}
            color="cyan"
            items={keywordQueue}
            queueType="KeywordRepairQueue"
            loading={false}
            onDelete={id => deleteItem('KeywordRepairQueue', id)}
            onClearDone={() => clearDone('KeywordRepairQueue', keywordQueue)}
          />
        </div>
      )}
    </div>
  );
}