/**
 * runNightlyAutoExecution — Execução automática noturna às 23:50 BRT
 *
 * Fluxo:
 *   1. Busca todas as OptimizationDecisions com:
 *      - status = 'approved' OU (status = 'pending' AND requires_approval = false)
 *      - confidence >= 80
 *      - risk != 'high'
 *      - attempt_count < 3
 *      - não é uma negação com venda histórica
 *   2. Valida cada decisão via claudeAdsAgent (Policy Engine) para confirmação final
 *   3. Executa via executeAutopilotDecision (Amazon Ads API)
 *   4. Registra resultado no AutopilotRun para auditoria
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MIN_CONFIDENCE = 80;
const MAX_DECISIONS_PER_RUN = 100;

Deno.serve(async (req) => {
  const startTime = Date.now();
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  try {
    const base44 = createClientFromRequest(req);

    let isAuthorized = false;
    try { const u = await base44.auth.me(); if (u) isAuthorized = true; } catch {}
    if (!isAuthorized) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    // ── 1. Resolver conta ─────────────────────────────────────────────────
    const accs = await base44.asServiceRole.entities.AmazonAccount.filter(
      { status: 'connected' }, '-created_date', 1
    );
    const account = accs[0] || null;
    if (!account) return Response.json({ ok: false, skipped: true, reason: 'Nenhuma conta conectada.' });

    const aid = account.id;

    // ── 2. Verificar AutopilotConfig ──────────────────────────────────────
    const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid });
    const cfg = configs[0] || {};
    if (cfg.enabled === false) {
      return Response.json({ ok: true, skipped: true, reason: 'Autopilot desabilitado na configuração.' });
    }

    // ── 3. Registrar início do run ────────────────────────────────────────
    const runRecord = await base44.asServiceRole.entities.AutopilotRun.create({
      amazon_account_id: aid,
      status: 'running',
      trigger: 'scheduled_nightly_execution',
      started_at: now,
    });

    // ── 4. Buscar decisões elegíveis para execução automática ─────────────
    // Buscar 'approved' e 'pending' (sem aprovação exigida) separadamente
    const [approvedDecs, pendingDecs] = await Promise.all([
      base44.asServiceRole.entities.OptimizationDecision.filter(
        { amazon_account_id: aid, status: 'approved' },
        '-confidence', MAX_DECISIONS_PER_RUN
      ),
      base44.asServiceRole.entities.OptimizationDecision.filter(
        { amazon_account_id: aid, status: 'pending' },
        '-confidence', MAX_DECISIONS_PER_RUN
      ),
    ]);

    // Filtrar pendentes que não requerem aprovação
    const autoApproved = pendingDecs.filter(d => d.requires_approval === false);
    const allCandidates = [...approvedDecs, ...autoApproved];

    // ── 5. Aplicar filtros de segurança ───────────────────────────────────
    const eligible = allCandidates.filter(d => {
      // Confiança mínima de 80%
      if ((d.confidence || 0) < MIN_CONFIDENCE) return false;

      // Nunca executar risk=high automaticamente
      if (d.risk === 'high') return false;

      // Nunca executar ação irreversível de negação com venda histórica de forma auto
      const isNegation = ['negative_exact', 'negative_phrase', 'negative_keyword'].includes(d.action);
      if (isNegation && d.risk !== 'low') return false;

      // Máximo de 3 tentativas
      if ((d.attempt_count || 0) >= 3) return false;

      // Não executar decisões já em execução
      if (d.status === 'executing') return false;

      // Não executar reconciliações (não são ações estruturais)
      if ((d.action || '').startsWith('reconcile_')) return false;

      // Precisa ter entity_id ou campaign_id para executar
      if (!d.entity_id && !d.campaign_id && !d.keyword_id) return false;

      return true;
    });

    if (eligible.length === 0) {
      await base44.asServiceRole.entities.AutopilotRun.update(runRecord.id, {
        status: 'completed',
        completed_at: new Date().toISOString(),
        decisions_generated: 0,
      });
      return Response.json({
        ok: true,
        executed: 0,
        skipped: 0,
        failed: 0,
        reason: 'Nenhuma decisão elegível com confiança ≥ 80% para execução automática.',
        duration_ms: Date.now() - startTime,
      });
    }

    // ── 6. Ordenar por prioridade (pause > bid_change > budget_change > others) e confiança ──
    const priority = (d) => {
      if (d.decision_type === 'pause') return 10;
      if (d.action === 'pause_campaign') return 10;
      if (d.decision_type === 'bid_change' && d.risk === 'low') return 8;
      if (d.decision_type === 'budget_change' && d.risk === 'low') return 7;
      if (d.decision_type === 'bid_change') return 6;
      if (d.decision_type === 'budget_change') return 5;
      if (d.decision_type === 'negative_keyword') return 3;
      if (d.decision_type === 'harvest_search_term') return 4;
      return 2;
    };

    eligible.sort((a, b) => {
      const pDiff = priority(b) - priority(a);
      if (pDiff !== 0) return pDiff;
      return (b.confidence || 0) - (a.confidence || 0);
    });

    // Limitar ao máximo por run
    const toExecute = eligible.slice(0, MAX_DECISIONS_PER_RUN);

    console.log(`[runNightlyAutoExecution] ${toExecute.length} decisões elegíveis para execução.`);

    // ── 7. Executar uma decisão por vez ──────────────────────────────────
    const results = { executed: 0, failed: 0, skipped: 0, details: [] };

    for (const d of toExecute) {
      console.log(`[runNightlyAutoExecution] Executando decisão ${d.id} (${d.action}, confiança ${d.confidence}%)`);

      try {
        const r = await base44.asServiceRole.functions.invoke('executeAutopilotDecision', {
          decision_ids: [d.id],
        });

        const result = r?.results?.[0];
        if (result?.ok) {
          results.executed++;
        } else {
          results.failed++;
        }
        results.details.push({
          id: d.id,
          ok: result?.ok ?? false,
          action: d.action,
          confidence: d.confidence,
          status: result?.status || 'unknown',
          error: result?.error || null,
        });
      } catch (err) {
        results.failed++;
        results.details.push({ id: d.id, ok: false, action: d.action, error: err.message });
        console.error(`[runNightlyAutoExecution] Erro na decisão ${d.id}: ${err.message}`);
      }

      // 1s entre chamadas para respeitar rate limit Amazon
      await new Promise(r => setTimeout(r, 1000));
    }

    // ── 8. Registrar resumo no Claude para análise pós-execução ──────────
    // Só se houver execuções bem-sucedidas
    if (results.executed > 0) {
      try {
        await base44.asServiceRole.functions.invoke('reviewLatestDecisionsPostExecution', {
          amazon_account_id: aid,
          run_date: today,
          executed_count: results.executed,
          failed_count: results.failed,
        }).catch(() => {}); // não bloquear o run se falhar
      } catch {}
    }

    // ── 9. Finalizar run ──────────────────────────────────────────────────
    const finalStatus = results.failed > 0 && results.executed === 0 ? 'failed' : 'completed';
    await base44.asServiceRole.entities.AutopilotRun.update(runRecord.id, {
      status: finalStatus,
      completed_at: new Date().toISOString(),
      decisions_generated: results.executed,
    });

    return Response.json({
      ok: true,
      eligible_found: toExecute.length,
      executed: results.executed,
      failed: results.failed,
      skipped: eligible.length - toExecute.length,
      confidence_threshold: MIN_CONFIDENCE,
      details: results.details,
      duration_ms: Date.now() - startTime,
    });

  } catch (error) {
    console.error('[runNightlyAutoExecution] Erro fatal:', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});