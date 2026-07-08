import { useState } from 'react';
import { Loader2, Check, Trash2, ChevronDown, ChevronRight, Package } from 'lucide-react';

// ─── Configurações de badges ──────────────────────────────────────────────────

const TERM_TYPE_CONFIG = {
  primary_high_conversion:    { label: 'Principal',    color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  mid_tail:                   { label: 'Cauda média',  color: 'text-cyan bg-cyan/10 border-cyan/20' },
  long_tail:                  { label: 'Cauda longa',  color: 'text-blue-400 bg-blue-500/10 border-blue-500/20' },
  alternative_purchase_intent:{ label: 'Alternativo',  color: 'text-violet-400 bg-violet-500/10 border-violet-500/20' },
  general:                    { label: 'Geral',        color: 'text-slate-400 bg-slate-500/10 border-slate-500/20' },
};

const PROMOTION_STATUS_CONFIG = {
  kickoff_candidate:   { label: 'Kick-off',    color: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  promoted_to_manual:  { label: 'Manual',      color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  in_auto_campaign:    { label: 'Auto camp.',  color: 'text-cyan bg-cyan/10 border-cyan/20' },
  pending:             { label: 'Pendente',    color: 'text-slate-400 bg-slate-500/10 border-slate-500/20' },
  rejected:            { label: 'Rejeitado',   color: 'text-red-400 bg-red-500/10 border-red-500/20' },
};

const SOURCE_LABEL = {
  product_title_ai_analysis: 'IA — título',
  deterministic_title_parser: 'Parser título',
  ai_suggestion:              'IA',
  search_term_auto:           'Search term',
  manual_kickoff:             'Kick-off manual',
  user_input:                 'Manual',
  cross_asin:                 'Cross-ASIN',
  csv_import:                 'CSV',
};

const CAMP_STATUS_CONFIG = {
  enabled:   { label: 'Campanha ativa',     color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
  active:    { label: 'Campanha ativa',     color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
  incomplete:{ label: 'Incompleta',         color: 'text-amber-400 bg-amber-400/10 border-amber-400/20' },
  paused:    { label: 'Pausada',            color: 'text-slate-400 bg-slate-400/10 border-slate-400/20' },
  archived:  { label: 'Arquivada',          color: 'text-slate-500 bg-slate-500/10 border-slate-500/20' },
  failed:    { label: 'Falha ao criar',     color: 'text-red-400 bg-red-400/10 border-red-400/20' },
  created:   { label: 'Campanha criada',    color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
  approved:  { label: 'Criando campanha…', color: 'text-cyan bg-cyan/10 border-cyan/20' },
};

function Badge({ cfg }) {
  if (!cfg) return null;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${cfg.color}`}>
      {cfg.label}
    </span>
  );
}

function ConfidencePill({ value }) {
  const conf = value == null ? 0 : value <= 1 ? Math.round(value * 100) : Math.round(value);
  const color = conf >= 90 ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/25'
    : conf >= 85 ? 'text-cyan bg-cyan/10 border-cyan/25'
    : conf >= 75 ? 'text-amber-400 bg-amber-500/10 border-amber-500/25'
    : 'text-red-400 bg-red-500/10 border-red-500/25';
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-bold ${color}`}>
      {conf}%
    </span>
  );
}

// ─── Linha de sugestão (dentro do grupo de produto) ──────────────────────────

function SuggestionRow({ s, busy, onReview }) {
  const campStatus = s.campaign_status || (
    s.status === 'created' ? 'enabled'
    : s.status === 'approved' ? 'approved'
    : s.status === 'failed' ? 'failed'
    : null
  );
  const isDone = ['created', 'approved'].includes(s.status) || !!campStatus;
  const isFailed = s.status === 'failed' || campStatus === 'failed';

  const termType = TERM_TYPE_CONFIG[s.term_type] || null;
  const promoStatus = PROMOTION_STATUS_CONFIG[s.promotion_status] || null;
  const sourceLabel = SOURCE_LABEL[s.source] || s.source || 'IA';
  const rawConf = s.confidence || s.relevance_score;
  const keyword = s.keyword || s.term || '—';

  return (
    <div className="flex items-start gap-3 py-3 px-4 border-b border-surface-2/40 last:border-0 hover:bg-surface-2/20 transition-colors">
      {/* Termo + badges de tipo */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className="text-sm font-semibold text-white">{keyword}</span>
          {termType && <Badge cfg={termType} />}
          {promoStatus && <Badge cfg={promoStatus} />}
        </div>
        <div className="flex items-center gap-2 flex-wrap text-[10px] text-slate-500">
          <span>{sourceLabel}</span>
          {s.reason && <span>· {s.reason}</span>}
          {campStatus && (
            <Badge cfg={CAMP_STATUS_CONFIG[campStatus] || { label: campStatus, color: 'text-slate-400 bg-slate-500/10 border-slate-500/20' }} />
          )}
          {s.error && <span className="text-red-400">⚠ {s.error}</span>}
        </div>
      </div>

      {/* Confidence */}
      <div className="flex-shrink-0">
        <ConfidencePill value={rawConf} />
      </div>

      {/* Match type */}
      <div className="flex-shrink-0 text-[10px] text-slate-500 w-14 text-right">
        {s.recommended_match_type || s.match_type || '—'}
      </div>

      {/* Ações */}
      <div className="flex-shrink-0 flex gap-1.5">
        {busy ? (
          <span className="flex items-center gap-1 rounded-lg bg-cyan/10 border border-cyan/20 px-2.5 py-1.5 text-xs text-cyan">
            <Loader2 className="h-3 w-3 animate-spin" /> Criando…
          </span>
        ) : isDone && !isFailed ? (
          <span className="flex items-center gap-1 rounded-lg bg-emerald-500/10 border border-emerald-500/15 px-2.5 py-1.5 text-xs text-emerald-400">
            <Check className="h-3 w-3" /> Criada
          </span>
        ) : isFailed ? (
          <button onClick={() => onReview(s, 'approve')}
            className="rounded-lg bg-amber-500/15 border border-amber-500/20 px-2.5 py-1.5 text-xs font-semibold text-amber-300 hover:bg-amber-500/25 transition-colors">
            Tentar novamente
          </button>
        ) : (
          <button onClick={() => onReview(s, 'approve')}
            className="flex items-center gap-1 rounded-lg bg-emerald-500/15 border border-emerald-500/20 px-2.5 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/25 transition-colors">
            <Check className="h-3 w-3" /> Aprovar
          </button>
        )}
        {!['created', 'approved'].includes(s.status) && !busy && (
          <button onClick={() => onReview(s, 'delete')}
            className="rounded-lg bg-red-500/10 border border-red-500/15 px-2 py-1.5 text-xs text-red-400 hover:bg-red-500/20 transition-colors">
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Grupo por produto ────────────────────────────────────────────────────────

function ProductGroup({ asin, productName, items, workingId, onReview }) {
  const [open, setOpen] = useState(true);
  const kickoffCount = items.filter(s => s.promotion_status === 'kickoff_candidate').length;
  const highConf = items.filter(s => {
    const c = s.confidence || s.relevance_score || 0;
    return (c <= 1 ? c * 100 : c) >= 90;
  }).length;

  return (
    <div className="border border-surface-2 rounded-xl overflow-hidden mb-3">
      {/* Cabeçalho do grupo */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 bg-surface-2/40 hover:bg-surface-2/60 transition-colors text-left"
      >
        <div className="flex-shrink-0 text-slate-400">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </div>
        <Package className="h-4 w-4 text-slate-500 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white truncate">{productName || 'Produto não identificado'}</p>
          <p className="text-[10px] font-mono text-cyan">{asin}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-[10px] text-slate-400">{items.length} termo{items.length !== 1 ? 's' : ''}</span>
          {kickoffCount > 0 && (
            <span className="text-[10px] font-semibold text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-full px-2 py-0.5">
              {kickoffCount} kick-off
            </span>
          )}
          {highConf > 0 && (
            <span className="text-[10px] font-semibold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-2 py-0.5">
              {highConf} conf≥90%
            </span>
          )}
        </div>
      </button>

      {/* Linhas de sugestão */}
      {open && (
        <div>
          {/* Sub-cabeçalho de colunas */}
          <div className="flex items-center gap-3 px-4 py-1.5 bg-surface-2/20 border-b border-surface-2/40">
            <span className="flex-1 text-[10px] uppercase text-slate-600">Termo / Tipo / Origem</span>
            <span className="flex-shrink-0 w-12 text-[10px] uppercase text-slate-600 text-right">Conf.</span>
            <span className="flex-shrink-0 w-14 text-[10px] uppercase text-slate-600 text-right">Match</span>
            <span className="flex-shrink-0 w-32 text-[10px] uppercase text-slate-600 text-right">Ação</span>
          </div>
          {items.map(s => (
            <SuggestionRow key={s.id} s={s} busy={workingId === s.id} onReview={onReview} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Painel principal ─────────────────────────────────────────────────────────

const TERM_TYPE_ORDER = ['primary_high_conversion', 'mid_tail', 'long_tail', 'alternative_purchase_intent', 'general'];

export default function SuggestionsPanel({ suggestions, products, workingId, onReview }) {
  const productMap = Object.fromEntries(products.map(p => [p.asin, p]));

  if (suggestions.length === 0) {
    return (
      <div className="rounded-xl border border-surface-2 bg-surface-1 px-4 py-12 text-center text-sm text-slate-500">
        Nenhuma sugestão encontrada. Use "Gerar com IA" ou "Produtos novos" para criar termos.
      </div>
    );
  }

  // Agrupar por ASIN, ordenar por term_type priority e depois confidence desc
  const groups = {};
  for (const s of suggestions) {
    const key = s.asin || '__no_asin__';
    if (!groups[key]) groups[key] = [];
    groups[key].push(s);
  }

  // Ordenar itens dentro de cada grupo
  for (const key of Object.keys(groups)) {
    groups[key].sort((a, b) => {
      const ta = TERM_TYPE_ORDER.indexOf(a.term_type);
      const tb = TERM_TYPE_ORDER.indexOf(b.term_type);
      const typeDiff = (ta === -1 ? 99 : ta) - (tb === -1 ? 99 : tb);
      if (typeDiff !== 0) return typeDiff;
      const ca = a.confidence || a.relevance_score || 0;
      const cb = b.confidence || b.relevance_score || 0;
      const confA = ca <= 1 ? ca * 100 : ca;
      const confB = cb <= 1 ? cb * 100 : cb;
      return confB - confA;
    });
  }

  // Ordenar grupos: mais termos e maior confiança média primeiro
  const sortedAsins = Object.keys(groups).sort((a, b) => {
    const avgConf = (items) => {
      const vals = items.map(s => { const c = s.confidence || s.relevance_score || 0; return c <= 1 ? c * 100 : c; });
      return vals.reduce((s, v) => s + v, 0) / (vals.length || 1);
    };
    return avgConf(groups[b]) - avgConf(groups[a]);
  });

  return (
    <div>
      {sortedAsins.map(asin => {
        const p = productMap[asin];
        const name = p?.product_name || p?.display_name || groups[asin][0]?.product_name || '';
        return (
          <ProductGroup
            key={asin}
            asin={asin === '__no_asin__' ? '—' : asin}
            productName={name}
            items={groups[asin]}
            workingId={workingId}
            onReview={onReview}
          />
        );
      })}
    </div>
  );
}