import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Clock, CheckCircle, XCircle, Loader2, ChevronDown, ChevronUp, AlertTriangle, Minus } from 'lucide-react';

const CHECKPOINTS = [
  { key: 'morning',   hour: 6,  label: '06h', operation: 'budget_checkpoint_morning',   desc: 'Calibração Matinal' },
  { key: 'afternoon', hour: 13, label: '13h', operation: 'budget_checkpoint_afternoon', desc: 'Rebalanceamento Meio-Dia' },
  { key: 'evening',   hour: 19, label: '19h', operation: 'budget_checkpoint_evening',   desc: 'Proteção Noturna' },
  { key: 'night',     hour: 22, label: '22h', operation: 'budget_checkpoint_night',     desc: 'Proteção Final' },
];

function fmtBRL(v) {
  if (v == null) return '—';
  return `R$${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function parseResult(log) {
  if (!log?.result_summary) return null;
  try { return JSON.parse(log.result_summary); } catch { return null; }
}

function StatusIcon({ status }) {
  if (status === 'success')  return <CheckCircle className="w-4 h-4 text-emerald-400" />;
  if (status === 'skipped')  return <Minus className="w-4 h-4 text-slate-500" />;
  if (status === 'error')    return <XCircle className="w-4 h-4 text-red-400" />;
  return <Clock className="w-4 h-4 text-slate-600" />;
}

function CheckpointCard({ cp, log, currentHourBRT }) {
  const [expanded, setExpanded] = useState(false);
  const result = parseResult(log);
  const isPast = currentHourBRT > cp.hour;
  const isCurrent = currentHourBRT === cp.hour || (currentHourBRT > cp.hour && currentHourBRT < (CHECKPOINTS.find(c => c.hour > cp.hour)?.hour ?? 25));
  const status = log ? log.status : isPast ? 'pending' : 'waiting';

  const statusCfg = {
    success:  { label: 'Executado',   color: 'text-emerald-400', border: 'border-emerald-500/20', bg: 'bg-emerald-500/5' },
    skipped:  { label: 'Pulado',      color: 'text-slate-400',   border: 'border-slate-500/20',   bg: 'bg-slate-500/5' },
    error:    { label: 'Erro',        color: 'text-red-400',     border: 'border-red-500/20',     bg: 'bg-red-500/5' },
    pending:  { label: 'Pendente',    color: 'text-amber-400',   border: 'border-amber-500/20',   bg: 'bg-amber-500/5' },
    waiting:  { label: 'Aguardando',  color: 'text-slate-500',   border: 'border-surface-2',      bg: 'bg-surface-2/30' },
  };
  const cfg = statusCfg[status] || statusCfg.waiting;

  return (
    <div className={`border rounded-xl overflow-hidden transition-colors ${cfg.border} ${cfg.bg} ${isCurrent && !log ? 'ring-1 ring-cyan/20' : ''}`}>
      <button
        className="w-full flex items-center gap-3 px-4 py-3 text-left"
        onClick={() => log && setExpanded(v => !v)}
      >
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 font-bold text-xs ${isCurrent && !log ? 'bg-cyan/15 border border-cyan/30 text-cyan' : 'bg-surface-2 text-slate-400'}`}>
          {cp.label}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-white">{cp.desc}</p>
          <p className="text-[10px] text-slate-500 mt-0.5">
            {log?.started_at
              ? new Date(log.started_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
              : `Executa às ${cp.label} BRT`}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {result?.confirmed_spend != null && (
            <span className="text-[10px] text-cyan font-mono hidden sm:block">{fmtBRL(result.confirmed_spend)}</span>
          )}
          {result?.deviation_pct != null && (
            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full border hidden sm:block ${
              Math.abs(result.deviation_pct) > 15
                ? 'text-amber-400 bg-amber-500/10 border-amber-500/20'
                : 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
            }`}>
              {result.deviation_pct > 0 ? '+' : ''}{result.deviation_pct?.toFixed(1)}%
            </span>
          )}
          <StatusIcon status={status} />
          <span className={`text-[10px] font-semibold ${cfg.color}`}>{cfg.label}</span>
          {log && (expanded ? <ChevronUp className="w-3.5 h-3.5 text-slate-500" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-500" />)}
        </div>
      </button>

      {/* Detalhes expandidos */}
      {expanded && result && (
        <div className="border-t border-surface-2/50 px-4 py-3 space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {result.confirmed_spend != null && (
              <div className="bg-surface-1/60 rounded-lg p-2">
                <p className="text-[9px] text-slate-500 mb-0.5">Gasto Confirmado</p>
                <p className="text-sm font-bold text-cyan">{fmtBRL(result.confirmed_spend)}</p>
              </div>
            )}
            {result.projected_eod != null && (
              <div className="bg-surface-1/60 rounded-lg p-2">
                <p className="text-[9px] text-slate-500 mb-0.5">Projetado EOD</p>
                <p className={`text-sm font-bold ${result.projected_eod > (result.daily_cap || 0) ? 'text-red-400' : 'text-amber-400'}`}>{fmtBRL(result.projected_eod)}</p>
              </div>
            )}
            {result.deviation_pct != null && (
              <div className="bg-surface-1/60 rounded-lg p-2">
                <p className="text-[9px] text-slate-500 mb-0.5">Desvio de Pacing</p>
                <p className={`text-sm font-bold ${Math.abs(result.deviation_pct) > 15 ? 'text-amber-400' : 'text-emerald-400'}`}>
                  {result.deviation_pct > 0 ? '+' : ''}{result.deviation_pct?.toFixed(1)}%
                </p>
              </div>
            )}
            {result.scheduled_pause_hour != null && (
              <div className="bg-surface-1/60 rounded-lg p-2">
                <p className="text-[9px] text-slate-500 mb-0.5">Hora de Pausa</p>
                <p className="text-sm font-bold text-red-400">{result.scheduled_pause_hour}h BRT</p>
              </div>
            )}
          </div>

          {result.actions_taken?.length > 0 && (
            <div className="space-y-1">
              <p className="text-[10px] font-semibold text-slate-400">Ações tomadas:</p>
              {result.actions_taken.map((a, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  <span className="w-1 h-1 rounded-full bg-cyan mt-1.5 flex-shrink-0" />
                  <p className="text-[10px] text-slate-300">{a}</p>
                </div>
              ))}
            </div>
          )}

          {result.data_source === 'fallback_current_spend' && (
            <div className="flex items-center gap-2 px-2 py-1.5 bg-amber-500/10 border border-amber-500/20 rounded-lg">
              <AlertTriangle className="w-3 h-3 text-amber-400 flex-shrink-0" />
              <p className="text-[10px] text-amber-300">Dados via fallback (relatório ainda não processado)</p>
            </div>
          )}

          {result.budget_boosts > 0 && (
            <p className="text-[10px] text-emerald-400">✓ Budget aumentado em {result.budget_boosts} campanhas vencedoras para cobertura até 23:59</p>
          )}

          {result.skipped && (
            <p className="text-[10px] text-slate-500">Pulado: {result.reason || 'Já executado hoje'}</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function BudgetCheckpointsPanel({ account }) {
  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState({});
  const [loading, setLoading] = useState(false);
  const [currentHour, setCurrentHour] = useState(0);

  useEffect(() => {
    // Hora BRT atual
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false,
    }).formatToParts(new Date());
    setCurrentHour(Number(parts.find(p => p.type === 'hour')?.value || 0) % 24);
  }, []);

  useEffect(() => {
    if (!open || !account) return;
    setLoading(true);
    const load = async () => {
      try {
        const todayBRT = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
        const allLogs = await base44.entities.SyncExecutionLog.filter(
          { amazon_account_id: account.id },
          '-started_at', 20
        ).catch(() => []);

        const todayLogs = allLogs.filter(l => {
          const op = l.operation || '';
          const date = (l.started_at || l.created_date || '').slice(0, 10);
          return date === todayBRT && op.startsWith('budget_checkpoint_');
        });

        const logMap = {};
        for (const cp of CHECKPOINTS) {
          logMap[cp.key] = todayLogs.find(l => l.operation === cp.operation) || null;
        }
        setLogs(logMap);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [open, account]);

  const executedCount = Object.values(logs).filter(l => l?.status === 'success').length;

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-2/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-slate-400" />
          <p className="text-xs font-semibold text-slate-200">Checkpoints do Dia</p>
          {executedCount > 0 && (
            <span className="text-[10px] px-2 py-0.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-full">
              {executedCount}/4 executados
            </span>
          )}
          <span className="text-[10px] text-slate-500">06h · 13h · 19h · 22h BRT</span>
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
      </button>

      {open && (
        <div className="border-t border-surface-2 px-4 pb-4 pt-3">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 text-cyan animate-spin" />
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {CHECKPOINTS.map(cp => (
                <CheckpointCard
                  key={cp.key}
                  cp={cp}
                  log={logs[cp.key]}
                  currentHourBRT={currentHour}
                />
              ))}
            </div>
          )}

          <p className="text-[10px] text-slate-600 mt-3">
            Checkpoints lêem o gasto real via CampaignMetricsDaily e tomam decisões automáticas de pacing, dayparting e budget de campanhas vencedoras.
          </p>
        </div>
      )}
    </div>
  );
}