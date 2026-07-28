import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import {
  X, Loader2, Sparkles, CheckCircle, AlertCircle, ChevronDown, ChevronRight,
  Plus, ArrowRight, Info
} from 'lucide-react';

function fmtBRL(v) {
  return `R$${Number(v || 0).toFixed(2)}`;
}

function ProposalRow({ p, expanded, onToggle }) {
  const isNew = p.status === 'new' || p.status === 'proposed';
  const isExisting = p.status === 'already_proposed';
  const actionColor = p.action === 'campaign_create' ? 'text-emerald-400' : 'text-cyan';
  const actionBg = p.action === 'campaign_create' ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-cyan/10 border-cyan/20';

  return (
    <div className={`border rounded-xl overflow-hidden ${isExisting ? 'border-surface-2 opacity-60' : 'border-surface-2'}`}>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 bg-surface-1 hover:bg-surface-2/50 transition-colors text-left"
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm font-bold text-cyan">{p.asin}</span>
            {isExisting && <span className="text-[10px] px-2 py-0.5 bg-slate-500/15 border border-slate-500/20 text-slate-400 rounded-full">já proposta hoje</span>}
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-[10px] text-slate-500 flex-wrap">
            <span className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${actionBg} ${actionColor}`}>
              {p.action === 'campaign_create' ? '+ Nova campanha' : '+ Keywords em existente'}
            </span>
            <span>{p.keywords_count} keywords</span>
            <span>Bid médio: {fmtBRL(p.avg_bid)}</span>
            <span>Budget sugerido: {fmtBRL(p.suggested_budget)}/dia</span>
          </div>
        </div>
        {p.status === 'proposed' && <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0" />}
      </button>

      {expanded && (
        <div className="border-t border-surface-2 bg-surface-1/50 p-4">
          <p className="text-[10px] text-slate-500 mb-2 font-semibold uppercase tracking-wide">Keywords ({p.keywords?.length || 0}) — Match: Exact</p>
          <div className="space-y-1 max-h-48 overflow-y-auto scrollbar-thin">
            {(p.keywords || []).map((k, i) => (
              <div key={i} className="flex items-center justify-between text-xs py-1 border-b border-surface-2/40 last:border-0">
                <span className="text-slate-300 font-medium">{k.keyword}</span>
                <div className="flex items-center gap-3 text-slate-500">
                  <span>{k.orders} pedido{k.orders !== 1 ? 's' : ''}</span>
                  <span className="text-cyan font-semibold">Bid: {fmtBRL(k.bid)}</span>
                  <span className="text-[10px] text-slate-600">{k.source === 'keyword_bank' ? 'Term Bank' : 'Search Term'}</span>
                </div>
              </div>
            ))}
          </div>
          {p.existing_campaign_id && (
            <p className="text-[10px] text-amber-400 mt-2">
              ⚠ Campanha manual existente detectada (ID: {p.existing_campaign_id}) — keywords serão adicionadas via keyword_add, não criará nova campanha.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function ManualCampaignProposalModal({ account, onClose, onDone }) {
  const [phase, setPhase] = useState('idle'); // idle | loading_preview | preview | creating | done | error
  const [proposals, setProposals] = useState([]);
  const [expandedIdx, setExpandedIdx] = useState(null);
  const [result, setResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');

  const loadPreview = async () => {
    setPhase('loading_preview');
    setErrorMsg('');
    try {
      const res = await base44.functions.invoke('proposeManualCampaignsFromWinners', {
        amazon_account_id: account.id,
        preview_only: true,
      });
      const data = res?.data ?? res;
      if (!data?.ok) throw new Error(data?.error || 'Erro ao carregar preview');
      setProposals(data.proposals || []);
      setPhase('preview');
    } catch (e) {
      setErrorMsg(e.message);
      setPhase('error');
    }
  };

  const createProposals = async () => {
    setPhase('creating');
    setErrorMsg('');
    try {
      const res = await base44.functions.invoke('proposeManualCampaignsFromWinners', {
        amazon_account_id: account.id,
        preview_only: false,
      });
      const data = res?.data ?? res;
      if (!data?.ok) throw new Error(data?.error || 'Erro ao criar propostas');
      setResult(data);
      setProposals(data.proposals || []);
      setPhase('done');
      onDone?.();
    } catch (e) {
      setErrorMsg(e.message);
      setPhase('error');
    }
  };

  const newProposals = proposals.filter(p => p.status === 'new');
  const alreadyProposed = proposals.filter(p => p.status === 'already_proposed');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-2xl max-h-[90vh] bg-[#0D111E] border border-surface-2 rounded-2xl flex flex-col overflow-hidden shadow-2xl">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-2 flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center">
              <Sparkles className="w-4 h-4 text-emerald-400" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">Campanhas Manuais a partir de Termos Vencedores</h2>
              <p className="text-[10px] text-slate-500">Exact match · Bid baseado em CPC histórico · Aprovação obrigatória</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 text-slate-500 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4 scrollbar-thin">

          {/* Aviso de aprovação */}
          <div className="flex items-start gap-3 px-4 py-3 rounded-xl border border-amber-500/20 bg-amber-500/5">
            <Info className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-amber-300">
              <strong>Aprovação obrigatória.</strong> Este processo apenas cria <em>propostas</em> (OptimizationDecision) para revisão na Sala de Controle → Automação IA. Nenhuma campanha é criada na Amazon até você aprovar individualmente.
            </p>
          </div>

          {/* Estado: idle */}
          {phase === 'idle' && (
            <div className="text-center py-8 space-y-3">
              <p className="text-sm text-slate-300">Clique em "Analisar" para identificar ASINs com vendas e seus termos vencedores.</p>
              <p className="text-xs text-slate-500">Fontes: Search Terms (orders &gt; 0) + Term Bank (winner tier). Uma campanha por ASIN com todos os termos.</p>
            </div>
          )}

          {/* Estado: loading */}
          {(phase === 'loading_preview' || phase === 'creating') && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <Loader2 className="w-7 h-7 text-emerald-400 animate-spin" />
              <p className="text-sm text-slate-300">
                {phase === 'loading_preview' ? 'Analisando ASINs e termos vencedores...' : 'Criando propostas de campanhas...'}
              </p>
              <p className="text-xs text-slate-500">Isso pode levar alguns segundos.</p>
            </div>
          )}

          {/* Estado: error */}
          {phase === 'error' && (
            <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20">
              <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
              <p className="text-xs text-red-400">{errorMsg}</p>
            </div>
          )}

          {/* Preview / done */}
          {(phase === 'preview' || phase === 'done') && (
            <div className="space-y-3">
              {/* Resumo */}
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: 'ASINs com vendas', value: proposals.length, color: 'text-white' },
                  { label: 'Novas propostas', value: newProposals.length, color: 'text-emerald-400' },
                  { label: 'Já propostas hoje', value: alreadyProposed.length, color: 'text-slate-400' },
                ].map(k => (
                  <div key={k.label} className="bg-surface-1 border border-surface-2 rounded-xl p-3 text-center">
                    <p className="text-[10px] text-slate-500 mb-0.5">{k.label}</p>
                    <p className={`text-xl font-bold ${k.color}`}>{k.value}</p>
                  </div>
                ))}
              </div>

              {phase === 'done' && result && (
                <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
                  <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                  <p className="text-xs text-emerald-300">{result.message}</p>
                </div>
              )}

              {proposals.length === 0 ? (
                <div className="text-center py-8 text-sm text-slate-500">
                  Nenhum ASIN com termos vencedores encontrado. Verifique se há Search Terms com pedidos registrados.
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-slate-400 mb-1">
                    Propostas por ASIN ({proposals.length})
                  </p>
                  {proposals.map((p, i) => (
                    <ProposalRow
                      key={p.asin + i}
                      p={p}
                      expanded={expandedIdx === i}
                      onToggle={() => setExpandedIdx(expandedIdx === i ? null : i)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-surface-2 flex-shrink-0 gap-3">
          <button onClick={onClose} className="px-4 py-2 text-xs font-semibold bg-surface-2 border border-surface-3 text-slate-300 hover:text-white rounded-lg transition-colors">
            Fechar
          </button>
          <div className="flex items-center gap-2">
            {(phase === 'idle' || phase === 'error') && (
              <button
                onClick={loadPreview}
                className="flex items-center gap-2 px-4 py-2 text-xs font-semibold bg-cyan/15 border border-cyan/30 text-cyan hover:bg-cyan/25 rounded-lg transition-colors"
              >
                <Sparkles className="w-3.5 h-3.5" /> Analisar termos
              </button>
            )}
            {phase === 'preview' && newProposals.length > 0 && (
              <button
                onClick={createProposals}
                className="flex items-center gap-2 px-4 py-2 text-xs font-semibold bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25 rounded-lg transition-colors"
              >
                <ArrowRight className="w-3.5 h-3.5" />
                Criar {newProposals.length} proposta{newProposals.length > 1 ? 's' : ''} para revisão
              </button>
            )}
            {phase === 'preview' && newProposals.length === 0 && (
              <span className="text-xs text-slate-500">Nenhuma proposta nova disponível</span>
            )}
            {phase === 'done' && (
              <button
                onClick={() => { setPhase('idle'); setProposals([]); setResult(null); }}
                className="flex items-center gap-2 px-4 py-2 text-xs font-semibold bg-surface-2 border border-surface-3 text-slate-300 hover:text-white rounded-lg transition-colors"
              >
                Nova análise
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}