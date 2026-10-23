import { AsyncLocalStorage } from 'node:async_hooks';
const context = new AsyncLocalStorage<string>();
export const currentCorrelationId = () => context.getStore();
export async function withCycleContext<T>(payload: Record<string, any>, execute: (body: Record<string, any>) => Promise<T>): Promise<T> {
  payload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const correlation_id = context.getStore() || String(payload.correlation_id || '').trim().slice(0, 180) || crypto.randomUUID();
  return await context.run(correlation_id, () => execute({ ...payload, correlation_id }));
}
