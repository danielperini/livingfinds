/**
 * suggestCampaignActivations
 * Identifica produtos com estoque positivo e sem campanha ativa,
 * e cria sugestões (AgentAction) para ativação de anúncios.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    // Buscar todas as contas
    const accounts = await base44.asServiceRole.entities.AmazonAccount.list();
    if (!accounts.length) return Response.json({ ok: true, message: 'Nenhuma conta encontrada', suggestions: 0 });

    let totalSuggestions = 0;

    for (const account of accounts) {
      const aid = account.id;

      // Produtos com estoque positivo e sem campanha ativa
      const products = await base44.asServiceRole.entities.Product.filter(
        { amazon_account_id: aid },
        '-created_date',
        2000
      );

      const eligible = products.filter(p =>
        (p.fba_inventory || 0) > 0 &&
        p.campaign_status !== 'active' &&
        p.status !== 'archived'
      );

      if (eligible.length === 0) continue;

      // Buscar sugestões já existentes para evitar duplicatas
      const existing = await base44.asServiceRole.entities.AgentAction.filter({
        amazon_account_id: aid,
        action: 'create_auto_campaign',
        status: 'pending',
      }, '-created_date', 500);

      const existingAsins = new Set(existing.map(e => e.asin));

      const toCreate = eligible
        .filter(p => !existingAsins.has(p.asin))
        .map(p => ({
          amazon_account_id: aid,
          action: 'create_auto_campaign',
          asin: p.asin,
          reason: `Produto com ${p.fba_inventory} unidades em stock FBA sem campanha ativa (${p.campaign_status || 'none'}).`,
          evidence: `Vendas 30d: $${(p.total_sales_30d || 0).toFixed(2)} · Units: ${p.total_units_30d || 0} · SKU: ${p.sku || '—'}`,
          risk_level: 'low',
          requires_approval: true,
          status: 'pending',
        }));

      if (toCreate.length > 0) {
        for (let i = 0; i < toCreate.length; i += 100) {
          await base44.asServiceRole.entities.AgentAction.bulkCreate(toCreate.slice(i, i + 100));
        }
        totalSuggestions += toCreate.length;
      }
    }

    return Response.json({
      ok: true,
      suggestions_created: totalSuggestions,
      message: `${totalSuggestions} sugestão(ões) de ativação de campanha criadas.`,
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});