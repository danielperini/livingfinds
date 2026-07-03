import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { CheckCircle, AlertCircle, XCircle, Loader2 } from 'lucide-react';

const statusMap = {
  healthy: ['Saudável', 'text-emerald-400', CheckCircle],
  degraded: ['Degradado', 'text-amber-400', AlertCircle],
  unavailable: ['Indisponível', 'text-red-400', XCircle],
  not_configured: ['Não configurado', 'text-slate-400', AlertCircle],
  checking: ['Verificando...', 'text-cyan', Loader2],
};

function Row({ label, status, detail }) {
  const [text, color, Icon] = statusMap[status] || statusMap.not_configured;
  return <div className="flex items-center justify-between gap-4 border-b border-surface-2 py-4 last:border-0">
    <div><p className="text-sm text-white">{label}</p><p className="mt-1 text-xs text-slate-500">{detail}</p></div>
    <span className={`flex items-center gap-2 text-xs font-semibold ${color}`}><Icon className={`h-4 w-4 ${status === 'checking' ? 'animate-spin' : ''}`} />{text}</span>
  </div>;
}

export default function SystemHealthV4() {
  const [account, setAccount] = useState({ status: 'checking', detail: 'Carregando conta...' });
  const [spApi, setSpApi] = useState({ status: 'checking', detail: 'Verificando SP-API...' });

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const accounts = await base44.entities.AmazonAccount.list();
        const current = accounts[0];
        if (!active) return;
        if (!current) {
          setAccount({ status: 'not_configured', detail: 'Nenhuma conta Amazon configurada.' });
          setSpApi({ status: 'not_configured', detail: 'Configure uma conta Amazon.' });
          return;
        }
        setAccount({ status: current.status === 'connected' ? 'healthy' : 'degraded', detail: `${current.seller_name || current.seller_id || current.id} · Marketplace ${current.marketplace_id || 'não informado'}` });
        const response = await base44.functions.invoke('checkSpApiConnection', { amazon_account_id: current.id });
        const data = response?.data || {};
        if (!active) return;
        if (data.ok) setSpApi({ status: 'healthy', detail: data.message || 'Conexão validada.' });
        else if (data.status === 'not_configured') setSpApi({ status: 'not_configured', detail: data.error || 'Configuração ausente.' });
        else if (data.status === 'auth_error') setSpApi({ status: 'unavailable', detail: data.error || 'Autorização recusada.' });
        else setSpApi({ status: 'degraded', detail: data.error || 'Falha na verificação.' });
      } catch (error) {
        if (active) setSpApi({ status: 'unavailable', detail: error?.response?.data?.error || error?.message || 'Falha na verificação.' });
      }
    })();
    return () => { active = false; };
  }, []);

  return <div className="space-y-5 p-6">
    <div><h1 className="text-lg font-bold text-white">Saúde do Sistema</h1><p className="text-xs text-slate-400">Diagnóstico automático das integrações Amazon</p></div>
    <div className="rounded-xl border border-surface-2 bg-surface-1 px-5">
      <Row label="Conta Amazon" {...account} />
      <Row label="SP-API OAuth (Catálogo/Inventário)" {...spApi} />
    </div>
  </div>;
}
