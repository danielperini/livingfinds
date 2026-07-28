import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { AlertTriangle, XCircle, TrendingUp, ExternalLink, X } from 'lucide-react';
import { Link } from 'react-router-dom';

/**
 * GoalAlignmentBanner — exibe alerta quando goal_alignment_status = GOAL_TENSION ou MISCONFIGURED.
 * Usado em DaypartingDashboard e SalaDeComando.
 */
export default function GoalAlignmentBanner({ accountId, className = '' }) {
  const [controller, setController] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    const load = async () => {
      try {
        const todayBRT = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
          .toISOString().slice(0, 10);
        const [controllers, snaps] = await Promise.all([
          base44.entities.AccountDailySpendController.filter(
            { amazon_account_id: accountId, spend_date: todayBRT }, null, 1
          ).catch(() => []),
          base44.entities.PerformanceTrendSnapshot.filter(
            { amazon_account_id: accountId }, null, 1
          ).catch(() => []),
        ]);
        setController(controllers[0] || null);
        setSnapshot(snaps[0] || null);
      } catch {}
    };
    load();
  }, [accountId]);

  if (dismissed) return null;

  const status = controller?.goal_alignment_status;
  const recencyProtection = controller?.recency_protection_active || snapshot?.recency_protection_active;

  // Só exibe se há algo relevante
  if (!status && !recencyProtection) return null;
  if (status === 'ALIGNED' || status === 'UNCHECKED') {
    if (!recencyProtection) return null;
  }

  const acos14d = controller?.acos_14d_at_last_check || snapshot?.acos_14d;
  const acos80d = snapshot?.acos_80d;
  const targetAcos = snapshot?.target_acos_at_snapshot;

  const isMisconfigured = status === 'MISCONFIGURED';
  const isTension = status === 'GOAL_TENSION';
  const isRecencyProtected = recencyProtection && snapshot?.trend_classification === 'STRONGLY_IMPROVING';

  // Prioridade: MISCONFIGURED > GOAL_TENSION > RECENCY_PROTECTION
  let bgClass, borderClass, iconColor, Icon, title, body;

  if (isMisconfigured) {
    bgClass = 'bg-red-500/10';
    borderClass = 'border-red-500/30';
    iconColor = 'text-red-400';
    Icon = XCircle;
    title = 'Motor em SAFE_MODE — Meta não calibrada';
    body = `Target ACoS ${targetAcos?.toFixed(1) ?? '?'}% muito agressivo. ACoS real 14D: ${acos14d?.toFixed(1) ?? '?'}%. Mutações automáticas suspensas até ajuste manual.`;
  } else if (isTension) {
    bgClass = 'bg-amber-500/10';
    borderClass = 'border-amber-500/30';
    iconColor = 'text-amber-400';
    Icon = AlertTriangle;
    title = 'GOAL_TENSION — Meta mais agressiva que performance real';
    body = `Target ACoS ${targetAcos?.toFixed(1) ?? '?'}% vs ACoS real 14D ${acos14d?.toFixed(1) ?? '?'}%. Reduções de bid limitadas a -5% por ciclo.`;
  } else if (isRecencyProtected) {
    bgClass = 'bg-cyan/10';
    borderClass = 'border-cyan/30';
    iconColor = 'text-cyan';
    Icon = TrendingUp;
    title = 'RECENCY PROTECTION ativa — Performance em forte melhora';
    body = `ACoS 14D: ${acos14d?.toFixed(1) ?? '?'}% vs histórico 80D: ${acos80d?.toFixed(1) ?? '?'}%. Decisões baseadas em dados antigos estão bloqueadas.`;
  } else {
    return null;
  }

  return (
    <div className={`flex items-start gap-3 px-4 py-3 rounded-xl border ${bgClass} ${borderClass} ${className}`}>
      <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${iconColor}`} />
      <div className="flex-1 min-w-0">
        <p className={`text-xs font-bold ${iconColor} mb-0.5`}>{title}</p>
        <p className="text-xs text-slate-300">{body}</p>
        <Link
          to="/settings"
          className={`inline-flex items-center gap-1 mt-1 text-[10px] font-semibold ${iconColor} hover:underline`}
        >
          Ajustar PerformanceSettings <ExternalLink className="w-3 h-3" />
        </Link>
      </div>
      <button
        onClick={() => setDismissed(true)}
        className="text-slate-500 hover:text-slate-300 flex-shrink-0"
        title="Fechar"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}