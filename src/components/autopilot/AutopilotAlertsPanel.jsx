import { base44 } from '@/api/base44Client';
import { AlertTriangle, AlertCircle, Info, X } from 'lucide-react';

const SEVERITY_CONFIG = {
  critical: { icon: AlertCircle, color: 'text-red-400 border-red-400/20 bg-red-400/5', label: 'Crítico' },
  warning: { icon: AlertTriangle, color: 'text-amber-400 border-amber-400/20 bg-amber-400/5', label: 'Atenção' },
  info: { icon: Info, color: 'text-cyan border-cyan/20 bg-cyan/5', label: 'Info' },
};

export default function AutopilotAlertsPanel({ alerts, onDismiss }) {
  if (!alerts?.length) return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-6 text-center">
      <p className="text-sm text-slate-500">Nenhum alerta ativo. Sistema operando normalmente.</p>
    </div>
  );

  return (
    <div className="space-y-2">
      {alerts.map(alert => {
        const cfg = SEVERITY_CONFIG[alert.severity] || SEVERITY_CONFIG.warning;
        const Icon = cfg.icon;
        return (
          <div key={alert.id} className={`flex items-start gap-3 p-4 border rounded-xl ${cfg.color}`}>
            <Icon className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-xs font-bold uppercase">{cfg.label}</span>
                {alert.entity_name && <span className="text-xs opacity-70 truncate">{alert.entity_name}</span>}
              </div>
              <p className="text-xs leading-relaxed">{alert.message}</p>
              {alert.value != null && alert.threshold != null && (
                <p className="text-xs opacity-60 mt-0.5">Valor: {alert.value?.toFixed(2)} · Limite: {alert.threshold}</p>
              )}
            </div>
            <button onClick={() => onDismiss(alert.id)}
              className="flex-shrink-0 opacity-60 hover:opacity-100 transition-opacity">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}