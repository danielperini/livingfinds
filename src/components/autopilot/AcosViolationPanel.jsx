import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { TrendingUp, Play, RefreshCw, AlertTriangle, CheckCircle, Loader2, ChevronDown, ChevronUp, PauseCircle, Shield } from 'lucide-react';

const STATUS_STYLES = {
  watching:  { label: '1° ciclo',   cls: 'text-blue-400 bg-blue-400/10 border-blue-400/20' },
  warning:   { label: '2° ciclo ⚠', cls: 'text-amber-400 bg-amber-400/10 border-amber-400/20' },
  paused:    { label: 'Pausada',    cls: 'text-red-400 bg-red-400/10 border-red-400/20' },
  recovered: { label: 'Recuperada', cls: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
  exempt:    { label: 'Isenta',     cls: 'text-slate-400 bg-slate-400/10 border-slate-400/20' },
};

function AcosBars({ acos1, acos2, acos3, maxAcos }) {
  const bars = [acos1, acos2, acos3].filter(a => a > 0);
  if (!bars.length) return <span className="text-xs text-slate-600">—</span>;
  return (
    <div className="flex items-end gap-1 h-6">
      {bars.map((a, i) => {
        const h = Math.min(100, (a / (maxAcos * 1.5)) * 100);
        const color = a > maxAcos ? 'bg-red-400' : 'bg-emerald-400';
        return (
          <div key={i} title={`Ciclo ${i + 1}: ${a.toFixed(0)}%`}
            className={`w-3 rounded-sm ${color} opacity-80 transition-all`}
            style={{ height: `${h}%` }} />
        );
      })}
    </div>
  );
}

export default function AcosViolationPanel({ account }) {
  const [violations, setViolations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState('all');

  const loadData = useCallback(async () => {
    if (!account?.id) return;
    setLoading(true);
    try {
      const data = await base44.entities.CampaignAcosViolation.filter(
        { amazon_account_id: account.id }, '-last_violation_at', 200
      );
      setViolations(data);
    } finally {
      setLoading(false);
    }
  }, [account?.id]);

  useEffect(() => { loadData(); }, [loadData]);

  const runChecker = async () => {
    if (!account?.id || running) return;
    setRunning(true);
    setMsg(null);
    try {
      const res = await base44.functions.invoke('runAcosViolationChecker', { amazon_account_id: account.id });
      const d = res.data;
      if (d?.ok) {
        const s = d.stats || {};
        setMsg({
          type: 'success',
          text: `✓ ${s.campaigns_evaluated} avaliadas · ${s.new_violations} violações · ${s.warnings_issued} alertas · ${s.campaigns_paused} pausadas · ${s.violations_reset} recuperadas`,
        });
        await loadData();
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

  const watching = violations.filter(v => v.status === 'watching').length;
  const warnings = violations.filter(v => v.status === 'warning').length;
  const paused = violations.filter(v => v.status === 'paused').length;
  const recovered = violations.filter(v => v.status === 'recovered').length;

  const filtered = filter === 'all' ? violations : violations.filter(v => v.status === filter);
  const maxAcos = violations[0]?.maximum_acos || 45;

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-surface-2 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-amber-400" />
          <h3 className="text-sm font-semibold text-slate-200">Desligamento por ACoS — 3 Ciclos</h3>
          {warnings > 0 ? (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-400 font-semibold">
              {warnings} em alerta
            </span>
          ) : null}
          {paused > 0 ? (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-500/15 border border-red-500/30 text-red-400 font-semibold">
              {paused} pausadas
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={loadData} disabled={loading} className="p-2 bg-surface-2 border border-surface-3 rounded-lg text-slate-400 hover:text-white disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={runChecker} disabled={running}
            className="flex items-center gap-1.5 px-4 py-2 bg-amber-500/15 border border-amber-500/30 text-amber-300 hover:bg-amber-500/25 text-xs font-semibold rounded-lg disabled:opacity-50">
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            {running ? 'Verificando...' : 'Verificar agora'}
          </button>
        </div>
      </div>

      {/* Descrição da lógica */}
      <div className="px-5 pt-4 pb-2">
        <div className="flex flex-wrap gap-4 text-xs text-slate-500">
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-blue-400" />
            <span><span className="text-slate-300">1° ciclo:</span> Observando</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-amber-400" />
            <span><span className="text-slate-300">2° ciclo:</span> Alerta — próximo ciclo pausa</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-red-400" />
            <span><span className="text-slate-300">3° ciclo:</span> Pausada automaticamente</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Shield className="w-3 h-3 text-slate-500" />
            <span>Campanhas AUTO recebem tolerância maior (+30% do ACoS máx.)</span>
          </div>
        </div>
      </div>

      {/* KPIs */}
      <div className="p-5 pt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-blue-500/5 border border-blue-500/15 rounded-lg p-3">
          <p className="text-[10px] text-slate-500 mb-1">1° ciclo (observando)</p>
          <p className="text-xl font-bold text-blue-400">{watching}</p>
          <p className="text-[10px] text-slate-600">campanhas</p>
        </div>
        <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3">
          <p className="text-[10px] text-slate-500 mb-1">2° ciclo (alerta)</p>
          <p className="text-xl font-bold text-amber-400">{warnings}</p>
          <p className="text-[10px] text-slate-600">próximo pausa</p>
        </div>
        <div className="bg-red-500/5 border border-red-500/20 rounded-lg p-3">
          <p className="text-[10px] text-slate-500 mb-1">3° ciclo (pausadas)</p>
          <p className="text-xl font-bold text-red-400">{paused}</p>
          <p className="text-[10px] text-slate-600">desligadas</p>
        </div>
        <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-3">
          <p className="text-[10px] text-slate-500 mb-1">Recuperadas</p>
          <p className="text-xl font-bold text-emerald-400">{recovered}</p>
          <p className="text-[10px] text-slate-600">voltaram à meta</p>
        </div>
      </div>

      {/* Message */}
      {msg ? (
        <div className={`mx-5 mb-4 px-4 py-3 rounded-lg text-xs border flex items-center gap-2 ${msg.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300' : 'bg-red-500/10 border-red-500/20 text-red-400'}`}>
          {msg.type === 'success' ? <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />}
          {msg.text}
        </div>
      ) : null}

      {/* Tabela */}
      {violations.length > 0 ? (
        <div className="border-t border-surface-2" key="violations-table">
          <button onClick={() => setExpanded(e => !e)}
            className="w-full flex items-center justify-between px-5 py-3 text-xs text-slate-400 hover:text-slate-200 hover:bg-surface-2/40 transition-colors">
            <span>Histórico de violações ({violations.length} campanhas)</span>
            {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>

          {expanded && (
            <div className="px-5 pb-5">
              <div className="flex flex-wrap gap-2 mb-3">
                {['all', 'watching', 'warning', 'paused', 'recovered'].map(s => (
                  <button key={s} onClick={() => setFilter(s)}
                    className={`px-2.5 py-1 rounded-lg text-[10px] font-semibold border transition-colors ${filter === s ? 'bg-cyan/15 border-cyan/30 text-cyan' : 'bg-surface-2 border-surface-3 text-slate-500 hover:text-slate-300'}`}>
                    {s === 'all' ? `Todos (${violations.length})` : `${STATUS_STYLES[s]?.label || s} (${violations.filter(v => v.status === s).length})`}
                  </button>
                ))}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-surface-2">
                      {['Campanha', 'Tipo', 'Ciclos', 'ACoS (c1/c2/c3)', 'Último ACoS', 'Status', 'Motivo'].map(h => (
                        <th key={h} className="px-3 py-2 text-left text-[10px] text-slate-500 uppercase whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(v => {
                      const s = STATUS_STYLES[v.status] || STATUS_STYLES.watching;
                      const lastAcos = v.acos_cycle_3 || v.acos_cycle_2 || v.acos_cycle_1 || 0;
                      return (
                        <tr key={v.id} className="border-b border-surface-2/50 hover:bg-surface-2/40">
                          <td className="px-3 py-2 text-white max-w-[180px] truncate" title={v.campaign_name}>{v.campaign_name || v.campaign_id}</td>
                          <td className="px-3 py-2">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${v.campaign_type === 'AUTO' ? 'text-blue-400 bg-blue-400/10' : 'text-slate-300 bg-slate-400/10'}`}>
                              {v.campaign_type || '—'}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-1">
                              {[1, 2, 3].map(n => (
                                <div key={n} className={`w-2 h-2 rounded-full ${n <= (v.consecutive_violations || 0) ? 'bg-red-400' : 'bg-surface-3'}`} />
                              ))}
                              <span className="text-slate-400 ml-1">{v.consecutive_violations || 0}/3</span>
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <AcosBars acos1={v.acos_cycle_1} acos2={v.acos_cycle_2} acos3={v.acos_cycle_3} maxAcos={maxAcos} />
                          </td>
                          <td className={`px-3 py-2 font-semibold ${lastAcos > maxAcos ? 'text-red-400' : 'text-emerald-400'}`}>
                            {lastAcos > 0 ? `${lastAcos.toFixed(0)}%` : '—'}
                          </td>
                          <td className="px-3 py-2">
                            <span className={`px-2 py-0.5 rounded-full text-[9px] font-semibold border ${s.cls}`}>{s.label}</span>
                          </td>
                          <td className="px-3 py-2 text-slate-500 max-w-[200px] truncate text-[10px]" title={v.pause_reason || v.notes}>
                            {v.pause_reason || v.notes || '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {filtered.length === 0 && <p className="py-4 text-center text-xs text-slate-600">Nenhuma violação neste filtro.</p>}
              </div>
            </div>
          )}
        </div>
      ) : null}

      {!loading && violations.length === 0 ? (
        <div className="px-5 pb-5 text-xs text-slate-600 text-center py-4">
          Nenhuma violação registrada. Execute a verificação para rastrear campanhas com ACoS acima da meta.
        </div>
      ) : null}
    </div>
  );
}