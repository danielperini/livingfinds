import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import DaypartingPanel from '@/components/settings/DaypartingPanel';
import { Loader2 } from 'lucide-react';

export default function SettingsDayparting() {
  const [account, setAccount] = useState(null);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      try {
        const me = await base44.auth.me();
        const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
        const acc = accounts[0] || null;
        setAccount(acc);
        if (acc) {
          const settings = await base44.entities.PerformanceSettings.filter({ amazon_account_id: acc.id }, '-updated_at', 1).catch(() => []);
          setEnabled(settings[0]?.dayparting_enabled !== false);
        }
      } finally { setLoading(false); }
    })();
  }, []);
  if (loading) return <div className="p-8"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>;
  return <div className="p-6 max-w-5xl mx-auto"><DaypartingPanel account={account} enabled={enabled} /></div>;
}
