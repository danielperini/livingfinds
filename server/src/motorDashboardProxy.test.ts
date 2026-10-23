import { deepStrictEqual as eq, ok } from 'node:assert/strict';

type Handler = (request: Request) => Promise<Response>;
const handlers: Handler[] = [];
const serve = Deno.serve;
try {
  Deno.serve = ((handler: Handler) => { handlers.push(handler); }) as typeof Deno.serve;
  await import('../../base44/functions/getMotorDashboardStatus/entry.ts');
  await import('../../base44/functions/getMotorCycleEvidence/entry.ts');
} finally { Deno.serve = serve; }

Deno.test('dashboard and historical evidence proxies only issue authenticated local GETs, never Amazon writes or motor replay', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  try {
    globalThis.fetch = ((url: URL, init: RequestInit) => {
      eq(init.method, 'GET'); eq(url.origin, 'http://local-test.invalid');
      ok(['/api/motor-status', '/api/motor-cycle-evidence'].includes(url.pathname));
      eq(new Headers(init.headers).get('authorization'), 'Bearer synthetic-session');
      eq(url.searchParams.get('account_id'), 'a');
      calls.push(url.pathname);
      return Promise.resolve(Response.json({ ok: true, read_only: true }));
    }) as typeof fetch;
    for (const handler of handlers) {
      const request = new Request('http://local-test.invalid/functions/read', {
        method: 'POST', headers: { authorization: 'Bearer synthetic-session' },
        body: JSON.stringify({ account_id: 'a', date: '2026-10-23', source: 'decisions' }),
      });
      eq((await handler(request)).status, 200);
    }
    eq(calls, ['/api/motor-status', '/api/motor-cycle-evidence']);
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test('read proxy surfaces a technical failure instead of an empty successful dashboard', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (() => { throw new Error('local endpoint unavailable'); }) as typeof fetch;
    const response = await handlers[0](new Request('http://local-test.invalid/read', {
      method: 'POST', body: JSON.stringify({ account_id: 'a' }),
    }));
    eq(response.status, 503); eq((await response.json()).ok, false);
  } finally { globalThis.fetch = originalFetch; }
});
