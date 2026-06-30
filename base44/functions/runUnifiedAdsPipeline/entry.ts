/**
 * runUnifiedAdsPipeline — Pipeline unificado de otimização Amazon Ads
 * 
 * Arquitetura em 3 camadas:
 * 1. calculateMetrics: Cálculos matemáticos puros (ACoS, ROAS, CPC, CTR, etc.)
 * 2. applyOptimizationRules: Motor de regras de negócio
 * 3. summarizeForAI: Resumo consolidado para IA (opcional, 1 chamada/dia)
 * 
 * Vantagens:
 * - Zero IA para cálculos e regras (econômico)
 * - IA apenas para priorização estratégica (1 chamada/dia)
 * - Total auditabilidade e controle
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    
    // Aceitar execução por scheduler (sem user)
    let user = null;
    try {
      user = await base44.auth.me();
    } catch {
      // automação scheduled
    }

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, use_ai = false, simulate_only = false } = body;

    // Resolver conta
    let accountId = amazon_account_id;
    if (!accountId) {
      const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-last_sync_at', 1);
      if (accounts.length === 0) {
        return Response.json({ error: 'Nenhuma conta Amazon conectada' }, { status: 404 });
      }
      accountId = accounts[0].id;
    }

    const account = await base44.asServiceRole.entities.AmazonAccount.get(accountId);
    if (!account) {
      return Response.json({ error: 'Conta não encontrada' }, { status: 404 });
    }

    const startTime = Date.now();
    const results = {};

    // ========== CAMADA 1: Cálculos Matemáticos ==========
    console.log('[Pipeline] Camada 1: Calculando métricas...');
    
    try {
      const metricsResult = await base44.functions.invoke('calculateMetrics', {
        amazon_account_id: accountId,
      });

      if (!metricsResult.data?.ok) {
        throw new Error(`Camada 1 falhou: ${metricsResult.data?.error || 'Erro desconhecido'}`);
      }

      results.layer1 = {
        status: 'success',
        summary: metricsResult.data.summary,
        duration_ms: metricsResult.data.duration_ms || 0,
      };

      console.log(`[Pipeline] Camada 1 concluída: ${metricsResult.data.summary.campaigns.total} campanhas, ${metricsResult.data.summary.keywords.total} keywords`);
    } catch (error) {
      results.layer1 = { status: 'error', error: error.message };
      console.error('[Pipeline] Erro Camada 1:', error.message);
    }

    // ========== CAMADA 2: Motor de Regras ==========
    console.log('[Pipeline] Camada 2: Aplicando regras de otimização...');

    try {
      const rulesResult = await base44.functions.invoke('applyOptimizationRules', {
        amazon_account_id: accountId,
        simulate_only,
      });

      if (!rulesResult.data?.ok) {
        throw new Error(`Camada 2 falhou: ${rulesResult.data?.error || 'Erro desconhecido'}`);
      }

      results.layer2 = {
        status: 'success',
        decisions_count: rulesResult.data.decisions_count,
        actions_breakdown: rulesResult.data.actions_breakdown,
        duration_ms: rulesResult.data.duration_ms || 0,
      };

      console.log(`[Pipeline] Camada 2 concluída: ${rulesResult.data.decisions_count} decisões geradas`);
    } catch (error) {
      results.layer2 = { status: 'error', error: error.message };
      console.error('[Pipeline] Erro Camada 2:', error.message);
    }

    // ========== CAMADA 3: Resumo para IA (opcional) ==========
    if (use_ai) {
      console.log('[Pipeline] Camada 3: Gerando resumo para IA...');

      try {
        const aiResult = await base44.functions.invoke('summarizeForAI', {
          amazon_account_id: accountId,
          use_ai: true,
        });

        if (!aiResult.data?.ok) {
          throw new Error(`Camada 3 falhou: ${aiResult.data?.error || 'Erro desconhecido'}`);
        }

        results.layer3 = {
          status: 'success',
          ai_prioritization: aiResult.data.ai_prioritization,
          executive_summary: aiResult.data.executive_summary,
          duration_ms: aiResult.data.duration_ms || 0,
        };

        console.log(`[Pipeline] Camada 3 concluída: IA priorizou ${aiResult.data.ai_prioritization?.prioritized_actions?.length || 0} ações`);
      } catch (error) {
        results.layer3 = { status: 'error', error: error.message };
        console.error('[Pipeline] Erro Camada 3:', error.message);
      }
    } else {
      results.layer3 = { status: 'skipped', reason: 'use_ai=false' };
    }

    // ========== CONSOLIDAR RESULTADOS ==========
    const totalDuration = Date.now() - startTime;

    // Criar log de execução
    await base44.asServiceRole.entities.SyncRun.create({
      amazon_account_id: accountId,
      operation: 'unified_ads_pipeline',
      trigger_type: user ? 'manual' : 'automatic',
      status: 'success',
      execution_date: new Date().toISOString().slice(0, 10),
      started_at: new Date(startTime).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: totalDuration,
      records_processed: (results.layer1?.summary?.campaigns?.total || 0) + 
                         (results.layer1?.summary?.keywords?.total || 0),
    }).catch(() => {});

    return Response.json({
      ok: true,
      amazon_account_id: accountId,
      pipeline_version: '3.0',
      architecture: {
        layer1: 'calculateMetrics (cálculos matemáticos)',
        layer2: 'applyOptimizationRules (motor de regras)',
        layer3: 'summarizeForAI (resumo + priorização IA)',
      },
      results,
      summary: {
        campaigns_analyzed: results.layer1?.summary?.campaigns?.total || 0,
        keywords_analyzed: results.layer1?.summary?.keywords?.total || 0,
        decisions_generated: results.layer2?.decisions_count || 0,
        ai_prioritization: !!results.layer3?.ai_prioritization,
      },
      duration_ms: totalDuration,
      executed_at: new Date().toISOString(),
    });

  } catch (error) {
    console.error('[Pipeline] Erro geral:', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});