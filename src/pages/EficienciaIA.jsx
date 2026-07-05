/**
 * EficienciaIA — Dashboard de uso e eficiência
 * Exibe consumo de IA, API e cache em tempo real para monitoramento de custos.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { RefreshCw, Zap, Database, Brain, TrendingDown, AlertTriangle, CheckCircle, Clock, DollarSign, BarChart2 } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line } from 'recharts';

function Kpi({ label, value, sub, color = 'text-white', icon: Icon, loading }) {
  if (loading) return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-4 animate-pulse">
      <div className="h-3 w-20 bg-surface-3 rounded mb-2" />
      <div className="h-6 w-28 bg-surface-3 rounded" />
    </div>
  );
  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
      <div className="flex items-center gap-1.5 mb-1">
        {Icon && <Icon className="w-3.5 h-3.5 text-slate-500" />}
        <p className="text-[11px] text-slate-400">{label}</p>
      </div>
      <p className={`text-xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-[10px] text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );
}

export default function EficienciaIA() {
  const [logs, setLogs] = useState([]);
  const [today, setToday] = useState(null);
  const [loading, setLoading] = useState(true);
  const [account, setAccount] = useState(null);
  const [aiCacheEntries, setAiCacheEntries] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      let accs = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      if (!accs.length) accs = await base44.entities.AmazonAccount.list();
      const acc = accs[0];
      if (!acc) { setLoading(false); return; }
      setAccount(acc);
      const aid = acc.id;

      const [usageLogs, cacheItems] = await Promise.all([
        base44.entities.AIUsageLog.filter({ amazon_account_id: aid }, '-log_date', 14),
        base44.entities.AIAnalysisCache.filter({ amazon_account_id: aid, status: 'valid' }, '-created_date', 30),
      ]);

      setLogs(usageLogs);
      setAiCacheEntries(cacheItems);
      const todayStr = new Date().toISOString().slice(0, 10);
      setToday(usageLogs.find(l => l.log_date === todayStr) || null);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const t = today || {};
  const calls_pct = t.calls_limit ? Math.round((t.calls_made || 0) / t.calls_limit * 100) : 0;
  const tokens_pct = t.tokens_limit ? Math.round((t.tokens_used || 0) / t.tokens_limit * 100) : 0;
  const total_avoided = (t.calls_avoided_cache || 0) + (t.calls_avoided_rules || 0);
  const efficiency_pct = (t.calls_made || 0) + total_avoided > 0
    ? Math.round(total_avoided / ((t.calls_made || 0) + total_avoided) * 100) : 0;

  const chartData = [...logs].reverse().map(l => ({
    date: l.log_date?.slice(5) || '',
    ai_calls: l.calls_made || 0,
    avoided: (l.calls_avoided_cache || 0) + (l.calls_avoided_rules || 0),
    api_ads: l.api_calls_ads || 0,
    api_sp: l.api_calls_sp || 0,
    cost: l.cost_estimate || 0,
    local: l.local_calculations || 0,
  }));

  // Classificar cache por tipo
  const cacheByType = aiCacheEntries.reduce((acc, e) => {
    const t = e.analysis_type || 'other';
    if (!acc[t]) acc[t] = { count: 0, reuses: 0 };
    acc[t].count++;
    acc[t].reuses += e.reuse_count || 0;
    return acc;
  }, {});

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-white flex items-center gap-2">
            <Zap className="w-5 h-5 text-cyan" /> Uso e Eficiência
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">Monitoramento de IA, API Amazon e cache — hoje</p>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-2 px-3 py-2 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-sm rounded-lg transition-colors">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* KPIs do dia */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Chamadas IA hoje" value={`${t.calls_made || 0} / ${t.calls_limit || 20}`}
          sub={`${calls_pct}% do limite diário`}
          color={calls_pct > 80 ? 'text-red-400' : calls_pct > 50 ? 'text-amber-400' : 'text-emerald-400'}
          icon={Brain} loading={loading} />
        <Kpi label="Tokens usados" value={(t.tokens_used || 0).toLocaleString('pt-BR')}
          sub={`${tokens_pct}% do limite`}
          color={tokens_pct > 80 ? 'text-red-400' : 'text-slate-300'}
          icon={BarChart2} loading={loading} />
        <Kpi label="Custo estimado" value={`R$ ${(t.cost_estimate || 0).toFixed(4)}`}
          sub="hoje" color="text-amber-400" icon={DollarSign} loading={loading} />
        <Kpi label="Eficiência de cache" value={`${efficiency_pct}%`}
          sub={`${total_avoided} chamadas evitadas`}
          color={efficiency_pct > 60 ? 'text-emerald-400' : 'text-amber-400'}
          icon={TrendingDown} loading={loading} />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Chamadas Amazon Ads" value={t.api_calls_ads || 0}
          sub="hoje" icon={Database} loading={loading} />
        <Kpi label="Chamadas SP-API" value={t.api_calls_sp || 0}
          sub="hoje" icon={Database} loading={loading} />
        <Kpi label="Evitadas por cache" value={t.calls_avoided_cache || 0}
          color="text-emerald-400" sub="API + IA" icon={CheckCircle} loading={loading} />
        <Kpi label="Cálculos locais" value={t.local_calculations || 0}
          color="text-cyan" sub="sem IA" icon={Zap} loading={loading} />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Decisões reutilizadas" value={t.decisions_reused || 0}
          color="text-violet-400" sub="do cache de IA" icon={Brain} loading={loading} />
        <Kpi label="Ações em fila" value={t.queue_actions || 0}
          sub="Amazon Action Queue" icon={Clock} loading={loading} />
        <Kpi label="Chamadas agrupadas" value={t.api_calls_grouped || 0}
          color="text-emerald-400" sub="bulk endpoints" icon={CheckCircle} loading={loading} />
        <Kpi label="Chamadas evitadas (regras)" value={t.calls_avoided_rules || 0}
          color="text-cyan" sub="RuleEngine local" icon={Zap} loading={loading} />
      </div>

      {/* Barra de limite de IA */}
      {calls_pct > 70 && (
        <div className={`flex items-start gap-3 p-4 rounded-xl border text-sm ${calls_pct >= 100 ? 'bg-red-500/10 border-red-500/30 text-red-300' : 'bg-amber-500/10 border-amber-500/30 text-amber-300'}`}>
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">{calls_pct >= 100 ? 'Limite diário de IA atingido' : 'Orçamento de IA quase esgotado'}</p>
            <p className="text-xs mt-0.5 opacity-80">
              {calls_pct >= 100
                ? 'Apenas análises críticas serão processadas. Regras locais em uso para os demais casos.'
                : `${t.calls_limit - t.calls_made} chamadas restantes hoje. Análises estratégicas serão priorizadas.`}
            </p>
          </div>
        </div>
      )}

      {/* Gráficos históricos */}
      {chartData.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Chamadas IA vs Evitadas */}
          <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-slate-300 mb-4">Chamadas IA: usadas vs evitadas (14d)</h2>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={{ background: '#111318', border: '1px solid #1A1D26', borderRadius: 8, fontSize: 11 }} />
                <Bar dataKey="ai_calls" fill="#8B5CF6" radius={[4,4,0,0]} name="Chamadas IA" />
                <Bar dataKey="avoided" fill="#10B981" radius={[4,4,0,0]} name="Evitadas" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Custo estimado */}
          <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-slate-300 mb-4">Custo estimado IA (14d) — R$</h2>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ background: '#111318', border: '1px solid #1A1D26', borderRadius: 8, fontSize: 11 }}
                  formatter={(v) => [`R$ ${Number(v).toFixed(4)}`, 'Custo']} />
                <Line type="monotone" dataKey="cost" stroke="#F59E0B" strokeWidth={2} dot={false} name="Custo" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Cache de IA ativo */}
      {Object.keys(cacheByType).length > 0 && (
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
            <Brain className="w-4 h-4 text-violet-400" /> Cache de Análises IA (válidas)
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {Object.entries(cacheByType).map(([type, data]) => (
              <div key={type} className="bg-surface-2 rounded-lg p-3">
                <p className="text-[10px] text-slate-500 mb-1">{type.replace(/_/g, ' ')}</p>
                <p className="text-sm font-bold text-violet-400">{data.count} cached</p>
                <p className="text-[10px] text-emerald-400">{data.reuses} reusos</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Princípios de uso */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
          <CheckCircle className="w-4 h-4 text-emerald-400" /> Princípios de Eficiência Ativos
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-slate-400">
          {[
            ['✅', 'ACoS, ROAS, CPC calculados localmente (sem IA)'],
            ['✅', 'Budget e Bid por RuleEngine determinístico'],
            ['✅', 'IA bloqueada para cálculos simples'],
            ['✅', 'Cache de análise IA por 1–30 dias conforme tipo'],
            ['✅', 'shouldUseAI() verificado antes de toda chamada'],
            ['✅', 'hasMeaningfulChange() evita reanálises desnecessárias'],
            ['✅', 'Uma única análise IA consolidada por conta/dia'],
            ['✅', 'Freshness TTL por tipo de dado (6h, 12h, 24h, 7d)'],
            ['✅', 'Orçamento diário de IA com fila de prioridade'],
            ['✅', 'Todas as ações rastreadas em AmazonActionQueue'],
          ].map(([icon, label], i) => (
            <div key={i} className="flex items-start gap-2 py-1">
              <span>{icon}</span>
              <span>{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}