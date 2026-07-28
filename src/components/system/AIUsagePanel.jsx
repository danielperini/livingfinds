import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Cpu, Zap, DollarSign, Shield, AlertTriangle } from 'lucide-react';

// Funções e se usam IA ou são determinísticas
const AI_FUNCTION_MAP = [
  { name: 'claudeAdsAgent', label: 'Ads Intelligence Agent', type: 'gpt', model: 'GPT-4o', desc: 'Análise e recomendações — sob demanda' },
  { name: 'runWeeklyClaudeRuleReview', label: 'Revisão Semanal de Regras', type: 'gpt', model: 'GPT-4o', desc: 'Propõe regras determinísticas — 1x/semana' },
  { name: 'runWeeklyMotorPrelection', label: 'Preleção Semanal do Motor', type: 'gpt', model: 'GPT-4o', desc: 'Auditoria estratégica — 1x/semana' },
  { name: 'generateListingEnhancementSuggestions', label: 'Melhorias de Listing', type: 'gpt', model: 'GPT-4o-mini', desc: 'Título, bullets, descrição — sob demanda' },
  { name: 'suggestProductKeywordsWithAI', label: 'Keywords por IA', type: 'gpt', model: 'GPT-4o-mini', desc: 'Só com force_ai=true — kickoff manual' },
  { name: 'runDeterministicDecisionEngine', label: 'Motor Determinístico', type: 'deterministic', desc: 'Bid/budget/pausa — sem IA' },
  { name: 'runAcosBidReductionEngine', label: 'Redutor de ACoS', type: 'deterministic', desc: 'Fórmula bid = bid × (target/acos) — sem IA' },
  { name: 'enforceCampaignSpendLimits', label: 'Kill Switch de Budget', type: 'deterministic', desc: 'Cap 97% — sem IA' },
  { name: 'harvestConvertedSearchTerms', label: 'Harvest de Search Terms', type: 'deterministic', desc: 'Threshold conversão — sem IA' },
  { name: 'pauseAutoCampaignsNoStock', label: 'Pausa por Estoque Zero', type: 'deterministic', desc: 'Verificação FBA — sem IA' },
];

const DAILY_CALL_LIMIT = 20;

export default function AIUsagePanel() {
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const today = new Date().toISOString().slice(0, 10);
        // Carregar logs de uso de IA do dia
        const logs = await base44.entities.AIUsageLog.filter(
          { log_date: today }, '-created_date', 50
        ).catch(() => []);

        if (!active) return;

        const totalCalls = logs.reduce((s, l) => s + (l.calls_made || 0), 0);
        const totalTokens = logs.reduce((s, l) => s + (l.tokens_used || l.total_tokens || 0), 0);
        const totalCost = logs.reduce((s, l) => s + (l.cost_estimate || l.cost_usd || 0), 0);
        const callsAvoided = logs.reduce((s, l) => s + (l.calls_avoided_cache || l.cache_hits || 0), 0);

        // Verificar se ANTHROPIC_API_KEY está sendo usada (deve ser zero)
        const anthropicCalls = logs.filter(l =>
          (l.model || '').toLowerCase().includes('claude') ||
          (l.provider || '').toLowerCase().includes('anthropic')
        ).length;

        setUsage({ totalCalls, totalTokens, totalCost, callsAvoided, anthropicCalls, logs: logs.slice(0, 5) });
      } catch {
        setUsage(null);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const semaphore = !usage ? 'gray'
    : usage.totalCalls >= DAILY_CALL_LIMIT ? 'red'
    : usage.totalCalls >= 15 ? 'amber'
    : 'green';

  const semaphoreColors = {
    green: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400',
    amber: 'bg-amber-500/10 border-amber-500/20 text-amber-400',
    red: 'bg-red-500/10 border-red-500/20 text-red-400',
    gray: 'bg-surface-2 border-surface-3 text-slate-500',
  };

  return (
    <div className="rounded-xl border border-surface-2 bg-surface-1 p-5 space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-violet-400" />
          <h2 className="text-sm font-semibold text-white">Uso de IA</h2>
        </div>
        <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-semibold ${semaphoreColors[semaphore]}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${semaphore === 'green' ? 'bg-emerald-400' : semaphore === 'amber' ? 'bg-amber-400' : semaphore === 'red' ? 'bg-red-400' : 'bg-slate-500'}`} />
          {semaphore === 'green' ? 'Normal' : semaphore === 'amber' ? 'Atenção' : semaphore === 'red' ? 'Limite atingido' : '—'}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-6">
          <div className="w-5 h-5 border-2 border-violet-400/30 border-t-violet-400 rounded-full animate-spin" />
        </div>
      ) : (
        <>
          {/* Métricas do dia */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { icon: Zap, label: 'Chamadas hoje', value: usage ? `${usage.totalCalls} / ${DAILY_CALL_LIMIT}` : '—', color: 'text-violet-400' },
              { icon: Cpu, label: 'Tokens usados', value: usage ? (usage.totalTokens > 0 ? usage.totalTokens.toLocaleString('pt-BR') : '0') : '—', color: 'text-cyan' },
              { icon: DollarSign, label: 'Custo estimado', value: usage ? `US$ ${(usage.totalCost || 0).toFixed(4)}` : '—', color: 'text-emerald-400' },
              { icon: Shield, label: 'Cache (evitadas)', value: usage ? `${usage.callsAvoided}` : '—', color: 'text-amber-400' },
            ].map(({ icon: Icon, label, value, color }) => (
              <div key={label} className="bg-surface-2 rounded-lg p-3">
                <div className="flex items-center gap-1.5 mb-2">
                  <Icon className={`w-3 h-3 ${color}`} />
                  <p className="text-[10px] text-slate-500">{label}</p>
                </div>
                <p className={`text-sm font-bold ${color}`}>{value}</p>
              </div>
            ))}
          </div>

          {/* Alerta Anthropic */}
          {usage?.anthropicCalls > 0 && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-300">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              <span>⚠ Detectadas <strong>{usage.anthropicCalls}</strong> chamadas Anthropic — deve ser zero. Verifique <code>ANTHROPIC_API_KEY</code>.</span>
            </div>
          )}
          {usage?.anthropicCalls === 0 && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/8 border border-emerald-500/15 text-xs text-emerald-400">
              <Shield className="w-3.5 h-3.5 flex-shrink-0" />
              <span>✓ Zero chamadas Anthropic — todas as chamadas de IA usam exclusivamente <strong>OpenAI (OPENAI_API_KEY)</strong></span>
            </div>
          )}

          {/* Tabela de funções */}
          <div>
            <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-2">Funções — IA vs Determinístico</p>
            <div className="space-y-1">
              {AI_FUNCTION_MAP.map(fn => (
                <div key={fn.name} className="flex items-center gap-3 py-1.5 border-b border-surface-2/40 last:border-0">
                  <span className={`flex-shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded ${fn.type === 'gpt' ? 'bg-violet-500/15 text-violet-300 border border-violet-500/20' : 'bg-slate-700/50 text-slate-400 border border-slate-700'}`}>
                    {fn.type === 'gpt' ? `GPT` : 'DET'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <span className="text-xs text-slate-300">{fn.label}</span>
                    <span className="text-[10px] text-slate-600 ml-1.5">{fn.desc}</span>
                  </div>
                  {fn.model && (
                    <span className="text-[10px] text-slate-600 flex-shrink-0">{fn.model}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}