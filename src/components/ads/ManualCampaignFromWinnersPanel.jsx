import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Sparkles, Loader2, CheckCircle, AlertCircle, Play, Eye,
  ChevronDown, ChevronUp, Package, Info
} from 'lucide-react';

function fmtBRL(v) {
  return `R$${Number(v || 0).toFixed(2)}`;
}

function ProposalRow({ p, onApprove, approving }) {
  const [expanded, setExpanded] = useState(false);
  const isWorking = approving === p.asin;

  return (
    <div className={`border-b border-surface-2/50 last:border-0 ${p.skipped ? 'opacity-50' : ''}`}>
      <div className="flex items-center gap-3 px-4 py-3">
        <button onClick={() => setExpanded(v => !v)} className="text-slate-600 hover:text-slate-400 flex-shrink-0">
          {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>
        <div className="flex-1 min-w-0 grid grid-cols-5 gap-3 items-center">
          {/* ASIN + Produto */}
          <div className="col-span-2 min-w-0">
            <p className="text-xs font-mono font-bold text-cyan">{p.asin}</p>
            {p.product_name && (
              <p className="text-[10px] text-slate-500 truncate mt-0.5">{p.product_name}</p>
            )}
          </div>
          {/* Nº Keywords */}
          <div className="text-center">
            <p className="text-sm font-bold text-white">{p.keywords_count}</p>
            <p className="text-[9px] text-slate-500">keywords</p>
          </div>
          {/* Bid médio */}
          <div className="text-center">
            <p className="text-sm font-bold text-white">{fmtBRL(p.avg_bid)}</p>
            <p className="text-[9px] text-slate-500">bid médio</p>
          </div>
          {/* Budget */}
          <div className="text-center">
            <p className="text-sm font-bold text-amber-400">{fmtBRL(p.suggested_budget)}</p>
            <p className="text-[9px] text-slate-500">budget/dia</p>
          </div>
        </div>

        {/* Ação */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {p.skipped ? (
            <span className="text-[10px] text-slate-500 italic">{p.reason}</span>
          ) : p.action === 'keyword_add' ? (
            <span className="text-[10px] px-2 py-0.5 rounded-full border bg-violet-500/10 border-violet-500/20 text-violet-400 font-semibold">
              + Keywords
            </span>
          ) : (
            <span className="text-[10px] px-2 py-0.5 rounded-full border bg-emerald-500/10 border-emerald-500/20 text-emerald-400 font-semibold">
              Nova Campanha
            </span>
          )}
          {!p.skipped && p.decision_id && (
            <button
              onClick={() => onApprove(p)}
              disabled={isWorking}
              className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-semibold rounded-lg bg-cyan/15 border border-cyan/30 text-cyan hover:bg-cyan/25 transition-colors disabled:opacity-50"
            >
              {isWorking ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
              Aprovar
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-3 space-y-2">
          {p.existing_campaign && (
            <div className="flex items-center gap-2 px-3 py-2 bg-violet-500/5 border border-violet-500/15 rounded-lg">
              <Info className="w-3.5 h-3.5 text-violet-400 flex-shrink-0" />
              <p className="text-[10px] text-violet-300">
                Campanha existente: <span className="font-mono font-bold">{p.existing_campaign}</span> — keywords serão adicionadas à campanha existente.
              </p>
            </div>
          )}
          {p.keywords_preview?.length > 0 && (
            <div>
              <p className="text-[10px] text-slate-500 mb-1">Amostra de keywords ({p.keywords_preview.length} de {p.keywords_count}):</p>
              <div className="flex flex-wrap gap-1.5">
                {p.keywords_preview.map(k => (
                  <span key={k} className="text-[10px] px-2 py-0.5 bg-surface-2 border border-surface-3 text-slate-300 rounded font-mono">
                    {k}
                  </span>
                ))}
                {p.keywords_count > 5 && (
                  <span className="text-[10px] text-slate-600">+{p.keywords_count - 5} mais...</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ManualCampaignFromWinnersPanel({ account, onDone }) {
  const [running, setRunning] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [result, setResult] = useState(null);
  const [msg, setMsg] = useState(null);
  const [approving, setApproving] = useState(null); // asin aprovando

  const showMsg = (type, text) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 8000);
  };

  const runPreview = async () => {
    if (!account || previewing || running) return;
    setPreviewing(true);
    setResult(null);
    setMsg(null);
    try {
      const res = await base44.functions.invoke('proposeManualCampaignsFromWinners', {
        amazon_account_id: account.id,
        dry_run: true,
      });
      const data = res?.data || res;
      if (data?.ok) {
        setResult({ ...data, dry_run: true });
      } else {
        showMsg('error', data?.error || 'Erro ao gerar preview.');
      }
    } catch (e) {
      showMsg('error', e.message);
    } finally {
      setPreviewing(false);
    }
  };

  const runPropose = async () => {
    if (!account || running || previewing) return;
    setRunning(true);
    setResult(null);
    setMsg(null);
    try {
      const res = await base44.functions.invoke('proposeManualCampaignsFromWinners', {
        amazon_account_id: account.id,
        dry_run: false,
      });
      const data = res?.data || res;
      if (data?.ok) {
        setResult({ ...data, dry_run: false });
        showMsg('success', `${data.proposals_created} proposta(s) criada(s) para revisão na Sala de Comando.`);
        onDone?.();
      } else {
        showMsg('error', data?.error || 'Erro ao propor campanhas.');
      }
    } catch (e) {
      showMsg('error', e.message);
    } finally {
      setRunning(false);
    }
  };

  const approveProposal = async (proposal) => {
    if (!account || approving) return;
    setApproving(proposal.asin);
    try {
      await base44.entities.OptimizationDecision.update(proposal.decision_id, {
        status: 'approved',
        approved_at: new Date().toISOString(),
        approved_by: 'user',
        updated_at: new Date().toISOString(),
      });

      // Invocar criação da campanha
      let res;
      if (proposal.action === 'campaign_create') {
        res = await base44.functions.invoke('createManualCampaignV2', {
          amazon_account_id: account.id,
          asin: proposal.asin,
          keywords: result?.proposals?.find(p => p.asin === proposal.asin)?.keywords_preview || [],
          decision_id: proposal.decision_id,
        });
      } else {
        res = await base44.functions.invoke('createSpKeywordsForAdGroup', {
          amazon_account_id: account.id,
          asin: proposal.asin,
          decision_id: proposal.decision_id,
        });
      }

      const data = res?.data || res;
      if (data?.ok || data?.created) {
        await base44.entities.OptimizationDecision.update(proposal.decision_id, {
          status: 'executed',
          executed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        setResult(prev => ({
          ...prev,
          proposals: prev.proposals.map(p =>
            p.asin === proposal.asin ? { ...p, status: 'executed', skipped: true, reason: '✓ Executada' } : p
          ),
        }));
        showMsg('success', `Campanha para ${proposal.asin} criada/atualizada com sucesso!`);
        onDone?.();
      } else {
        await base44.entities.OptimizationDecision.update(proposal.decision_id, {
          status: 'failed',
          execution_error: data?.error || 'Falha desconhecida',
          updated_at: new Date().toISOString(),
        });
        showMsg('error', data?.error || 'Falha ao executar criação da campanha.');
      }
    } catch (e) {
      showMsg('error', e.message);
    } finally {
      setApproving(null);
    }
  };

  const proposals = result?.proposals || [];
  const activeProposals = proposals.filter(p => !p.skipped);
  const skippedProposals = proposals.filter(p => p.skipped);

  return (
    <div className="border border-violet-500/25 bg-violet-500/5 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-violet-500/20">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-violet-400 flex-shrink-0" />
          <div>
            <p className="text-xs font-bold text-violet-300">Campanhas Manuais a partir de Termos Vencedores</p>
            <p className="text-[10px] text-slate-500 mt-0.5">Identifica ASINs com vendas, coleta search terms vencedores e propõe campanhas exact match com bid baseado em CPC histórico.</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={runPreview}
            disabled={!account || previewing || running}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-surface-2 border border-surface-3 text-slate-300 hover:text-white rounded-lg transition-colors disabled:opacity-50"
          >
            {previewing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
            Preview
          </button>
          <button
            onClick={runPropose}
            disabled={!account || running || previewing}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-violet-500/20 border border-violet-500/30 text-violet-300 hover:bg-violet-500/30 rounded-lg transition-colors disabled:opacity-50"
          >
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {running ? 'Analisando...' : 'Propor Campanhas'}
          </button>
        </div>
      </div>

      {/* Message */}
      {msg && (
        <div className={`mx-4 mt-3 px-3 py-2 rounded-lg text-xs border flex items-center gap-2 ${
          msg.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' :
          msg.type === 'error' ? 'bg-red-500/10 border-red-500/20 text-red-400' :
          'bg-cyan/10 border-cyan/20 text-cyan'
        }`}>
          {msg.type === 'success' ? <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />}
          {msg.text}
        </div>
      )}

      {/* Result */}
      {result && (
        <div className="p-4 space-y-3">
          {/* Summary */}
          <div className="flex items-center gap-4 flex-wrap text-xs">
            {result.dry_run && (
              <span className="px-2 py-0.5 bg-amber-500/15 border border-amber-500/30 text-amber-400 rounded-full text-[10px] font-semibold">
                PREVIEW — nenhuma decisão criada
              </span>
            )}
            <span className="text-slate-400">ASINs elegíveis: <strong className="text-white">{result.eligible_asins}</strong></span>
            <span className="text-slate-400">Propostas: <strong className="text-violet-300">{result.proposals_created}</strong></span>
            {result.proposals_skipped > 0 && (
              <span className="text-slate-500">Já existem: {result.proposals_skipped}</span>
            )}
          </div>

          {/* Aviso aprovação */}
          {!result.dry_run && activeProposals.length > 0 && (
            <div className="flex items-start gap-2 px-3 py-2 bg-amber-500/8 border border-amber-500/20 rounded-lg">
              <AlertCircle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5" />
              <p className="text-[10px] text-amber-300">
                <strong>Aprovação obrigatória.</strong> As decisões foram criadas na Sala de Comando. Use o botão "Aprovar" para executar individualmente, ou acesse a aba "Automação IA" na Sala de Comando para aprovar em lote.
              </p>
            </div>
          )}

          {/* Tabela de propostas */}
          {proposals.length > 0 && (
            <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
              {/* Cabeçalho da tabela */}
              <div className="grid grid-cols-5 gap-3 px-4 py-2 border-b border-surface-2 bg-surface-2/40">
                <div className="col-span-2 text-[10px] font-semibold text-slate-500 uppercase">ASIN / Produto</div>
                <div className="text-[10px] font-semibold text-slate-500 uppercase text-center">Keywords</div>
                <div className="text-[10px] font-semibold text-slate-500 uppercase text-center">Bid Médio</div>
                <div className="text-[10px] font-semibold text-slate-500 uppercase text-center">Budget/dia</div>
              </div>
              <div className="divide-y divide-surface-2/40">
                {activeProposals.map(p => (
                  <ProposalRow
                    key={p.asin}
                    p={p}
                    onApprove={approveProposal}
                    approving={approving}
                  />
                ))}
                {skippedProposals.length > 0 && (
                  <div className="px-4 py-2 text-[10px] text-slate-600 italic">
                    {skippedProposals.length} ASIN(s) já possuem decisão criada hoje ou foram ignorados.
                  </div>
                )}
              </div>
            </div>
          )}

          {proposals.length === 0 && (
            <div className="text-center py-8 text-slate-500 text-xs flex flex-col items-center gap-2">
              <Package className="w-6 h-6 text-slate-700" />
              <p>Nenhum ASIN elegível encontrado. Verifique se há search terms com vendas registradas no Term Bank.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}