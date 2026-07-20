/**
 * smoke.ts — prova o ciclo completo do shim de entidades contra o Postgres real:
 * create -> get -> update -> filter (com sort) -> delete. Cria a tabela sob demanda.
 * Uso: deno run --allow-net --allow-env --allow-read scripts/smoke.ts
 */
import { makeEntities } from '../src/sdk/entities.ts';
import { sql } from '../src/db.ts';

const e = makeEntities();
const Repo = e.SmokeTest; // entidade de teste (tabela smoke_test criada sob demanda)

function ok(cond: boolean, label: string) {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) throw new Error('FALHOU: ' + label);
}

console.log('--- SMOKE TEST: shim de entidades <-> Postgres ---');

const created = await Repo.create({ name: 'hello', n: 1, tags: ['a', 'b'], nested: { x: 10 } });
ok(!!created.id, `create gerou id (${created.id})`);
ok(created.name === 'hello' && created.n === 1, 'create preservou os campos');
ok(!!created.created_date, 'create preencheu created_date (campo de sistema)');

const got = await Repo.get(created.id);
ok(got?.id === created.id && got?.nested?.x === 10, 'get devolve o registro (inclui objeto aninhado)');

const upd = await Repo.update(created.id, { n: 2, extra: true });
ok(upd?.n === 2 && upd?.extra === true && upd?.name === 'hello', 'update fez merge (n=2, extra=true, manteve name)');

// cria mais alguns p/ testar filter + sort numerico
await Repo.create({ name: 'hello', n: 5 });
await Repo.create({ name: 'hello', n: 9 });
await Repo.create({ name: 'other', n: 99 });

const filtered = await Repo.filter({ name: 'hello' }, '-n', 10);
ok(filtered.length === 3, `filter({name:'hello'}) => 3 registros (veio ${filtered.length})`);
ok(filtered[0].n === 9, `sort '-n' desc: primeiro n=9 (veio ${filtered[0].n})`);

const del = await Repo.delete(created.id);
ok(del.id === created.id, 'delete retornou o id');
const after = await Repo.get(created.id);
ok(after === null, 'get após delete => null');

const many = await Repo.deleteMany({ name: 'hello' });
ok(many.deleted >= 2, `deleteMany limpou os restantes (${many.deleted})`);

// limpeza total da tabela de teste
await sql.unsafe('DROP TABLE IF EXISTS "smoke_test"');
await sql.end();

console.log('\n🎉 SMOKE TEST PASSOU — ciclo shim<->Postgres funcionando ponta a ponta.');
Deno.exit(0);
