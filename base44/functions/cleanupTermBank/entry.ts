/**
 * cleanupTermBank
 * Deleta termos do TermBank que não tiveram atualização de performance
 * por mais de 180 dias (last_performance_update ou created_at).
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    const cutoff = new Date(Date.now() - 180 * 86400000).toISOString();

    // Buscar todos os termos do banco
    let deleted = 0;
    let offset = 0;
    const PAGE = 200;

    while (true) {
      const batch = await base44.asServiceRole.entities.TermBank.filter(
        {}, '-created_at', PAGE, offset
      );
      if (!batch.length) break;

      const toDelete = batch.filter(t => {
        const lastActivity = t.last_performance_update || t.last_seen_at || t.created_at;
        return lastActivity && lastActivity < cutoff;
      });

      for (const t of toDelete) {
        await base44.asServiceRole.entities.TermBank.delete(t.id);
        deleted++;
      }

      if (batch.length < PAGE) break;
      offset += PAGE;
    }

    return Response.json({ ok: true, deleted, cutoff });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});