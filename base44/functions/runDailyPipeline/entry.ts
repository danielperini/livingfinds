/**
 * runDailyPipeline — Orquestrador diário que executa todos os fluxos em sequência para as
 * contas Amazon disponíveis: solicita relatórios, baixa, analisa por IA, prepara e executa.
 * Payload (opcional): { skip_request, skip_analysis, skip_execution }
 *
 * Não precisa de amazon_account_id — detecta automaticamente todas as contas.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  const pipelineStart = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const skip = await req.json().catch(() => ({})).then(b => ({
      skipRequest: b.skip_request !== undefined ? b.skip_request : false,
      skipExecution: b.skip_execution !== undefined ? b.skip_execution : false,
    }));

    const [accounts, runs] = await Promise.all([
      base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }),
      base44.asServiceRole.entities.SyncRun.filter({}, '-started_at', 1),
    ]);
    if (!accounts.length) return Response.json({ ok: true, message: 'No connected accounts', duration: Date.now() - pipelineStart });

    const accountResults = [];
    for (const acc of accounts) {
      const steps = [];
      try {
        const accountStart = Date.now();
        // 1. Solicitar relatórios completos (11 tipos)
        if (!skip.skipRequest) {
          const r1 = await base44.functions.invoke('requestAdsReportsFull', { amazon_account_id: acc.id });
          steps.push({ step: 'request_reports', ok: r1?.ok, result: r1 });
        }

        // 2. Análise IA em blocos
        if (!skip.skipAnalysis) {
          const r2 = await base44.functions.invoke('runDailyAIAdsAnalysis', { amazon_account_id: acc.id, auto_apply: false });
          steps.push({ step: 'ai_analysis', ok: r2?.ok, decisions: r2?.decisions_generated || 0 });
        }

        accountResults.push({ account: acc.id, ok: true, duration: Date.now() - accountStart, steps });
      } catch (e) {
        accountResults.push({ account: acc.id, ok: false, error: e.message });
      }
    }

    const totalOk = accountResults.filter(r => r.ok).length;
    await base44.asServiceRole.entities.SyncRun.create({
      amazon_account_id: accounts.length > 1 ? '__pipeline' : accounts[0]?.id || '__pipeline',
      operation: `dailyPipeline,${new Date().toISOString().slice(0, 10)}`,
      status: 'success',
      records_upserted: totalOk,
      duration_ms: Date.now() - pipelineStart,
      completed_at: new Date().toISOString(),
      started_at: new Date(pipelineStart).toISOString(),
    });

    return Response.json({
      ok: true,
      accounts_processed: accounts.length,
      successful: totalOk,
      decisions_count: accountResults.reduce((s, r) => s + (r.steps?.[1]?.decisions || 0), 0),
      account_results: accountResults, duration: Date.now() - pipelineStart,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});