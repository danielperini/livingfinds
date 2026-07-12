import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Shield, RefreshCw, Play, AlertTriangle, CheckCircle, XCircle,
  Loader2, ChevronDown, ChevronRight, Info
} from 'lucide-react';

const GUARDRAIL_DOCS = {
  'G1': { label: 'Bid Floor', color: 'text-blue-400', desc: 'Nenhum lance cai abaixo do mínimo configurado (min_bid).' },
  'G2': { label: 'Bid Ceiling', color: 'text-violet-400', desc: 'Nenhum lance sobe acima do máximo configurado (max_bid).' },
  'G3': { label: 'CPC Econômico', color: 'text-cyan', desc: 'Bid nunca excede o CPC máximo seguro calculado por margem e CVR do produto.' },
  'G4': { label: 'ACoS Crítico', color: 'text-red-400', desc: 'Bloqueia aumentos em campanhas com ACoS > max_acos × 1.3.' },
  'G5': { label: 'Variação Máxima', color: 'text-amber-400', desc: 'Nenhum lance muda mais que max_bid_change_pct em um único ciclo.' },
  'G6': { label: 'Budget Cap', color: 'text-orange-400', desc: 'Bloqueia aumentos quando gasto real de ontem ≥ limite diário.' },
  'G7': { label: 'ROAS Mínimo', color: 'text-emerald-400', desc: 'Bloqueia escala quando ROAS < 70% do alvo configurado.' },
  'G8': { label: 'Keyword Nova', color: 'text-sky-400', desc: 'Protege keywords criadas há menos de 48h de reduções prematuras.' },
  'G9': { label: 'CPC Aberrante', color: 'text-pink-400', desc: 'Bids > 3× a média da campanha são cortados para 2.5× a média.' },
  'G10': { label: 'Estoque Crítico', color: 'text-red-500', desc: 'Bloqueia qualquer aumento quando cobertura de estoque < 7 dias.' },
};

function GuardrailBadge({ code }) {
  const g = GUARDRAIL_DOCS[code] || { label: code, color: 'text-slate-400', desc: '' };
  const [tip, setTip] = useState(false);
  return (
    <span className="relative inline-flex items-center gap-1">
      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border bg-surface-3/50 border-surface-3 ${g.color}`}>
        {code}: {g.label}
      </span>
      <button onClick={() => setTip(v => !v)} className="text-slate-600 hover:text-slate-400">
        <Info className="w-3 h-3" />
      </button>
      {tip && (
        <div className="absolute bottom-full left-0 mb-1 w-56 bg-surface-1 border border-surface-2 rounded-lg p-2 text-[10px] text-slate-300 z-10 shadow-xl">
          {g.desc}
        </div>
      )}
    </span>
  );
}

function ResultRow({ r }) {
  const [open, setOpen] = useState(false);
  const codes = (r.rule || '').split(' | ').filter(g => g !== 'pass');
  return (
    <div className="border-b border-surface-2/40 last:border-0">
      <button onClick={() => setOpen(v => !v)}
        className="w-full flex items-start gap-3 px-4 py-2.5 hover:bg-surface-2/30 text-left transition-colors">
        <div className="flex-shrink-0 mt-0.5">
          {r.blocked
            ? <XCircle className="w-4 h-4 text-red-400" />
            : r.triggered
            ? <AlertTriangle className="w-4 h-4 text-amber-400" />
            : <CheckCircle className="w-4 h-4 text-emerald-400" />}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-slate-300 font-medium">
            {r.blocked ? '🚫 Bloqueada' : r.triggered ? '⚡ Ajustada' : '✓ Aprovada'}
            {r.entity_id && <span className="ml-2 text-[10px] font-mono text-slate-500">...{String(r.entity_id).slice(-8)}</span>}
          </p>
          <div className="flex flex-wrap gap-1 mt-1">
            {codes.map(c => <GuardrailBadge key={c} code={c.split(':')[0]} />)}
          </div>
        </div>
        {open ? <ChevronDown className="w-3.5 h-3.5 text-slate-500 flex-shrink-0 mt-0.5" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-500 flex-shrink-0 mt-0.5" />}
      </button>
      {open && (
        <div className="px-4 pb-3 ml-7">
          <p className="text-[10px] text-slate-400 leading-relaxed">{r.reason}</p>
          {r.original_value != null && r.clamped_value != null && (
            <p className="text-[10px] text-amber-400 mt-1">
              R${r.original_value.toFixed(2)} → R${r.clamped_value.toFixed(2)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function GuardrailsPanel({ accountId }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [lastLog, setLastLog] = useState(null);
  const [showAll, setShowAll] = useState(false);

  const loadLastLog = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const logs = await base44.entities.SyncExecutionLog.filter(
        { amazon_account_id: accountId, operation: 'bid_budget_guardrails' },
        '-started_at', 1
      ).catch(() => []);
      setLastLog(logs[0] || null);
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => { loadLastLog(); }, [loadLastLog]);

  const runGuardrails = async (dryRun = false) => {
    if (!accountId || running) return;
    setRunning(true);
    try {
      const res = await base44.functions.invoke('runBidBudgetGuardrails', {
        amazon_account_id: accountId,
        dry_run: dryRun,
      });
      setResult(res?.data || null);
      await loadLastLog();
    } finally {
      setRunning(false);
    }
  };

  const summary = result?.guardrails;
  const triggered = result?.triggered_results || [];
  const showList = showAll ? triggered : triggered.filter(r => r.triggered);

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-surface-2">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center">
            <Shield className="w-4 h-4 text-emerald-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-200">Guardrails de Lance & Orçamento</p>
            <p className="text-[10px] text-slate-500">10 regras automáticas que protegem todas as decisões do motor</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={loadLastLog} disabled={loading}
            className="p-1.5 text-slate-500 hover:text-slate-300 transition-colors">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={() => runGuardrails(true)} disabled={running || !accountId}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border bg-surface-2 border-surface-3 text-slate-400 hover:text-white disabled:opacity-50 transition-colors">
            {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
            Simular
          </button>
          <button onClick={() => runGuardrails(false)} disabled={running || !accountId}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border bg-emerald-500/15 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25 disabled:opacity-50 transition-colors">
            {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Shield className="w-3 h-3" />}
            Aplicar Agora
          </button>
        </div>
      </div>

      {/* Resumo de 10 regras */}
      <div className="px-5 py-4 border-b border-surface-2">
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {Object.entries(GUARDRAIL_DOCS).map(([code, g]) => (
            <div key={code} className="rounded-lg border border-surface-3 bg-surface-2/40 px-2.5 py-2">
              <p className={`text-[10px] font-bold ${g.color}`}>{code}</p>
              <p className="text-[10px] text-slate-400 mt-0.5 leading-tight">{g.label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Último log */}
      {lastLog && !result && (
        <div className="px-5 py-3 border-b border-surface-2 flex items-center justify-between text-[10px]">
          <span className="text-slate-500">
            Última execução: <span className="text-slate-300">
              {new Date(lastLog.started_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
            </span>
          </span>
          {lastLog.result_summary && (() => {
            try {
              const s = JSON.parse(lastLog.result_summary);
              return (
                <div className="flex items-center gap-3">
                  <span className="text-red-400">🚫 {s.blocked} bloqueadas</span>
                  <span className="text-amber-400">⚡ {s.clamped} ajustadas</span>
                  <span className="text-emerald-400">✓ {s.passed} aprovadas</span>
                </div>
              );
            } catch { return null; }
          })()}
        </div>
      )}

      {/* Resultado da execução */}
      {result && (
        <div className="px-5 py-4 border-b border-surface-2 space-y-3">
          {result.dry_run && (
            <div className="flex items-center gap-2 px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs text-amber-400">
              <Info className="w-3.5 h-3.5 flex-shrink-0" />
              Modo simulação — nenhuma alteração foi aplicada.
            </div>
          )}

          {/* KPIs */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-red-500/8 border border-red-500/20 rounded-lg p-3 text-center">
              <p className="text-xl font-bold text-red-400">{summary?.blocked ?? 0}</p>
              <p className="text-[10px] text-slate-500 mt-0.5">Bloqueadas</p>
            </div>
            <div className="bg-amber-500/8 border border-amber-500/20 rounded-lg p-3 text-center">
              <p className="text-xl font-bold text-amber-400">{summary?.clamped ?? 0}</p>
              <p className="text-[10px] text-slate-500 mt-0.5">Valores Ajustados</p>
            </div>
            <div className="bg-emerald-500/8 border border-emerald-500/20 rounded-lg p-3 text-center">
              <p className="text-xl font-bold text-emerald-400">{summary?.passed ?? 0}</p>
              <p className="text-[10px] text-slate-500 mt-0.5">Aprovadas</p>
            </div>
          </div>

          {/* Budget guardrail */}
          {summary?.budget_guardrail_active && (
            <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              <span>G6 ativo: gasto D-1 R${summary.spend_yesterday?.toFixed(2)} ≥ cap R${summary.budget_cap} — todos os aumentos bloqueados.</span>
            </div>
          )}

          {/* Limites aplicados */}
          {result.limits_applied && (
            <div className="flex flex-wrap gap-2 text-[10px]">
              {Object.entries(result.limits_applied).map(([k, v]) => (
                <span key={k} className="px-2 py-1 bg-surface-2 border border-surface-3 rounded text-slate-400">
                  <span className="text-slate-500">{k}:</span> {String(v)}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Lista de resultados */}
      {result && triggered.length > 0 && (
        <div>
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-surface-2">
            <p className="text-[10px] text-slate-500">{triggered.filter(r => r.triggered).length} intervenções</p>
            <button onClick={() => setShowAll(v => !v)} className="text-[10px] text-cyan hover:underline">
              {showAll ? 'Mostrar apenas intervenções' : `Ver todas (${triggered.length})`}
            </button>
          </div>
          <div className="max-h-80 overflow-y-auto scrollbar-thin">
            {showList.map((r, i) => <ResultRow key={r.decision_id || i} r={r} />)}
          </div>
        </div>
      )}

      {result && triggered.length === 0 && (
        <div className="px-5 py-6 text-center">
          <CheckCircle className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
          <p className="text-sm text-slate-400">Todas as decisões passaram nos guardrails.</p>
        </div>
      )}
    </div>
  );
}