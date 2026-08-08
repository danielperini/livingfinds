import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const n = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const text = (value: unknown) => String(value || '').trim();

function brazilDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function coverage(units: number, velocity: number): number | null {
  if (velocity <= 0) return null;
  return Math.max(0, units / velocity);
}

function growthFactor(product: any): number {
  const profit = n(product.profit_after_ads);
  const tacos = n(product.tacos);
  const acos = n(product.acos);
  const sales = n(product.total_sales_30d);
  if (profit > 0 && sales > 0 && (tacos <= 5 || tacos === 0) && (acos <= 15 || acos === 0)) return 1.25;
  if (profit > 0 && sales > 0) return 1.10;
  return 1.0;
}

function priorityFor(days: number | null, recommended: number): 'low' | 'medium' | 'high' | 'critical' {
  if (recommended <= 0) return 'low';
  if (days == null || days <= 3) return 'critical';
  if (days <= 7) return 'high';
  if (days <= 14) return 'medium';
  return 'low';
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (body._service_role !== true) {
      const authenticated = await base44.auth.isAuthenticated().catch(() => false);
      if (!authenticated) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const today = brazilDate();
    const now = new Date().toISOString();
    const leadTimeDays = Math.max(1, Math.min(60, n(body.lead_time_days, 14)));
    const safetyDays = Math.max(1, Math.min(45, n(body.safety_stock_days, 7)));
    const baseTargetDays = leadTimeDays + safetyDays;

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 50);

    const output: any[] = [];
    for (const account of accounts) {
      const accountId = String(account.id);
      const country = text(account.country_code || 'BR').toUpperCase();
      const marketplaceId = text(account.marketplace_id);
      const apiCreateSupported = country !== 'BR';
      const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId, status: 'active' }, '-updated_at', 5000).catch(() => []);
      const existing = await base44.asServiceRole.entities.FbaReplenishmentRecommendation.filter({ amazon_account_id: accountId, recommendation_date: today }, '-updated_at', 5000).catch(() => []);
      const existingByKey = new Map(existing.map((row: any) => [String(row.idempotency_key), row]));

      let created = 0;
      let updated = 0;
      const recommendations: any[] = [];

      for (const product of products) {
        const asin = text(product.asin).toUpperCase();
        const sku = text(product.sku);
        if (!asin || !sku || product.listing_suppressed === true || product.listing_status === 'inactive') continue;

        const velocity = Math.max(0, n(product.daily_sales_velocity_30d, n(product.total_units_30d) / 30));
        const available = Math.max(0, n(product.available_quantity, product.fba_inventory));
        const reserved = Math.max(0, n(product.reserved_inventory));
        const inbound = Math.max(0, n(product.inbound_inventory));
        const sellableCoverage = coverage(available, velocity);
        const projectedCoverage = coverage(available + inbound, velocity);
        const observedDays = n(product.inventory_signal_observed_days, 0);
        const sufficientHistory = velocity > 0 && (observedDays >= 7 || n(product.total_units_30d) >= 3);
        const factor = growthFactor(product);
        const targetDays = Math.ceil(baseTargetDays * factor);
        const targetUnits = sufficientHistory ? Math.ceil(velocity * targetDays) : 0;
        const recommendedUnits = sufficientHistory ? Math.max(0, targetUnits - available - inbound) : 0;
        const priority = priorityFor(sellableCoverage, recommendedUnits);
        const capability = apiCreateSupported ? 'api_supported' : 'recommendation_only_br_marketplace';
        const status = !sufficientHistory
          ? 'watch'
          : recommendedUnits <= 0
            ? 'no_action'
            : !apiCreateSupported
              ? 'blocked_api_unavailable'
              : priority === 'critical' ? 'critical' : 'replenish';
        const key = `FBA_REPLENISH|${accountId}|${asin}|${today}`;
        const reason = !sufficientHistory
          ? 'Histórico insuficiente para calcular reposição automática com segurança.'
          : recommendedUnits <= 0
            ? `Cobertura suficiente: ${projectedCoverage == null ? 'n/a' : projectedCoverage.toFixed(1)} dias incluindo inbound.`
            : `Meta ${targetDays} dias = ${targetUnits} un.; disponível ${available}; inbound ${inbound}; recomendar ${recommendedUnits} un.`;

        const record = {
          amazon_account_id: accountId,
          asin, sku,
          product_name: text(product.product_name || product.display_name),
          marketplace_id: marketplaceId,
          marketplace_country: country,
          recommendation_date: today,
          idempotency_key: key,
          status,
          priority,
          daily_sales_velocity: Number(velocity.toFixed(4)),
          available_inventory: available,
          reserved_inventory: reserved,
          inbound_inventory: inbound,
          days_of_supply: sellableCoverage == null ? null : Number(sellableCoverage.toFixed(2)),
          days_of_supply_with_inbound: projectedCoverage == null ? null : Number(projectedCoverage.toFixed(2)),
          lead_time_days: leadTimeDays,
          safety_stock_days: safetyDays,
          target_coverage_days: targetDays,
          target_inventory_units: targetUnits,
          recommended_units: recommendedUnits,
          ads_growth_factor: factor,
          profit_after_ads: n(product.profit_after_ads),
          acos: n(product.acos),
          tacos: n(product.tacos),
          inventory_signal_quality: sufficientHistory ? 'sufficient' : 'insufficient_history',
          calculation_reason: reason,
          execution_capability: capability,
          amazon_status: apiCreateSupported ? 'creation_not_implemented' : 'BR_INBOUND_CREATE_NOT_SUPPORTED_BY_AMAZON_API',
          last_error: apiCreateSupported ? null : 'Amazon Fulfillment Inbound API v2024-03-20 não suporta criação de inbound shipment no Brasil.',
          calculated_at: now,
          updated_at: now,
        };

        const prior = existingByKey.get(key);
        if (prior?.id) {
          await base44.asServiceRole.entities.FbaReplenishmentRecommendation.update(prior.id, record);
          updated++;
        } else {
          await base44.asServiceRole.entities.FbaReplenishmentRecommendation.create(record);
          created++;
        }

        await base44.asServiceRole.entities.Product.update(product.id, {
          daily_sales_velocity_30d: Number(velocity.toFixed(4)),
          days_of_supply: sellableCoverage == null ? null : Number(sellableCoverage.toFixed(2)),
          days_of_supply_with_inbound: projectedCoverage == null ? null : Number(projectedCoverage.toFixed(2)),
          inventory_coverage_status: !sufficientHistory ? 'insufficient_history'
            : available <= 0 ? 'out_of_stock'
            : (sellableCoverage || 0) <= 3 ? 'critical'
            : (sellableCoverage || 0) <= 14 ? 'low' : 'healthy',
          inventory_signal_quality: sufficientHistory ? 'sufficient' : 'insufficient_history',
          inventory_signal_calculated_at: now,
        }).catch(() => null);

        recommendations.push({ asin, sku, recommended_units: recommendedUnits, priority, status, days_of_supply: sellableCoverage, inbound, execution_capability: capability });
      }

      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: accountId,
        sync_type: 'fba_replenishment_planner',
        status: 'completed',
        source_function: 'runFbaReplenishmentPlanner',
        records_processed: products.length,
        records_imported: created + updated,
        message: country === 'BR'
          ? `Reposição FBA calculada automaticamente. Criação de inbound via API bloqueada por indisponibilidade oficial no Brasil; ${recommendations.filter((r) => r.recommended_units > 0).length} SKU(s) requerem reposição.`
          : `Reposição FBA calculada automaticamente; ${recommendations.filter((r) => r.recommended_units > 0).length} SKU(s) requerem reposição.`,
        started_at: now,
        completed_at: new Date().toISOString(),
      }).catch(() => null);

      output.push({ amazon_account_id: accountId, country, api_create_supported: apiCreateSupported, created, updated, recommendations });
    }

    return Response.json({ ok: true, engine: 'FBA_REPLENISHMENT_V1', automatic: true, creates_shipments: false, results: output });
  } catch (error: any) {
    return Response.json({ ok: false, engine: 'FBA_REPLENISHMENT_V1', error: error?.message || String(error) }, { status: 500 });
  }
});
