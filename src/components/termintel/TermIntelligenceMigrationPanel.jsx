import { useCallback, useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Loader2, Play, RefreshCw, ShieldCheck, Layers } from 'lucide-react';
import TermIntelligenceActionRow from './TermIntelligenceActionRow';

function Kpi({ label, value }) {
  return (
    <div className="lf-card p-4">
      <p className="text-[13px] text-[#6B7280]">{label}</p>
      <p className="text-2xl font-bold text-[#0D1117] mt-0.5 tabular-nums">{value}</p>
    </div>
  );
}

export default function TermIntelligenceMigrationPanel() {
  const [account, setAccount] = useState(null);
  const [runs, setRuns] = useState([]);
  const [actions, setActions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(null);
  const [message, setMessage] = useState(null);
  const [scope, setScope] = useState('');
  const [lookback, setLookback] = useState(15);
  const [executionEnabled, setExecutionEnabled] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      let accs = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      if (!accs.length) accs = await base44.entities.AmazonAccount.list();
      const acc = accs[0] || null;
      setAccount(acc);
      if (!acc) return;
      const [runRows, actionRows, flags] = await Promise.all([
        base44.entities.TermIntelligenceRun.filter({ amazon_account_id: acc.id }, '-started_at', 10).catch(() => []),
        base44.entities.TermIntelligenceAction.filter({ amazon_account_id: acc.id }, '-created_at', 200).catch(() => []),
        base44.entities.FeatureFlag.filter({ key: 'term_intelligence_execution_enabled' }, '-updated_at', 1).catch(() => []),
      ]);
      setRuns(runRows);
      setActions(actionRows);
      setExecutionEnabled(flags[0]?.enabled === true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const trigger = async (execute) => {
    if (!account) return;
    setRunning(execute ? 'execute' : 'dry');
    setMessage({ type: 'info', text: execute ? 'Executando ações aprovadas na Amazon…' : 'Gerando plano de reconciliação (sem escrever na Amazon)…' });
    try {
      const res = await base44.functions.invoke('runTermIntelligenceBackfill', {
        amazon_account_id: account.id,
        lookback_days: Number(lookback) || 15,
        execute_changes: execute,
        asin_scope: scope.split(',').map(s => s.trim()).filter(Boolean),
      });
      const data = res?.data ?? res;
      if (data?.ok) {
        setMessage({ type: 'success', text: `${data.actions_planned} ações planejadas · ${data.terms_scanned} termos · ${data.asins_scanned} ASINs${execute ? ` · ${data.actions_executed} executadas` : ''}` });
        await load();
      } else {
        setMessage({ type: 'error', text: data?.error || 'Falha ao executar o backfill.' });
      }
    } catch (error) {
      setMessage({ type: 'error', text: error?.message || 'Erro inesperado.' });
    } finally {
      setRunning(null);
    }
  };

  const lastRun = runs[0];
  const confirmed = actions.filter(a => a.execution_status === 'AMAZON_CONFIRMED').length;
  const failed = actions.filter(a => a.execution_status === 'FAILED').length;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-[#EFF6FF] border border-[#DBEAFE] flex items-center justify-center">
            <Layers className="w-5 h-5 text-[#2563EB]" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-[#0D1117]">Term Intelligence — Migração</h2>
            <p className="text-[13px] text-[#4B5563]">Clusters de 2–5 Exact coerentes, winners isolados 1:1 e reconciliação retroativa com confirmação Amazon.</p>
          </div>
        </div>
        <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold ${executionEnabled ? 'badge-success' : 'badge-warning'}`}>
          <ShieldCheck className="w-3.5 h-3.5" />
          {executionEnabled ? 'Execução liberada' : 'Somente simulação'}
        </span>
      </div>

      <div className="lf-card p-4 flex items-end gap-3 flex-wrap">
        <div>
          <label className="block text-[12px] text-[#6B7280] mb-1">Janela (dias)</label>
          <input type="number" min={1} value={lookback} onChange={e => setLookback(e.target.value)}
            className="w-28 px-3 py-2 rounded-lg border border-[#E5E7EB] text-[15px]" />
        </div>
        <div className="flex-1 min-w-[240px]">
          <label className="block text-[12px] text-[#6B7280] mb-1">ASINs (opcional, separados por vírgula)</label>
          <input value={scope} onChange={e => setScope(e.target.value)} placeholder="B0XXXXXXX, B0YYYYYYY"
            className="w-full px-3 py-2 rounded-lg border border-[#E5E7EB] text-[15px]" />
        </div>
        <button type="button" onClick={() => trigger(false)} disabled={!!running || !account}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-white border border-[#E5E7EB] text-[#0D1117] font-semibold hover:bg-[#F8FAFC] disabled:opacity-50">
          {running === 'dry' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Simular plano
        </button>
        <button type="button" onClick={() => trigger(true)} disabled={!!running || !account || !executionEnabled}
          title={executionEnabled ? 'Executar ações na Amazon' : 'Ative a flag term_intelligence_execution_enabled'}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#2563EB] text-white font-semibold hover:bg-[#1D4ED8] disabled:opacity-50">
          {running === 'execute' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          Executar
        </button>
      </div>

      {message && (
        <div className={`px-4 py-3 rounded-xl border text-[15px] font-medium ${message.type === 'success' ? 'badge-success' : message.type === 'error' ? 'badge-danger' : 'badge-info'}`}>
          {message.text}
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Kpi label="ASINs analisados" value={lastRun?.asins_scanned ?? '—'} />
        <Kpi label="Termos analisados" value={lastRun?.terms_scanned ?? '—'} />
        <Kpi label="Ações planejadas" value={lastRun?.actions_planned ?? actions.length} />
        <Kpi label="Confirmadas na Amazon" value={confirmed} />
        <Kpi label="Falhas" value={failed} />
      </div>

      <div className="lf-card overflow-hidden">
        <div className="px-5 py-3 border-b border-[#E5E7EB]">
          <p className="text-[13px] text-[#4B5563]">
            {loading ? 'Carregando…' : `${actions.length} ações registradas${lastRun ? ` · última execução ${new Date(lastRun.started_at).toLocaleString('pt-BR')}` : ''}`}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>ASIN / Termo</th>
                <th>Ação</th>
                <th>Estado atual</th>
                <th>Estado desejado</th>
                <th>Execução</th>
              </tr>
            </thead>
            <tbody>
              {actions.slice(0, 100).map(action => (
                <TermIntelligenceActionRow key={action.id} action={action} />
              ))}
              {!loading && actions.length === 0 && (
                <tr><td colSpan={5} className="text-center text-[#6B7280] py-8">Nenhuma ação ainda — rode uma simulação para gerar o plano.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}