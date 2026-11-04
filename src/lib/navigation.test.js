import test from 'node:test';
import assert from 'node:assert/strict';
import { getJourneyForPath, isNavigationItemActive, navigationJourneys } from './navigation.js';

test('mantém os três grupos principais em PT-BR', () => {
  assert.deepEqual(navigationJourneys.map(({ id }) => id), ['operar', 'analisar', 'configurar']);
  assert.equal(getJourneyForPath('/')?.journey.id, 'operar');
  assert.equal(getJourneyForPath('/analytics')?.journey.id, 'analisar');
  assert.equal(getJourneyForPath('/settings')?.journey.id, 'configurar');
});

test('sidebar compacta mantém destinos canônicos únicos', () => {
  const allSections = navigationJourneys.flatMap(journey => journey.sections);
  const sectionItems = allSections.flatMap(section => section.items);
  const flatItems = navigationJourneys.flatMap(journey => journey.items);
  assert.equal(sectionItems.length, flatItems.length);
  assert.equal(new Set(sectionItems.map(item => item.path)).size, sectionItems.length);
  assert.ok(navigationJourneys.every(journey => journey.sections.length > 0));
  assert.equal(navigationJourneys.find(journey => journey.id === 'operar').sections.find(section => section.primary).items.length, 4);
});

test('active matching não marca dashboard em outras rotas', () => {
  const dashboard = navigationJourneys[0].items[0];
  assert.equal(isNavigationItemActive('/', dashboard), true);
  assert.equal(isNavigationItemActive('/products', dashboard), false);
});

test('rotas antigas removidas da sidebar não são destinos ativos', () => {
  const visibleItems = navigationJourneys.flatMap(({ items }) => items);
  for (const path of ['/products/listing-enhancement', '/sala-de-comando/legacy', '/settings/ads-authorization']) {
    assert.equal(visibleItems.some(item => item.path === path), false);
  }
});
