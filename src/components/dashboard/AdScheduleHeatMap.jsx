import React from 'react';
import { Clock, Loader2 } from 'lucide-react';

export default function AdScheduleHeatMap({ hourlyMetrics, loading }) {
  // Heat map data - dias do mês vs horas
  const heatMapData = hourlyMetrics.reduce((acc, h) => {
    const day = h.date ? new Date(h.date).getDate() : 1;
    const hour = h.hour ?? 0;
    const key = `${day}-${hour}`;
    if (!acc[key]) {
      acc[key] = { day, hour, spend: 0, sales: 0, impressions: 0, clicks: 0, active: false };
    }
    acc[key].spend += h.spend || 0;
    acc[key].sales += h.sales || 0;
    acc[key].impressions += h.impressions || 0;
    acc[key].clicks += h.clicks || 0;
    acc[key].active = acc[key].spend > 0;
    return acc;
  }, {});
  const heatMapArray = Object.values(heatMapData);

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
          <Clock className="w-4 h-4 text-cyan" />
          Horário de Veiculação dos Ads
        </h2>
        <span className="text-xs text-slate-500">Últimos 30 dias</span>
      </div>
      {loading ? (
        <div className="h-64 flex items-center justify-center"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
      ) : heatMapArray.length > 0 ? (
        <div className="overflow-x-auto">
          <div className="min-w-[600px]">
            <div className="grid gap-1" style={{ gridTemplateColumns: '40px repeat(24, 1fr)' }}>
              {/* Header - Horas */}
              <div className="text-[9px] text-slate-500 font-semibold">Dia</div>
              {Array.from({ length: 24 }, (_, h) => (
                <div key={h} className="text-[9px] text-slate-500 text-center font-semibold">{h}</div>
              ))}
              
              {/* Dias */}
              {Array.from({ length: 30 }, (_, d) => (
                <React.Fragment key={d}>
                  <div className="text-[9px] text-slate-400 text-right pr-2">{d + 1}</div>
                  {Array.from({ length: 24 }, (_, h) => {
                    const cell = heatMapArray.find(c => c.day === d + 1 && c.hour === h);
                    const intensity = cell 
                      ? cell.spend > 5 ? 'bg-cyan/60' 
                        : cell.spend > 2 ? 'bg-cyan/40'
                        : cell.spend > 0 ? 'bg-cyan/20'
                        : 'bg-surface-2'
                      : 'bg-surface-2';
                    const isBudgetExceeded = cell && cell.spend > 10;
                    return (
                      <div
                        key={h}
                        className={`h-3 rounded-sm ${intensity} ${isBudgetExceeded ? 'ring-1 ring-amber-400/50' : ''}`}
                        title={`Dia ${d + 1} · ${h}:00 · Spend: $${(cell?.spend || 0).toFixed(2)}`}
                      />
                    );
                  })}
                </React.Fragment>
              ))}
            </div>
            <div className="flex items-center gap-4 mt-3 text-[10px] text-slate-500">
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 rounded-sm bg-surface-2" /> Sem veiculação
              </div>
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 rounded-sm bg-cyan/20" /> Baixo spend
              </div>
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 rounded-sm bg-cyan/40" /> Médio spend
              </div>
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 rounded-sm bg-cyan/60" /> Alto spend
              </div>
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 rounded-sm ring-1 ring-amber-400/50" /> Budget excedido
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="h-64 flex flex-col items-center justify-center text-sm text-slate-500">
          <Clock className="w-8 h-8 text-slate-600 mb-2" />
          Sem dados horários. Execute um Sync completo.
        </div>
      )}
    </div>
  );
}