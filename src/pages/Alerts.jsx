import { useState, useEffect, useCallback } from 'react';
import React from 'react';
import { base44 } from '@/api/base44Client';
import {
  AlertTriangle, Bell, Check, Loader2, TrendingUp, TrendingDown,
  DollarSign, Package, Eye, RefreshCw, Zap, XCircle, Filter
} from 'lucide-react';

const ALERT_CONFIG = {
  high_acos:        { icon: TrendingUp,   color: 'text-red-400',    bg: 'bg-red-500/10',    border: 'border-red-500/20',    label: 'ACoS Alto' },
  low_roas:         { icon: TrendingDown, color: 'text-amber-400',  bg: 'bg-amber-500/10',  border: 'border-amber-500/20',  label: 'ROAS Baixo' },
  budget_exhausted: { icon: DollarSign,   color: 'text-red-400',    bg: 'bg-red-500/10',    border: 'border-red-500/20',    label: 'Budget Esgotado' },
  no_impressions:   { icon: Eye,          color: 'text-amber-400',  bg: 'bg-amber-500/10',  border: 'border-amber-500/20',  label: 'Sem Impressões' },
  out_of_stock:     { icon: Package,      color: 'text-red-400',    bg: 'bg-red-500/10',    border: 'border-red-500/20',    label: 'Sem Estoque' },
  token_expired:    { icon: XCircle,      color: 'text-red-400',    bg: 'bg-red-500/10',    border: 'border-red-500/20',    label: 'Token Expirado' },
  high_cpc:         { icon: DollarSign,   color: 'text-amber-400',  bg: 'bg-amber-500/10',  border: 'border-amber-500/20',  label: 'CPC Alto' },
  campaign_paused:  { icon: XCircle,      color: 'text-slate-400',  bg: 'bg-slate-500/10',  border: 'border-slate-500/20',  label: 'Campanha Pausada' },
  rate_limit:       { icon: AlertTriangle,color: 'text-amber-400',  bg: 'bg-amber-500/10',  border: 'border-amber-500/20',  label: 'Rate Limit' },
  sync_error:       { icon: AlertTriangle,color: 'text-red-400',    bg: 'bg-red-500/10',    border: 'border-red-500/20',    label: 'Erro de Sync' },
};

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

export default function Alerts() {
  const [alerts, setAlerts]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [account, setAccount] = useState(null);
  const [filter, setFilter]   = useState('all');
  const [generating, setGenerating] = useState(false);
  const [genMsg, setGenMsg]   = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accounts[0] || (await base44.entities.AmazonAccount.list())[0];
      setAccount(acc);
      if (!acc) return;
      const all = await base44.entities.Alert.filter(
        { amazon_account_id: acc.id }, '-created_at', 200
      );
      setAlerts(all.sort((a, b) =>
        (SEVERITY_ORDER[a.severity] ?? 4) - (SEVERITY_ORDER[b.severity] ?? 4)
      ));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const resolve = async (id) => {
    await base44.entities.Alert.update(id, { status: 'resolved', resolved_at: new Date().toISOString() });
    setAlerts(prev => prev.map(a => a.id === id ? { ...a, status: 'resolved' } : a));
  };

  const acknowledge = async (id) => {
    await base44.entities.Alert.update(id, { status: 'acknowledged', acknowledged_at: new Date().toISOString() });
    setAlerts(prev => prev.map(a => a.id === id ? { ...a, status: 'acknowledged' } : a));
  };

  const generateAlerts = async () => {
    if (!account) return;
    setGenerating(true);
    setGenMsg(null);
    try {
      const res = await base44.functions.invoke('checkAndCreateAlerts', { amazon_account_id: account.id });
      const d = res.data;
      setGenMsg(d?.ok ? `✓ ${d.alerts_created || 0} novos alertas gerados` : `❌ ${d?.error || 'Erro'}`);
      await load();
    } catch (e) {
      setGenMsg(`❌ ${e.message}`);
    } finally {
      setGenerating(false);
      setTimeout(() => setGenMsg(null), 8000);
    }
  };

  const filtered = alerts.filter(a => {
    if (filter === 'active') return a.status === 'active';
    if (filter === 'acknowledged') return a.status === 'acknowledged';
    if (filter === 'resolved') return a.status === 'resolved';
    if (filter === 'critical') return a.severity === 'critical';
    if (filter === 'high') return a.severity === 'high';
    return true;
  });

  const active = alerts.filter(a => a.status === 'active').length;
  const acknowledged = alerts.filter(a => a.status === 'acknowledged').length;
  const bySeverity = {
    critical: alerts.filter(a => a.severity === 'critical' && a.status === 'active').length,
    high: alerts.filter(a => a.severity === 'high' && a.status === 'active').length,
  };

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
            <Bell className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Alertas</h1>
            <p className="text-xs text-slate-400">
              {active} ativos · {acknowledged} reconhecidos · {alerts.length} total
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={generateAlerts} disabled={generating || !account}
            className="flex items-center gap-2 px-3 py-2 bg-cyan/10 border border-cyan/20 text-cyan hover:bg-cyan/20 text-xs font-semibold rounded-lg transition-colors disabled:opacity-50">
            {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
            {generating ? 'Gerando...' : 'Gerar Alertas'}
          </button>
          <button onClick={load} disabled={loading}
            className="p-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {genMsg && (
        <div className={`px-4 py-3 rounded-xl border text-sm font-medium ${genMsg.startsWith('✓') ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300' : 'bg-red-400/10 border-red-400/20 text-red-400'}`}>
          {genMsg}
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'Ativos', value: active, color: active > 0 ? 'text-amber-400' : 'text-emerald-400' },
          { label: 'Críticos', value: bySeverity.critical, color: bySeverity.critical > 0 ? 'text-red-400' : 'text-slate-400' },
          { label: 'Alta Prioridade', value: bySeverity.high, color: bySeverity.high > 0 ? 'text-amber-400' : 'text-slate-400' },
          { label: 'Reconhecidos', value: acknowledged, color: 'text-slate-400' },
        ].map(k => (
          <div key={k.label} className="bg-surface-1 border border-surface-2 rounded-xl p-4">
            <p className="text-xs text-slate-500 mb-1">{k.label}</p>
            <p className={`text-2xl font-bold ${k.color}`}>{k.value}</p>
          </div>
        ))}
      </div>

      {/* Filtros */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <Filter className="w-3.5 h-3.5 text-slate-500" />
        {[
          { key: 'all', label: `Todos (${alerts.length})` },
          { key: 'active', label: `Ativos (${active})` },
          { key: 'acknowledged', label: `Reconhecidos (${acknowledged})` },
          { key: 'high', label: `Alta Prioridade (${bySeverity.high})` },
          { key: 'critical', label: `Críticos (${bySeverity.critical})` },
        ].map(f => (
          <button key={f.key} onClick={() => setFilter(f.key)}
            className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${filter === f.key ? 'bg-cyan/20 text-cyan border-cyan/30' : 'bg-surface-2 text-slate-500 border-surface-3 hover:text-slate-300'}`}>
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <Bell className="w-12 h-12 text-slate-600" />
          <p className="text-sm text-slate-400">{alerts.length === 0 ? 'Sem alertas. Clique em "Gerar Alertas" para verificar.' : 'Nenhum alerta com este filtro.'}</p>
        </div>
      ) : (
        <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-2 bg-surface-2/40">
                  {['Tipo', 'Severidade', 'Título', 'Mensagem', 'Entidade', 'Status', 'Data', 'Ações'].map(h => (
                    <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(a => {
                  const cfg = ALERT_CONFIG[a.alert_type] || { icon: AlertTriangle, color: 'text-slate-400', bg: 'bg-slate-500/10', border: 'border-slate-500/20', label: a.alert_type };
                  const Icon = cfg.icon;
                  const isResolved = a.status === 'resolved';
                  return (
                    <tr key={a.id} className={`border-b border-surface-2/40 hover:bg-surface-2/30 transition-colors ${isResolved ? 'opacity-50' : ''}`}>
                      <td className="px-4 py-3">
                        <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-semibold ${cfg.bg} ${cfg.color} border ${cfg.border}`}>
                          <Icon className="w-3 h-3" />
                          {cfg.label}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                          a.severity === 'critical' ? 'bg-red-500/20 text-red-400' :
                          a.severity === 'high' ? 'bg-amber-500/20 text-amber-400' :
                          a.severity === 'medium' ? 'bg-yellow-500/20 text-yellow-400' :
                          'bg-slate-500/20 text-slate-400'
                        }`}>
                          {a.severity || 'medium'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs font-semibold text-white max-w-[180px] truncate">{a.title}</td>
                      <td className="px-4 py-3 text-xs text-slate-400 max-w-[220px] truncate">{a.message || '—'}</td>
                      <td className="px-4 py-3 text-xs font-mono text-cyan">{a.keyword_id || a.campaign_id || a.asin || '—'}</td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          a.status === 'active' ? 'bg-amber-500/20 text-amber-400' :
                          a.status === 'acknowledged' ? 'bg-blue-500/20 text-blue-400' :
                          'bg-emerald-500/20 text-emerald-400'
                        }`}>
                          {a.status || 'active'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">
                        {a.created_at ? new Date(a.created_at).toLocaleDateString('pt-BR') : '—'}
                      </td>
                      <td className="px-4 py-3">
                        {!isResolved && (
                          <div className="flex items-center gap-1.5">
                            {a.status === 'active' && (
                              <button onClick={() => acknowledge(a.id)}
                                className="p-1.5 bg-blue-500/10 border border-blue-500/20 text-blue-400 hover:bg-blue-500/20 rounded-lg transition-colors" title="Reconhecer">
                                <Eye className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button onClick={() => resolve(a.id)}
                              className="p-1.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 rounded-lg transition-colors" title="Resolver">
                              <Check className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}