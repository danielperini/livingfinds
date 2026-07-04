import { createClient } from '@base44/sdk';
import { appParams } from '@/lib/app-params';

const { appId, token, functionsVersion, appBaseUrl } = appParams;

export const base44 = createClient({
  appId,
  token,
  functionsVersion,
  serverUrl: '',
  requiresAuth: false,
  appBaseUrl
});

// O dashboard histórico solicitava 500 registros de AdsBidChangeLog.
// Quando esse limite antigo for usado, a consulta passa a buscar todas as páginas.
const adsBidChangeLogEntity = base44.entities.AdsBidChangeLog;
const originalAdsBidChangeFilter = adsBidChangeLogEntity.filter.bind(adsBidChangeLogEntity);

adsBidChangeLogEntity.filter = async (query = {}, sort = '-created_at', limit, offset = 0) => {
  if (Number(limit || 0) < 500) {
    return originalAdsBidChangeFilter(query, sort, limit, offset);
  }

  const pageSize = 200;
  const allRecords = [];
  const seen = new Set();
  let currentOffset = Number(offset || 0);

  while (true) {
    const page = await originalAdsBidChangeFilter(query, sort, pageSize, currentOffset);
    let newRecords = 0;

    for (const record of page) {
      const key = record?.id || `${record?.created_at || ''}:${record?.campaign_id || ''}:${record?.keyword_id || ''}:${allRecords.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      allRecords.push(record);
      newRecords += 1;
    }

    if (page.length < pageSize || newRecords === 0) break;
    currentOffset += pageSize;
  }

  return allRecords;
};