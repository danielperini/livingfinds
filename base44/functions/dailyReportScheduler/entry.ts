/**
 * dailyReportScheduler — Agendado diariamente às 10h (BRT).
 * Usa runFullSync para pipeline completo:
 * 1. Importa campanhas + solicita relatórios 30d
 * 2. Aguarda até 30 min com polling de 5 min
 * 3. Baixa, normaliza e persiste todos os dados
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
    if (accounts.length === 0) return Response.json({ ok: false, message: 'Nenhuma conta Amazon conectada.' });
    const amazonAccountId = accounts[0].id;

    // Fase 1: importar campanhas + solicitar relatórios
    const r1 = await base44.asServiceRole.functions.invoke('runFullSync', { amazon_account_id: amazonAccountId, action: 'request' });
    const d1 = r1?.data || r1;

    if (!d1?.ok) return Response.json({ ok: false, step: 'request', error: d1?.message || d1?.amazon_error });

    const { reportIds, syncRunId } = d1;

    // Fase 2: polling até 30 min (6 tentativas × 5 min)
    let downloadResult = null;
    for (let attempt = 1; attempt <= 6; attempt++) {
      await new Promise(r => setTimeout(r, 5 * 60 * 1000));
      const r2 = await base44.asServiceRole.functions.invoke('runFullSync', {
        amazon_account_id: amazonAccountId,
        action: 'download',
        reportIds,
        syncRunId,
      });
      const d2 = r2?.data || r2;
      if (d2?.ready === true) { downloadResult = d2; break; }
      if (!d2?.ok && !d2?.ready) break; // erro real
      // ainda pendente → continuar
    }

    return Response.json({
      ok: true,
      amazon_account_id: amazonAccountId,
      campaigns_imported: d1.campaigns_imported,
      download: downloadResult,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});