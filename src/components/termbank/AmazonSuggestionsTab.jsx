import { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { Loader2, CheckCircle, XCircle, Target, Zap, ChevronDown, ChevronRight, Package, Star, Filter, PlusCircle } from 'lucide-react';

const STATUS_CONFIG = {
  suggested: { label: 'Sugerida', color: 'text-slate-400', bg: 'bg-slate-500/10' },
  ranked: { label: 'Ranqueada', color: 'text-cyan', bg: 'bg-cyan/10' },
  approved: { label: 'Aprovada', color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  queued: { label: 'Na fila', color: 'text-amber-400', bg: 'bg-amber-500/10' },
  creating: { label: 'Criando...', color: 'text-violet-400', bg: 'bg-violet-500/10' },
  created: { label: 'Criada', color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  failed: { label: 'Falha', color: 'text-red-400', bg: 'bg-red-500/10' },
  archived_by_policy: { label: 'Arquivada', color: 'text-slate-500', bg: 'bg-slate-500/5' },
  superseded: { label: 'Substituída', color: 'text-slate-500', bg: 'bg-slate-500/5' }
};

const RISK_CONFIG = {
  low: { label: 'Baixo', color: 'text-emerald-400' },
  medium: { label: 'Médio', color: 'text-amber-400' },
  high: { label: 'Alto', color: 'text-red-400' }
};

const fmtBrl = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);

// Score composto: IA rank + confiança + relevância Amazon + bid sugerido + prioridade
function getScore(s) {
  let score = 0;
  // IA rank (menor número = melhor) — peso alto
  if (s.ai_rank) score += Math.max(0, 20 - s.ai_rank) * 50;
  // Confiança IA (0-1 ou 0-100)
  const conf = s.ai_confidence != null ?
  s.ai_confidence <= 1 ? s.ai_confidence : s.ai_confidence / 100 :
  0;
  score += conf * 300;
  // Relevância Amazon (0-1)
  if (s.amazon_relevance_score) score += s.amazon_relevance_score * 200;
  // should_create_campaign = sinal forte
  if (s.should_create_campaign) score += 150;
  // Prioridade de implementação
  if (s.implementation_priority === 'immediate') score += 100;else
  if (s.implementation_priority === 'next_window') score += 50;
  // Bid sugerido como proxy de competitividade
  if (s.amazon_suggested_bid) score += Math.min(s.amazon_suggested_bid * 20, 100);
  // Estimativas Amazon
  if (s.amazon_impression_estimate) score += Math.min(s.amazon_impression_estimate / 1000, 50);
  if (s.amazon_order_estimate) score += Math.min(s.amazon_order_estimate * 10, 100);
  // Risco baixo = bônus
  if (s.risk_level === 'low') score += 30;else
  if (s.risk_level === 'high') score -= 50;
  return score;
}

// Classifica o score em tier visual
function getScoreTier(score) {
  if (score >= 500) return { label: 'Alta', color: 'text-emerald-400', bg: 'bg-emerald-500/15 border-emerald-500/25', dot: 'bg-emerald-400' };
  if (score >= 250) return { label: 'Média', color: 'text-amber-400', bg: 'bg-amber-500/15 border-amber-500/25', dot: 'bg-amber-400' };
  if (score >= 100) return { label: 'Baixa', color: 'text-slate-400', bg: 'bg-slate-500/10 border-slate-500/20', dot: 'bg-slate-500' };
  return { label: '—', color: 'text-slate-600', bg: 'bg-transparent border-transparent', dot: 'bg-slate-700' };
}

const VIEW_FILTERS = [
{ key: 'all', label: 'Todas' },
{ key: 'ranked', label: 'Ranqueadas' },
{ key: 'ready', label: '⚡ Prontas p/ campanha' },
{ key: 'created', label: '✓ Criadas' }];


function ProductGroup({ asin, product, suggestions, onReject, onCreateCampaign, workingId, creatingId, viewFilter }) {
  const [open, setOpen] = useState(true);
  const prodName = product?.product_name || product?.display_name || 'Produto';
  const imgUrl = product?.product_image_url;

  const filtered = useMemo(() => {
    let list = suggestions;
    if (viewFilter === 'ranked') list = list.filter((s) => s.ai_rank);else
    if (viewFilter === 'ready') list = list.filter((s) => s.should_create_campaign && (s.ai_confidence || 0) >= 0.90);else
    if (viewFilter === 'created') list = list.filter((s) => s.status === 'created');
    return list;
  }, [suggestions, viewFilter]);

  const created = suggestions.filter((s) => s.status === 'created').length;
  const ready = suggestions.filter((s) => s.should_create_campaign && (s.ai_confidence || 0) >= 0.90).length;
  const ranked = suggestions.filter((s) => s.ai_rank).length;
  const topScore = suggestions[0] ? getScore(suggestions[0]) : 0;
  const topTier = getScoreTier(topScore);

  if (filtered.length === 0 && viewFilter !== 'all') return null;

  return (
    <div className="rounded-xl border border-surface-2 bg-surface-1 overflow-hidden">
      {/* Header do grupo */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-surface-2/40 transition-colors text-left">
        
        {open ? <ChevronDown className="w-4 h-4 text-slate-500 flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-slate-500 flex-shrink-0" />}
        {imgUrl ?
        <img src={imgUrl} alt="" className="w-9 h-9 rounded object-cover bg-surface-3 flex-shrink-0" /> :
        <div className="w-9 h-9 rounded bg-surface-3 flex items-center justify-center flex-shrink-0"><Package className="w-4 h-4 text-slate-600" /></div>
        }
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white truncate">{prodName}</p>
          <p className="text-xs font-mono text-cyan">{asin}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
          {/* Tier do melhor termo */}
          <span className={`flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full border ${topTier.bg} ${topTier.color}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${topTier.dot}`} />
            Relevância {topTier.label}
          </span>
          <span className="text-xs text-slate-400">{suggestions.length} sugestões</span>
          {ranked > 0 && <span className="px-2 py-0.5 bg-violet-500/15 border border-violet-500/25 text-violet-400 rounded-full text-[10px]">{ranked} ranq.</span>}
          {ready > 0 && <span className="px-2 py-0.5 bg-amber-500/15 border border-amber-500/25 text-amber-400 rounded-full text-[10px]">⚡ {ready} prontas</span>}
          {created > 0 && <span className="px-2 py-0.5 bg-emerald-500/15 border border-emerald-500/25 text-emerald-400 rounded-full text-[10px]">✓ {created}</span>}
        </div>
      </button>

      {open &&
      <div className="overflow-x-auto border-t border-surface-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-2 bg-surface-2/40">
                {['#', 'Keyword', 'Match', 'Relevância', 'Bid Amazon', 'Score IA', 'Risco', 'Prioridade', 'Status', ''].map((h) =>
              <th key={h} className="px-3 py-2.5 text-left text-[10px] uppercase text-slate-500 whitespace-nowrap">{h}</th>
              )}
              </tr>
            </thead>
            <tbody>
              {filtered.map((s, idx) => {
              const statusCfg = STATUS_CONFIG[s.status] || STATUS_CONFIG.suggested;
              const riskCfg = RISK_CONFIG[s.risk_level] || RISK_CONFIG.medium;
              const conf = s.ai_confidence != null ?
              Math.round(s.ai_confidence <= 1 ? s.ai_confidence * 100 : s.ai_confidence) :
              null;
              const score = getScore(s);
              const tier = getScoreTier(score);
              const isWorking = workingId === s.id;
              const isCreating = creatingId === s.id;
              const isReady = s.should_create_campaign && conf != null && conf >= 90;
              const canCreate = !['created', 'archived_by_policy', 'superseded', 'creating'].includes(s.status);

              return (
                <tr key={s.id} className={`border-b border-surface-2/30 transition-colors ${isReady ? 'bg-emerald-500/3 hover:bg-emerald-500/6' : 'hover:bg-surface-2/20'}`}>
                    <td className="px-3 py-2.5 text-[10px] text-slate-600 font-mono w-8">{idx + 1}</td>
                    <td className="px-3 py-2.5 max-w-[200px]">
                      <p className={`font-semibold truncate ${isReady ? 'text-emerald-300' : 'text-white'}`}>{s.keyword}</p>
                      {s.ai_reason && <p className="text-[10px] text-slate-500 truncate mt-0.5 max-w-[180px]">{s.ai_reason}</p>}
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      <span className="px-1.5 py-0.5 bg-surface-3 text-slate-300 rounded text-[10px] font-mono">{(s.match_type || '').toUpperCase()}</span>
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      {s.amazon_relevance_score > 0 ?
                    <span className="font-mono font-bold text-amber-400">{s.amazon_relevance_score.toFixed(2)}</span> :
                    <span className="text-slate-600">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-300 whitespace-nowrap">
                      {s.amazon_suggested_bid ? fmtBrl(s.amazon_suggested_bid) : '—'}
                      {s.amazon_suggested_bid_min && s.amazon_suggested_bid_max &&
                    <p className="text-[9px] text-slate-600">{fmtBrl(s.amazon_suggested_bid_min)} – {fmtBrl(s.amazon_suggested_bid_max)}</p>
                    }
                    </td>
                    <td className="px-3 py-2.5 text-xs whitespace-nowrap">
                      {s.ai_rank ?
                    <div className="flex items-center gap-1.5">
                          <span className="font-bold text-violet-400">#{s.ai_rank}</span>
                          {conf != null &&
                      <span className={`text-[10px] font-semibold ${conf >= 90 ? 'text-emerald-400' : conf >= 70 ? 'text-amber-400' : 'text-slate-500'}`}>
                              {conf}%
                            </span>
                      }
                        </div> :

                    <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border ${tier.bg} ${tier.color}`}>
                          <span className={`w-1 h-1 rounded-full ${tier.dot}`} />
                          {Math.round(score)}
                        </span>
                    }
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      {s.risk_level ?
                    <span className={riskCfg.color}>{riskCfg.label}</span> :
                    <span className="text-slate-600">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      {s.implementation_priority === 'immediate' ?
                    <span className="text-emerald-400 font-semibold">Imediata</span> :
                    s.implementation_priority === 'next_window' ?
                    <span className="text-amber-400">Próx. janela</span> :
                    <span className="text-slate-600">—</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${statusCfg.bg} ${statusCfg.color}`}>
                        {statusCfg.label}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1">
                        {/* Botão Criar Campanha */}
                        {canCreate && (
                          <button
                            onClick={() => onCreateCampaign(s)}
                            disabled={isCreating || isWorking}
                            className="flex items-center gap-1 rounded px-2 py-1 text-[10px] font-semibold bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25 transition-colors disabled:opacity-50 whitespace-nowrap"
                            title="Criar campanha (bid R$0,50 · gerida pelo app)">
                            {isCreating ? <Loader2 className="h-3 w-3 animate-spin" /> : <PlusCircle className="h-3 w-3" />}
                            {isCreating ? 'Criando...' : 'Criar campanha'}
                          </button>
                        )}
                        {/* Botão Rejeitar */}
                        {!['created', 'archived_by_policy', 'superseded'].includes(s.status) && (
                          <button
                            onClick={() => onReject(s)}
                            disabled={isWorking || isCreating}
                            className="rounded p-1 text-slate-600 hover:text-red-400 transition-colors disabled:opacity-50"
                            title="Rejeitar">
                            {isWorking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
                          </button>
                        )}
                        {s.status === 'created' && s.amazon_campaign_id && (
                          <span className="text-emerald-400 text-[10px] font-mono">✓ {s.amazon_campaign_id.slice(-8)}</span>
                        )}
                      </div>
                    </td>
                  </tr>);

            })}
            </tbody>
          </table>
        </div>
      }
    </div>);

}

export default function AmazonSuggestionsTab({ suggestions, products, account, onRefresh }) {
  const [workingId, setWorkingId] = useState(null);
  const [creatingId, setCreatingId] = useState(null);
  const [message, setMessage] = useState(null);
  const [competitorAsin, setCompetitorAsin] = useState('');
  const [selectedAsin, setSelectedAsin] = useState('');
  const [fetching, setFetching] = useState(false);
  const [ranking, setRanking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [viewFilter, setViewFilter] = useState('all');
  const [sortGroupsBy, setSortGroupsBy] = useState('relevance'); // 'relevance' | 'count' | 'ready'

  const productMap = Object.fromEntries(products.map((p) => [p.asin, p]));

  const activeSuggestions = useMemo(() => suggestions.filter((s) =>
  ['AMAZON_ADS_SUGGESTED_KEYWORD', 'AMAZON_ADS_SUGGESTED_TARGET', 'AMAZON_ADS_RECOMMENDATION'].includes(s.source) &&
  !['archived_by_policy', 'superseded'].includes(s.status)
  ), [suggestions]);

  // Agrupar por ASIN e ordenar cada grupo por score desc
  const { grouped, sortedAsins } = useMemo(() => {
    const grouped = {};
    for (const s of activeSuggestions) {
      if (!grouped[s.asin]) grouped[s.asin] = [];
      grouped[s.asin].push(s);
    }
    // Ordenar cada grupo por score desc
    for (const asin of Object.keys(grouped)) {
      grouped[asin].sort((a, b) => getScore(b) - getScore(a));
    }
    // Ordenar grupos conforme critério escolhido
    const sortedAsins = Object.keys(grouped).sort((a, b) => {
      if (sortGroupsBy === 'count') return grouped[b].length - grouped[a].length;
      if (sortGroupsBy === 'ready') {
        const readyA = grouped[a].filter((s) => s.should_create_campaign && (s.ai_confidence || 0) >= 0.90).length;
        const readyB = grouped[b].filter((s) => s.should_create_campaign && (s.ai_confidence || 0) >= 0.90).length;
        return readyB - readyA;
      }
      // 'relevance': pelo score máximo do primeiro item (já ordenado)
      return getScore(grouped[b][0]) - getScore(grouped[a][0]);
    });
    return { grouped, sortedAsins };
  }, [activeSuggestions, sortGroupsBy]);

  const ranked = activeSuggestions.filter((s) => s.ai_rank);
  const eligible = ranked.filter((s) => s.should_create_campaign && (s.ai_confidence || 0) >= 0.90);

  const handleFetchSuggestions = async () => {
    if (!account || !selectedAsin) {setMessage({ type: 'error', text: 'Selecione um produto primeiro.' });return;}
    setFetching(true);setMessage(null);
    try {
      const res = await base44.functions.invoke('syncAmazonKeywordSuggestionsByAsin', {
        amazon_account_id: account.id, asin: selectedAsin,
        competitor_asins: competitorAsin ? [competitorAsin.trim()] : [],
        max_suggestions_per_asin: 50, match_types: ['EXACT', 'PHRASE', 'BROAD']
      });
      const d = res?.data;
      if (d?.ok) {
        setMessage({ type: d.total_created > 0 ? 'success' : 'info', text: `✓ ${d.total_created} novas sugestões · ${d.total_skipped} já existiam` });
        onRefresh();
      } else {
        setMessage({ type: 'error', text: d?.error || 'Erro ao buscar sugestões' });
      }
    } catch (e) {
      if (!e.message?.includes('App not found')) setMessage({ type: 'error', text: e.message });
    } finally {setFetching(false);}
  };

  const handleRank = async () => {
    if (!account || !selectedAsin) {setMessage({ type: 'error', text: 'Selecione um produto primeiro.' });return;}
    setRanking(true);setMessage(null);
    try {
      const res = await base44.functions.invoke('rankAmazonKeywordSuggestions', {
        amazon_account_id: account.id, asin: selectedAsin, max_results: 10
      });
      const d = res?.data;
      if (d?.ok) {
        setMessage({ type: 'success', text: `✓ IA ranqueou ${d.ranked} sugestões. ${d.should_create_count} prontas para criar campanha.` });
        onRefresh();
      } else {
        setMessage({ type: 'error', text: d?.message || d?.error || 'Erro ao ranquear' });
      }
    } catch (e) {setMessage({ type: 'error', text: e.message });} finally
    {setRanking(false);}
  };

  const handleCreateCampaigns = async () => {
    if (!account || !selectedAsin) {setMessage({ type: 'error', text: 'Selecione um produto primeiro.' });return;}
    setCreating(true);setMessage(null);
    try {
      const res = await base44.functions.invoke('createExactCampaignsFromAmazonSuggestions', {
        amazon_account_id: account.id, asin: selectedAsin, limit: 4, execute_now_if_window: true
      });
      const d = res?.data;
      if (d?.scheduled) {
        setMessage({ type: 'info', text: `⏰ Fora da janela Amazon. Agendado para ${new Date(d.next_window).toLocaleString('pt-BR')}.` });
      } else if (d?.ok) {
        setMessage({ type: 'success', text: `✓ ${d.created} campanha(s) EXACT criada(s).` });
        onRefresh();
      } else {
        setMessage({ type: 'error', text: d?.error || 'Erro ao criar campanhas' });
      }
    } catch (e) {setMessage({ type: 'error', text: e.message });} finally
    {setCreating(false);}
  };

  const handleReject = async (s) => {
    setWorkingId(s.id);
    try {
      await base44.entities.KeywordSuggestion.update(s.id, { status: 'rejected' });
      onRefresh();
    } catch (e) {setMessage({ type: 'error', text: e.message });} finally
    {setWorkingId(null);}
  };

  const handleCreateCampaign = async (s) => {
    if (!account) return;
    setCreatingId(s.id);
    setMessage(null);
    try {
      // Agendar para próxima janela (03:00-06:00 BRT) via createExactCampaignsFromAmazonSuggestions
      // com bid inicial fixo de R$0,50 — gerido pelo motor após criação
      const res = await base44.functions.invoke('createManualCampaignFromKeywordSuggestion', {
        amazon_account_id: account.id,
        suggestion_ids: [s.id],
        overrides: { [s.id]: { bid: 0.50, budget: 15.00 } },
      });
      const d = res?.data;
      if (d?.ok) {
        const created = d.results?.find(r => r.id === s.id);
        if (created?.ok) {
          setMessage({ type: 'success', text: `✓ Campanha "${created.campaign_name}" criada · bid R$0,50 · gerida pelo app.` });
        } else {
          setMessage({ type: 'error', text: created?.error || 'Erro ao criar campanha.' });
        }
        onRefresh();
      } else {
        setMessage({ type: 'error', text: d?.error || 'Erro ao criar campanha.' });
      }
    } catch (e) {
      setMessage({ type: 'error', text: e.message });
    } finally {
      setCreatingId(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* Controles */}
      <div className="rounded-xl border border-surface-2 bg-surface-1 p-4 space-y-3">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex flex-col gap-1 min-w-[200px]">
            <label className="text-xs text-slate-500">Produto (ASIN)</label>
            <select value={selectedAsin} onChange={(e) => setSelectedAsin(e.target.value)}
            className="rounded-lg border border-surface-2 bg-surface-2 px-3 py-2 text-sm text-white">
              <option value="">Selecionar produto...</option>
              {products.map((p) =>
              <option key={p.id} value={p.asin}>{p.asin} — {(p.product_name || p.display_name || '').slice(0, 40)}</option>
              )}
            </select>
          </div>
          <div className="flex flex-col gap-1 min-w-[180px]">
            <label className="text-xs text-slate-500">ASIN concorrente (opcional)</label>
            <input value={competitorAsin} onChange={(e) => setCompetitorAsin(e.target.value)}
            placeholder="Ex: B08XXXXXXXXXXX"
            className="rounded-lg border border-surface-2 bg-surface-2 px-3 py-2 text-sm text-white placeholder-slate-600" />
          </div>
          <button onClick={handleFetchSuggestions} disabled={fetching || !selectedAsin}
          className="flex items-center gap-2 rounded-lg bg-cyan/15 border border-cyan/30 px-4 py-2 text-sm font-semibold text-cyan hover:bg-cyan/25 transition-colors disabled:opacity-50">
            {fetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Target className="h-4 w-4" />}
            {fetching ? 'Buscando...' : 'Buscar sugestões Amazon Ads'}
          </button>
          <button onClick={handleRank} disabled={ranking || !selectedAsin}
          className="flex items-center gap-2 rounded-lg bg-violet-500/15 border border-violet-500/30 px-4 py-2 text-sm font-semibold text-violet-300 hover:bg-violet-500/25 transition-colors disabled:opacity-50">
            {ranking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
            {ranking ? 'Ranqueando...' : 'IA rankear'}
          </button>
          {eligible.length > 0 &&
          <button onClick={handleCreateCampaigns} disabled={creating || !selectedAsin}
          className="flex items-center gap-2 rounded-lg bg-emerald-500/15 border border-emerald-500/30 px-4 py-2 text-sm font-semibold text-emerald-300 hover:bg-emerald-500/25 transition-colors disabled:opacity-50 hidden">
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
              {creating ? 'Criando...' : `Criar ${Math.min(4, eligible.length)} campanha(s) EXACT`}
            </button>
          }
        </div>
        <p className="text-xs text-slate-500">A IA apenas rankeia sugestões oficiais da Amazon. Apenas confiança ≥ 90% e risco baixo/médio geram campanhas.</p>
      </div>

      {message &&
      <div className={`rounded-lg p-3 text-sm ${message.type === 'success' ? 'bg-emerald-400/10 text-emerald-300' : message.type === 'info' ? 'bg-cyan/10 text-cyan' : 'bg-red-400/10 text-red-300'}`}>
          {message.text}
        </div>
      }

      {/* Resumo */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
        { label: 'Sugestões Amazon', value: activeSuggestions.length, color: 'text-cyan' },
        { label: 'Produtos com sugestões', value: sortedAsins.length, color: 'text-violet-400' },
        { label: 'Ranqueadas por IA', value: ranked.length, color: 'text-amber-400' },
        { label: '⚡ Prontas p/ campanha', value: eligible.length, color: 'text-emerald-400' }].
        map(({ label, value, color }) =>
        <div key={label} className="rounded-xl border border-surface-2 bg-surface-1 p-3 text-center">
            <p className={`text-xl font-bold ${color}`}>{value}</p>
            <p className="text-xs text-slate-500 mt-1">{label}</p>
          </div>
        )}
      </div>

      {/* Filtros e ordenação */}
      {sortedAsins.length > 0 &&
      <div className="flex items-center justify-between flex-wrap gap-3">
          {/* Filtro por status */}
          <div className="flex items-center gap-1 bg-surface-2 border border-surface-3 rounded-lg p-0.5">
            {VIEW_FILTERS.map((f) =>
          <button key={f.key} onClick={() => setViewFilter(f.key)}
          className={`px-3 py-1.5 rounded text-xs font-medium transition-all ${viewFilter === f.key ? 'bg-cyan text-white' : 'text-slate-400 hover:text-slate-200'}`}>
                {f.label}
              </button>
          )}
          </div>
          {/* Ordenação dos grupos */}
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Filter className="w-3.5 h-3.5" />
            <span>Ordenar grupos por:</span>
            {[
          { key: 'relevance', label: 'Relevância' },
          { key: 'ready', label: '⚡ Prontas' },
          { key: 'count', label: 'Qtd.' }].
          map((o) =>
          <button key={o.key} onClick={() => setSortGroupsBy(o.key)}
          className={`px-2.5 py-1 rounded border transition-colors ${sortGroupsBy === o.key ? 'bg-cyan/15 border-cyan/30 text-cyan' : 'border-surface-3 text-slate-400 hover:text-slate-200'}`}>
                {o.label}
              </button>
          )}
          </div>
        </div>
      }

      {/* Grupos por produto */}
      {sortedAsins.length === 0 ?
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <Target className="h-10 w-10 text-slate-600" />
          <p className="text-sm text-slate-400">Nenhuma sugestão Amazon Ads ainda.</p>
          <p className="text-xs text-slate-600">Selecione um produto e clique em "Buscar sugestões Amazon Ads".</p>
        </div> :

      <div className="space-y-3">
          {sortedAsins.map((asin) =>
        <ProductGroup
          key={asin}
          asin={asin}
          product={productMap[asin]}
          suggestions={grouped[asin]}
          onReject={handleReject}
          onCreateCampaign={handleCreateCampaign}
          workingId={workingId}
          creatingId={creatingId}
          viewFilter={viewFilter} />

        )}
        </div>
      }
    </div>);

}