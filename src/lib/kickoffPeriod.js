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

export function filterKickoffByDateRange(items = [], startDate = '', endDate = '') {
  if (!startDate && !endDate) return items;
  return items.filter(item => {
    const activityDate = kickoffActivityDate(item);
    if (!activityDate) return false;
    return (!startDate || activityDate >= startDate) && (!endDate || activityDate <= endDate);
  });
}

export async function loadAllKickoffQueuePages(fetchPage, pageSize = 200) {
  const records = [];
  const seenRecordIds = new Set();
  let offset = 0;
  let previousPageSignature = '';

  while (true) {
    const page = await fetchPage(offset, pageSize);
    if (!Array.isArray(page) || page.length === 0) break;

    const pageKeys = page.map(record => record.id || [record.asin, record.created_date, record.status, record.keyword].join('|'));
    const signature = pageKeys.join('::');
    // Stop if an API/SDK ignores offset and repeats the same page forever.
    if (signature === previousPageSignature) break;
    previousPageSignature = signature;

    let added = 0;
    page.forEach((record, index) => {
      const id = record.id || `${pageKeys[index]}|${offset + index}`;
      if (seenRecordIds.has(id)) return;
      seenRecordIds.add(id);
      records.push(record);
      added += 1;
    });

    if (page.length < pageSize || added === 0) break;
    offset += pageSize;
  }

  return records;
}
