import { useState, useEffect, useRef } from 'react';
import { Zap, Star, Megaphone, CheckCircle, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import { base44 } from '@/api/base44Client';

const fmt = (v, d = 2) => Number(v || 0).toFixed(d).replace('.', ',');

async function scheduleOne(account, rec, setScheduledIds) {
  const res = await base44.functions.invoke('scheduleManualCampaignFromTerm', {
    amazon_account_id: account.id,
    asin: rec.asin,
    keyword: rec.term,
    product_name: rec.product_name || rec.asin,
    sku: rec.sku || null,
  });
  const d = res?.data || {};
  const ok = d?.ok || d?.already_exists || d?.already_queued;
  if (ok) setScheduledIds(prev => ({ ...prev, [rec.id]: d.executed ? 'executed' : 'queued' }));
  return ok;
}

export default function HighRelevancePanel({
  data, multiAsinTerms, search, account,
  schedulingId, scheduledIds, onSchedule,
  setSchedulingId, setScheduledIds, setMessage
}) {
  const [expandedTerm, setExpandedTerm] = useState(null);
  const [batchLoading, setBatchLoading] = useState(null);
  const [autoRunning, setAutoRunning] = useState(false);
  const [autoProgress, setAutoProgress] = useState(null);
  const processedIdsRef = useRef(new Set()); // IDs já processados nesta sessão
  const runningRef = useRef(false);

  const q = search || '';
  const filtered = data.filter(g => !q || g.term.toLowerCase().includes(q));

  // Todos os registros pendentes de termos ≥90% ainda não processados
  const pendingHigh = data
    .filter(g => g.conf >= 90)
    .flatMap(g => g.records.filter(r => !scheduledIds[r.id] && !processedIdsRef.current.has(r.id)));

  // Dispara sempre que data/account mudam e há pendentes novos
  useEffect(() => {
    if (!account || pendingHigh.length === 0 || runningRef.current) return;
    runningRef.current = true;
    setAutoRunning(true);
    setAutoProgress({ done: 0, total: pendingHigh.length });
    setMessage(null);

    (async () => {
      let created = 0, failed = 0;
      for (let i = 0; i < pendingHigh.length; i++) {
        const rec = pendingHigh[i];
        processedIdsRef.current.add(rec.id); // marcar antes de enviar (evita duplo envio)
        try {
          const ok = await scheduleOne(account, rec, setScheduledIds);
          ok ? created++ : failed++;
        } catch { failed++; }
        setAutoProgress({ done: i + 1, total: pendingHigh.length });
        await new Promise(r => setTimeout(r, 400));
      }
      setAutoRunning(false);
      setAutoProgress(null);
      runningRef.current = false;
      setMessage({
        type: failed === 0 ? 'success' : 'info',
        text: `✓ Auto-implementação concluída — ${created} criadas/agendadas${failed > 0 ? `, ${failed} falhas` : ''}.`,
      });
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, data]);

  const handleBatchCreate = async (group) => {
    if (!account || batchLoading) return;
    const key = group.term.toLowerCase();
    setBatchLoading(key);
    setMessage(null);
    let created = 0, failed = 0;
    for (const rec of group.records) {
      try {
        const ok = await scheduleOne(account, rec, setScheduledIds);
        ok ? created++ : failed++;
      } catch { failed++; }
      await new Promise(r => setTimeout(r, 300));
    }
    setBatchLoading(null);
    setMessage({
      type: failed === 0 ? 'success' : 'info',
      text: `"${group.term}" — ${created} campanhas criadas/agendadas${failed > 0 ? `, ${failed} falhas` : ''}.`,
    });
  };

  const confColor = (c) => c >= 90 ? 'text-emerald-400' : c >= 80 ? 'text-amber-400' : 'text-slate-400';
  const confBg = (c) => c >= 90 ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-amber-500/10 border-amber-500/20';

  return (
    <div className="space-y-4">
      {/* Legenda + status de auto-execução */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-4 text-xs text-slate-500">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" />≥90% multi-campanha</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400 inline-block" />80–89% relevância alta</span>
        </div>
        {autoRunning && autoProgress && (
          <div className="flex items-center gap-2 text-xs text-emerald-400">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>Criando campanhas… {autoProgress.done}/{autoProgress.total}</span>
          </div>
        )}
      </div>

      {/* Barra de progresso automática */}
      {autoRunning && autoProgress && (
        <div className="rounded-lg bg-surface-2 p-3">
          <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
            <span>Criando campanhas ≥90% automaticamente…</span>
            <span>{Math.round((autoProgress.done / autoProgress.total) * 100)}%</span>
          </div>
          <div className="w-full h-1.5 bg-surface-3 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full transition-all duration-300"
              style={{ width: `${(autoProgress.done / autoProgress.total) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Banner multi-ASIN */}
      {multiAsinTerms.length > 0 && (
        <div className="rounded-xl border border-violet-500/30 bg-violet-500/10 p-4">
          <div className="flex items-start gap-3">
            <Star className="h-4 w-4 text-violet-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-violet-300">
                {multiAsinTerms.length} termo{multiAsinTerms.length > 1 ? 's' : ''} com ≥90% aplicável{multiAsinTerms.length > 1 ? 'is' : ''} a múltiplos ASINs
              </p>
              <p className="text-xs text-violet-400/80 mt-0.5">
                Estes termos podem ser usados em campanhas de mais de um produto simultaneamente.
              </p>
              <div className="flex flex-wrap gap-2 mt-2">
                {multiAsinTerms.slice(0, 8).map(g => (
                  <span key={g.term} className="px-2 py-0.5 rounded-full text-xs font-medium bg-violet-500/20 border border-violet-500/30 text-violet-300">
                    {g.term} <span className="opacity-60">({g.asins.size} ASINs)</span>
                  </span>
                ))}
                {multiAsinTerms.length > 8 && (
                  <span className="px-2 py-0.5 text-xs text-violet-400/60">+{multiAsinTerms.length - 8} mais</span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="text-center py-16 text-slate-500 text-sm">Nenhum termo com relevância ≥80% encontrado.</div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-surface-2 bg-surface-1">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-2 bg-surface-2/40">
                <th className="px-4 py-3 text-left text-xs uppercase text-slate-500">Termo</th>
                <th className="px-4 py-3 text-left text-xs uppercase text-slate-500">Relevância</th>
                <th className="px-4 py-3 text-left text-xs uppercase text-slate-500">ASINs</th>
                <th className="px-4 py-3 text-left text-xs uppercase text-slate-500">Total Pedidos</th>
                <th className="px-4 py-3 text-left text-xs uppercase text-slate-500">Total Gasto</th>
                <th className="px-4 py-3 text-left text-xs uppercase text-slate-500">Ação</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((group) => {
                const key = group.term.toLowerCase();
                const isMulti = group.asins.size > 1 && group.conf >= 90;
                const totalOrders = group.records.reduce((s, r) => s + (r.orders || 0), 0);
                const totalSpend = group.records.reduce((s, r) => s + (r.spend || 0), 0);
                const isExpanded = expandedTerm === key;
                const isBatchingThis = batchLoading === key;
                const allScheduled = group.records.every(r => scheduledIds[r.id]);

                return [
                  <tr
                    key={key}
                    className={`border-b border-surface-2/40 hover:bg-surface-2/20 transition-colors cursor-pointer ${isMulti ? 'bg-violet-500/5' : ''}`}
                    onClick={() => setExpandedTerm(isExpanded ? null : key)}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {isMulti ? <Star className="w-3 h-3 text-violet-400 shrink-0" /> : <Zap className="w-3 h-3 text-amber-400 shrink-0" />}
                        <span className="font-semibold text-white">{group.term}</span>
                        {isExpanded
                          ? <ChevronUp className="w-3 h-3 text-slate-500 ml-1" />
                          : <ChevronDown className="w-3 h-3 text-slate-500 ml-1" />}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-bold px-2 py-0.5 rounded border ${confColor(group.conf)} ${confBg(group.conf)}`}>
                        {group.conf}%
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs ${isMulti ? 'text-violet-300 font-semibold' : 'text-slate-400'}`}>
                        {group.asins.size} ASIN{group.asins.size > 1 ? 's' : ''}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-cyan">{totalOrders > 0 ? totalOrders : '—'}</td>
                    <td className="px-4 py-3 text-xs text-slate-300">{totalSpend > 0 ? `R$${fmt(totalSpend)}` : '—'}</td>
                    <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                      {group.records.length === 1 ? (
                        // Único ASIN → botão individual
                        allScheduled ? (
                          <span className="flex items-center gap-1 text-[10px] text-emerald-400"><CheckCircle className="w-3 h-3" />Criada</span>
                        ) : (
                          <button
                            onClick={() => onSchedule(group.records[0])}
                            disabled={schedulingId === group.records[0].id}
                            className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold rounded-lg border border-cyan/30 bg-cyan/10 text-cyan hover:bg-cyan/20 disabled:opacity-50 transition-colors whitespace-nowrap"
                          >
                            {schedulingId === group.records[0].id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Megaphone className="w-3 h-3" />}
                            Criar campanha
                          </button>
                        )
                      ) : (
                        // Multi-ASIN → batch
                        allScheduled ? (
                          <span className="flex items-center gap-1 text-[10px] text-emerald-400"><CheckCircle className="w-3 h-3" />Todas criadas</span>
                        ) : (
                          <button
                            onClick={() => handleBatchCreate(group)}
                            disabled={!!isBatchingThis}
                            className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold rounded-lg border border-violet-400/30 bg-violet-400/10 text-violet-300 hover:bg-violet-400/20 disabled:opacity-50 transition-colors whitespace-nowrap"
                          >
                            {isBatchingThis ? <Loader2 className="w-3 h-3 animate-spin" /> : <Star className="w-3 h-3" />}
                            Criar em {group.records.length} ASINs
                          </button>
                        )
                      )}
                    </td>
                  </tr>,
                  isExpanded && (
                    <tr key={`${key}_exp`} className="bg-surface-2/30">
                      <td colSpan={6} className="px-6 py-3">
                        <div className="space-y-1">
                          <p className="text-[10px] uppercase text-slate-500 mb-2">Produtos com este termo</p>
                          {group.records.map(rec => (
                            <div key={rec.id} className="flex items-center justify-between gap-3 py-1.5 px-3 rounded-lg bg-surface-1 border border-surface-2/60">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="font-mono text-[10px] text-cyan shrink-0">{rec.asin}</span>
                                <span className="text-xs text-slate-300 truncate max-w-[200px]">{rec.product_name || '—'}</span>
                              </div>
                              <div className="flex items-center gap-4 text-[10px] text-slate-400 shrink-0">
                                <span>Pedidos: <span className="text-cyan">{rec.orders || 0}</span></span>
                                <span>Gasto: <span className="text-slate-200">{rec.spend > 0 ? `R$${fmt(rec.spend)}` : '—'}</span></span>
                                <span className={`font-bold ${confColor(toConf100(rec.confidence))}`}>{toConf100(rec.confidence)}%</span>
                              </div>
                              <div className="shrink-0">
                                {scheduledIds[rec.id] ? (
                                  <span className="flex items-center gap-1 text-[10px] text-emerald-400"><CheckCircle className="w-3 h-3" />{scheduledIds[rec.id] === 'executed' ? 'Criada' : 'Agendada'}</span>
                                ) : (
                                  <button
                                    onClick={() => onSchedule(rec)}
                                    disabled={schedulingId === rec.id}
                                    className="flex items-center gap-1 px-2 py-0.5 text-[10px] rounded border border-cyan/30 bg-cyan/10 text-cyan hover:bg-cyan/20 disabled:opacity-50 transition-colors"
                                  >
                                    {schedulingId === rec.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Megaphone className="w-3 h-3" />}
                                    Criar
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function toConf100(c) {
  if (c == null) return 0;
  return c <= 1 ? Math.round(c * 100) : Math.round(c);
}