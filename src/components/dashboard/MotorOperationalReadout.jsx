import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';

const dateTime = (value) => value ? new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'não informado';

export default function MotorOperationalReadout({ data, error, accountId }) {
  const [showEvidence, setShowEvidence] = useState(false);
  const [source, setSource] = useState('decisions');
  const [offset, setOffset] = useState(0);
  const [evidence, setEvidence] = useState({ loading: false, error: null, data: null });
  const cycle = data?.daily_motor;
  const cycleDate = cycle?.last_cycle_date;
  useEffect(() => {
    if (!showEvidence || !accountId || !cycleDate) return;
    let active = true;
    setEvidence({ loading: true, error: null, data: null });
    base44.functions.invoke('getMotorCycleEvidence', { account_id: accountId, date: cycleDate, source, offset,
      ...(cycle.correlation_id ? { correlation_id: cycle.correlation_id } : {}),
    }).then((response) => {
      const result = response?.data ?? response;
      if (result?.ok !== true) throw new Error(result?.error || 'Evidência indisponível');
      if (active) setEvidence({ loading: false, error: null, data: result });
    }).catch((err) => { if (active) setEvidence({ loading: false, error: err.message, data: null }); });
    return () => { active = false; };
  }, [showEvidence, accountId, cycleDate, cycle?.correlation_id, source, offset]);

  if (error) return <p role="alert" className="text-xs text-red-600">Falha ao consultar o diagnóstico: {error}</p>;
  if (!data) return <p className="text-xs text-theme-muted">Consultando fontes de leitura do motor…</p>;
  return (
    <div className="space-y-3 mb-4 text-xs text-theme-secondary">
      <p>{cycle?.current_execution_known === false ? 'Execução atual não verificada: uma fonte está indisponível.' : cycle?.is_running ? 'Há uma execução atual em andamento.' : 'Nenhum ciclo atual em execução.'}</p>
      <p>Ciclo histórico ({cycle?.status || 'desconhecido'}): {dateTime(cycle?.finished_at || cycle?.started_at)} · Idade do status: {cycle?.status_age_seconds == null ? 'desconhecida' : `${Math.floor(cycle.status_age_seconds / 60)} min`} · correlation_id: {cycle?.correlation_id || 'ausente no registro legado — sem evidência para reconstruir'}</p>
      {cycle?.reconciliation === 'pending' && <p role="alert" className="text-amber-700">Reconciliação pendente · Estado remoto desconhecido · Replay automático bloqueado.</p>}
      <p>Serviço: {data.service?.status === 'responding' ? 'respondendo' : 'estado não confirmado'} · leitura do banco: {data.service?.database_read === true ? 'confirmada' : 'incompleta'}. Saúde do motor depende também de dados, fila e reconciliação.</p>
      <p>Scheduler: {data.scheduler?.enabled ? data.scheduler?.started ? 'ativo' : 'habilitado, inicialização não confirmada' : 'desabilitado'}{data.scheduler?.healthy === true ? ' · saudável' : ' · saúde não confirmada'}{data.states?.includes('scheduler_error') ? ' · scheduler_error (falha técnica)' : ''}</p>
      {data.scheduler?.last_error && <p role="alert">Causa técnica do scheduler: {data.scheduler.last_error}</p>}
      {data.scheduler?.active_job_errors?.map((job,index) => <p role="alert" key={index}>Job {job.job} · slot {job.slot_key} · {job.cause} · {dateTime(job.at)}</p>)}
      {data.daily_motor?.failed_jobs?.filter(job => job.classification === 'technical_failure').map((job,index) => <p role="alert" key={index}>Falha técnica persistida: {job.function_name} · {job.last_error} · {dateTime(job.updated_at)}</p>)}
      {cycle?.unresolved_run && <p>Execução com resultado remoto desconhecido: {cycle.unresolved_run.id} · correlation_id: {cycle.unresolved_run.correlation_id || 'ausente no registro legado'} · {dateTime(cycle.unresolved_run.date)}</p>}
      {cycle?.block_reason && <p>Motivo do bloqueio: {cycle.block_reason}</p>}
      <p>Decisões stale: {data.decision_counts?.stale ?? '—'} · última decisão criada: {dateTime(data.decision_counts?.last_decision_at)} · bloqueadas: {data.decision_counts?.blocked ?? '—'} · sem evidência de envio: {data.decision_counts?.not_sent ?? '—'} · não enviadas (confirmado): {data.decision_counts?.confirmed_not_sent ?? '—'} · apenas enviadas, sem confirmação: {data.decision_counts?.unconfirmed ?? '—'} · total com evidência de envio: {data.decision_counts?.sent ?? '—'} · confirmadas: {data.decision_counts?.confirmed ?? '—'}</p>
      <p>Fila pendente: {data.decision_recovery?.pending ?? '—'} · propostas recentes sem envio: {data.decision_recovery?.safe_unsent ?? '—'} (ainda sujeitas às validações) · exigem nova coleta e nova decisão: {data.decision_recovery?.requires_new_collection ?? '—'}</p>
      {data.decision_recovery?.blocked_by_remote_unknown && <p role="alert">Recuperação da fila desta conta bloqueada até reconciliação do estado remoto, mesmo para propostas recentes.</p>}
      <div className="grid grid-cols-2 gap-2">
        {[['campaigns', 'Campanhas'], ['products', 'Produtos'], ['decisions', 'Decisões'], ['inventory', 'Estoque']].map(([key, label]) => {
          const freshness = data.data_freshness?.[key];
          return <div key={key}>{label}: última atualização {dateTime(freshness?.latest_at)} · {freshness?.status === 'fresh' ? 'cobertura recente completa' : 'cobertura incompleta / dados stale'}
            <p>Total {freshness?.total_records ?? '—'} · recentes {freshness?.recent_records ?? '—'} · antigos {freshness?.old_records ?? '—'} · sem timestamp {freshness?.missing_timestamp_records ?? '—'} · cobertura {freshness?.coverage_percent ?? '—'}%</p>
            <p className="text-theme-muted">{key === 'decisions' ? 'Criação/avaliação histórica não é falha de sincronização. Novas propostas exigem coleta atual.' : key === 'inventory' ? 'Sincronização de catálogo não comprova atualização de estoque.' : 'Timestamp antigo demonstra idade do registro; falha de sincronização exige evidência do job.'} Janela de cobertura: {freshness?.threshold_minutes ?? '—'} min.</p>
          </div>;
        })}
      </div>
      <p>Dados locais sincronizados: {data.source_counts?.raw_campaign_rows ?? '—'} registros de campanha; {data.source_counts?.enabled_rows ?? '—'} habilitados; {data.source_counts?.incomplete_rows ?? '—'} incompletos; {data.source_counts?.stocked_products ?? '—'} produtos ativos com saldo FBA positivo. A contagem do dashboard remove duplicatas e campanhas excluídas; “ativas” inclui incompletas. Estoque positivo não confirma elegibilidade de ativação.</p>
      {data.source_errors?.map((item, index) => <p role="alert" key={`${item.source}-${index}`}>Fonte {item.source} indisponível: {item.error}</p>)}
      <details><summary>Histórico de jobs preservado (últimos {cycle?.failed_jobs_limit || 100} erros)</summary>{cycle?.failed_jobs_has_more && <p>Há mais registros no ledger do scheduler; esta visão é limitada e não comprova ausência de erros anteriores.</p>}{cycle?.failed_jobs?.filter(job => job.classification !== 'technical_failure').map((job,index) => <p key={index}>{job.function_name} · {job.slot_key} · {job.classification} · {job.last_error}</p>)}</details>
      {cycleDate && <button type="button" className="text-blue-600 underline" onClick={() => { setShowEvidence((value) => !value); setOffset(0); }}>{cycle?.reconciliation === 'pending' ? 'Reconciliar — consultar evidências (somente leitura)' : 'Consultar evidência histórica (somente leitura)'}</button>}
      {showEvidence && <div className="rounded border border-[var(--border-color)] p-3 space-y-2">
        <label>Fonte: <select value={source} onChange={(event) => { setSource(event.target.value); setOffset(0); }}>
          <option value="decisions">Decisões e request_ids</option><option value="claims">Claims</option><option value="history">Histórico e request_ids</option>
        </select></label>
        <p>Ciclo {cycleDate}. Nenhuma operação de reconciliação ou replay é executada por esta consulta.</p>
        {evidence.data?.match_mode === 'local_date_candidates' && <p>Correlação não registrada: listando candidatos da data local, sem afirmar vínculo causal com o ciclo.</p>}
        {evidence.loading && <p>Consultando página…</p>}
        {evidence.error && <p role="alert">{evidence.error}</p>}
        {evidence.data && <>
          <pre className="overflow-auto max-h-72 text-[10px] whitespace-pre-wrap">{JSON.stringify(evidence.data.items, null, 2)}</pre>
          <div className="flex gap-3"><button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 250))}>Anterior</button>
            <span>Registros {offset + 1}–{offset + evidence.data.items.length}</span>
            <button type="button" disabled={evidence.data.next_offset == null} onClick={() => setOffset(evidence.data.next_offset)}>Próxima</button></div>
        </>}
      </div>}
    </div>
  );
}
