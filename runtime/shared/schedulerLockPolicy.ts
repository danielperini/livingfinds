export type SchedulerLockRecord = {
  id?: string | null;
  amazon_account_id?: string | null;
  lock_key?: string | null;
  status?: string | null;
  owner_id?: string | null;
  created_date?: string | null;
  acquired_at?: string | null;
  expires_at?: string | null;
};

function recordOrder(record: SchedulerLockRecord): string {
  return String(record.created_date || record.acquired_at || "");
}

function compareLocks(
  left: SchedulerLockRecord,
  right: SchedulerLockRecord,
): number {
  const byDate = recordOrder(left).localeCompare(recordOrder(right));
  if (byDate !== 0) return byDate;
  return String(left.id || "").localeCompare(String(right.id || ""));
}

export function isLiveSchedulerLock(
  record: SchedulerLockRecord,
  accountId: string,
  lockKey: string,
  nowMs = Date.now(),
): boolean {
  if (String(record.amazon_account_id || "") !== String(accountId)) {
    return false;
  }
  if (String(record.lock_key || "") !== String(lockKey)) return false;
  if (!["candidate", "acquired"].includes(String(record.status || ""))) {
    return false;
  }
  const expiresAt = new Date(String(record.expires_at || "")).getTime();
  return Number.isFinite(expiresAt) && expiresAt > nowMs;
}

export function electSchedulerLock(
  records: SchedulerLockRecord[],
  accountId: string,
  lockKey: string,
  nowMs = Date.now(),
): SchedulerLockRecord | null {
  const live = records.filter((record) =>
    isLiveSchedulerLock(record, accountId, lockKey, nowMs)
  );
  // Um lock já adquirido sempre vence candidatos posteriores. Isso evita que
  // ele desapareça da eleição no intervalo entre candidate -> acquired.
  const acquired = live
    .filter((record) => record.status === "acquired")
    .sort(compareLocks);
  if (acquired.length) return acquired[0];
  return live.sort(compareLocks)[0] || null;
}
