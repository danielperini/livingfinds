// Componente auxiliar para exibir diff entre valor atual e proposto
export default function ListingDiffViewer({ currentValue, proposedValue, fieldName }) {
  if (!currentValue && !proposedValue) return null;

  return (
    <div className="space-y-1.5">
      {fieldName && <p className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider">{fieldName}</p>}
      <div className="grid grid-cols-2 gap-2">
        <div className="bg-red-500/5 border border-red-500/15 rounded-lg p-3">
          <p className="text-[9px] text-slate-500 mb-1.5 uppercase tracking-wider">Atual</p>
          <p className="text-xs text-slate-300 whitespace-pre-wrap break-words">{currentValue || '(vazio)'}</p>
        </div>
        <div className="bg-emerald-500/5 border border-emerald-500/15 rounded-lg p-3">
          <p className="text-[9px] text-slate-500 mb-1.5 uppercase tracking-wider">Proposto</p>
          <p className="text-xs text-emerald-300 whitespace-pre-wrap break-words">{proposedValue || '(vazio)'}</p>
        </div>
      </div>
    </div>
  );
}