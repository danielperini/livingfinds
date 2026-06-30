import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Clock, TrendingUp, TrendingDown, DollarSign, Activity, Loader2, Search, Filter, Calendar, Play, RotateCcw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

// Cores do mapa de calor
function getHeatColor(value, type = 'roas') {
  if (!value || value === 0) return 'bg-slate-800/50';
  
  if (type === 'roas') {
    if (value >= 5) return 'bg-emerald-500';
    if (value >= 4) return 'bg-emerald-400';
    if (value >= 3) return 'bg-green-400';
    if (value >= 2) return 'bg-yellow-400';
    if (value >= 1) return 'bg-orange-400';
    return 'bg-red-500';
  }
  
  if (type === 'spend') {
    if (value >= 10) return 'bg-red-500';
    if (value >= 5) return 'bg-orange-400';
    if (value >= 2) return 'bg-yellow-400';
    if (value >= 1) return 'bg-green-400';
    return 'bg-slate-700';
  }
  
  return 'bg-slate-700';
}

const classificationConfig = {
  peak_high_profit: { label: 'Pico Alta Rentabilidade', color: 'bg-emerald-500', text: 'text-emerald-400' },
  peak_conversion: { label: 'Pico Conversão', color: 'bg-green-500', text: 'text-green-400' },
  peak_traffic: { label: 'Pico Tráfego', color: 'bg-cyan-500', text: 'text-cyan-400' },
  efficient: { label: 'Eficiente', color: 'bg-blue-500', text: 'text-blue-400' },
  neutral: { label: 'Neutro', color: 'bg-slate-500', text: 'text-slate-400' },
  discovery: { label: 'Descoberta', color: 'bg-indigo-500', text: 'text-indigo-400' },
  low_efficiency: { label: 'Baixa Eficiência', color: 'bg-amber-500', text: 'text-amber-400' },
  deficit: { label: 'Deficitário', color: 'bg-red-500', text: 'text-red-400' },
  insufficient_data: { label: 'Dados Insuficientes', color: 'bg-slate-700', text: 'text-slate-600' },
};

export default function DaypartingDashboard() {
  const [account, setAccount] = useState(null);
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [data, setData] = useState(null);
  const [metricType, setMetricType] = useState('roas'); // roas, spend, sales, clicks
  const [days, setDays] = useState(30);

  useEffect(() => {
    loadAccount();
  }, []);

  const loadAccount = async () => {
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      setAccount(accounts[0] || null);
    } catch (error) {
      console.error('Erro ao carregar conta:', error);
    }
  };

  const runAnalysis = async () => {
    if (!account) return;
    
    setAnalyzing(true);
    try {
      const res = await base44.functions.invoke('analyzeDayparting', {
        amazon_account_id: account.id,
        days,
      });
      
      if (res.data?.ok) {
        setData(res.data);
      }
    } catch (error) {
      console.error('Erro na análise:', error);
    } finally {
      setAnalyzing(false);
    }
  };

  const runOptimization = async () => {
    if (!account) return;
    
    setLoading(true);
    try {
      const res = await base44.functions.invoke('runAiOptimization', {
        amazon_account_id: account.id,
        mode: 'assisted',
      });
      
      if (res.data?.ok) {
        alert(`Otimização concluída! ${res.data.summary.decisions_generated} decisões geradas.`);
      }
    } catch (error) {
      console.error('Erro na otimização:', error);
      alert('Erro: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  const daysOfWeek = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

  if (!account) {
    return (
      <div className="p-6 flex flex-col items-center justify-center min-h-[400px] gap-3">
        <Clock className="w-12 h-12 text-slate-600" />
        <p className="text-sm text-slate-400">Nenhuma conta Amazon configurada.</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
            <Clock className="w-5 h-5 text-cyan" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Dayparting Inteligente</h1>
            <p className="text-xs text-slate-400">Otimização por horário e dia da semana</p>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          <select
            value={days}
            onChange={e => setDays(Number(e.target.value))}
            className="text-xs bg-surface-2 border border-surface-3 text-slate-300 rounded-lg px-3 py-2 focus:outline-none"
          >
            <option value={7}>7 dias</option>
            <option value={14}>14 dias</option>
            <option value={30}>30 dias</option>
            <option value={60}>60 dias</option>
          </select>
          
          <Button onClick={runAnalysis} disabled={analyzing} size="sm">
            {analyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Activity className="w-4 h-4" />}
            {analyzing ? 'Analisando...' : 'Analisar Horários'}
          </Button>
          
          <Button onClick={runOptimization} disabled={loading} variant="outline" size="sm">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {loading ? 'Otimizando...' : 'Otimizar Agora'}
          </Button>
        </div>
      </div>

      {/* KPIs */}
      {data && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <Card className="bg-surface-1 border-surface-2">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-slate-500">Período Analisado</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-lg font-bold text-white">{data.analysis_period_days} dias</p>
            </CardContent>
          </Card>
          
          <Card className="bg-surface-1 border-surface-2">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-slate-500">Pontos de Dados</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-lg font-bold text-white">{data.total_data_points?.toLocaleString() || 0}</p>
            </CardContent>
          </Card>
          
          <Card className="bg-emerald-500/5 border-emerald-500/20">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-emerald-400">Melhores Horários</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-lg font-bold text-emerald-400">{data.best_hours?.length || 0}</p>
            </CardContent>
          </Card>
          
          <Card className="bg-red-500/5 border-red-500/20">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-red-400">Piores Horários</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-lg font-bold text-red-400">{data.worst_hours?.length || 0}</p>
            </CardContent>
          </Card>
          
          <Card className="bg-cyan/5 border-cyan/20">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-cyan">Recomendações</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-lg font-bold text-cyan">{data.recommendations?.length || 0}</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Mapa de Calor */}
      {data && data.classifications && (
        <Card className="bg-surface-1 border-surface-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-sm font-semibold text-white">Mapa de Calor por Horário</CardTitle>
                <CardDescription className="text-xs text-slate-500">
                  {metricType === 'roas' ? 'ROAS por hora e dia da semana' :
                   metricType === 'spend' ? 'Gasto (USD) por hora e dia da semana' :
                   metricType === 'sales' ? 'Vendas (USD) por hora e dia da semana' :
                   'Cliques por hora e dia da semana'}
                </CardDescription>
              </div>
              
              <div className="flex items-center gap-1">
                <Button
                  variant={metricType === 'roas' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setMetricType('roas')}
                >
                  ROAS
                </Button>
                <Button
                  variant={metricType === 'spend' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setMetricType('spend')}
                >
                  Gasto
                </Button>
                <Button
                  variant={metricType === 'sales' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setMetricType('sales')}
                >
                  Vendas
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <div className="min-w-[1600px]">
                {/* Header horas */}
                <div className="flex mb-2">
                  <div className="w-16 flex-shrink-0" />
                  {Array.from({ length: 24 }, (_, i) => (
                    <div key={i} className="w-[64px] text-center text-[10px] text-slate-500">
                      {i}:00
                    </div>
                  ))}
                </div>
                
                {/* Linhas por dia */}
                {daysOfWeek.map((dayName, dayIndex) => (
                  <div key={dayIndex} className="flex items-center mb-1">
                    <div className="w-16 flex-shrink-0 text-xs font-semibold text-slate-400">
                      {dayName}
                    </div>
                    {Array.from({ length: 24 }, (_, hour) => {
                      const cellData = data.classifications.find(c => c.day === dayIndex && c.hour === hour);
                      const value = cellData?.metrics?.[metricType] || 0;
                      const colorClass = getHeatColor(value, metricType);
                      
                      return (
                        <div
                          key={hour}
                          className={`${colorClass} w-[64px] h-8 mx-px rounded cursor-pointer hover:opacity-80 transition-opacity flex items-center justify-center`}
                          title={`${dayName}, ${hour}:00 — ${metricType === 'roas' ? `ROAS ${value?.toFixed(2)}` :
                            metricType === 'spend' || metricType === 'sales' ? `$${value?.toFixed(2)}` :
                            `${value?.toLocaleString()} cliques`}`}
                        >
                          <p className="text-[9px] font-semibold text-white drop-shadow">
                            {metricType === 'roas' && value > 0 ? value.toFixed(1) :
                             metricType === 'spend' || metricType === 'sales' ? value?.toFixed(0) :
                             value?.toLocaleString() || '0'}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Classificações */}
      {data && data.classifications && (
        <Card className="bg-surface-1 border-surface-2">
          <CardHeader>
            <CardTitle className="text-sm font-semibold text-white">Classificação de Horários</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
              {Object.entries(classificationConfig).map(([key, config]) => {
                const count = data.classifications.filter(c => c.classification === key).length;
                return (
                  <div key={key} className={`p-3 rounded-lg border ${config.color}/10 ${config.color.replace('bg-', 'border-')}/20`}>
                    <div className="flex items-center gap-2 mb-1">
                      <div className={`w-2 h-2 rounded-full ${config.color}`} />
                      <p className={`text-xs font-semibold ${config.text}`}>{config.label}</p>
                    </div>
                    <p className="text-lg font-bold text-white">{count}</p>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recomendações */}
      {data && data.recommendations && data.recommendations.length > 0 && (
        <Card className="bg-surface-1 border-surface-2">
          <CardHeader>
            <CardTitle className="text-sm font-semibold text-white flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-cyan" />
              Recomendações da IA
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.recommendations.map((rec, i) => (
              <div
                key={i}
                className={`p-3 rounded-lg border ${
                  rec.type === 'oportunidade' ? 'bg-emerald-500/5 border-emerald-500/20' :
                  rec.type === 'atencao' ? 'bg-amber-500/5 border-amber-500/20' :
                  'bg-slate-500/5 border-slate-500/20'
                }`}
              >
                <p className={`text-xs font-semibold mb-1 ${
                  rec.type === 'oportunidade' ? 'text-emerald-400' :
                  rec.type === 'atencao' ? 'text-amber-400' :
                  'text-slate-400'
                }`}>
                  {rec.title}
                </p>
                <p className="text-xs text-slate-300 mb-1">{rec.action}</p>
                {rec.details && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {rec.details.slice(0, 5).map((d, j) => (
                      <span key={j} className="text-[10px] px-2 py-0.5 rounded bg-surface-2 border border-surface-3 text-slate-400">
                        {d}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {!data && !analyzing && (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
          <Clock className="w-12 h-12 text-slate-600" />
          <p className="text-sm text-slate-400">
            Clique em "Analisar Horários" para gerar o mapa de calor e recomendações.
          </p>
        </div>
      )}
    </div>
  );
}