export default function StatusBadge({ status, size = 'sm' }) {
  const config = {
    enabled: { label: 'Ativo', color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
    active: { label: 'Ativo', color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
    connected: { label: 'Conectado', color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
    paused: { label: 'Pausado', color: 'text-amber-400 bg-amber-400/10 border-amber-400/20' },
    pending: { label: 'Pendente', color: 'text-amber-400 bg-amber-400/10 border-amber-400/20' },
    archived: { label: 'Arquivado', color: 'text-slate-400 bg-slate-400/10 border-slate-400/20' },
    incomplete: { label: 'Incompleta', color: 'text-orange-400 bg-orange-400/10 border-orange-400/20' },
    review_required: { label: 'Revisão', color: 'text-amber-400 bg-amber-400/10 border-amber-400/20' },
    error: { label: 'Erro', color: 'text-red-400 bg-red-400/10 border-red-400/20' },
    running: { label: 'Sincronizando', color: 'text-cyan bg-cyan/10 border-cyan/20' },
    success: { label: 'Concluído', color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
    approved: { label: 'Aprovado', color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
    executed: { label: 'Executado', color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
    rejected: { label: 'Rejeitado', color: 'text-red-400 bg-red-400/10 border-red-400/20' },
    failed: { label: 'Falhou', color: 'text-red-400 bg-red-400/10 border-red-400/20' },
    disconnected: { label: 'Desconectado', color: 'text-slate-400 bg-slate-400/10 border-slate-400/20' },
    high: { label: 'Alta', color: 'text-red-400 bg-red-400/10 border-red-400/20' },
    medium: { label: 'Média', color: 'text-amber-400 bg-amber-400/10 border-amber-400/20' },
    low: { label: 'Baixa', color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
  };

  const cfg = config[status] || { label: status, color: 'text-slate-400 bg-slate-400/10 border-slate-400/20' };
  const sizeClass = size === 'xs' ? 'text-xs px-1.5 py-0.5' : 'text-xs px-2.5 py-1';

  return (
    <span className={`inline-flex items-center gap-1 rounded-full border font-medium ${cfg.color} ${sizeClass}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {cfg.label}
    </span>
  );
}