/**
 * validate-vs-amazon.ts — confere os dados do nosso Postgres contra a Amazon Ads AO VIVO.
 * Puxa a lista de campanhas SP direto da Amazon e compara contagem, estado e orçamento
 * com o que temos migrado. É o critério de aceite do cliente ("os números batem com a Amazon").
 */
import { makeEntities } from '../src/sdk/entities.ts';
import { sql } from '../src/db.ts';

const CLIENT_ID = Deno.env.get('ADS_CLIENT_ID')!;
const SECRET = Deno.env.get('ADS_CLIENT_SECRET')!;
const REFRESH = Deno.env.get('ADS_REFRESH_TOKEN')!;
const PROFILE = Deno.env.get('ADS_PROFILE_ID')!;
const ADS = 'https://advertising-api.amazon.com';

async function token(): Promise<string> {
  const r = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: REFRESH, client_id: CLIENT_ID, client_secret: SECRET }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('LWA falhou: ' + JSON.stringify(d));
  return d.access_token;
}

async function liveCampaigns(access: string): Promise<Map<string, { state: string; budget: number }>> {
  const out = new Map<string, { state: string; budget: number }>();
  let nextToken: string | undefined;
  do {
    const res = await fetch(`${ADS}/sp/campaigns/list`, {
      method: 'POST',
      headers: {
        'Amazon-Advertising-API-ClientId': CLIENT_ID,
        'Authorization': `Bearer ${access}`,
        'Amazon-Advertising-API-Scope': PROFILE,
        'Content-Type': 'application/vnd.spCampaign.v3+json',
        'Accept': 'application/vnd.spCampaign.v3+json',
      },
      body: JSON.stringify({ maxResults: 100, ...(nextToken ? { nextToken } : {}) }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`sp/campaigns/list HTTP ${res.status}: ${JSON.stringify(d).slice(0, 200)}`);
    for (const c of d.campaigns ?? []) {
      out.set(String(c.campaignId), { state: String(c.state ?? '').toLowerCase(), budget: Number(c.budget?.budget ?? 0) });
    }
    nextToken = d.nextToken;
  } while (nextToken);
  return out;
}

console.log('🔎 Validando nosso Postgres vs Amazon Ads (ao vivo)...\n');
const access = await token();
const live = await liveCampaigns(access);
console.log(`Amazon (ao vivo): ${live.size} campanhas SP`);

const e = makeEntities();
const ours = await e.Campaign.filter({}, null, 2000);
const oursById = new Map(ours.filter((c) => c.campaign_id).map((c) => [String(c.campaign_id), c]));
console.log(`Nosso banco: ${ours.length} campanhas (${oursById.size} com campaign_id Amazon)\n`);

let matched = 0, stateMatch = 0, budgetMatch = 0, onlyLive = 0, onlyOurs = 0;
const mismatches: string[] = [];
for (const [id, lc] of live) {
  const o = oursById.get(id);
  if (!o) { onlyLive++; continue; }
  matched++;
  const oState = String(o.state ?? o.status ?? '').toLowerCase();
  const oBudget = Number(o.daily_budget ?? o.budget ?? 0);
  if (oState === lc.state) stateMatch++;
  else if (mismatches.length < 5) mismatches.push(`  campanha ${id}: estado nosso="${oState}" vs Amazon="${lc.state}"`);
  if (Math.abs(oBudget - lc.budget) < 0.01) budgetMatch++;
  else if (mismatches.length < 5) mismatches.push(`  campanha ${id}: orçamento nosso=${oBudget} vs Amazon=${lc.budget}`);
}
for (const id of oursById.keys()) if (!live.has(id)) onlyOurs++;

console.log('=== RESULTADO ===');
console.log(`Campanhas casadas por ID: ${matched}/${live.size}`);
console.log(`  estado igual:    ${stateMatch}/${matched} (${matched ? Math.round(stateMatch / matched * 100) : 0}%)`);
console.log(`  orçamento igual: ${budgetMatch}/${matched} (${matched ? Math.round(budgetMatch / matched * 100) : 0}%)`);
console.log(`Só na Amazon (não no nosso banco): ${onlyLive}`);
console.log(`Só no nosso banco (não ativas na Amazon / arquivadas): ${onlyOurs}`);
if (mismatches.length) { console.log('\nExemplos de divergência:'); mismatches.forEach((m) => console.log(m)); }

await sql.end();
Deno.exit(0);
