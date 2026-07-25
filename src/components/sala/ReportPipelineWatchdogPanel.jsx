import { useState, useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { CheckCircle, AlertTriangle, Loader2, Clock, Zap } from 'lucide-react';

const STALE_HOURS = 26;
const STUCK_THRESHOLD_MIN = 30; // jobs pendentes há mais de 30min sem poll_attempts = travados

export default function ReportPipelineWatchdogPanel({ account }) {
  const [state, setState] = useState({
    loading: true,
    status: 'unknown',   // 'ok' | 'stuck' | 'missing' | 'recovering' | 'requesting' | 'unknown'
    message: '',
    lastProcessedAt: null,
    stuckCount: 0,
  });
  const recoveryFiredRef = useRef(false);

  const checkJobs = async (silent = false) => {
    if (!account) return;
    if (!silent) setState(s => ({ ...s, loading: true }));

    try {
      const jobs = await base44.entities.AmazonAdsReportJob.filter(
        { amazon_account_id: account.id },
        '-created_date',
        50
      );

      const nowMs = Date.now();
      const cutoffProcessed = new Date(nowMs - STALE_HOURS * 3600000).toISOString();
      const cutoffStuck = new Date(nowMs - STUCK_THRESHOLD_MIN * 60 * 1000).toISOString();

      // Data atual em BRT (UTC-3)
      const todayBRT = new Date(nowMs - 3 * 3600000).toISOString().slice(0, 10);

      // 1. Pipeline saudável = pelo menos 1 job com processed_at recente
      const processedJob = jobs.find(j =>
        ['processed', 'completed'].includes(j.status) && (j.processed_at || '') >= cutoffProcessed
      );

      if (processedJob) {
        setState({
          loading: false,
          status: 'ok',
          message: `Processado em ${new Date(processedJob.processed_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`,
          lastProcessedAt: processedJob.processed_at,
          stuckCount: 0,
        });
        recoveryFiredRef.current = false;
        return;
      }

      // 2. Detectar jobs travados: pending + poll_attempts=0 + (criado há >30min OU start_date=hoje)
      const stuckJobs = jobs.filter(j => {
        const createdAt = j.created_date || j.created_at || j.requested_at || '';
        const startDate = j.start_date || j.end_date || '';
        const isPending = ['pending', 'processing', 'requested'].includes(j.status);
        const neverPolled = (j.poll_attempts || 0) === 0;
        const oldEnough = createdAt <= cutoffStuck;
        const isToday = startDate === todayBRT;
        return isPending && neverPolled && (oldEnough || isToday);
      });

      if (stuckJobs.length > 0) {
        setState({
          loading: false,
          status: recoveryFiredRef.current ? 'recovering' : 'stuck',
          message: `${stuckJobs.length} job(s) travado(s) — poll_attempts=0`,
          lastProcessedAt: null,
          stuckCount: stuckJobs.length,
        });

        // Disparo automático único por sessão de detecção
        if (!recoveryFiredRef.current) {
          recoveryFiredRef.current = true;
          setState(s => ({ ...s, status: 'recovering', message: 'Recuperando pipeline automaticamente...' }));
          base44.functions.invoke('pollAmazonAdsReportJobs', {
            force_all_pending: true,
            amazon_account_id: account.id,
            _service_role: true,
          }).catch(() => {});
          // Re-verificar após 2 minutos
          setTimeout(() => checkJobs(true), 2 * 60 * 1000);
        }
        return;
      }

      // 3. Nenhum job do dia atual em nenhum estado → pipeline ausente
      const todayJobs = jobs.filter(j => {
        const startDate = j.start_date || j.end_date || '';
        return startDate === todayBRT;
      });

      if (todayJobs.length === 0) {
        setState({
          loading: false,
          status: recoveryFiredRef.current ? 'requesting' : 'missing',
          message: 'Nenhum job criado para hoje — pipeline ausente',
          lastProcessedAt: null,
          stuckCount: 0,
        });

        if (!recoveryFiredRef.current) {
          recoveryFiredRef.current = true;
          setState(s => ({ ...s, status: 'requesting', message: 'Solicitando relatórios do dia...' }));
          base44.functions.invoke('runDailyFullReportPipeline', {
            amazon_account_id: account.id,
            force: true,
            _service_role: true,
          }).catch(() => {});
          setTimeout(() => checkJobs(true), 3 * 60 * 1000);
        }
        return;
      }

      // 4. Há jobs hoje mas nenhum processado ainda — aguardando (estado normal após criação)
      const pendingCount = todayJobs.filter(j => ['pending', 'processing', 'requested'].includes(j.status)).length;
      setState({
        loading: false,
        status: 'recovering',
        message: `${pendingCount} job(s) em processamento para hoje`,
        lastProcessedAt: null,
        stuckCount: 0,
      });
      recoveryFiredRef.current = false;

    } catch {
      setState(s => ({ ...s, loading: false, status: 'unknown', message: 'Erro ao verificar jobs' }));
    }
  };

  useEffect(() => {
    recoveryFiredRef.current = false;
    checkJobs();
    const interval = setInterval(() => checkJobs(true), 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [account?.id]);

  const { loading, status, message, lastProcessedAt, stuckCount } = state;

  const isAlert = ['stuck', 'missing'].includes(status);
  const isOk = status === 'ok';
  const isRecovering = ['recovering', 'requesting'].includes(status);

  const containerClass = isAlert
    ? 'bg-amber-500/8 border-amber-500/30'
    : isOk
    ? 'bg-surface-1 border-surface-2'
    : 'bg-blue-500/8 border-blue-500/25';

  const iconBg = isAlert
    ? 'bg-amber-500/20 border-amber-500/30'
    : isOk
    ? 'bg-emerald-500/15 border-emerald-500/25'
    : 'bg-blue-500/15 border-blue-500/25';

  const Icon = isOk ? CheckCircle : isAlert ? AlertTriangle : isRecovering ? Zap : Clock;
  const iconColor = isOk ? 'text-emerald-400' : isAlert ? 'text-amber-400' : 'text-blue-400';

  return (
    <div className={`flex items-center gap-3 p-3 rounded-xl border transition-colors ${containerClass}`}>
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 border ${iconBg}`}>
        {loading
          ? <Loader2 className="w-4 h-4 text-slate-400 animate-spin" />
          : <Icon className={`w-4 h-4 ${iconColor}`} />}
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-white">Sync de Relatórios Amazon Ads</p>
        {loading ? (
          <p className="text-[10px] text-slate-500 mt-0.5">Verificando jobs...</p>
        ) : (
          <p className={`text-[10px] mt-0.5 flex items-center gap-1 ${isAlert ? 'text-amber-400' : isRecovering ? 'text-blue-400' : 'text-slate-500'}`}>
            {isRecovering && <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" />}
            {!isRecovering && <Clock className="w-3 h-3 flex-shrink-0" />}
            {message}
          </p>
        )}
      </div>
    </div>
  );
}