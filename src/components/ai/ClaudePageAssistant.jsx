import { useState, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Sparkles, Loader2, ChevronDown, ChevronUp, AlertTriangle,
  CheckCircle, Clock, XCircle, Ban, RefreshCw, Zap, Info
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';

// ── Status config ─────────────────────────────────────────────────────────────
const STATUS_CONFIG = {
  EXECUTE_NOW:        { label: 'Executar agora',      color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20', icon: Zap },
  RECOMMEND_APPROVAL: { label: 'Requer aprovação',    color: 'text-amber-400 bg-amber-400/10 border-amber-400/20',     icon: AlertTriangle },
  SCHEDULE:           { label: 'Agendar',             color: 'text-blue-400 bg-blue-400/10 border-blue-400/20',        icon: Clock },
  WAIT_FOR_DATA:      { label: 'Aguardar dados',      color: 'text-slate-400 bg-slate-400/10 border-slate-400/20',     icon: Clock },
  BLOCK:              { label: 'Bloqueado',            color: 'text-red-400 bg-red-400/10 border-red-400/20',           icon: Ban },
  NO_ACTION:          { label: 'Sem ação necessária', color: 'text-slate-400 bg-slate-400/10 border-slate-400/20',     icon: CheckCircle },
  ROLLBACK:           { label: 'Reverter',             color: 'text-orange-400 bg-orange-400/10 border-orange-400/20', icon: RefreshCw },
};

const RISK_COLORS = {
  low:    'text-emerald-400',
  medium: 'text-amber-400',
  high:   'text-red-400',
};

// ── Sub-componentes ───────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.NO_ACTION;
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-semibold ${cfg.color}`}>
      <Icon className="w-3 h-3" />
      {cfg.label}
    </span>
  );
}

function ConfidenceBar({ value = 0 }) {
  const color = value >= 80 ? 'bg-emerald-400' : value >= 60 ? 'bg-amber-400' : 'bg-red-400';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-surface-3 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${value}%` }} />
      </div>
      <span className="text-xs text-slate-400 w-8 text-right">{value}%</span>
    </div>
  );
}

function RationaleSection({ rationale }) {
  if (!rationale || typeof rationale !== 'object') return null;

  const rows = [
    { label: 'Objetivo',         value: rationale.objective },
    { label: 'Diagnóstico',      value: rationale.diagnosis },
    { label: 'Evidências',       value: rationale.evidence },
    { label: 'Por que esta ação',value: rationale.why_this_action },
    { label: 'Alternativas descartadas', value: rationale.why_not_alternatives },
    { label: 'Resultado esperado', value: rationale.expected_result },
    { label: 'Avaliar em',       value: rationale.evaluation_at },
    { label: 'Critério de sucesso', value: rationale.success_criteria },
    { label: 'Critério de rollback', value: rationale.rollback_criteria },
  ].filter(r => r.value);

  return (
    <div className="space-y-2 pt-2 border-t border-surface-3/50">
      {rows.map(r => (
        <div key={r.label}>
          <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-0.5">{r.label}</p>
          <p className="text-xs text-slate-300 leading-relaxed">{r.value}</p>
        </div>
      ))}
      {rationale.risk && (
        <div className="flex items-center gap-2 pt-1">
          <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Risco:</span>
          <span className={`text-xs font-semibold capitalize ${RISK_COLORS[rationale.risk] || 'text-slate-400'}`}>
            {rationale.risk}
          </span>
        </div>
      )}
      {rationale.confidence != null && (
        <div>
          <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Confiança</p>
          <ConfidenceBar value={rationale.confidence} />
        </div>
      )}
    </div>
  );
}

function DecisionCard({ decision }) {
  const [expanded, setExpanded] = useState(false);
  if (!decision || typeof decision !== 'object') return null;

  const hasChange = decision.value_before != null && decision.value_after != null;
  const changePct = decision.change_pct;

  return (
    <div className="border border-surface-3 bg-surface-2/40 rounded-xl overflow-hidden">
      <div className="px-3 py-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap flex-1">
            <StatusBadge status={decision.status} />
            {decision.action && (
              <span className="text-xs font-mono text-slate-400 bg-surface-3 px-1.5 py-0.5 rounded">
                {decision.action}
              </span>
            )}
            {decision.entity_type && (
              <span className="text-xs text-slate-500">{decision.entity_type}</span>
            )}
          </div>
          <button onClick={() => setExpanded(v => !v)} className="text-slate-500 hover:text-slate-300 flex-shrink-0">
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>

        {hasChange && (
          <div className="flex items-center gap-3 mt-2">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-slate-500">Antes:</span>
              <span className="text-sm font-bold text-white">{decision.value_before}</span>
            </div>
            <span className="text-slate-600">→</span>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-slate-500">Depois:</span>
              <span className="text-sm font-bold text-cyan">{decision.value_after}</span>
            </div>
            {changePct != null && (
              <span className={`text-xs font-semibold px-1.5 py-0.5 rounded ${changePct > 0 ? 'text-emerald-400 bg-emerald-400/10' : 'text-red-400 bg-red-400/10'}`}>
                {changePct > 0 ? '+' : ''}{changePct}%
              </span>
            )}
          </div>
        )}

        {decision.requires_approval && (
          <div className="flex items-center gap-1 mt-1.5">
            <AlertTriangle className="w-3 h-3 text-amber-400" />
            <span className="text-xs text-amber-400">Requer aprovação humana</span>
          </div>
        )}
      </div>

      {expanded && decision.rationale && (
        <div className="px-3 pb-3">
          <RationaleSection rationale={decision.rationale} />
        </div>
      )}
    </div>
  );
}

// ── Componente principal ──────────────────────────────────────────────────────
/**
 * ClaudePageAssistant
 *
 * Props:
 *   title      string   — título do painel (padrão: "Assistente IA")
 *   prompt     string   — prompt base enviado ao agente (obrigatório)
 *   context    object   — dados de contexto estruturados para o agente
 *   autoRun    boolean  — executa automaticamente ao montar (padrão: false)
 *   compact    boolean  — modo compacto sem cabeçalho expandido (padrão: false)
 *   className  string   — classes extras para o container
 */
export default function ClaudePageAssistant({
  title = 'Assistente IA',
  prompt,
  context = null,
  autoRun = false,
  compact = false,
  className = '',
}) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [ran, setRan] = useState(false);

  const run = useCallback(async () => {
    if (!prompt) return;
    setLoading(true);
    setError(null);
    try {
      const res = await base44.functions.invoke('claudeAdsAgent', {
        mode: 'analyze',
        prompt,
        context,
      });
      if (!res?.data?.ok) throw new Error(res?.data?.error || 'Erro na análise da IA.');
      setResult(res.data.response);
      setRan(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [prompt, context]);

  // autoRun na primeira renderização
  useState(() => { if (autoRun && !ran) run(); }, []);

  // Detectar se o resultado é uma decisão estruturada ou texto livre
  const isDecision = result && typeof result === 'object' && result.status;
  const isText = result && typeof result === 'string';
  const isArray = Array.isArray(result);

  return (
    <div className={`bg-surface-1 border border-surface-2 rounded-xl overflow-hidden ${className}`}>
      {/* Header */}
      {!compact && (
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-2">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-violet-500/20 border border-violet-500/30 flex items-center justify-center">
              <Sparkles className="w-3.5 h-3.5 text-violet-400" />
            </div>
            <h3 className="text-sm font-semibold text-white">{title}</h3>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400 border border-violet-500/20 font-medium">
              Claude AI
            </span>
          </div>
          <button
            onClick={run}
            disabled={loading || !prompt}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-violet-500/15 border border-violet-500/30 text-violet-400 hover:bg-violet-500/25 rounded-lg transition-colors disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {loading ? 'Analisando...' : ran ? 'Atualizar análise' : 'Analisar com IA'}
          </button>
        </div>
      )}

      {/* Compact trigger */}
      {compact && !ran && (
        <button
          onClick={run}
          disabled={loading || !prompt}
          className="w-full flex items-center justify-center gap-2 px-3 py-2.5 text-xs font-semibold text-violet-400 hover:bg-violet-500/10 transition-colors disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          {loading ? 'Analisando com IA...' : title}
        </button>
      )}

      {/* Loading */}
      {loading && !compact && (
        <div className="flex flex-col items-center justify-center py-10 gap-3">
          <div className="relative">
            <div className="w-10 h-10 rounded-full border-2 border-violet-500/20 border-t-violet-400 animate-spin" />
            <Sparkles className="w-4 h-4 text-violet-400 absolute inset-0 m-auto" />
          </div>
          <p className="text-sm text-slate-400">Agente IA analisando dados...</p>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-start gap-2 mx-4 my-3 px-3 py-2.5 bg-red-400/10 border border-red-400/20 rounded-lg">
          <XCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-red-300">{error}</p>
        </div>
      )}

      {/* Result: structured decision */}
      {!loading && isDecision && (
        <div className="p-4">
          <DecisionCard decision={result} />
        </div>
      )}

      {/* Result: array of decisions */}
      {!loading && isArray && (
        <div className="p-4 space-y-3">
          {result.map((item, i) => (
            <DecisionCard key={i} decision={item} />
          ))}
        </div>
      )}

      {/* Result: free text / markdown */}
      {!loading && isText && (
        <div className="px-4 py-3">
          <div className="prose prose-sm prose-invert max-w-none text-slate-300 text-sm leading-relaxed">
            <ReactMarkdown>{result}</ReactMarkdown>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && !result && ran && (
        <div className="flex flex-col items-center justify-center py-8 gap-2 text-center px-4">
          <Info className="w-6 h-6 text-slate-600" />
          <p className="text-xs text-slate-500">O agente não retornou análise para os dados fornecidos.</p>
        </div>
      )}

      {/* Compact loading overlay */}
      {loading && compact && (
        <div className="flex items-center justify-center gap-2 py-3 px-4">
          <Loader2 className="w-4 h-4 text-violet-400 animate-spin" />
          <p className="text-xs text-slate-400">Analisando com IA...</p>
        </div>
      )}
    </div>
  );
}