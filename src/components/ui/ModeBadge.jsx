export default function ModeBadge({ className = '' }) {
  // We read mode from localStorage as a client-side approximation
  // The real mode comes from the server OPERATION_MODE secret
  const mode = 'mock'; // Will be updated when health check runs

  const config = {
    mock: { label: 'MOCK', color: 'text-amber-400 bg-amber-400/10 border-amber-400/20' },
    hybrid: { label: 'HYBRID', color: 'text-cyan bg-cyan/10 border-cyan/20' },
    real: { label: 'REAL', color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20 animate-pulse-badge' },
  };

  const cfg = config[mode] || config.mock;

  return (
    <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-semibold ${cfg.color} ${className}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {cfg.label}
    </div>
  );
}