import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';

/** Read-only audit. Counts observations, not distinct queries or motor decisions. */
export default function SearchTermQualityPanel({ accountId }) {
  const [state, setState] = useState({ rows: [], cycle: null, loading: true, error: false });
  useEffect(() => {
    let active = true;
    if (!accountId) return;
    setState({ rows: [], cycle: null, loading: true, error: false });
    async function load() {
      const groups = await Promise.all(['SearchTerm', 'Keyword', 'ImportedSearchTermReportRow', 'SearchTermQualityAudit'].map(async entity => {
        const rows = [];
        for (let offset = 0; ; offset += 500) {
          const page = await base44.entities[entity].filter({ amazon_account_id: accountId, ...(entity === 'SearchTermQualityAudit' ? {} : { search_term_quality_view: 'audit' }) }, 'id', 500, offset);
          rows.push(...page.filter(row => row.accepted === false));
          if (page.length < 500) return rows;
        }
      }));
      const cycles = await base44.entities.SearchTermQualityCycle.filter({ amazon_account_id: accountId }, '-completed_at', 1);
      if (active) setState({ rows: groups.flat(), cycle: cycles[0] || null, loading: false, error: false });
    }
    load().catch(() => { if (active) setState({ rows: [], loading: false, error: true }); });
    return () => { active = false; };
  }, [accountId]);
  if (!accountId) return null;
  return <details className="rounded-xl border border-slate-700 p-3 text-xs text-slate-400">
    <summary>{state.loading ? 'Consultando qualidade dos termos…' : state.error ? 'Auditoria de termos indisponível' : `${state.rows.length} registros de termos excluídos · consultar motivos`}</summary>
    {state.cycle && <p className="my-2">Última execução com filtragem ({state.cycle.source}, {state.cycle.completed_at}): {state.cycle.filtered_count} registros inválidos filtrados. A validação ocorreu mesmo quando não gerou ações.</p>}
    <p className="my-2">A filtragem é uma etapa de validação e pode terminar sem gerar decisões. Registros históricos e importações são contados por observação; esta contagem não representa um ciclo específico.</p>
    <div className="max-h-64 overflow-auto">{state.rows.map((row, index) => <p key={`${row.id}-${index}`} className="py-1">{row.raw_term || '(vazio)'} → {row.normalized_term || '(vazio)'} · {row.exclusion_reason} · {row.source} · campanha {row.campaign_id || '—'}</p>)}</div>
  </details>;
}
