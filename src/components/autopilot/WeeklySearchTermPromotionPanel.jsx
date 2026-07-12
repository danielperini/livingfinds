import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { Search, Play, Wrench, RefreshCw, CheckCircle, AlertTriangle, Loader2, ChevronDown, ChevronUp, Clock } from 'lucide-react';

const STATUS_COLORS = {
  completed: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
  manual_active: 'text-cyan bg-cyan/10 border-cyan/20',
  repair_required: 'text-amber-400 bg-amber-400/10 border-amber-400/20',
  failed_retryable: 'text-orange-400 bg-orange-400/10 border-orange-400/20',
  failed_permanent: 'text-red-400 bg-red-400/10 border-red-400/20',
  campaign_created: 'text-blue-400 bg-blue-400/10 border-blue-400/20',
  ad_group_created: 'text-blue-400 bg-blue-400/10 border-blue-400/20',
  product_ad_created: 'text-blue-400 bg-blue-400/10 border-blue-400/20',
  keyword_created: 'text-blue-400 bg-blue-400/10 border-blue-400/20',
  validated: 'text-slate-300 bg-slate-400/10 border-slate-400/20',
  identified: 'text-slate-400 bg-slate-500/10 border-slate-500/20',
};

const STATUS_LABELS = {
  completed: 'Concluído', manual_active: 'Campanha ativa', repair_required: 'Reparar',
  failed_retryable: 'Falha (retry)', failed_permanent: 'Falha definitiva',
  campaign_created: 'Camp. criada', ad_group_created: 'AG criado',
  product_ad_created: 'Product ad ok', keyword_created: 'Keyword criada',
  validated: 'Validado', identified: 'Identificado',
  campaign_creating: 'Criando...', enabling: 'Ativando...',
  negative_creating: 'Negativando...', negative_created: 'Negativa ok',
};

export default function WeeklySearchTermPromotionPanel({ account }) {
  const [promos, setPromos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [msg, setMsg] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [filterStatus, setFilterStatus] = useState('all');

  const loadPromos = useCallback(async () => {
    if (!account?.id) return;
    setLoading(true);
    try {
      const data = await base44.entities.SearchTermPromotion.filter({ amazon_account_id: account.id }, '-created_at', 200);
      setPromos(data);
    } finally {
      setLoading(false);
    }
  }, [account?.id]);

  useEffect(() => { loadPromos(); }, [loadPromos]);

  const runPromotion = async () => {
    if (!account?.id || running) return;
    setRunning(true);
    setMsg(null);
    try {
      const res = await base44.functions.invoke('runWeeklySearchTermPromotion', { amazon_account_id: account.id });
      const d = res.data;
      if (d?.ok) {
        const s = d.stats || {};
        setMsg({ type: 'success', text: `✓ ${s.candidates} candidatos · ${s.created} campanhas criadas · ${s.negatives_created} negativas · ${s.duplicates_skipped} duplicatas evitadas · ${s.failed} falhas` });
        await loadPromos();
      } else {
        setMsg({ type: 'error', text: d?.error || 'Erro desconhecido' });
      }
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setRunning(false);
      setTimeout(() => setMsg(null), 15000);
    }
  };

  const runRepair = async () => {
    if (!account?.id || repairing) return;
    setRepairing(true);
    setMsg(null);
    try {
      const res = await base44.functions.invoke('completeIncompleteWeeklyPromotions', { amazon_account_id: account.id });
      const d = res.data;
      if (d?.ok) {
        const s = d.stats || {};
        setMsg({ type: 'success', text: `✓ Reparados: ${s.repaired} · Negativas: ${s.negatives_created} · Falhas: ${s.failed}` });
        await loadPromos();
      } else {
        setMsg({ type: 'error', text: d?.error || 'Erro no reparo' });
      }
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setRepairing(false);
      setTimeout(() => setMsg(null), 15000);
    }
  };

  const completed = promos.filter(p => p.promotion_status === 'completed').length;
  const incomplete = promos.filter(p => ['repair_required', 'failed_retryable', 'campaign_creating', 'campaign_created', 'ad_group_created', 'product_ad_created', 'keyword_created', 'enabling', 'manual_active'].includes(p.promotion_status)).length;
  const failed = promos.filter(p => p.promotion_status === 'failed_permanent').length;
  const lastRan = promos[0]?.created_at;

  const filtered = filterStatus === 'all' ? promos : promos.filter(p => p.promotion_status === filterStatus);

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-surface-2 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Search className="w-4 h-4 text-cyan" />
          <h3 className="text-sm font-semibold text-slate-200">Promoção Semanal de Termos</h3>
          {incomplete > 0 ? (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-400 font-semibold">
              {incomplete} pendentes
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={loadPromos} disabled={loading} className="p-2 bg-surface-2 border border-surface-3 rounded-lg text-slate-400 hover:text-white disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={runRepair} disabled={repairing || running}
            className="flex items-center gap-1.5 px-3 py-2 bg-amber-500/15 border border-amber-500/30 text-amber-300 hover:bg-amber-500/25 text-xs rounded-lg disabled:opacity-50">
            {repairing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wrench className="w-3.5 h-3.5" />}
            Reparar pendências
          </button>
          <button onClick={runPromotion} disabled={running || repairing}
            className="flex items-center gap-1.5 px-4 py-2 bg-cyan/20 border border-cyan/30 text-cyan hover:bg-cyan/30 text-xs font-semibold rounded-lg disabled:opacity-50">
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            {running ? 'Executando...' : 'Executar agora'}
          </button>
        </div>
      </div>

      {/* KPIs */}
      <div className="p-5 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-surface-2 rounded-lg p-3">
          <p className="text-[10px] text-slate-500 mb-1">Última execução</p>
          <p className="text-sm font-semibold text-white">
            {lastRan ? new Date(lastRan).toLocaleDateString('pt-BR') : '—'}
          </p>
          <p className="text-[10px] text-slate-600">{lastRan ? new Date(lastRan).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : 'nunca executou'}</p>
        </div>
        <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-3">
          <p className="text-[10px] text-slate-500 mb-1">Concluídos</p>
          <p className="text-xl font-bold text-emerald-400">{completed}</p>
          <p className="text-[10px] text-slate-600">campanhas criadas</p>
        </div>
        <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3">
          <p className="text-[10px] text-slate-500 mb-1">Incompletos</p>
          <p className="text-xl font-bold text-amber-400">{incomplete}</p>
          <p className="text-[10px] text-slate-600">aguardando reparo</p>
        </div>
        <div className="bg-red-500/5 border border-red-500/20 rounded-lg p-3">
          <p className="text-[10px] text-slate-500 mb-1">Falhas</p>
          <p className="text-xl font-bold text-red-400">{failed}</p>
          <p className="text-[10px] text-slate-600">permanentes</p>
        </div>
      </div>

      {/* Message */}
      {msg ? (
        <div className={`mx-5 mb-4 px-4 py-3 rounded-lg text-xs border flex items-center gap-2 ${msg.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300' : 'bg-red-500/10 border-red-500/20 text-red-400'}`}>
          {msg.type === 'success' ? <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />}
          {msg.text}
        </div>
      ) : null}

      {/* Table toggle */}
      {promos.length > 0 ? (
        <div className="border-t border-surface-2">
          <button onClick={() => setExpanded(e => !e)}
            className="w-full flex items-center justify-between px-5 py-3 text-xs text-slate-400 hover:text-slate-200 hover:bg-surface-2/40 transition-colors">
            <span>Detalhes dos termos promovidos ({promos.length})</span>
            {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>

          {expanded ? (
            <div className="px-5 pb-5">
              {/* Filter */}
              <div className="flex flex-wrap gap-2 mb-3">
                {['all', 'completed', 'repair_required', 'failed_permanent'].map(s => (
                  <button key={s} onClick={() => setFilterStatus(s)}
                    className={`px-2.5 py-1 rounded-lg text-[10px] font-semibold border transition-colors ${filterStatus === s ? 'bg-cyan/15 border-cyan/30 text-cyan' : 'bg-surface-2 border-surface-3 text-slate-500 hover:text-slate-300'}`}>
                    {s === 'all' ? 'Todos' : STATUS_LABELS[s] || s}
                  </button>
                ))}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-surface-2">
                      {['Termo', 'ASIN', 'Pedidos', 'CPC médio', 'Bid', 'Campanha destino', 'Status'].map(h => (
                        <th key={h} className="px-3 py-2 text-left text-[10px] text-slate-500 uppercase whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((p) => (
                      <tr key={p.id} className="border-b border-surface-2/50 hover:bg-surface-2/40">
                        <td className="px-3 py-2 text-white max-w-[200px] truncate" title={p.normalized_search_term || p.source_search_term}>
                          {p.normalized_search_term || p.source_search_term}
                        </td>
                        <td className="px-3 py-2 font-mono text-cyan text-[10px]">{p.asin}</td>
                        <td className="px-3 py-2 text-emerald-400 font-semibold">{p.orders || 0}</td>
                        <td className="px-3 py-2 text-slate-300">R${(p.average_cpc || 0).toFixed(2)}</td>
                        <td className="px-3 py-2 text-slate-300">R${(p.target_bid || 0).toFixed(2)}</td>
                        <td className="px-3 py-2 text-slate-400 text-[10px] max-w-[160px] truncate" title={p.destination_campaign_name}>
                          {p.destination_campaign_name || (p.destination_campaign_id ? `ID ${p.destination_campaign_id.slice(-8)}` : '—')}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`px-2 py-0.5 rounded-full text-[9px] font-semibold border ${STATUS_COLORS[p.promotion_status] || 'text-slate-400 bg-slate-500/10 border-slate-500/20'}`}>
                            {STATUS_LABELS[p.promotion_status] || p.promotion_status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {filtered.length === 0 && <p className="py-4 text-center text-xs text-slate-600">Nenhum termo neste filtro.</p>}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {!loading && promos.length === 0 ? (
        <div className="px-5 pb-5 text-xs text-slate-600 text-center py-4">
          Nenhuma promoção registrada. Execute a varredura para identificar termos vencedores.
        </div>
      ) : null}
    </div>
  );
}