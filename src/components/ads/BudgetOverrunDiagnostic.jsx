import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { AlertTriangle, RefreshCw, Loader2, CheckCircle, ChevronDown, ChevronUp, Zap, Sparkles } from 'lucide-react';

/**
 * Painel de diagnóstico de orçamento excedido.
 * Calcula soma dos budgets das campanhas enabled vs daily_budget_limit do AutopilotConfig.
 * Mostra alerta quando soma > cap, e botão de redistribuição proporcional.
 */
export default function BudgetOverrunDiagnostic({ campaigns, account, onRedistributed }) {
  const [budgetLimit, setBudgetLimit] = useState(null);
  const [loading, setLoading] = useState(false);
  const [redistributing, setRedistributing] = useState(false);
  const [preview, setPreview] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  const [result, setResult] = useState(null);
  const [expanded, setExpanded] = useState(false);

  // Carregar daily_budget_limit do AutopilotConfig
  useEffect(() => {
    if (!account?.id) return;
    base44.entities.AutopilotConfig.filter({ amazon_account_id: account.id }, null, 1)
      .then(rows => {
        const cfg = rows[0] || {};
        setBudgetLimit(Number(cfg.daily_budget_limit || cfg.total_daily_budget || 115));
      })
      .catch(() => setBudgetLimit(115));
  }, [account?.id]);

  const enabledCampaigns = campaigns.filter(c => {
    const s = (c.state || c.status || '').toLowerCase();
    return s === 'enabled';
  });

  const currentSum = enabledCampaigns.reduce((s, c) => s + Number(c.daily_budget || 0), 0);
  const cap = budgetLimit || 115;
  const excess = currentSum - cap;
  const isOverrun = excess > 0.5;

  const loadPreview = async () => {
    if (!account?.id || loading) return;
    setLoading(true);
    setPreview(null);
    try {
      const res = await base44.functions.invoke('redistributeCampaignBudgets', { dry_run: true });
      const d = res?.data;
      if (d?.ok) {
        setPreview(d);
        setShowPreview(true);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const applyRedistribution = async () => {
    if (!account?.id || redistributing) return;
    if (!window.confirm(`Redistribuir orçamentos de ${enabledCampaigns.length} campanhas proporcionalmente ao spend dos últimos 7 dias, respeitando o cap de R$${cap.toFixed(2)}?\n\nEsta ação atualiza os budgets na Amazon Ads API.`)) return;
    setRedistributing(true);
    setResult(null);
    try {
      const res = await base44.functions.invoke('redistributeCampaignBudgets', { dry_run: false });
      const d = res?.data;
      if (d?.ok) {
        setResult({ type: 'success', text: `${d.adjusted} campanhas ajustadas · Nova soma: R$${(d.new_sum || 0).toFixed(2)}` });
        setShowPreview(false);
        setPreview(null);
        if (onRedistributed) onRedistributed();
      } else {
        setResult({ type: 'error', text: d?.error || 'Erro ao redistribuir' });
      }
    } catch (e) {
      setResult({ type: 'error', text: e.message });
    } finally {
      setRedistributing(false);
      setTimeout(() => setResult(null), 15000);
    }
  };

  // Não renderizar enquanto não tem o cap carregado
  if (budgetLimit === null) return null;
  // Não mostrar se não há excesso
  if (!isOverrun) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-emerald-500/8 border border-emerald-500/20 rounded-lg">
        <CheckCircle className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
        <span className="text-[10px] text-emerald-300 font-medium">
          Orçamentos OK · Soma: R${currentSum.toFixed(2)} / Cap: R${cap.toFixed(2)}
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Alerta principal */}
      <div className="bg-red-500/10 border border-red-500/30 rounded-lg overflow-hidden">
        <button
          onClick={() => setExpanded(v => !v)}
          className="w-full flex items-center gap-2 px-3 py-2 text-left"
        >
          <AlertTriangle className="w-3.5 h-3.5 text-red-400 flex-shrink-0 animate-pulse" />
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-bold text-red-300">ORÇAMENTO EXCEDIDO</p>
            <p className="text-[9px] text-red-400/80">
              Soma: R${currentSum.toFixed(2)} · Cap: R${cap.toFixed(2)} · Excesso: R${excess.toFixed(2)}
            </p>
          </div>
          {expanded ? <ChevronUp className="w-3 h-3 text-red-400 flex-shrink-0" /> : <ChevronDown className="w-3 h-3 text-red-400 flex-shrink-0" />}
        </button>

        {expanded && (
          <div className="px-3 pb-3 space-y-2 border-t border-red-500/20">
            {/* Lista das campanhas com budget */}
            <div className="max-h-36 overflow-y-auto scrollbar-thin space-y-1 mt-2">
              {enabledCampaigns
                .sort((a, b) => Number(b.daily_budget || 0) - Number(a.daily_budget || 0))
                .map(c => {
                  const isAuto = (c.targeting_type || '').toUpperCase() === 'AUTO';
                  const budget = Number(c.daily_budget || 0);
                  const share = currentSum > 0 ? (budget / currentSum * 100) : 0;
                  return (
                    <div key={c.id} className="flex items-center gap-1.5">
                      {isAuto
                        ? <Zap className="w-2.5 h-2.5 text-amber-400 flex-shrink-0" />
                        : <Sparkles className="w-2.5 h-2.5 text-cyan flex-shrink-0" />
                      }
                      <span className="text-[9px] text-slate-400 truncate flex-1">{c.name || c.campaign_name}</span>
                      <span className="text-[9px] font-mono text-slate-300 flex-shrink-0">R${budget.toFixed(2)}</span>
                      <span className="text-[9px] text-slate-600 flex-shrink-0">({share.toFixed(0)}%)</span>
                    </div>
                  );
                })
              }
            </div>

            {/* Botões de ação */}
            <div className="flex gap-1.5 mt-2">
              <button
                onClick={loadPreview}
                disabled={loading}
                className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-[10px] font-semibold bg-amber-500/15 border border-amber-500/30 text-amber-400 hover:bg-amber-500/25 rounded-lg transition-colors disabled:opacity-50"
              >
                {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                {loading ? 'Calculando...' : 'Preview redistribuição'}
              </button>
              <button
                onClick={applyRedistribution}
                disabled={redistributing}
                className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-[10px] font-semibold bg-red-500/20 border border-red-500/40 text-red-300 hover:bg-red-500/30 rounded-lg transition-colors disabled:opacity-50"
              >
                {redistributing ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                {redistributing ? 'Redistribuindo...' : 'Redistribuir agora'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Resultado */}
      {result && (
        <p className={`text-[10px] text-center font-semibold px-2 py-1 rounded ${result.type === 'success' ? 'text-emerald-400 bg-emerald-500/10' : 'text-red-400 bg-red-500/10'}`}>
          {result.text}
        </p>
      )}

      {/* Preview modal-like */}
      {showPreview && preview && (
        <div className="bg-surface-1 border border-amber-500/30 rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-bold text-amber-400">Preview Redistribuição</p>
            <div className="flex items-center gap-2 text-[9px] text-slate-500">
              <span>Antes: R${(preview.current_sum || 0).toFixed(2)}</span>
              <span>→</span>
              <span className="text-emerald-400">Depois: R${(preview.new_sum || 0).toFixed(2)}</span>
              <span>/ Cap: R${(preview.daily_budget_limit || cap).toFixed(2)}</span>
            </div>
          </div>
          <div className="max-h-48 overflow-y-auto scrollbar-thin space-y-1">
            {(preview.preview || []).map((p, i) => {
              const diff = p.new_budget - p.current_budget;
              return (
                <div key={i} className="flex items-center gap-1.5 py-0.5">
                  <span className="text-[9px] text-slate-400 truncate flex-1">{p.name}</span>
                  <span className="text-[9px] font-mono text-slate-500 flex-shrink-0 line-through">R${p.current_budget.toFixed(2)}</span>
                  <span className="text-[9px] text-slate-600 flex-shrink-0">→</span>
                  <span className={`text-[9px] font-mono font-bold flex-shrink-0 ${diff > 0 ? 'text-emerald-400' : diff < 0 ? 'text-red-400' : 'text-slate-500'}`}>
                    R${p.new_budget.toFixed(2)}
                  </span>
                  {diff !== 0 && (
                    <span className={`text-[9px] flex-shrink-0 ${diff > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      ({diff > 0 ? '+' : ''}{diff.toFixed(2)})
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={applyRedistribution}
              disabled={redistributing}
              className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-[10px] font-semibold bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/30 rounded-lg transition-colors disabled:opacity-50"
            >
              {redistributing ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              {redistributing ? 'Aplicando...' : 'Confirmar e aplicar'}
            </button>
            <button
              onClick={() => { setShowPreview(false); setPreview(null); }}
              className="px-3 py-1.5 text-[10px] text-slate-500 hover:text-slate-300 bg-surface-2 border border-surface-3 rounded-lg transition-colors"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}