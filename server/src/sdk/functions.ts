/**
 * Functions — reimplementa `base44.functions.invoke(name, payload)`.
 * Chama o handler da função-alvo (já carregado no registry) em processo, montando um Request
 * com corpo JSON, e devolve { data, status, ok } — as funções leem `res?.data || res`.
 */
import { registry, type FnHandler } from '../registry.ts';

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

const BASE = () => Deno.env.get('APP_BASE_URL') ?? 'http://localhost:8000';

export function makeFunctions(serviceRole: boolean) {
  const invoke = async (name: string, payload: Json = {}): Promise<Json> => {
    const handler: FnHandler | undefined = registry.get(name);
    const body = serviceRole ? { ...payload, _service_role: true } : { ...payload };

    if (!handler) {
      // fallback: chamada HTTP (caso a função esteja em outro processo/host)
      try {
        const res = await fetch(`${BASE()}/functions/${name}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-service-role': String(serviceRole) },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        return { data, status: res.status, ok: res.ok };
      } catch (e) {
        return { data: null, ok: false, status: 500, error: `Função '${name}' não encontrada: ${(e as Error).message}` };
      }
    }

    const req = new Request(`${BASE()}/functions/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-role': String(serviceRole) },
      body: JSON.stringify(body),
    });
    const res = await handler(req);
    const data = await res.json().catch(() => ({}));
    return { data, status: res.status, ok: res.ok };
  };

  return { invoke };
}
