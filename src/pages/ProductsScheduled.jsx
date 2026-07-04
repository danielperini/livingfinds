import { useCallback, useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import Products from '@/pages/Products';
import { CheckCircle2, Clock, RefreshCw } from 'lucide-react';

function nextWindow(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(p.hour || 0);
  const day = `${p.year}-${p.month}-${p.day}`;

  if (hour < 4) return { label: 'janela 00:00–04:00 em andamento', at: `${day}T04:00:00-03:00` };
  if (hour < 13) return { label: 'hoje, 13:00–14:00', at: `${day}T13:00:00-03:00` };
  if (hour < 14) return { label: 'janela 13:00–14:00 em andamento', at: `${day}T14:00:00-03:00` };

  const tomorrow = new Date(`${day}T12:00:00-03:00`);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowDay = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(tomorrow);
  return { label: 'amanhã, 00:00–04:00', at: `${tomorrowDay}T00:00:00-03:00` };
}

function formatDateTime(value) {
  if (!value) return 'ainda não registrada';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'ainda não registrada';
  return date.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export default function ProductsScheduled() {
  const [account, setAccount] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [status, setStatus] = useState('waiting');
  const [refreshKey, setRefreshKey] = useState(0);
  const windowInfo = useMemo(() => nextWindow(), [lastUpdate]);

  const readStatus = useCallback(async () => {
    try {
      const me = await base44.auth.me();
      let accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      if (!accounts.length) accounts = await base44.entities.AmazonAccount.filter({ status: 'connected' });
      if (!accounts.length) accounts = await base44.entities.AmazonAccount.list();
      const current = accounts[0] || null;
      setAccount(current);
      if (!current) return;

      const logs = await base44.entities.SyncExecutionLog.filter({
        amazon_account_id: current.id,
        operation: 'products_ads_window_sync',
      }, '-completed_at', 1).catch(() => []);
      const latest = logs[0] || null;
      const nextValue = latest?.completed_at || current.products_ads_last_sync_at || current.last_sync_at || null;

      setStatus(latest?.status || current.products_ads_sync_status || 'waiting');
      setLastUpdate((previous) => {
        if (previous && nextValue && previous !== nextValue) setRefreshKey((key) => key + 1);
        return nextValue;
      });
    } catch {
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    readStatus();
    const timer = window.setInterval(readStatus, 60000);
    return () => window.clearInterval(timer);
  }, [readStatus]);

  return (
    <div className="space-y-4">
      <div className="mx-6 mt-6 rounded-xl border border-cyan/20 bg-cyan/5 p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          {status === 'success' ? <CheckCircle2 className="w-5 h-5 text-emerald-400 mt-0.5" /> : <Clock className="w-5 h-5 text-cyan mt-0.5" />}
          <div>
            <p className="text-sm font-semibold text-white">Produtos & Ads — atualização automática ativa</p>
            <p className="text-xs text-slate-400 mt-1">Campanhas, catálogo, estoque e vínculos são atualizados automaticamente nas janelas 00:00–04:00 e 13:00–14:00.</p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-slate-500">
              <span>Última atualização: {formatDateTime(lastUpdate)}</span>
              <span>Próxima atualização: {windowInfo.label}</span>
              {account?.status && <span>Conta Amazon: {account.status === 'connected' ? 'conectada' : account.status}</span>}
            </div>
          </div>
        </div>
        <button type="button" onClick={readStatus} className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-surface-3 bg-surface-2 text-xs font-semibold text-slate-300 hover:text-white">
          <RefreshCw className="w-4 h-4" />
          Atualizar status
        </button>
      </div>
      <Products key={refreshKey} />
    </div>
  );
}
