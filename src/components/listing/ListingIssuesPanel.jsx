import { AlertCircle, AlertTriangle, Info } from 'lucide-react';

const SEVERITY_CONFIG = {
  ERROR: { icon: AlertCircle, color: 'text-red-400', bg: 'bg-red-500/5 border-red-500/20', label: 'Erro' },
  WARNING: { icon: AlertTriangle, color: 'text-amber-400', bg: 'bg-amber-500/5 border-amber-500/20', label: 'Aviso' },
  INFO: { icon: Info, color: 'text-blue-400', bg: 'bg-blue-500/5 border-blue-500/20', label: 'Info' },
};

export default function ListingIssuesPanel({ issues, missingFields, asin, sku }) {
  if (!issues?.length && !missingFields?.length) {
    return (
      <div className="text-center py-10 text-slate-500 text-sm">
        <AlertCircle className="w-8 h-8 text-slate-600 mx-auto mb-3" />
        <p>Nenhum issue encontrado neste listing.</p>
        {!issues && <p className="text-xs mt-1">Sincronize o listing para verificar issues da Amazon.</p>}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Issues Amazon */}
      {issues?.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 text-red-400" /> Issues reportados pela Amazon ({issues.length})
          </p>
          {issues.map((issue, i) => {
            const severity = (issue.severity || issue.code?.startsWith('5') ? 'ERROR' : 'WARNING').toUpperCase();
            const config = SEVERITY_CONFIG[severity] || SEVERITY_CONFIG.WARNING;
            const Icon = config.icon;
            return (
              <div key={i} className={`rounded-xl p-4 border ${config.bg} space-y-2`}>
                <div className="flex items-start gap-2">
                  <Icon className={`w-4 h-4 ${config.color} mt-0.5 flex-shrink-0`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className={`text-[10px] font-bold uppercase ${config.color}`}>{config.label}</span>
                      {issue.code && <span className="font-mono text-[10px] text-slate-500">{issue.code}</span>}
                      {issue.attributeName && (
                        <span className="font-mono text-[10px] bg-surface-2 px-1.5 py-0.5 rounded text-slate-400">{issue.attributeName}</span>
                      )}
                    </div>
                    <p className="text-xs text-slate-300">{issue.message || issue.description || JSON.stringify(issue)}</p>
                    {issue.helpUrl && (
                      <a href={issue.helpUrl} target="_blank" rel="noopener noreferrer"
                        className="text-[10px] text-cyan hover:underline mt-1 block">
                        Ver documentação Amazon →
                      </a>
                    )}
                  </div>
                </div>
                <div className="ml-6 text-[10px] text-slate-500 space-y-0.5">
                  <p><strong className="text-slate-400">ASIN:</strong> {asin} · <strong className="text-slate-400">SKU:</strong> {sku}</p>
                  {issue.attributeName && <p><strong className="text-slate-400">Campo:</strong> {issue.attributeName}</p>}
                  {issue.remediation && <p><strong className="text-slate-400">Correção:</strong> {issue.remediation}</p>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Campos ausentes */}
      {missingFields?.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400" /> Campos obrigatórios ausentes ({missingFields.length})
          </p>
          <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4">
            <div className="flex flex-wrap gap-2">
              {missingFields.map((field, i) => (
                <span key={i} className="px-2 py-1 bg-surface-2 rounded-lg text-[10px] font-mono text-amber-400 border border-amber-500/20">
                  {field}
                </span>
              ))}
            </div>
            <p className="text-[10px] text-slate-500 mt-3">
              Preencha esses campos para reduzir rejeições, melhorar filtros da Amazon e aumentar a visibilidade do produto.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}