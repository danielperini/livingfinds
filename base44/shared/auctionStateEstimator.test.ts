import { estimateCpcAuctionState } from './auctionStateEstimator.ts';

function assert(value: unknown, message = 'assertion failed'): asserts value {
  if (!value) throw new Error(message);
}

Deno.test('Kalman não reage de forma permanente a salto isolado de CPC', () => {
  const result = estimateCpcAuctionState([
    { cpc: 0.50, clicks: 20 },
    { cpc: 0.52, clicks: 20 },
    { cpc: 1.20, clicks: 2 },
    { cpc: 0.51, clicks: 25 },
    { cpc: 0.50, clicks: 25 },
  ]);
  assert(result.auction_pressure_state !== 'PROBABLE_REGIME_CHANGE');
  assert(result.predicted_cpc_next_window < 0.70);
});

Deno.test('Kalman identifica pressão persistente de leilão', () => {
  const result = estimateCpcAuctionState([
    { cpc: 0.40, clicks: 20 },
    { cpc: 0.42, clicks: 20 },
    { cpc: 0.55, clicks: 20 },
    { cpc: 0.70, clicks: 20 },
    { cpc: 0.86, clicks: 20 },
  ]);
  assert(['RISING', 'PROBABLE_REGIME_CHANGE'].includes(result.auction_pressure_state));
  assert(result.predicted_cpc_next_window > 0.70);
});
