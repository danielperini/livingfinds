/**
 * DashboardScheduled
 *
 * Ao abrir o Dashboard:
 * 1. Verifica se há dados frescos (< 6h) em AdsMetricsHistory
 * 2. Se sim → apenas exibe o Dashboard com dados do banco (sem chamar API Amazon)
 * 3. Se não → chama loadDashboardFromReports para processar relatórios já baixados,
 *    ou exibe aviso pedindo para aguardar a automação noturna solicitar novos relatórios.
 *
 * A solicitação e download de relatórios é feita pela automação agendada (autoRequestAndDownloadReports).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { base44 } from '@/api/base44Client';
import Dashboard from '@/pages/Dashboard';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export default function DashboardScheduled() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [syncStatus, setSyncStatus] = useState(null); // null | 'checking' | 'processing' | 'done' | 'stale' | 'error'
  const [syncMsg, setSyncMsg] = useState('');
  const running = useRef(false);

  const autoLoad = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      const me = await base44.auth.me().catch(() => null);
      if (!me) return;

      let accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      if (!accounts.length) accounts = await base44.entities.AmazonAccount.list();
      const account = accounts[0];
      if (!account) return;

      const aid = account.id;

      setSyncStatus('checking');
      setSyncMsg('Verificando dados locais...');

      // Checar se há dados frescos de AdsMetricsHistory (< 6h)
      const recentHistory = await base44.entities.AdsMetricsHistory.filter(
        { amazon_account_id: aid }, '-synced_at', 1
      ).catch(() => []);

      const lastSynced = recentHistory[0]?.synced_at;
      const isFresh = lastSynced && (Date.now() - new Date(lastSynced).getTime()) < SIX_HOURS_MS;

      if (isFresh) {
        // Dados frescos — processar localmente (sem chamar Amazon)
        setSyncStatus('processing');
        setSyncMsg('Atualizando métricas dos relatórios...');
        const res = await base44.functions.invoke('loadDashboardFromReports', { amazon_account_id: aid });
        const d = res?.data || {};
        if (d.ok) {
          setSyncStatus('done');
          setSyncMsg(`✓ ${d.updated || 0} métricas atualizadas`);
          setRefreshKey(k => k + 1);
        } else {
          // Dados ok no banco mesmo sem reprocessar
          setSyncStatus(null);
          setRefreshKey(k => k + 1);
        }
        return;
      }

      // Sem dados frescos — verificar se há relatórios não processados
      setSyncStatus('processing');
      setSyncMsg('Processando relatórios disponíveis...');

      const loadRes = await base44.functions.invoke('loadDashboardFromReports', { amazon_account_id: aid });
      const loadData = loadRes?.data || {};

      if (loadData.ok) {
        setSyncStatus('done');
        setSyncMsg(`✓ ${loadData.updated || 0} métricas carregadas dos relatórios`);
        setRefreshKey(k => k + 1);
      } else {
        // Sem dados — avisar usuário que a automação vai buscar na próxima execução
        setSyncStatus('stale');
        setSyncMsg('Sem dados recentes. A automação buscará novos relatórios em breve.');
        setRefreshKey(k => k + 1);
      }
    } catch (err) {
      setSyncStatus('error');
      setSyncMsg(err.message || 'Erro ao carregar dados');
    } finally {
      running.current = false;
      // Limpar mensagem de sucesso após 8s
      setTimeout(() => setSyncStatus(s => (s === 'done' ? null : s)), 8000);
    }
  }, []);

  useEffect(() => {
    autoLoad();
    // Re-verificar a cada 6h
    const timer = window.setInterval(() => {
      if (!running.current) autoLoad();
    }, SIX_HOURS_MS);
    return () => window.clearInterval(timer);
  }, [autoLoad]);

  const statusColor = {
    checking: 'bg-surface-1 border-surface-2 text-slate-300',
    processing: 'bg-surface-1 border-cyan/20 text-slate-300',
    done: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300',
    stale: 'bg-amber-500/10 border-amber-500/20 text-amber-300',
    error: 'bg-red-500/10 border-red-500/20 text-red-300',
  };

  return (
    <div className="relative">
      {syncStatus && (
        <div className={`fixed bottom-4 right-4 z-50 flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-medium shadow-lg border backdrop-blur-sm ${statusColor[syncStatus] || statusColor.checking}`}>
          {(syncStatus === 'checking' || syncStatus === 'processing') && (
            <span className="w-3 h-3 rounded-full border-2 border-cyan/40 border-t-cyan animate-spin flex-shrink-0" />
          )}
          {syncMsg}
        </div>
      )}
      <Dashboard key={refreshKey} />
    </div>
  );
}