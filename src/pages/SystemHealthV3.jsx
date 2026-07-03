import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { CheckCircle, AlertCircle, XCircle, Loader2, RefreshCw } from 'lucide-react';

const styles = {
  healthy: ['Saudável', 'text-emerald-400', CheckCircle],
  degraded: ['Degradado', 'text-amber-400', AlertCircle],
  unavailable: ['Indisponível', 'text-red-400', XCircle],
  not_configured: ['Não configurado', 'text-slate-400', AlertCircle],
  checking: ['Verificando...', 'text-cyan', Loader2],
};

function StatusRow({ label, status = 'checking', detail }) {
  const [text, color, Icon] = styles[status] || styles.not_configured;
  return <div className="flex items-center justify-between gap-4 border-b border-surface-2 py-4 last:border-0">
    <div><p className="text-sm text-white">{label}</p><p className="mt-1 text-xs text-slate-500">{detail}</p></div>
    <span className={`flex items-center gap-2 text-xs font-semibold ${color}`}><Icon className={`h-4 w-4 ${status === 'checking' ? 'animate-spin' : ''}`} />{text}</span>
  </div>;
}

export default function SystemHealthV3() {
  const [loading, setLoading] = useState(false);
  const [spApi, setSpApi] = useState({ status: 'checking', detail: 'Testando OAuth da SP-API...' });
  const [account, setAccount] = useState({ status: 'checking', detail: 'Carregando conta...' });

  async function run() {
    setLoading(true);
    setSpApi({ status: 'checking', detail: 'Testando OAuth da SP-API...' });
    try {
      const accounts = await base44.entities.AmazonAccount.list();
      const current = accounts[0];
      if (!current) {
        setAccount({ status: 'not_configured', detail: 'Nenhuma conta Amazon configurada.' });
        setSpApi({ status: 'not_configured', detail: 'Configure uma conta Amazon antes de testar a SP-API.' });
        return;
      }

      setAccount({
        status: current.status === 'connected' ? 'healthy' : 'degraded',
        detail: `${current.seller_name || current.seller_id || current.id} · Marketplace ${current.marketplace_id || 'não informado'}`,
      });

      const response = await base44.functions.invoke('checkSpApiConnection', { amazon_account_id: current.id });
      const data = response?.data || {};

      if (data.ok) {
        const configured = data.configured_with || {};
        setSpApi({
          status: 'healthy',
          detail: `${data.message} Secrets ativos: ${configured.refresh_token}, ${configured.client_id}, ${configured.client_secret}.`,
        });
      } else if (data.status === 'not_configured') {
        setSpApi({ status: 'not_configured', detail: data.error || 'Secrets SP-API ausentes.' });
      } else if (data.status === 'auth_error') {
        setSpApi({ status: 'unavailable', detail: `Credenciais encontradas, mas a Amazon recusou o OAuth: ${data.error}` });
      } else {
        setSpApi({ status: 'degraded', detail: data.error || 'Falha ao testar a SP-API.' });
      }
    } catch (error) {
      setSpApi({
        status: 'unavailable',
        detail: error?.response?.data?.error || error?.message || 'Erro ao testar a SP-API.',
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { run(); }, []);

  return <div className="space-y-5 p-6">
    <div className="flex items-center justify-between">
      <div><h1 className="text-lg font-bold text-white">Saúde do Sistema</h1><p className="text-xs text-slate-400">Diagnóstico real das integrações Amazon</p></div>
      <button onClick={run} disabled={loading} className="flex items-center gap-2 rounded-lg bg-cyan px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        Executar diagnóstico
      </button>
    </div>

    <div className="rounded-xl border border-surface-2 bg-surface-1 px-5">
      <StatusRow label="Conta Amazon" {...account} />
      <StatusRow label="SP-API OAuth (Catálogo/Inventário)" {...spApi} />
    </div>
  </div>;
}
