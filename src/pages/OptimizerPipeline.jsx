import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Brain, Zap, Calculator, FileText, Play, Loader2, AlertCircle, CheckCircle, TrendingUp, TrendingDown } from 'lucide-react';

export default function OptimizerPipeline() {
  const [account, setAccount] = useState(null);
  const [running, setRunning] = useState(false);
  const [step, setStep] = useState(null);
  const [results, setResults] = useState(null);
  const [useAI, setUseAI] = useState(false);
  const [simulateOnly, setSimulateOnly] = useState(true);

  useEffect(() => {
    const loadAccount = async () => {
      try {
        const me = await base44.auth.me();
        const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
        if (accounts.length > 0) setAccount(accounts[0]);
      } catch (error) {
        console.error('Erro:', error);
      }
    };
    loadAccount();
  }, []);

  const runPipeline = async () => {
    if (!account) return;
    setRunning(true);
    setResults(null);

    try {
      // Camada 1
      setStep({ current: 1, total: 3, label: 'Calculando métricas...' });
      const layer1 = await base44.functions.invoke('calculateMetrics', { amazon_account_id: account.id });
      if (!layer1.data?.ok) throw new Error(layer1.data?.error);

      // Camada 2
      setStep({ current: 2, total: 3, label: 'Aplicando regras...' });
      const layer2 = await base44.functions.invoke('applyOptimizationRules', { 
        amazon_account_id: account.id,
        simulate_only: simulateOnly,
      });
      if (!layer2.data?.ok) throw new Error(layer2.data?.error);

      // Camada 3
      setStep({ current: 3, total: 3, label: 'Gerando resumo...' });
      const layer3 = await base44.functions.invoke('summarizeForAI', { 
        amazon_account_id: account.id,
        use_ai: useAI,
      });
      if (!layer3.data?.ok) throw new Error(layer3.data?.error);

      setResults({ layer1: layer1.data, layer2: layer2.data, layer3: layer3.data });
    } catch (error) {
      setResults({ error: error.message });
    } finally {
      setRunning(false);
      setStep(null);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-white">Motor de Otimização</h1>
          <p className="text-sm text-slate-400">Cálculos → Regras → IA</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={useAI} onChange={e => setUseAI(e.target.checked)} className="rounded" />
            <span>Usar IA</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={simulateOnly} onChange={e => setSimulateOnly(e.target.checked)} className="rounded" />
            <span>Simulação</span>
          </label>
          <button onClick={runPipeline} disabled={running || !account} className="flex items-center gap-2 px-4 py-2 bg-cyan text-white rounded-lg disabled:opacity-50">
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {running ? 'Executando...' : 'Executar'}
          </button>
        </div>
      </div>

      {step && (
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <Loader2 className="w-5 h-5 text-cyan animate-spin" />
            <div className="flex-1">
              <p className="text-sm font-semibold">{step.label}</p>
              <div className="mt-2 h-2 bg-surface-3 rounded-full overflow-hidden">
                <div className="h-full bg-cyan" style={{ width: `${(step.current / step.total) * 100}%` }} />
              </div>
            </div>
            <span className="text-xs text-slate-500">{step.current}/{step.total}</span>
          </div>
        </div>
      )}

      {results?.layer1 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="rounded-xl border border-cyan/20 bg-cyan/5 p-4">
            <p className="text-xs text-slate-500">Campanhas</p>
            <p className="text-xl font-bold text-white">{results.layer1.summary.campaigns.total}</p>
          </div>
          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
            <p className="text-xs text-slate-500">Keywords</p>
            <p className="text-xl font-bold text-white">{results.layer1.summary.keywords.total}</p>
          </div>
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
            <p className="text-xs text-slate-500">Search Terms</p>
            <p className="text-xl font-bold text-white">{results.layer1.summary.search_terms.total}</p>
          </div>
          <div className="rounded-xl border border-cyan/20 bg-cyan/5 p-4">
            <p className="text-xs text-slate-500">Decisões</p>
            <p className="text-xl font-bold text-white">{results.layer2.decisions_generated}</p>
          </div>
        </div>
      )}

      {results?.layer3?.executive_summary && (
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-white mb-4">Resumo (30 dias)</h2>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            <div className="text-center p-3 rounded-lg bg-surface-2">
              <p className="text-xs text-slate-500">Spend</p>
              <p className="text-lg font-bold">${results.layer3.executive_summary.account_metrics.total_spend}</p>
            </div>
            <div className="text-center p-3 rounded-lg bg-surface-2">
              <p className="text-xs text-slate-500">Vendas</p>
              <p className="text-lg font-bold text-emerald-400">${results.layer3.executive_summary.account_metrics.total_sales}</p>
            </div>
            <div className="text-center p-3 rounded-lg bg-surface-2">
              <p className="text-xs text-slate-500">ACoS</p>
              <p className="text-lg font-bold text-amber-400">{results.layer3.executive_summary.account_metrics.acos}%</p>
            </div>
            <div className="text-center p-3 rounded-lg bg-surface-2">
              <p className="text-xs text-slate-500">ROAS</p>
              <p className="text-lg font-bold text-cyan">{results.layer3.executive_summary.account_metrics.roas}x</p>
            </div>
          </div>
          
          <div className="grid grid-cols-2 gap-4">
            <div>
              <h3 className="text-xs font-semibold text-slate-400 mb-2 flex items-center gap-1">
                <TrendingDown className="w-3 h-3" /> Problemas
              </h3>
              {results.layer3.executive_summary.top_problems?.slice(0, 5).map((p, i) => (
                <div key={i} className="text-xs flex justify-between py-1">
                  <span className="text-slate-300 capitalize">{p.type.replace(/_/g, ' ')}</span>
                  <span className="text-slate-500">{p.count}</span>
                </div>
              ))}
            </div>
            <div>
              <h3 className="text-xs font-semibold text-slate-400 mb-2 flex items-center gap-1">
                <TrendingUp className="w-3 h-3" /> Oportunidades
              </h3>
              {results.layer3.executive_summary.opportunities?.slice(0, 5).map((o, i) => (
                <div key={i} className="text-xs flex justify-between py-1">
                  <span className="text-slate-300 capitalize">{o.type.replace(/_/g, ' ')}</span>
                  <span className="text-slate-500">{o.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {useAI && results?.layer3?.ai_prioritization && (
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <Brain className="w-5 h-5 text-cyan" />
            <h2 className="text-sm font-semibold text-white">Priorização IA</h2>
          </div>
          <div className="space-y-3">
            {results.layer3.ai_prioritization.prioritized_actions?.map((a, i) => (
              <div key={i} className="p-3 rounded-lg bg-surface-2 border border-surface-3">
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-cyan/20 text-cyan flex items-center justify-center text-xs font-bold">{a.rank}</div>
                  <div className="flex-1">
                    <p className="text-sm font-semibold">{a.action}</p>
                    <p className="text-xs text-slate-400 mt-1">{a.reason}</p>
                    <span className={`text-xs px-2 py-0.5 rounded-full mt-2 inline-block ${
                      a.risk === 'low' ? 'bg-emerald-500/10 text-emerald-400' :
                      a.risk === 'medium' ? 'bg-amber-500/10 text-amber-400' :
                      'bg-red-500/10 text-red-400'
                    }`}>Risco: {a.risk}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {results?.error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-400" />
          <p className="text-sm text-red-400">{results.error}</p>
        </div>
      )}

      {!results && !running && (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <Brain className="w-12 h-12 text-slate-600" />
          <p className="text-sm text-slate-400">Clique em "Executar" para iniciar</p>
        </div>
      )}
    </div>
  );
}