import React, { useState } from 'react';
import { Target, TrendingUp, TrendingDown, AlertTriangle, CheckCircle, Zap, Loader2 } from 'lucide-react';
import { RadialBarChart, RadialBar, ResponsiveContainer } from 'recharts';
import { base44 } from '@/api/base44Client';

function MetricGauge({ label, real, target, unit = '%', lowerIsBetter = false, targetLabel }) {
  const hasData = real > 0 && target > 0;
  const pct = hasData ? Math.min((real / target) * 100, 200) : 0;

  // Para ACoS/TACoS: real < target = bom. Para ROAS: real > target = bom.
  const isGood = hasData
    ? lowerIsBetter ? real <= target : real >= target
    : null;

  const isWarning = hasData
    ? lowerIsBetter ? real > target * 1.1 && real <= target * 1.3 : real >= target * 0.8 && real < target
    : null;

  const isBad = hasData
    ? lowerIsBetter ? real > target * 1.3 : real < target * 0.8
    : null;

  const color = !hasData ? '#334155' : isGood ? '#10B981' : isWarning ? '#F59E0B' : '#EF4444';
  const bgColor = !hasData ? 'border-surface-3' : isGood ? 'border-emerald-500/30' : isWarning ? 'border-amber-500/30' : 'border-red-500/30';
  const bgFill = !hasData ? '' : isGood ? 'bg-emerald-500/5' : isWarning ? 'bg-amber-500/5' : 'bg-red-500/5';

  const StatusIcon = !hasData ? null : isGood ? CheckCircle : isWarning ? AlertTriangle : TrendingUp;
  const statusColor = !hasData ? '' : isGood ? 'text-emerald-400' : isWarning ? 'text-amber-400' : 'text-red-400';
  const statusText = !hasData ? 'Sem dados' : isGood ? 'Na meta' : isWarning ? 'Atenção' : 'Fora da meta';

  // Gauge data: fill até 100% do target
  const fillPct = hasData ? Math.min(pct, 100) : 0;
  const gaugeData = [{ value: fillPct, fill: color }];

  return (
    <div className={`rounded-xl border p-4 ${bgColor} ${bgFill}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-slate-300">{label}</span>
        {StatusIcon && (
          <span className={`flex items-center gap-1 text-[10px] font-semibold ${statusColor}`}>
            <StatusIcon className="w-3 h-3" />
            {statusText}
          </span>
        )}
        {!hasData && <span className="text-[10px] text-slate-600">Sem dados</span>}
      </div>

      <div className="flex items-center gap-3">
        {/* Mini gauge */}
        <div className="w-16 h-16 flex-shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <RadialBarChart
              cx="50%" cy="50%"
              innerRadius="60%" outerRadius="90%"
              startAngle={225} endAngle={-45}
              data={gaugeData}
            >
              <RadialBar dataKey="value" cornerRadius={4} background={{ fill: '#1A1D26' }} />
            </RadialBarChart>
          </ResponsiveContainer>
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-xl font-bold" style={{ color }}>
            {hasData ? `${real.toFixed(1)}${unit}` : '—'}
          </p>
          <p className="text-[10px] text-slate-500 mt-0.5">
            Meta: <span className="text-slate-300 font-semibold">{target > 0 ? `${target}${unit}` : '—'}</span>
          </p>
          {hasData && (
            <p className="text-[10px] mt-0.5" style={{ color }}>
              {lowerIsBetter
                ? real <= target
                  ? `${((target - real) / target * 100).toFixed(0)}% abaixo da meta ✓`
                  : `${((real - target) / target * 100).toFixed(0)}% acima da meta`
                : real >= target
                  ? `${((real - target) / target * 100).toFixed(0)}% acima da meta ✓`
                  : `${((target - real) / target * 100).toFixed(0)}% abaixo da meta`
              }
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function GoalsComparisonPanel({ acos, roas, tacos = 0, autopilotConfig, loading, amazonAccountId }) {
  const [fixing, setFixing] = useState(false);
  const [fixResult, setFixResult] = useState(null);

  async function handleFixNow() {
    setFixing(true);
    setFixResult(null);
    try {
      const res = await base44.functions.invoke('runDailyAdsOptimization', {
        amazon_account_id: amazonAccountId,
        trigger: 'manual_goals_correction',
      });
      const d = res?.data || {};
      if (d.ok === false && !d.rate_limited) {
        setFixResult({ ok: false, msg: d.message || d.error || 'Erro ao executar ajuste.' });
      } else {
        setFixResult({
          ok: true,
          msg: d.rate_limited
            ? 'Rate limit atingido. Tente novamente em 1-2 min.'
            : `Ajuste concluído: ${d.decisions_created || 0} decisões geradas, ${d.decisions_executed || 0} aplicadas automaticamente.`,
        });
      }
    } catch (e) {
      setFixResult({ ok: false, msg: e.message || 'Erro inesperado.' });
    } finally {
      setFixing(false);
    }
  }
  if (loading) {
    return (
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-5 animate-pulse">
        <div className="h-4 w-40 bg-surface-3 rounded mb-4" />
        <div className="grid grid-cols-3 gap-4">
          {[1, 2, 3].map(i => <div key={i} className="h-28 bg-surface-2 rounded-xl" />)}
        </div>
      </div>
    );
  }

  const targetAcos = autopilotConfig?.target_acos || 0;
  const maximumAcos = autopilotConfig?.maximum_acos || 0;
  const targetRoas = autopilotConfig?.target_roas || 0;
  const targetTacos = autopilotConfig?.target_tacos || 0;

  const hasGoals = targetAcos > 0 || targetRoas > 0 || targetTacos > 0;

  if (!hasGoals) {
    return (
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-2">
          <Target className="w-4 h-4 text-slate-500" />
          <h2 className="text-sm font-semibold text-slate-400">Metas vs Realidade</h2>
        </div>
        <p className="text-xs text-slate-500">
          Nenhuma meta configurada. <a href="/settings" className="text-cyan hover:underline">Defina suas metas em Configurações →</a>
        </p>
      </div>
    );
  }

  // Status geral
  const acosOk = targetAcos > 0 ? acos <= targetAcos : true;
  const roasOk = targetRoas > 0 ? roas >= targetRoas : true;
  const tacosOk = targetTacos > 0 ? tacos <= targetTacos : true;
  const allOk = acosOk && roasOk && tacosOk;
  const anyBad = !acosOk || !roasOk || !tacosOk;

  return (
    <div className={`bg-surface-1 rounded-xl p-5 border ${anyBad ? 'border-red-500/25' : 'border-emerald-500/25'}`}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Target className={`w-4 h-4 ${anyBad ? 'text-red-400' : 'text-emerald-400'}`} />
          <h2 className="text-sm font-semibold text-slate-300">Metas vs Realidade — 30 dias</h2>
        </div>
        <span className={`flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full border ${
          allOk
            ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400'
            : 'bg-red-500/10 border-red-500/25 text-red-400'
        }`}>
          {allOk ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
          {allOk ? 'Todas as metas atingidas' : 'Fora de alguma meta'}
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <MetricGauge
          label="ACoS"
          real={acos}
          target={targetAcos}
          unit="%"
          lowerIsBetter={true}
        />
        <MetricGauge
          label="ROAS"
          real={roas}
          target={targetRoas}
          unit="x"
          lowerIsBetter={false}
        />
        <MetricGauge
          label="TACoS"
          real={tacos}
          target={targetTacos}
          unit="%"
          lowerIsBetter={true}
        />
      </div>

      {anyBad && (
        <div className="mt-4 flex flex-col gap-2">
          <button
            onClick={handleFixNow}
            disabled={fixing}
            className="flex items-center justify-center gap-2 w-full sm:w-auto sm:self-start px-4 py-2.5 bg-red-500/15 hover:bg-red-500/25 border border-red-500/30 text-red-300 hover:text-red-200 text-sm font-semibold rounded-lg transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {fixing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            {fixing ? 'Executando ajuste automático...' : 'Corrigir Agora — Ajuste Automático de Bids'}
          </button>
          {fixResult && (
            <div className={`flex items-start gap-2 p-3 rounded-lg text-xs border ${fixResult.ok ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300' : 'bg-red-500/10 border-red-500/25 text-red-300'}`}>
              {fixResult.ok ? <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" /> : <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />}
              <span>{fixResult.msg}</span>
            </div>
          )}
        </div>
      )}

      {maximumAcos > 0 && acos > maximumAcos && (
        <div className="mt-3 flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/25 rounded-lg text-xs text-red-300">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span><strong>ACoS crítico:</strong> {acos.toFixed(1)}% está acima do ACoS máximo permitido de {maximumAcos}%. Revisão urgente recomendada.</span>
        </div>
      )}
    </div>
  );
}