/**
 * cleanupTermBank
 * Remove termos do TermBank sem performance real:
 * - spend = 0 E orders = 0 E clicks = 0
 * - Fontes de IA legadas (AI_GENERATED, GPT_*, OPENAI_*, CLAUDE_*, PRODUCT_ANALYSIS)
 * - Termos sem atividade por mais de 90 dias
 * - Termos com ASIN de produto inativo/sem estoque
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const AI_SOURCES = new Set([
  'AI_GENERATED', 'OPENAI_TITLE_ANALYSIS', 'GPT_TITLE_ANALYSIS',
  'CLAUDE_PRODUCT_ANALYSIS', 'PRODUCT_ANALYSIS',
]);

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const cutoff90d = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);

    const body = await req.json().catch(() => ({}));
    let amazon_account_id = body.amazon_account_id;

    if (!amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      amazon_account_id = accs[0]?.id;
    }
    if (!amazon_account_id) return Response.json({ ok: false, error: 'Conta não encontrada' });

    // ASINs ativos com estoque
    const products = await base44.asServiceRole.entities.Product.filter(
      { amazon_account_id, status: 'active' }, null, 300
    ).catch(() => []);
    const activeAsins = new Set(
      products
        .filter((p: any) => Number(p.fba_inventory ?? p.fba_quantity ?? 0) > 0)
        .map((p: any) => p.asin).filter(Boolean)
    );

    let deleted = 0;
    let offset = 0;
    const PAGE = 200;

    while (true) {
      const batch = await base44.asServiceRole.entities.TermBank.filter(
        { amazon_account_id }, '-created_at', PAGE, offset
      );
      if (!batch.length) break;

      const toDelete = batch.filter((t: any) => {
        // Manter termos com performance real
        if ((t.spend || 0) > 0) return false;
        if ((t.orders || 0) > 0) return false;
        if ((t.clicks || 0) > 0) return false;
        if ((t.sales || 0) > 0) return false;

        // Deletar termos de produto inativo/sem estoque
        if (t.asin && !activeAsins.has(t.asin)) return true;

        // Deletar termos de fonte IA legada
        if (t.source && AI_SOURCES.has(t.source)) return true;

        // Deletar termos sem atividade há mais de 90 dias
        const lastActivity = t.last_performance_update || t.last_seen_at || t.created_at || t.created_date;
        if (lastActivity && lastActivity.slice(0, 10) < cutoff90d) return true;

        return false;
      });

      for (const t of toDelete) {
        await base44.asServiceRole.entities.TermBank.delete(t.id);
        deleted++;
      }

      if (batch.length < PAGE) break;
      offset += PAGE;
    }

    return Response.json({ ok: true, deleted, cutoff_days: 90 });
  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});