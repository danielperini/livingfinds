import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { AlertTriangle, ExternalLink, X, Clock } from 'lucide-react';
import { Link } from 'react-router-dom';

/**
 * Banner fixo exibido quando:
 * (a) há Alert ativo de alert_type='token_expired', OU
 * (b) há SyncExecutionLog recente (< 2h) com operation contendo 'token_manager' e status='error'
 *     com message contendo 'Not authorized' — indicando token revogado bloqueando o pipeline.
 */
export default function TokenExpiredBanner({ accountId }) {
  const [alertData, setAlertData] = useState(null); // { type: 'alert'|'token_revoked', message, since, stuckJobs, lastSyncHoursAgo }
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;

    const check = async () => {
      try {
        // Verificação positiva: token já está ativo?
        const accounts = await base44.entities.AmazonAccount.filter(
          { id: accountId }, null, 1
        ).catch(() => []);
        const account = accounts[0];
        if (account?.ads_token_status === 'active') {
          // Confirmar que o alerta também foi resolvido no banco
          const activeTokenAlerts = await base44.entities.Alert.filter(
            { amazon_account_id: accountId, alert_type: 'token_expired', status: 'active' },
            null, 1
          ).catch(() => []);
          if (!activeTokenAlerts[0]) {
            if (!cancelled) setAlertData(null);
            return;
          }
        }

        // Verificação 1: Alert ativo de token_expired
        const alerts = await base44.entities.Alert.filter(
          { amazon_account_id: accountId, alert_type: 'token_expired', status: 'active' },
          '-created_at', 1
        ).catch(() => []);

        if (alerts[0]) {
          if (!cancelled) {
            setDismissed(false);
            setAlertData({ type: 'alert', message: alerts[0].message });
          }
          return;
        }

        // Verificação 2: SyncExecutionLog com erro de token_manager nas últimas 2h
        const cutoff2h = new Date(Date.now() - 2 * 3600000).toISOString();
        const errorLogs = await base44.entities.SyncExecutionLog.filter(
          { amazon_account_id: accountId, status: 'error' },
          '-created_date', 20
        ).catch(() => []);

        const tokenManagerError = errorLogs.find(log => {
          const op = (log.operation || '').toLowerCase();
          const msg = (log.error_message || log.result_summary || '').toLowerCase();
          const isRecent = (log.created_date || log.started_at || '') >= cutoff2h;
          return isRecent && op.includes('token_manager') && msg.includes('not authorized');
        });

        if (!tokenManagerError) {
          if (!cancelled) {
            setAlertData(null);
            // Token is healthy — allow banner to show again if it revokes in the future
            setDismissed(false);
          }
          return;
        }

        // Detectado: calcular contexto de impacto
        const since = tokenManagerError.started_at || tokenManagerError.created_date;

        // Jobs travados: pending com mais de 4h sem poll
        const cutoff4h = new Date(Date.now() - 4 * 3600000).toISOString();
        const pendingJobs = await base44.entities.AmazonAdsReportJob.filter(
          { amazon_account_id: accountId, status: 'pending' },
          '-created_date', 50
        ).catch(() => []);

        const stuckJobs = pendingJobs.filter(j => {
          const created = j.created_date || j.created_at || j.requested_at || '';
          return created <= cutoff4h && (j.poll_attempts || 0) === 0;
        });

        // Último sync bem-sucedido
        const successLogs = await base44.entities.SyncExecutionLog.filter(
          { amazon_account_id: accountId, status: 'success' },
          '-created_date', 1
        ).catch(() => []);

        let lastSyncHoursAgo = null;
        if (successLogs[0]) {
          const ts = successLogs[0].completed_at || successLogs[0].created_date;
          if (ts) lastSyncHoursAgo = Math.round((Date.now() - new Date(ts).getTime()) / 3600000);
        }

        if (!cancelled) {
          setDismissed(false); // reset dismiss so banner re-appears on future revocations
          setAlertData({
            type: 'token_revoked',
            since,
            stuckJobs: stuckJobs.length,
            lastSyncHoursAgo,
          });
        }
      } catch { /* silencioso */ }
    };

    check();
    const interval = setInterval(check, 60000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [accountId]);

  if (!alertData || dismissed) return null;

  const formatDate = (iso) => {
    if (!iso) return '';
    return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="flex items-start gap-3 px-4 py-3 rounded-xl border bg-red-500/10 border-red-500/30 text-sm mb-1">
      <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        {alertData.type === 'token_revoked' ? (
          <>
            <span className="font-semibold text-red-300">Token Amazon Ads revogado — sincronização bloqueada</span>
            {alertData.since && (
              <span className="text-red-300/70 ml-2 text-xs">desde {formatDate(alertData.since)}</span>
            )}
            <span className="text-red-300/80 ml-1">. Clique aqui para reconectar via OAuth.</span>
            {(alertData.stuckJobs > 0 || alertData.lastSyncHoursAgo !== null) && (
              <div className="flex items-center gap-3 mt-1">
                {alertData.stuckJobs > 0 && (
                  <span className="inline-flex items-center gap-1 text-xs text-amber-400/80">
                    <Clock className="w-3 h-3" />
                    {alertData.stuckJobs} {alertData.stuckJobs === 1 ? 'job travado' : 'jobs travados'} aguardando
                  </span>
                )}
                {alertData.lastSyncHoursAgo !== null && (
                  <span className="text-xs text-red-300/60">
                    Último sync: há {alertData.lastSyncHoursAgo}h
                  </span>
                )}
              </div>
            )}
          </>
        ) : (
          <>
            <span className="font-semibold text-red-300">Token Amazon Ads expirado</span>
            <span className="text-red-300/80 ml-2">
              {alertData.message || 'Acesse /amazon-oauth-setup para reconectar.'}
            </span>
          </>
        )}
      </div>
      <Link
        to="/amazon-oauth-setup"
        className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/20 border border-red-500/30 text-red-300 hover:bg-red-500/30 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors flex-shrink-0"
      >
        <ExternalLink className="w-3 h-3" />
        Reconectar
      </Link>
      <button
        onClick={() => setDismissed(true)}
        className="text-red-400/60 hover:text-red-300 flex-shrink-0"
        title="Fechar banner (não resolve o problema)"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}