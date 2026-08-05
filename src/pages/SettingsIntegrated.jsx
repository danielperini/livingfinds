import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import Settings from '@/pages/Settings';
import DaypartingPanel from '@/components/settings/DaypartingPanel';
import { Loader2 } from 'lucide-react';

export default function SettingsIntegrated() {
  const [account, setAccount] = useState(null);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const me = await base44.auth.me();
        const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id }, '-updated_at', 1);
        const current = accounts?.[0] || null;
        if (!active) return;
        setAccount(current);
        if (current) {
          const settings = await base44.entities.PerformanceSettings.filter(
            { amazon_account_id: current.id },
            '-updated_at',
            1,
          ).catch(() => []);
          if (active) setEnabled(settings?.[0]?.dayparting_enabled !== false);

          await base44.functions.invoke('syncDaypartingConfiguration', {
            amazon_account_id: current.id,
            bootstrap_default_rules: true,
            force_holidays: true,
          }).catch(() => null);
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  return (
    <>
      <Settings />
      <section className="px-6 pb-10 max-w-3xl w-full">
        <div className="mb-3 text-left">
          <h2 className="text-base font-semibold text-white">Dayparting</h2>
          <p className="text-xs text-slate-500 mt-1">
            Agendamento central de campanhas, bids e placements. As regras são persistidas em AmazonScheduledRule e executadas pelo motor existente.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4">
          {loading
            ? <div className="bg-surface-1 border border-surface-2 rounded-xl p-6"><Loader2 className="w-5 h-5 animate-spin text-cyan" /></div>
            : <DaypartingPanel account={account} enabled={enabled} />}
        </div>
      </section>
    </>
  );
}