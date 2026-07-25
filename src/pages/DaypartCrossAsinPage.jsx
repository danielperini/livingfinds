import { useState, useEffect, useCallback, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { usePerformanceData } from '@/hooks/usePerformanceData';
import {
  Clock, Loader2, CheckCircle, XCircle,
  AlertTriangle, ArrowRightLeft, Zap, Play, Search
} from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid
} from 'recharts';

const DAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];

const DECISION_COLORS = {
  BID_UP:            'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  BID_DOWN_ACOS:     'text-red-400 bg-red-500/10 border-red-500/20',
  BID_DOWN_CVR:      'text-orange-400 bg-orange-500/10 border-orange-500/20',
  NO_SALES_SOFT:     'text-amber-400 bg-amber-500/10 border-amber-500/20',
  NO_SALES_HARD:     'text-red-500 bg-red-600/10 border-red-600/20',
  MAINTAIN:          'text-slate-400 bg-slate-500/10 border-slate-500/20',
  BLOCK_LOW_TIME:    'text-slate-500 bg-slate-600/10 border-slate-600/20',
  BUDGET_PROTECTION: 'text-cyan bg-cyan/10 border-cyan/20',
  WAIT:              'text-slate-500 bg-slate-600/10 border-slate-600/20',
};

const SLOT_COLORS = {
  ELITE_TIME:      'text-emerald-300 bg-emerald-500/15 border border-emerald-500/25',
  STRONG_TIME:     'text-cyan bg-cyan/15 border border-cyan/25',
  NORMAL_TIME:     'text-slate-300 bg-slate-500/10 border border-slate-500/20',
  WEAK_TIME:       'text-amber-400 bg-amber-500/10 border border-amber-500/20',
  LOSS_TIME:       'text-red-400 bg-red-500/10 border border-red-500/20',
  COLLECTING_DATA: 'text-slate-500 bg-slate-700/20 border border-slate-700/20',
};

const TRANSFER_COLORS = {
  HIGH_CONFIDENCE_TRANSFER: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  MANUAL_REVIEW:            'text-amber-400 bg-amber-500/10 border-amber-500/20',
  DO_NOT_TRANSFER:          'text-red-400 bg-red-500/10 border-red-500/20',
  TRANSFER_EXECUTED:        'text-cyan bg-cyan/10 border-cyan/20',
  FAILED_CROSS_ASIN:        'text-red-500 bg-red-600/10 border-red-600/20',
};

function StatusBadge({ value, map }) {
  const cls = map[value] || 'text-slate-400 bg-slate-500/10 border-slate-500/20';
  return (
    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded border ${cls} whitespace-nowrap`}>
      {value}
    </span>
  );
}

function BidChartTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-[#111827] border border-surface-3 rounded-lg px-3 py-2 text-xs shadow-xl">
      <p className="text-slate-300 font-semibold mb-0.5">Hora {d.hour}h</p>
      <p className="text-cyan">Bid médio: <span className="font-bold">R${d.avg_bid.toFixed(2)}</span></p>
      <p className="text-slate-500">{d.count} decisão{d.count !== 1 ? 'ões' : ''}</p>
    </div>
  );
}

// Fetch único de todos os dados da página (usado pelo cache)
async function fetchDaypartData(accountId) {
  const [allDecisions, campaigns, transfers, familyBank] = await Promise.all([
    base44.entities.DaypartingDecision.filter({ amazon_account_id: accountId }, '-created_date', 700),
    base44.entities.Campaign.filter({ amazon_account_id: accountId }, null, 500).catch(() => []),
    base44.entities.CrossAsinTransfer.filter({ amazon_account_id: accountId }, '-created_date', 200),
    base44.entities.ProductFamilyKeywordBank.filter({ amazon_account_id: accountId }, '-winning_asin_count', 50).catch(() => []),
  ]);
  return { allDecisions, campaigns, transfers, familyBank };
}

// ── Dayparting Tab ────────────────────────────────────────────────────────
function DaypartingTab({ data, loading, onLocalUpdate }) {
  const [executing, setExecuting] = useState({});
  const [filter, setFilter]       = useState('pending_approval');
  const [search, setSearch]       = useState('');

  const allDecisions = data?.allDecisions || [];
  const campaigns    = data?.campaigns    || [];

  // Derivados em memória — sem queries ao trocar filtro
  const decisions         = useMemo(() => filter === 'all' ? allDecisions : allDecisions.filter(d => d.status === filter), [allDecisions, filter]);
  const executedDecisions = useMemo(() => allDecisions.filter(d => d.status === 'executed'), [allDecisions]);

  const approveDecision = async (dec) => {
    try {
      await base44.entities.DaypartingDecision.update(dec.id, { status: 'approved', approved_at: new Date().toISOString() });
      onLocalUpdate(prev => ({ ...prev, allDecisions: prev.allDecisions.map(d => d.id === dec.id ? { ...d, status: 'approved' } : d) }));
    } catch {}
  };

  const rejectDecision = async (dec) => {
    try {
      await base44.entities.DaypartingDecision.update(dec.id, { status: 'rejected', rejected_at: new Date().toISOString() });
      onLocalUpdate(prev => ({ ...prev, allDecisions: prev.allDecisions.map(d => d.id === dec.id ? { ...d, status: 'rejected' } : d) }));
    } catch {}
  };

  const executeDecision = async (dec) => {
    if (executing[dec.id]) return;
    setExecuting(prev => ({ ...prev, [dec.id]: true }));
    try {
      const res = await base44.functions.invoke('executeDaypartingDecision', { decision_id: dec.id, amazon_account_id: data?.accountId });
      if (res?.data?.ok) onLocalUpdate(prev => ({ ...prev, allDecisions: prev.allDecisions.map(d => d.id === dec.id ? { ...d, status: 'executed' } : d) }));
    } catch {}
    finally { setExecuting(prev => ({ ...prev, [dec.id]: false })); }
  };

  const filtered = decisions.filter(d => !search || (d.keyword_text || '').toLowerCase().includes(search.toLowerCase()));

  const pending  = allDecisions.filter(d => d.status === 'pending_approval').length;
  const approved = allDecisions.filter(d => d.status === 'approved').length;
  const executed = allDecisions.filter(d => d.status === 'executed').length;
  const bidUp    = allDecisions.filter(d => d.decision_type === 'BID_UP').length;

  const bidByHour = useMemo(() => {
    const map = {};
    for (const d of executedDecisions) {
      const h = d.hour ?? -1;
      if (h < 0 || h > 23) continue;
      const bid = Number(d.proposed_bid || 0);
      if (bid <= 0) continue;
      if (!map[h]) map[h] = { sum: 0, count: 0 };
      map[h].sum += bid;
      map[h].count += 1;
    }
    return Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      avg_bid: map[h] ? parseFloat((map[h].sum / map[h].count).toFixed(2)) : 0,
      count: map[h]?.count || 0,
    }));
  }, [executedDecisions]);

  const campaignsNoBudget = useMemo(() => campaigns.filter(c => {
    const state = (c.state || c.status || '').toLowerCase();
    if (state === 'archived') return false;
    return Number(c.daily_budget || 0) <= 0;
  }), [campaigns]);

  const X_LABELS_SHOW = new Set([0, 6, 12, 18, 23]);

  return (
    <div className="p-4 space-y-4">
      {/* KPIs */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: 'Pendentes', value: pending,  color: 'text-amber-400' },
          { label: 'Aprovadas', value: approved, color: 'text-cyan' },
          { label: 'Executadas', value: executed, color: 'text-emerald-400' },
          { label: 'BID_UP',    value: bidUp,    color: 'text-emerald-300' },
        ].map(k => (
          <div key={k.label} className="bg-surface-2 rounded-xl p-3 border border-surface-3">
            <p className="text-[10px] text-slate-500 mb-1">{k.label}</p>
            <p className={`text-xl font-bold ${k.color}`}>{k.value}</p>
          </div>
        ))}
      </div>

      {/* Gráfico + Alerta orçamento */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="bg-surface-2 rounded-xl border border-surface-3 p-4">
          <p className="text-xs font-semibold text-slate-300 mb-3">Bid médio por hora (decisões executadas)</p>
          {executedDecisions.length === 0 ? (
            <div className="h-[180px] flex items-center justify-center text-slate-600 text-xs">Sem decisões executadas ainda.</div>
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={bidByHour} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke="#1E2A40" />
                <XAxis dataKey="hour" tick={{ fontSize: 10, fill: '#94A3B8' }} tickLine={false} axisLine={false}
                  tickFormatter={h => X_LABELS_SHOW.has(h) ? `${h}h` : ''} />
                <YAxis tick={{ fontSize: 10, fill: '#94A3B8' }} tickLine={false} axisLine={false}
                  tickFormatter={v => v > 0 ? `R$${v.toFixed(2)}` : ''} width={48} />
                <Tooltip content={<BidChartTooltip />} />
                <Line dataKey="avg_bid" stroke="#3B82F6" strokeWidth={2}
                  dot={({ cx, cy, payload }) => payload.avg_bid
                    ? <circle key={`dot-${payload.hour}`} cx={cx} cy={cy} r={3} fill="#3B82F6" stroke="none" />
                    : <circle key={`dot-${payload.hour}`} r={0} />}
                  activeDot={{ r: 5 }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        {campaignsNoBudget.length > 0 && (
          <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
              <p className="text-xs font-semibold text-amber-300">{campaignsNoBudget.length} campanha{campaignsNoBudget.length !== 1 ? 's' : ''} sem orçamento diário</p>
            </div>
            <div className="space-y-1.5 max-h-[148px] overflow-y-auto scrollbar-thin">
              {campaignsNoBudget.map((c, i) => (
                <div key={c.id || i} className="flex items-center gap-2 py-1 border-b border-amber-500/10 last:border-0">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-slate-300 truncate font-medium">{c.name || c.campaign_name || '—'}</p>
                    {c.asin && <p className="text-[9px] font-mono text-slate-500">{c.asin}</p>}
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-slate-700/50 text-slate-400 border border-slate-600/30">
                      {(c.targeting_type || '').toUpperCase() === 'AUTO' ? 'AUTO' : 'MANUAL'}
                    </span>
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-400 border border-orange-500/30">SEM ORÇAMENTO</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
        <Clock className="w-3 h-3" /> Motor executado automaticamente pelo orquestrador diário
      </div>

      {/* Filtros */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar keyword..."
            className="pl-7 pr-3 py-1.5 bg-surface-2 border border-surface-3 rounded-lg text-xs text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan/40 w-44" />
        </div>
        {['all','pending_approval','approved','executed','rejected'].map(s => (
          <button key={s} onClick={() => setFilter(s)}
            className={`px-2.5 py-1 text-[10px] font-medium rounded transition-colors ${filter === s ? 'bg-cyan/20 text-cyan border border-cyan/30' : 'text-slate-500 hover:text-slate-300'}`}>
            {s === 'all' ? 'Todas' : s.replace('_', ' ')}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-slate-500">
          <Clock className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p className="text-sm">Nenhuma decisão encontrada.</p>
        </div>
      ) : (
        <div className="bg-surface-2 rounded-xl border border-surface-3 overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-[#0D0F14] border-b border-surface-3">
                {['Slot','Keyword','Tipo','Score','Bid Atual','Bid Proposto','Δ%','ACoS Slot','CVR Slot','CPC Sust.','Confiança','Status','Ação'].map(h => (
                  <th key={h} className="px-3 py-2.5 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((d, i) => (
                <tr key={d.id || i} className="border-b border-surface-3/40 hover:bg-surface-3/20">
                  <td className="px-3 py-2.5">
                    <div className="text-[10px] font-semibold text-slate-300">{DAY_LABELS[d.day_of_week]} {d.hour}h</div>
                    <StatusBadge value={d.slot_classification || 'COLLECTING_DATA'} map={SLOT_COLORS} />
                  </td>
                  <td className="px-3 py-2.5 max-w-[140px]">
                    <p className="text-slate-200 truncate font-medium">{d.keyword_text || '—'}</p>
                    <p className="text-[9px] text-slate-500">{d.asin}</p>
                  </td>
                  <td className="px-3 py-2.5"><StatusBadge value={d.decision_type} map={DECISION_COLORS} /></td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1">
                      <div className="w-12 h-1.5 bg-surface-3 rounded-full overflow-hidden">
                        <div className="h-full bg-cyan rounded-full" style={{ width: `${d.time_slot_score || 0}%` }} />
                      </div>
                      <span className="text-slate-300 font-mono">{d.time_slot_score || 0}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-slate-400 font-mono">R${(d.current_bid||0).toFixed(2)}</td>
                  <td className="px-3 py-2.5 text-white font-mono font-semibold">R${(d.proposed_bid||0).toFixed(2)}</td>
                  <td className="px-3 py-2.5">
                    <span className={`font-semibold font-mono ${(d.bid_change_pct||0) > 0 ? 'text-emerald-400' : (d.bid_change_pct||0) < 0 ? 'text-red-400' : 'text-slate-400'}`}>
                      {(d.bid_change_pct||0) > 0 ? '+' : ''}{(d.bid_change_pct||0).toFixed(1)}%
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`font-mono font-semibold ${(d.slot_acos||0) > (d.target_acos||15) ? 'text-red-400' : 'text-emerald-400'}`}>
                      {(d.slot_acos||0).toFixed(1)}%
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-slate-300 font-mono">{((d.slot_cvr||0)*100).toFixed(1)}%</td>
                  <td className="px-3 py-2.5 text-cyan font-mono">R${(d.sustainable_cpc||0).toFixed(2)}</td>
                  <td className="px-3 py-2.5">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${d.data_confidence === 'VERY_HIGH' ? 'bg-emerald-500/15 text-emerald-400' : d.data_confidence === 'HIGH' ? 'bg-cyan/15 text-cyan' : d.data_confidence === 'MEDIUM' ? 'bg-amber-500/10 text-amber-400' : 'bg-slate-700/30 text-slate-500'}`}>
                      {d.data_confidence}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${d.status === 'executed' ? 'bg-emerald-500/15 text-emerald-400' : d.status === 'approved' ? 'bg-cyan/15 text-cyan' : d.status === 'rejected' ? 'bg-red-500/15 text-red-400' : d.status === 'expired' ? 'bg-slate-700/30 text-slate-500' : 'bg-amber-500/10 text-amber-400'}`}>
                      {d.status}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1">
                      {d.status === 'pending_approval' ? (
                        <>
                          <button onClick={() => approveDecision(d)} className="p-1 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20" title="Aprovar">
                            <CheckCircle className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => rejectDecision(d)} className="p-1 rounded bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20" title="Rejeitar">
                            <XCircle className="w-3.5 h-3.5" />
                          </button>
                        </>
                      ) : d.status === 'approved' ? (
                        <button onClick={() => executeDecision(d)} disabled={executing[d.id]} className="p-1 rounded bg-cyan/10 border border-cyan/20 text-cyan hover:bg-cyan/20 disabled:opacity-50" title="Executar na Amazon">
                          {executing[d.id] ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Cross-ASIN Tab ────────────────────────────────────────────────────────
function CrossAsinTab({ data, loading, onLocalUpdate }) {
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  const transfers  = data?.transfers  || [];
  const familyBank = data?.familyBank || [];

  const updateStatus = async (transfer, newStatus) => {
    try {
      await base44.entities.CrossAsinTransfer.update(transfer.id, {
        status: newStatus,
        [newStatus === 'APPROVED' ? 'approved_at' : 'failed_at']: new Date().toISOString(),
      });
      onLocalUpdate(prev => ({ ...prev, transfers: prev.transfers.map(t => t.id === transfer.id ? { ...t, status: newStatus } : t) }));
    } catch {}
  };

  const filtered = transfers.filter(t => {
    if (filter !== 'all' && t.transfer_decision !== filter && t.status !== filter) return false;
    if (search && !(t.keyword || '').toLowerCase().includes(search.toLowerCase()) &&
        !(t.source_asin || '').toLowerCase().includes(search.toLowerCase()) &&
        !(t.destination_asin || '').toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const proposed  = transfers.filter(t => t.transfer_decision === 'HIGH_CONFIDENCE_TRANSFER').length;
  const manualRev = transfers.filter(t => t.transfer_decision === 'MANUAL_REVIEW').length;
  const executed  = transfers.filter(t => t.status === 'EXECUTED' || t.status === 'TRANSFER_EXECUTED').length;

  return (
    <div className="p-4 space-y-4">
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: 'Alta Confiança', value: proposed,  color: 'text-emerald-400' },
          { label: 'Revisão Manual', value: manualRev, color: 'text-amber-400' },
          { label: 'Executadas',     value: executed,  color: 'text-cyan' },
          { label: 'Family Bank',    value: familyBank.filter(f => f.high_confidence_transfer).length, color: 'text-violet-400' },
        ].map(k => (
          <div key={k.label} className="bg-surface-2 rounded-xl p-3 border border-surface-3">
            <p className="text-[10px] text-slate-500 mb-1">{k.label}</p>
            <p className={`text-xl font-bold ${k.color}`}>{k.value}</p>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
        <Clock className="w-3 h-3" /> Análise Cross-ASIN executada automaticamente pelo orquestrador diário
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar keyword ou ASIN..."
            className="pl-7 pr-3 py-1.5 bg-surface-2 border border-surface-3 rounded-lg text-xs text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan/40 w-52" />
        </div>
        {['all','HIGH_CONFIDENCE_TRANSFER','MANUAL_REVIEW','DO_NOT_TRANSFER'].map(s => (
          <button key={s} onClick={() => setFilter(s)}
            className={`px-2.5 py-1 text-[10px] font-medium rounded transition-colors ${filter === s ? 'bg-cyan/20 text-cyan border border-cyan/30' : 'text-slate-500 hover:text-slate-300'}`}>
            {s === 'all' ? 'Todas' : s.replace(/_/g, ' ')}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-slate-500">
          <ArrowRightLeft className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p className="text-sm">Nenhuma transferência encontrada. O motor analisa oportunidades diariamente.</p>
        </div>
      ) : (
        <div className="bg-surface-2 rounded-xl border border-surface-3 overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-[#0D0F14] border-b border-surface-3">
                {['Keyword','ASIN Origem','ASIN Destino','Score','Fase','Winner Tier','Bid Inicial','Decisão','Confiança','Fase LLM','Ação'].map(h => (
                  <th key={h} className="px-3 py-2.5 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((t, i) => (
                <tr key={t.id || i} className="border-b border-surface-3/40 hover:bg-surface-3/20">
                  <td className="px-3 py-2.5 font-medium text-slate-200 max-w-[120px] truncate">{t.keyword || '—'}</td>
                  <td className="px-3 py-2.5 font-mono text-cyan text-[10px]">{t.source_asin}</td>
                  <td className="px-3 py-2.5">
                    <p className="font-mono text-slate-300 text-[10px]">{t.destination_asin}</p>
                    <p className="text-[9px] text-slate-500 truncate max-w-[100px]">{t.destination_product_name}</p>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1">
                      <div className="w-10 h-1.5 bg-surface-3 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${(t.relevance_score||0) >= 90 ? 'bg-emerald-400' : (t.relevance_score||0) >= 80 ? 'bg-amber-400' : 'bg-red-400'}`} style={{ width: `${t.relevance_score||0}%` }} />
                      </div>
                      <span className="font-mono font-semibold text-white">{t.relevance_score||0}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-[10px] text-slate-400">{t.relevance_phase || '—'}</td>
                  <td className="px-3 py-2.5">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${t.source_winner_tier === 'STRONG_WINNER' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-cyan/10 text-cyan'}`}>
                      {t.source_winner_tier || '—'}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 font-mono text-white">R${(t.initial_bid||0).toFixed(2)}</td>
                  <td className="px-3 py-2.5"><StatusBadge value={t.transfer_decision} map={TRANSFER_COLORS} /></td>
                  <td className="px-3 py-2.5">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${t.transfer_confidence === 'VERY_HIGH' ? 'bg-emerald-500/15 text-emerald-400' : t.transfer_confidence === 'HIGH' ? 'bg-cyan/15 text-cyan' : 'bg-amber-500/10 text-amber-400'}`}>
                      {t.transfer_confidence || 'MEDIUM'}
                    </span>
                    {t.family_bank_boost ? <span className="ml-1 text-[9px] text-violet-400">★ Family</span> : null}
                  </td>
                  <td className="px-3 py-2.5 text-[10px]">
                    {t.llm_reason ? (
                      <span className="text-slate-400" title={t.llm_reason}>
                        {t.relevance_phase === 'LLM_VALIDATED' ? '🤖 ' : '⚡ '}
                        {t.llm_reason.slice(0, 40)}{t.llm_reason.length > 40 ? '…' : ''}
                      </span>
                    ) : <span className="text-slate-600">Heurística</span>}
                  </td>
                  <td className="px-3 py-2.5">
                    {t.status === 'PROPOSED' && t.transfer_decision === 'HIGH_CONFIDENCE_TRANSFER' ? (
                      <div className="flex items-center gap-1">
                        <button onClick={() => updateStatus(t, 'APPROVED')} className="p-1 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20" title="Aprovar">
                          <CheckCircle className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => updateStatus(t, 'REJECTED')} className="p-1 rounded bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20" title="Rejeitar">
                          <XCircle className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${t.status === 'EXECUTED' ? 'bg-emerald-500/15 text-emerald-400' : t.status === 'REJECTED' ? 'bg-red-500/15 text-red-400' : t.status === 'APPROVED' ? 'bg-cyan/15 text-cyan' : 'bg-slate-700/30 text-slate-500'}`}>
                        {t.status}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {familyBank.length > 0 && (
        <div className="bg-surface-2 rounded-xl border border-surface-3 p-4">
          <h3 className="text-xs font-semibold text-slate-300 mb-3 flex items-center gap-2">
            <Zap className="w-3.5 h-3.5 text-violet-400" />
            Product Family Keyword Bank ({familyBank.length} famílias)
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {familyBank.slice(0, 10).map((f, i) => (
              <div key={f.id || i} className="flex items-center justify-between p-2.5 bg-surface-3/30 rounded-lg border border-surface-3/50">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-slate-200 truncate">{f.keyword}</p>
                  <p className="text-[10px] text-slate-500">{f.family_name}</p>
                </div>
                <div className="flex items-center gap-2 ml-2 flex-shrink-0">
                  <span className="text-[10px] text-emerald-400 font-semibold">{f.winning_asin_count} ASINs</span>
                  {f.high_confidence_transfer && (
                    <span className="text-[9px] bg-violet-500/15 text-violet-400 border border-violet-500/20 px-1.5 py-0.5 rounded font-medium">AUTO</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────
export default function DaypartCrossAsinPage() {
  const [account, setAccount]   = useState(null);
  const [activeTab, setActiveTab] = useState('dayparting');

  useEffect(() => {
    (async () => {
      try {
        const me   = await base44.auth.me();
        const accs = await base44.entities.AmazonAccount.filter({ user_id: me.id }, null, 1);
        setAccount(accs[0] || null);
      } catch {}
    })();
  }, []);

  // fetchFn estável (não recria a cada render)
  const fetchFn = useCallback(fetchDaypartData, []);

  // Um único fetch para todos os dados da página — ambas as abas consomem do mesmo cache
  const { data, loading } = usePerformanceData('dayparting', account?.id, fetchFn);

  // Permite mutações otimistas locais sem invalidar o cache
  const [localData, setLocalData] = useState(null);
  useEffect(() => { setLocalData(data); }, [data]);

  const activeData = localData || data;

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b border-surface-2 bg-surface-1 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-violet-500/20 border border-violet-500/30 flex items-center justify-center">
              <Clock className="w-4 h-4 text-violet-400" />
            </div>
            <div>
              <h1 className="text-base font-bold text-white">Dayparting & Cross-ASIN Transfer</h1>
              <p className="text-xs text-slate-400">Motor determinístico de otimização por horário e transferência de keywords entre ASINs</p>
            </div>
          </div>
          {loading && (
            <Loader2 className="w-4 h-4 text-slate-500 animate-spin" />
          )}
        </div>
      </div>

      <div className="flex border-b border-surface-2 bg-[#0D0F14] flex-shrink-0">
        {[
          { key: 'dayparting', label: 'Dayparting',          icon: Clock },
          { key: 'crossasin',  label: 'Cross-ASIN Transfer', icon: ArrowRightLeft },
        ].map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-2 px-5 py-3 text-xs font-semibold border-b-2 transition-colors ${activeTab === tab.key ? 'border-cyan text-cyan' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
            <tab.icon className="w-3.5 h-3.5" />
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {activeTab === 'dayparting'
          ? <DaypartingTab data={activeData} loading={loading} onLocalUpdate={setLocalData} />
          : <CrossAsinTab  data={activeData} loading={loading} onLocalUpdate={setLocalData} />}
      </div>
    </div>
  );
}