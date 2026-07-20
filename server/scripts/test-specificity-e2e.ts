/**
 * test-specificity-e2e.ts — prova o filtro de especificidade (#2) rodando a função REAL
 * promoteSearchTermToExact contra o Postgres, com um termo genérico e um específico.
 */
import { loadFunctions, registry } from '../src/registry.ts';
import { makeEntities } from '../src/sdk/entities.ts';
import { sql } from '../src/db.ts';

await loadFunctions();
const e = makeEntities();

function ok(cond: boolean, label: string) {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) throw new Error('FALHOU: ' + label);
}

const acc = await e.AmazonAccount.create({ status: 'connected', currency_symbol: 'R$' });
await e.AutopilotConfig.create({ amazon_account_id: acc.id, min_bid: 0.1, max_bid: 5, target_acos: 25 });
await e.Product.create({
  amazon_account_id: acc.id, asin: 'B0TEST', inventory_status: 'in_stock',
  status: 'active', price: 100, fba_inventory: 50,
});

const handler = registry.get('promoteSearchTermToExact')!;
const call = (body: unknown) =>
  handler(new Request('http://x/functions/promoteSearchTermToExact', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));

console.log('\n--- CASO 1: termo genérico "café elétrico" (deve ser BARRADO) ---');
const promoGeneric = await e.SearchTermPromotion.create({
  amazon_account_id: acc.id, asin: 'B0TEST', search_term: 'café elétrico',
  normalized_term: 'café elétrico', status: 'pending', conversions: 2, acos: 20,
  tail_type: 'head', promotion_score: 50, avg_cpc: 0.5, target_bid: 0.6,
});
const r1 = await (await call({ amazon_account_id: acc.id, promotion_id: promoGeneric.id })).json();
console.log('resposta:', JSON.stringify(r1));
ok(r1.rejected === true, 'termo genérico foi rejeitado');
ok(String(r1.reason).toLowerCase().includes('genérico') || String(r1.reason).includes('especificidade'),
  'motivo cita especificidade/genérico');
const g = await e.SearchTermPromotion.get(promoGeneric.id);
ok(g?.status === 'rejected', `status no banco = rejected (veio ${g?.status})`);
ok(!!g?.rejection_reason, `rejection_reason persistido (auditável): "${g?.rejection_reason}"`);

console.log('\n--- CASO 2: termo específico long-tail (NÃO deve ser barrado por especificidade) ---');
const promoSpecific = await e.SearchTermPromotion.create({
  amazon_account_id: acc.id, asin: 'B0TEST',
  search_term: 'cafeteira elétrica 220v inox 15 xícaras',
  normalized_term: 'cafeteira elétrica 220v inox 15 xícaras',
  status: 'pending', conversions: 3, acos: 18, tail_type: 'long', promotion_score: 80,
  avg_cpc: 0.4, target_bid: 0.5,
});
const r2 = await (await call({ amazon_account_id: acc.id, promotion_id: promoSpecific.id })).json();
console.log('resposta:', JSON.stringify(r2));
const blockedForSpecificity = r2.rejected === true &&
  (String(r2.reason).includes('especificidade') || String(r2.reason).toLowerCase().includes('genérico'));
ok(!blockedForSpecificity, 'termo específico NÃO foi barrado pelo filtro de especificidade');

// limpeza
for (const t of ['amazon_account', 'autopilot_config', 'product', 'search_term_promotion', 'amazon_action_queue', 'campaign', 'keyword']) {
  await sql.unsafe(`DROP TABLE IF EXISTS "${t}"`).catch(() => {});
}
await sql.end();
console.log('\n🎉 FILTRO DE ESPECIFICIDADE (#2) FUNCIONANDO ponta a ponta na função real.');
Deno.exit(0);
