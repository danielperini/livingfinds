import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { CloudUpload, CheckCircle, XCircle, Loader2, Clock } from 'lucide-react';

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

export default function BackupPanel() {
  const [logs, setLogs] = useState([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);

  const loadLogs = async () => {
    const data = await base44.entities.BackupAuditLog.filter(
      { operation: 'backup' },
      '-started_at',
      10
    ).catch(() => []);
    setLogs(data);
  };

  useEffect(() => { loadLogs(); }, []);

  const runManualBackup = async () => {
    setRunning(true);
    setResult(null);
    try {
      const res = await base44.functions.invoke('runBackupToDrive', { backup_type: 'manual' });
      setResult(res.data);
      await loadLogs();
    } catch (e) {
      setResult({ ok: false, error: e.message });
    } finally {
      setRunning(false);
    }
  };

  const lastSuccess = logs.find(l => l.status === 'completed' || l.status === 'completed_with_warnings');

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-300">Backup Google Drive</h3>
          <p className="text-[10px] text-slate-500 mt-0.5">
            Automático: diário às 02h · semanal às Sex 14:30 · mensal dia 1
          </p>
        </div>
        <button
          onClick={runManualBackup}
          disabled={running}
          className="flex items-center gap-2 px-4 py-2 bg-cyan/10 border border-cyan/30 hover:bg-cyan/20 text-cyan text-xs font-semibold rounded-lg transition-colors disabled:opacity-50"
        >
          {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CloudUpload className="w-3.5 h-3.5" />}
          {running ? 'Executando...' : 'Backup manual agora'}
        </button>
      </div>

      {/* Resultado do último manual */}
      {result && (
        <div className={`flex items-start gap-2 px-3 py-2.5 rounded-lg text-xs border ${
          result.ok ? 'bg-emerald-500/8 border-emerald-500/20 text-emerald-300' : 'bg-red-500/8 border-red-500/20 text-red-300'
        }`}>
          {result.ok
            ? <CheckCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            : <XCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />}
          <div>
            {result.ok
              ? <span><strong>{result.total_records?.toLocaleString('pt-BR')}</strong> registros · <strong>{result.total_files}</strong> arquivos · {fmtDuration(result.duration_ms)}</span>
              : <span>{result.error}</span>
            }
            {result.errors?.length > 0 && <p className="text-amber-400 mt-0.5">{result.errors.length} avisos</p>}
          </div>
        </div>
      )}

      {/* Último backup bem-sucedido */}
      {lastSuccess && (
        <div className="flex items-center gap-2 text-[10px] text-slate-500">
          <Clock className="w-3 h-3" />
          <span>Último backup: <span className="text-slate-400">{fmtDate(lastSuccess.completed_at)}</span></span>
          <span>·</span>
          <span>{lastSuccess.records_processed?.toLocaleString('pt-BR') || 0} registros</span>
          <span>·</span>
          <span className={lastSuccess.status === 'completed' ? 'text-emerald-400' : 'text-amber-400'}>
            {lastSuccess.backup_type?.replace('_', ' ')}
          </span>
        </div>
      )}

      {/* Histórico compacto */}
      {logs.length > 0 && (
        <div className="space-y-1 border-t border-surface-2 pt-3">
          <p className="text-[10px] text-slate-500 mb-2">Histórico recente</p>
          {logs.slice(0, 5).map((log, i) => (
            <div key={log.id || i} className="flex items-center justify-between text-[10px]">
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                  log.status === 'completed' ? 'bg-emerald-400' :
                  log.status === 'completed_with_warnings' ? 'bg-amber-400' :
                  log.status === 'running' ? 'bg-cyan animate-pulse' : 'bg-red-400'
                }`} />
                <span className="text-slate-400">{log.backup_type?.replace(/_/g, ' ')}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-slate-500">{(log.records_processed || 0).toLocaleString('pt-BR')} reg.</span>
                <span className="text-slate-600">{fmtDate(log.started_at)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}