/**
 * DashboardScheduled
 *
 * Carrega automaticamente os dados do Dashboard via relatórios (sem chamar a Amazon diretamente):
 * 1. Verifica se já há dados frescos (< 6h) em AdsMetricsHistory
 * 2. Se sim → chama loadDashboardFromReports (processa localmente, sem API Amazon)
 * 3. Se não → solicita novos relatórios via scheduledAdsReportSync action=request,
 *    aguarda ~15min e então baixa + processa via scheduledAdsReportSync action=download
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { base44 } from '@/api/base44Client';
import Dashboard from '@/pages/Dashboard';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const REPORT_WAIT_MS = 15 * 60 * 1000; // 15 min para relatório ficar pronto

export default function DashboardScheduled() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [syncStatus, setSyncStatus] = useState(null); // null | 'loading' | 'requesting' | 'waiting' | 'downloading' | 'done' | 'error'
  const [syncMsg, setSyncMsg] = useState('');
  const running = useRef(false);

  const autoSync = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      // Resolver conta
      const me = await base44.auth.me().catch(() => null);
      if (!me) return;
      let accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      if (!accounts.length) accounts = await base44.entities.AmazonAccount.list();
      const account = accounts[0];
      if (!account) return;

      const aid = account.id;

      // 1. Verificar se há dados frescos de AdsMetricsHistory (< 6h)
      setSyncStatus('loading');
      setSyncMsg('Verificando dados de relatórios...');

      const recentHistory = await base44.entities.AdsMetricsHistory.filter(
        { amazon_account_id: aid }, '-synced_at', 1
      ).catch(() => []);

      const lastHistorySyncAt = recentHistory[0]?.synced_at;
      const historyFresh = lastHistorySyncAt && (Date.now() - new Date(lastHistorySyncAt).getTime()) < SIX_HOURS_MS;

      if (historyFresh) {
        // Dados frescos disponíveis — apenas processar localmente
        setSyncMsg('Carregando métricas dos relatórios...');
        const res = await base44.functions.invoke('loadDashboardFromReports', { amazon_account_id: aid });
        if (res?.data?.ok) {
          setSyncStatus('done');
          setSyncMsg(`✓ ${res.data.metrics_records} registros atualizados dos relatórios`);
          setRefreshKey(k => k + 1);
        } else {
          // loadDashboardFromReports falhou mas há dados no banco — continuar sem erro bloqueante
          setSyncStatus('done');
          setSyncMsg('Dados do relatório já processados');
          setRefreshKey(k => k + 1);
        }
        return;
      }

      // 2. Sem dados frescos — solicitar novos relatórios à Amazon
      setSyncStatus('requesting');
      setSyncMsg('Solicitando novos relatórios à Amazon Ads...');

      const reqRes = await base44.functions.invoke('scheduledAdsReportSync', {
        amazon_account_id: aid,
        action: 'request',
      });
      const reqData = reqRes?.data || {};

      if (!reqData.ok || !reqData.reportIds) {
        setSyncStatus('error');
        setSyncMsg(reqData.error || 'Falha ao solicitar relatórios');
        return;
      }

      const { reportIds, syncRunId } = reqData;

      // 3. Aguardar relatório ficar pronto (poll a cada 2 min, até 20 min)
      setSyncStatus('waiting');
      setSyncMsg('Aguardando relatórios ficarem prontos (pode levar até 15 min)...');

      const pollStart = Date.now();
      const POLL_INTERVAL = 2 * 60 * 1000; // 2 min
      const MAX_WAIT = 20 * 60 * 1000; // 20 min

      let downloaded = false;
      while (Date.now() - pollStart < MAX_WAIT) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL));

        setSyncStatus('downloading');
        setSyncMsg('Baixando e processando relatórios...');

        const dlRes = await base44.functions.invoke('scheduledAdsReportSync', {
          amazon_account_id: aid,
          action: 'download',
          reportIds,
          syncRunId,
        });
        const dlData = dlRes?.data || {};

        if (dlData.ok && dlData.ready !== false) {
          // Download concluído — agora processar no Dashboard
          setSyncMsg('Atualizando métricas do Dashboard...');
          const loadRes = await base44.functions.invoke('loadDashboardFromReports', { amazon_account_id: aid });
          const loadData = loadRes?.data || {};

          setSyncStatus('done');
          setSyncMsg(`✓ ${loadData.metrics_records || dlData.campaign_metrics || 0} métricas · ${dlData.search_terms || 0} search terms atualizados`);
          setRefreshKey(k => k + 1);
          downloaded = true;
          break;
        } else if (dlData.ready === false) {
          setSyncStatus('waiting');
          setSyncMsg(`Relatórios em geração... (${Math.round((Date.now() - pollStart) / 60000)} min)`);
        } else {
          setSyncStatus('error');
          setSyncMsg(dlData.error || 'Falha no download dos relatórios');
          break;
        }
      }

      if (!downloaded && syncStatus !== 'error') {
        setSyncStatus('error');
        setSyncMsg('Timeout: relatórios não ficaram prontos em 20 min. Tente novamente mais tarde.');
      }

    } catch (err) {
      setSyncStatus('error');
      setSyncMsg(err.message || 'Erro ao sincronizar métricas');
    } finally {
      running.current = false;
    }
  }, []);

  useEffect(() => {
    autoSync();
    // Re-verificar a cada 6h
    const timer = window.setInterval(() => {
      if (!running.current) autoSync();
    }, SIX_HOURS_MS);
    return () => window.clearInterval(timer);
  }, [autoSync]);

  return (
    <div className="relative">
      {syncStatus && syncStatus !== 'done' && (
        <div className={`fixed bottom-4 right-4 z-50 flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-medium shadow-lg border backdrop-blur-sm
          ${syncStatus === 'error'
            ? 'bg-red-500/20 border-red-500/30 text-red-300'
            : 'bg-surface-1 border-surface-2 text-slate-300'}`}>
          {syncStatus !== 'error' && (
            <span className="w-3 h-3 rounded-full border-2 border-cyan/40 border-t-cyan animate-spin" />
          )}
          {syncMsg}
        </div>
      )}
      <Dashboard key={refreshKey} />
    </div>
  );
}