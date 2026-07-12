import { useState, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  X, Sparkles, CheckCircle2, AlertCircle, ShieldAlert, Clock,
  Loader2, Check, XIcon, Send, Eye, RotateCcw, AlertTriangle, FileText, History
} from 'lucide-react';
import ListingIssuesPanel from './ListingIssuesPanel';
import ListingSnapshotPanel from './ListingSnapshotPanel';
import ListingHistoryPanel from './ListingHistoryPanel';

const TABS = [
  { id: 'overview', label: 'Visão Geral' },
  { id: 'proposals', label: 'Propostas' },
  { id: 'issues', label: 'Issues' },
  { id: 'snapshot', label: 'Conteúdo Atual' },
  { id: 'history', label: 'Histórico' },
];

const PROPOSAL_TYPE_LABELS = {
  organic_terms: 'Termos Orgânicos', title: 'Título', bullet: 'Bullets',
  description: 'Descrição', attribute: 'Atributo', image: 'Imagem',
  a_plus: 'A+ Content', price: 'Preço', offer: 'Oferta',
};

const STATUS_COLORS = {
  draft: 'bg-slate-500/10 border-slate-500/20 text-slate-400',
  pending_review: 'bg-amber-500/10 border-amber-500/20 text-amber-400',
  approved: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400',
  rejected: 'bg-red-500/10 border-red-500/20 text-red-400',
  conflict: 'bg-orange-500/10 border-orange-500/20 text-orange-400',
};

const SUBMISSION_COLORS = {
  not_submitted: 'text-slate-500',
  submitted: 'text-blue-400',
  processing: 'text-amber-400',
  confirmed: 'text-emerald-400',
  failed: 'text-red-400',
};

function ProposalCard({ proposal, loading, onApprove, onReject, onSubmit, onDryRun, onEdit, onSendForReview }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(proposal.proposed_value || '');

  const isBullet = proposal.proposal_type === 'bullet';
  let displayValue = proposal.proposed_value || '';
  if (isBullet) {
    try { displayValue = JSON.parse(displayValue).join('\n'); } catch {}
  }

  const handleSaveEdit = async () => {
    let finalValue = editValue;
    if (isBullet) {
      const lines = editValue.split('\n').map(l => l.trim()).filter(Boolean);
      finalValue = JSON.stringify(lines);
    }
    await onEdit(proposal.id, finalValue);
    setEditing(false);
  };

  const canEdit = ['draft', 'pending_review', 'rejected'].includes(proposal.approval_status);
  const canApprove = proposal.approval_status === 'pending_review';
  const canSubmit = proposal.approval_status === 'approved' &&
    !['submitted', 'processing', 'confirmed'].includes(proposal.submission_status || '');
  const isBlocked = proposal.brand_safety_status === 'blocked';
  const isLoading = loading === proposal.id;

  return (
    <div className={`rounded-xl border transition-all ${
      proposal.approval_status === 'approved' ? 'border-emerald-500/30 bg-emerald-500/5' :
      proposal.approval_status === 'pending_review' ? 'border-amber-500/30 bg-amber-500/5' :
      proposal.approval_status === 'conflict' ? 'border-orange-500/30 bg-orange-500/5' :
      'border-surface-2 bg-surface-1'
    }`}>
      {/* Header */}
      <div className="flex items-center justify-between p-3 cursor-pointer" onClick={() => setExpanded(v => !v)}>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-bold text-slate-200">{PROPOSAL_TYPE_LABELS[proposal.proposal_type] || proposal.proposal_type}</span>
          <span className="text-[10px] font-mono text-slate-500">{proposal.field_name}</span>
          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${STATUS_COLORS[proposal.approval_status] || 'text-slate-500'}`}>
            {proposal.approval_status?.replace('_', ' ')}
          </span>
          {proposal.submission_status && proposal.submission_status !== 'not_submitted' && (
            <span className={`text-[10px] font-semibold ${SUBMISSION_COLORS[proposal.submission_status] || 'text-slate-500'}`}>
              · {proposal.submission_status}
            </span>
          )}
          {isBlocked && <span className="text-[10px] text-red-400 font-semibold">🚫 Marca bloqueada</span>}
          {proposal.brand_safety_status === 'brand_review_required' && (
            <span className="text-[10px] text-orange-400">⚠ Revisão de marca</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {canApprove && !isLoading && (
            <button onClick={e => { e.stopPropagation(); onApprove(proposal); }}
              className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 transition-colors">
              <Check className="w-3 h-3" /> Aprovar
            </button>
          )}
          {canApprove && !isLoading && (
            <button onClick={e => { e.stopPropagation(); onReject(proposal); }}
              className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-colors">
              <XIcon className="w-3 h-3" /> Rejeitar
            </button>
          )}
          {canSubmit && !isBlocked && !isLoading && (
            <button onClick={e => { e.stopPropagation(); onSubmit(proposal.id); }}
              className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold rounded-lg bg-violet-500/15 border border-violet-500/30 text-violet-300 hover:bg-violet-500/25 transition-colors">
              <Send className="w-3 h-3" /> Publicar
            </button>
          )}
          {isLoading && <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan" />}
        </div>
      </div>

      {/* Expanded */}
      {expanded && (
        <div className="px-3 pb-3 space-y-3 border-t border-surface-2/60 pt-3">
          {/* Rationale */}
          {proposal.rationale && (
            <p className="text-[10px] text-slate-400 leading-relaxed">{proposal.rationale}</p>
          )}

          {/* Diff: Current vs Proposed */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <p className="text-[10px] font-semibold text-slate-500 mb-1">Valor Atual</p>
              <div className="bg-red-900/10 border border-red-500/10 rounded-lg p-2 text-[10px] text-slate-400 max-h-32 overflow-y-auto whitespace-pre-wrap break-words">
                {proposal.current_value ? (
                  isBullet
                    ? (() => { try { return JSON.parse(proposal.current_value).map((b, i) => `${i+1}. ${b}`).join('\n'); } catch { return proposal.current_value; } })()
                    : proposal.current_value
                ) : <span className="italic text-slate-600">Vazio</span>}
              </div>
            </div>
            <div>
              <p className="text-[10px] font-semibold text-slate-500 mb-1">Valor Proposto</p>
              {editing ? (
                <div className="space-y-1">
                  <textarea
                    value={isBullet ? editValue : editValue}
                    onChange={e => setEditValue(e.target.value)}
                    rows={isBullet ? 6 : 4}
                    className="w-full bg-surface-2 border border-cyan/30 rounded-lg p-2 text-[10px] text-slate-200 resize-none focus:outline-none focus:border-cyan/60"
                    placeholder={isBullet ? 'Um bullet por linha...' : 'Valor proposto...'}
                  />
                  <div className="flex gap-1">
                    <button onClick={handleSaveEdit}
                      className="px-2 py-0.5 text-[10px] font-semibold rounded bg-cyan/15 border border-cyan/30 text-cyan hover:bg-cyan/25">
                      Salvar
                    </button>
                    <button onClick={() => { setEditing(false); setEditValue(proposal.proposed_value || ''); }}
                      className="px-2 py-0.5 text-[10px] font-semibold rounded bg-surface-2 border border-surface-3 text-slate-400">
                      Cancelar
                    </button>
                  </div>
                </div>
              ) : (
                <div className="relative group">
                  <div className="bg-emerald-900/10 border border-emerald-500/10 rounded-lg p-2 text-[10px] text-slate-300 max-h-32 overflow-y-auto whitespace-pre-wrap break-words">
                    {displayValue || <span className="italic text-slate-600">Vazio</span>}
                  </div>
                  {canEdit && (
                    <button onClick={() => { setEditing(true); setEditValue(isBullet ? displayValue : proposal.proposed_value || ''); }}
                      className="absolute top-1 right-1 px-1.5 py-0.5 text-[9px] rounded bg-surface-2/80 border border-surface-3 text-slate-500 hover:text-slate-200 opacity-0 group-hover:opacity-100 transition-opacity">
                      Editar
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Ações secundárias */}
          <div className="flex items-center gap-2 flex-wrap">
            {proposal.approval_status === 'draft' && (
              <button onClick={() => onSendForReview(proposal.id)}
                className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-colors">
                <Eye className="w-3 h-3" /> Enviar para Revisão
              </button>
            )}
            {proposal.approval_status === 'approved' && (
              <button onClick={() => onDryRun(proposal.id)}
                className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold rounded-lg bg-surface-2 border border-surface-3 text-slate-400 hover:text-slate-200 transition-colors">
                <Eye className="w-3 h-3" /> Validar (dry run)
              </button>
            )}
            {proposal.submission_status === 'processing' && (
              <span className="text-[10px] text-amber-400 flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> Processando na Amazon...
              </span>
            )}
            {proposal.submission_status === 'confirmed' && (
              <span className="text-[10px] text-emerald-400 flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" /> Confirmado pela Amazon
              </span>
            )}
          </div>

          {/* Issues da Amazon */}
          {proposal.amazon_issues && proposal.amazon_issues !== '[]' && (
            <div className="bg-red-500/5 border border-red-500/15 rounded-lg p-2">
              <p className="text-[10px] font-semibold text-red-400 mb-1">Issues Amazon</p>
              {(() => {
                try {
                  const iss = JSON.parse(proposal.amazon_issues);
                  return iss.map((issue, i) => (
                    <p key={i} className="text-[10px] text-slate-400">{issue.message || JSON.stringify(issue)}</p>
                  ));
                } catch {
                  return <p className="text-[10px] text-slate-400">{proposal.amazon_issues}</p>;
                }
              })()}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ListingEnhancementDrawer({ product, snapshot, proposals, account, onClose, onRefresh }) {
  const [activeTab, setActiveTab] = useState('overview');
  const [msg, setMsg] = useState(null);
  const [loading, setLoading] = useState(null);

  const parseJson = (str, fallback) => { try { return JSON.parse(str || ''); } catch { return fallback; } };
  const issues = parseJson(snapshot?.amazon_issues, []);
  const missingFields = parseJson(snapshot?.missing_fields, []);
  const images = parseJson(snapshot?.images, []);
  const bullets = parseJson(snapshot?.bullets, []);
  const organicTerms = parseJson(snapshot?.organic_terms, []);

  const pendingProposals = (proposals || []).filter(p => p.approval_status === 'pending_review');
  const approvedProposals = (proposals || []).filter(p => p.approval_status === 'approved');
  const draftProposals = (proposals || []).filter(p => p.approval_status === 'draft');

  const showMsg = (type, text) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 7000);
  };

  const approveProposal = useCallback(async (proposal) => {
    setLoading(proposal.id);
    try {
      await base44.entities.ListingEnhancementProposal.update(proposal.id, {
        approval_status: 'approved', approved_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      showMsg('success', 'Proposta aprovada. Pronta para submissão.');
      onRefresh?.();
    } catch (e) { showMsg('error', e.message); }
    finally { setLoading(null); }
  }, [onRefresh]);

  const rejectProposal = useCallback(async (proposal) => {
    const reason = window.prompt('Motivo da rejeição (obrigatório):');
    if (!reason) return;
    setLoading(proposal.id);
    try {
      await base44.entities.ListingEnhancementProposal.update(proposal.id, {
        approval_status: 'rejected', rejected_at: new Date().toISOString(),
        rejection_reason: reason, updated_at: new Date().toISOString(),
      });
      showMsg('success', 'Proposta rejeitada.');
      onRefresh?.();
    } catch (e) { showMsg('error', e.message); }
    finally { setLoading(null); }
  }, [onRefresh]);

  const sendForReview = useCallback(async (proposalId) => {
    setLoading(proposalId);
    try {
      await base44.entities.ListingEnhancementProposal.update(proposalId, {
        approval_status: 'pending_review', updated_at: new Date().toISOString(),
      });
      showMsg('success', 'Proposta enviada para revisão.');
      onRefresh?.();
    } catch (e) { showMsg('error', e.message); }
    finally { setLoading(null); }
  }, [onRefresh]);

  const editProposal = useCallback(async (proposalId, newValue) => {
    setLoading(proposalId);
    try {
      await base44.entities.ListingEnhancementProposal.update(proposalId, {
        proposed_value: newValue, updated_at: new Date().toISOString(),
      });
      showMsg('success', 'Valor atualizado.');
      onRefresh?.();
    } catch (e) { showMsg('error', e.message); }
    finally { setLoading(null); }
  }, [onRefresh]);

  const submitProposal = useCallback(async (proposalId, dryRun = false) => {
    setLoading(proposalId);
    try {
      const res = await base44.functions.invoke('submitApprovedListingEnhancement', {
        proposal_id: proposalId, amazon_account_id: account?.id, dry_run: dryRun,
      });
      if (res?.data?.ok) {
        showMsg('success', dryRun
          ? `Validação OK: sem issues detectadas.`
          : `Submetido com sucesso. Status: ${res.data.status}`);
        if (!dryRun) onRefresh?.();
      } else {
        showMsg('error', res?.data?.error || 'Falha na submissão.');
      }
    } catch (e) { showMsg('error', e.message); }
    finally { setLoading(null); }
  }, [account, onRefresh]);

  const pollStatus = useCallback(async () => {
    setLoading('poll');
    try {
      const res = await base44.functions.invoke('pollListingSubmissionStatus', { amazon_account_id: account?.id });
      if (res?.data?.ok) {
        showMsg('success', `${res.data.confirmed} confirmados, ${res.data.still_processing} ainda processando.`);
        onRefresh?.();
      } else {
        showMsg('error', res?.data?.error || 'Erro ao verificar status.');
      }
    } catch (e) { showMsg('error', e.message); }
    finally { setLoading(null); }
  }, [account, onRefresh]);

  const hasProcessing = (proposals || []).some(p => p.submission_status === 'processing');

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/60" onClick={onClose} />
      <div className="w-full max-w-3xl bg-[#0D111E] border-l border-surface-2 flex flex-col h-full overflow-hidden">

        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-surface-2 flex-shrink-0">
          <div>
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="font-mono text-cyan text-sm">{product.asin}</span>
              <span className="text-slate-600">·</span>
              <span className="font-mono text-slate-500 text-xs">{product.sku}</span>
              {snapshot?.product_type && (
                <span className="px-2 py-0.5 bg-surface-2 rounded text-slate-400 text-[10px] font-mono">{snapshot.product_type}</span>
              )}
            </div>
            <p className="text-sm font-semibold text-white truncate max-w-[420px]">
              {product.display_name || product.product_name || '—'}
            </p>
            <div className="flex items-center gap-3 mt-1 text-[10px] text-slate-500 flex-wrap">
              {snapshot?.synced_at && (
                <span>Sync: {new Date(snapshot.synced_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
              )}
              {issues.length > 0 && <span className="text-red-400">{issues.length} issues</span>}
              {missingFields.length > 0 && <span className="text-amber-400">{missingFields.length} campos ausentes</span>}
              {hasProcessing && (
                <button onClick={pollStatus} disabled={loading === 'poll'}
                  className="flex items-center gap-1 text-amber-400 hover:text-amber-300 transition-colors">
                  {loading === 'poll' ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                  Verificar status
                </button>
              )}
            </div>
          </div>
          <button onClick={onClose} className="p-1 text-slate-500 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-surface-2 flex-shrink-0 overflow-x-auto">
          {TABS.map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2.5 text-xs font-semibold whitespace-nowrap border-b-2 transition-colors ${activeTab === tab.id ? 'border-violet-400 text-violet-300' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
              {tab.label}
              {tab.id === 'proposals' && (proposals?.length || 0) > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 bg-violet-500/20 text-violet-400 rounded-full text-[9px]">{proposals.length}</span>
              )}
              {tab.id === 'issues' && issues.length > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 bg-red-500/20 text-red-400 rounded-full text-[9px]">{issues.length}</span>
              )}
            </button>
          ))}
        </div>

        {msg && (
          <div className={`mx-4 mt-3 px-3 py-2 rounded-lg text-xs border ${msg.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border-red-500/20 text-red-400'}`}>
            {msg.text}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">

          {/* ── Visão Geral ── */}
          {activeTab === 'overview' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                {[
                  { label: 'Título', value: snapshot?.title ? '✅ Presente' : '⚠️ Ausente', ok: !!snapshot?.title },
                  { label: 'Bullets', value: `${bullets.length} bullets`, ok: bullets.length >= 3 },
                  { label: 'Descrição', value: snapshot?.description ? '✅ Presente' : '⚠️ Ausente', ok: !!snapshot?.description },
                  { label: 'Termos Orgânicos', value: `${organicTerms.length} termos`, ok: organicTerms.length > 0 },
                  { label: 'Imagens', value: `${images.length} imagens`, ok: images.length >= 1 },
                  { label: 'Campos Ausentes', value: missingFields.length > 0 ? `${missingFields.length} ausentes` : '✅ Completo', ok: missingFields.length === 0 },
                ].map(item => (
                  <div key={item.label} className="bg-surface-2 rounded-lg p-3">
                    <p className="text-[10px] text-slate-500 mb-0.5">{item.label}</p>
                    <p className={`text-xs font-semibold ${item.ok ? 'text-emerald-400' : 'text-amber-400'}`}>{item.value}</p>
                  </div>
                ))}
              </div>

              {/* Aviso */}
              <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg border border-amber-500/20 bg-amber-500/5">
                <ShieldAlert className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                <p className="text-[10px] text-amber-300">
                  <strong>Aprovação obrigatória.</strong> Propostas precisam ser revisadas e aprovadas manualmente antes de qualquer publicação na Amazon. Marcas de terceiros são bloqueadas automaticamente.
                </p>
              </div>

              {/* Resumo de propostas */}
              {(draftProposals.length > 0 || pendingProposals.length > 0 || approvedProposals.length > 0) && (
                <div className="space-y-2">
                  {draftProposals.length > 0 && (
                    <div className="flex items-center justify-between px-3 py-2 rounded-lg border border-slate-500/20 bg-slate-500/5">
                      <div className="flex items-center gap-2">
                        <FileText className="w-3.5 h-3.5 text-slate-400" />
                        <span className="text-xs text-slate-300">{draftProposals.length} rascunho{draftProposals.length > 1 ? 's' : ''} — aguardando revisão interna</span>
                      </div>
                      <button onClick={() => setActiveTab('proposals')} className="text-[10px] text-cyan hover:text-white transition-colors">Ver →</button>
                    </div>
                  )}
                  {pendingProposals.length > 0 && (
                    <div className="flex items-center justify-between px-3 py-2 rounded-lg border border-amber-500/20 bg-amber-500/5">
                      <div className="flex items-center gap-2">
                        <Clock className="w-3.5 h-3.5 text-amber-400" />
                        <span className="text-xs text-amber-300">{pendingProposals.length} aguardando aprovação</span>
                      </div>
                      <button onClick={() => setActiveTab('proposals')} className="text-[10px] text-cyan hover:text-white transition-colors">Revisar →</button>
                    </div>
                  )}
                  {approvedProposals.length > 0 && (
                    <div className="flex items-center justify-between px-3 py-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-xs text-emerald-300">{approvedProposals.length} aprovada{approvedProposals.length > 1 ? 's' : ''} — pronta{approvedProposals.length > 1 ? 's' : ''} para publicação</span>
                      </div>
                      <button onClick={() => setActiveTab('proposals')} className="text-[10px] text-cyan hover:text-white transition-colors">Publicar →</button>
                    </div>
                  )}
                </div>
              )}

              {!snapshot && (
                <div className="text-center py-8 text-slate-500 text-xs">
                  Listing não sincronizado. Use o botão "Sync" na tabela para carregar o conteúdo atual da Amazon.
                </div>
              )}
            </div>
          )}

          {/* ── Propostas ── */}
          {activeTab === 'proposals' && (
            <div className="space-y-3">
              {(!proposals || proposals.length === 0) ? (
                <div className="text-center py-12 text-slate-500 text-xs space-y-1">
                  <Sparkles className="w-6 h-6 text-slate-600 mx-auto mb-2" />
                  <p>Nenhuma proposta gerada ainda.</p>
                  <p>Use o botão "Sugerir" na tabela para gerar propostas com IA.</p>
                </div>
              ) : (
                proposals.map(p => (
                  <ProposalCard
                    key={p.id}
                    proposal={p}
                    loading={loading}
                    onApprove={approveProposal}
                    onReject={rejectProposal}
                    onSubmit={id => submitProposal(id, false)}
                    onDryRun={id => submitProposal(id, true)}
                    onEdit={editProposal}
                    onSendForReview={sendForReview}
                  />
                ))
              )}
            </div>
          )}

          {/* ── Issues ── */}
          {activeTab === 'issues' && (
            <ListingIssuesPanel issues={issues} missingFields={missingFields} asin={product.asin} sku={product.sku} />
          )}

          {/* ── Conteúdo Atual ── */}
          {activeTab === 'snapshot' && (
            <ListingSnapshotPanel snapshot={snapshot} />
          )}

          {/* ── Histórico ── */}
          {activeTab === 'history' && (
            <ListingHistoryPanel asin={product.asin} accountId={account?.id} />
          )}
        </div>
      </div>
    </div>
  );
}