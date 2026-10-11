export function getExecutionOutcome(result) {
  if (!result) return { status: 'failed', text: 'A API não retornou resultado individual.' };
  if (result.status === 'confirmed' || result.confirmation_status === 'confirmed') {
    return { status: 'confirmed', text: 'Estado confirmado pela integração.' };
  }
  if (result.skipped || result.status === 'blocked') return { status: 'blocked', text: result.reason || result.error || 'Ação bloqueada.' };
  if (result.status === 'failed' || result.ok === false) return { status: 'failed', text: result.error || result.reason || 'Falha informada pela API.' };
  if (result.status === 'confirming' || result.confirmation_status === 'pending' || result.confirmation_required) {
    return { status: 'confirming', text: 'Enviada; aguardando confirmação do estado na Amazon.' };
  }
  if (result.status === 'executed' || result.ok === true) {
    return { status: 'sent', text: 'Solicitação aceita/enviada; confirmação do estado não informada.' };
  }
  return { status: 'failed', text: result.error || result.reason || 'Estado da resposta não reconhecido.' };
}
