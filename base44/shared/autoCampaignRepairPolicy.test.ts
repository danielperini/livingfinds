import { assertEquals, assertThrows } from 'jsr:@std/assert';
import { autoCampaignRepairCancellationPatch, autoCampaignRepairPreflight } from './autoCampaignRepairPolicy.ts';

Deno.test('repair requires account, campaign and product identity before any Amazon call', () => {
  assertEquals(autoCampaignRepairPreflight({ asin: 'B000000001', campaign_id: '  ' }), { ok: false, code: 'MISSING_ACCOUNT_ID', reason: 'Conta Amazon ausente; reparo não pode ser executado.' });
  assertEquals(autoCampaignRepairPreflight({ amazon_account_id: 'acct', asin: 'B000000001', campaign_id: '' }), { ok: false, code: 'MISSING_CAMPAIGN_ID', reason: 'ID de campanha ausente; criação deve ocorrer no fluxo de cobertura/Kick-off.' });
  assertEquals(autoCampaignRepairPreflight({ amazon_account_id: 'acct', campaign_id: '123' }), { ok: false, code: 'MISSING_PRODUCT_ID', reason: 'ASIN e SKU ausentes; reparo não pode ser vinculado a um produto.' });
  assertEquals(autoCampaignRepairPreflight({ amazon_account_id: 'acct', asin: 'B000000001', campaign_id: ' 123 ' }), { ok: true, campaignId: '123' });
  assertEquals(autoCampaignRepairPreflight({ amazon_account_id: 'acct', sku: 'SKU-1', amazon_campaign_id: '456' }), { ok: true, campaignId: '456' });
});

Deno.test('unrepairable legacy queue item is soft-cancelled without incrementing attempts or losing history', () => {
  const item = { amazon_account_id: 'acct', asin: 'B000000001', campaign_id: null, attempt_count: 5 };
  assertEquals(autoCampaignRepairCancellationPatch(item, '2026-10-13T12:00:00.000Z'), {
    status: 'cancelled',
    completed_at: '2026-10-13T12:00:00.000Z',
    retryable: false,
    error_code: 'MISSING_CAMPAIGN_ID',
    last_error: 'ID de campanha ausente; criação deve ocorrer no fluxo de cobertura/Kick-off.',
  });
  assertEquals(item.attempt_count, 5);
});

Deno.test('valid queue item cannot be soft-cancelled as unrepairable', () => {
  assertThrows(() => autoCampaignRepairCancellationPatch({ amazon_account_id: 'acct', asin: 'B000000001', campaign_id: '123' }));
});
