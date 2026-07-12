import { useState, useEffect } from 'react';
import { Clock } from 'lucide-react';
import { base44 } from '@/api/base44Client';

const WINDOW_START = 16;
const WINDOW_END = 18;

const PIPELINE = [
  { time: '16:00', label: 'Leitura dos relatórios recentes' },
  { time: '16:10', label: 'Motor determinístico e IA' },
  { time: '16:20', label: 'Alterações de bids' },
  { time: '16:40', label: 'Keywords e negativas' },
  { time: '17:00', label: 'Criação e reparo de campanhas' },
  { time: '17:30', label: 'Budgets, estados e demais edições' },
  { time: '17:50', label: 'Confirmação e auditoria Amazon' },
];

function getBRTHour() {
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  return ((utcH - 3 + 24) % 24) + utcM / 60;
}

function getNextWindowInfo() {
  const brtHour = getBRTHour();
  if (brtHour >= WINDOW_START && brtHour < WINDOW_END) {
    const minutesLeft = Math.round((WINDOW_END - brtHour) * 60);
    return { active: true, minutesLeft };
  }
  const hoursUntil = brtHour < WINDOW_START
    ? WINDOW_START - brtHour
    : (24 - brtHour) + WINDOW_START;
  const totalMins = Math.round(hoursUntil * 60);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return { active: false, nextIn: h > 0 ? `${h}h${m > 0 ? `${m}min` : ''}` : `${m}min` };
}

function getCurrentTask(brtHour) {
  for (let i = PIPELINE.length - 1; i >= 0; i--) {
    const [h, m] = PIPELINE[i].time.split(':').map(Number);
    if (brtHour >= h + m / 60) return PIPELINE[i];
  }
  return null;
}

function useWindowSuccessRate() {
  const [rate, setRate] = useState(null);
  const [lastWindowAt, setLastWindowAt] = useState(null);

  useEffect(() => {
    async function load() {
      try {
        const runs = await base44.entities.SyncExecutionLog.filter({}, '-started_at', 50);
        if (!runs?.length) return;

        const now = new Date();
        const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        // 16:00 BRT = 19:00 UTC; 18:00 BRT = 21:00 UTC.
        const todayStartUTC = new Date(todayUTC.getTime() + 19 * 3600000);
        const todayEndUTC = new Date(todayUTC.getTime() + 21 * 3600000);
        const windowEnd = now.getTime() < todayEndUTC.getTime()
          ? new Date(todayEndUTC.getTime() - 24 * 3600000)
          : todayEndUTC;
        const windowStart = new Date(windowEnd.getTime() - 2 * 3600000);

        const windowRuns = runs.filter(r => {
          const ts = new Date(r.started_at || r.created_date || 0).getTime();
          return ts >= windowStart.getTime() && ts <= windowEnd.getTime();
        });

        if (!windowRuns.length) {
          const recentRuns = runs.slice(0, 10);
          const successes = recentRuns.filter(r => r.status === 'success' || r.status === 'skipped_limit').length;
          setRate(recentRuns.length > 0 ? Math.round(successes / recentRuns.length * 100) : null);
          setLastWindowAt(recentRuns[0] ? new Date(recentRuns[0].started_at || recentRuns[0].created_date) : null);
        } else {
          const successes = windowRuns.filter(r => r.status === 'success' || r.status === 'skipped_limit').length;
          setRate(Math.round(successes / windowRuns.length * 100));
          setLastWindowAt(windowEnd);
        }
      } catch {}
    }
    load();
  }, []);

  return { rate, lastWindowAt };
}

export default function AutoWindowStatus() {
  const brtHour = getBRTHour();
  const { active, minutesLeft, nextIn } = getNextWindowInfo();
  const currentTask = active ? getCurrentTask(brtHour) : null;
  const { rate, lastWindowAt } = useWindowSuccessRate();

  const lastWindowStr = lastWindowAt
    ? lastWindowAt.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : null;

  const rateColor = rate === null ? 'text-slate-500'
    : rate >= 80 ? 'text-emerald-400'
    : rate >= 50 ? 'text-amber-400'
    : 'text-red-400';

  if (active) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-emerald-500/10 border border-emerald-500/20 rounded-lg" title={`Pipeline automático: ${PIPELINE.map(p => `${p.time} ${p.label}`).join(' · ')}`}>
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0" />
        <div className="text-[11px] flex items-center gap-1 flex-wrap">
          <span className="text-emerald-300 font-semibold">Janela Amazon ativa 16h–18h</span>
          {currentTask && <span className="text-slate-400">· {currentTask.label}</span>}
          <span className="text-slate-500">({minutesLeft}min restantes)</span>
          {rate !== null && <span className={`font-semibold ${rateColor}`}>· {rate}% OK</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-2 border border-surface-3 rounded-lg" title={`Pipeline automático: ${PIPELINE.map(p => `${p.time} ${p.label}`).join(' · ')}`}>
      <Clock className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
      <div className="text-[11px] flex items-center gap-1 flex-wrap">
        {lastWindowStr ? (
          <span className="text-slate-400">Última janela: {lastWindowStr}</span>
        ) : (
          <span className="text-slate-400">Operações Amazon 16h–18h BRT</span>
        )}
        <span className="text-slate-600">· próxima em {nextIn}</span>
        {rate !== null && <span className={`font-bold ${rateColor}`}>· {rate}% implementadas</span>}
      </div>
    </div>
  );
}