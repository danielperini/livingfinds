import { useState, useEffect, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import {
  AlertTriangle, Bell, Check, Loader2, TrendingUp, TrendingDown,
  DollarSign, Package, Wifi, RefreshCw, ChevronDown, ChevronRight, Clock
} from 'lucide-react';

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const SEVERITY_STYLE = {
  critical: { bar: 'bg-red-500', text: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/20' },
  high:     { bar: 'bg-orange-500', text: 'text-orange-400', bg: 'bg-orange-500/10', border: 'border-orange-500/20' },
  medium:   { bar: 'bg-amber-500', text: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/20' },
  low:      { bar: 'bg-blue-500', text: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/20' },
  info:     { bar: 'bg-slate-500', text: 'text-slate-400', bg: 'bg-slate-500/10', border: 'border-slate-500/20' },
};
const FAMILY_LABELS = {
  inventory: '📦 Estoque', performance: '📊 Performance',
  budget: '💸 Orçamento', token: '🔑 Token',
  sync: '🔄 Sincronização', keyword: '🔤 Keywords', campaign: '📣 Campanhas',
};
const TYPE_ICON = {
  high_acos: TrendingUp, low_roas: TrendingDown, no_sales: DollarSign,
  budget_exhausted: DollarSign, spend_overpacing: DollarSign, daily_cap_reached: DollarSign,
  out_of_stock: Package, low_stock: Package, critical_stock: Package,
  token_expired: Wifi, sync_error: RefreshCw, rate_limit: Wifi,
};

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function AlertRow({ alert, onResolve }) {
  const [expanded, setExpanded] = useState(false);
  const sev = alert.severity || 'medium';
  const style = SEVERITY_STYLE[sev] || SEVERITY_STYLE.medium;
  const Icon = TYPE_ICON[alert.alert_type] || AlertTriangle;

  return (
    <div className={`rounded-lg border ${style.bg} ${style.border} overflow-hidden`}>
      <div className="flex items-start gap-3 px-3 py-2.5">
        {/* Barra lateral de severidade */}
        <div className={`w-1 self-stretch rounded-full flex-shrink-0 ${style.bar}`} />
        <Icon className={`w-4 h-4 flex-shrink-0 mt-0.5 ${style.text}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-0.5">
            <span className={`text-[10px] font-bold uppercase ${style.text}`}>{sev}</span>
            <span className="text-[10px] text-slate-600">·</span>
            <span className="text-[10px] text-slate-500">{alert.alert_type?.replace(/_/g, ' ')}</span>
            {(alert.occurrence_count || 0) > 1 && (
              <span className="text-[10px] px-1.5 py-0.5 bg-surface-3 rounded-full text-slate-400 flex items-center gap-0.5">
                <Clock className="w-2.5 h-2.5" />{alert.occurrence_count}×
              </span>
            )}
          </div>
          <p className="text-xs font-semibold text-white leading-snug">{alert.title}</p>
          <p className="text-[11px] text-slate-400 mt-0.5 leading-snug">{alert.message}</p>

          {expanded && (
            <div className="mt-2 space-y-1">
              {alert.entity_type && <p className="text-[10px] text-slate-500">Entidade: <span className="text-slate-300">{alert.entity_type} / {alert.entity_id}</span></p>}
              {alert.asin && <p className="text-[10px] text-slate-500">ASIN: <span className="font-mono text-cyan">{alert.asin}</span></p>}
              {alert.campaign_id && <p className="text-[10px] text-slate-500">Campanha: <span className="text-slate-300">{alert.campaign_id}</span></p>}
              {alert.metric_name && <p className="text-[10px] text-slate-500">{alert.metric_name}: <span className="text-slate-300">{alert.metric_value} / limite {alert.threshold_value}</span></p>}
              {alert.first_detected_at && <p className="text-[10px] text-slate-500">1ª detecção: {fmtDate(alert.first_detected_at)}</p>}
              {alert.last_detected_at && <p className="text-[10px] text-slate-500">Última: {fmtDate(alert.last_detected_at)}</p>}
              {alert.source_function && <p className="text-[10px] text-slate-600">Fonte: {alert.source_function}</p>}
              {alert.data_freshness && alert.data_freshness !== 'unknown' && (
                <p className="text-[10px] text-slate-600">Dados: {alert.data_freshness}</p>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button onClick={() => setExpanded(v => !v)} className="p-1 text-slate-600 hover:text-slate-300 transition-colors">
            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </button>
          <button onClick={() => onResolve(alert.id)} className="p-1 text-slate-500 hover:text-emerald-400 transition-colors" title="Resolver">
            <Check className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AlertsPanel({ compact = false }) {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [account, setAccount] = useState(null);
  const [groupBy, setGroupBy] = useState('family');
  const [expandedGroups, setExpandedGroups] = useState(new Set());

  useEffect(() => { loadAlerts(); }, []);

  const loadAlerts = async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accounts[0];
      setAccount(acc);
      if (!acc) return;

      const allAlerts = await base44.entities.Alert.filter(
        { amazon_account_id: acc.id, status: 'active' },
        '-created_at', 100
      ).catch(() => []);
      setAlerts(allAlerts.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 5) - (SEVERITY_ORDER[b.severity] ?? 5)));
    } finally {
      setLoading(false);
    }
  };

  const resolveAlert = async (alertId) => {
    try {
      await base44.entities.Alert.update(alertId, {
        status: 'resolved',
        resolved_at: new Date().toISOString(),
        resolution_reason: 'manual_resolve',
        updated_at: new Date().toISOString(),
      });
      setAlerts(prev => prev.filter(a => a.id !== alertId));
    } catch (err) {
      console.error('Erro ao resolver alerta:', err);
    }
  };

  const toggleGroup = (key) => setExpandedGroups(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  const grouped = useMemo(() => {
    const map = new Map();
    for (const a of alerts) {
      const key = groupBy === 'family' ? (a.alert_family || 'outros')
        : groupBy === 'severity' ? (a.severity || 'medium')
        : (a.asin || a.campaign_id || 'conta');
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(a);
    }
    return Array.from(map.entries()).sort((a, b) => {
      if (groupBy === 'severity') return (SEVERITY_ORDER[a[0]] ?? 5) - (SEVERITY_ORDER[b[0]] ?? 5);
      return a[0].localeCompare(b[0]);
    });
  }, [alerts, groupBy]);

  if (!account) return null;

  const criticalCount = alerts.filter(a => a.severity === 'critical').length;
  const highCount = alerts.filter(a => a.severity === 'high').length;

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-2">
        <div className="flex items-center gap-2">
          <Bell className="w-4 h-4 text-cyan" />
          <span className="text-sm font-semibold text-white">Alertas</span>
          <span className="text-xs text-slate-500">({alerts.length})</span>
          {criticalCount > 0 && <span className="text-[10px] px-1.5 py-0.5 bg-red-500/15 border border-red-500/25 text-red-400 rounded-full font-bold">{criticalCount} críticos</span>}
          {highCount > 0 && <span className="text-[10px] px-1.5 py-0.5 bg-orange-500/15 border border-orange-500/25 text-orange-400 rounded-full">{highCount} altos</span>}
        </div>
        <div className="flex items-center gap-2">
          <select
            value={groupBy}
            onChange={e => setGroupBy(e.target.value)}
            className="text-[10px] bg-surface-2 border border-surface-3 text-slate-400 rounded px-1.5 py-1 focus:outline-none"
          >
            <option value="family">Por família</option>
            <option value="severity">Por severidade</option>
            <option value="asin">Por produto</option>
          </select>
          <button onClick={loadAlerts} className="p-1.5 text-slate-500 hover:text-slate-300 transition-colors">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className={`overflow-y-auto scrollbar-thin ${compact ? 'max-h-64' : 'max-h-[520px]'}`}>
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="w-5 h-5 text-cyan animate-spin" />
          </div>
        ) : alerts.length === 0 ? (
          <p className="text-sm text-slate-500 text-center py-8">✅ Sem alertas ativos</p>
        ) : (
          <div className="p-3 space-y-2">
            {grouped.map(([groupKey, groupAlerts]) => {
              const isOpen = expandedGroups.has(groupKey) || grouped.length <= 3;
              const label = groupBy === 'family' ? (FAMILY_LABELS[groupKey] || groupKey)
                : groupBy === 'severity' ? groupKey.toUpperCase()
                : `ASIN ${groupKey}`;
              const maxSev = groupAlerts.reduce((m, a) => (SEVERITY_ORDER[a.severity] ?? 5) < (SEVERITY_ORDER[m] ?? 5) ? a.severity : m, 'info');
              const st = SEVERITY_STYLE[maxSev] || SEVERITY_STYLE.info;
              return (
                <div key={groupKey} className="rounded-xl border border-surface-2 overflow-hidden">
                  <button
                    onClick={() => toggleGroup(groupKey)}
                    className="w-full flex items-center justify-between px-3 py-2 bg-surface-2/40 hover:bg-surface-2/70 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] font-bold ${st.text}`}>{label}</span>
                      <span className="text-[10px] text-slate-500">{groupAlerts.length} alerta{groupAlerts.length > 1 ? 's' : ''}</span>
                    </div>
                    {isOpen ? <ChevronDown className="w-3 h-3 text-slate-500" /> : <ChevronRight className="w-3 h-3 text-slate-500" />}
                  </button>
                  {isOpen && (
                    <div className="p-2 space-y-1.5">
                      {groupAlerts.map(alert => (
                        <AlertRow key={alert.id} alert={alert} onResolve={resolveAlert} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}