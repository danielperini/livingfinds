import React, { useState } from 'react';
import { Database, Zap, Calculator, Globe, Brain, ChevronDown, ChevronUp, CheckCircle } from 'lucide-react';

const SOURCES = [
  {
    step: 1,
    icon: Database,
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/10 border-emerald-500/20',
    dot: 'bg-emerald-400',
    label: 'Banco de dados',
    desc: 'Leitura primária — campanhas, métricas, produtos do banco local.',
  },
  {
    step: 2,
    icon: Zap,
    color: 'text-cyan',
    bg: 'bg-cyan/10 border-cyan/20',
    dot: 'bg-cyan',
    label: 'Cache válido',
    desc: 'ApiCallCache e AIAnalysisCache usados enquanto TTL não expirou.',
  },
  {
    step: 3,
    icon: Calculator,
    color: 'text-amber-400',
    bg: 'bg-amber-500/10 border-amber-500/20',
    dot: 'bg-amber-400',
    label: 'Regra matemática',
    desc: 'Motor determinístico: ACoS, ROAS, bid, budget — sem IA, sem API.',
  },
  {
    step: 4,
    icon: Globe,
    color: 'text-orange-400',
    bg: 'bg-orange-500/10 border-orange-500/20',
    dot: 'bg-orange-400',
    label: 'API Amazon',
    desc: 'Chamada real somente quando dado está vencido (sync janela noturna/manhã).',
  },
  {
    step: 5,
    icon: Brain,
    color: 'text-purple-400',
    bg: 'bg-purple-500/10 border-purple-500/20',
    dot: 'bg-purple-400',
    label: 'IA (Claude)',
    desc: 'Acionada apenas para decisões estratégicas ou ambíguas — revisão semanal.',
  },
];

export default function DataSourcePriorityBanner() {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-2/50 transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <div className="flex items-center gap-1">
            {SOURCES.map(s => (
              <div key={s.step} className={`w-2 h-2 rounded-full ${s.dot}`} />
            ))}
          </div>
          <span className="text-xs font-semibold text-slate-300">Hierarquia de Fontes de Dados</span>
          <span className="text-[10px] text-slate-500 bg-surface-2 px-1.5 py-0.5 rounded hidden sm:inline">
            DB → Cache → Matemática → API → IA
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-emerald-400 flex items-center gap-1">
            <CheckCircle className="w-3 h-3" /> Ativo
          </span>
          {expanded
            ? <ChevronUp className="w-3.5 h-3.5 text-slate-500" />
            : <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
          }
        </div>
      </button>

      {expanded && (
        <div className="border-t border-surface-2 px-4 py-4">
          <p className="text-xs text-slate-500 mb-3">
            Cada consulta percorre esta ordem. A API Amazon e a IA só são acionadas como último recurso.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
            {SOURCES.map((s, i) => {
              const Icon = s.icon;
              return (
                <div key={s.step} className="flex sm:flex-col items-start gap-2">
                  {i > 0 && (
                    <div className="hidden sm:flex items-center justify-center w-full -mt-1 mb-1">
                      <div className="text-slate-600 text-[10px]">↓</div>
                    </div>
                  )}
                  <div className={`flex-1 sm:w-full px-3 py-2.5 rounded-lg border ${s.bg}`}>
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className={`text-[10px] font-bold ${s.color}`}>{s.step}</span>
                      <Icon className={`w-3.5 h-3.5 ${s.color}`} />
                      <span className={`text-xs font-semibold ${s.color}`}>{s.label}</span>
                    </div>
                    <p className="text-[10px] text-slate-400 leading-relaxed">{s.desc}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}