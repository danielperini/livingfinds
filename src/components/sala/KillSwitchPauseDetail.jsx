import { Pause } from 'lucide-react';

/**
 * KillSwitchPauseDetail — exibe status detalhado das pausas do kill switch
 * Lê global_stop_snapshot para mostrar: confirmadas, reconciliadas, local-only, não propagadas, falhas
 */
export default function KillSwitchPauseDetail({ controller: c }) {
  let snapshot = null;
  try { snapshot = c?.global_stop_snapshot ? JSON.parse(c.global_stop_snapshot) : null; } catch {}

  const confirmed  = snapshot?.paused_confirmed  ?? [];
  const localOnly  = snapshot?.paused_local_only ?? [];
  const failed     = snapshot?.pause_failed      ?? [];
  const unconf     = snapshot?.unconfirmed_after_get ?? [];
  const reconciled = snapshot?.reconciled        ?? [];
  const legacyIds  = c?.campaigns_paused_today   ?? [];

  const hasDetail = confirmed.length + localOnly.length + failed.length + unconf.length + reconciled.length > 0;
  const hasLegacy = !hasDetail && legacyIds.length > 0;

  if (!hasDetail && !hasLegacy) return null;

  return (
    <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Pause className="w-4 h-4 text-red-400" />
        <p className="text-xs font-semibold text-red-300">Campanhas Pausadas pelo Teto Hoje</p>
        <span className="ml-auto text-[9px] text-slate-500">Retomada: 00h BRT</span>
      </div>

      {hasDetail && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          <div className="bg-surface-2/60 rounded-lg p-2 text-center">
            <p className="text-lg font-bold text-emerald-300">{confirmed.length}</p>
            <p className="text-[9px] text-slate-500">Confirmadas</p>
          </div>
          <div className="bg-surface-2/60 rounded-lg p-2 text-center">
            <p className={`text-lg font-bold ${reconciled.length > 0 ? 'text-cyan' : 'text-slate-500'}`}>{reconciled.length}</p>
            <p className="text-[9px] text-slate-500">Reconciliadas</p>
          </div>
          <div className="bg-surface-2/60 rounded-lg p-2 text-center">
            <p className={`text-lg font-bold ${localOnly.length > 0 ? 'text-amber-400' : 'text-slate-500'}`}>{localOnly.length}</p>
            <p className="text-[9px] text-slate-500">Local-only</p>
          </div>
          <div className="bg-surface-2/60 rounded-lg p-2 text-center">
            <p className={`text-lg font-bold ${unconf.length > 0 ? 'text-orange-400' : 'text-slate-500'}`}>{unconf.length}</p>
            <p className="text-[9px] text-slate-500">Não propagadas</p>
          </div>
          <div className="bg-surface-2/60 rounded-lg p-2 text-center">
            <p className={`text-lg font-bold ${failed.length > 0 ? 'text-red-400' : 'text-slate-500'}`}>{failed.length}</p>
            <p className="text-[9px] text-slate-500">Falhas persist.</p>
          </div>
        </div>
      )}

      {localOnly.length > 0 && (
        <div className="px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg">
          <p className="text-[10px] text-amber-400 font-semibold mb-0.5">⚠ {localOnly.length} sem amazon_campaign_id válido — pausadas apenas no banco</p>
          <p className="text-[9px] text-slate-400">Verifique o vínculo dessas campanhas com a Amazon Ads API.</p>
        </div>
      )}

      {failed.length > 0 && (
        <div className="px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg">
          <p className="text-[10px] text-red-400 font-semibold mb-1">✗ {failed.length} campanha(s) falharam mesmo após retry automático (5 min)</p>
          <div className="flex flex-wrap gap-1 mt-1">
            {failed.slice(0, 10).map((id) => (
              <span key={id} className="text-[9px] font-mono px-1.5 py-0.5 bg-red-500/10 border border-red-500/20 text-red-300 rounded">{id}</span>
            ))}
            {failed.length > 10 && <span className="text-[9px] text-slate-500">+{failed.length - 10} mais</span>}
          </div>
        </div>
      )}

      {unconf.length > 0 && (
        <div className="px-3 py-2 bg-orange-500/10 border border-orange-500/20 rounded-lg">
          <p className="text-[10px] text-orange-400 font-semibold mb-0.5">⚡ {unconf.length} não propagadas detectadas via GET — tentativa de reconciliação feita</p>
        </div>
      )}

      {confirmed.length > 0 && (
        <details className="group">
          <summary className="text-[10px] text-slate-500 cursor-pointer hover:text-slate-300 transition-colors list-none flex items-center gap-1 select-none">
            <span className="group-open:hidden">▶</span>
            <span className="hidden group-open:inline">▼</span>
            {' '}Ver {confirmed.length} IDs confirmados
          </summary>
          <div className="flex flex-wrap gap-1 mt-2">
            {confirmed.slice(0, 30).map((cid) => (
              <span key={cid} className="text-[9px] font-mono px-1.5 py-0.5 bg-red-500/10 border border-red-500/20 text-red-300 rounded">{cid}</span>
            ))}
            {confirmed.length > 30 && <span className="text-[9px] text-slate-500">+{confirmed.length - 30} mais</span>}
          </div>
        </details>
      )}

      {hasLegacy && (
        <div className="flex flex-wrap gap-1.5">
          {legacyIds.slice(0, 30).map((cid) => (
            <span key={cid} className="text-[10px] font-mono px-2 py-0.5 bg-red-500/10 border border-red-500/20 text-red-300 rounded">{cid}</span>
          ))}
          {legacyIds.length > 30 && <span className="text-[9px] text-slate-500">+{legacyIds.length - 30}</span>}
        </div>
      )}
    </div>
  );
}