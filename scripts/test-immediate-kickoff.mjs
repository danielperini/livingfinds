// Node 24 runner for pure Deno policy tests plus isolated backend integration tests.
// All SDK calls are mocked; this script cannot change an Amazon account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { canonicalSkuRecord, recoveredOfferLockPatch } from '../base44/shared/catalogRecoveryPolicy.ts';
import { campaignMatchesProduct } from '../base44/shared/productCampaignPauseGuard.ts';
import { kickoffDiscovery } from '../base44/shared/productDiscoveryPolicy.ts';

test('new microphone with FBA 20 and available zero is discovered without sales history', () => {
  const p={amazon_account_id:'a1',sku:'FBA-0122',asin:'B0HLMF8PPD',fba_inventory:20,available_quantity:0,
    catalog_sync_status:'success',last_catalog_sync_at:new Date().toISOString(),offer_active:true,listing_buyable:true,
    ads_last_eligibility_check_at:new Date().toISOString(),ads_scope_status:'authorized',cost_confirmed:true};
  assert.equal(kickoffDiscovery(p,[],[]).status,'ready');
  assert.equal(kickoffDiscovery({...p,cost_confirmed:false},[],[]).status,'blocked');
  assert.equal(kickoffDiscovery({...p,listing_buyable:false},[],[]).status,'blocked');
  assert.equal(kickoffDiscovery(p,[{...p,state:'enabled'}],[]).status,'covered');
  assert.equal(kickoffDiscovery(p,[],[{...p,status:'scheduled'}]).status,'queued');
  assert.equal(kickoffDiscovery({...p,campaign_pause_lock:true},[],[]).status,'blocked');
  assert.equal(kickoffDiscovery(p,[{...p,amazon_account_id:'another',state:'enabled'}],[]).status,'ready');
});

test('duplicate SKU recovery preserves confirmed cost record and rejects different ASIN', () => {
  const a={id:'a',asin:'B0GNW1Q6V3',cost_confirmed:true}, b={id:'b',asin:a.asin};
  assert.equal(canonicalSkuRecord([b,a],a.asin),a);
  assert.equal(canonicalSkuRecord([a,{...b,asin:'B0HFB78DNP'}],a.asin),null);
});
test('confirmed buyable offer clears only migration-owned locks', () => {
  const signal={listing_status_confirmed:true,listing_buyable:true,offer_active:true};
  assert.equal(recoveredOfferLockPatch({campaign_pause_locked_by:'pause_guard_migration'},signal).campaign_pause_lock,false);
  assert.deepEqual(recoveredOfferLockPatch({campaign_pause_locked_by:'authenticated_user'},signal),{});
  assert.deepEqual(recoveredOfferLockPatch({campaign_pause_locked_by:'pause_guard_migration'},{...signal,listing_status_confirmed:false}),{});
});
test('another SKU on the same ASIN cannot pause a SKU-linked campaign', () => {
  assert.equal(campaignMatchesProduct({asin:'B0GNW1Q6V3',sku:'SKU-002314V'},{asin:'B0GNW1Q6V3',sku:'SKU-002314'}),false);
});

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'jsr:@std/assert') return { url: 'data:text/javascript,export { deepStrictEqual as assertEquals } from "node:assert/strict";', shortCircuit: true };
  return next(specifier, context);
}});
globalThis.Deno = { test };
test('modified backend handlers have valid TypeScript syntax', async () => {
  for (const name of ['autoStockCampaignGuard', 'checkInventoryChangesAndKickoff', 'ensureActiveProductCampaignCoverage',
    'processProductKickoffQueueV2', 'runImmediateSameSkuSearchTermHarvest', 'runUnifiedDecisionEngine', 'syncProductCatalogV2', 'discoverDailyKickoffProducts', 'scheduleProductKickoff']) {
    stripTypeScriptTypes(await readFile(`base44/functions/${name}/entry.ts`, 'utf8'));
  }
});
for (const name of ['stockAdsPolicy', 'campaignCoverageEligibility', 'searchTermHarvestPolicy']) {
  await import(`../base44/shared/${name}.test.ts`);
}

async function handler(name, client) {
  const filename = path.resolve(`base44/functions/${name}/entry.ts`);
  let source = await readFile(filename, 'utf8');
  source = source.replace(/import \{ createClientFromRequest \} from 'npm:[^']+';/, 'const createClientFromRequest = () => globalThis.__testClient;');
  source = source.replace(/from '(\.\.[^']+)'/g, (_, spec) => `from '${pathToFileURL(path.resolve(path.dirname(filename), spec)).href}'`);
  globalThis.__testClient = client;
  globalThis.Deno.serve = value => { globalThis.__testHandler = value; };
  await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}#${Math.random()}`);
  return globalThis.__testHandler;
}

test('daily discovery updates one product repeatedly without creating campaigns or queue jobs', async () => {
  const product={id:'mic',amazon_account_id:'a1',sku:'FBA-0122',asin:'B0HLMF8PPD',fba_inventory:20,available_quantity:0,
    catalog_sync_status:'success',last_catalog_sync_at:new Date().toISOString(),cost_confirmed:false};
  const calls=[],updates=[];
  const client={auth:{isAuthenticated:async()=>true},asServiceRole:{entities:{
    AmazonAccount:{filter:async()=>[{id:'a1'}]},
    Product:{filter:async()=>[product],update:async(id,patch)=>{updates.push(id);Object.assign(product,patch);}},
    Campaign:{filter:async()=>[]},ProductKickoffQueue:{filter:async()=>[]},
  },functions:{invoke:async(name)=>{calls.push(name);return {data:{ok:true}};}}}};
  const run=await handler('discoverDailyKickoffProducts',client);
  const request=()=>new Request('https://test.invalid',{method:'POST',body:JSON.stringify({amazon_account_id:'a1'})});
  const first=await (await run(request())).json();
  const discoveredAt=product.kickoff_discovered_at;
  const second=await (await run(request())).json();
  assert.equal(first.ok,true);assert.equal(second.results[0].candidates.length,1);
  assert.equal(product.kickoff_discovered_at,discoveredAt);
  assert.equal(product.kickoff_discovery_status,'blocked');
  assert.deepEqual(updates,['mic','mic']);
  assert.ok(calls.every(n=>['syncProductCatalogV2','syncAmazonOfferAvailability'].includes(n)));
});

function fixture({ syncOk = true, queueFails = false, paused = false } = {}) {
  const calls = [];
  const product = { id: 'p1', asin: 'B0GNW1Q6V3', sku: 'SKU-002314V', available_quantity: 1, cost_confirmed:true, ads_scope_status:'authorized',
    catalog_sync_status: 'success', last_catalog_sync_at: new Date().toISOString() };
  const entities = {
    AmazonAccount: { filter: async () => [{ id: 'a1' }] },
    Product: { filter: async () => [product], update: async () => {} },
    Campaign: { filter: async () => paused ? [{ asin: product.asin, state: 'paused', last_pause_reason: 'negative_margin' }] : [] },
    ProductKickoffQueue: { filter: async () => [], create: async data => { if (queueFails) throw Error('database unavailable'); calls.push(['queue', data]); } },
    Alert: { create: async () => {} },
  };
  const client = { auth: { me: async () => ({ id: 'user' }) }, asServiceRole: { entities,
    functions: { invoke: async (name, payload) => { calls.push([name, payload]); return { data: { ok: name === 'syncProductCatalogV2' ? syncOk : true } }; } },
  } };
  return { calls, client };
}

for (const scenario of [
  { name: 'fresh inventory queues and executes immediately', expected: true },
  { name: 'failed inventory sync blocks kickoff', syncOk: false, expected: false },
  { name: 'dry run cannot mutate or execute', dry: true, expected: true },
  { name: 'queue persistence failure does not execute', queueFails: true, expected: false },
  { name: 'financially paused campaigns do not receive replacement kickoff', paused: true, expected: true },
]) {
  test(scenario.name, async () => {
    const { client, calls } = fixture(scenario);
    const run = await handler('checkInventoryChangesAndKickoff', client);
    const response = await run(new Request('https://test.invalid', { method: 'POST', body: JSON.stringify({ amazon_account_id: 'a1', dry_run: scenario.dry === true }) }));
    const data = await response.json();
    assert.equal(data.ok, scenario.expected);
    const queued = calls.filter(([name]) => name === 'queue');
    if (scenario.dry || scenario.syncOk === false || scenario.queueFails || scenario.paused) assert.equal(queued.length, 0);
    else { assert.equal(queued.length, 1); assert.equal(queued[0][1].queue_window, 'now'); }
    if (scenario.dry || !scenario.expected) assert.equal(calls.some(([name]) => name === 'processProductKickoffQueueV2'), false);
    else assert.equal(calls.some(([name]) => name === 'processProductKickoffQueueV2'), true);
  });
}

test('daily engine requests reports before same-SKU winner search with fresh inventory', async () => {
  const calls = [];
  const client = { auth: { isAuthenticated: async () => true }, asServiceRole: { functions: { invoke: async (name, payload) => {
    calls.push([name, payload]); return { data: { ok: true } };
  } } } };
  const run = await handler('runUnifiedDecisionEngine', client);
  await run(new Request('https://test.invalid', { method: 'POST', body: JSON.stringify({ daily_close: true, dry_run: true }) }));
  const names = calls.map(([name]) => name);
  assert.ok(names.indexOf('ensureDailyReportsCurrent') < names.indexOf('runImmediateSameSkuSearchTermHarvest'));
  const harvest = calls.find(([name]) => name === 'runImmediateSameSkuSearchTermHarvest')[1];
  assert.equal(harvest.require_fresh_inventory, true);
  assert.equal(harvest.max_promotions, 2);
  assert.equal(harvest.dry_run, true);
});

for (const accepted of [true, false]) {
  test(`stock guard ${accepted ? 'resumes only stock pauses' : 'rejects HTTP 207 item failures'}`, async () => {
    const updates = [], requests = [];
    const product = { id: 'p1', asin: 'B0GNW1Q6V3', available_quantity: 8,
      catalog_sync_status: 'success', last_catalog_sync_at: new Date().toISOString(), pause_reason: 'out_of_stock_confirmed' };
    const campaigns = [
      { id: 'stock', asin: product.asin, campaign_id: '42', state: 'paused', last_pause_reason: 'out_of_stock_confirmed' },
      { id: 'loss', asin: product.asin, campaign_id: '43', state: 'paused', last_pause_reason: 'negative_margin' },
    ];
    const client = { auth: { me: async () => ({ id: 'user' }) }, asServiceRole: {
      functions: { invoke: async () => ({ data: { ok: true, access_token: 'test-only' } }) },
      entities: {
        AmazonAccount: { filter: async () => [{ id: 'a1', ads_profile_id: 'test' }] },
        Product: { filter: async () => [product], update: async (id, patch) => updates.push([id, patch]) },
        Campaign: { filter: async () => campaigns, bulkUpdate: async () => {}, update: async (id, patch) => updates.push([id, patch]) },
      },
    } };
    const realFetch = globalThis.fetch;
    globalThis.Deno.env = { get: () => '' };
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      if (url.endsWith('/list')) return Response.json({ campaigns: body.stateFilter.include[0] === 'PAUSED' ? [{ campaignId: '42' }, { campaignId: '43' }] : [] });
      requests.push(body);
      return Response.json({ campaigns: { [accepted ? 'success' : 'error']: [{ campaignId: '42' }] } }, { status: 207 });
    };
    try {
      const run = await handler('autoStockCampaignGuard', client);
      const result = await (await run(new Request('https://test.invalid', { method: 'POST', body: '{}' }))).json();
      assert.equal(result.ok, accepted);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].campaigns[0].campaignId, '42');
      assert.equal(updates.some(([id]) => id === 'loss'), false);
      assert.equal(updates.some(([id, patch]) => id === 'stock' && patch.state === 'enabled'), accepted);
      assert.equal(updates.some(([id, patch]) => id === 'p1' && patch.campaign_status === 'active'), accepted);
    } finally { globalThis.fetch = realFetch; }
  });
}
