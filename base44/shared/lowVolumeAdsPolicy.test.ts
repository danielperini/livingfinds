import { strict as assert } from 'node:assert';
import { calculateLowVolumeDailyPlan, isPriorityLowVolumeProduct } from './lowVolumeAdsPolicy.ts';

assert.equal(isPriorityLowVolumeProduct({ title: 'Moedor de Café USB' }), true);
assert.equal(isPriorityLowVolumeProduct({ title: 'Kit Organizador de Malas para Viagem' }), true);
assert.equal(isPriorityLowVolumeProduct({ title: 'Ventilador 60W E27' }), true);
assert.equal(isPriorityLowVolumeProduct({ title: 'Lixeira Automática Cinza 13 Litros' }), true);
assert.equal(isPriorityLowVolumeProduct({ title: 'Headset Gamer USB' }), false);

const plan = calculateLowVolumeDailyPlan({
  sales: 140, orders: 2, spend: 12, sampleDays: 14, targetAcos: 10,
  profitBeforeAdsPerUnit: 25, safeMaxCpc: 0.6, targetCpc: 0.5,
  accountCampaignShareCap: 5, currentBudget: 5,
});
assert.equal(plan.lowVolume, true);
assert.equal(plan.dailyBudget, 1);
assert.equal(plan.targetBid, 0.25);
assert.ok(plan.dailyBudget <= plan.dailySales);
assert.equal(plan.strategy, 'AUTO_LOW_VOLUME_PROFIT_GUARD');

const learning = calculateLowVolumeDailyPlan({
  sales: 0, orders: 0, spend: 0, sampleDays: 14, targetAcos: 10,
  profitBeforeAdsPerUnit: 25, safeMaxCpc: 0.6, accountCampaignShareCap: 8, currentBudget: 5,
});
assert.equal(learning.dailyBudget, 1);
assert.equal(learning.calculatedSpendCap, 1);
