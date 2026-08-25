// ═══════════════════════════════════════════════════════════════════════════
// motorLabels.js — mapeamento local (sem IA) de reason_code / action / change_type
// para texto amigável em pt-BR. Toda "interpretação" do motor no frontend passa
// por aqui; nada é gerado por LLM.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Classifica o tipo operacional de um item (OptimizationDecision ou AdsBidChangeLog).
 * @returns {{ type: 'bid_change'|'pause'|'enable'|'budget'|'placement'|'exact'|'structure'|'other', icon: string }}
 */
export function getMotorActionType(item) {
  const decisionType = String(item?.decision_type || '').toLowerCase();
  const action = String(item?.action || '').toLowerCase();
  const changeType = String(item?.change_type || item?.reason || item?.classification || '').toLowerCase();
  const stack = `${decisionType} ${action} ${changeType}`;

  if (stack.includes('pause') || stack.includes('paus')) return { type: 'pause', icon: 'pause' };
  if (stack.includes('enable') || stack.includes('reactivat') || stack.includes('ativ')) return { type: 'enable', icon: 'play' };
  if (stack.includes('budget') || stack.includes('orçamento')) return { type: 'budget', icon: 'wallet' };
  if (stack.includes('placement') || stack.includes('top_of_search') || stack.includes('rest_of_search')) return { type: 'placement', icon: 'layers' };
  if (stack.includes('create_keyword') || stack.includes('keyword_add') || stack.includes('harvest_search_term') || stack.includes('promote_same_sku') || stack.includes('exact')) {
    return { type: 'exact', icon: 'target' };
  }
  if (stack.includes('repair_structure') || stack.includes('structure_repair') || stack.includes('repair_campaign')) {
    return { type: 'structure', icon: 'wrench' };
  }
  if (decisionType.includes('bid') || action.includes('bid') || action.includes('lance') || changeType.includes('bid') || item?.new_bid !== undefined || item?.old_bid !== undefined) {
    return { type: 'bid_change', icon: 'trending' };
  }
  return { type: 'other', icon: 'activity' };
}

/**
 * Mapeia reason_code / reason / rationale / change_type para texto amigável em pt-BR.
 * Retorna sempre uma string legível; se não houver código conhecido, usa o rationale
 * bruto (quando existir) ou retorna "Ação automática do motor".
 */
export function getMotorReasonLabel(item) {
  const raw = String(
    item?.reason_code || item?.reason || item?.rationale || item?.change_type || item?.classification || ''
  ).toLowerCase();

  if (!raw) return item?.rationale || 'Ação automática do motor.';

  const map = [
    // Bid — recuperação / sem gasto
    [/recover_delivery|recuperação.*entrega|recuperacao.*entrega|rescue|zero.?delivery/, 'Recuperação de entrega: campanha sem impressões, lance reajustado para voltar a competir.'],
    [/increase_no_spend_?10/, 'Lance aumentado em R$0,10 — campanha ativa sem gasto nas últimas horas.'],
    [/increase_no_spend_?05/, 'Lance aumentado em R$0,05 — sinal de ainda sem gasto, ajuste cauteloso.'],
    [/no.?click|sem.?clique/, 'Redução de lance — campanhas com impressões mas sem cliques relevantes.'],
    [/low.?cpc|cpc.?baixo/, 'Redução de lance — CPC observado abaixo do piso, ajuste para economia.'],
    [/reduce_for_goal|meta.?acos|reduce.?goal/, 'Redução para meta: ACoS acima do alvo, lance reduzido na direção da meta.'],
    [/adjust.?goal|acima.?meta/, 'Ajuste direcionado à meta de performance configurada.'],

    // Pausa / ativação
    [/out_of_stock|sem.?estoque|estoque.?zerado/, 'Pausa protetiva: produto sem estoque vendável.'],
    [/low_stock|estoque.?baixo/, 'Redução/pausa preventiva: estoque baixo, motor conserva cobertura.'],
    [/pause.*manual|manual.*pause|user_manual/, 'Pausa acionada manualmente pelo gestor.'],
    [/pause.*acos|acos.?violation|violação.?acos/, 'Pausa por ACoS: campanha estourou o limite máximo tolerado.'],
    [/pause.*budget|budget.?kill|kill.?switch/, 'Pausa por orçamento: teto diário atingido (kill-switch).'],
    [/reactivat|reativ|enable.*stock|restock/, 'Reativação: estoque restabelecido, campanha voltou a competir.'],
    [/winner|protected.?winner|vencedor/, 'Proteção de termo vencedor mantida (alta performance confirmada).'],

    // Budget
    [/budget.?increase|aumento.?orçamento|redistribui|refill/, 'Orçamento redistribuído: campanha vencedora recebeu mais verba do dia.'],
    [/budget.?decrease|redução.?orçamento|budget.?reduce/, 'Redução de orçamento: campanha em baixa eficiência cedeu verba.'],
    [/budget.?balanc|balancer|equilíbrio.?orçamento/, 'Balanceamento econômico: teto diário recalculado por margem disponível.'],

    // Placement
    [/top_of_search|primeira.?pagina|first.?page/, 'Ajuste de placement Top of Search conforme padrão de pico.'],
    [/rest_of_search|product.?pages/, 'Ajuste de placement conforme curva de desempenho por horário.'],

    // Dayparting
    [/daypart|horário|pico.?janela|peak.?hour/, 'Ajuste horário (dayparting): janela de pico identificada para o ASIN.'],
    [/piso|floor.?bid/, 'Lance levado ao piso: horário de baixa eficiência, economia preservada.'],
    [/boost|incremento.?pico|peak.?boost/, 'Boost de pico: lance aumentado na janela de maior conversão do ASIN.'],
  ];

  for (const [re, label] of map) {
    if (re.test(raw)) return label;
  }

  // Fallback: usa rationale textual se existir, senão mensagem genérica
  return item?.rationale || item?.reason || 'Ação automática do motor baseada nos dados de performance observados.';
}

/**
 * Rótulo curto do tipo de ação (usado nos badges coloridos).
 */
export function getMotorActionBadge(item) {
  const { type } = getMotorActionType(item);
  const badges = {
    bid_change: { label: 'Ajuste de lance', tone: 'blue' },
    pause: { label: 'Pausa', tone: 'amber' },
    enable: { label: 'Ativação', tone: 'green' },
    budget: { label: 'Orçamento', tone: 'violet' },
    placement: { label: 'Placement', tone: 'sky' },
    exact: { label: 'EXACT', tone: 'green' },
    structure: { label: 'Reparo estrutural', tone: 'amber' },
    other: { label: 'Decisão', tone: 'slate' },
  };
  return badges[type] || badges.other;
}

/**
 * Mapeia o status de confirmação na Amazon para um ícone + texto + tom.
 * @returns {{ label: string, tone: 'green'|'amber'|'red'|'slate', symbol: '✓'|'⏳'|'✗'|'·' }}
 */
export function getAmazonConfirmationStatus(item) {
  const decisionStatus = String(item?.status || '').toLowerCase();
  const queueStatus = String(item?.queue_status || '').toLowerCase();
  const confirmationStatus = String(item?.confirmation_status || '').toLowerCase();
  const hasAmazonAttempt = Boolean(
    item?.amazon_request_id || item?.amazon_response || item?.executed_at ||
    item?.last_attempt_at || Number(item?.attempt_count || 0) > 0
  );

  if (['cancelled', 'canceled', 'winner_protection_blocked'].includes(decisionStatus)) {
    return { label: 'Cancelado pelo motor', tone: 'slate', symbol: '·' };
  }
  if (['skipped', 'rejected', 'superseded', 'expired'].includes(decisionStatus)) {
    return { label: 'Impedido pelo motor', tone: 'slate', symbol: '·' };
  }

  if (confirmationStatus === 'confirmed' || ['executed', 'completed', 'success'].includes(decisionStatus)) {
    return { label: 'Confirmado na Amazon', tone: 'green', symbol: '✓' };
  }
  if (decisionStatus === 'pending_approval') {
    return { label: 'Aguardando aprovação', tone: 'amber', symbol: '⏳' };
  }
  if (['executing', 'confirming'].includes(decisionStatus) || queueStatus === 'processing') {
    return hasAmazonAttempt
      ? { label: 'Aguardando confirmação', tone: 'amber', symbol: '⏳' }
      : { label: 'Enviando à Amazon', tone: 'amber', symbol: '⏳' };
  }
  if (confirmationStatus === 'pending' && hasAmazonAttempt) {
    return { label: 'Aguardando confirmação', tone: 'amber', symbol: '⏳' };
  }
  if (decisionStatus === 'scheduled' || queueStatus === 'scheduled') {
    return { label: 'Agendado na fila local', tone: 'amber', symbol: '⏳' };
  }
  if (['pending', 'proposed', 'approved'].includes(decisionStatus) || ['pending', 'queued'].includes(queueStatus)) {
    return { label: 'Na fila local', tone: 'amber', symbol: '⏳' };
  }
  if (decisionStatus === 'blocked') {
    return { label: 'Bloqueado pelo motor', tone: 'red', symbol: '✗' };
  }
  if (['failed', 'failed_final', 'error', 'rolled_back'].includes(decisionStatus) || queueStatus === 'failed') {
    return hasAmazonAttempt
      ? { label: 'Falha no envio à Amazon', tone: 'red', symbol: '✗' }
      : { label: 'Falha antes do envio', tone: 'red', symbol: '✗' };
  }
  return { label: 'Sem confirmação', tone: 'slate', symbol: '·' };
}
