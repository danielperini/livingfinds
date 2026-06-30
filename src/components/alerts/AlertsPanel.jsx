import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { AlertTriangle, Bell, Check, X, Loader2, TrendingUp, TrendingDown, DollarSign, Package } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

const alertConfig = {
  budget_exhaustion: { icon: DollarSign, color: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/20' },
  high_acos: { icon: TrendingUp, color: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/20' },
  low_roas: { icon: TrendingDown, color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/20' },
  no_sales: { icon: DollarSign, color: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/20' },
  low_stock: { icon: Package, color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/20' },
};

export default function AlertsPanel() {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [account, setAccount] = useState(null);

  useEffect(() => {
    loadAlerts();
  }, []);

  const loadAlerts = async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accounts[0];
      setAccount(acc);
      if (!acc) return;

      const allAlerts = await base44.entities.Alert.filter(
        { amazon_account_id: acc.id, is_resolved: false },
        '-created_at',
        50
      );
      setAlerts(allAlerts);
    } finally {
      setLoading(false);
    }
  };

  const resolveAlert = async (alertId) => {
    try {
      await base44.entities.Alert.update(alertId, {
        is_resolved: true,
        resolved_at: new Date().toISOString(),
        resolved_by: (await base44.auth.me()).id,
      });
      setAlerts(prev => prev.filter(a => a.id !== alertId));
    } catch (err) {
      console.error('Erro ao resolver alerta:', err);
    }
  };

  const getAlertConfig = (type) => alertConfig[type] || { icon: AlertTriangle, color: 'text-slate-400', bg: 'bg-slate-500/10', border: 'border-slate-500/20' };

  if (!account) return null;

  return (
    <Card className="bg-surface-1 border-surface-2">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold text-white flex items-center gap-2">
          <Bell className="w-4 h-4 text-cyan" />
          Alertas ({alerts.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 text-cyan animate-spin" />
          </div>
        ) : alerts.length === 0 ? (
          <p className="text-sm text-slate-500 text-center py-4">Sem alertas ativos</p>
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto scrollbar-thin">
            {alerts.map(alert => {
              const Config = getAlertConfig(alert.alert_type);
              const Icon = Config.icon;
              return (
                <div key={alert.id} className={`p-3 rounded-lg border ${Config.bg} ${Config.border}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <Icon className={`w-4 h-4 ${Config.color}`} />
                        <span className={`text-xs font-semibold ${Config.color}`}>{alert.alert_type.replace('_', ' ').toUpperCase()}</span>
                        <span className="text-xs text-slate-500">({alert.severity})</span>
                      </div>
                      <p className="text-xs text-slate-300">{alert.title}</p>
                      <p className="text-xs text-slate-500 mt-0.5">{alert.message}</p>
                    </div>
                    <button onClick={() => resolveAlert(alert.id)} className="p-1 text-slate-500 hover:text-emerald-400 transition-colors">
                      <Check className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}