import { strict as assert } from 'node:assert';
import {
  classifyCampaignDeliveryHealth,
  evaluateZeroDeliveryBootstrap,
  nextConservativeBid,
} from './campaignDeliveryHealthPolicy.ts';

const base = {
  ageHours: 96, impressions: 0, clicks: 0, orders: 0, sales: 0, spend: 0,
  complete: true, hasProduct: true, inStock: true, protectedWinner: false,
  accountOutOfBudget: false, priorBidEscalations: 0, operationalState: 'ENABLED',
};

Deno.test('campanha incompleta deve ser reparada antes de alterar bid', () => {
  assert.equal(classifyCampaignDeliveryHealth({ ...base, complete: false }), 'REPAIR_STRUCTURE');
});

Deno.test('campanha em inserção há mais de 6 horas deve ser reparada', () => {
  assert.equal(classifyCampaignDeliveryHealth({ ...base, ageHours: 24, operationalState: 'INSERTING' }), 'REPAIR_STRUCTURE');
});

Deno.test('campanha em inserção recente ainda pode aguardar', () => {
  assert.equal(classifyCampaignDeliveryHealth({ ...base, ageHours: 3, operationalState: 'INSERTING' }), 'WAIT');
});

Deno.test('produto sem estoque deve ser arquivado e não escalado', () => {
  assert.equal(classifyCampaignDeliveryHealth({ ...base, inStock: false }), 'ARCHIVE_OUT_OF_STOCK');
});

Deno.test('campanha nova aguarda 72 horas', () => {
  assert.equal(classifyCampaignDeliveryHealth({ ...base, ageHours: 48 }), 'WAIT');
});

Deno.test('zero entrega após 72h aumenta bid respeitando incremento configurado', () => {
  assert.equal(classifyCampaignDeliveryHealth(base), 'INCREASE_BID');
  assert.equal(nextConservativeBid(0.5, 0.8, 0.1, 0.2), 0.60);
});

Deno.test('incremento nunca ultrapassa bid máximo', () => {
  assert.equal(nextConservativeBid(0.79, 0.8, 0.1, 0.2), 0.8);
});

Deno.test('285 zero-click não autorizam salto agressivo: cada recovery sobe somente R$0,10', () => {
  const bids = Array.from({ length: 285 }, () => nextConservativeBid(0.5, 0.8, 0.1, 0.2));
  assert.equal(bids.every((bid) => bid === 0.60), true);
  assert.equal(bids.slice(0, 8).length, 8);
});

Deno.test('após três tentativas sem entrega pausa e substitui', () => {
  assert.equal(classifyCampaignDeliveryHealth({ ...base, priorBidEscalations: 3 }), 'PAUSE_AND_REPLACE');
});

Deno.test('não aumenta bid quando conta está sem orçamento', () => {
  assert.equal(classifyCampaignDeliveryHealth({ ...base, accountOutOfBudget: true }), 'WAIT');
});

Deno.test('campanhas com vendas permanecem protegidas', () => {
  assert.equal(classifyCampaignDeliveryHealth({ ...base, orders: 1, sales: 50 }), 'PROTECT_WINNER');
});

Deno.test('manual madura que começou a entregar não volta para ZERO_DELIVERY', () => {
  assert.equal(classifyCampaignDeliveryHealth({
    ...base,
    ageHours: 240,
    impressions: 1,
    priorBidEscalations: 3,
  }), 'WAIT');
});

Deno.test('entrega remota prevalece sobre espelho local incompleto', () => {
  assert.equal(classifyCampaignDeliveryHealth({
    ...base,
    complete: false,
    impressions: 1,
  }), 'WAIT');
});

const bootstrap = {
  actionableEconomics: false,
  safeMaxCpc: 0.78,
  breakEvenAcos: 27.77,
  currentPrice: 69.9,
  unitCost: 40,
  costSource: 'manual_confirmed_import',
  assessmentStatus: 'insufficient_data',
  asinSpend: 1.2,
  asinSales: 0,
  asinOrders: 0,
  inStock: true,
  accountOutOfBudget: false,
};

Deno.test('bootstrap confiável destrava somente ZERO_DELIVERY dentro do envelope', () => {
  const result = evaluateZeroDeliveryBootstrap(bootstrap);
  assert.equal(result.eligible, true);
  assert.equal(result.economics_source, 'trusted_bootstrap');
  assert.equal(result.spend_cap, 3.12);
  assert.equal(result.remaining_spend_headroom, 1.92);
});

Deno.test('bootstrap bloqueia ASIN sem venda que consumiu o teto de exploração', () => {
  const result = evaluateZeroDeliveryBootstrap({ ...bootstrap, asinSpend: 3.12 });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'ASIN_ZERO_SALE_SPEND_CAP_EXHAUSTED');
});

Deno.test('bootstrap não inventa economia quando safe CPC ou custo confirmado faltam', () => {
  assert.equal(evaluateZeroDeliveryBootstrap({ ...bootstrap, safeMaxCpc: 0 }).reason, 'ECONOMICS_NOT_ACTIONABLE');
  assert.equal(evaluateZeroDeliveryBootstrap({ ...bootstrap, costSource: 'unknown' }).reason, 'ECONOMICS_NOT_ACTIONABLE');
});

Deno.test('bootstrap respeita bloqueio de listing e hard stop da conta', () => {
  assert.equal(evaluateZeroDeliveryBootstrap({ ...bootstrap, assessmentStatus: 'listing_blocked' }).reason, 'PRODUCT_DELIVERY_BLOCKED');
  assert.equal(evaluateZeroDeliveryBootstrap({ ...bootstrap, hardStop: true }).reason, 'ACCOUNT_SPEND_GUARD');
});
