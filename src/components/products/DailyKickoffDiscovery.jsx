import { useState } from 'react';
import { base44 } from '@/api/base44Client';

export default function DailyKickoffDiscovery({ products, accounts, onKickoff, onRefresh }) {
  const [busy,setBusy] = useState(false);
  const [message,setMessage] = useState('');
  const [expanded,setExpanded] = useState(false);
  const candidates=products.filter(p=>['ready','blocked','queued'].includes(p.kickoff_discovery_status) && p.status!=='archived');
  async function scan() {
    setBusy(true);setMessage('');
    try {
      for(const account of accounts) {
        const response=await base44.functions.invoke('discoverDailyKickoffProducts',{amazon_account_id:account.id});
        if(response.data?.ok!==true) throw new Error(response.data?.error || response.data?.results?.find(r=>!r.ok)?.error || 'Não foi possível atualizar a varredura.');
      }
      await onRefresh();setMessage('Varredura concluída.');
    } catch(error) {setMessage(error.message);} finally {setBusy(false);}
  }
  const checked=products.map(p=>p.kickoff_discovery_checked_at).filter(Boolean).sort().pop();
  return <section className="rounded-xl border border-cyan-500/30 bg-cyan-500/5 p-4 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h2 className="font-semibold">Produtos para kickoff · {candidates.length}</h2>
        <p className="text-sm opacity-75">Varredura diária às 07h05 (Brasília), considerando o saldo FBA.</p>
        {checked && <p className="text-xs opacity-70">Última verificação: {new Date(checked).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})}</p>}
      </div>
      <button type="button" disabled={busy} onClick={scan} className="rounded-lg border px-3 py-2 disabled:opacity-50">{busy?'Verificando…':'Verificar novos produtos'}</button>
    </div>
    {message && <p role="status" className="text-sm">{message}</p>}
    {!candidates.length && <p className="text-sm">Nenhuma sugestão pendente na última varredura. Use “Verificar novos produtos” para atualizar.</p>}
    {(expanded?candidates:candidates.slice(0,8)).map(p=><div key={p.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-black/10 p-3">
      <div><p className="font-medium">{p.product_name || p.display_name || p.asin}</p>
        <p className="text-sm">{p.sku} · {p.asin} · FBA: {p.fba_inventory ?? 'não confirmado'}</p>
        <p className="text-sm opacity-80">{p.kickoff_discovery_status==='ready'?'Pronto para configurar o kickoff.':(p.kickoff_discovery_reasons||[]).join(' ')}</p>
      </div>
      <button type="button" disabled={p.kickoff_discovery_status!=='ready'} onClick={()=>onKickoff(p)} className="rounded-lg border px-3 py-2 disabled:opacity-40">Configurar kickoff</button>
    </div>)}
    {candidates.length>8 && <button type="button" onClick={()=>setExpanded(!expanded)} className="underline">{expanded?'Mostrar menos':`Mostrar todos os ${candidates.length} produtos`}</button>}
  </section>;
}
