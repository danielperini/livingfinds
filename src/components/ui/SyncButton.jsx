import { useState } from 'react';
import { RefreshCw, CheckCircle, AlertCircle } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { isXanoAuthenticated } from '@/lib/xanoClient';

export default function SyncButton({ amazonAccountId, onSuccess }) {
  const [state, setState] = useState('idle');
  const [error, setError] = useState(null);
  const xanoConnected = isXanoAuthenticated();

  const handleSync = async () => {
    if (!amazonAccountId) return;
    setState('loading');
    setError(null);
    try {
      // Sempre via xanoProxy (backend injeta XANO_API_KEY)
      const res = await base44.functions.invoke('xanoProxy', {
        method: 'POST',
        path: '/sync/full-daily',
        body: { amazon_account_id: amazonAccountId, date: new Date().toISOString().slice(0, 10) },
      });
      if (!res.data?.ok) throw new Error(res.data?.error || 'Sync failed');
      setState('success');
      onSuccess?.();
      setTimeout(() => setState('idle'), 3000);
    } catch (err) {
      setState('error');
      setError(err.message || 'Sync error');
      setTimeout(() => setState('idle'), 4000);
    }
  };

  const config = {
    idle: { label: 'Sync via Xano', icon: RefreshCw, cls: 'bg-cyan hover:bg-cyan/90 text-white' },
    loading: { label: 'Sincronizando...', icon: RefreshCw, cls: 'bg-cyan/70 text-white cursor-not-allowed' },
    success: { label: 'Concluído!', icon: CheckCircle, cls: 'bg-emerald-600 text-white' },
    error: { label: error || 'Erro', icon: AlertCircle, cls: 'bg-red-600 text-white' },
  };

  const cfg = config[state];
  const Icon = cfg.icon;

  return (
    <button
      onClick={handleSync}
      disabled={state === 'loading' || !amazonAccountId}
      className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-200 ${cfg.cls} disabled:opacity-50`}
    >
      <Icon className={`w-4 h-4 ${state === 'loading' ? 'animate-spin' : ''}`} />
      {cfg.label}
    </button>
  );
}