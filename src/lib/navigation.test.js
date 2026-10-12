import test from 'node:test';
import assert from 'node:assert/strict';
import { getJourneyForPath, isNavigationItemActive, navigationJourneys } from './navigation.js';

test('journeys cover the new API catalog without changing existing route names', () => {
  assert.equal(getJourneyForPath('/configuracao/apis')?.journey.id, 'configurar');
  assert.equal(getJourneyForPath('/products/listing-enhancement')?.journey.id, 'operar');
  assert.equal(getJourneyForPath('/sala-de-comando/legacy')?.journey.id, 'analisar');
  assert.deepEqual(navigationJourneys.map(({ id }) => id), ['operar', 'analisar', 'configurar']);
});

test('active matching does not mark dashboard as active on every route', () => {
  const dashboard = navigationJourneys[0].items[0];
  assert.equal(isNavigationItemActive('/', dashboard), true);
  assert.equal(isNavigationItemActive('/products', dashboard), false);
  assert.equal(isNavigationItemActive('/products/listing-enhancement', navigationJourneys[0].items[1]), true);
});
