/**
 * runtime.ts — shim do módulo `base44:runtime` para o self-hosted.
 *
 * No Base44 esse módulo é fornecido pelo edge runtime deles. Self-hosted não tem
 * edge runtime, então reproduzimos a mesma superfície sobre Deno:
 *  - waitUntil(promise): executa trabalho em background após a resposta (fire-and-forget).
 *  - secrets: cofre de segredos → mapeado para variáveis de ambiente.
 */

/**
 * Mantém uma promise viva após a Response ser retornada. No Deno.serve o handler
 * pode devolver a Response enquanto a promise continua — só garantimos que um erro
 * no trabalho de background não derrube o processo.
 */
export function waitUntil(promise: Promise<unknown> | (() => Promise<unknown>)): void {
  const p = typeof promise === 'function' ? promise() : promise;
  Promise.resolve(p).catch((e) => console.error('[runtime.waitUntil] erro em background:', e));
}

/**
 * secrets.get('NOME') → Deno.env.get('NOME'). Também suporta acesso direto por
 * propriedade (secrets.NOME) via Proxy, por robustez.
 */
export const secrets = new Proxy(
  { get: (name: string): string | undefined => Deno.env.get(name) },
  {
    get(target, prop) {
      if (prop === 'get') return target.get;
      if (typeof prop === 'string') return Deno.env.get(prop);
      return undefined;
    },
  },
) as { get(name: string): string | undefined; [key: string]: unknown };
