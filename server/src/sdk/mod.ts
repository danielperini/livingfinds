/**
 * Shim do @base44/sdk — ponto de entrada que o import-map (deno.json) injeta no lugar do
 * pacote real para as funções. Reconstrói o objeto `base44` que elas usam:
 *   base44.entities.<E>.{list,filter,get,create,bulkCreate,update,delete,deleteMany}
 *   base44.auth.{me,isAuthenticated}
 *   base44.integrations.Core.{InvokeLLM,SendEmail,UploadFile}
 *   base44.functions.invoke(name, payload)
 *   base44.connectors.getConnection(name)
 *   base44.asServiceRole.{entities,functions,connectors,integrations}
 */
import { makeEntities } from './entities.ts';
import { makeAuth } from './auth.ts';
import { makeIntegrations } from './integrations.ts';
import { makeFunctions } from './functions.ts';
import { makeConnectors } from './connectors.ts';

// deno-lint-ignore no-explicit-any
export type Base44Client = Record<string, any>;

export function createClientFromRequest(req?: Request): Base44Client {
  const entities = makeEntities();
  const integrations = makeIntegrations();
  const connectors = makeConnectors();
  const auth = makeAuth(req);

  const client: Base44Client = {
    entities,
    auth,
    integrations,
    connectors,
    functions: makeFunctions(false),
    asServiceRole: {
      entities,
      integrations,
      connectors,
      functions: makeFunctions(true),
    },
  };
  return client;
}

/** Alguns SDKs expõem createClient({...}); mantemos por compatibilidade. */
export function createClient(_opts?: unknown): Base44Client {
  return createClientFromRequest();
}

export default { createClientFromRequest, createClient };
