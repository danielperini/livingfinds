import { strict as assert } from 'node:assert';
import { classifyCampaignDeliveryHealth, nextConservativeBid } from './campaignDeliveryHealthPolicy.ts';

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
  assert.equal(nextConservativeBid(0.5, 0.8, 0.1, 0.2), 0.6);
});

Deno.test('incremento nunca ultrapassa bid máximo', () => {
  assert.equal(nextConservativeBid(0.75, 0.8, 0.1, 0.2), 0.8);
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
