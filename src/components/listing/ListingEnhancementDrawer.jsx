import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { X, RefreshCw, Sparkles, CheckCircle2, AlertCircle, ShieldAlert, Clock, History, FileText, ChevronDown, ChevronUp, Loader2, Eye, Check, XIcon } from 'lucide-react';
import ListingDiffViewer from './ListingDiffViewer';
import ListingProposalReview from './ListingProposalReview';
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

export default function ListingEnhancementDrawer({ product, snapshot, proposals, account, onClose, onRefresh }) {
  const [activeTab, setActiveTab] = useState('overview');
  const [msg, setMsg] = useState(null);
  const [loading, setLoading] = useState(null);

  const pendingProposals = (proposals || []).filter(p => p.approval_status === 'pending_review');
  const approvedProposals = (proposals || []).filter(p => p.approval_status === 'approved');
  const draftProposals = (proposals || []).filter(p => p.approval_status === 'draft');

  let issues = [];
  try { issues = JSON.parse(snapshot?.amazon_issues || '[]'); } catch {}
  let missingFields = [];
  try { missingFields = JSON.parse(snapshot?.missing_fields || '[]'); } catch {}
  let images = [];
  try { images = JSON.parse(snapshot?.images || '[]'); } catch {}
  let bullets = [];
  try { bullets = JSON.parse(snapshot?.bullets || '[]'); } catch {}
  let organicTerms = [];
  try { organicTerms = JSON.parse(snapshot?.organic_terms || '[]'); } catch {}

  const submitProposal = async (proposalId) => {
    setLoading(proposalId);
    setMsg(null);
    try {
      const res = await base44.functions.invoke('submitApprovedListingEnhancement', {
        proposal_id: proposalId,
        amazon_account_id: account?.id,
      });
      if (res?.data?.ok) {
        setMsg({ type: 'success', text: `Submetido com sucesso. Status: ${res.data.status}` });
        onRefresh?.();
      } else {
        setMsg({ type: 'error', text: res?.data?.error || 'Falha na submissão.' });
      }
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setLoading(null);
      setTimeout(() => setMsg(null), 8000);
    }
  };

  const approveProposal = async (proposal) => {
    setLoading(proposal.id);
    try {
      await base44.entities.ListingEnhancementProposal.update(proposal.id, {
        approval_status: 'approved',
        approved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      setMsg({ type: 'success', text: 'Proposta aprovada.' });
      onRefresh?.();
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setLoading(null);
      setTimeout(() => setMsg(null), 5000);
    }
  };

  const rejectProposal = async (proposal) => {
    const reason = window.prompt('Motivo da rejeição:');
    if (!reason) return;
    setLoading(proposal.id);
    try {
      await base44.entities.ListingEnhancementProposal.update(proposal.id, {
        approval_status: 'rejected',
        rejected_at: new Date().toISOString(),
        rejection_reason: reason,
        updated_at: new Date().toISOString(),
      });
      setMsg({ type: 'success', text: 'Proposta rejeitada.' });
      onRefresh?.();
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setLoading(null);
      setTimeout(() => setMsg(null), 5000);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/60" onClick={onClose} />
      <div className="w-full max-w-3xl bg-[#0D111E] border-l border-surface-2 flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-surface-2 flex-shrink-0">
          <div>
            <div className="flex items-center gap-2 mb-1">
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
            <div className="flex items-center gap-3 mt-1 text-[10px] text-slate-500">
              {snapshot?.synced_at && <span>Sync: {new Date(snapshot.synced_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>}
              {issues.length > 0 && <span className="text-red-400">{issues.length} issues</span>}
              {missingFields.length > 0 && <span className="text-amber-400">{missingFields.length} campos ausentes</span>}
            </div>
          </div>
          <button onClick={onClose} className="p-1 text-slate-500 hover:text-white transition-colors"><X className="w-5 h-5" /></button>
        </div>

        {/* Tabs */}
        <div className="flex gap-0 border-b border-surface-2 flex-shrink-0 overflow-x-auto">
          {TABS.map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2.5 text-xs font-semibold whitespace-nowrap border-b-2 transition-colors ${activeTab === tab.id ? 'border-violet-400 text-violet-300' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
              {tab.label}
              {tab.id === 'proposals' && proposals?.length > 0 && (
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
              {/* Status do listing */}
              <div className="grid grid-cols-2 gap-3">
                {[
                  { label: 'Título', value: snapshot?.title ? '✅ Presente' : '⚠️ Ausente', ok: !!snapshot?.title },
                  { label: 'Bullets', value: `${bullets.length} bullets`, ok: bullets.length >= 3 },
                  { label: 'Descrição', value: snapshot?.description ? '✅ Presente' : '⚠️ Ausente', ok: !!snapshot?.description },
                  { label: 'Termos Orgânicos', value: `${organicTerms.length} termos`, ok: organicTerms.length > 0 },
                  { label: 'Imagens', value: `${images.length} imagens`, ok: images.length >= 1 },
                  { label: 'Campos Ausentes', value: missingFields.length > 0 ? `${missingFields.length} ausentes` : '✅ OK', ok: missingFields.length === 0 },
                ].map(item => (
                  <div key={item.label} className="bg-surface-2 rounded-lg p-3">
                    <p className="text-[10px] text-slate-500 mb-0.5">{item.label}</p>
                    <p className={`text-xs font-semibold ${item.ok ? 'text-emerald-400' : 'text-amber-400'}`}>{item.value}</p>
                  </div>
                ))}
              </div>

              {/* Propostas pendentes */}
              {pendingProposals.length > 0 && (
                <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4">
                  <p className="text-xs font-semibold text-amber-400 mb-3 flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5" /> {pendingProposals.length} proposta{pendingProposals.length > 1 ? 's' : ''} aguardando revisão
                  </p>
                  <div className="space-y-2">
                    {pendingProposals.map(p => (
                      <div key={p.id} className="flex items-center justify-between gap-3 bg-surface-2 rounded-lg p-3">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold text-slate-200">{p.proposal_type} · {p.field_name}</p>
                          <p className="text-[10px] text-slate-500 truncate mt-0.5">{p.rationale}</p>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button onClick={() => approveProposal(p)} disabled={!!loading}
                            className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-50 transition-colors">
                            {loading === p.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Aprovar
                          </button>
                          <button onClick={() => rejectProposal(p)} disabled={!!loading}
                            className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 disabled:opacity-50 transition-colors">
                            <XIcon className="w-3 h-3" /> Rejeitar
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Propostas aprovadas prontas para publicar */}
              {approvedProposals.length > 0 && (
                <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4">
                  <p className="text-xs font-semibold text-emerald-400 mb-3 flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5" /> {approvedProposals.length} proposta{approvedProposals.length > 1 ? 's' : ''} aprovada{approvedProposals.length > 1 ? 's' : ''} — pronta{approvedProposals.length > 1 ? 's' : ''} para submissão
                  </p>
                  <div className="space-y-2">
                    {approvedProposals.map(p => (
                      <div key={p.id} className="flex items-center justify-between gap-3 bg-surface-2 rounded-lg p-3">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold text-slate-200">{p.proposal_type} · {p.field_name}</p>
                          <p className="text-[10px] text-slate-500 truncate mt-0.5">{(p.proposed_value || '').slice(0, 80)}</p>
                          {p.brand_safety_status === 'brand_review_required' && (
                            <p className="text-[10px] text-orange-400 mt-0.5">⚠️ Revisão de marca necessária</p>
                          )}
                        </div>
                        <button
                          onClick={() => submitProposal(p.id)}
                          disabled={!!loading || p.brand_safety_status === 'blocked' || !p.proposed_value}
                          className="flex items-center gap-1 px-3 py-1.5 text-[10px] font-semibold rounded-lg bg-violet-500/15 border border-violet-500/30 text-violet-300 hover:bg-violet-500/25 disabled:opacity-50 transition-colors whitespace-nowrap">
                          {loading === p.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                          Publicar
                        </button>
                      </div>
                    ))}
                  </div>
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
            <ListingProposalReview
              proposals={proposals || []}
              onApprove={approveProposal}
              onReject={rejectProposal}
              onSubmit={submitProposal}
              loading={loading}
            />
          )}

          {/* ── Issues ── */}
          {activeTab === 'issues' && (
            <ListingIssuesPanel
              issues={issues}
              missingFields={missingFields}
              asin={product.asin}
              sku={product.sku}
            />
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