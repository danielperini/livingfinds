import { useState } from 'react';
import { RefreshCw, CheckCircle, AlertCircle } from 'lucide-react';
import { base44 } from '@/api/base44Client';

export default function SyncButton({ amazonAccountId, onSuccess }) {
  const [state, setState] = useState('idle'); // idle | loading | success | error
  const [error, setError] = useState(null);

  const handleSync = async () => {
    if (!amazonAccountId) return;
    setState('loading');
    setError(null);
    try {
      const res = await base44.functions.invoke('syncAll', { amazon_account_id: amazonAccountId });
      if (res.data?.ok) {
        setState('success');
        onSuccess?.();
        setTimeout(() => setState('idle'), 3000);
      } else {
        throw new Error(res.data?.message || 'Sync failed');
      }
    } catch (err) {
      setState('error');
      setError(err.message || 'Sync error');
      setTimeout(() => setState('idle'), 4000);
    }
  };

  const config = {
    idle: { label: 'Sync All', icon: RefreshCw, cls: 'bg-cyan hover:bg-cyan/90 text-white' },
    loading: { label: 'Sincronizando...', icon: RefreshCw, cls: 'bg-cyan/70 text-white cursor-not-allowed' },
    success: { label: 'Concluído', icon: CheckCircle, cls: 'bg-emerald-600 text-white' },
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