/**
 * useAmazonPropagation
 * Hook centralizado para propagar ações do usuário imediatamente para a Amazon Ads API.
 * Inclui: feedback visual tipificado, atualização otimista, enfileiramento em rate limit,
 * e gravação de SyncExecutionLog com trigger_type='user_action'.
 */
import { useState, useCallback } from 'react';
import { base44 } from '@/api/base44Client';

/**
 * Classifica o erro retornado pela API e devolve uma mensagem amigável.
 */
function classifyApiError(error) {
  const msg = String(error?.message || error?.error || '').toLowerCase();
  const status = error?.status || error?.http_status;

  if (status === 401 || msg.includes('401') || msg.includes('unauthorized') || msg.includes('token')) {
    return { code: 'auth', text: 'Token expirado — reconecte em Configurações' };
  }
  if (status === 429 || msg.includes('429') || msg.includes('rate limit') || msg.includes('throttl')) {
    return { code: 'rate_limit', text: 'Limite Amazon atingido — ação enfileirada para retry' };
  }
  if (status >= 500 || msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504') || msg.includes('gateway')) {
    return { code: 'server', text: 'Erro Amazon — ação enfileirada para retry' };
  }
  return { code: 'unknown', text: error?.message || 'Erro ao sincronizar com a Amazon' };
}

/**
 * Grava um registro de execução no SyncExecutionLog para auditoria.
 */
async function logExecution(amazonAccountId, operation, status, resultSummary, errorMessage) {
  try {
    await base44.entities.SyncExecutionLog.create({
      amazon_account_id: amazonAccountId,
      operation,
      trigger_type: 'user_action',
      status,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      result_summary: resultSummary || null,
      error_message: errorMessage || null,
    });
  } catch {
    // Não bloquear a UI por falha de log
  }
}

/**
 * Enfileira uma ação na AmazonActionQueue para retry automático.
 */
async function enqueueForRetry(amazonAccountId, actionType, payload, reason) {
  try {
    await base44.entities.AmazonActionQueue.create({
      amazon_account_id: amazonAccountId,
      action_type: actionType,
      payload: JSON.stringify(payload),
      status: 'pending',
      retry_reason: reason,
      scheduled_for: new Date(Date.now() + 60000).toISOString(), // 60s
      created_at: new Date().toISOString(),
    });
  } catch {
    // Ignorar silenciosamente — não bloquear a UI
  }
}

export function useAmazonPropagation() {
  const [propagating, setPropagating] = useState({}); // { [key]: boolean }
  const [propagationResult, setPropagationResult] = useState({}); // { [key]: { type, text } }

  const clearResult = useCallback((key) => {
    setTimeout(() => {
      setPropagationResult(prev => { const next = { ...prev }; delete next[key]; return next; });
    }, 3000);
  }, []);

  /**
   * Executa uma ação de propagação com:
   * - spinner durante o envio
   * - badge verde 'Sincronizado na Amazon' se ok
   * - badge vermelho com mensagem específica se falhar
   * - enfileiramento automático em rate limit / 5xx
   * - log em SyncExecutionLog
   *
   * @param {string} key - Identificador único da ação (ex: productId, campaignId)
   * @param {string} operation - Nome da operação para log
   * @param {Function} actionFn - Função async que realiza a ação
   * @param {object} options - { amazonAccountId, actionType, enqueuePayload }
   * @returns {{ ok: boolean, classified?: object }}
   */
  const propagate = useCallback(async (key, operation, actionFn, options = {}) => {
    const { amazonAccountId, actionType, enqueuePayload } = options;

    setPropagating(prev => ({ ...prev, [key]: true }));
    setPropagationResult(prev => { const next = { ...prev }; delete next[key]; return next; });

    try {
      const result = await actionFn();

      await logExecution(amazonAccountId, operation, 'success', `Ação do usuário concluída: ${operation}`);

      setPropagationResult(prev => ({
        ...prev,
        [key]: { type: 'success', text: '✓ Sincronizado na Amazon' },
      }));
      clearResult(key);

      return { ok: true, result };
    } catch (error) {
      const classified = classifyApiError(error);

      // Rate limit ou 5xx: enfileirar para retry
      if ((classified.code === 'rate_limit' || classified.code === 'server') && amazonAccountId && actionType) {
        await enqueueForRetry(amazonAccountId, actionType, enqueuePayload || {}, classified.text);
      }

      await logExecution(
        amazonAccountId,
        operation,
        'error',
        null,
        `${classified.code}: ${error?.message || ''}`.slice(0, 500)
      );

      setPropagationResult(prev => ({
        ...prev,
        [key]: { type: 'error', text: classified.text },
      }));
      clearResult(key);

      return { ok: false, classified, error };
    } finally {
      setPropagating(prev => { const next = { ...prev }; delete next[key]; return next; });
    }
  }, [clearResult]);

  return { propagating, propagationResult, propagate };
}