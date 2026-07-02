import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Sparkles, Loader2, CheckCircle, XCircle, AlertTriangle,
  RefreshCw, Check, X, ChevronDown, ChevronUp, Zap, Copy
} from 'lucide-react';

const INTENT_LABELS = {
  commercial: 'Comercial',
  high_purchase_intent: 'Alta intenção',
  informational: 'Informacional',
  navigational: 'Navegacional',
};

const INTENT_COLORS = {
  commercial: 'text-cyan bg-cyan/10 border-cyan/20',
  high_purchase_intent: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
  informational: 'text-slate-400 bg-slate-400/10 border-slate-400/20',
  navigational: 'text-amber-400 bg-amber-400/10 border-amber-400/20',
};

function ScoreBar({ value, color = 'bg-cyan' }) {
  const pct = Math.round((value || 0) * 100);
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-16 h-1.5 bg-surface-3 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] text-slate-400">{pct}%</span>
    </div>
  );
}

function SuggestionCard({ suggestion, selected, onToggleSelect, onEditBid, onEditBudget }) {
  const [expanded, setExpanded] = useState(false);
  const [bid, setBid] = useState(suggestion.recommended_bid?.toFixed(2) || '0.30');
  const [budget, setBudget] = useState(suggestion.recommended_budget?.toFixed(2) || '5.00');

  const isDuplicate = suggestion.status === 'duplicate' || suggestion.already_exists;
  const isBlocked = suggestion.status === 'blocked';
  const isCreated = suggestion.status === 'created';
  const isCreating = suggestion.status === 'creating';
  const isFailed = suggestion.status === 'failed';
  const canSelect = !isDuplicate && !isBlocked && !isCreated && !isCreating;

  const tailLabel = suggestion.tail_type === 'long' ? 'Cauda longa' : 'Cauda média';
  const tailColor = suggestion.tail_type === 'long' ? 'text-violet-400 bg-violet-400/10 border-violet-400/20' : 'text-blue-400 bg-blue-400/10 border-blue-400/20';

  return (
    <div className={`border rounded-xl transition-all ${
      isCreated ? 'border-emerald-400/30 bg-emerald-400/5' :
      isDuplicate ? 'border-slate-600/30 bg-slate-800/30 opacity-60' :
      isBlocked ? 'border-red-400/20 bg-red-400/5 opacity-60' :
      isFailed ? 'border-red-400/30 bg-red-400/5' :
      selected ? 'border-cyan/40 bg-cyan/5' :
      'border-surface-3 bg-surface-2/40 hover:border-surface-2'
    }`}>
      <div className="px-3 py-2.5">
        {/* Row 1: checkbox + keyword + badges */}
        <div className="flex items-start gap-2">
          {canSelect && (
            <button
              onClick={() => onToggleSelect(suggestion)}
              className={`mt-0.5 w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
                selected ? 'bg-cyan border-cyan' : 'border-slate-600 hover:border-cyan'
              }`}
            >
              {selected && <Check className="w-2.5 h-2.5 text-white" />}
            </button>
          )}
          {isCreated && <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />}
          {isDuplicate && <Copy className="w-4 h-4 text-slate-500 flex-shrink-0 mt-0.5" />}
          {isFailed && <XCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />}
          {isCreating && <Loader2 className="w-4 h-4 text-cyan animate-spin flex-shrink-0 mt-0.5" />}

          <div className="flex-1 min-w-0">
            <p className={`text-sm font-medium leading-snug ${isDuplicate || isBlocked ? 'text-slate-500' : 'text-white'}`}>
              {suggestion.keyword}
            </p>
            <div className="flex items-center gap-1.5 flex-wrap mt-1">
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${tailColor}`}>{tailLabel}</span>
              <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded border ${INTENT_COLORS[suggestion.intent] || INTENT_COLORS.commercial}`}>
                {INTENT_LABELS[suggestion.intent] || suggestion.intent}
              </span>
              {isDuplicate && (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-500/20 text-slate-400 border border-slate-500/20">
                  Já existe
                </span>
              )}
              {isCreated && (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-400/20 text-emerald-400 border border-emerald-400/20">
                  Criada ✓
                </span>
              )}
              {isFailed && (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-400/20 text-red-400 border border-red-400/20">
                  Falhou
                </span>
              )}
            </div>
          </div>

          <button onClick={() => setExpanded(v => !v)} className="text-slate-500 hover:text-slate-300 ml-1 flex-shrink-0">
            {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </div>

        {/* Row 2: scores + bid */}
        {!isDuplicate && !isBlocked && (
          <div className="flex items-center gap-4 mt-2 flex-wrap">
            <div>
              <p className="text-[10px] text-slate-500 mb-0.5">Relevância</p>
              <ScoreBar value={suggestion.relevance_score} color="bg-cyan" />
            </div>
            <div>
              <p className="text-[10px] text-slate-500 mb-0.5">Confiança</p>
              <ScoreBar value={suggestion.confidence} color="bg-emerald-400" />
            </div>
            {!isCreated && !isCreating && (
              <div className="flex items-center gap-2 ml-auto">
                <div>
                  <p className="text-[10px] text-slate-500 mb-0.5">Bid</p>
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] text-slate-400">R$</span>
                    <input
                      type="number" step="0.01" min="0.10" max="5.00"
                      value={bid}
                      onChange={e => { setBid(e.target.value); onEditBid(suggestion, parseFloat(e.target.value) || 0.30); }}
                      className="w-14 px-1.5 py-0.5 text-[11px] bg-surface-3 border border-surface-3 rounded text-white focus:outline-none focus:border-cyan/50"
                    />
                  </div>
                </div>
                <div>
                  <p className="text-[10px] text-slate-500 mb-0.5">Orçamento/dia</p>
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] text-slate-400">R$</span>
                    <input
                      type="number" step="0.50" min="5.00"
                      value={budget}
                      onChange={e => { setBudget(e.target.value); onEditBudget(suggestion, parseFloat(e.target.value) || 5.00); }}
                      className="w-14 px-1.5 py-0.5 text-[11px] bg-surface-3 border border-surface-3 rounded text-white focus:outline-none focus:border-cyan/50"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Expandido: motivo + block reason */}
        {expanded && (
          <div className="mt-2 pt-2 border-t border-surface-3/50 space-y-1.5">
            {suggestion.reason && (
              <p className="text-[11px] text-slate-400 leading-relaxed">
                <span className="text-slate-500 font-semibold">Motivo: </span>{suggestion.reason}
              </p>
            )}
            {suggestion.block_reason && (
              <p className="text-[11px] text-amber-400">{suggestion.block_reason}</p>
            )}
            {suggestion.error && (
              <p className="text-[11px] text-red-400">{suggestion.error}</p>
            )}
            {suggestion.maximum_profitable_cpc > 0 && (
              <p className="text-[11px] text-slate-500">CPC máx. rentável: R${suggestion.maximum_profitable_cpc.toFixed(2)}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function KeywordSuggestionsPanel({ product, account, onCampaignsCreated }) {
  const [suggestions, setSuggestions] = useState(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [overrides, setOverrides] = useState({}); // id → { bid, budget }
  const [batchResult, setBatchResult] = useState(null);

  const loadSuggestions = async () => {
    if (!product?.asin || !account?.id) return;
    setLoading(true);
    setError(null);
    setSuggestions(null);
    setBatchResult(null);
    setSelected(new Set());
    try {
      const res = await base44.functions.invoke('suggestProductKeywordsWithAI', {
        amazon_account_id: account.id,
        asin: product.asin,
        product_id: product.id,
      });
      if (!res?.data?.ok) throw new Error(res?.data?.error || 'Erro ao gerar sugestões.');
      setSuggestions(res.data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const allCards = suggestions
    ? [...(suggestions.medium_tail || []), ...(suggestions.long_tail || [])]
    : [];

  const selectable = allCards.filter(s => s.status === 'suggested');

  const toggleSelect = (s) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(s.keyword)) next.delete(s.keyword);
      else next.add(s.keyword);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === selectable.length) setSelected(new Set());
    else setSelected(new Set(selectable.map(s => s.keyword)));
  };

  const editBid = (s, val) => setOverrides(o => ({ ...o, [s.keyword]: { ...o[s.keyword], bid: val } }));
  const editBudget = (s, val) => setOverrides(o => ({ ...o, [s.keyword]: { ...o[s.keyword], budget: val } }));

  const createSelected = async () => {
    if (!selected.size) return;
    setCreating(true);
    setBatchResult(null);
    try {
      // Primeiro salvar sugestões no banco e obter seus IDs
      // As sugestões já foram salvas pelo backend — buscar IDs por keyword
      const savedRes = await base44.functions.invoke('suggestProductKeywordsWithAI', {
        amazon_account_id: account.id,
        asin: product.asin,
        product_id: product.id,
      });

      // Construir lista de IDs das sugestões selecionadas
      // Buscar entidades salvas no banco
      const entitiesRes = await base44.entities.KeywordSuggestion.filter({
        amazon_account_id: account.id,
        asin: product.asin,
        status: 'suggested',
      }, '-created_at', 100);

      const selectedEntities = entitiesRes.filter(e => selected.has(e.keyword));
      // Aplicar overrides
      const suggestionIds = selectedEntities.map(e => {
        const ov = overrides[e.keyword];
        return e.id;
      });

      if (!suggestionIds.length) {
        setError('Nenhuma sugestão encontrada no banco para criar. Clique em "Sugerir palavras-chave" novamente.');
        return;
      }

      const res = await base44.functions.invoke('createManualCampaignFromKeywordSuggestion', {
        amazon_account_id: account.id,
        suggestion_ids: suggestionIds,
      });

      if (res?.data) {
        setBatchResult(res.data);
        // Atualizar status local das sugestões
        setSuggestions(prev => {
          if (!prev) return prev;
          const updateList = (list) => list.map(s => {
            const r = res.data.results?.find(r => r.keyword === s.keyword);
            if (!r) return s;
            if (r.ok) return { ...s, status: 'created' };
            if (r.already_exists) return { ...s, status: 'duplicate', already_exists: true };
            return { ...s, status: 'failed', error: r.error };
          });
          return { ...prev, medium_tail: updateList(prev.medium_tail || []), long_tail: updateList(prev.long_tail || []) };
        });
        setSelected(new Set());
        onCampaignsCreated?.();
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  };

  const hasTitle = !!(product?.product_name || product?.display_name);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-violet-400" />
          <h3 className="text-sm font-semibold text-white">Sugestões de palavras-chave com IA</h3>
        </div>
        <button
          onClick={loadSuggestions}
          disabled={loading || !hasTitle}
          title={!hasTitle ? 'Produto sem título — sincronize os títulos primeiro' : 'Gerar sugestões com IA'}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-violet-500/15 border border-violet-500/30 text-violet-400 hover:bg-violet-500/25 rounded-lg transition-colors disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          {loading ? 'Gerando...' : suggestions ? 'Atualizar sugestões' : 'Sugerir palavras-chave'}
        </button>
      </div>

      {!hasTitle && (
        <div className="flex items-start gap-2 px-3 py-2.5 bg-amber-400/10 border border-amber-400/20 rounded-xl">
          <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-amber-300">Produto sem título. Clique em "Sincronizar Títulos" antes de gerar sugestões.</p>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 px-3 py-2.5 bg-red-400/10 border border-red-400/20 rounded-xl">
          <XCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-red-300">{error}</p>
        </div>
      )}

      {loading && (
        <div className="flex flex-col items-center justify-center py-10 gap-3">
          <Loader2 className="w-8 h-8 text-violet-400 animate-spin" />
          <p className="text-sm text-slate-400">Analisando produto com IA...</p>
          <p className="text-xs text-slate-600">Consultando histórico de campanhas e search terms.</p>
        </div>
      )}

      {suggestions && !loading && (
        <>
          {/* Stats */}
          <div className="grid grid-cols-3 gap-2">
            <div className="bg-surface-2 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-white">{suggestions.new_suggestions}</p>
              <p className="text-[10px] text-slate-500">Novas</p>
            </div>
            <div className="bg-surface-2 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-amber-400">{suggestions.duplicates}</p>
              <p className="text-[10px] text-slate-500">Duplicadas</p>
            </div>
            <div className="bg-surface-2 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-cyan">{selected.size}</p>
              <p className="text-[10px] text-slate-500">Selecionadas</p>
            </div>
          </div>

          {/* Bulk actions */}
          {selectable.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={toggleAll} className="text-xs text-slate-400 hover:text-white transition-colors underline">
                {selected.size === selectable.length ? 'Desmarcar todas' : 'Selecionar todas'}
              </button>
              {selected.size > 0 && (
                <button
                  onClick={createSelected}
                  disabled={creating}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/30 rounded-lg transition-colors disabled:opacity-50 ml-auto"
                >
                  {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                  {creating ? 'Criando...' : `Criar ${selected.size} campanha(s)`}
                </button>
              )}
            </div>
          )}

          {/* Batch result */}
          {batchResult && (
            <div className="px-3 py-2.5 bg-surface-2 rounded-xl border border-surface-3 text-xs space-y-0.5">
              <p className="font-semibold text-white">Resultado da criação em lote</p>
              <p className="text-emerald-400">{batchResult.created} campanhas criadas</p>
              {batchResult.already_exists > 0 && <p className="text-amber-400">{batchResult.already_exists} já existentes</p>}
              {batchResult.failed > 0 && <p className="text-red-400">{batchResult.failed} falharam</p>}
            </div>
          )}

          {/* Cauda média */}
          {suggestions.medium_tail?.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-blue-400 mb-2 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-blue-400" />
                Cauda média ({suggestions.medium_tail.length})
              </p>
              <div className="space-y-2">
                {suggestions.medium_tail.map((s, i) => (
                  <SuggestionCard
                    key={i}
                    suggestion={s}
                    selected={selected.has(s.keyword)}
                    onToggleSelect={toggleSelect}
                    onEditBid={editBid}
                    onEditBudget={editBudget}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Cauda longa */}
          {suggestions.long_tail?.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-violet-400 mb-2 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-violet-400" />
                Cauda longa ({suggestions.long_tail.length})
              </p>
              <div className="space-y-2">
                {suggestions.long_tail.map((s, i) => (
                  <SuggestionCard
                    key={i}
                    suggestion={s}
                    selected={selected.has(s.keyword)}
                    onToggleSelect={toggleSelect}
                    onEditBid={editBid}
                    onEditBudget={editBudget}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}