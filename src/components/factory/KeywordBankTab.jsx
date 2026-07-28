/**
 * KeywordBankTab — tabela da entidade KeywordBank com filtros por
 * lifecycle_status, source_type, ASIN e keyword.
 */
import { ChevronDown } from 'lucide-react';

const LIFECYCLE_CONFIG = {
  WINNER:       { label: 'Winner',       color: 'text-emerald-400', bg: 'bg-emerald-500/15 border-emerald-500/30' },
  STRONG_WINNER:{ label: 'Strong Winner',color: 'text-emerald-300', bg: 'bg-emerald-400/20 border-emerald-400/40' },
  CANDIDATE:    { label: 'Candidato',    color: 'text-cyan',        bg: 'bg-cyan/15 border-cyan/30' },
  VALIDATING:   { label: 'Validando',    color: 'text-amber-400',   bg: 'bg-amber-500/15 border-amber-500/30' },
  SUGGESTION:   { label: 'Sugestão',     color: 'text-slate-400',   bg: 'bg-slate-500/10 border-slate-500/20' },
  FAILED:       { label: 'Falhou',       color: 'text-red-400',     bg: 'bg-red-500/15 border-red-500/30' },
  BANK_ONLY:    { label: 'No Bank',      color: 'text-slate-500',   bg: 'bg-slate-500/10 border-slate-500/20' },
  RETIRED:      { label: 'Retirado',     color: 'text-slate-600',   bg: 'bg-slate-700/15 border-slate-600/20' },
  HARVESTED:    { label: 'Colhido',      color: 'text-violet-400',  bg: 'bg-violet-500/15 border-violet-500/30' },
  SCALED:       { label: 'Escalado',     color: 'text-blue-400',    bg: 'bg-blue-500/15 border-blue-500/30' },
};

const SOURCE_LABELS = {
  AUTO_SEARCH_TERM:        'Auto ST',
  BROAD_SEARCH_TERM:       'Broad ST',
  PHRASE_SEARCH_TERM:      'Phrase ST',
  EXACT_KEYWORD:           'Exact KW',
  AMAZON_KEYWORD_SUGGESTION:'Amazon Sug.',
  AMAZON_PRODUCT_SUGGESTION:'Amazon Prod.',
  PRODUCT_TARGET_WINNER:   'Prod. Target',
  KEYWORD_BANK:            'Bank',
  HISTORICAL_WINNER:       'Histórico',
};

function LifecycleBadge({ status, winnerTier }) {
  const key = winnerTier === 'STRONG_WINNER' ? 'STRONG_WINNER' : (status || 'BANK_ONLY');
  const cfg = LIFECYCLE_CONFIG[key] || LIFECYCLE_CONFIG.BANK_ONLY;
  return (
    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${cfg.bg} ${cfg.color}`}>
      {cfg.label}
    </span>
  );
}

function SourceBadge({ source }) {
  return (
    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-surface-3 text-slate-400 border border-surface-3">
      {SOURCE_LABELS[source] || source}
    </span>
  );
}

function IntentBar({ score }) {
  const color = score >= 85 ? 'bg-emerald-500' : score >= 60 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 bg-surface-3 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${score}%` }} />
      </div>
      <span className="text-[10px] text-slate-400">{score}</span>
    </div>
  );
}

export default function KeywordBankTab({
  filteredBank,
  lifecycleFilter, setLifecycleFilter,
  sourceFilter, setSourceFilter,
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <select value={lifecycleFilter} onChange={e => setLifecycleFilter(e.target.value)}
          className="px-2 py-1.5 bg-surface-2 border border-surface-3 rounded-lg text-xs text-slate-300 focus:outline-none">
          <option value="all">Todos status</option>
          {Object.entries(LIFECYCLE_CONFIG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}
          className="px-2 py-1.5 bg-surface-2 border border-surface-3 rounded-lg text-xs text-slate-300 focus:outline-none">
          <option value="all">Todas fontes</option>
          {Object.entries(SOURCE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <span className="text-xs text-slate-500">{filteredBank.length} termos</span>
      </div>
      <div className="overflow-hidden rounded-xl border border-surface-2 bg-surface-1">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-[#0D0F14] z-10">
              <tr className="border-b border-surface-2">
                {['Keyword','ASIN','Fonte','Status','Intent','Promo','Pedidos','ACoS','CPC','Colheita'].map(h => (
                  <th key={h} className="px-3 py-2.5 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredBank.slice(0, 200).map((e, i) => (
                <tr key={e.id || i} className="border-b border-surface-2/40 hover:bg-surface-2/30">
                  <td className="px-3 py-2 max-w-[180px]">
                    <p className="text-[11px] font-medium text-white truncate">{e.keyword}</p>
                    <p className="text-[9px] text-slate-600">{e.match_type}</p>
                  </td>
                  <td className="px-3 py-2 font-mono text-[10px] text-cyan">{e.asin}</td>
                  <td className="px-3 py-2"><SourceBadge source={e.source_type} /></td>
                  <td className="px-3 py-2"><LifecycleBadge status={e.lifecycle_status} winnerTier={e.winner_tier} /></td>
                  <td className="px-3 py-2"><IntentBar score={e.intent_score || 0} /></td>
                  <td className="px-3 py-2 text-[10px] text-violet-400">{e.promotion_score || 0}</td>
                  <td className="px-3 py-2 text-emerald-400 font-semibold text-[11px]">{e.orders || 0}</td>
                  <td className="px-3 py-2">
                    <span className={`text-[10px] font-semibold ${(e.acos || 0) > (e.target_acos || 15) ? 'text-red-400' : (e.acos || 0) > 0 ? 'text-emerald-400' : 'text-slate-600'}`}>
                      {(e.acos || 0) > 0 ? `${(e.acos || 0).toFixed(1)}%` : '—'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-[10px] text-slate-400">R${(e.cpc || 0).toFixed(2)}</td>
                  <td className="px-3 py-2">
                    {e.harvest_candidate && (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400 border border-violet-500/25">
                        {e.harvest_action || 'HARVEST'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filteredBank.length > 200 && (
          <p className="text-[10px] text-slate-500 text-center py-2">Mostrando 200 de {filteredBank.length} — use filtros para refinar</p>
        )}
      </div>
    </div>
  );
}