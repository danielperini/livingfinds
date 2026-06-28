/**
 * useXano — Hook centralizado para chamar o Xano via xanoProxy (backend Base44)
 * Nunca chama o Xano diretamente. Injeta XANO_API_KEY via servidor.
 */
import { base44 } from '@/api/base44Client';

// Função global — chama xanoProxy que injeta X-API-Key + XANO_BASE_URL
export async function xanoRequest(method, path, body = null, params = null) {
  const payload = { method, path };
  if (body) payload.body = body;
  if (params) payload.params = params;

  const res = await base44.functions.invoke('xanoProxy', payload);
  const result = res.data;

  if (!result.ok) {
    const status = result.status || 0;
    let msg = result.error || 'Erro desconhecido';

    if (status === 401) msg = 'Chave XANO_API_KEY inválida ou diferente da configurada no Xano.';
    else if (status === 404) msg = 'Endpoint não encontrado no Xano. Verifique o path e o API group.';
    else if (status === 500) msg = 'Erro interno no Xano. Verifique os logs do endpoint.';
    else if (status === 0) msg = 'Não foi possível conectar ao Xano. Confira XANO_BASE_URL.';

    throw new Error(msg);
  }

  // Normalizar: aceitar { data: [...] }, [...], ou { success, data }
  const d = result.data;
  if (d && typeof d === 'object' && 'data' in d) return d.data;
  return d;
}

// Helper para extrair array de qualquer formato de resposta
export function toArray(val, key = null) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  if (key && val[key]) return val[key];
  // tenta qualquer chave que seja array
  const arrKey = Object.keys(val).find(k => Array.isArray(val[k]));
  if (arrKey) return val[arrKey];
  return [];
}