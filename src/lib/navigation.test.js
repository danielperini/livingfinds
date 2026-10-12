import test from 'node:test';
import assert from 'node:assert/strict';
import { getJourneyForPath, isNavigationItemActive, navigationJourneys } from './navigation.js';

test('journeys cover the new API catalog without changing existing route names', () => {
  assert.equal(getJourneyForPath('/configuracao/apis')?.journey.id, 'configurar');
  assert.equal(getJourneyForPath('/products/listing-enhancement')?.journey.id, 'operar');
  assert.equal(getJourneyForPath('/sala-de-comando/legacy')?.journey.id, 'analisar');
  assert.deepEqual(navigationJourneys.map(({ id }) => id), ['operar', 'analisar', 'configurar']);
});

test('simplified journey sections retain every unique destination', () => {
  const allSections = navigationJourneys.flatMap(journey => journey.sections);
  const sectionItems = allSections.flatMap(section => section.items);
  const flatItems = navigationJourneys.flatMap(journey => journey.items);
  assert.equal(sectionItems.length, flatItems.length);
  assert.equal(new Set(sectionItems.map(item => item.path)).size, sectionItems.length);
  assert.ok(navigationJourneys.every(journey => journey.sections.length > 0));
  assert.equal(navigationJourneys.find(journey => journey.id === 'operar').sections.find(section => section.primary).items.length, 3);
});

test('active matching does not mark dashboard as active on every route', () => {
  const dashboard = navigationJourneys[0].items[0];
  assert.equal(isNavigationItemActive('/', dashboard), true);
  assert.equal(isNavigationItemActive('/products', dashboard), false);
  assert.equal(isNavigationItemActive('/products/listing-enhancement', navigationJourneys[0].items[1]), false);
});

test('only the most-specific navigation destination is active', () => {
  const items = navigationJourneys.flatMap(({ items: groupItems }) => groupItems);
  for (const path of ['/products/listing-enhancement', '/settings/ads-authorization']) {
    const active = items.filter((item) => isNavigationItemActive(path, item));
    assert.equal(active.length, 1);
    assert.equal(active[0].path, path);
  }
});
