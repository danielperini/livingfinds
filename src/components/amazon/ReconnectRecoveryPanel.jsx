import { useState, useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { CheckCircle, Loader2, XCircle, Clock, RefreshCw, FileText, Zap, ShieldCheck } from 'lucide-react';

const POLL_INTERVAL = 15000;
const AUTO_DISMISS_AFTER = 60000;

function StepRow({ icon: Icon, label, status, detail, count }) {
  return (
    <div className="flex items-start gap-3">
      {/* Timeline dot + line */}
      <div className="flex flex-col items-center gap-0 flex-shrink-0 pt-0.5">
        <div className={`w-7 h-7 rounded-full flex items-center justify-center border flex-shrink-0 transition-all ${
          status === 'done'    ? 'bg-emerald-500/20 border-emerald-500/40' :
          status === 'running' ? 'bg-cyan/15 border-cyan/40' :
          status === 'error'   ? 'bg-red-500/15 border-red-500/30' :
                                 'bg-surface-3 border-surface-3'
        }`}>
          {status === 'done'    ? <CheckCircle className="w-3.5 h-3.5 text-emerald-400" /> :
           status === 'running' ? <Loader2 className="w-3.5 h-3.5 text-cyan animate-spin" /> :
           status === 'error'   ? <XCircle className="w-3.5 h-3.5 text-red-400" /> :
                                  <Icon className="w-3.5 h-3.5 text-slate-600" />}
        </div>
      </div>
      {/* Content */}
      <div className="flex-1 pb-4">
        <div className="flex items-center gap-2">
          <p className={`text-sm font-semibold ${
            status === 'done'    ? 'text-emerald-300' :
            status === 'running' ? 'text-white' :
            status === 'error'   ? 'text-red-300' :
                                   'text-slate-500'
          }`}>{label}</p>
          {count != null && status !== 'pending' && (
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold border ${
              status === 'done'  ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' :
              status === 'error' ? 'bg-red-500/10 border-red-500/20 text-red-400' :
                                   'bg-cyan/10 border-cyan/20 text-cyan'
            }`}>
              {count}
            </span>
          )}
        </div>
        {detail && (
          <p className="text-xs text-slate-500 mt-0.5">{detail}</p>
        )}
      </div>
    </div>
  );
}

export default function ReconnectRecoveryPanel({ account }) {
  const [steps, setSteps] = useState({
    reports:   { status: 'running', detail: 'Disparando pipeline de relatórios...', count: null },
    campaigns: { status: 'pending', detail: null, count: null },
    verify:    { status: 'pending', detail: null, count: null },
  });
  const [stuckJobs, setStuckJobs] = useState(0);
  const [startedAt] = useState(Date.now());
  const [dismissed, setDismissed] = useState(false);
  const [allDone, setAllDone] = useState(false);
  const [downtime, setDowntime] = useState(null);
  const pollRef = useRef(null);
  const dismissRef = useRef(null);

  const fireRecovery = async () => {
    if (!account?.id) return;
    // Fire-and-forget — não await bloqueante
    base44.functions.invoke('checkAndForceReportPipeline', { amazon_account_id: account.id, _service_role: true }).catch(() => {});
    base44.functions.invoke('unlockStuckSyncs', { amazon_account_id: account.id, _service_role: true }).catch(() => {});

    // Aguarda 3s antes de disparar syncAdsQuick para não colidir
    setTimeout(() => {
      base44.functions.invoke('syncAdsQuick', { amazon_account_id: account.id, _service_role: true })
        .then(() => {
          setSteps(prev => ({
            ...prev,
            campaigns: { status: 'done', detail: 'Campanhas sincronizadas com sucesso.', count: null },
          }));
        })
        .catch(() => {
          setSteps(prev => ({
            ...prev,
            campaigns: { status: 'error', detail: 'Erro ao sincronizar campanhas.', count: null },
          }));
        });
    }, 3000);

    setSteps(prev => ({
      ...prev,
      campaigns: { status: 'running', detail: 'Sincronizando estado das campanhas...', count: null },
    }));
  };

  const pollJobs = async () => {
    if (!account?.id) return;
    try {
      const jobs = await base44.entities.AmazonAdsReportJob.filter(
        { amazon_account_id: account.id },
        '-created_date',
        100
      ).catch(() => []);

      const pending = jobs.filter(j => j.status === 'pending' || j.status === 'rate_limited');
      const processed = jobs.filter(j => j.status === 'processed' || j.status === 'completed' || j.status === 'downloaded');
      const failed = jobs.filter(j => j.status === 'failed' || j.status === 'expired');

      setStuckJobs(pending.length);

      if (pending.length === 0) {
        // Todos saíram do estado pendente
        setSteps(prev => ({
          ...prev,
          reports: {
            status: 'done',
            detail: `${processed.length} job(s) recuperado(s)${failed.length > 0 ? ` · ${failed.length} falharam` : ''}`,
            count: processed.length,
          },
        }));
        clearInterval(pollRef.current);
      } else {
        setSteps(prev => ({
          ...prev,
          reports: {
            status: 'running',
            detail: `${pending.length} job(s) ainda processando...`,
            count: null,
          },
        }));
      }
    } catch {
      // silencioso
    }
  };

  const checkVerify = async () => {
    if (!account?.id) return;
    try {
      const logs = await base44.entities.SyncExecutionLog.filter(
        { amazon_account_id: account.id, status: 'success' },
        '-completed_at',
        1
      ).catch(() => []);

      if (logs.length > 0) {
        const lastSuccess = logs[0];
        // Calcular downtime aproximado
        const lastSuccessTime = new Date(lastSuccess.completed_at || lastSuccess.created_date).getTime();
        const downtimeMins = Math.round((Date.now() - lastSuccessTime) / 60000);
        setDowntime(downtimeMins);
        setSteps(prev => ({
          ...prev,
          verify: {
            status: 'done',
            detail: `Sistema operacional · downtime estimado: ~${downtimeMins < 60 ? `${downtimeMins}min` : `${Math.round(downtimeMins / 60)}h`}`,
            count: null,
          },
        }));
        setAllDone(true);
      }
    } catch {
      // silencioso
    }
  };

  useEffect(() => {
    fireRecovery();
    pollRef.current = setInterval(pollJobs, POLL_INTERVAL);
    // Após 30s começar a verificar se o sistema está OK
    const verifyTimer = setTimeout(checkVerify, 30000);

    return () => {
      clearInterval(pollRef.current);
      clearTimeout(verifyTimer);
      clearTimeout(dismissRef.current);
    };
  }, [account?.id]);

  // Quando tudo conclui, configurar auto-dismiss
  useEffect(() => {
    if (allDone) {
      dismissRef.current = setTimeout(() => setDismissed(true), AUTO_DISMISS_AFTER);
    }
  }, [allDone]);

  if (dismissed) return null;

  const elapsed = Math.round((Date.now() - startedAt) / 1000);

  return (
    <div className="rounded-2xl border border-emerald-500/25 bg-gradient-to-br from-emerald-500/5 to-cyan/5 p-5 space-y-4 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-emerald-500/15 border border-emerald-500/25 flex items-center justify-center">
            <RefreshCw className={`w-4 h-4 text-emerald-400 ${!allDone ? 'animate-spin' : ''}`} />
          </div>
          <div>
            <p className="text-sm font-bold text-white">Recuperação automática em progresso</p>
            <p className="text-[10px] text-slate-400">Retomando jobs e sincronizações pausados durante a desconexão</p>
          </div>
        </div>
        {allDone && (
          <button
            onClick={() => setDismissed(true)}
            className="text-[10px] text-slate-500 hover:text-slate-300 px-2 py-1 rounded bg-surface-2 border border-surface-3 transition-colors flex-shrink-0"
          >
            Fechar
          </button>
        )}
      </div>

      {/* Jobs travados badge */}
      {stuckJobs > 0 && (
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
          <Clock className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
          <p className="text-xs text-amber-300">
            <span className="font-bold">{stuckJobs}</span> job{stuckJobs !== 1 ? 's' : ''} travado{stuckJobs !== 1 ? 's' : ''} aguardando desbloqueio...
          </p>
        </div>
      )}

      {/* Timeline steps */}
      <div className="pl-1">
        <StepRow
          icon={FileText}
          label="Relatórios pendentes"
          status={steps.reports.status}
          detail={steps.reports.detail}
          count={steps.reports.count}
        />
        <StepRow
          icon={Zap}
          label="Sincronização de campanhas"
          status={steps.campaigns.status}
          detail={steps.campaigns.detail}
          count={steps.campaigns.count}
        />
        <StepRow
          icon={ShieldCheck}
          label="Verificação final"
          status={steps.verify.status}
          detail={steps.verify.detail}
          count={steps.verify.count}
        />
      </div>

      {/* Resumo final */}
      {allDone && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
          <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0" />
          <p className="text-xs text-emerald-300">
            <span className="font-bold">Sistema recuperado.</span>
            {downtime != null && ` Downtime total: ~${downtime < 60 ? `${downtime}min` : `${Math.round(downtime / 60)}h`}.`}
            {' '}Painel fechará automaticamente em 60 segundos.
          </p>
        </div>
      )}
    </div>
  );
}