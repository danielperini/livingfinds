/**
 * AdsAutopilotScheduled — wrapper passivo para AdsAutopilot.
 * Exibe o status da automação e permite ativar/pausar via AutopilotConfig.
 * Sem MutationObserver, sem hacks de DOM — UI limpa baseada em estado.
 */
import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import AdsAutopilot from '@/pages/AdsAutopilot';
import { Clock, Loader2, PauseCircle, PlayCircle, RefreshCw } from 'lucide-react';

export default function AdsAutopilotScheduled() {
  const [account, setAccount] = useState(null);
  const [config, setConfig] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const me = await base44.auth.me();
        let accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
        if (!accounts.length) accounts = await base44.entities.AmazonAccount.list();
        const current = accounts[0] || null;
        if (!active || !current) return;
        setAccount(current);

        const [configs, logs] = await Promise.all([
          base44.entities.AutopilotConfig.filter({ amazon_account_id: current.id }),
          base44.entities.SyncExecutionLog.filter({ amazon_account_id: current.id }, '-completed_at', 20),
        ]);
        if (!active) return;
        setConfig(configs[0] || { amazon_account_id: current.id, enabled: true });

        const dates = [current.last_sync_at, ...logs.map(l => l.completed_at || l.started_at)]
          .filter(Boolean).map(d => new Date(d).getTime()).filter(t => !isNaN(t));
        if (dates.length) setLastUpdate(new Date(Math.max(...dates)).toISOString());
      } catch { /* silencioso */ }
    })();
    return () => { active = false; };
  }, []);

  async function toggleAutomation() {
    if (!account || saving) return;
    setSaving(true);
    try {
      const enabled = !(config?.enabled !== false);
      const payload = { ...(config || {}), amazon_account_id: account.id, enabled };
      let saved;
      if (config?.id) saved = await base44.entities.AutopilotConfig.update(config.id, payload);
      else saved = await base44.entities.AutopilotConfig.create(payload);
      setConfig(saved || payload);
    } finally {
      setSaving(false);
    }
  }

  const enabled = config?.enabled !== false;
  const fmtDate = d => new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="space-y-4">
      {/* Banner de status da automação */}
      <div className="mx-6 mt-6 rounded-xl border border-cyan/20 bg-cyan/5 p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <Clock className="w-5 h-5 text-cyan mt-0.5 flex-shrink-0" />
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-semibold text-white">
                {enabled ? '✅ Automação ativa — rodando no backend 24h' : '⏸ Automação pausada pelo usuário'}
              </p>
              {enabled && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 font-semibold">ATIVO</span>
              )}
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Motor de bids, harvest de termos, guardrails e execução de ações Amazon rodam via automações agendadas — sem necessidade de ter esta página aberta.
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-slate-500">
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {lastUpdate ? `Última atualização: ${fmtDate(lastUpdate)}` : 'Ainda sem registro de execução'}
              </span>
              <span>{enabled ? 'Pipeline a cada hora + diário às 11h BRT' : 'Aguardando ativação'}</span>
            </div>
          </div>
        </div>
        <button onClick={toggleAutomation} disabled={saving || !account}
          className={`flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-bold disabled:opacity-50 whitespace-nowrap ${enabled ? 'bg-red-500/15 border border-red-500/30 text-red-300 hover:bg-red-500/25' : 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25'}`}>
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : enabled ? <PauseCircle className="w-4 h-4" /> : <PlayCircle className="w-4 h-4" />}
          {saving ? 'Salvando...' : enabled ? 'Pausar Automação' : 'Ativar Automação'}
        </button>
      </div>
      <AdsAutopilot />
    </div>
  );
}