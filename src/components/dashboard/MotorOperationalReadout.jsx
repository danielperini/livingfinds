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
      <p>Último ciclo: {dateTime(cycle?.finished_at || cycle?.started_at)} · Idade do status: {cycle?.status_age_seconds == null ? 'desconhecida' : `${Math.floor(cycle.status_age_seconds / 60)} min`} · Correlação: {cycle?.correlation_id || 'não registrada'}</p>
      {cycle?.reconciliation === 'pending' && <p role="alert" className="text-amber-700">Reconciliação pendente · Estado remoto desconhecido · Replay automático bloqueado.</p>}
      <p>Scheduler: {data.scheduler?.enabled ? data.scheduler?.started ? 'ativo' : 'habilitado, inicialização não confirmada' : 'desabilitado'}{data.states?.includes('scheduler_error') ? ' · scheduler_error' : ''}</p>
      {data.scheduler?.last_error && <p role="alert">Falha registrada do scheduler. Consulte o diagnóstico técnico do serviço.</p>}
      <div className="grid grid-cols-2 gap-2">
        {[['campaigns', 'Campanhas'], ['products', 'Produtos'], ['decisions', 'Decisões'], ['inventory', 'Estoque']].map(([key, label]) => {
          const freshness = data.data_freshness?.[key];
          return <p key={key}>{label}: última atualização {dateTime(freshness?.latest_at)} · {(freshness?.latest_status || freshness?.status) === 'fresh' ? 'recente' : 'data_stale'}
            {freshness?.stale_records > 0 && <span className="block text-amber-700">Cobertura da fonte: {freshness.stale_records} de {freshness.total_records} registros antigos ou sem timestamp confiável.</span>}
          </p>;
        })}
      </div>
      <p>Dados locais sincronizados: {data.source_counts?.raw_campaign_rows ?? '—'} registros de campanha; {data.source_counts?.enabled_rows ?? '—'} habilitados; {data.source_counts?.incomplete_rows ?? '—'} incompletos; {data.source_counts?.stocked_products ?? '—'} produtos ativos com saldo FBA positivo. A contagem do dashboard remove duplicatas e campanhas excluídas; “ativas” inclui incompletas. Estoque positivo não confirma elegibilidade de ativação.</p>
      {data.source_errors?.map((item, index) => <p role="alert" key={`${item.source}-${index}`}>Fonte {item.source} indisponível: {item.error}</p>)}
      {cycleDate && <button type="button" className="text-blue-600 underline" onClick={() => { setShowEvidence((value) => !value); setOffset(0); }}>Consultar evidência histórica (somente leitura)</button>}
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
