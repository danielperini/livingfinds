import { v6siaSnapshotQuery } from './v6siaSnapshotScope.ts';

Deno.test('snapshot supervision is scoped to account and real last 24 hours, excluding old and future records', () => {
  const now = Date.parse('2026-10-15T13:00:00Z');
  const query = v6siaSnapshotQuery('account-a', now);
  if (query.amazon_account_id !== 'account-a' || query.captured_at.$gte !== '2026-10-14T13:00:00.000Z' || query.captured_at.$lte !== '2026-10-15T13:00:00.000Z') {
    throw new Error('Invalid operational snapshot scope');
  }
  const inScope = (date: string) => date >= query.captured_at.$gte && date <= query.captured_at.$lte;
  if (inScope('2026-08-04T13:00:00.000Z') || inScope('2026-10-16T00:00:00.000Z') || !inScope('2026-10-15T12:59:00.000Z')) throw new Error('Old or future evidence accepted');
});
