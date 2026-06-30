/**
 * generateAlerts — Gera alertas baseados em anomalias e limites
 * Chamado diariamente após sync
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    // Aceitar automação ou user
    let isAuth = false;
    try {
      const user = await base44.auth.me();
      isAuth = !!user;
    } catch {
      isAuth = true;
    }

    const body = await req.json().catch(() => ({}));

    // Resolver conta
    let accounts = [];
    if (body.amazon_account_id) {
      const acc = await base44.asServiceRole.entities.AmazonAccount.get(body.amazon_account_id).catch(() => null);
      if (acc) accounts = [acc];
    }
    if (accounts.length === 0) {
      accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' });
    }
    if (accounts.length === 0) {
      return Response.json({ ok: false, message: 'Nenhuma conta encontrada' });
    }

    const results = [];
    const now = new Date().toISOString();

    for (const account of accounts) {
      const amazonAccountId = account.id;
      let alertsCreated = 0;

      // Buscar alertas ativos recentes (evitar duplicação)
      const existingAlerts = await base44.asServiceRole.entities.Alert.filter(
        { amazon_account_id: amazonAccountId, status: 'active' },
        '-created_at',
        200
      );
      const existingAlertKeys = new Set(existingAlerts.map(a => `${a.alert_type}|${a.entity_type}|${a.entity_id}`));

      // 1. ACoS crítico (>80%)
      const highAcosCampaigns = await base44.asServiceRole.entities.Campaign.filter(
        { amazon_account_id: amazonAccountId, acos: { $gt: 80 }, state: 'enabled' },
        '-acos',
        20
      );
      for (const camp of highAcosCampaigns) {
        const key = `high_acos|campaign|${camp.campaign_id}`;
        if (existingAlertKeys.has(key)) continue;

        await base44.asServiceRole.entities.Alert.create({
          amazon_account_id,
          alert_type: 'high_acos',
          severity: camp.acos > 100 ? 'critical' : 'high',
          title: `ACoS crítico: ${camp.name}`,
          message: `ACoS de ${(camp.acos || 0).toFixed(1)}% está muito acima do target (25-35%)`,
          entity_type: 'campaign',
          entity_id: camp.campaign_id,
          campaign_id: camp.campaign_id,
          threshold_value: 35,
          current_value: camp.acos || 0,
          status: 'active',
          created_at: now,
        }).catch(() => {});
        alertsCreated++;
        existingAlertKeys.add(key);
      }

      // 2. ROAS baixo (<1)
      const lowRoasCampaigns = await base44.asServiceRole.entities.Campaign.filter(
        { amazon_account_id: amazonAccountId, roas: { $lt: 1 }, spend: { $gt: 5 }, state: 'enabled' },
        'roas',
        20
      );
      for (const camp of lowRoasCampaigns) {
        const key = `low_roas|campaign|${camp.campaign_id}`;
        if (existingAlertKeys.has(key)) continue;

        await base44.asServiceRole.entities.Alert.create({
          amazon_account_id,
          alert_type: 'low_roas',
          severity: 'high',
          title: `ROAS baixo: ${camp.name}`,
          message: `ROAS de ${(camp.roas || 0).toFixed(2)}x está abaixo do mínimo (4x)`,
          entity_type: 'campaign',
          entity_id: camp.campaign_id,
          campaign_id: camp.campaign_id,
          threshold_value: 4,
          current_value: camp.roas || 0,
          status: 'active',
          created_at: now,
        }).catch(() => {});
        alertsCreated++;
        existingAlertKeys.add(key);
      }

      // 3. Budget esgotado cedo (>90% antes das 18h)
      const hour = new Date().getHours();
      if (hour < 18) {
        const exhaustedCampaigns = await base44.asServiceRole.entities.Campaign.filter(
          { amazon_account_id: amazonAccountId, state: 'enabled' },
          '-spend',
          50
        );
        for (const camp of exhaustedCampaigns) {
          const budgetConsumed = camp.daily_budget > 0 ? (camp.spend || 0) / camp.daily_budget : 0;
          if (budgetConsumed < 0.9) continue;

          const key = `budget_exhausted|campaign|${camp.campaign_id}`;
          if (existingAlertKeys.has(key)) continue;

          await base44.asServiceRole.entities.Alert.create({
            amazon_account_id,
            alert_type: 'budget_exhausted',
            severity: 'high',
            title: `Budget esgotado: ${camp.name}`,
            message: `Campaign consumiu ${(budgetConsumed * 100).toFixed(0)}% do budget ($${(camp.spend || 0).toFixed(2)}/$${camp.daily_budget}) antes das 18h`,
            entity_type: 'campaign',
            entity_id: camp.campaign_id,
            campaign_id: camp.campaign_id,
            threshold_value: 100,
            current_value: budgetConsumed * 100,
            status: 'active',
            created_at: now,
          }).catch(() => {});
          alertsCreated++;
          existingAlertKeys.add(key);
        }
      }

      // 4. Produto sem estoque
      const outOfStockProducts = await base44.asServiceRole.entities.Product.filter(
        { amazon_account_id: amazonAccountId, fba_inventory: 0, has_campaign: true },
        '-total_sales_30d',
        20
      );
      for (const prod of outOfStockProducts) {
        const key = `out_of_stock|product|${prod.asin}`;
        if (existingAlertKeys.has(key)) continue;

        await base44.asServiceRole.entities.Alert.create({
          amazon_account_id,
          alert_type: 'out_of_stock',
          severity: 'critical',
          title: `Sem estoque: ${prod.asin}`,
          message: `Produto sem estoque FBA mas com campanha ativa`,
          entity_type: 'product',
          entity_id: prod.asin,
          asin: prod.asin,
          campaign_id: prod.linked_campaign_id,
          status: 'active',
          created_at: now,
        }).catch(() => {});
        alertsCreated++;
        existingAlertKeys.add(key);
      }

      // 5. Keyword sem impressões (>7 dias)
      const noImpressionsKeywords = await base44.asServiceRole.entities.Keyword.filter(
        { amazon_account_id: amazonAccountId, impressions: 0, state: 'enabled' },
        '-last_seen_at',
        50
      );
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      for (const kw of noImpressionsKeywords) {
        if (!kw.last_seen_at || kw.last_seen_at < sevenDaysAgo) continue;

        const key = `no_impressions|keyword|${kw.keyword_id}`;
        if (existingAlertKeys.has(key)) continue;

        await base44.asServiceRole.entities.Alert.create({
          amazon_account_id,
          alert_type: 'no_impressions',
          severity: 'low',
          title: `Sem impressões: ${kw.keyword_text}`,
          message: `Keyword sem impressões há mais de 7 dias`,
          entity_type: 'keyword',
          entity_id: kw.keyword_id,
          keyword_id: kw.keyword_id,
          campaign_id: kw.campaign_id,
          status: 'active',
          created_at: now,
        }).catch(() => {});
        alertsCreated++;
        existingAlertKeys.add(key);
      }

      results.push({ account: amazonAccountId, alerts_created: alertsCreated });
      console.log(`[generateAlerts] Conta ${amazonAccountId}: ${alertsCreated} alertas criados`);
    }

    return Response.json({ ok: true, results });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});