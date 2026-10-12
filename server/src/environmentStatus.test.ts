import { assertEquals, assert } from 'jsr:@std/assert@1';
import { environmentIntegrations, getEnvironmentStatus, makeEnvironmentStatusResponse } from './environmentStatus.ts';

Deno.test('environment status returns allowlisted names and configured booleans only', () => {
  const privateValue = 'must-never-appear-in-response';
  const result = getEnvironmentStatus((name) => name === 'OPENAI_API_KEY' ? privateValue : undefined);
  const serialized = JSON.stringify(result);
  assert(!serialized.includes(privateValue));
  assertEquals(result.length, environmentIntegrations.length);
  assertEquals(result.find((item) => item.key === 'openai')?.variables[0], {
    name: 'OPENAI_API_KEY', configured: true,
  });
  assertEquals(result.find((item) => item.key === 'openai')?.variables[1], {
    name: 'OPENAI_MODEL', configured: false,
  });
  for (const group of result) for (const variable of group.variables) {
    assertEquals(typeof variable.configured, 'boolean');
    assertEquals(Object.keys(variable).sort(), ['configured', 'name']);
  }
});

Deno.test('environment status never reads outside the static allowlist', () => {
  const requested: string[] = [];
  getEnvironmentStatus((name) => { requested.push(name); return undefined; });
  assertEquals([...new Set(requested)].sort(), environmentIntegrations.flatMap((group) => [...group.variables]).sort());
});

Deno.test('environment status rejects missing or non-admin sessions without reading environment', async () => {
  let reads = 0;
  const reader = () => { reads += 1; return 'private'; };
  const anonymous = makeEnvironmentStatusResponse('GET', null, reader);
  const operator = makeEnvironmentStatusResponse('GET', { role: 'operator' }, reader);
  assertEquals(anonymous.status, 403);
  assertEquals(operator.status, 403);
  assertEquals(reads, 0);
});

Deno.test('environment status is GET-only and does not cache successful data', async () => {
  let reads = 0;
  const reader = () => { reads += 1; return 'private-secret-value'; };
  const unsupported = makeEnvironmentStatusResponse('POST', { role: 'admin' }, reader);
  assertEquals(unsupported.status, 405);
  assertEquals(reads, 0);
  const response = makeEnvironmentStatusResponse('GET', { role: 'admin' }, reader, '2026-10-12T12:00:00.000Z');
  const text = await response.text();
  assertEquals(response.status, 200);
  assertEquals(response.headers.get('cache-control'), 'no-store');
  assert(!text.includes('private-secret-value'));
});
