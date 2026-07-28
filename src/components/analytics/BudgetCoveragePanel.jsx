/**
 * BudgetCoveragePanel — Painel de Cobertura de Budget Diário
 * Visão diária com drill-down por hora ao clicar num dia.
 */
import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  BarChart, Bar, AreaChart, Area, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts';
import {
  Clock, AlertTriangle, CheckCircle2, TrendingDown, TrendingUp,
  Loader2, RefreshCw, Zap, ChevronDown, ChevronUp, Activity,
} from 'lucide-react';

const r2 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;
const fmtBRL = (v) => `R$${r2(v).toFixed(2)}`;
const fmtHour = (h) => `${String(h).padStart(2, '0')}h`;

// Calcula data BRT atual
function todayBRT() {
  const now = new Date();
  const brt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  return brt;
}

function getHourBRT() {
  return Number(new Intl.DateTimeFormat('en', {
    timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false,
  }).format(new Date())) % 24;
}

// ── Tooltip customizado para barras diárias ──────────────────────────────────
const DailyTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  return (
    <div className="bg-[#111318] border border-surface-2 rounded-lg p-3 text-xs shadow-xl min-w-[180px]">
      <p className="text-slate-300 font-semibold mb-2">{label}</p>
      <div className="space-y-1">
        <div className="flex justify-between gap-4">
          <span className="text-slate-400">Spend confirmado</span>
          <span className="text-white font-bold">{fmtBRL(d?.spend)}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-slate-400">Budget cap</span>
          <span className="text-slate-300">{fmtBRL(d?.cap)}</span>
        </div>
        {d?.cpc_medio > 0 && (
          <div className="flex justify-between gap-4">
            <span className="text-slate-400">CPC médio</span>
            <span className="text-violet-400 font-semibold">{fmtBRL(d?.cpc_medio)}</span>
          </div>
        )}
        {d?.cap_hour !== null && d?.cap_hour !== undefined && (
          <div className="flex justify-between gap-4 mt-1 pt-1 border-t border-surface-3">
            <span className="text-amber-400">Budget esgotado às</span>
            <span className="text-amber-400 font-bold">{fmtHour(d?.cap_hour)}</span>
          </div>
        )}
        {d?.lasted && (
          <div className="flex justify-between gap-4 mt-1 pt-1 border-t border-surface-3">
            <span className="text-emerald-400">Budget durou o dia</span>
            <span className="text-emerald-400 font-bold">✓</span>
          </div>
        )}
      </div>
    </div>
  );
};

// ── Tooltip para drill-down horário ─────────────────────────────────────────
const HourlyTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  return (
    <div className="bg-[#111318] border border-surface-2 rounded-lg p-3 text-xs shadow-xl min-w-[200px]">
      <p className="text-slate-300 font-semibold mb-2">{label}</p>
      <div className="space-y-1">
        <div className="flex justify-between gap-4">
          <span className="text-slate-400">Spend acumulado</span>
          <span className="text-white font-bold">{fmtBRL(d?.cumulative_spend)}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-slate-400">Spend na hora</span>
          <span className="text-cyan">{fmtBRL(d?.hour_spend)}</span>
        </div>
        {d?.cpc > 0 && (
          <div className="flex justify-between gap-4">
            <span className="text-slate-400">CPC hora</span>
            <span className="text-violet-400">{fmtBRL(d?.cpc)}</span>
          </div>
        )}
        <div className="flex justify-between gap-4">
          <span className="text-slate-400">Esperado linear</span>
          <span className="text-slate-500">{fmtBRL(d?.expected_linear)}</span>
        </div>
        {d?.status && (
          <div className={`mt-1 pt-1 border-t border-surface-3 text-center font-semibold ${
            d.status === 'ativa' ? 'text-emerald-400' :
            d.status === 'dayparting' ? 'text-slate-400' :
            d.status === 'cap_atingido' ? 'text-red-400' : 'text-amber-400'
          }`}>
            {d.status === 'ativa' ? '● Ativa' :
             d.status === 'dayparting' ? '⏸ Dayparting' :
             d.status === 'cap_atingido' ? '🛑 Cap atingido' : '⏸ Pausada'}
          </div>
        )}
      </div>
    </div>
  );
};

// ── Card de status do dia atual ──────────────────────────────────────────────
function TodayStatusCard({ account, dailyCap, perfSettings }) {
  const [ctrl, setCtrl] = useState(null);
  const [calibrating, setCalibrating] = useState(false);
  const [calibResult, setCalibResult] = useState(null);
  const hourNow = getHourBRT();
  const today = todayBRT();

  useEffect(() => {
    if (!account?.id) return;
    base44.entities.AccountDailySpendController.filter(
      { amazon_account_id: account.id, spend_date: today }, null, 1
    ).then(r => setCtrl(r[0] || null)).catch(() => {});
  }, [account?.id, today]);

  const recalibrate = async () => {
    if (!account?.id || calibrating) return;
    setCalibrating(true);
    setCalibResult(null);
    try {
      const checkpoint = hourNow < 10 ? 'morning' : hourNow < 16 ? 'afternoon' : hourNow < 21 ? 'evening' : 'night';
      const res = await base44.functions.invoke('runIntraDayBudgetPacingCycle', {
        amazon_account_id: account.id, checkpoint,
      });
      const d = res?.data || res;
      setCalibResult({ ok: d?.ok, actions: d?.actionsCount || d?.actions_executed || 0, msg: d?.actionsTaken?.[0] || (d?.ok ? 'Pacing recalibrado' : 'Falha') });
    } catch (e) {
      setCalibResult({ ok: false, msg: e.message });
    } finally {
      setCalibrating(false);
    }
  };

  const spend = Number(ctrl?.confirmed_spend || 0);
  const cap = dailyCap || Number(ctrl?.effective_daily_spend_cap || ctrl?.user_daily_spend_cap || 0);
  const projected = Number(ctrl?.projected_end_of_day_spend || 0);
  const remaining = Math.max(0, cap - spend);
  const pct = cap > 0 ? Math.min(100, (spend / cap) * 100) : 0;
  const hoursUntilCap = Number(ctrl?.time_to_cap_hours || 0);
  const projectedCapHour = hoursUntilCap > 0 && hoursUntilCap < 24 ? hourNow + hoursUntilCap : null;
  const pacing = ctrl?.spend_pacing || 'unknown';
  const cpcOverride = Number(perfSettings?.cpc_intraday_override || 0);
  const targetCpc = Number(perfSettings?.target_cpc || 0);

  const statusColor = pct >= 95 ? 'red' : pct >= 75 ? 'amber' : 'green';
  const statusMap = { green: 'bg-emerald-500/10 border-emerald-500/25', amber: 'bg-amber-500/10 border-amber-500/25', red: 'bg-red-500/10 border-red-500/25' };
  const barColor = pct >= 95 ? 'bg-red-500' : pct >= 75 ? 'bg-amber-500' : 'bg-emerald-500';

  const nextCheckpoint = hourNow < 7 ? '07:00' : hourNow < 13 ? '13:00' : hourNow < 19 ? '19:00' : '22:00';

  return (
    <div className={`rounded-xl border p-4 ${statusMap[statusColor]}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Activity className={`w-4 h-4 ${pct >= 95 ? 'text-red-400' : pct >= 75 ? 'text-amber-400' : 'text-emerald-400'}`} />
          <span className="text-sm font-semibold text-white">Status Atual do Budget — {fmtHour(hourNow)} BRT</span>
        </div>
        <button
          onClick={recalibrate}
          disabled={calibrating}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-cyan/15 border border-cyan/30 text-cyan hover:bg-cyan/25 rounded-lg disabled:opacity-50 transition-colors"
        >
          {calibrating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
          Recalibrar Agora
        </button>
      </div>

      {calibResult && (
        <div className={`mb-3 px-3 py-2 rounded-lg text-xs font-medium ${calibResult.ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-400'}`}>
          {calibResult.ok ? `✓ ${calibResult.msg} · ${calibResult.actions} ações` : `✗ ${calibResult.msg}`}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <div>
          <p className="text-[10px] text-slate-500 mb-0.5">Gasto confirmado</p>
          <p className="text-lg font-bold text-white">{fmtBRL(spend)}</p>
          <p className="text-[10px] text-slate-500">de {fmtBRL(cap)}</p>
        </div>
        <div>
          <p className="text-[10px] text-slate-500 mb-0.5">Saldo restante</p>
          <p className={`text-lg font-bold ${remaining < cap * 0.15 ? 'text-red-400' : remaining < cap * 0.30 ? 'text-amber-400' : 'text-emerald-400'}`}>{fmtBRL(remaining)}</p>
        </div>
        <div>
          <p className="text-[10px] text-slate-500 mb-0.5">Projeção EOD</p>
          <p className={`text-lg font-bold ${projected > cap * 1.05 ? 'text-red-400' : projected > cap * 0.95 ? 'text-amber-400' : 'text-emerald-400'}`}>{fmtBRL(projected)}</p>
          {projectedCapHour !== null && (
            <p className="text-[10px] text-amber-400">⚠ Encerra ~{fmtHour(Math.min(23, Math.round(projectedCapHour)))}</p>
          )}
        </div>
        <div>
          <p className="text-[10px] text-slate-500 mb-0.5">CPC-alvo</p>
          {cpcOverride > 0 ? (
            <>
              <p className="text-lg font-bold text-violet-400">{fmtBRL(cpcOverride)}</p>
              <p className="text-[10px] text-violet-500">override intraday (base: {fmtBRL(targetCpc)})</p>
            </>
          ) : (
            <>
              <p className="text-lg font-bold text-violet-400">{targetCpc > 0 ? fmtBRL(targetCpc) : '—'}</p>
              <p className="text-[10px] text-slate-500">configurado em Settings</p>
            </>
          )}
        </div>
      </div>

      {/* Barra de progresso */}
      <div className="mb-3">
        <div className="flex justify-between text-[10px] text-slate-500 mb-1">
          <span>{pct.toFixed(0)}% utilizado</span>
          <span>Próximo checkpoint: {nextCheckpoint}</span>
        </div>
        <div className="h-2 bg-surface-3 rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="flex items-center gap-3 text-[11px]">
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-semibold ${
          pacing === 'overpacing' ? 'bg-red-500/15 text-red-400' :
          pacing === 'underpacing' ? 'bg-amber-500/15 text-amber-400' :
          pacing === 'on_track' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-surface-3 text-slate-500'
        }`}>
          {pacing === 'overpacing' ? <TrendingUp className="w-2.5 h-2.5" /> :
           pacing === 'underpacing' ? <TrendingDown className="w-2.5 h-2.5" /> :
           <CheckCircle2 className="w-2.5 h-2.5" />}
          {pacing === 'overpacing' ? 'Overpacing' : pacing === 'underpacing' ? 'Underpacing' : pacing === 'on_track' ? 'No ritmo' : 'Desconhecido'}
        </span>
        <span className="text-slate-500">Ratio: {r2(ctrl?.pacing_ratio || 0)}x</span>
        {ctrl?.global_kill_switch && <span className="text-red-400 font-bold">🛑 Kill Switch Ativo</span>}
      </div>
    </div>
  );
}

// ── Drill-down horário ───────────────────────────────────────────────────────
function HourlyDrillDown({ accountId, date, cap, onClose }) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!accountId || !date) return;
    setLoading(true);
    Promise.all([
      base44.entities.UnifiedAdsMetricsHourly.filter(
        { amazon_account_id: accountId, date }, null, 500
      ).catch(() => []),
      base44.entities.AdsBidChangeLog.filter(
        { amazon_account_id: accountId, date }, null, 500
      ).catch(() => []),
    ]).then(([hourly, bidLogs]) => {
      // Agregar por hora
      const byHour = {};
      for (let h = 0; h < 24; h++) {
        byHour[h] = { hour: h, hour_spend: 0, clicks: 0, impressions: 0 };
      }
      for (const m of hourly) {
        const h = Number(m.hour || 0);
        if (byHour[h]) {
          byHour[h].hour_spend += Number(m.cost || 0);
          byHour[h].clicks += Number(m.clicks || 0);
          byHour[h].impressions += Number(m.impressions || 0);
        }
      }

      // Detectar pausas por dayparting no bid log
      const daypartHours = new Set();
      const capHours = new Set();
      for (const log of bidLogs) {
        const action = String(log.action || log.classification || '').toLowerCase();
        const h = Number(log.created_at ? new Date(log.created_at).getHours() : -1);
        if (h < 0) continue;
        if (action.includes('daypart') || action.includes('piso') || action.includes('reduce')) daypartHours.add(h);
        if (action.includes('cap') || action.includes('cap_reached') || action.includes('kill')) capHours.add(h);
      }

      let cumulative = 0;
      const rows = Object.values(byHour).map((d) => {
        cumulative += d.hour_spend;
        const expected_linear = cap > 0 ? (cap / 24) * (d.hour + 1) : 0;
        const cpc = d.clicks > 0 ? d.hour_spend / d.clicks : 0;
        const status = capHours.has(d.hour) ? 'cap_atingido' :
          daypartHours.has(d.hour) ? 'dayparting' :
          d.hour_spend > 0 ? 'ativa' : 'sem_dados';
        return {
          name: fmtHour(d.hour),
          hour: d.hour,
          hour_spend: r2(d.hour_spend),
          cumulative_spend: r2(cumulative),
          expected_linear: r2(expected_linear),
          cpc: r2(cpc),
          status,
          isDaypart: daypartHours.has(d.hour),
          isCap: capHours.has(d.hour),
        };
      });
      setData(rows);
    }).finally(() => setLoading(false));
  }, [accountId, date, cap]);

  const maxSpend = data.reduce((m, d) => Math.max(m, d.cumulative_spend), 0);
  const capReachedHour = data.find(d => d.isCap)?.hour;
  const firstDaypartHour = data.find(d => d.isDaypart)?.hour;

  return (
    <div className="mt-4 bg-surface-2 border border-surface-3 rounded-xl p-5 animate-fade-in">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-white">Curva Horária — {date}</h3>
          <p className="text-[11px] text-slate-500 mt-0.5">
            {capReachedHour != null && <span className="text-red-400 mr-3">🛑 Cap às {fmtHour(capReachedHour)}</span>}
            {firstDaypartHour != null && <span className="text-slate-400">⏸ Dayparting detectado às {fmtHour(firstDaypartHour)}</span>}
          </p>
        </div>
        <button onClick={onClose} className="p-1.5 text-slate-500 hover:text-white transition-colors">
          <ChevronUp className="w-4 h-4" />
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="gCumulative" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#3B82F6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
              <XAxis dataKey="name" tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} interval={2} />
              <YAxis tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} />
              <Tooltip content={<HourlyTooltip />} />
              {/* Faixa de dayparting — cinza */}
              {data.filter(d => d.isDaypart).map(d => (
                <ReferenceLine key={d.hour} x={d.name} stroke="#94a3b8" strokeWidth={8} strokeOpacity={0.15} />
              ))}
              {/* Faixa de cap atingido — vermelho */}
              {data.filter(d => d.isCap).map(d => (
                <ReferenceLine key={d.hour} x={d.name} stroke="#EF4444" strokeWidth={8} strokeOpacity={0.20} />
              ))}
              {/* Linha de budget proporcional esperado */}
              <Line type="monotone" dataKey="expected_linear" name="Esperado" stroke="#475569" strokeDasharray="4 4" strokeWidth={1} dot={false} />
              {/* Gasto acumulado */}
              <Area type="monotone" dataKey="cumulative_spend" name="Gasto acumulado" stroke="#3B82F6" fill="url(#gCumulative)" strokeWidth={2} dot={false} />
              {cap > 0 && <ReferenceLine y={cap} stroke="#EF4444" strokeDasharray="6 3" strokeOpacity={0.6} label={{ value: 'Cap', fill: '#EF4444', fontSize: 9, position: 'right' }} />}
            </AreaChart>
          </ResponsiveContainer>

          {/* Legenda inline */}
          <div className="flex items-center gap-4 mt-3 text-[10px] text-slate-500 flex-wrap">
            <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-blue-400 inline-block" /> Gasto acumulado</span>
            <span className="flex items-center gap-1"><span className="w-3 h-0.5 border-t border-dashed border-slate-500 inline-block" /> Ritmo esperado</span>
            <span className="flex items-center gap-1"><span className="w-3 h-2 bg-slate-500/20 inline-block rounded" /> Dayparting</span>
            <span className="flex items-center gap-1"><span className="w-3 h-2 bg-red-500/20 inline-block rounded" /> Cap atingido</span>
            <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-red-500/60 border-t border-dashed border-red-500 inline-block" /> Budget cap</span>
          </div>

          {/* CPC horário */}
          <div className="mt-4">
            <p className="text-[10px] text-slate-500 mb-2 font-semibold uppercase tracking-wide">CPC por Hora</p>
            <ResponsiveContainer width="100%" height={100}>
              <BarChart data={data} margin={{ top: 2, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
                <XAxis dataKey="name" tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false} interval={2} />
                <YAxis tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false} width={30} />
                <Tooltip formatter={(v) => [fmtBRL(v), 'CPC']} contentStyle={{ background: '#111318', border: '1px solid #1A1D26', fontSize: 11 }} />
                <Bar dataKey="cpc" name="CPC" radius={[2, 2, 0, 0]}>
                  {data.map((d, i) => (
                    <Cell key={i} fill={d.isDaypart ? '#475569' : d.isCap ? '#EF4444' : '#8B5CF6'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}

// ── Painel Principal ─────────────────────────────────────────────────────────
export default function BudgetCoveragePanel({ account, dailyCap, perfSettings }) {
  const [dailyData, setDailyData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState(14);
  const [selectedDate, setSelectedDate] = useState(null);
  const today = todayBRT();

  const load = useCallback(async () => {
    if (!account?.id) return;
    setLoading(true);
    try {
      const cutoff = new Date(Date.now() - period * 86400000).toISOString().slice(0, 10);

      const [controllers, bidLogs, hourlyMetrics] = await Promise.all([
        base44.entities.AccountDailySpendController.filter(
          { amazon_account_id: account.id }, '-spend_date', period + 2
        ).catch(() => []),
        base44.entities.AdsBidChangeLog.filter(
          { amazon_account_id: account.id }, '-created_at', 500
        ).catch(() => []),
        base44.entities.UnifiedAdsMetricsHourly.filter(
          { amazon_account_id: account.id }, '-date', 2000
        ).catch(() => []),
      ]);

      // Agregar spend por data a partir de métricas horárias
      const spendByDate = {};
      const clicksByDate = {};
      for (const m of hourlyMetrics) {
        const d = m.date;
        if (!d || d < cutoff) continue;
        spendByDate[d] = (spendByDate[d] || 0) + Number(m.cost || 0);
        clicksByDate[d] = (clicksByDate[d] || 0) + Number(m.clicks || 0);
      }

      // Detectar hora de cap por data a partir de bid logs
      const capHourByDate = {};
      const daypartStartByDate = {};
      for (const log of bidLogs) {
        if (!log.created_at) continue;
        const logDate = log.created_at.slice(0, 10);
        if (logDate < cutoff) continue;
        const logHour = new Date(log.created_at).getHours();
        const action = String(log.action || log.classification || '').toLowerCase();
        if ((action.includes('cap') || action.includes('kill')) && !capHourByDate[logDate]) {
          capHourByDate[logDate] = logHour;
        }
        if ((action.includes('daypart') || action.includes('piso')) && !daypartStartByDate[logDate]) {
          daypartStartByDate[logDate] = logHour;
        }
      }

      // Montar linhas diárias
      const rows = controllers
        .filter(c => c.spend_date && c.spend_date >= cutoff && c.spend_date < today)
        .map(c => {
          const d = c.spend_date;
          const [, mm, dd] = d.split('-');
          const spend = spendByDate[d] || Number(c.confirmed_spend || 0);
          const cap = Number(c.effective_daily_spend_cap || c.user_daily_spend_cap || dailyCap || 0);
          const clicks = clicksByDate[d] || 0;
          const cpc_medio = clicks > 0 ? spend / clicks : 0;
          const capHour = capHourByDate[d] ?? null;
          const daypartStart = daypartStartByDate[d] ?? null;
          const lasted = capHour === null && spend >= cap * 0.80;
          // Classificação de cor: verde se durou, âmbar se cap tardio, vermelho se cap cedo
          const fillColor = lasted ? '#10B981' : (capHour !== null && capHour < 20) ? '#EF4444' : '#F59E0B';
          return { name: `${dd}/${mm}`, date: d, spend: r2(spend), cap: r2(cap), cpc_medio: r2(cpc_medio), capHour, daypartStart, lasted, fillColor };
        })
        .sort((a, b) => a.date.localeCompare(b.date));

      setDailyData(rows);
    } finally {
      setLoading(false);
    }
  }, [account?.id, period, dailyCap, today]);

  useEffect(() => { load(); }, [load]);

  const cap = dailyCap || (dailyData[0]?.cap || 0);

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-5 space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <Clock className="w-4 h-4 text-cyan" />
            Cobertura de Budget Diário
          </h2>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Quando o budget iniciou, quando terminou e por qual motivo (dayparting vs esgotamento).
            Clique num dia para ver a curva horária.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex bg-surface-2 border border-surface-3 rounded-lg p-0.5 gap-0.5">
            {[7, 14, 30].map(d => (
              <button key={d} onClick={() => setPeriod(d)}
                className={`px-3 py-1 rounded text-xs font-semibold transition-all ${period === d ? 'bg-cyan text-white' : 'text-slate-400 hover:text-slate-200'}`}>
                {d}d
              </button>
            ))}
          </div>
          <button onClick={load} disabled={loading} className="p-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg disabled:opacity-50 transition-colors">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Card de status hoje */}
      <TodayStatusCard account={account} dailyCap={dailyCap} perfSettings={perfSettings} />

      {/* Legenda de cores */}
      <div className="flex items-center gap-4 text-[11px] text-slate-500 flex-wrap">
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-emerald-500/70 inline-block" />Budget durou o dia</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-amber-500/70 inline-block" />Esgotado após 20h</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-red-500/70 inline-block" />Esgotado antes das 20h</span>
        <span className="flex items-center gap-1.5 ml-auto text-violet-400"><span className="w-4 h-0.5 bg-violet-400 inline-block" />CPC médio diário</span>
      </div>

      {/* Gráfico diário principal */}
      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
      ) : dailyData.length === 0 ? (
        <div className="text-center py-12 text-slate-500 text-sm">
          Sem dados de AccountDailySpendController para o período.
        </div>
      ) : (
        <>
          <div>
            <p className="text-[10px] text-slate-500 mb-3">Clique em qualquer barra para ver a curva horária do dia</p>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={dailyData} onClick={(e) => {
                const date = e?.activePayload?.[0]?.payload?.date;
                setSelectedDate(prev => prev === date ? null : date);
              }} style={{ cursor: 'pointer' }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <Tooltip content={<DailyTooltip />} />
                {cap > 0 && (
                  <ReferenceLine y={cap} stroke="#EF4444" strokeDasharray="6 3" strokeOpacity={0.5}
                    label={{ value: `Cap R$${cap}`, fill: '#EF4444', fontSize: 9, position: 'insideRight' }} />
                )}
                <Bar dataKey="spend" name="Spend" radius={[3, 3, 0, 0]}>
                  {dailyData.map((d, i) => (
                    <Cell
                      key={i}
                      fill={d.date === selectedDate ? '#60A5FA' : d.fillColor}
                      opacity={selectedDate && d.date !== selectedDate ? 0.4 : 0.85}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Linha de CPC médio diário */}
          <div>
            <p className="text-[10px] text-slate-500 mb-2 font-semibold uppercase tracking-wide">CPC Médio Diário</p>
            <ResponsiveContainer width="100%" height={90}>
              <LineChart data={dailyData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
                <XAxis dataKey="name" tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} width={40} />
                <Tooltip formatter={(v) => [fmtBRL(v), 'CPC médio']} contentStyle={{ background: '#111318', border: '1px solid #1A1D26', fontSize: 11 }} />
                <Line type="monotone" dataKey="cpc_medio" name="CPC médio" stroke="#8B5CF6" strokeWidth={2} dot={{ fill: '#8B5CF6', r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Tabela resumo */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-surface-2">
                  {['Data', 'Spend', 'Cap', 'Utilização', 'CPC Médio', 'Status Budget', 'Dayparting'].map(h => (
                    <th key={h} className="px-3 py-2 text-left font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...dailyData].reverse().map((d, i) => {
                  const util = d.cap > 0 ? d.spend / d.cap * 100 : 0;
                  return (
                    <tr key={i}
                      onClick={() => setSelectedDate(prev => prev === d.date ? null : d.date)}
                      className={`border-b border-surface-2/30 hover:bg-surface-2 transition-colors cursor-pointer ${d.date === selectedDate ? 'bg-cyan/5 border-l-2 border-l-cyan' : ''}`}>
                      <td className="px-3 py-2 font-semibold text-slate-200">{d.name}</td>
                      <td className="px-3 py-2 text-white font-mono">{fmtBRL(d.spend)}</td>
                      <td className="px-3 py-2 text-slate-400 font-mono">{fmtBRL(d.cap)}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <div className="w-16 h-1.5 bg-surface-3 rounded-full overflow-hidden">
                            <div className="h-full rounded-full" style={{ width: `${Math.min(100, util)}%`, background: d.fillColor }} />
                          </div>
                          <span className={`font-semibold ${util >= 95 ? 'text-red-400' : util >= 75 ? 'text-amber-400' : 'text-emerald-400'}`}>{util.toFixed(0)}%</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-violet-400 font-mono">{d.cpc_medio > 0 ? fmtBRL(d.cpc_medio) : '—'}</td>
                      <td className="px-3 py-2">
                        {d.lasted ? (
                          <span className="text-emerald-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />Durou o dia</span>
                        ) : d.capHour !== null ? (
                          <span className="text-amber-400 flex items-center gap-1">
                            <AlertTriangle className="w-3 h-3" />
                            Esgotou às {fmtHour(d.capHour)}
                          </span>
                        ) : (
                          <span className="text-slate-500">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {d.daypartStart !== null ? (
                          <span className="text-slate-400">Ativo às {fmtHour(d.daypartStart)}</span>
                        ) : <span className="text-slate-600">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Drill-down horário */}
          {selectedDate && (
            <HourlyDrillDown
              accountId={account.id}
              date={selectedDate}
              cap={dailyData.find(d => d.date === selectedDate)?.cap || cap}
              onClose={() => setSelectedDate(null)}
            />
          )}
        </>
      )}
    </div>
  );
}