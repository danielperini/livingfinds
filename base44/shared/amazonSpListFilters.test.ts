import { strict as assert } from 'node:assert';
import { normalizeSpListFilters } from './amazonSpListFilters.ts';

Deno.test('paired bid and repair reads use SP v3 include filters without mutating caller', () => {
  const payload = { campaignIdFilter: ['123'], adGroupIdFilter: ['456'], stateFilter: { include: ['ENABLED', 'PAUSED'] }, maxResults: 10 };
  assert.deepEqual(normalizeSpListFilters('/sp/adGroups/list', 'POST', payload), {
    ...payload, campaignIdFilter: { include: ['123'] }, adGroupIdFilter: { include: ['456'] },
  });
  assert.deepEqual(payload.campaignIdFilter, ['123']);
});

Deno.test('valid filter objects and keyword enum arrays remain unchanged', () => {
  const payload = { campaignIdFilter: { include: ['123'] }, matchTypeFilter: ['EXACT'], nextToken: 'page2' };
  assert.deepEqual(normalizeSpListFilters('/sp/keywords/list', 'POST', payload), payload);
});

Deno.test('mutation payloads and legacy endpoints are never rewritten', () => {
  const payload = { campaignIdFilter: ['123'], adGroups: [{ adGroupId: '456', defaultBid: 0.5 }] };
  assert.equal(normalizeSpListFilters('/sp/adGroups', 'PUT', payload), payload);
  assert.equal(normalizeSpListFilters('/v2/sp/adGroups', 'POST', payload), payload);
  assert.equal(normalizeSpListFilters('/sp/adGroups/list', 'GET', payload), payload);
  assert.equal(normalizeSpListFilters('/sp/adGroups/list', 'POST', null), null);
});
