import { useState, useEffect } from 'react';
import { CheckCircle, Clock, Zap } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// Janela operacional: 03:00–06:00 BRT
const WINDOW_START = 3; // hora BRT
const WINDOW_END = 6;   // hora BRT

// Pipeline diário de automações na janela 03:00–06:00 BRT
const PIPELINE = [
  { time: '03:00', label: 'Relatórios Amazon Ads' },
  { time: '03:15', label: 'Termos Iniciais (produtos novos)' },
  { time: '03:30', label: 'Bids & Harvest' },
  { time: '03:45', label: 'Keyword Discovery' },
  { time: '04:00', label: 'Inventário + Kick-off' },
  { time: '04:15', label: 'Aprendizado AUTO' },
  { time: '04:30', label: 'Motor Determinístico' },
  { time: '04:45', label: 'Dayparting' },
  { time: '05:00', label: 'Outcomes de Decisões' },
  { time: '05:15', label: 'Monitor de Regras' },
];

function getBRTHour() {
  // Offset BRT = UTC-3
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
  // Calcular tempo até próxima janela
  let hoursUntil = brtHour < WINDOW_START
    ? WINDOW_START - brtHour
    : (24 - brtHour) + WINDOW_START;
  const totalMins = Math.round(hoursUntil * 60);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return { active: false, nextIn: h > 0 ? `${h}h${m > 0 ? `${m}min` : ''}` : `${m}min` };
}

// Tarefa que estaria rodando agora (ou a última executada)
function getCurrentTask(brtHour) {
  const hm = brtHour;
  for (let i = PIPELINE.length - 1; i >= 0; i--) {
    const [h, m] = PIPELINE[i].time.split(':').map(Number);
    if (hm >= h + m / 60) return PIPELINE[i];
  }
  return null;
}

// Calcula % de atividades da última janela que tiveram sucesso (via SyncExecutionLog)
function useWindowSuccessRate() {
  const [rate, setRate] = useState(null);
  const [lastWindowAt, setLastWindowAt] = useState(null);

  useEffect(() => {
    async function load() {
      try {
        // Busca os últimos logs de sync
        const runs = await base44.entities.SyncExecutionLog.filter({}, '-started_at', 30);
        if (!runs || runs.length === 0) return;

        // Última janela: define início da última janela 03:00–06:00 BRT
        const now = new Date();
        // Calcula meia-noite UTC de hoje e adiciona 6h (03h BRT = 06h UTC)
        const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const windowEndUTC = new Date(todayUTC.getTime() + 6 * 3600000); // 06:00 UTC = 03:00 BRT
        const windowStartUTC = new Date(windowEndUTC.getTime() - 3 * 3600000); // janela de 3h

        // Se ainda não passou a janela de hoje, usa a de ontem
        const windowEnd = now.getTime() < windowEndUTC.getTime()
          ? new Date(windowEndUTC.getTime() - 24 * 3600000)
          : windowEndUTC;
        const windowStart = new Date(windowEnd.getTime() - 3 * 3600000);

        // Filtra logs dentro da última janela
        const windowRuns = runs.filter(r => {
          const ts = new Date(r.started_at || r.created_date || 0).getTime();
          return ts >= windowStart.getTime() && ts <= windowEnd.getTime();
        });

        if (windowRuns.length === 0) {
          // Sem logs recentes — usa todos os últimos 10
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

  // Formata data/hora da última janela
  const lastWindowStr = lastWindowAt
    ? lastWindowAt.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : null;

  const rateColor = rate === null ? 'text-slate-500'
    : rate >= 80 ? 'text-emerald-400'
    : rate >= 50 ? 'text-amber-400'
    : 'text-red-400';

  if (active) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0" />
        <div className="text-[11px]">
          <span className="text-emerald-300 font-semibold">Janela ativa</span>
          {currentTask && <span className="text-slate-400 ml-1">· {currentTask.label}</span>}
          <span className="text-slate-500 ml-1">({minutesLeft}min restantes)</span>
          {rate !== null && (
            <span className={`ml-1.5 font-semibold ${rateColor}`}>· {rate}% OK</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-2 border border-surface-3 rounded-lg" title={`Pipeline automático: ${PIPELINE.map(p => `${p.time} ${p.label}`).join(' · ')}`}>
      <Clock className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
      <div className="text-[11px] flex items-center gap-1 flex-wrap">
        {lastWindowStr ? (
          <span className="text-slate-400">Atualizado em {lastWindowStr}</span>
        ) : (
          <span className="text-slate-400">Automações 03h–06h BRT</span>
        )}
        <span className="text-slate-600">· próxima em {nextIn}</span>
        {rate !== null && (
          <span className={`font-bold ${rateColor}`}>· {rate}% implementadas</span>
        )}
      </div>
    </div>
  );
}