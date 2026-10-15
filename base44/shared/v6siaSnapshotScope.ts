// Supervisory diagnostics use the current operational snapshot window. Historical
// reports and decision evidence remain stored separately and are never relabelled fresh.
export function v6siaSnapshotQuery(accountId: string, nowMs = Date.now()) {
  return {
    amazon_account_id: accountId,
    captured_at: {
      $gte: new Date(nowMs - 24 * 60 * 60 * 1000).toISOString(),
      $lte: new Date(nowMs).toISOString(),
    },
  };
}
