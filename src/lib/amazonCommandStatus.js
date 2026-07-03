export function isAmazonRateLimit(value) {
  const text = JSON.stringify(value || '').toLowerCase();
  return text.includes('rate limit') || text.includes('too many requests') || text.includes('throttl') || text.includes('429');
}

export function amazonScheduledMessage(value, options = {}) {
  if (!isAmazonRateLimit(value)) return null;
  const window = options.window || 'a próxima janela automática';
  const action = options.action || 'comando';
  return `A Amazon limitou temporariamente as chamadas. O ${action} foi mantido para ${window}, com intervalo de 14 segundos entre alterações.`;
}
