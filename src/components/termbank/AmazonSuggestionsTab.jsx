import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Loader2, CheckCircle, XCircle, Target, Zap, ChevronDown, ChevronRight, Package } from 'lucide-react';

const STATUS_CONFIG = {
  suggested:          { label: 'Sugerida',    color: 'text-slate-400',   bg: 'bg-slate-500/10' },
  ranked:             { label: 'Ranqueada',   color: 'text-cyan',        bg: 'bg-cyan/10' },
  approved:           { label: 'Aprovada',    color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  queued:             { label: 'Na fila',     color: 'text-amber-400',   bg: 'bg-amber-500/10' },
  creating:           { label: 'Criando...', color: 'text-violet-400',  bg: 'bg-violet-500/10' },
  created:            { label: 'Criada',      color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  failed:             { label: 'Falha',       color: 'text-red-400',     bg: 'bg-red-500/10' },
  archived_by_policy: { label: 'Arquivada',  color: 'text-slate-500',   bg: 'bg-slate-500/5' },
  superseded:         { label: 'Substituída', color: 'text-slate-500',   bg: 'bg-slate-500/5' },
};

const RISK_CONFIG = {
  low:    { label: 'Baixo', color: 'text-emerald-400' },
  medium: { label: 'Médio', color: 'text-amber-400' },
  high:   { label: 'Alto',  color: 'text-red-400' },
};

const fmtBrl = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);

// Score de ordenação: ai_rank (menor = melhor), amazon_relevance_score, amazon_suggested_bid
function getScore(s) {
  if (s.ai_rank) return 10000 - s.ai_rank * 100 + (s.ai_confidence || 0) * 100;
  if (s.amazon_relevance_score) return s.amazon_relevance_score;
  if (s.amazon_suggested_bid) return s.amazon_suggested_bid * 10;
  return 0;
}

function ProductGroup({ asin, product, suggestions, onReject, workingId }) {
  const [open, setOpen] = useState(true);
  const prodName = product?.product_name || product?.display_name || 'Produto';
  const imgUrl = product?.product_image_url;
  const created = suggestions.filter(s => s.status === 'created').length;
  const ranked = suggestions.filter(s => s.ai_rank).length;

  return (
    <div className="rounded-xl border border-surface-2 bg-surface-1 overflow-hidden">
      {/* Header do grupo */}
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-surface-2/40 transition-colors text-left"
      >
        {open ? <ChevronDown className="w-4 h-4 text-slate-500 flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-slate-500 flex-shrink-0" />}
        {imgUrl
          ? <img src={imgUrl} alt="" className="w-9 h-9 rounded object-cover bg-surface-3 flex-shrink-0" />
          : <div className="w-9 h-9 rounded bg-surface-3 flex items-center justify-center flex-shrink-0"><Package className="w-4 h-4 text-slate-600" /></div>
        }
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white truncate">{prodName}</p>
          <p className="text-xs font-mono text-cyan">{asin}</p>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0 text-xs">
          <span className="text-slate-400">{suggestions.length} sugestões</span>
          {ranked > 0 && <span className="px-2 py-0.5 bg-violet-500/15 border border-violet-500/25 text-violet-400 rounded-full">{ranked} ranqueadas</span>}
          {created > 0 && <span className="px-2 py-0.5 bg-emerald-500/15 border border-emerald-500/25 text-emerald-400 rounded-full">{created} criadas</span>}
        </div>
      </button>

      {open && (
        <div className="overflow-x-auto border-t border-surface-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-2 bg-surface-2/40">
                {['#', 'Keyword', 'Match', 'Bid Amazon', 'Score / IA', 'Relevância', 'Risco', 'Motivo IA', 'Status', ''].map(h => (
                  <th key={h} className="px-3 py-2.5 text-left text-[10px] uppercase text-slate-500 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {suggestions.map((s, idx) => {
                const statusCfg = STATUS_CONFIG[s.status] || STATUS_CONFIG.suggested;
                const riskCfg = RISK_CONFIG[s.risk_level] || RISK_CONFIG.medium;
                const conf = s.ai_confidence != null
                  ? Math.round(s.ai_confidence <= 1 ? s.ai_confidence * 100 : s.ai_confidence)
                  : null;
                const isWorking = workingId === s.id;
                return (
                  <tr key={s.id} className="border-b border-surface-2/30 hover:bg-surface-2/20 transition-colors">
                    <td className="px-3 py-2.5 text-[10px] text-slate-600 font-mono w-8">{idx + 1}</td>
                    <td className="px-3 py-2.5 font-semibold text-white whitespace-nowrap max-w-[220px] truncate">{s.keyword}</td>
                    <td className="px-3 py-2.5 text-xs">
                      <span className="px-1.5 py-0.5 bg-surface-3 text-slate-300 rounded text-[10px] font-mono">{(s.match_type || '').toUpperCase()}</span>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-300 whitespace-nowrap">
                      {s.amazon_suggested_bid ? fmtBrl(s.amazon_suggested_bid) : '—'}
                      {s.amazon_suggested_bid_min && s.amazon_suggested_bid_max && (
                        <p className="text-[9px] text-slate-600">{fmtBrl(s.amazon_suggested_bid_min)} – {fmtBrl(s.amazon_suggested_bid_max)}</p>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs whitespace-nowrap">
                      {s.ai_rank ? (
                        <div className="flex items-center gap-1">
                          <span className="font-bold text-violet-400">#{s.ai_rank}</span>
                          {conf != null && (
                            <span className={conf >= 90 ? 'text-emerald-400' : conf >= 70 ? 'text-amber-400' : 'text-slate-500'}>
                              {conf}%
                            </span>
                          )}
                        </div>
                      ) : <span className="text-slate-600 text-[10px]">não ranqueada</span>}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-400">
                      {s.amazon_relevance_score > 0
                        ? <span className="font-mono text-amber-400">{s.amazon_relevance_score.toFixed(2)}</span>
                        : <span className="text-slate-600">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      {s.risk_level
                        ? <span className={riskCfg.color}>{riskCfg.label}</span>
                        : <span className="text-slate-600">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-400 max-w-[180px]">
                      <span className="line-clamp-2">{s.ai_reason || '—'}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${statusCfg.bg} ${statusCfg.color}`}>
                        {statusCfg.label}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      {!['created', 'archived_by_policy', 'superseded'].includes(s.status) && (
                        <button
                          onClick={() => onReject(s)}
                          disabled={isWorking}
                          className="rounded p-1 text-slate-600 hover:text-red-400 transition-colors disabled:opacity-50"
                          title="Rejeitar"
                        >
                          {isWorking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
                        </button>
                      )}
                      {s.status === 'created' && s.amazon_campaign_id && (
                        <span className="text-emerald-400 text-[10px] font-mono">✓ {s.amazon_campaign_id.slice(-8)}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function AmazonSuggestionsTab({ suggestions, products, account, onRefresh }) {
  const [workingId, setWorkingId] = useState(null);
  const [message, setMessage] = useState(null);
  const [competitorAsin, setCompetitorAsin] = useState('');
  const [selectedAsin, setSelectedAsin] = useState('');
  const [fetching, setFetching] = useState(false);
  const [ranking, setRanking] = useState(false);
  const [creating, setCreating] = useState(false);

  const productMap = Object.fromEntries(products.map(p => [p.asin, p]));

  const activeSuggestions = suggestions.filter(s =>
    ['AMAZON_ADS_SUGGESTED_KEYWORD', 'AMAZON_ADS_SUGGESTED_TARGET', 'AMAZON_ADS_RECOMMENDATION'].includes(s.source) &&
    !['archived_by_policy', 'superseded'].includes(s.status)
  );

  // Agrupar por ASIN e ordenar cada grupo por score desc
  const grouped = {};
  for (const s of activeSuggestions) {
    if (!grouped[s.asin]) grouped[s.asin] = [];
    grouped[s.asin].push(s);
  }
  // Ordenar cada grupo por score desc
  for (const asin of Object.keys(grouped)) {
    grouped[asin].sort((a, b) => getScore(b) - getScore(a));
  }
  // Ordenar grupos pelo total de sugestões desc
  const sortedAsins = Object.keys(grouped).sort((a, b) => grouped[b].length - grouped[a].length);

  const ranked = activeSuggestions.filter(s => s.ai_rank);
  const eligible = ranked.filter(s => s.should_create_campaign && (s.ai_confidence || 0) >= 0.90);

  const handleFetchSuggestions = async () => {
    if (!account || !selectedAsin) { setMessage({ type: 'error', text: 'Selecione um produto primeiro.' }); return; }
    setFetching(true); setMessage(null);
    try {
      const res = await base44.functions.invoke('syncAmazonKeywordSuggestionsByAsin', {
        amazon_account_id: account.id, asin: selectedAsin,
        competitor_asins: competitorAsin ? [competitorAsin.trim()] : [],
        max_suggestions_per_asin: 50, match_types: ['EXACT', 'PHRASE', 'BROAD'],
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
    } finally { setFetching(false); }
  };

  const handleRank = async () => {
    if (!account || !selectedAsin) { setMessage({ type: 'error', text: 'Selecione um produto primeiro.' }); return; }
    setRanking(true); setMessage(null);
    try {
      const res = await base44.functions.invoke('rankAmazonKeywordSuggestions', {
        amazon_account_id: account.id, asin: selectedAsin, max_results: 10,
      });
      const d = res?.data;
      if (d?.ok) {
        setMessage({ type: 'success', text: `✓ IA ranqueou ${d.ranked} sugestões. ${d.should_create_count} prontas para criar campanha.` });
        onRefresh();
      } else {
        setMessage({ type: 'error', text: d?.message || d?.error || 'Erro ao ranquear' });
      }
    } catch (e) { setMessage({ type: 'error', text: e.message }); }
    finally { setRanking(false); }
  };

  const handleCreateCampaigns = async () => {
    if (!account || !selectedAsin) { setMessage({ type: 'error', text: 'Selecione um produto primeiro.' }); return; }
    setCreating(true); setMessage(null);
    try {
      const res = await base44.functions.invoke('createExactCampaignsFromAmazonSuggestions', {
        amazon_account_id: account.id, asin: selectedAsin, limit: 4, execute_now_if_window: true,
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
    } catch (e) { setMessage({ type: 'error', text: e.message }); }
    finally { setCreating(false); }
  };

  const handleReject = async (s) => {
    setWorkingId(s.id);
    try {
      await base44.entities.KeywordSuggestion.update(s.id, { status: 'rejected' });
      onRefresh();
    } catch (e) { setMessage({ type: 'error', text: e.message }); }
    finally { setWorkingId(null); }
  };

  return (
    <div className="space-y-4">
      {/* Controles */}
      <div className="rounded-xl border border-surface-2 bg-surface-1 p-4 space-y-3">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex flex-col gap-1 min-w-[200px]">
            <label className="text-xs text-slate-500">Produto (ASIN)</label>
            <select value={selectedAsin} onChange={e => setSelectedAsin(e.target.value)}
              className="rounded-lg border border-surface-2 bg-surface-2 px-3 py-2 text-sm text-white">
              <option value="">Selecionar produto...</option>
              {products.map(p => (
                <option key={p.id} value={p.asin}>{p.asin} — {(p.product_name || p.display_name || '').slice(0, 40)}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1 min-w-[180px]">
            <label className="text-xs text-slate-500">ASIN concorrente (opcional)</label>
            <input value={competitorAsin} onChange={e => setCompetitorAsin(e.target.value)}
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
          {eligible.length > 0 && (
            <button onClick={handleCreateCampaigns} disabled={creating || !selectedAsin}
              className="flex items-center gap-2 rounded-lg bg-emerald-500/15 border border-emerald-500/30 px-4 py-2 text-sm font-semibold text-emerald-300 hover:bg-emerald-500/25 transition-colors disabled:opacity-50">
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
              {creating ? 'Criando...' : `Criar ${Math.min(4, eligible.length)} campanha(s) EXACT`}
            </button>
          )}
        </div>
        <p className="text-xs text-slate-500">A IA apenas rankeia sugestões oficiais da Amazon. Apenas confiança ≥ 90% e risco baixo/médio geram campanhas.</p>
      </div>

      {message && (
        <div className={`rounded-lg p-3 text-sm ${message.type === 'success' ? 'bg-emerald-400/10 text-emerald-300' : message.type === 'info' ? 'bg-cyan/10 text-cyan' : 'bg-red-400/10 text-red-300'}`}>
          {message.text}
        </div>
      )}

      {/* Resumo */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Sugestões Amazon', value: activeSuggestions.length, color: 'text-cyan' },
          { label: 'Produtos com sugestões', value: sortedAsins.length, color: 'text-violet-400' },
          { label: 'Ranqueadas por IA', value: ranked.length, color: 'text-amber-400' },
          { label: 'Criadas', value: activeSuggestions.filter(s => s.status === 'created').length, color: 'text-emerald-400' },
        ].map(({ label, value, color }) => (
          <div key={label} className="rounded-xl border border-surface-2 bg-surface-1 p-3 text-center">
            <p className={`text-xl font-bold ${color}`}>{value}</p>
            <p className="text-xs text-slate-500 mt-1">{label}</p>
          </div>
        ))}
      </div>

      {/* Grupos por produto */}
      {sortedAsins.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <Target className="h-10 w-10 text-slate-600" />
          <p className="text-sm text-slate-400">Nenhuma sugestão Amazon Ads ainda.</p>
          <p className="text-xs text-slate-600">Selecione um produto e clique em "Buscar sugestões Amazon Ads".</p>
        </div>
      ) : (
        <div className="space-y-3">
          {sortedAsins.map(asin => (
            <ProductGroup
              key={asin}
              asin={asin}
              product={productMap[asin]}
              suggestions={grouped[asin]}
              onReject={handleReject}
              workingId={workingId}
            />
          ))}
        </div>
      )}
    </div>
  );
}