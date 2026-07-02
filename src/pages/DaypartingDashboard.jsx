import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Clock, TrendingUp, TrendingDown, DollarSign, Activity, Loader2, Search, Filter, Calendar, Play, RotateCcw, CheckCircle, XCircle, AlertTriangle, ChevronRight, BarChart2, Zap } from 'lucide-react';
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
  const [executing, setExecuting] = useState(false);
  const [autoApplying, setAutoApplying] = useState(false);
  const [autoApplyMsg, setAutoApplyMsg] = useState(null);
  const [opportunities, setOpportunities] = useState([]);
  const [skipped, setSkipped] = useState([]);
  const [selectedOpp, setSelectedOpp] = useState(null);
  const [executionMode, setExecutionMode] = useState('hybrid'); // native, programmatic, hybrid
  const [metricType, setMetricType] = useState('roas');
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
      const res = await base44.functions.invoke('analyzeDaypartingOpportunities', {
        amazon_account_id: account.id,
      });
      
      if (res.data?.ok) {
        setOpportunities(res.data.opportunities || []);
        setSkipped(res.data.skipped || []);
      }
    } catch (error) {
      console.error('Erro na análise:', error);
    } finally {
      setAnalyzing(false);
    }
  };

  const executeDayparting = async (opp, approve = true) => {
    if (!account) return;
    setExecuting(true);
    try {
      const res = await base44.functions.invoke('applyDaypartingSchedule', {
        opportunity_id: opp.id,
        mode: executionMode,
        approve,
      });
      if (res.data?.ok) {
        setOpportunities(prev => prev.filter(o => o.id !== opp.id));
        setSelectedOpp(null);
      } else {
        alert('Erro: ' + (res.data?.error || 'Falha na execução'));
      }
    } catch (error) {
      alert('Erro: ' + error.message);
    } finally {
      setExecuting(false);
    }
  };

  // Aplicar automaticamente todas as campanhas com confidence >= 90%
  const applyAllAuto = async () => {
    const autoOpps = opportunities.filter(o => o.auto_apply && (o.confidence_score || 0) >= 90);
    if (!autoOpps.length) return;
    setAutoApplying(true);
    setAutoApplyMsg(null);
    let applied = 0, errors = 0;
    for (const opp of autoOpps) {
      try {
        const res = await base44.functions.invoke('applyDaypartingSchedule', {
          opportunity_id: opp.id,
          mode: executionMode,
          auto_apply: true,
        });
        if (res.data?.ok) {
          applied++;
          setOpportunities(prev => prev.filter(o => o.id !== opp.id));
        } else {
          errors++;
        }
      } catch {
        errors++;
      }
    }
    setAutoApplying(false);
    setAutoApplyMsg(`✓ ${applied} campanhas configuradas automaticamente${errors > 0 ? ` · ${errors} erros` : ''}`);
    setTimeout(() => setAutoApplyMsg(null), 10000);
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
          
          <button onClick={async () => {
              if (!account) return;
              try {
                const res = await base44.functions.invoke('analyzeCampaignStrategy', { amazon_account_id: account.id });
                alert(`Análise concluída: ${res.data?.analyzed || 0} campanhas analisadas.`);
              } catch(e) { alert('Erro: ' + e.message); }
            }}
            className="text-xs px-3 py-2 bg-purple-400/10 border border-purple-400/20 text-purple-400 hover:bg-purple-400/20 rounded-lg transition-colors">
            🤖 Motor SP
          </button>
          <Button onClick={runAnalysis} disabled={analyzing} size="sm">
            {analyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Activity className="w-4 h-4" />}
            {analyzing ? 'Analisando...' : 'Analisar Horários'}
          </Button>
          {opportunities.filter(o => o.auto_apply).length > 0 && (
            <button onClick={applyAllAuto} disabled={autoApplying}
              className="flex items-center gap-2 px-3 py-2 bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25 text-sm font-semibold rounded-lg disabled:opacity-50 transition-colors">
              {autoApplying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
              {autoApplying ? 'Aplicando...' : `Aplicar Automáticos (${opportunities.filter(o => o.auto_apply).length})`}
            </button>
          )}
        </div>
      </div>

      {autoApplyMsg && (
        <div className={`p-3 rounded-xl border text-sm font-medium ${autoApplyMsg.startsWith('✓') ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300' : 'bg-red-400/10 border-red-400/20 text-red-400'}`}>
          {autoApplyMsg}
        </div>
      )}

      {/* KPIs */}
      {opportunities.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Card className="bg-emerald-500/5 border-emerald-500/20">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-emerald-400">Campanhas Elegíveis</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-lg font-bold text-emerald-400">{opportunities.length}</p>
            </CardContent>
          </Card>
          
          <Card className="bg-cyan/5 border-cyan/20">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-cyan">Economia Estimada/dia</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-lg font-bold text-cyan">
                ${opportunities.reduce((sum, o) => sum + (o.estimated_daily_savings || 0), 0).toFixed(2)}
              </p>
            </CardContent>
          </Card>
          
          <Card className="bg-amber-500/5 border-amber-500/20">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-amber-400">Melhoria ROAS</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-lg font-bold text-amber-400">
                +{opportunities.reduce((sum, o) => sum + (o.estimated_roas_improvement_pct || 0), 0) / opportunities.length.toFixed(1)}%
              </p>
            </CardContent>
          </Card>
          
          <Card className="bg-surface-1 border-surface-2">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-slate-500">Campanhas Inelegíveis</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-lg font-bold text-white">{skipped.length}</p>
            </CardContent>
          </Card>
        </div>
      )}



      {/* Lista de Oportunidades */}
      {opportunities.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-bold text-white flex items-center gap-2">
            <BarChart2 className="w-4 h-4 text-cyan" />
            Campanhas Elegíveis para Dayparting ({opportunities.length})
          </h2>
          
          {opportunities.map(opp => (
            <Card key={opp.id} className="bg-surface-1 border-surface-2">
              <CardContent className="p-4">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <p className="text-sm font-bold text-white truncate">{opp.campaign_name}</p>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 font-semibold">
                        {opp.days_running} dias
                      </span>
                      <span className={`text-xs px-2 py-0.5 rounded-full border font-semibold ${
                        (opp.confidence_score || 0) >= 90
                          ? 'bg-cyan/15 border-cyan/30 text-cyan'
                          : (opp.confidence_score || 0) >= 70
                          ? 'bg-amber-400/10 border-amber-400/20 text-amber-400'
                          : 'bg-slate-500/10 border-slate-500/20 text-slate-400'
                      }`}>
                        {(opp.confidence_score || 0) >= 90 ? '⚡ ' : ''}{opp.confidence_score || 0}% confiança
                      </span>
                      {opp.auto_apply && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-semibold">
                          ✓ Auto-aplicável
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-4 text-xs text-slate-400 flex-wrap">
                      <span>ASIN: <span className="font-mono text-cyan">{opp.asin}</span></span>
                      <span>Cliques: <span className="text-white">{opp.total_clicks}</span></span>
                      <span>Vendas: <span className="text-emerald-400">{opp.total_sales}</span></span>
                      <span>ACoS: <span className={opp.current_avg_acos > 30 ? 'text-red-400' : 'text-emerald-400'}>{opp.current_avg_acos.toFixed(1)}%</span></span>
                      <span>ROAS: <span className="text-cyan">{opp.current_avg_roas.toFixed(2)}</span></span>
                      {opp.best_day_of_week && (
                        <span className="flex items-center gap-1 text-emerald-400">
                          <TrendingUp className="w-3 h-3" />
                          Melhor dia: <span className="font-semibold text-white">{opp.best_day_of_week.day_name}</span>
                        </span>
                      )}
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-2">
                    <div className="text-right">
                      <p className="text-xs text-slate-500">Economia estimada</p>
                      <p className="text-sm font-bold text-emerald-400">${opp.estimated_daily_savings?.toFixed(2)}/dia</p>
                    </div>
                    <Button onClick={() => setSelectedOpp(opp)} size="sm">
                      Revisar <ChevronRight className="w-4 h-4 ml-1" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Campanhas Inelegíveis */}
      {skipped.length > 0 && (
        <Card className="bg-surface-1 border-surface-2">
          <CardHeader>
            <CardTitle className="text-sm font-semibold text-white flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400" />
              Campanhas Inelegíveis ({skipped.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {skipped.slice(0, 5).map((s, i) => (
                <div key={i} className="text-xs text-slate-400 flex items-center justify-between py-1 border-b border-surface-2/50 last:border-0">
                  <span className="font-mono text-cyan">{s.campaign_id}</span>
                  <span className="text-slate-500">{s.reason}</span>
                </div>
              ))}
              {skipped.length > 5 && (
                <p className="text-xs text-slate-500 italic">+{skipped.length - 5} mais...</p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Modal de Aprovação */}
      {selectedOpp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={e => e.target === e.currentTarget && setSelectedOpp(null)}>
          <div className="bg-surface-1 border border-surface-2 rounded-2xl w-full max-w-4xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-surface-2">
              <div>
                <h2 className="text-sm font-bold text-white">Aprovar Dayparting</h2>
                <p className="text-xs text-slate-400 font-mono">{selectedOpp.campaign_name}</p>
              </div>
              <button onClick={() => setSelectedOpp(null)} className="text-slate-500 hover:text-white">
                <XCircle className="w-5 h-5" />
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {/* Resumo da Campanha */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <div className="bg-surface-2 rounded-xl p-3">
                  <p className="text-xs text-slate-500">Dias de execução</p>
                  <p className="text-lg font-bold text-white">{selectedOpp.days_running}</p>
                </div>
                <div className="bg-surface-2 rounded-xl p-3">
                  <p className="text-xs text-slate-500">Bid Original</p>
                  <p className="text-lg font-bold text-cyan">R$ {selectedOpp.original_bid?.toFixed(2)}</p>
                </div>
                <div className="bg-surface-2 rounded-xl p-3">
                  <p className="text-xs text-slate-500">ROAS Atual</p>
                  <p className="text-lg font-bold text-emerald-400">{selectedOpp.current_avg_roas?.toFixed(2)}</p>
                </div>
                <div className="bg-surface-2 rounded-xl p-3">
                  <p className="text-xs text-slate-500">ACoS Atual</p>
                  <p className="text-lg font-bold text-amber-400">{selectedOpp.current_avg_acos?.toFixed(1)}%</p>
                </div>
              </div>

              {/* Análise por Dia da Semana */}
              <div className="bg-surface-2 rounded-xl p-4 border border-surface-3">
                <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-cyan" />
                  Desempenho por Dia da Semana
                </h3>
                
                {/* Comparação Dias Úteis vs Finais de Semana */}
                <div className="grid grid-cols-2 gap-3 mb-4">
                  <div className="bg-cyan/5 border border-cyan/20 rounded-lg p-3">
                    <p className="text-xs text-cyan font-semibold mb-2">Dias Úteis (Seg–Sex)</p>
                    <div className="space-y-1 text-xs">
                      <div className="flex justify-between">
                        <span className="text-slate-400">ROAS:</span>
                        <span className="text-white font-semibold">{(selectedOpp.weekday_metrics?.roas || 0).toFixed(2)}x</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">ACoS:</span>
                        <span className="text-white font-semibold">{(selectedOpp.weekday_metrics?.acos || 100).toFixed(1)}%</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Vendas:</span>
                        <span className="text-emerald-400 font-semibold">${(selectedOpp.weekday_metrics?.sales || 0).toFixed(0)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Conversão:</span>
                        <span className="text-white font-semibold">{((selectedOpp.weekday_metrics?.cvr || 0) * 100).toFixed(1)}%</span>
                      </div>
                    </div>
                  </div>
                  
                  <div className="bg-amber/5 border border-amber/20 rounded-lg p-3">
                    <p className="text-xs text-amber-400 font-semibold mb-2">Finais de Semana (Sáb–Dom)</p>
                    <div className="space-y-1 text-xs">
                      <div className="flex justify-between">
                        <span className="text-slate-400">ROAS:</span>
                        <span className="text-white font-semibold">{(selectedOpp.weekend_metrics?.roas || 0).toFixed(2)}x</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">ACoS:</span>
                        <span className="text-white font-semibold">{(selectedOpp.weekend_metrics?.acos || 100).toFixed(1)}%</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Vendas:</span>
                        <span className="text-emerald-400 font-semibold">${(selectedOpp.weekend_metrics?.sales || 0).toFixed(0)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Conversão:</span>
                        <span className="text-white font-semibold">{((selectedOpp.weekend_metrics?.cvr || 0) * 100).toFixed(1)}%</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Melhor e Pior Dia */}
                <div className="grid grid-cols-2 gap-3 mb-4">
                  {selectedOpp.best_day_of_week && (
                    <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-3">
                      <p className="text-xs text-emerald-400 font-semibold mb-2 flex items-center gap-1">
                        <TrendingUp className="w-3 h-3" /> Melhor Dia
                      </p>
                      <p className="text-sm font-bold text-white mb-1">{selectedOpp.best_day_of_week.day_name}</p>
                      <div className="space-y-1 text-xs">
                        <div className="flex justify-between">
                          <span className="text-slate-400">ROAS:</span>
                          <span className="text-emerald-400 font-semibold">{(selectedOpp.best_day_of_week.roas || 0).toFixed(2)}x</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-400">Vendas:</span>
                          <span className="text-emerald-400 font-semibold">${(selectedOpp.best_day_of_week.sales || 0).toFixed(0)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-400">Cliques:</span>
                          <span className="text-white font-semibold">{(selectedOpp.best_day_of_week.clicks || 0).toLocaleString()}</span>
                        </div>
                      </div>
                    </div>
                  )}
                  
                  {selectedOpp.worst_day_of_week && (
                    <div className="bg-red-500/5 border border-red-500/20 rounded-lg p-3">
                      <p className="text-xs text-red-400 font-semibold mb-2 flex items-center gap-1">
                        <TrendingDown className="w-3 h-3" /> Pior Dia
                      </p>
                      <p className="text-sm font-bold text-white mb-1">{selectedOpp.worst_day_of_week.day_name}</p>
                      <div className="space-y-1 text-xs">
                        <div className="flex justify-between">
                          <span className="text-slate-400">ACoS:</span>
                          <span className="text-red-400 font-semibold">{(selectedOpp.worst_day_of_week.acos || 0).toFixed(1)}%</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-400">Vendas:</span>
                          <span className="text-emerald-400 font-semibold">${(selectedOpp.worst_day_of_week.sales || 0).toFixed(0)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-400">Cliques:</span>
                          <span className="text-white font-semibold">{(selectedOpp.worst_day_of_week.clicks || 0).toLocaleString()}</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Tabela de todos os dias */}
                {selectedOpp.daily_analysis && selectedOpp.daily_analysis.length > 0 && (
                  <div>
                    <p className="text-xs text-slate-400 mb-2">Desempenho detalhado por dia:</p>
                    <div className="space-y-1">
                      {selectedOpp.daily_analysis.map((day, idx) => (
                        <div key={idx} className="flex items-center justify-between text-xs py-1.5 px-2 rounded bg-surface-3/50">
                          <div className="flex items-center gap-2">
                            <span className={`w-2 h-2 rounded-full ${
                              day.is_weekend ? 'bg-amber-400' : 'bg-cyan-400'
                            }`} />
                            <span className="text-white font-medium">{day.day_name}</span>
                            {day.is_weekend && <span className="text-[10px] text-amber-400">(Fim de Semana)</span>}
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="text-slate-400">${day.spend?.toFixed(0)}</span>
                            <span className="text-emerald-400">${day.sales?.toFixed(0)}</span>
                            <span className={`font-semibold ${day.roas >= 3 ? 'text-emerald-400' : day.roas >= 1 ? 'text-amber-400' : 'text-red-400'}`}>
                              {day.roas?.toFixed(2)}x
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Estratégia Proposta */}
              <div className="bg-surface-2 rounded-xl p-4 border border-surface-3">
                <h3 className="text-sm font-semibold text-white mb-3">Estratégia Proposta</h3>
                <div className="space-y-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Estratégia de Lance</span>
                    <span className="text-white font-semibold">Dynamic Bids — Down Only</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Bid Fora do Pico</span>
                    <span className="text-white font-semibold">R$ {(selectedOpp.original_bid * 0.20).toFixed(2)} (20% do original)</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Bid Pico Vencedor</span>
                    <span className="text-emerald-400 font-semibold">R$ {selectedOpp.original_bid?.toFixed(2)} (100% do original)</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Modo de Execução</span>
                    <select
                      value={executionMode}
                      onChange={e => setExecutionMode(e.target.value)}
                      className="text-xs bg-surface-3 border border-surface-3 text-white rounded px-2 py-1"
                    >
                      <option value="hybrid">Híbrido (Base 50% + Regra +100%)</option>
                      <option value="native">Nativo (Regra Programada)</option>
                      <option value="programmatic">Programático (Alteração Direta)</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Janelas de Dayparting */}
              <div>
                <h3 className="text-sm font-semibold text-white mb-2">Janelas Propostas por Dia</h3>
                <div className="space-y-2">
                  {Object.entries(selectedOpp.dayparting_windows || {}).map(([day, windows]) => {
                    const dayNames = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
                    return (
                      <div key={day} className="bg-surface-2 rounded-lg p-3">
                        <p className="text-xs font-semibold text-white mb-2">{dayNames[parseInt(day)] || day}</p>
                        <div className="space-y-1">
                          {windows.map((w, i) => (
                            <div key={i} className="flex items-center justify-between text-xs">
                              <span className="text-slate-400">{String(w.startHour).padStart(2, '0')}h–{String(w.endHour).padStart(2, '0')}h</span>
                              <span className={`font-semibold ${
                                w.targetBidPct >= 80 ? 'text-emerald-400' :
                                w.targetBidPct >= 50 ? 'text-amber-400' :
                                'text-red-400'
                              }`}>
                                {w.targetBidPct}% do bid original
                              </span>
                              <span className="text-slate-500">{w.classification}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Impacto Esperado */}
              <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4">
                <h3 className="text-sm font-semibold text-emerald-300 mb-2">Impacto Esperado</h3>
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <p className="text-slate-400">Economia diária estimada</p>
                    <p className="text-lg font-bold text-emerald-400">${selectedOpp.estimated_daily_savings?.toFixed(2)}</p>
                  </div>
                  <div>
                    <p className="text-slate-400">Melhoria ROAS</p>
                    <p className="text-lg font-bold text-emerald-400">+{selectedOpp.estimated_roas_improvement_pct?.toFixed(1)}%</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Ações */}
            <div className="px-6 py-4 border-t border-surface-2 flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => setSelectedOpp(null)}>
                Cancelar
              </Button>
              <Button
                onClick={() => executeDayparting(selectedOpp, true)}
                disabled={executing}
                className="bg-emerald-500 hover:bg-emerald-400"
              >
                {executing ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                {executing ? 'Aplicando...' : 'Aprovar e Aplicar Dayparting'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {!opportunities.length && !analyzing && (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
          <Clock className="w-12 h-12 text-slate-600" />
          <p className="text-sm text-slate-400">
            Clique em "Analisar Horários" para identificar campanhas elegíveis para dayparting.
          </p>
        </div>
      )}
    </div>
  );
}