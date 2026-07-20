/**
 * test-real-ads.ts — valida a stack migrada contra a AMAZON REAL (ao vivo):
 * renova o token via amazonAdsTokenManager e lista os perfis de Ads. Prova o fim-a-fim
 * (HTTP → função → shim → Postgres + Amazon Ads → resposta) com credencial real.
 */
import { loadFunctions, registry } from '../src/registry.ts';
import { makeEntities } from '../src/sdk/entities.ts';
import { sql } from '../src/db.ts';

await loadFunctions();
const e = makeEntities();

const accs = await e.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
const accId = accs[0]?.id;
console.log('Conta:', accId, '| ads_profile_id:', accs[0]?.ads_profile_id, '\n');

const call = (name: string, body: unknown) =>
  registry.get(name)!(new Request('http://x/f/' + name, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));

// 1) Renovar token de Ads contra a Amazon real (núcleo do #5)
const tm = await (await call('amazonAdsTokenManager', { amazon_account_id: accId, _service_role: true, force_refresh: true })).json();
console.log('1) amazonAdsTokenManager →', tm.ok ? '✅ OK' : '❌ ' + (tm.message || tm.error),
  '| source:', tm.source, '| access_token:', tm.access_token ? tm.access_token.slice(0, 6) + '…(' + tm.access_token.length + ')' : 'nenhum');

// 2) Listar perfis de Ads (leitura real da API)
if (registry.get('listAdsProfiles')) {
  const lp = await (await call('listAdsProfiles', { amazon_account_id: accId, _service_role: true })).json();
  const body = JSON.stringify(lp);
  console.log('2) listAdsProfiles →', lp.ok !== false ? '✅' : '❌', body.slice(0, 260));
}

await sql.end();
console.log('\n(fim do teste real de Ads)');
Deno.exit(0);
