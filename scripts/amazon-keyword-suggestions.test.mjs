import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const source = readFileSync(new URL('../base44/functions/syncAmazonKeywordSuggestionsByAsin/entry.ts', import.meta.url), 'utf8')
  .replace(/import \{ createClientFromRequest \} from '[^']+';/, 'const createClientFromRequest = globalThis.clientFactory;');

async function runFixture(throttled = false) {
  const calls = [], created = [];
  let handler;
  const entities = {
    AmazonAccount: { filter: async () => [{ id: 'account', ads_profile_id: 'profile', ads_refresh_token: 'fake' }] },
    CompetitorAsinMap: { filter: async () => [] },
    KeywordSuggestion: { filter: async () => [], bulkCreate: async rows => created.push(...rows) },
  };
  const context = vm.createContext({
    Request, Response, URLSearchParams, console,
    setTimeout: callback => { callback(); return 0; },
    clientFactory: () => ({ auth: { isAuthenticated: async () => false }, asServiceRole: { entities } }),
    Deno: { env: { get: () => 'fake' }, serve: h => { handler = h; } },
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(url.includes('/auth/') ? '{}' : options.body) });
      if (url.includes('/auth/')) return Response.json({ access_token: 'fake' });
      if (throttled) return new Response('rate limited', { status: 429 });
      assert.equal(calls.at(-1).body.recommendationType, 'KEYWORDS_FOR_ASINS');
      return Response.json({ keywordTargetList: [{ keyword: 'interruptor wifi sem neutro' }] });
    },
  });
  new vm.Script(stripTypeScriptTypes(source)).runInContext(context);
  const result = await handler(new Request('http://localhost', {
    method: 'POST', body: JSON.stringify({ _service_role: true, amazon_account_id: 'account', asin: 'B000000001', match_types: ['EXACT'] }),
  }));
  return { body: await result.json(), calls, created };
}

test('Amazon v4 request and response produce one complete EXACT keyword', async () => {
  const { body, calls, created } = await runFixture();
  assert.equal(body.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(created.length, 1);
  assert.equal(created[0].keyword, 'interruptor wifi sem neutro');
  assert.equal(created[0].match_type, 'EXACT');
  assert.equal(created[0].source, 'AMAZON_ADS_SUGGESTED_KEYWORD');
});

test('429 retries stop at the configured attempt limit without an extra request', async () => {
  const { calls, created } = await runFixture(true);
  assert.equal(calls.filter(c => c.url.includes('/recommendations')).length, 4);
  assert.equal(calls.filter(c => c.url.includes('/suggested/keywords')).length, 3);
  assert.equal(created.length, 0);
});
