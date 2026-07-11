import React, { useEffect, useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertCircle, Bot, Loader2, Target } from 'lucide-react';
import { base44 } from '@/api/base44Client';

const DAYS = 30;

function fmtBRL(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
  }).format(Number(value || 0));
}

function fmtDate(date) {
  const [, month, day] = String(date || '').split('-');
  return day && month ? `${day}/${month}` : date;
}

function dateOnly(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value).slice(0, 10) : parsed.toISOString().slice(0, 10);
}

function buildClosedDates(days = DAYS) {
  const dates = [];
  const end = new Date();
  end.setDate(end.getDate() - 1);
  end.setHours(0, 0, 0, 0);

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(end);
    date.setDate(end.getDate() - offset);
    dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
}

function dedupeMetrics(metrics) {
  const records = new Map();
  for (const metric of metrics || []) {
    if (!metric?.date) continue;
    const key = `${metric.amazon_account_id || ''}:${metric.campaign_id || ''}:${metric.date}`;
    if (!records.has(key)) records.set(key, metric);
  }
  return Array.from(records.values());
}

function ChartCard({ title, description, children, summary }) {
  return (
    <section className="bg-surface-1 border border-surface-2 rounded-xl p-5 min-w-0">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-300">{title}</h2>
          <p className="text-[10px] text-slate-500 mt-0.5">{description}</p>
        </div>
        {summary && <div className="text-right text-xs font-semibold text-white shrink-0">{summary}</div>}
      </div>
      {children}
    </section>
  );
}

function GoalDistanceCard({ currentAcos, targetAcos, source }) {
  const hasTarget = Number(targetAcos) > 0;
  const current = Number(currentAcos || 0);
  const target = Number(targetAcos || 0);
  const distance = hasTarget ? current - target : null;
  const achieved = hasTarget && current > 0 && current <= target;
  const progress = !hasTarget || current <= 0
    ? 0
    : Math.min(100, Math.round((target / current) * 100));

  return (
    <section className={`rounded-xl border p-5 ${
      achieved
        ? 'bg-emerald-500/5 border-emerald-500/20'
        : hasTarget
          ? 'bg-amber-500/5 border-amber-500/20'
          : 'bg-surface-1 border-surface-2'
    }`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className={`p-2 rounded-lg ${achieved ? 'bg-emerald-500/10' : 'bg-cyan/10'}`}>
            <Target className={`w-5 h-5 ${achieved ? 'text-emerald-400' : 'text-cyan'}`} />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-slate-200">Distância da IA para a meta principal</h2>
            <p className="text-[10px] text-slate-500 mt-0.5">
              ACoS dos últimos 14 dias comparado ao ACoS alvo · fonte: {source || 'configuração da conta'}
            </p>
          </div>
        </div>
        <span className={`text-xs font-semibold px-2 py-1 rounded-full ${
          achieved
            ? 'bg-emerald-500/15 text-emerald-400'
            : hasTarget
              ? 'bg-amber-500/15 text-amber-400'
              : 'bg-surface-2 text-slate-500'
        }`}>
          {achieved ? 'Meta atingida' : hasTarget ? 'Em otimização' : 'Meta não configurada'}
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
        <div className="bg-black/10 rounded-lg p-3">
          <p className="text-[10px] text-slate-500">ACoS atual</p>
          <p className="text-lg font-bold text-white mt-1">{current > 0 ? `${current.toFixed(1)}%` : '—'}</p>
        </div>
        <div className="bg-black/10 rounded-lg p-3">
          <p className="text-[10px] text-slate-500">Meta principal</p>
          <p className="text-lg font-bold text-cyan mt-1">{hasTarget ? `${target.toFixed(1)}%` : '—'}</p>
        </div>
        <div className="bg-black/10 rounded-lg p-3">
          <p className="text-[10px] text-slate-500">Distância</p>
          <p className={`text-lg font-bold mt-1 ${distance !== null && distance <= 0 ? 'text-emerald-400' : 'text-amber-400'}`}>
            {distance === null ? '—' : `${Math.abs(distance).toFixed(1)} p.p. ${distance <= 0 ? 'abaixo' : 'acima'}`}
          </p>
        </div>
        <div className="bg-black/10 rounded-lg p-3">
          <p className="text-[10px] text-slate-500">Progresso</p>
          <p className="text-lg font-bold text-white mt-1">{hasTarget && current > 0 ? `${progress}%` : '—'}</p>
        </div>
      </div>

      {hasTarget && current > 0 && (
        <div className="mt-4 h-2 rounded-full bg-surface-3 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${achieved ? 'bg-emerald-400' : 'bg-cyan'}`}
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
    </section>
  );
}

export default function SeparatedPerformanceCharts() {
  const [state, setState] = useState({ loading: true, error: null, data: null });

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const user = await base44.auth.me();
        const accounts = await base44.entities.AmazonAccount.filter({ user_id: user.id }, '-updated_date', 5);
        const account = accounts.find((item) => item.status === 'connected') || accounts[0];
        if (!account) throw new Error('Nenhuma conta Amazon conectada.');

        const [metrics, decisions, campaigns, settings, autopilot, canonicalResponse] = await Promise.all([
          base44.entities.CampaignMetricsDaily.filter({ amazon_account_id: account.id }, '-date', 5000),
          base44.entities.OptimizationDecision.filter({ amazon_account_id: account.id }, '-created_at', 2000),
          base44.entities.Campaign.filter({ amazon_account_id: account.id }, '-created_at', 2000),
          base44.entities.PerformanceSettings.filter({ amazon_account_id: account.id }, '-updated_at', 1),
          base44.entities.AutopilotConfig.filter({ amazon_account_id: account.id }, '-updated_at', 1),
          base44.functions.invoke('getCanonicalAccountContext', { amazon_account_id: account.id }).catch(() => null),
        ]);

        if (!active) return;
        setState({
          loading: false,
          error: null,
          data: {
            metrics: dedupeMetrics(metrics),
            decisions,
            campaigns,
            settings: settings[0] || null,
            autopilot: autopilot[0] || null,
            canonical: canonicalResponse?.data || null,
          },
        });
      } catch (error) {
        if (active) setState({ loading: false, error: error.message, data: null });
      }
    }

    load();
    return () => { active = false; };
  }, []);

  const derived = useMemo(() => {
    if (!state.data) return null;
    const { metrics, decisions, campaigns, settings, autopilot, canonical } = state.data;
    const dates = buildClosedDates();
    const dateSet = new Set(dates);
    const byDate = new Map(dates.map((date) => [date, {
      date,
      gasto: 0,
      vendas: 0,
      cliques: 0,
      impressoes: 0,
      alteracoes: 0,
      campanhasCriadas: 0,
      campanhasAlteradas: new Set(),
    }]));

    for (const metric of metrics) {
      if (!dateSet.has(metric.date)) continue;
      const row = byDate.get(metric.date);
      row.gasto += Number(metric.spend || 0);
      row.vendas += Number(metric.sales || 0);
      row.cliques += Number(metric.clicks || 0);
      row.impressoes += Number(metric.impressions || 0);
    }

    const createdCampaignIdsByDate = new Map();
    for (const campaign of campaigns) {
      if (!campaign.created_by_app) continue;
      const createdDate = dateOnly(campaign.created_at || campaign.created_date);
      if (!createdDate || !dateSet.has(createdDate)) continue;
      const row = byDate.get(createdDate);
      row.campanhasCriadas += 1;
      if (!createdCampaignIdsByDate.has(createdDate)) createdCampaignIdsByDate.set(createdDate, new Set());
      const campaignId = campaign.campaign_id || campaign.amazon_campaign_id || campaign.id;
      if (campaignId) createdCampaignIdsByDate.get(createdDate).add(String(campaignId));
    }

    for (const decision of decisions) {
      if (String(decision.status || '').toLowerCase() !== 'executed') continue;
      const decisionDate = dateOnly(decision.executed_at || decision.created_at || decision.created_date);
      if (!decisionDate || !dateSet.has(decisionDate)) continue;
      const row = byDate.get(decisionDate);
      row.alteracoes += 1;
      const campaignId = decision.campaign_id || decision.entity_id;
      const createdIds = createdCampaignIdsByDate.get(decisionDate);
      if (campaignId && !createdIds?.has(String(campaignId))) row.campanhasAlteradas.add(String(campaignId));
    }

    const chartData = dates.map((date) => {
      const row = byDate.get(date);
      return {
        date: fmtDate(date),
        gasto: Number(row.gasto.toFixed(2)),
        vendas: Number(row.vendas.toFixed(2)),
        cliques: row.cliques,
        impressoes: row.impressoes,
        alteracoes: row.alteracoes,
        campanhasCriadas: row.campanhasCriadas,
        campanhasAlteradas: row.campanhasAlteradas.size,
      };
    });

    const totals = chartData.reduce((acc, row) => ({
      gasto: acc.gasto + row.gasto,
      vendas: acc.vendas + row.vendas,
      cliques: acc.cliques + row.cliques,
      impressoes: acc.impressoes + row.impressoes,
      alteracoes: acc.alteracoes + row.alteracoes,
      campanhasCriadas: acc.campanhasCriadas + row.campanhasCriadas,
      campanhasAlteradas: acc.campanhasAlteradas + row.campanhasAlteradas,
    }), { gasto: 0, vendas: 0, cliques: 0, impressoes: 0, alteracoes: 0, campanhasCriadas: 0, campanhasAlteradas: 0 });

    const targetAcos = Number(
      canonical?.settings?.target_acos
      || settings?.target_acos
      || autopilot?.target_acos
      || 0
    );
    const currentAcos = Number(canonical?.kpis_14d?.acos || (() => {
      const last14 = metrics.filter((metric) => {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 14);
        return metric.date >= cutoff.toISOString().slice(0, 10);
      });
      const spend = last14.reduce((sum, metric) => sum + Number(metric.spend || 0), 0);
      const sales = last14.reduce((sum, metric) => sum + Number(metric.sales || 0), 0);
      return sales > 0 ? (spend / sales) * 100 : 0;
    })());

    return {
      chartData,
      totals,
      targetAcos,
      currentAcos,
      goalSource: canonical?.settings?.source || (settings ? 'PerformanceSettings' : autopilot ? 'AutopilotConfig' : 'não configurada'),
    };
  }, [state.data]);

  if (state.loading) {
    return (
      <div className="bg-surface-1 border border-surface-2 rounded-xl h-56 flex items-center justify-center">
        <Loader2 className="w-5 h-5 text-cyan animate-spin" />
      </div>
    );
  }

  if (state.error || !derived) {
    return (
      <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-4 flex items-center gap-2 text-xs text-red-300">
        <AlertCircle className="w-4 h-4" />
        Não foi possível carregar os gráficos separados: {state.error || 'dados indisponíveis'}
      </div>
    );
  }

  const { chartData, totals, targetAcos, currentAcos, goalSource } = derived;

  return (
    <div className="space-y-4" data-separated-performance-charts="true">
      <GoalDistanceCard currentAcos={currentAcos} targetAcos={targetAcos} source={goalSource} />

      <ChartCard
        title="Gasto e Vendas Ads"
        description="Últimos 30 dias fechados · valores atribuídos pela Amazon Ads"
        summary={`${fmtBRL(totals.gasto)} / ${fmtBRL(totals.vendas)}`}
      >
        <ResponsiveContainer width="100%" height={230}>
          <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="sepSpend" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.28} />
                <stop offset="95%" stopColor="#3B82F6" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="sepSales" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#10B981" stopOpacity={0.28} />
                <stop offset="95%" stopColor="#10B981" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
            <XAxis dataKey="date" tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false} width={44} tickFormatter={(value) => value >= 1000 ? `${Math.round(value / 1000)}k` : value} />
            <Tooltip formatter={(value, name) => [fmtBRL(value), name]} contentStyle={{ background: '#111318', border: '1px solid #252936', borderRadius: 8, fontSize: 11 }} />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            <Area type="monotone" dataKey="gasto" name="Gasto Ads" stroke="#3B82F6" fill="url(#sepSpend)" strokeWidth={2} dot={false} />
            <Area type="monotone" dataKey="vendas" name="Vendas Ads" stroke="#10B981" fill="url(#sepSales)" strokeWidth={2} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <ChartCard title="Cliques" description="Cliques por dia em colunas" summary={totals.cliques.toLocaleString('pt-BR')}>
          <ResponsiveContainer width="100%" height={210}>
            <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
              <XAxis dataKey="date" tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false} width={38} />
              <Tooltip contentStyle={{ background: '#111318', border: '1px solid #252936', borderRadius: 8, fontSize: 11 }} />
              <Bar dataKey="cliques" name="Cliques" fill="#38BDF8" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Impressões" description="Impressões por dia em colunas" summary={totals.impressoes.toLocaleString('pt-BR')}>
          <ResponsiveContainer width="100%" height={210}>
            <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
              <XAxis dataKey="date" tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false} width={42} tickFormatter={(value) => value >= 1000 ? `${Math.round(value / 1000)}k` : value} />
              <Tooltip contentStyle={{ background: '#111318', border: '1px solid #252936', borderRadius: 8, fontSize: 11 }} />
              <Bar dataKey="impressoes" name="Impressões" fill="#8B5CF6" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <ChartCard
        title="Desempenho da IA"
        description="Ações executadas e campanhas efetivamente criadas ou alteradas por dia"
        summary={`${totals.alteracoes.toLocaleString('pt-BR')} ações`}
      >
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="bg-surface-2 rounded-lg p-3">
            <p className="text-[10px] text-slate-500">Alterações executadas</p>
            <p className="text-lg font-bold text-amber-400 mt-1">{totals.alteracoes.toLocaleString('pt-BR')}</p>
          </div>
          <div className="bg-surface-2 rounded-lg p-3">
            <p className="text-[10px] text-slate-500">Campanhas criadas</p>
            <p className="text-lg font-bold text-emerald-400 mt-1">{totals.campanhasCriadas.toLocaleString('pt-BR')}</p>
          </div>
          <div className="bg-surface-2 rounded-lg p-3">
            <p className="text-[10px] text-slate-500">Campanhas alteradas</p>
            <p className="text-lg font-bold text-cyan mt-1">{totals.campanhasAlteradas.toLocaleString('pt-BR')}</p>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={230}>
          <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
            <XAxis dataKey="date" tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false} width={38} />
            <Tooltip contentStyle={{ background: '#111318', border: '1px solid #252936', borderRadius: 8, fontSize: 11 }} />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            <Bar dataKey="alteracoes" name="Alterações da IA" fill="#F59E0B" radius={[3, 3, 0, 0]} />
            <Bar dataKey="campanhasCriadas" name="Campanhas criadas" fill="#10B981" radius={[3, 3, 0, 0]} />
            <Bar dataKey="campanhasAlteradas" name="Campanhas alteradas" fill="#22D3EE" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
        <div className="flex items-center gap-2 mt-3 text-[10px] text-slate-500">
          <Bot className="w-3.5 h-3.5 text-amber-400" />
          Contagens calculadas somente a partir de campanhas e decisões persistidas no app.
        </div>
      </ChartCard>
    </div>
  );
}
