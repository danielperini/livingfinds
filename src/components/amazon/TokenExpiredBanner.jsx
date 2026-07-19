import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { AlertTriangle, ExternalLink, X } from 'lucide-react';
import { Link } from 'react-router-dom';

/**
 * Banner fixo exibido quando há Alert ativo de alert_type='token_expired'
 * Persiste até o sistema limpar o alerta automaticamente.
 */
export default function TokenExpiredBanner({ accountId }) {
  const [alert, setAlert]       = useState(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;

    const check = async () => {
      try {
        const alerts = await base44.entities.Alert.filter(
          { amazon_account_id: accountId, alert_type: 'token_expired', status: 'active' },
          '-created_at', 1
        );
        if (!cancelled) setAlert(alerts[0] || null);
      } catch { /* silencioso */ }
    };

    check();
    const interval = setInterval(check, 60000); // re-verifica a cada 1 min
    return () => { cancelled = true; clearInterval(interval); };
  }, [accountId]);

  if (!alert || dismissed) return null;

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-xl border bg-red-500/10 border-red-500/30 text-sm mb-1">
      <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="font-semibold text-red-300">Token Amazon Ads expirado</span>
        <span className="text-red-300/80 ml-2">
          {alert.message || 'Acesse /amazon-oauth-setup para reconectar.'}
        </span>
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