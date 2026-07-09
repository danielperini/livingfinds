import { CheckCircle, Clock, Zap } from 'lucide-react';

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

export default function AutoWindowStatus() {
  const brtHour = getBRTHour();
  const { active, minutesLeft, nextIn } = getNextWindowInfo();
  const currentTask = active ? getCurrentTask(brtHour) : null;

  if (active) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0" />
        <div className="text-[11px]">
          <span className="text-emerald-300 font-semibold">Janela ativa</span>
          {currentTask && <span className="text-slate-400 ml-1">· {currentTask.label}</span>}
          <span className="text-slate-500 ml-1">({minutesLeft}min restantes)</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-2 border border-surface-3 rounded-lg" title={`Pipeline automático: ${PIPELINE.map(p => `${p.time} ${p.label}`).join(' · ')}`}>
      <Clock className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
      <div className="text-[11px]">
        <span className="text-slate-400">Automações 03h–06h BRT</span>
        <span className="text-slate-600 ml-1">· próxima em {nextIn}</span>
      </div>
    </div>
  );
}