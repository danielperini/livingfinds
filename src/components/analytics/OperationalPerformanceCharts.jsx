import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertCircle, Bot, Loader2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';

const DAYS = 30;

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

function ChartCard({ title, description, summary, children }) {
  return (
    <section className="bg-surface-1 border border-surface-2 rounded-xl p-5 min-w-0">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-300">{title}</h2>
          <p className="text-[10px] text-slate-500 mt-0.5">{description}</p>
        </div>
        <div className="text-right text-xs font-semibold text-white shrink-0">{summary}</div>
      </div>
      {children}
    </section>
  );
}

export default function OperationalPerformanceCharts() {
  const [state, setState] = useState({ loading: true, error: null, metrics: [], decisions: [], campaigns: [] });

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const user = await base44.auth.me();
        let accounts = await base44.entities.AmazonAccount.filter({ user_id: user.id }, '-updated_date', 5);
        if (!accounts.length) accounts = await base44.entities.AmazonAccount.list();
        const account = accounts.find((item) => item.status === 'connected') || accounts[0];
        if (!account) throw new Error('Nenhuma conta Amazon conectada.');

        const [metrics, decisions, campaigns] = await Promise.all([
          base44.entities.CampaignMetricsDaily.filter({ amazon_account_id: account.id }, '-date', 5000),
          base44.entities.OptimizationDecision.filter({ amazon_account_id: account.id }, '-created_at', 2000),
          base44.entities.Campaign.filter({ amazon_account_id: account.id }, '-created_at', 2000),
        ]);

        if (active) setState({ loading: false, error: null, metrics: dedupeMetrics(metrics), decisions, campaigns });
      } catch (error) {
        if (active) setState({ loading: false, error: error.message, metrics: [], decisions: [], campaigns: [] });
      }
    })();
    return () => { active = false; };
  }, []);

  const derived = useMemo(() => {
    const dates = buildClosedDates();
    const dateSet = new Set(dates);
    const byDate = new Map(dates.map((date) => [date, {
      date,
      cliques: 0,
      impressoes: 0,
      alteracoes: 0,
      campanhasCriadas: 0,
      campanhasAlteradas: new Set(),
    }]));

    for (const metric of state.metrics) {
      if (!dateSet.has(metric.date)) continue;
      const row = byDate.get(metric.date);
      row.cliques += Number(metric.clicks || 0);
      row.impressoes += Number(metric.impressions || 0);
    }

    const createdCampaignIdsByDate = new Map();
    for (const campaign of state.campaigns) {
      if (!campaign.created_by_app) continue;
      const createdDate = dateOnly(campaign.created_at || campaign.created_date);
      if (!createdDate || !dateSet.has(createdDate)) continue;
      const row = byDate.get(createdDate);
      row.campanhasCriadas += 1;
      if (!createdCampaignIdsByDate.has(createdDate)) createdCampaignIdsByDate.set(createdDate, new Set());
      const campaignId = campaign.campaign_id || campaign.amazon_campaign_id || campaign.id;
      if (campaignId) createdCampaignIdsByDate.get(createdDate).add(String(campaignId));
    }

    for (const decision of state.decisions) {
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
        cliques: row.cliques,
        impressoes: row.impressoes,
        alteracoes: row.alteracoes,
        campanhasCriadas: row.campanhasCriadas,
        campanhasAlteradas: row.campanhasAlteradas.size,
      };
    });

    const totals = chartData.reduce((acc, row) => ({
      cliques: acc.cliques + row.cliques,
      impressoes: acc.impressoes + row.impressoes,
      alteracoes: acc.alteracoes + row.alteracoes,
      campanhasCriadas: acc.campanhasCriadas + row.campanhasCriadas,
      campanhasAlteradas: acc.campanhasAlteradas + row.campanhasAlteradas,
    }), { cliques: 0, impressoes: 0, alteracoes: 0, campanhasCriadas: 0, campanhasAlteradas: 0 });

    return { chartData, totals };
  }, [state.metrics, state.decisions, state.campaigns]);

  if (state.loading) {
    return <div className="h-56 flex items-center justify-center"><Loader2 className="w-5 h-5 text-cyan animate-spin" /></div>;
  }

  if (state.error) {
    return (
      <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-4 flex items-center gap-2 text-xs text-red-300">
        <AlertCircle className="w-4 h-4" />
        Não foi possível carregar os gráficos operacionais: {state.error}
      </div>
    );
  }

  const { chartData, totals } = derived;
  const tooltipStyle = { background: '#111318', border: '1px solid #252936', borderRadius: 8, fontSize: 11 };

  return (
    <div className="space-y-4" data-analytics-operational-charts="true">
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <ChartCard title="Cliques" description="Cliques por dia em colunas · últimos 30 dias fechados" summary={totals.cliques.toLocaleString('pt-BR')}>
          <ResponsiveContainer width="100%" height={210}>
            <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
              <XAxis dataKey="date" tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false} width={38} />
              <Tooltip contentStyle={tooltipStyle} />
              <Bar dataKey="cliques" name="Cliques" fill="#38BDF8" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Impressões" description="Impressões por dia em colunas · últimos 30 dias fechados" summary={totals.impressoes.toLocaleString('pt-BR')}>
          <ResponsiveContainer width="100%" height={210}>
            <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
              <XAxis dataKey="date" tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false} width={42} tickFormatter={(value) => value >= 1000 ? `${Math.round(value / 1000)}k` : value} />
              <Tooltip contentStyle={tooltipStyle} />
              <Bar dataKey="impressoes" name="Impressões" fill="#8B5CF6" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <ChartCard title="Desempenho da IA" description="Ações executadas e campanhas efetivamente criadas ou alteradas por dia" summary={`${totals.alteracoes.toLocaleString('pt-BR')} ações`}>
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="bg-surface-2 rounded-lg p-3"><p className="text-[10px] text-slate-500">Alterações executadas</p><p className="text-lg font-bold text-amber-400 mt-1">{totals.alteracoes.toLocaleString('pt-BR')}</p></div>
          <div className="bg-surface-2 rounded-lg p-3"><p className="text-[10px] text-slate-500">Campanhas criadas</p><p className="text-lg font-bold text-emerald-400 mt-1">{totals.campanhasCriadas.toLocaleString('pt-BR')}</p></div>
          <div className="bg-surface-2 rounded-lg p-3"><p className="text-[10px] text-slate-500">Campanhas alteradas</p><p className="text-lg font-bold text-cyan mt-1">{totals.campanhasAlteradas.toLocaleString('pt-BR')}</p></div>
        </div>
        <ResponsiveContainer width="100%" height={230}>
          <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
            <XAxis dataKey="date" tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false} width={38} />
            <Tooltip contentStyle={tooltipStyle} />
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
