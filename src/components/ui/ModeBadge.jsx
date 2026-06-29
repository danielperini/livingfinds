export default function ModeBadge({ mode, className = '' }) {
  return (
    <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-semibold text-emerald-400 bg-emerald-400/10 border-emerald-400/20 ${className}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      REAL
    </div>
  );
}