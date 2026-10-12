export type NormalizedAmazonBatchResponse = {
  ok: boolean;
  success: any[];
  errors: any[];
  request_id: string | null;
  status_code?: number | null;
  retry_after_seconds?: number | null;
};

/** Build the exact v3 keyword-bid mutation consumed by executeAutopilotDecisionV2. */
export function buildKeywordBidMutation(input: { keywordId: unknown; bid: unknown }) {
  const keywordId = String(input.keywordId ?? '').trim();
  const bid = Number(input.bid);
  if (!keywordId) throw new Error('keywordId obrigatório para alterar lance');
  if (!Number.isFinite(bid) || bid <= 0) throw new Error('bid precisa ser um número positivo');
  return {
    operation: 'updateBid',
    method: 'PUT' as const,
    path: '/sp/keywords',
    entityKey: 'keywords',
    payload: { keywords: [{ keywordId, bid }] },
  };
}

/** Normalize Amazon Ads v3 batch responses without treating partial writes as success. */
export function normalizeAmazonBatchResponse(raw: any, entityKey: string): NormalizedAmazonBatchResponse {
  const request_id = raw?.headers?.request_id || raw?.amazon_request_id || raw?.request_id || null;
  const status_code = Number(raw?.status || raw?.status_code || raw?.http_status || 0) || null;
  const retryAfterRaw = raw?.headers?.['retry-after'] || raw?.headers?.retry_after || raw?.retry_after;
  const retry_after_seconds = Number(retryAfterRaw) > 0 ? Number(retryAfterRaw) : null;

  const v3block = raw?.payload?.[entityKey] || raw?.[entityKey] || null;
  if (v3block) {
    const success: any[] = v3block.success || [];
    const errors: any[] = v3block.error || v3block.errors || [];
    return { ok: success.length > 0 && errors.length === 0, success, errors, request_id, status_code, retry_after_seconds };
  }
  if (raw?.ok === false) return { ok: false, success: [], errors: raw?.errors || [{ message: raw?.error || 'Erro desconhecido' }], request_id, status_code, retry_after_seconds };
  if (raw?.ok === true || raw?.status === 200) return { ok: true, success: [], errors: [], request_id, status_code, retry_after_seconds };
  if (raw?.status === 207) {
    const hasError = Array.isArray(raw?.errors) && raw.errors.length > 0;
    return { ok: !hasError, success: [], errors: raw?.errors || [], request_id, status_code, retry_after_seconds };
  }
  return { ok: false, success: [], errors: [{ message: 'Resposta Amazon não reconhecida' }], request_id, status_code, retry_after_seconds };
}

export function amazonBidMatchesExpected(remoteBid: unknown, expectedBid: unknown, tolerance = 0.01): boolean {
  const remote = Number(remoteBid);
  const expected = Number(expectedBid);
  return Number.isFinite(remote) && Number.isFinite(expected) && Math.abs(remote - expected) < tolerance;
}
