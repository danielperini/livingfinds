const BRT_TIME_ZONE = 'America/Sao_Paulo';

export function dateKeyInSaoPaulo(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BRT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value instanceof Date ? value : new Date(value));
}

export function kickoffActivityDate(item = {}) {
  const timestamp = item.last_attempt_at
    || item.completed_at
    || item.started_at
    || item.updated_date
    || item.updated_at
    || item.scheduled_at
    || item.created_date
    || item.created_at;
  return timestamp ? dateKeyInSaoPaulo(timestamp) : '';
}

export function filterKickoffByDate(items = [], selectedDate = '') {
  if (!selectedDate) return items;
  return items.filter(item => kickoffActivityDate(item) === selectedDate);
}
