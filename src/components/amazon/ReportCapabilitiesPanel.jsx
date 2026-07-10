import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { CheckCircle, XCircle, HelpCircle, AlertCircle, Loader2, FlaskConical, RefreshCw } from 'lucide-react';

const REPORT_TYPES = [
  { id: 'spCampaigns',        label: 'SP Campaigns',         desc: 'Performance por campanha' },
  { id: 'spTargeting',        label: 'SP Targeting',         desc: 'Keywords e targets (bid/performance)' },
  { id: 'spSearchTerm',       label: 'SP Search Term',       desc: 'Termos de busca que geraram impressões' },
  { id: 'spPurchasedProduct', label: 'SP Purchased Product', desc: 'ASINs comprados via anúncios' },
];

function StatusIcon({ status }) {
  if (status === 'supported')   return <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0" />;
  if (status === 'unsupported') return <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />;
  if (status === 'error')       return <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0" />;
  return <HelpCircle className="w-4 h-4 text-slate-500 flex-shrink-0" />;
}

function statusLabel(s) {
  if (s === 'supported')   return { text: 'Suportado',     cls: 'badge-success' };
  if (s === 'unsupported') return { text: 'Não suportado', cls: 'badge-danger' };
  if (s === 'error')       return { text: 'Erro',          cls: 'badge-warning' };
  return                          { text: 'Desconhecido',  cls: 'badge-neutral' };
}

export default function ReportCapabilitiesPanel({ account }) {
  const [capabilities, setCapabilities] = useState({});
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  useEffect(() => {
    if (!account?.id) return;
    loadCapabilities();
  }, [account?.id]);

  const loadCapabilities = async () => {
    setLoading(true);
    try {
      const rows = await base44.entities.AmazonAdsReportCapability.filter({ amazon_account_id: account.id });
      const map = {};
      for (const r of rows) map[r.report_type_id] = r;
      setCapabilities(map);
    } catch {
      setCapabilities({});
    } finally {
      setLoading(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await base44.functions.invoke('testAmazonAdsReportCapabilities', { amazon_account_id: account.id });
      setTestResult(res.data);
      await loadCapabilities();
    } catch (e) {
      setTestResult({ ok: false, error: e.message });
    } finally {
      setTesting(false);
    }
  };

  const spTargeting = capabilities['spTargeting'];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FlaskConical className="w-4 h-4 text-cyan" />
          <p className="text-sm font-semibold text-white">Capacidades de Relatórios Amazon Ads</p>
        </div>
        <button
          onClick={runTest}
          disabled={testing}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-cyan/15 border border-cyan/30 text-cyan hover:bg-cyan/25 rounded-lg transition-colors disabled:opacity-60 font-semibold"
        >
          {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          {testing ? 'Testando...' : 'Testar capacidades agora'}
        </button>
      </div>

      {/* spTargeting unsupported alert */}
      {!loading && spTargeting && spTargeting.status === 'unsupported' && (
        <div className="flex items-start gap-2 px-3 py-2.5 bg-amber-500/10 border border-amber-500/20 rounded-lg">
          <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-amber-300 space-y-0.5">
            <p className="font-semibold">spTargeting não suportado neste perfil</p>
            <p className="text-amber-400/80">O motor usará <strong>spCampaigns + spSearchTerm</strong> como fallback. Decisões por keyword individual ficam desativadas.</p>
            {spTargeting.amazon_error_message && (
              <p className="font-mono text-[10px] text-amber-500/70 mt-1">{spTargeting.amazon_error_message}</p>
            )}
          </div>
        </div>
      )}

      {/* Tabela */}
      <div className="divide-y divide-surface-2 rounded-xl border border-surface-2 overflow-hidden">
        {loading ? (
          <div className="flex items-center gap-2 px-4 py-3 bg-surface-1">
            <Loader2 className="w-4 h-4 text-slate-500 animate-spin" />
            <p className="text-xs text-slate-500">Carregando...</p>
          </div>
        ) : (
          REPORT_TYPES.map(rt => {
            const cap = capabilities[rt.id];
            const { text, cls } = statusLabel(cap?.status);
            return (
              <div key={rt.id} className="flex items-start gap-3 px-4 py-3 bg-surface-1 hover:bg-surface-2 transition-colors">
                <StatusIcon status={cap?.status} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-mono font-semibold text-slate-200">{rt.id}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${cls}`}>{text}</span>
                    {cap?.notes && <span className="text-[10px] text-slate-500 italic">{cap.notes}</span>}
                  </div>
                  <p className="text-[11px] text-slate-500 mt-0.5">{rt.desc}</p>
                  {cap?.amazon_error_message && cap.status !== 'supported' && (
                    <p className="text-[10px] text-red-400/80 font-mono mt-0.5 truncate">{cap.amazon_error_message}</p>
                  )}
                  {cap?.fallback_report_type && (
                    <p className="text-[10px] text-slate-500 mt-0.5">
                      Fallback: <span className="text-slate-400">{cap.fallback_report_type}</span>
                    </p>
                  )}
                </div>
                <div className="text-right flex-shrink-0">
                  {cap?.tested_at && (
                    <p className="text-[10px] text-slate-600">
                      {new Date(cap.tested_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </p>
                  )}
                  {cap?.http_status && (
                    <p className="text-[10px] text-slate-600">HTTP {cap.http_status}</p>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Resultado do teste em tempo real */}
      {testResult && (
        <div className={`px-4 py-3 rounded-xl border text-xs space-y-2 ${testResult.ok ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-red-500/5 border-red-500/20'}`}>
          {testResult.ok ? (
            <>
              <p className="font-semibold text-emerald-300">
                Teste concluído — {testResult.tested_at ? new Date(testResult.tested_at).toLocaleString('pt-BR') : ''}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {Object.entries(testResult.summary || {}).map(([rt, info]) => (
                  <div key={rt} className="bg-surface-2 rounded-lg px-2 py-1.5">
                    <p className="font-mono text-[10px] text-slate-400">{rt}</p>
                    <p className={`text-xs font-semibold ${info.status === 'supported' ? 'text-emerald-400' : info.status === 'unsupported' ? 'text-red-400' : 'text-amber-400'}`}>
                      {info.status} <span className="text-slate-500 font-normal">(HTTP {info.http_status})</span>
                    </p>
                    {info.error && <p className="text-[10px] text-red-400/70 truncate">{info.error}</p>}
                    {info.notes && <p className="text-[10px] text-slate-500 italic">{info.notes}</p>}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="text-red-400">{testResult.error || 'Erro ao executar teste'}</p>
          )}
        </div>
      )}
    </div>
  );
}