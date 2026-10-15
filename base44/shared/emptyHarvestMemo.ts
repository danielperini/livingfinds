// Scope this memo to one engine invocation. Never reuse a successful mutation,
// an error, partial evidence or a response with candidates still to process.
export function createEmptyHarvestMemo() {
  const emptyResults = new Map<string, any>();
  return async (payload: Record<string, any>, invoke: () => Promise<any>) => {
    const key = JSON.stringify(payload, Object.keys(payload).sort());
    if (emptyResults.has(key)) return { ...emptyResults.get(key), operational_reuse: 'verified_empty_same_cycle' };
    const response = await invoke();
    const data = response?.data || response;
    const reports = data?.reports;
    if (data?.ok === true && data.evidence_complete === true && data.partial !== true && data.complete !== false &&
        Array.isArray(reports) && reports.length > 0 && reports.every((report: any) =>
          report.amazon_account_id === payload.amazon_account_id &&
          report.evidence_complete === true && report.partial !== true && report.complete !== false &&
          report.same_sku_candidates === 0 && report.selected === 0 &&
          report.promoted === 0 && report.failed === 0 &&
          Array.isArray(report.promoted_terms) && report.promoted_terms.length === 0 &&
          Array.isArray(report.failures) && report.failures.length === 0)) {
      emptyResults.set(key, data);
    }
    return data;
  };
}
