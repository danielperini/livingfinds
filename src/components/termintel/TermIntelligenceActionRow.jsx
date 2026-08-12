import { CheckCircle2, Clock, XCircle, MinusCircle } from 'lucide-react';

const STATUS = {
  PLANNED: { label: 'Planejada', cls: 'badge-neutral', Icon: Clock },
  REQUESTED: { label: 'Solicitada', cls: 'badge-info', Icon: Clock },
  SENT: { label: 'Enviada', cls: 'badge-info', Icon: Clock },
  AMAZON_CONFIRMED: { label: 'Confirmada na Amazon', cls: 'badge-success', Icon: CheckCircle2 },
  FAILED: { label: 'Falhou', cls: 'badge-danger', Icon: XCircle },
  SKIPPED: { label: 'Ignorada', cls: 'badge-neutral', Icon: MinusCircle },
  BLOCKED: { label: 'Bloqueada', cls: 'badge-warning', Icon: MinusCircle },
};

export default function TermIntelligenceActionRow({ action }) {
  const status = STATUS[action.execution_status] || STATUS.PLANNED;
  const Icon = status.Icon;
  return (
    <tr>
      <td>
        <span className="font-mono text-[13px] text-[#2563EB]">{action.asin}</span>
        {action.term && <p className="text-[13px] text-[#0D1117] mt-0.5 line-clamp-1">{action.term}</p>}
      </td>
      <td>
        <span className="inline-flex px-2.5 py-1 rounded-full text-xs font-semibold badge-info">{action.action}</span>
        <p className="text-[12px] text-[#6B7280] mt-1">P{action.priority ?? 7} · {action.classification || '—'}</p>
      </td>
      <td className="text-[13px] text-[#4B5563] max-w-[220px]">{action.current_state || '—'}</td>
      <td className="text-[13px] text-[#4B5563] max-w-[220px]">{action.desired_state || '—'}</td>
      <td>
        <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold ${status.cls}`}>
          <Icon className="w-3.5 h-3.5" />{status.label}
        </span>
        {action.failure_reason && <p className="text-[12px] text-[#991B1B] mt-1">{action.failure_reason}</p>}
      </td>
    </tr>
  );
}