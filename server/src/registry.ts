/**
 * Registry — carrega dinamicamente as funções Deno sem modificá-las.
 *
 * Truque: cada função chama `Deno.serve(handler)` no topo do módulo. Nós substituímos
 * `Deno.serve` por um capturador ANTES de importar cada entry.ts — em vez de subir um servidor,
 * ele guarda o handler no registro. Depois o main.ts roteia as requisições para esses handlers.
 */
import { join, toFileUrl } from 'jsr:@std/path@1';

export type FnHandler = (req: Request) => Response | Promise<Response>;

export const registry = new Map<string, FnHandler>();

let capturing: FnHandler | null = null;
// deno-lint-ignore no-explicit-any
const originalServe = Deno.serve.bind(Deno) as any;

function installServeInterceptor() {
  const noopServer = {
    finished: Promise.resolve(),
    shutdown: () => Promise.resolve(),
    ref() {},
    unref() {},
    addr: { transport: 'tcp', hostname: '127.0.0.1', port: 0 },
  };
  // deno-lint-ignore no-explicit-any
  (Deno as any).serve = (arg1: any, arg2?: any): unknown => {
    const handler: FnHandler = typeof arg1 === 'function'
      ? arg1
      : (typeof arg2 === 'function' ? arg2 : (arg1?.handler ?? arg1?.fetch));
    if (typeof handler === 'function') capturing = handler;
    return noopServer;
  };
}

/** Restaura o Deno.serve original (o main.ts precisa dele para subir o servidor de verdade). */
export function restoreServe(): void {
  // deno-lint-ignore no-explicit-any
  (Deno as any).serve = originalServe;
}

function functionsDir(): string {
  return Deno.env.get('FUNCTIONS_DIR') ??
    join(import.meta.dirname!, '..', '..', 'base44', 'functions');
}

export async function loadFunctions(): Promise<{ loaded: number; failed: string[] }> {
  installServeInterceptor();
  const dir = functionsDir();
  const failed: string[] = [];
  let loaded = 0;

  const entries: string[] = [];
  try {
    for await (const d of Deno.readDir(dir)) {
      if (d.isDirectory) entries.push(d.name);
    }
  } catch (e) {
    console.error(`[registry] não consegui ler ${dir}:`, (e as Error).message);
    return { loaded: 0, failed: ['<dir-inacessivel>'] };
  }
  entries.sort();

  for (const name of entries) {
    const entryPath = join(dir, name, 'entry.ts');
    try {
      await Deno.stat(entryPath);
    } catch {
      continue; // pasta sem entry.ts
    }
    capturing = null;
    try {
      const mod = await import(toFileUrl(entryPath).href);
      const handler = capturing ?? (mod.default as FnHandler | undefined) ??
        (mod.handler as FnHandler | undefined);
      if (typeof handler === 'function') {
        registry.set(name, handler);
        loaded++;
      } else {
        failed.push(name);
      }
    } catch (e) {
      failed.push(name);
      console.error(`[registry] falhou ao carregar ${name}:`, (e as Error).message);
    }
  }
  restoreServe();
  console.log(`[registry] ${loaded} funções carregadas, ${failed.length} falharam.`);
  return { loaded, failed };
}
