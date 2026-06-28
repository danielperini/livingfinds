/**
 * SyncPanel — Painel de sincronização completa com progresso por etapa
 */
import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { RefreshCw, CheckCircle, XCircle, Clock, Zap, Package, Tag, Database, BarChart2, Layers } from 'lucide-react';

const STEPS_CONFIG = [
  { key: 'campaigns', label: 'Campanhas SP + SB + SD', icon: Layers, fn: 'syncCampaignsFull' },
  { key: 'adGroups_keywords', label: 'Ad Groups + Keywords', icon: Tag, fn: 'syncAdGroupsAndKeywords' },
  { key: 'product_ads', label: 'Product Ads + Targets', icon: Zap, fn: 'syncProductAds' },
  { key: 'product_catalog', label: 'Catálogo + Inventário FBA', icon: Package, fn: 'syncProductCatalog' },
  { key: 'metrics_report_request', label: 'Relatório de Métricas 30d', icon: BarChart2, fn: 'requestAdsReport' },
];

export default function SyncPanel({ amazonAccountId, onDone }) {
  const [state, setState] = useState('idle'); // idle | running | done | error
  const [steps, setSteps] = useState([]);
  const [currentStep, setCurrentStep] = useState(null);
  const [reportId, setReportId] = useState(null);
  const [summary, setSummary] = useState(null);

  const runFullSync = async () => {
    setState('running');
    setSteps([]);
    setCurrentStep(null);
    setReportId(null);
    setSummary(null);

    const results = [];

    for (const step of STEPS_CONFIG) {
      setCurrentStep(step.key);
      try {
        const res = await base44.functions.invoke(step.fn, { amazon_account_id: amazonAccountId, days: 30 });
        const data = res.data;
        const upserted = data?.totalUpserted ?? data?.records_upserted ?? 0;
        const result = { ...step, ok: data?.ok !== false, upserted, errors: data?.errors || [], reportId: data?.reportId };
        results.push(result);
        setSteps([...results]);
        if (data?.reportId) setReportId(data.reportId);
      } catch (e) {
        results.push({ ...step, ok: false, upserted: 0, errors: [e.message] });
        setSteps([...results]);
      }
    }

    setCurrentStep(null);
    const totalUpserted = results.reduce((s, r) => s + (r.upserted || 0), 0);
    const failedCount = results.filter(r => !r.ok).length;
    setSummary({ totalUpserted, failedCount });
    setState(failedCount === STEPS_CONFIG.length ? 'error' : 'done');
    onDone?.();
  };

  const runSingleStep = async (step) => {
    setCurrentStep(step.key);
    try {
      const res = await base44.functions.invoke(step.fn, { amazon_account_id: amazonAccountId, days: 30 });
      const data = res.data;
      const upserted = data?.totalUpserted ?? data?.records_upserted ?? 0;
      setSteps(prev => {
        const idx = prev.findIndex(s => s.key === step.key);
        const updated = { ...step, ok: data?.ok !== false, upserted, errors: data?.errors || [], reportId: data?.reportId };
        if (data?.reportId) setReportId(data.reportId);
        if (idx >= 0) { const n = [...prev]; n[idx] = updated; return n; }
        return [...prev, updated];
      });
    } catch (e) {
      setSteps(prev => {
        const idx = prev.findIndex(s => s.key === step.key);
        const updated = { ...step, ok: false, upserted: 0, errors: [e.message] };
        if (idx >= 0) { const n = [...prev]; n[idx] = updated; return n; }
        return [...prev, updated];
      });
    } finally {
      setCurrentStep(null);
      onDone?.();
    }
  };

  const isRunning = state === 'running' || currentStep !== null;

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <Database className="w-4 h-4 text-cyan" /> Sincronização Completa
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">Importa campanhas, keywords, produtos e métricas da Amazon</p>
        </div>
        <button
          onClick={runFullSync}
          disabled={isRunning}
          className="flex items-center gap-2 px-4 py-2 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60"
        >
          <RefreshCw className={`w-4 h-4 ${isRunning ? 'animate-spin' : ''}`} />
          {isRunning ? 'Sincronizando...' : 'Sync Completo'}
        </button>
      </div>

      {/* Steps */}
      <div className="space-y-2">
        {STEPS_CONFIG.map((step) => {
          const result = steps.find(s => s.key === step.key);
          const isActive = currentStep === step.key;
          const Icon = step.icon;

          return (
            <div key={step.key} className={`flex items-center gap-3 p-3 rounded-lg border transition-all ${
              isActive ? 'border-cyan/30 bg-cyan/5' :
              result?.ok === true ? 'border-emerald-400/20 bg-emerald-400/5' :
              result?.ok === false ? 'border-red-400/20 bg-red-400/5' :
              'border-surface-3 bg-surface-2'
            }`}>
              <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${
                isActive ? 'bg-cyan/20' :
                result?.ok === true ? 'bg-emerald-400/15' :
                result?.ok === false ? 'bg-red-400/15' :
                'bg-surface-3'
              }`}>
                {isActive ? (
                  <RefreshCw className="w-3.5 h-3.5 text-cyan animate-spin" />
                ) : result?.ok === true ? (
                  <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
                ) : result?.ok === false ? (
                  <XCircle className="w-3.5 h-3.5 text-red-400" />
                ) : (
                  <Icon className="w-3.5 h-3.5 text-slate-500" />
                )}
              </div>

              <div className="flex-1 min-w-0">
                <p className={`text-xs font-medium ${
                  isActive ? 'text-cyan' :
                  result?.ok === true ? 'text-emerald-300' :
                  result?.ok === false ? 'text-red-300' :
                  'text-slate-400'
                }`}>{step.label}</p>
                {result?.ok === true && (
                  <p className="text-xs text-slate-500">{result.upserted} registos actualizados{result.reportId ? ` · reportId: ${result.reportId.slice(0, 8)}…` : ''}</p>
                )}
                {result?.ok === false && result.errors?.length > 0 && (
                  <p className="text-xs text-red-400 truncate">{result.errors[0]}</p>
                )}
                {isActive && <p className="text-xs text-cyan/70">A processar...</p>}
              </div>

              <button
                onClick={() => runSingleStep(step)}
                disabled={isRunning}
                title={`Executar apenas: ${step.label}`}
                className="flex-shrink-0 p-1.5 rounded-md text-slate-500 hover:text-slate-300 hover:bg-surface-3 transition-colors disabled:opacity-40"
              >
                <RefreshCw className="w-3 h-3" />
              </button>
            </div>
          );
        })}
      </div>

      {/* Summary */}
      {summary && (
        <div className={`p-3 rounded-lg border text-xs ${
          summary.failedCount === 0
            ? 'border-emerald-400/20 bg-emerald-400/5 text-emerald-300'
            : summary.failedCount < STEPS_CONFIG.length
            ? 'border-amber-400/20 bg-amber-400/5 text-amber-300'
            : 'border-red-400/20 bg-red-400/5 text-red-300'
        }`}>
          {summary.failedCount === 0
            ? `✓ Sync completo! ${summary.totalUpserted} registos importados.`
            : `Sync parcial — ${summary.totalUpserted} registos importados, ${summary.failedCount} etapas com erro.`}
          {reportId && <span className="ml-2 text-slate-400">Métricas em processamento. Baixe em 2-5 min.</span>}
        </div>
      )}

      {/* Download metrics if we have a reportId */}
      {reportId && (
        <DownloadMetricsButton amazonAccountId={amazonAccountId} reportId={reportId} onDone={onDone} />
      )}
    </div>
  );
}

function DownloadMetricsButton({ amazonAccountId, reportId, onDone }) {
  const [state, setState] = useState('idle');
  const [msg, setMsg] = useState('');

  const download = async () => {
    setState('loading');
    try {
      const res = await base44.functions.invoke('downloadAdsReport', { amazon_account_id: amazonAccountId, report_id: reportId });
      const data = res.data;
      if (!data.ok) throw new Error(data.error || 'Erro');
      if (data.ready) {
        setState('done');
        setMsg(`✓ ${data.records_upserted} campanhas com métricas actualizadas`);
        onDone?.();
      } else {
        setState('idle');
        setMsg(`Ainda a processar (${data.status}) — tente novamente`);
      }
    } catch (e) {
      setState('error');
      setMsg(e.message);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={download}
        disabled={state === 'loading' || state === 'done'}
        className={`flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-lg border transition-colors disabled:opacity-60 ${
          state === 'done' ? 'border-emerald-400/20 text-emerald-400 bg-emerald-400/5' :
          state === 'error' ? 'border-red-400/20 text-red-400 bg-red-400/5' :
          'border-cyan/20 text-cyan bg-cyan/5 hover:bg-cyan/10'
        }`}
      >
        <BarChart2 className={`w-3.5 h-3.5 ${state === 'loading' ? 'animate-pulse' : ''}`} />
        {state === 'loading' ? 'A verificar...' : state === 'done' ? 'Métricas importadas!' : 'Baixar Métricas Agora'}
      </button>
      {msg && <p className={`text-xs ${state === 'error' ? 'text-red-400' : 'text-slate-400'}`}>{msg}</p>}
    </div>
  );
}