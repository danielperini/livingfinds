import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { CheckCircle2, Clock3, RefreshCw, ShieldCheck } from 'lucide-react';

const PHASE_LABELS = {
  buildKeywordLearningSignals: 'Descoberta e sinais',
  runKeywordMLPipeline: 'Previsão econômica',
  mineSearchTermOpportunities: 'Oportunidades',
  runDailyAiAdsAnalysis: 'Análise da IA',
  runImmediateSameSkuSearchTermHarvest: 'Promoção same-SKU',
  promoteWinningSearchTerms: 'Promoção para manual',
  negative_exact: 'Defesa negativa',
};

function parseObservation(row) {
  try { return JSON.parse(row?.observation || '{}'); } catch { return {}; }
}

function formatDate(value) {
  if (!value) return 'aguardando primeiro ciclo';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'data indisponível' : date.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export default function KeywordIntelligenceStatus({ accountId }) {
  const [state, setState] = useState({ loading: true, error: null, row: null });

  const load = useCallback(async () => {
    if (!accountId) return;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const rows = await base44.entities.LearningEvent.filter(
        { amazon_account_id: accountId, event_type: 'daily_keyword_intelligence_cycle' }, '-recorded_at', 1,
      );
      setState({ loading: false, error: null, row: rows[0] || null });
    } catch (error) {
      setState({ loading: false, error: error?.message || 'não foi possível consultar o ciclo', row: null });
    }
  }, [accountId]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [load]);

  const details = parseObservation(state.row);
  const phases = Array.isArray(details.phases) ? details.phases : [];
  const threshold = Math.round(Number(details.confidence_threshold || 0.8) * 100);
  const hasRun = Boolean(state.row);

  return (
    <section className="rounded-2xl border border-cyan/20 bg-cyan/[0.04] p-4 md:p-5">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-cyan">
            <ShieldCheck className="w-3.5 h-3.5" /> Inteligência de termos
          </div>
          <h2 className="text-base font-semibold text-white mt-1">Ciclo diário de análise e otimização</h2>
          <p className="text-xs text-slate-400 mt-1">Descoberta, economia, promoção e defesa com auditoria.</p>
        </div>
        <button type="button" onClick={load} disabled={state.loading || !accountId}
          className="inline-flex items-center gap-1.5 rounded-lg border border-cyan/25 px-2.5 py-1.5 text-[11px] font-semibold text-cyan hover:bg-cyan/10 disabled:opacity-50">
          <RefreshCw className={`w-3 h-3 ${state.loading ? 'animate-spin' : ''}`} /> Atualizar
        </button>
      </div>
      {state.error ? <p role="alert" className="text-xs text-amber-300 mt-3">{state.error}</p> : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-4">
          <div className="rounded-xl border border-white/[0.07] bg-black/10 p-3">
            <p className="text-[10px] uppercase text-slate-500">Último ciclo</p>
            <p className="text-sm font-semibold text-white mt-1">{formatDate(state.row?.recorded_at)}</p>
          </div>
          <div className="rounded-xl border border-white/[0.07] bg-black/10 p-3">
            <p className="text-[10px] uppercase text-slate-500">Confiança mínima</p>
            <p className="text-sm font-semibold text-emerald-300 mt-1">{threshold}%</p>
          </div>
          <div className="rounded-xl border border-white/[0.07] bg-black/10 p-3">
            <p className="text-[10px] uppercase text-slate-500">Negativas avaliadas</p>
            <p className="text-sm font-semibold text-white mt-1">{details.negative_candidates ?? '—'}</p>
          </div>
          <div className="rounded-xl border border-white/[0.07] bg-black/10 p-3">
            <p className="text-[10px] uppercase text-slate-500">Próximo ciclo</p>
            <p className="text-sm font-semibold text-white mt-1">diário após 10h BRT</p>
          </div>
        </div>
      )}
      {hasRun && phases.length ? (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {phases.map((phase) => <span key={phase} className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-300">
            <CheckCircle2 className="w-3 h-3" /> {PHASE_LABELS[phase] || phase}
          </span>)}
        </div>
      ) : !state.loading && !state.error ? (
        <p className="flex items-center gap-1.5 text-[11px] text-slate-400 mt-3"><Clock3 className="w-3 h-3" /> O primeiro ciclo será registrado automaticamente.</p>
      ) : null}
      <div className="flex gap-3 mt-4 text-[11px]">
        <Link to="/search-terms" className="text-cyan hover:underline">Ver termos e promoções →</Link>
        <Link to="/sala-de-comando" className="text-slate-400 hover:text-white">Abrir decisões →</Link>
      </div>
    </section>
  );
}
