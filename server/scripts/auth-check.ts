/**
 * auth-check.ts — Probe de autenticação Amazon (LWA → Ads / SP-API).
 * Recebe candidatos por env (nenhum segredo hardcoded). Testa todas as combinações
 * cliente×refresh-token no endpoint LWA e, para as que autenticam, tenta Ads e SP-API.
 *
 * Uso: passar clientes (CA_, CB_) e tokens (T1, T2) por variável de ambiente.
 */
// deno-lint-ignore no-explicit-any
type Any = any;

const clients = [
  { name: Deno.env.get('CA_NAME') ?? 'A', id: Deno.env.get('CA_ID'), secret: Deno.env.get('CA_SECRET') },
  { name: Deno.env.get('CB_NAME') ?? 'B', id: Deno.env.get('CB_ID'), secret: Deno.env.get('CB_SECRET') },
].filter((c) => c.id && c.secret);

const tokens = [
  { name: Deno.env.get('T1_NAME') ?? 'T1', val: Deno.env.get('T1') },
  { name: Deno.env.get('T2_NAME') ?? 'T2', val: Deno.env.get('T2') },
].filter((t) => t.val);

const ADS_PROFILE_ID = Deno.env.get('ADS_PROFILE_ID') ?? '';

async function lwaExchange(id: string, secret: string, refresh: string): Promise<Any> {
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: refresh, client_id: id, client_secret: secret,
    }),
  });
  const data = await res.json().catch(() => ({}));
  return { httpOk: res.ok, status: res.status, access: data.access_token, err: data.error_description || data.error };
}

async function adsProfiles(clientId: string, access: string): Promise<Any> {
  const res = await fetch('https://advertising-api.amazon.com/v2/profiles', {
    headers: { 'Amazon-Advertising-API-ClientId': clientId, 'Authorization': `Bearer ${access}` },
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, count: Array.isArray(data) ? data.length : 0, sample: Array.isArray(data) ? data.slice(0, 3) : data };
}

async function spParticipations(access: string): Promise<Any> {
  const res = await fetch('https://sellingpartnerapi-na.amazon.com/sellers/v1/marketplaceParticipations', {
    headers: { 'x-amz-access-token': access },
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body: JSON.stringify(data).slice(0, 300) };
}

console.log(`Clientes: ${clients.length} | Tokens: ${tokens.length} | ADS_PROFILE_ID: ${ADS_PROFILE_ID || '(vazio)'}\n`);

for (const t of tokens) {
  for (const c of clients) {
    const ex = await lwaExchange(c.id!, c.secret!, t.val!);
    const tag = `[token ${t.name} × cliente ${c.name}]`;
    if (!ex.access) {
      console.log(`❌ ${tag} LWA falhou (HTTP ${ex.status}): ${ex.err}`);
      continue;
    }
    console.log(`✅ ${tag} LWA OK — access token obtido`);
    // este par (cliente, token) casa. Testar escopos:
    const ads = await adsProfiles(c.id!, ex.access);
    console.log(`   ↳ Ads /v2/profiles: HTTP ${ads.status} ${ads.ok ? `(${ads.count} perfis)` : ''}${ads.ok ? '' : ' — ' + JSON.stringify(ads.sample).slice(0, 160)}`);
    if (ads.ok && ads.count) {
      console.log(`   ↳ perfis Ads: ${JSON.stringify(ads.sample.map((p: Any) => ({ profileId: p.profileId, country: p.countryCode, type: p.accountInfo?.type })))}`);
    }
    const sp = await spParticipations(ex.access);
    console.log(`   ↳ SP-API marketplaceParticipations: HTTP ${sp.status} ${sp.ok ? 'OK' : '— ' + sp.body}`);
  }
}
console.log('\n(fim do probe)');
