/**
 * test-decisionlog-e2e.ts — prova o log de decisão auditável (#4): ao promover/rejeitar um termo,
 * a função real grava um registro `Decision` com rationale + métricas, consultável num só lugar.
 */
import { loadFunctions, registry } from '../src/registry.ts';
import { makeEntities } from '../src/sdk/entities.ts';
import { sql } from '../src/db.ts';

await loadFunctions();
const e = makeEntities();
function ok(c: boolean, label: string) {
  console.log(`${c ? '✅' : '❌'} ${label}`);
  if (!c) throw new Error('FALHOU: ' + label);
}

const acc = await e.AmazonAccount.create({ status: 'connected', currency_symbol: 'R$' });
await e.AutopilotConfig.create({ amazon_account_id: acc.id, min_bid: 0.1, max_bid: 5, target_acos: 25 });
await e.Product.create({ amazon_account_id: acc.id, asin: 'B0DEC', inventory_status: 'in_stock', status: 'active', price: 100, fba_inventory: 50 });

const handler = registry.get('promoteSearchTermToExact')!;
const call = (body: unknown) =>
  handler(new Request('http://x/f', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

// 1) termo específico -> promovido -> deve gerar Decision(create_campaign_manual)
const pSpec = await e.SearchTermPromotion.create({
  amazon_account_id: acc.id, asin: 'B0DEC', search_term: 'cafeteira elétrica 220v inox 15 xícaras',
  normalized_term: 'cafeteira elétrica 220v inox 15 xícaras', status: 'pending', conversions: 3, acos: 18,
  tail_type: 'long', promotion_score: 80, avg_cpc: 0.4, target_bid: 0.5,
});
await call({ amazon_account_id: acc.id, promotion_id: pSpec.id });

// 2) termo genérico -> rejeitado -> deve gerar Decision(reject_keyword, status rejected)
const pGen = await e.SearchTermPromotion.create({
  amazon_account_id: acc.id, asin: 'B0DEC', search_term: 'café elétrico',
  normalized_term: 'café elétrico', status: 'pending', conversions: 1, acos: 30,
  tail_type: 'head', promotion_score: 40, avg_cpc: 0.6, target_bid: 0.6,
});
await call({ amazon_account_id: acc.id, promotion_id: pGen.id });

// Consultar o log de decisão (um só lugar)
const decisions = await e.Decision.filter({ amazon_account_id: acc.id }, '-created_date', 50);
console.log(`\nRegistros no log de decisão: ${decisions.length}`);
for (const d of decisions) {
  console.log(` • [${d.decision_type}/${d.status}] ${d.rationale}`);
  console.log(`   métricas: ${d.metrics_used}`);
}

const approval = decisions.find((d: Record<string, unknown>) => d.decision_type === 'create_campaign_manual');
const rejection = decisions.find((d: Record<string, unknown>) => d.decision_type === 'reject_keyword');

ok(!!approval, 'gravou Decision de APROVAÇÃO (create_campaign_manual)');
ok(typeof approval?.rationale === 'string' && approval.rationale.length > 10, 'aprovação tem rationale (POR QUE) legível');
ok(!!approval?.metrics_used && approval.metrics_used.includes('conversions'), 'aprovação tem métricas/evidência');
ok(!!rejection && rejection.status === 'rejected', 'gravou Decision de REJEIÇÃO (reject_keyword, status rejected)');
ok(String(rejection?.rationale).includes('especificidade'), 'rejeição explica o motivo (especificidade)');

for (const t of ['amazon_account', 'autopilot_config', 'product', 'search_term_promotion', 'amazon_action_queue', 'campaign', 'keyword', 'decision']) {
  await sql.unsafe(`DROP TABLE IF EXISTS "${t}"`).catch(() => {});
}
await sql.end();
console.log('\n🎉 LOG DE DECISÃO AUDITÁVEL (#4) funcionando — cada decisão tem POR QUE + evidência, num só lugar.');
Deno.exit(0);
