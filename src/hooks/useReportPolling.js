import { useEffect, useRef, useCallback } from 'react';
import { base44 } from '@/api/base44Client';

/**
 * Polling leve a cada 2 minutos no AmazonAdsReportJob.
 * Quando detecta um downloaded_at mais novo, chama onNewReport().
 * Pausa automaticamente quando a aba não está visível.
 */
export function useReportPolling({ accountId, onNewReport, enabled = true }) {
  const lastDownloadedAt = useRef(null);
  const intervalRef = useRef(null);

  const check = useCallback(async () => {
    if (!accountId) return;
    try {
      const jobs = await base44.entities.AmazonAdsReportJob.filter(
        { status: 'processed', amazon_account_id: accountId },
        '-downloaded_at',
        1
      );
      const job = jobs?.[0];
      if (!job?.downloaded_at) return;

      const newDate = job.downloaded_at;

      // Primeira execução: apenas memoriza sem disparar reload
      if (lastDownloadedAt.current === null) {
        lastDownloadedAt.current = newDate;
        return;
      }

      if (newDate !== lastDownloadedAt.current) {
        lastDownloadedAt.current = newDate;
        onNewReport?.();
      }
    } catch {
      // silencioso — polling não deve quebrar o dashboard
    }
  }, [accountId, onNewReport]);

  useEffect(() => {
    if (!enabled || !accountId) return;

    const start = () => {
      check(); // primeira checagem imediata
      intervalRef.current = setInterval(check, 120_000);
    };

    const stop = () => {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    };

    const handleVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        start();
      }
    };

    start();
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [enabled, accountId, check]);
}