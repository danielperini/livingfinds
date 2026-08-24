/**
 * Functions — reimplementa `base44.functions.invoke(name, payload)`.
 * Chama o handler da função-alvo (já carregado no registry) em processo, montando um Request
 * com corpo JSON, e devolve { data, status, ok } — as funções leem `res?.data || res`.
 */
import { registry, type FnHandler } from '../registry.ts';

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

const BASE = () => Deno.env.get('APP_BASE_URL') ?? 'http://localhost:8000';

function internalInvocationToken(): string {
  return Deno.env.get('INTERNAL_FUNCTION_TOKEN') ||
    Deno.env.get('API_TOKEN') ||
    Deno.env.get('ADMIN_PASSWORD') ||
    '';
}

export function makeFunctions(serviceRole: boolean) {
  const invoke = async (name: string, payload: Json = {}): Promise<Json> => {
    const handler: FnHandler | undefined = registry.get(name);
    const body = serviceRole ? { ...payload, _service_role: true } : { ...payload };
    const internalToken = serviceRole ? internalInvocationToken() : '';
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-service-role': String(serviceRole),
    };
    if (internalToken) headers['x-internal-invocation-token'] = internalToken;

    if (!handler) {
      try {
        const res = await fetch(`${BASE()}/functions/${name}`, {
          method: 'POST',
          headers,
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
      headers,
      body: JSON.stringify(body),
    });
    const res = await handler(req);
    const data = await res.json().catch(() => ({}));
    return { data, status: res.status, ok: res.ok };
  };

  return { invoke };
}
