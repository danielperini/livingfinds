import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { AlertTriangle, Bell, Check, X, Loader2, TrendingUp, TrendingDown, DollarSign, Package } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 text-cyan animate-spin" />
      </div>
    );
  }

  if (!account) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
        <AlertTriangle className="w-8 h-8 text-slate-600" />
        <p className="text-sm text-slate-400">Nenhuma conta Amazon configurada.</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
            <Bell className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Alertas</h1>
            <p className="text-xs text-slate-400">{alerts.length} alertas ativos</p>
          </div>
        </div>
        <Button onClick={loadAlerts} size="sm" variant="outline">
          <Loader2 className="w-4 h-4" />
        </Button>
      </div>

      {alerts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <Bell className="w-12 h-12 text-slate-600" />
          <p className="text-sm text-slate-400">Sem alertas ativos.</p>
          <p className="text-xs text-slate-600">O sistema verifica automaticamente após cada sync.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {alerts.map(alert => {
            const config = getAlertConfig(alert.alert_type);
            const Icon = config.icon;
            return (
              <Card key={alert.id} className={`bg-surface-1 ${config.border} border`}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 flex-1">
                      <div className={`w-8 h-8 rounded-lg ${config.bg} flex items-center justify-center flex-shrink-0`}>
                        <Icon className={`w-4 h-4 ${config.color}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="text-sm font-semibold text-white">{alert.title}</h3>
                          <span className={`text-xs px-2 py-0.5 rounded-full ${
                            alert.severity === 'critical' ? 'bg-red-500/20 text-red-400' :
                            alert.severity === 'high' ? 'bg-amber-500/20 text-amber-400' :
                            'bg-slate-500/20 text-slate-400'
                          }`}>
                            {alert.severity}
                          </span>
                        </div>
                        <p className="text-xs text-slate-400 mb-2">{alert.message}</p>
                        {alert.current_value != null && alert.threshold_value != null && (
                          <div className="text-xs text-slate-500">
                            Atual: <span className="text-white">{alert.current_value}</span> · Limiar: <span className="text-amber-400">{alert.threshold_value}</span>
                          </div>
                        )}
                        <p className="text-xs text-slate-600 mt-2">
                          {new Date(alert.created_at).toLocaleString('pt-BR')}
                        </p>
                      </div>
                    </div>
                    <Button onClick={() => resolveAlert(alert.id)} size="sm" variant="outline">
                      <Check className="w-4 h-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}