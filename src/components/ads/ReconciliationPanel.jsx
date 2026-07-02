import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { RefreshCw, Upload, CheckCircle, AlertCircle, Loader2, GitMerge, X } from 'lucide-react';

export default function ReconciliationPanel({ account, onDone }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [csvFile, setCsvFile] = useState(null);
  const [showConfirm, setShowConfirm] = useState(false);

  const handleFileChange = (e) => {
    const f = e.target.files?.[0];
    if (f) setCsvFile(f);
  };

  const runReconciliation = async () => {
    if (!account) return;
    setRunning(true);
    setError(null);
    setResult(null);
    setShowConfirm(false);

    try {
      let csvText = null;
      if (csvFile) {
        csvText = await csvFile.text();
      }

      const res = await base44.functions.invoke('reconcileSponsoredProductsCampaigns', {
        amazon_account_id: account.id,
        force_api_refresh: true,
        ...(csvText ? { csv_text: csvText } : {}),
      });

      if (res?.data?.ok) {
        setResult(res.data);
        if (onDone) onDone();
      } else {
        setError(res?.data?.error || 'Falha na conciliação.');
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  const operational = result ? (result.csv_active || 0) + (result.csv_paused || 0) + (result.csv_incomplete || 0) : null;

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <GitMerge className="w-4 h-4 text-cyan" />
          <h3 className="text-sm font-semibold text-white">Conciliação Sponsored Products</h3>
        </div>
        {result && (
          <span className="text-[10px] text-slate-500">
            {new Date(result.reconciled_at).toLocaleString('pt-BR')}
          </span>
        )}
      </div>

      {/* Upload CSV opcional */}
      <div className="mb-3">
        <label className="flex items-center gap-2 px-3 py-2 bg-surface-2 border border-surface-3 border-dashed rounded-lg cursor-pointer hover:border-cyan/40 transition-colors">
          <Upload className="w-3.5 h-3.5 text-slate-400" />
          <span className="text-xs text-slate-400">
            {csvFile ? csvFile.name : 'Anexar CSV da Amazon (opcional)'}
          </span>
          <input type="file" accept=".csv" className="hidden" onChange={handleFileChange} />
        </label>
        {csvFile && (
          <button onClick={() => setCsvFile(null)} className="mt-1 text-[10px] text-slate-500 hover:text-red-400 flex items-center gap-1">
            <X className="w-3 h-3" /> Remover CSV
          </button>
        )}
      </div>

      {/* Resultado anterior */}
      {result && (
        <div className="mb-3 grid grid-cols-3 gap-2 text-center">
          {[
            { label: 'CSV total', value: result.csv_rows, color: 'text-slate-300' },
            { label: 'API encontradas', value: result.api_campaigns_found, color: 'text-cyan' },
            { label: 'Criadas', value: result.created, color: 'text-emerald-400' },
            { label: 'Atualizadas', value: result.updated, color: 'text-blue-400' },
            { label: 'Arquivadas', value: result.archived, color: 'text-slate-500' },
            { label: 'Incompletas', value: result.incomplete, color: 'text-amber-400' },
            { label: 'Ausentes na API', value: result.api_missing, color: 'text-red-400' },
            { label: 'Ambíguas', value: result.ambiguous, color: 'text-orange-400' },
            { label: 'Operacionais', value: operational, color: 'text-emerald-300' },
          ].map(({ label, value, color }) => (
            <div key={label} className="bg-surface-2 rounded-lg p-2">
              <p className={`text-sm font-bold ${color}`}>{value ?? '—'}</p>
              <p className="text-[9px] text-slate-500 mt-0.5">{label}</p>
            </div>
          ))}
        </div>
      )}

      {result?.errors?.length > 0 && (
        <div className="mb-3 p-2 bg-red-500/5 border border-red-500/20 rounded-lg">
          <p className="text-[10px] font-semibold text-red-400 mb-1">Erros:</p>
          {result.errors.map((e, i) => (
            <p key={i} className="text-[10px] text-red-300">{e}</p>
          ))}
        </div>
      )}

      {error && (
        <div className="mb-3 flex items-center gap-2 p-2 bg-red-500/10 border border-red-500/20 rounded-lg">
          <AlertCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
          <p className="text-xs text-red-300">{error}</p>
        </div>
      )}

      {/* Botão principal */}
      {!showConfirm ? (
        <button
          onClick={() => setShowConfirm(true)}
          disabled={running || !account}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold bg-cyan/10 border border-cyan/30 text-cyan hover:bg-cyan/20 rounded-lg transition-colors disabled:opacity-50"
        >
          {running ? (
            <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Conciliando...</>
          ) : (
            <><RefreshCw className="w-3.5 h-3.5" /> Conciliar com Amazon</>
          )}
        </button>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-amber-400 text-center">
            Isso irá buscar todas as campanhas via Amazon API e atualizar o banco.<br />
            Nenhuma campanha será apagada ou reativada automaticamente.
          </p>
          <div className="flex gap-2">
            <button onClick={() => setShowConfirm(false)}
              className="flex-1 px-3 py-2 text-xs font-semibold bg-surface-2 border border-surface-3 text-slate-400 rounded-lg hover:text-white transition-colors">
              Cancelar
            </button>
            <button onClick={runReconciliation}
              className="flex-1 px-3 py-2 text-xs font-semibold bg-cyan text-white rounded-lg hover:bg-cyan/90 transition-colors flex items-center justify-center gap-1.5">
              <CheckCircle className="w-3.5 h-3.5" /> Confirmar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}