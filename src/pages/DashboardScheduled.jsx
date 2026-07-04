import { useCallback, useEffect, useRef, useState } from 'react';
import { base44 } from '@/api/base44Client';
import Dashboard from '@/pages/Dashboard';

export default function DashboardScheduled() {
  const [refreshKey, setRefreshKey] = useState(0);
  const running = useRef(false);

  const refreshMetrics = useCallback(async () => {
    if (running.current) return;
    try {
      const me = await base44.auth.me();
      let accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      if (!accounts.length) accounts = await base44.entities.AmazonAccount.list();
      const account = accounts[0];
      if (!account) return;
      const last = account.ads_metrics_last_sync_at || account.last_sync_at;
      const stale = !last || Date.now() - new Date(last).getTime() > 900000;
      if (!stale) return;
      running.current = true;
      const response = await base44.functions.invoke('syncAdsPerformanceMetricsV2', {
        amazon_account_id: account.id,
        trigger_type: 'dashboard_refresh'
      });
      if (response?.data?.ok) setRefreshKey((value) => value + 1);
    } catch {
    } finally {
      running.current = false;
    }
  }, []);

  useEffect(() => {
    refreshMetrics();
    const timer = window.setInterval(() => {
      setRefreshKey((value) => value + 1);
      refreshMetrics();
    }, 20000);
    return () => window.clearInterval(timer);
  }, [refreshMetrics]);

  return <Dashboard key={refreshKey} />;
}