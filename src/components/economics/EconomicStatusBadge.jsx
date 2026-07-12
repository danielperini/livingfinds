export const ECON_STATUS_LABELS = {
  complete: { label: 'Completo', color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' },
  partial: { label: 'Parcial', color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/20' },
  missing_cost: { label: 'Sem custo', color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/20' },
  missing_price: { label: 'Sem preço', color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/20' },
  missing_fees: { label: 'Sem tarifas', color: 'text-slate-400', bg: 'bg-slate-500/10 border-slate-500/20' },
  invalid: { label: 'Inválido', color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/20' },
  stale: { label: 'Desatualizado', color: 'text-slate-400', bg: 'bg-slate-500/10 border-slate-500/20' },
};

export const ECON_CLASS_LABELS = {
  highly_profitable: { label: '💚 Alta Margem', color: 'text-emerald-400' },
  profitable: { label: '✅ Lucrativo', color: 'text-emerald-400' },
  low_margin: { label: '🟡 Baixa Margem', color: 'text-amber-400' },
  break_even: { label: '⚖ Break-even', color: 'text-amber-400' },
  unprofitable: { label: '🔴 Prejuízo', color: 'text-red-400' },
  no_sales: { label: '⏸ Sem Vendas', color: 'text-slate-400' },
  unknown: { label: '⬜ Sem dados', color: 'text-slate-500' },
};

export default function EconomicStatusBadge({ status, classification, compact = false }) {
  const st = ECON_STATUS_LABELS[status] || ECON_STATUS_LABELS.partial;
  const cl = ECON_CLASS_LABELS[classification] || ECON_CLASS_LABELS.unknown;

  if (compact) {
    return (
      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${st.bg} ${st.color}`}>
        {st.label}
      </span>
    );
  }

  return (
    <div className="space-y-1">
      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${st.bg} ${st.color}`}>
        {st.label}
      </span>
      {classification && classification !== 'unknown' && (
        <p className={`text-[10px] ${cl.color}`}>{cl.label}</p>
      )}
    </div>
  );
}