import { useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import AdsAutopilot from '@/pages/AdsAutopilot';
import { Clock, Loader2, PauseCircle, PlayCircle } from 'lucide-react';

function nextWindow(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const hour = Number(value.hour || 0);
  const day = `${value.year}-${value.month}-${value.day}`;

  if (hour < 4) return { label: 'janela 00:00–04:00 em andamento', at: `${day}T04:00:00-03:00` };
  if (hour < 13) return { label: 'hoje, 13:00–14:00', at: `${day}T13:00:00-03:00` };
  if (hour < 14) return { label: 'janela 13:00–14:00 em andamento', at: `${day}T14:00:00-03:00` };

  const tomorrow = new Date(`${day}T12:00:00-03:00`);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowDay = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(tomorrow);
  return { label: 'amanhã, 00:00–04:00', at: `${tomorrowDay}T00:00:00-03:00` };
}

function scheduledMessage(text) {
  const normalized = String(text || '').toLowerCase();
  if (!normalized.includes('rate limit exceeded')) return null;
  if (normalized.includes('dayparting') || normalized.includes('guardrails') || normalized.includes('proteções horárias')) {
    return 'Programado para a janela 13:00–14:00. Nenhuma ação imediata é necessária.';
  }
  return 'Programado para execução gradual na janela 00:00–04:00. Nenhuma ação imediata é necessária.';
}

export default function AdsAutopilotScheduled() {
  const [account, setAccount] = useState(null);
  const [config, setConfig] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [saving, setSaving] = useState(false);
  const windowInfo = useMemo(() => nextWindow(), [lastUpdate, config?.enabled]);

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
          base44.entities.SyncExecutionLog.filter({ amazon_account_id: current.id }, '-completed_at', 50),
        ]);
        if (!active) return;
        setConfig(configs[0] || { amazon_account_id: current.id, enabled: true });

        // Pegar a data mais recente entre todos os logs e o last_sync_at da conta
        const dates = [
          current.last_sync_at,
          ...logs.map((l) => l.completed_at || l.started_at),
        ].filter(Boolean).map((d) => new Date(d).getTime()).filter((t) => !isNaN(t));
        const mostRecent = dates.length ? new Date(Math.max(...dates)).toISOString() : null;
        setLastUpdate(mostRecent);
      } catch {
        // A página original continuará funcionando mesmo sem o resumo programado.
      }
    })();
    return () => { active = false; };
  }, []);

  // Atualiza a data uma vez por hora para refletir syncs automáticos do backend
  useEffect(() => {
    const interval = window.setInterval(async () => {
      try {
        const me = await base44.auth.me();
        let accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
        if (!accounts.length) accounts = await base44.entities.AmazonAccount.list();
        const current = accounts[0];
        if (!current) return;
        const logs = await base44.entities.SyncExecutionLog.filter({ amazon_account_id: current.id }, '-completed_at', 50);
        const dates = [current.last_sync_at, ...logs.map((l) => l.completed_at || l.started_at)]
          .filter(Boolean).map((d) => new Date(d).getTime()).filter((t) => !isNaN(t));
        if (dates.length) setLastUpdate(new Date(Math.max(...dates)).toISOString());
      } catch { /* silencioso */ }
    }, 60 * 60 * 1000); // 1 hora
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const patch = () => {
      const buttons = document.querySelectorAll('button');
      buttons.forEach((button) => {
        const text = button.textContent?.replace(/\s+/g, ' ').trim();
        if (['Analisar & Executar', 'Só Analisar', 'Executar análise agora', 'Automação Total', 'Parar Automação'].includes(text)) {
          button.style.display = 'none';
          button.setAttribute('aria-hidden', 'true');
        }
      });

      const nodes = document.querySelectorAll('p, span, div');
      nodes.forEach((node) => {
        if (node.children.length > 0) return;
        const replacement = scheduledMessage(node.textContent);
        if (replacement) {
          node.textContent = replacement;
          node.classList.remove('text-red-400');
          node.classList.add('text-cyan');
        }
        if (node.textContent?.trim() === 'Automação Total em Andamento') {
          node.textContent = 'Automação programada';
        }
      });
    };

    patch();
    const observer = new MutationObserver(patch);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
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
  return (
    <div className="space-y-4">
      <div className="mx-6 mt-6 rounded-xl border border-cyan/20 bg-cyan/5 p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <Clock className="w-5 h-5 text-cyan mt-0.5" />
          <div>
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold text-white">{enabled ? '✅ Automação Segura — rodando 24h sem página aberta' : '⏸ Automação pausada pelo usuário'}</p>
              {enabled && <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 font-semibold">ATIVO</span>}
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Aprendizado AUTO, otimização de bids, harvest de termos, colheita, guardrails e execução de ações Amazon rodam automaticamente no backend — independente de qualquer página aberta.
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-slate-500">
              <span>Última atualização: {lastUpdate ? new Date(lastUpdate).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'ainda não registrada'}</span>
              <span>Próxima execução: {enabled ? windowInfo.label : 'aguardando ativação do usuário'}</span>
            </div>
          </div>
        </div>
        <button onClick={toggleAutomation} disabled={saving || !account}
          className={`flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-bold disabled:opacity-50 ${enabled ? 'bg-red-500/15 border border-red-500/30 text-red-300 hover:bg-red-500/25' : 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25'}`}>
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : enabled ? <PauseCircle className="w-4 h-4" /> : <PlayCircle className="w-4 h-4" />}
          {saving ? 'Salvando...' : enabled ? 'Parar Automação' : 'Ativar Automação'}
        </button>
      </div>
      <AdsAutopilot />
    </div>
  );
}