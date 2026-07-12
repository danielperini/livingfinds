import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Check, X, Sparkles, ShieldAlert, AlertCircle, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';

const PROPOSAL_TYPE_LABELS = {
  organic_terms: 'Termos Orgânicos',
  title: 'Título',
  bullet: 'Bullet Point',
  description: 'Descrição',
  attribute: 'Atributo',
  image: 'Imagem',
  variation: 'Variação',
  price: 'Preço',
  offer: 'Oferta',
  a_plus: 'Conteúdo A+',
};

const APPROVAL_BADGES = {
  draft: 'text-slate-400 bg-slate-500/10 border-slate-500/20',
  pending_review: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  approved: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  rejected: 'text-red-400 bg-red-500/10 border-red-500/20',
  conflict: 'text-orange-400 bg-orange-500/10 border-orange-500/20',
  cancelled: 'text-slate-500 bg-slate-500/10 border-slate-500/20',
};

const SUBMISSION_BADGES = {
  not_submitted: 'text-slate-500',
  submitted: 'text-cyan',
  processing: 'text-amber-400',
  confirmed: 'text-emerald-400',
  failed: 'text-red-400',
  schema_unsupported: 'text-slate-500',
};

export default function ListingProposalReview({ proposals, onApprove, onReject, onSubmit, loading }) {
  const [expanded, setExpanded] = useState(null);
  const [editValues, setEditValues] = useState({});

  const grouped = {};
  for (const p of (proposals || [])) {
    const type = p.proposal_type || 'other';
    if (!grouped[type]) grouped[type] = [];
    grouped[type].push(p);
  }

  if (!proposals?.length) {
    return (
      <div className="text-center py-12 text-slate-500 text-sm">
        <Sparkles className="w-8 h-8 text-slate-600 mx-auto mb-3" />
        <p>Nenhuma proposta criada ainda.</p>
        <p className="text-xs mt-1">Use "Sugerir" na tabela para gerar propostas baseadas em dados reais.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {Object.entries(grouped).map(([type, typeProposals]) => (
        <div key={type} className="bg-surface-2 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-surface-3">
            <p className="text-xs font-semibold text-slate-300">{PROPOSAL_TYPE_LABELS[type] || type}</p>
          </div>
          <div className="divide-y divide-surface-3">
            {typeProposals.map(proposal => (
              <div key={proposal.id} className="p-4 space-y-3">
                {/* Header da proposta */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold border ${APPROVAL_BADGES[proposal.approval_status] || APPROVAL_BADGES.draft}`}>
                        {proposal.approval_status}
                      </span>
                      {proposal.submission_status && proposal.submission_status !== 'not_submitted' && (
                        <span className={`text-[10px] font-semibold ${SUBMISSION_BADGES[proposal.submission_status] || ''}`}>
                          → {proposal.submission_status}
                        </span>
                      )}
                      {proposal.brand_safety_status === 'brand_review_required' && (
                        <span className="flex items-center gap-1 text-[10px] text-orange-400">
                          <ShieldAlert className="w-3 h-3" /> revisão de marca
                        </span>
                      )}
                      {proposal.brand_safety_status === 'blocked' && (
                        <span className="flex items-center gap-1 text-[10px] text-red-400">
                          <ShieldAlert className="w-3 h-3" /> marca bloqueada
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-slate-500">{proposal.field_name} · confiança {proposal.confidence > 0 ? `${(proposal.confidence * 100).toFixed(0)}%` : '—'}</p>
                  </div>
                  <button onClick={() => setExpanded(expanded === proposal.id ? null : proposal.id)}
                    className="text-slate-500 hover:text-slate-300 transition-colors flex-shrink-0">
                    {expanded === proposal.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>
                </div>

                {/* Diff compacto */}
                <div className="space-y-1">
                  <div className="bg-red-500/5 border border-red-500/10 rounded p-2">
                    <p className="text-[10px] text-slate-500 mb-0.5">Atual</p>
                    <p className="text-xs text-slate-400 break-words">{(proposal.current_value || '').slice(0, 200) || '(vazio)'}</p>
                  </div>
                  <div className="bg-emerald-500/5 border border-emerald-500/10 rounded p-2">
                    <p className="text-[10px] text-slate-500 mb-0.5">Proposto</p>
                    {proposal.approval_status === 'draft' || proposal.approval_status === 'pending_review' ? (
                      <textarea
                        value={editValues[proposal.id] ?? proposal.proposed_value ?? ''}
                        onChange={e => setEditValues(v => ({ ...v, [proposal.id]: e.target.value }))}
                        rows={3}
                        className="w-full bg-transparent text-xs text-emerald-300 resize-none focus:outline-none"
                        placeholder="Valor proposto..."
                      />
                    ) : (
                      <p className="text-xs text-emerald-300 break-words">{(proposal.proposed_value || '').slice(0, 200) || '(vazio)'}</p>
                    )}
                  </div>
                </div>

                {/* Detalhes expandidos */}
                {expanded === proposal.id && (
                  <div className="space-y-2 text-[10px] text-slate-500">
                    {proposal.rationale && <p><strong className="text-slate-400">Justificativa:</strong> {proposal.rationale}</p>}
                    {proposal.source && <p><strong className="text-slate-400">Origem:</strong> {proposal.source}</p>}
                    {proposal.risk && <p><strong className="text-slate-400">Risco:</strong> {proposal.risk}</p>}
                    {proposal.amazon_issues && proposal.amazon_issues !== '[]' && (
                      <div className="bg-red-500/5 border border-red-500/10 rounded p-2">
                        <p className="text-red-400 font-semibold mb-1">Issues Amazon:</p>
                        {(JSON.parse(proposal.amazon_issues || '[]').map((iss, i) => (
                          <p key={i}>{iss.message || JSON.stringify(iss)}</p>
                        )))}
                      </div>
                    )}
                    {proposal.rejection_reason && (
                      <p className="text-red-400"><strong>Motivo rejeição:</strong> {proposal.rejection_reason}</p>
                    )}
                    {proposal.confirmed_at && (
                      <p className="text-emerald-400">✅ Confirmado pela Amazon em {new Date(proposal.confirmed_at).toLocaleString('pt-BR')}</p>
                    )}
                  </div>
                )}

                {/* Ações */}
                {['draft', 'pending_review'].includes(proposal.approval_status) && (
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={async () => {
                        const val = editValues[proposal.id];
                        if (val !== undefined && val !== proposal.proposed_value) {
                          await base44.entities.ListingEnhancementProposal.update(proposal.id, {
                            proposed_value: val,
                            approval_status: 'pending_review',
                            updated_at: new Date().toISOString(),
                          });
                        }
                        onApprove?.(proposal);
                      }}
                      disabled={!!loading}
                      className="flex items-center gap-1 px-3 py-1.5 text-[10px] font-semibold rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-50 transition-colors">
                      {loading === proposal.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                      Aprovar
                    </button>
                    <button
                      onClick={() => onReject?.(proposal)}
                      disabled={!!loading}
                      className="flex items-center gap-1 px-3 py-1.5 text-[10px] font-semibold rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 disabled:opacity-50 transition-colors">
                      <X className="w-3 h-3" /> Rejeitar
                    </button>
                  </div>
                )}

                {proposal.approval_status === 'approved' && proposal.submission_status === 'not_submitted' && (
                  <div className="pt-1">
                    <button
                      onClick={() => onSubmit?.(proposal.id)}
                      disabled={!!loading || proposal.brand_safety_status === 'blocked' || !proposal.proposed_value}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-semibold rounded-lg bg-violet-500/15 border border-violet-500/30 text-violet-300 hover:bg-violet-500/25 disabled:opacity-50 transition-colors">
                      {loading === proposal.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                      Publicar na Amazon
                    </button>
                    {(!proposal.proposed_value) && (
                      <p className="text-[10px] text-amber-400 mt-1">⚠️ Preencha o valor proposto antes de publicar.</p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}