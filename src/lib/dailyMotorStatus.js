export function dailyMotorNotice(health, checkedAt = new Date().toISOString()) {
  if (health?.loading) {
    return { tone: 'neutral', title: 'Verificando o ciclo diário', message: 'Consultando o estado atual do motor.', checkedAt };
  }
  if (health?.error || !health?.data?.daily_motor) {
    return { tone: 'warning', title: 'Status do ciclo indisponível', message: 'Não foi possível confirmar se o motor concluiu o ciclo diário.', checkedAt };
  }

  const run = health.data.daily_motor;
  const scheduler = health.data.scheduler;
  const schedulerActive = scheduler?.enabled === true && scheduler?.started === true;
  const cycleAt = run.finished_at || run.started_at;
  const date = cycleAt ? new Date(cycleAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    : run.date ? new Date(`${run.date}T12:00:00`).toLocaleDateString('pt-BR') : 'data não registrada';
  const currentKnown = run.current_execution_known !== false;
  const current = run.is_running === true || (run.is_running === undefined && run.status === 'running');
  const unknown = run.remote_outcome === 'unknown' || run.reconciliation === 'pending';
  const idleText = current ? '' : currentKnown ? ' Nenhum ciclo atual em execução.' : ' Não foi possível verificar a execução atual.';
  const safety = unknown ? ' Estado remoto desconhecido. Reconciliação pendente. Replay automático bloqueado.'
    : run.replay === 'blocked' ? ' Replay automático bloqueado.' : '';
  const activeText = schedulerActive ? ' Scheduler e worker do motor estão ativos.' : '';
  const details = `Ciclo histórico de ${date}. correlation_id: ${run.correlation_id || 'ausente no registro legado'}.${Number(run.attempts) ? ` ${run.attempts} tentativa(s).` : ''}${idleText}${activeText}${safety}`;
  if (current) return { tone: unknown ? 'danger' : 'info', title: 'Motor executando o ciclo diário',
    message: `correlation_id: ${run.current_run?.correlation_id || run.correlation_id || 'ausente no registro legado'}. Início ${run.current_run?.started_at || date}. Ainda sem confirmação de conclusão.${activeText}${safety}`, checkedAt };
  if (run.status === 'exhausted') return { tone: schedulerActive ? 'warning' : 'danger', title: schedulerActive ? 'Motor ativo · último ciclo diário esgotado' : 'Último ciclo diário: esgotado e bloqueado',
    message: `${details}${run.last_error ? ` Motivo registrado: ${run.last_error}` : ''}`, checkedAt };
  if (unknown) return { tone: schedulerActive ? 'warning' : 'danger', title: schedulerActive ? 'Motor ativo · reconciliação do último ciclo pendente' : 'Último ciclo diário: reconciliação pendente', message: details, checkedAt };
  if (run.confirmed_success === true || run.status === 'succeeded') return { tone: 'success', title: 'Último ciclo diário concluído', message: details, checkedAt };
  if (run.status === 'running') return { tone: 'warning', title: 'Estado de execução desatualizado', message: details, checkedAt };
  if (!run.due || run.status === 'not_due') return { tone: 'neutral', title: schedulerActive ? 'Motor ativo · aguardando o próximo ciclo diário' : 'Motor aguardando o próximo ciclo diário',
    message: `${idleText}${activeText} Próximo ciclo previsto para ${run.scheduled_local_time || 'o horário configurado'}.`, checkedAt };
  return { tone: schedulerActive ? 'warning' : 'warning', title: schedulerActive ? 'Motor ativo · último ciclo sem confirmação' : 'Último ciclo diário sem confirmação', message: `${details}${run.last_error ? ` Motivo: ${run.last_error}` : ''}`, checkedAt };
}
