/**
 * checkAndCreateAlerts — Verifica condições críticas e cria alertas
 * Chamado diariamente após sync
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    // Aceitar automação scheduled
    let user = null;
    try {
      user = await base44.auth.me();
    } catch {
      // automação não tem user
    }

    const body = await req.json().catch(() => ({}));
    let amazonAccountId = body.amazon_account_id;

    // Resolver conta
    if (!amazonAccountId) {
      const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      amazonAccountId = accounts[0]?.id;
    }

    if (!amazonAccountId) {
      return Response.json({ ok: false, message: 'Nenhuma conta Amazon encontrada' });
    }

    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    let alertsCreated = 0;

    // Buscar campanhas ativas
    const campaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: amazonAccountId, state: 'enabled' },
      '-spend',
      500
    );

    // Buscar regras de budget
    const budgetRules = await base44.asServiceRole.entities.BudgetRule.filter({ amazon_account_id: amazonAccountId });
    const budgetRule = budgetRules[0] || { target_acos: 25, max_bid: 5.0 };

    // Verificar cada campanha
    for (const campaign of campaigns) {
      const alerts = [];

      // 1. Budget terminando cedo
      const hourOfDay = new Date().getHours();
      const expectedSpendPct = hourOfDay / 24;
      const actualSpendPct = campaign.daily_budget > 0 ? (campaign.current_spend || 0) / campaign.daily_budget : 0;

      if (actualSpendPct > expectedSpendPct + 0.3 && actualSpendPct > 0.7) {
        alerts.push({
          alert_type: 'budget_exhaustion',
          severity: 'high',
          title: 'Orçamento terminando cedo',
          message: `Campanha "${campaign.name}" consumiu ${(actualSpendPct * 100).toFixed(0)}% do budget às ${hourOfDay}h`,
          entity_type: 'campaign',
          entity_id: campaign.id,
          campaign_id: campaign.campaign_id,
          current_value: actualSpendPct * 100,
          threshold_value: 70,
        });
      }

      // 2. ACoS crítico
      if ((campaign.acos || 0) > 60) {
        alerts.push({
          alert_type: 'high_acos',
          severity: campaign.acos > 80 ? 'critical' : 'high',
          title: 'ACoS crítico',
          message: `Campanha "${campaign.name}" com ACoS ${(campaign.acos || 0).toFixed(0)}% (meta: ${budgetRule.target_acos}%)`,
          entity_type: 'campaign',
          entity_id: campaign.id,
          campaign_id: campaign.campaign_id,
          current_value: campaign.acos,
          threshold_value: budgetRule.target_acos,
        });
      }

      // 3. ROAS baixo
      if ((campaign.roas || 0) > 0 && campaign.roas < 2) {
        alerts.push({
          alert_type: 'low_roas',
          severity: 'medium',
          title: 'ROAS baixo',
          message: `Campanha "${campaign.name}" com ROAS ${(campaign.roas || 0).toFixed(2)}x`,
          entity_type: 'campaign',
          entity_id: campaign.id,
          campaign_id: campaign.campaign_id,
          current_value: campaign.roas,
          threshold_value: 2,
        });
      }

      // 4. Gasto sem venda (últimos 7 dias)
      if ((campaign.spend || 0) > 10 && (campaign.sales || 0) === 0) {
        alerts.push({
          alert_type: 'no_sales',
          severity: 'high',
          title: 'Gasto sem vendas',
          message: `Campanha "${campaign.name}" gastou $${(campaign.spend || 0).toFixed(2)} sem vendas`,
          entity_type: 'campaign',
          entity_id: campaign.id,
          campaign_id: campaign.campaign_id,
          current_value: campaign.spend,
          threshold_value: 10,
        });
      }

      // 5. Bid acima do limite
      if ((campaign.cpc || 0) > (budgetRule.max_bid || 5)) {
        alerts.push({
          alert_type: 'bid_above_limit',
          severity: 'medium',
          title: 'CPC acima do limite',
          message: `Campanha "${campaign.name}" com CPC $${(campaign.cpc || 0).toFixed(2)} (limite: $${budgetRule.max_bid})`,
          entity_type: 'campaign',
          entity_id: campaign.id,
          campaign_id: campaign.campaign_id,
          current_value: campaign.cpc,
          threshold_value: budgetRule.max_bid,
        });
      }

      // Criar alertas
      for (const alert of alerts) {
        // Verificar se já existe alerta não resolvido nas últimas 24h
        const existingAlerts = await base44.asServiceRole.entities.Alert.filter({
          amazon_account_id: amazonAccountId,
          alert_type: alert.alert_type,
          entity_id: alert.entity_id,
          is_resolved: false,
        }, '-created_at', 1);

        if (existingAlerts.length > 0) {
          const lastAlert = existingAlerts[0];
          const hoursSinceAlert = (Date.now() - new Date(lastAlert.created_at).getTime()) / 3600000;
          if (hoursSinceAlert < 24) continue; // Não duplicar em 24h
        }

        await base44.asServiceRole.entities.Alert.create({
          amazon_account_id: amazonAccountId,
          ...alert,
          created_at: now,
          expires_at: new Date(Date.now() + 7 * 86400000).toISOString(), // 7 dias
        }).catch(() => {});
        alertsCreated++;
      }
    }

    // Verificar produtos sem estoque
    const products = await base44.asServiceRole.entities.Product.filter(
      { amazon_account_id: amazonAccountId, has_campaign: true },
      '-total_sales_30d',
      100
    );

    for (const product of products) {
      if ((product.fba_inventory || 0) < 5) {
        await base44.asServiceRole.entities.Alert.create({
          amazon_account_id: amazonAccountId,
          alert_type: 'low_stock',
          severity: product.fba_inventory === 0 ? 'critical' : 'high',
          title: 'Estoque baixo',
          message: `Produto ${product.asin} com apenas ${product.fba_inventory || 0} unidades`,
          entity_type: 'product',
          entity_id: product.id,
          asin: product.asin,
          current_value: product.fba_inventory || 0,
          threshold_value: 5,
          created_at: now,
          expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
        }).catch(() => {});
        alertsCreated++;
      }
    }

    return Response.json({
      ok: true,
      alerts_created: alertsCreated,
      campaigns_checked: campaigns.length,
      products_checked: products.length,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});