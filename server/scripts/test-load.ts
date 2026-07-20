/**
 * test-load.ts — teste de integração: carrega todas as funções através do shim (import-map)
 * e reporta quantas subiram e quais falharam. Não precisa de banco.
 */
import { loadFunctions } from '../src/registry.ts';

const { loaded, failed } = await loadFunctions();
console.log('\n==== RESULTADO ====');
console.log('carregadas:', loaded);
console.log('falharam:', failed.length);
if (failed.length) console.log('lista de falhas:\n - ' + failed.join('\n - '));
Deno.exit(0);
