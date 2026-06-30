import { Clock, TrendingUp, TrendingDown, Minus, AlertCircle } from 'lucide-react';

const classificationConfig = {
  peak_high_profit: {
    label: 'Pico Alta Rentabilidade',
    color: 'bg-emerald-500',
    textColor: 'text-emerald-400',
    borderColor: 'border-emerald-500',
  },
  peak_conversion: {
    label: 'Pico Conversão',
    color: 'bg-green-500',
    textColor: 'text-green-400',
    borderColor: 'border-green-500',
  },
  peak_traffic: {
    label: 'Pico Tráfego',
    color: 'bg-cyan-500',
    textColor: 'text-cyan-400',
    borderColor: 'border-cyan-500',
  },
  efficient: {
    label: 'Eficiente',
    color: 'bg-blue-500',
    textColor: 'text-blue-400',
    borderColor: 'border-blue-500',
  },
  neutral: {
    label: 'Neutro',
    color: 'bg-slate-500',
    textColor: 'text-slate-400',
    borderColor: 'border-slate-500',
  },
  discovery: {
    label: 'Descoberta',
    color: 'bg-indigo-500',
    textColor: 'text-indigo-400',
    borderColor: 'border-indigo-500',
  },
  low_efficiency: {
    label: 'Baixa Eficiência',
    color: 'bg-amber-500',
    textColor: 'text-amber-400',
    borderColor: 'border-amber-500',
  },
  deficit: {
    label: 'Deficitário',
    color: 'bg-red-500',
    textColor: 'text-red-400',
    borderColor: 'border-red-500',
  },
  insufficient_data: {
    label: 'Dados Insuficientes',
    color: 'bg-slate-700',
    textColor: 'text-slate-500',
    borderColor: 'border-slate-700',
  },
};

export default function HourClassification({ classifications }) {
  if (!classifications || classifications.length === 0) {
    return (
      <div className="flex items-center justify-center py-10">
        <p className="text-sm text-slate-500">Nenhuma classificação disponível.</p>
      </div>
    );
  }

  // Agrupar por classificação
  const byClass = {};
  for (const c of classifications) {
    if (!byClass[c.classification]) {
      byClass[c.classification] = [];
    }
    byClass[c.classification].push(c);
  }

  const sortedKeys = Object.keys(byClass).sort((a, b) => {
    const order = [
      'peak_high_profit', 'peak_conversion', 'peak_traffic',
      'efficient', 'neutral', 'discovery',
      'low_efficiency', 'deficit', 'insufficient_data'
    ];
    return order.indexOf(a) - order.indexOf(b);
  });

  return (
    <div className="space-y-3">
      {sortedKeys.map(key => {
        const items = byClass[key];
        const config = classificationConfig[key] || classificationConfig.insufficient_data;
        
        return (
          <div key={key} className={`p-3 rounded-lg border ${config.color}/10 ${config.borderColor}/20`}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <div className={`w-3 h-3 rounded-full ${config.color}`} />
                <p className={`text-sm font-semibold ${config.textColor}`}>
                  {config.label}
                </p>
                <span className="text-xs text-slate-500">({items.length} horários)</span>
              </div>
            </div>
            
            <div className="flex flex-wrap gap-1">
              {items.slice(0, 10).map((item, i) => (
                <span
                  key={i}
                  className="text-xs px-2 py-1 rounded bg-surface-2 border border-surface-3 text-slate-300"
                  title={item.rationale}
                >
                  {['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'][item.day]} {item.hour}:00
                </span>
              ))}
              {items.length > 10 && (
                <span className="text-xs px-2 py-1 text-slate-500">
                  +{items.length - 10} mais
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}