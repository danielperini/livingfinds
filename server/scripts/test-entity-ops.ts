/**
 * test-entity-ops.ts — testa os métodos e operadores do shim de entidades contra o Postgres:
 * bulkUpdate, updateMany e filtros estilo Mongo ($in/$nin/$gt/$gte/$lt/$lte/$ne/$or/$exists).
 */
import { makeEntities } from '../src/sdk/entities.ts';
import { sql } from '../src/db.ts';

const R = makeEntities().EntityOpTest;
const T = 'entity_op_test';
await sql.unsafe(`DROP TABLE IF EXISTS "${T}"`).catch(() => {});

function ok(c: boolean, l: string) {
  console.log(`${c ? '✅' : '❌'} ${l}`);
  if (!c) throw new Error('FALHOU: ' + l);
}

const a = await R.create({ name: 'a', state: 'enabled', bid: 0.5, date: '2026-07-01' });
const b = await R.create({ name: 'b', state: 'paused', bid: 1.5, date: '2026-07-15' });
await R.create({ name: 'c', state: 'archived', bid: 3.0, date: '2026-06-01' });

ok((await R.filter({ state: { $in: ['enabled', 'paused'] } })).length === 2, '$in');
ok((await R.filter({ state: { $nin: ['archived'] } })).length === 2, '$nin');
ok((await R.filter({ bid: { $lt: 1.0 } })).length === 1, '$lt numérico');
ok((await R.filter({ bid: { $gte: 1.5 } })).length === 2, '$gte numérico');
ok((await R.filter({ date: { $gte: '2026-07-01' } })).length === 2, '$gte data ISO');
ok((await R.filter({ bid: { $gte: 1.0, $lte: 2.0 } })).length === 1, 'range $gte+$lte');
ok((await R.filter({ state: { $ne: 'archived' } })).length === 2, '$ne');
ok((await R.filter({ $or: [{ state: 'enabled' }, { state: 'archived' }] })).length === 2, '$or');
ok((await R.filter({ name: { $exists: true } })).length === 3, '$exists');

// bulkUpdate([{id, ...campos}])
await R.bulkUpdate([{ id: a.id, bid: 0.9 }, { id: b.id, bid: 1.9 }]);
ok((await R.get(a.id))?.bid === 0.9 && (await R.get(b.id))?.bid === 1.9, 'bulkUpdate');

// updateMany(filtro, {$set})
const um = await R.updateMany({ state: { $in: ['enabled', 'paused'] } }, { $set: { touched: true } });
ok(um.updated === 2, 'updateMany atualizou 2');
ok((await R.filter({ touched: true })).length === 2, 'updateMany aplicou o $set');

await sql.unsafe(`DROP TABLE IF EXISTS "${T}"`);
await sql.end();
console.log('\n🎉 Métodos e operadores do shim OK.');
Deno.exit(0);
