const ACTIVE_CYCLE_STATES = new Set(['running']);
const FAILED_CYCLE_STATES = new Set(['failed', 'exhausted', 'missing', 'ledger_unavailable']);

export function dailyMotorNotice(health, checkedAt = new Date().toISOString()) {
  if (health?.loading) {
    return { tone: 'neutral', title: 'Verificando o ciclo diário', message: 'Consultando o estado atual do motor.', checkedAt };
  }
  if (health?.error || !health?.data?.daily_motor) {
    return { tone: 'warning', title: 'Status do ciclo indisponível', message: 'Não foi possível confirmar se o motor concluiu o ciclo diário.', checkedAt };
  }

  const run = health.data.daily_motor;
  const date = run.date ? new Date(`${run.date}T12:00:00`).toLocaleDateString('pt-BR') : 'hoje';
  if (ACTIVE_CYCLE_STATES.has(String(run.status || '').toLowerCase())) {
    return { tone: 'info', title: 'Motor executando o ciclo diário', message: `Ciclo de ${date} iniciado em ${run.started_at ? new Date(run.started_at).toLocaleString('pt-BR') : 'horário não informado'}. Ainda sem confirmação de conclusão.`, checkedAt };
  }
  if (run.confirmed_success === true || run.status === 'succeeded') {
    return { tone: 'success', title: 'Ciclo diário concluído', message: `Ciclo de ${date} confirmado após ${Number(run.attempts || 1)} tentativa(s).`, checkedAt };
  }
  if (!run.due || run.status === 'not_due') {
    return { tone: 'neutral', title: 'Motor aguardando o ciclo diário', message: `Próximo ciclo previsto para ${run.scheduled_local_time || 'o horário configurado'}.`, checkedAt };
  }
  if (FAILED_CYCLE_STATES.has(String(run.status || '').toLowerCase())) {
    const attempts = Number(run.attempts || 0);
    const reason = String(run.last_error || '').trim();
    return {
      tone: 'danger',
      title: run.status === 'exhausted' ? 'Ciclo diário esgotado sem confirmação' : 'Ciclo diário não concluído',
      message: `Ciclo de ${date} terminou como “${run.status}”${attempts ? ` após ${attempts} tentativa(s)` : ''}.${reason ? ` Motivo registrado: ${reason}` : ''}`,
      checkedAt,
    };
  }
  return { tone: 'warning', title: 'Ciclo diário sem confirmação', message: `O estado atual é “${run.status || 'desconhecido'}”; não é possível afirmar que o motor está em repouso.`, checkedAt };
}
