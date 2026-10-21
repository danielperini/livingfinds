const ATTRIBUTION_WINDOWS = new Set([1, 7, 14, 30]);

function textValue(row, ...keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

function normalizeDate(value) {
  const raw = String(value ?? '').trim();
  let year; let month; let day;
  let match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) [, year, month, day] = match;
  else {
    match = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!match) return null;
    [, day, month, year] = match;
  }
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() + 1 !== Number(month) || date.getUTCDate() !== Number(day)) return null;
  return `${year}-${month}-${day}`;
}

function numberValue(row, ...keys) {
  for (const key of keys) {
    const raw = row?.[key];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    let value = String(raw).trim().replace(/[^\d,.-]/g, '');
    if (value.includes(',') && value.includes('.')) {
      const decimalSeparator = value.lastIndexOf(',') > value.lastIndexOf('.') ? ',' : '.';
      const thousandsSeparator = decimalSeparator === ',' ? '.' : ',';
      const decimalDigits = value.length - value.lastIndexOf(decimalSeparator) - 1;
      if (decimalDigits < 1 || decimalDigits > 2) return null;
      value = value.split(thousandsSeparator).join('').replace(decimalSeparator, '.');
    } else if (value.includes(',')) {
      const groups = value.split(',');
      if (groups.length > 2 || (groups.length === 2 && groups[1].length === 3 && groups[0].length <= 3)) return null;
      value = value.replace(',', '.');
    } else if (value.includes('.')) {
      const groups = value.split('.');
      if (groups.length > 2 || (groups.length === 2 && groups[1].length === 3 && groups[0].length <= 3)) return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stableUniqueKey(parts) {
  return parts.map((part) => encodeURIComponent(String(part ?? '').trim().toLowerCase())).join('|');
}

/** Validate and normalize one-day rows; never invent a day or attribution window. */
export async function normalizeImportedSearchTermRows(rows, account, syncedAt) {
  const accountId = typeof account === 'string' ? account : account?.id;
  if (!Array.isArray(rows) || rows.length === 0) return { ok: false, error: 'O relatório não contém linhas.' };
  if (!accountId) return { ok: false, error: 'Conta Amazon ausente.' };

  const normalized = [];
  const seen = new Map();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const dateValue = textValue(row, 'date', 'Data', 'Date');
    const startValue = dateValue || textValue(row, 'Data inicial', 'Start Date', 'startDate');
    const endValue = dateValue || textValue(row, 'Data final', 'End Date', 'endDate') || startValue;
    const start = normalizeDate(startValue);
    const end = normalizeDate(endValue);
    if (!start || !end) return { ok: false, error: `Linha ${index + 1}: data inicial/final ausente ou inválida; não foi importado nenhum dado.` };
    if (start !== end) return { ok: false, error: `Linha ${index + 1}: período ${start} a ${end} é agregado. Esta tabela aceita somente linhas diárias; nenhum dado foi alterado.` };

    const windowValue = numberValue(row, 'Janela de atribuição (dias)', 'Attribution Window (days)', 'attribution_window_days', 'attributionWindowDays');
    if (windowValue === null || !ATTRIBUTION_WINDOWS.has(windowValue)) {
      return { ok: false, error: `Linha ${index + 1}: informe uma janela de atribuição explícita (1, 7, 14 ou 30 dias); nenhum dado foi alterado.` };
    }
    const campaignId = textValue(row, 'ID da campanha', 'Campaign ID', 'campaignId');
    const searchTerm = textValue(row, 'Termo de pesquisa', 'Search Term', 'searchTerm');
    if (!campaignId || !searchTerm) return { ok: false, error: `Linha ${index + 1}: ID da campanha e termo de pesquisa são obrigatórios; nenhum dado foi alterado.` };

    const impressions = numberValue(row, 'Impressões', 'Impressions', 'impressions');
    const clicks = numberValue(row, 'Cliques', 'Clicks', 'clicks');
    const spend = numberValue(row, 'Gastos', 'Spend', 'spend');
    const sales = numberValue(row, 'Vendas', 'Sales', 'sales');
    const orders = numberValue(row, 'Pedidos', 'Orders', 'orders');
    const units = numberValue(row, 'Unidades vendidas', 'Units Sold', 'units');
    const values = { impressions, clicks, spend, sales, orders, units };
    const invalidMetric = Object.entries(values).find(([, value]) => value !== null && value < 0);
    if (invalidMetric) return { ok: false, error: `Linha ${index + 1}: métrica ${invalidMetric[0]} negativa; nenhum dado foi alterado.` };
    if (Object.values(values).some((value) => value === null)) {
      return { ok: false, error: `Linha ${index + 1}: métrica ausente ou inválida; nenhum dado foi alterado.` };
    }

    const matchTypeRaw = textValue(row, 'Tipo de correspondência', 'Match Type', 'matchType').toLowerCase();
    const matchType = /exat|exact/.test(matchTypeRaw) ? 'exact' : /fras|phrase/.test(matchTypeRaw) ? 'phrase' : /auto/.test(matchTypeRaw) ? 'auto' : 'broad';
    const adGroupId = textValue(row, 'ID do grupo de anúncios', 'Ad Group ID', 'adGroupId');
    const keywordId = textValue(row, 'ID da palavra-chave', 'Keyword ID', 'keywordId');
    const targetingIdentity = keywordId || stableUniqueKey([textValue(row, 'Palavra-chave', 'Keyword'), matchType]);
    const key = stableUniqueKey([accountId, campaignId, adGroupId, targetingIdentity, searchTerm, start]);
    const windowFields = {};
    for (const days of [1, 7, 14, 30]) {
      windowFields[`orders_${days}d`] = days === windowValue ? orders : null;
      windowFields[`units_${days}d`] = days === windowValue ? units : null;
      windowFields[`sales_${days}d`] = days === windowValue ? sales : null;
    }
    const record = {
      amazon_account_id: accountId,
      marketplace_id: typeof account === 'string' ? '' : String(account?.marketplace_id || ''),
      currency_code: typeof account === 'string' ? '' : String(account?.currency_code || ''),
      country_code: typeof account === 'string' ? '' : String(account?.country_code || ''),
      date: start,
      source_period_start: start,
      source_period_end: end,
      source_granularity: 'daily',
      source_report_type: 'manual_search_term_import',
      source_attribution_window_days: windowValue,
      attribution_window_days: windowValue,
      attribution_source: 'manual_import_report',
      same_sku_attribution_verified: false,
      decision_eligible: false,
      campaign_id: campaignId,
      campaign_name: textValue(row, 'Campanha', 'Campaign'),
      ad_group_id: adGroupId,
      ad_group_name: textValue(row, 'Grupo de anúncios', 'Ad Group'),
      keyword_id: keywordId,
      keyword_text: textValue(row, 'Palavra-chave', 'Keyword'),
      keyword_type: 'search_term',
      match_type: matchType,
      search_term: searchTerm,
      advertised_asin: textValue(row, 'ASIN', 'advertisedAsin'),
      advertised_sku: textValue(row, 'SKU', 'advertisedSku'),
      impressions, clicks, spend, sales, orders, units,
      ...windowFields,
      ctr: impressions > 0 ? clicks / impressions * 100 : null,
      cpc: clicks > 0 ? spend / clicks : null,
      acos: sales > 0 ? spend / sales * 100 : null,
      roas: spend > 0 ? sales / spend : null,
      conversion_rate: clicks > 0 ? orders / clicks * 100 : null,
      unique_key: key,
      synced_at: syncedAt,
    };
    const previous = seen.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(record)) {
      return { ok: false, error: `Linha ${index + 1}: chave duplicada com valores divergentes; nenhum dado foi alterado.` };
    }
    if (!previous) {
      seen.set(key, record);
      normalized.push(record);
    }
  }
  const batchPayload = normalized
    .map(({ synced_at: _syncedAt, ...record }) => record)
    .sort((left, right) => left.unique_key.localeCompare(right.unique_key));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(batchPayload)));
  const batchId = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  for (const record of normalized) {
    record.source_record_key = record.unique_key;
    record.unique_key = stableUniqueKey([record.unique_key, batchId]);
    record.import_batch_id = batchId;
  }
  return { ok: true, batch_id: batchId, records: normalized, duplicates_removed: rows.length - normalized.length };
}

/** Keep immutable report versions for audit, but expose only the latest completed row per source observation. */
export function selectActiveImportedSearchTermRows(rows, batches) {
  const completed = new Map((batches || [])
    .filter((batch) => batch.status === 'completed')
    .map((batch) => [batch.id, batch]));
  const active = new Map();
  for (const row of rows || []) {
    const batch = completed.get(row.import_batch_id);
    if (!batch) continue;
    const key = row.source_record_key || row.unique_key;
    const current = active.get(key);
    const versionTime = Date.parse(batch.completed_at || batch.started_at || '') || 0;
    const currentTime = current ? (Date.parse(current.batch.completed_at || current.batch.started_at || '') || 0) : -1;
    if (!current || versionTime > currentTime || (versionTime === currentTime && String(batch.id) > String(current.batch.id))) {
      active.set(key, { row, batch });
    }
  }
  return [...active.values()].map(({ row }) => ({ ...row, decision_eligible: false, imported_unverified: true }));
}

/**
 * Copy-on-write persistence contract. The UI may expose rows only after the
 * single batch record is completed; partial writes stay isolated and retryable.
 */
export async function persistImportedSearchTermBatch(repository, input) {
  const prior = await repository.findBatch(input.batch_id);
  if (prior?.status === 'completed') {
    return { replayed: true, created: 0, updated: 0, rows: prior.row_count };
  }
  await repository.startBatch({
    id: input.batch_id,
    amazon_account_id: input.account_id,
    marketplace_id: input.marketplace_id || '',
    country_code: input.country_code || '',
    currency_code: input.currency_code || '',
    status: 'processing',
    row_count: input.records.length,
    duplicates_removed: input.duplicates_removed,
    started_at: input.started_at,
    error_code: null,
  });

  try {
    const existing = await repository.findRowsByUniqueKeys(input.records.map((record) => record.unique_key));
    const byKey = new Map();
    for (const row of existing) {
      const key = String(row.unique_key || '');
      byKey.set(key, [...(byKey.get(key) || []), row]);
    }
    const duplicate = [...byKey.entries()].find(([, matches]) => matches.length > 1);
    if (duplicate) throw new Error(`duplicate_existing_import_key:${duplicate[0]}`);

    const create = [];
    const update = [];
    for (const record of input.records) {
      const row = byKey.get(record.unique_key)?.[0];
      if (row?.id) update.push({ ...record, id: row.id });
      else create.push(record);
    }
    await repository.updateRows(update);
    await repository.createRows(create);
    await repository.completeBatch(input.batch_id, { completed_at: input.completed_at });
    return { replayed: false, created: create.length, updated: update.length, rows: input.records.length };
  } catch (error) {
    await repository.failBatch(input.batch_id, 'import_incomplete').catch(() => {});
    throw error;
  }
}
