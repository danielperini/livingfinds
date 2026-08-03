import { useState } from 'react';
import { AlertTriangle, CheckCircle, ChevronDown, ChevronUp, Loader2, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { base44 } from '@/api/base44Client';

const metrics = [
  ['total_amazon', 'Total Amazon'], ['total_local', 'Total local'], ['active_amazon', 'Ativas Amazon'],
  ['active_in_app', 'Ativas no app'], ['paused', 'Pausadas'], ['incomplete', 'Incompletas'],
  ['divergences', 'Divergências'], ['duplicates', 'Duplicadas'], ['without_product', 'Sem produto'],
  ['without_stock', 'Sem estoque'], ['protected', 'Protegidas'], ['actions_proposed', 'Ações propostas'],
];

export default function AmazonCampaignReconciliationPanel({ accountId, onSynced }) {
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(null);
  const [expanded, setExpanded] = useState(false);

  async function run(mode) {
    if (!accountId || running) return;
    if (mode === 'execute_safe' && !window.confirm('Executar somente pausas seguras e sincronizações confirmadas? Campanhas vencedoras e arquivamentos serão protegidos.')) return;
    setRunning(mode);
    try {
      const response = await base44.functions.invoke('reconcileAmazonAdsCampaigns', { amazon_account_id: accountId, mode });
      const data = response?.data || response;
      setResult(data);
      if (data?.ok && mode !== 'dry_run') await onSynced?.();
    } catch (error) {
      setResult({ ok: false, error: error?.response?.data?.error || error.message });
    } finally { setRunning(null); }
  }

  const Button = ({ mode, children, icon: Icon, tone }) => (
    <button disabled={!accountId || !!running} onClick={() => run(mode)}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[10px] font-semibold disabled:opacity-50 ${tone}`}>
      {running === mode ? <Loader2 className="w-3 h-3 animate-spin" /> : <Icon className="w-3 h-3" />}{children}
    </button>
  );

  return <div className="border-b border-surface-2 bg-[#0b1118] p-3">
    <div className="flex flex-wrap items-center gap-2">
      <div className="mr-auto"><p className="text-xs font-bold text-white">Reconciliação Amazon Ads</p>
        <p className="text-[9px] text-slate-500">Leitura real, paginação completa e nenhuma exclusão física.</p></div>
      <Button mode="sync" icon={RefreshCw} tone="border-cyan/30 bg-cyan/10 text-cyan">Sincronizar com Amazon</Button>
      <Button mode="dry_run" icon={Search} tone="border-amber-400/30 bg-amber-400/10 text-amber-300">Analisar faxina</Button>
      <Button mode="execute_safe" icon={ShieldCheck} tone="border-emerald-400/30 bg-emerald-400/10 text-emerald-300">Executar ações seguras</Button>
    </div>
    {result && <div className="mt-3">
      {!result.ok ? <div className="flex gap-2 text-[10px] text-red-300"><AlertTriangle className="w-3 h-3" />{result.error}</div> : <>
        <div className="flex items-center gap-2 text-[10px] text-emerald-300 mb-2"><CheckCircle className="w-3 h-3" />
          Run {result.run_id} · {result.mode} · {result.summary?.profiles_complete || 0} perfil(is) completo(s) · {result.summary?.actions_confirmed || 0} ação(ões) confirmada(s)
        </div>
        <div className="grid grid-cols-3 md:grid-cols-6 gap-1.5">{metrics.map(([key, label]) =>
          <div key={key} className="rounded border border-surface-3 bg-surface-1 px-2 py-1.5"><p className="text-[8px] text-slate-500">{label}</p><p className="text-xs font-bold text-slate-200">{result.summary?.[key] ?? 0}</p></div>)}</div>
        <button onClick={() => setExpanded((v) => !v)} className="mt-2 flex items-center gap-1 text-[10px] text-cyan">
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}Resultado detalhado por campanha
        </button>
        {expanded && <div className="mt-2 max-h-72 overflow-auto border border-surface-3 rounded">
          <table className="w-full text-[9px]"><thead className="sticky top-0 bg-surface-2 text-slate-400"><tr>
            {['Campanha', 'Perfil', 'Amazon', 'App', 'Classificação', 'Estrutura', 'Ação'].map((x) => <th key={x} className="text-left px-2 py-1.5">{x}</th>)}
          </tr></thead><tbody>{(result.campaigns || []).map((row) => <tr key={`${row.profile_id}:${row.campaign_id}`} className="border-t border-surface-3 text-slate-300">
            <td className="px-2 py-1.5"><p className="max-w-44 truncate">{row.name}</p><span className="font-mono text-slate-600">{row.campaign_id}</span></td>
            <td className="px-2">{row.profile_id}</td><td className="px-2">{row.remote_state}</td><td className="px-2">{row.local_state || 'ausente'}</td>
            <td className="px-2 font-semibold">{row.classification}</td><td className="px-2">AG {row.ad_groups} · PA {row.product_ads} · KW {row.active_exact_keywords}</td>
            <td className="px-2">{row.proposed_action}</td></tr>)}</tbody></table>
        </div>}
      </>}
    </div>}
  </div>;
}
