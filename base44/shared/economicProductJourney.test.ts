import assert from 'node:assert/strict';
import test from 'node:test';
import { buildExactJourneyKey, calculateEconomicSnapshot, capBidToEconomics, determineProductJourneyState } from './economicProductJourney.ts';

test('calcula margem, ACoS de equilíbrio, meta e CPC sustentável', () => {
  const result = calculateEconomicSnapshot({ salePrice: 100, productCost: 40, referralFee: 15, fbaFee: 10,
    costConfirmed: true, feesFresh: true, inventoryKnown: true, salesFresh: true,
    safetyFactor: 0.75, estimatedConversionRate: 0.10 });
  assert.equal(result.margin_before_ads, 35);
  assert.equal(result.break_even_acos, 0.35);
  assert.equal(result.target_acos, 0.26249999999999996);
  assert.equal(result.max_sustainable_cpc, 2.625);
  assert.equal(result.actionable, true);
});

test('bloqueia custo, preço, estoque desconhecido e dados vencidos', () => {
  const result = calculateEconomicSnapshot({ salePrice: 0, productCost: null, costConfirmed: false,
    feesFresh: false, inventoryKnown: false, salesFresh: false });
  assert.equal(result.actionable, false);
  assert.deepEqual(result.missing_fields, ['sale_price', 'product_cost', 'amazon_fees', 'inventory', 'sales', 'positive_margin']);
});

test('estado sem estoque precede criação de campanhas', () => {
  assert.equal(determineProductJourneyState({ inventoryKnown: true, inventoryAvailable: 0 }).state, 'OUT_OF_STOCK');
});

test('retorno de estoque retoma descoberta sem duplicidade de chave', () => {
  const economics = { actionable: true, missing_fields: [] };
  assert.equal(determineProductJourneyState({ inventoryKnown: true, inventoryAvailable: 3, economics, listingActive: true }).state, 'READY_FOR_DISCOVERY');
  const keyA = buildExactJourneyKey({ accountId: 'a', profileId: 'p', marketplaceId: 'm', asin: 'B0ABC', term: 'Café  Elétrico!' });
  const keyB = buildExactJourneyKey({ accountId: 'a', profileId: 'p', marketplaceId: 'm', asin: 'B0ABC', term: 'cafe eletrico' });
  assert.equal(keyA, keyB);
});

test('bid nunca supera CPC sustentável nem aumento de 20%', () => {
  const result = capBidToEconomics(1, 2, 1.5, 0.20);
  assert.equal(result.bid, 1.2);
});
