/**
 * importProductEconomics
 * Importa/atualiza custos confirmados e preços na entidade ProductEconomics.
 * Idempotente por (amazon_account_id + normalized_sku).
 * Não apaga dados existentes — apenas atualiza ou cria.
 * Registra histórico em ProductEconomicsHistory antes de qualquer alteração.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const SAFETY_FACTOR = 0.80;
const AMAZON_FEE_DEFAULT_PCT = 0.15; // 15% padrão quando não configurado
const FALLBACK_CVR = 0.05;

function normalizeSku(sku: string): string {
  if (!sku) return '';
  return sku.trim().toUpperCase().replace(/\s+/g, '-').replace(/-{2,}/g, '-');
}

function calcEconomics(params: {
  unit_cost: number;
  inbound_freight: number;
  tax_per_unit: number;
  logistics_cost: number;
  packaging_cost: number;
  other_variable_cost: number;
  amazon_fee_amount: number;
  current_price: number;
  conversion_rate: number;
}): any {
  const {
    unit_cost, inbound_freight, tax_per_unit, logistics_cost,
    packaging_cost, other_variable_cost, amazon_fee_amount, current_price, conversion_rate
  } = params;

  if (current_price <= 0) {
    return {
      total_variable_cost_per_unit: unit_cost + inbound_freight + tax_per_unit + logistics_cost + packaging_cost + other_variable_cost + amazon_fee_amount,
      contribution_margin_amount: null,
      contribution_margin_percent: null,
      break_even_acos: null,
      target_acos: null,
      target_roas: null,
      safe_max_cpc: null,
      missing_price: true,
    };
  }

  const total_variable_cost = unit_cost + inbound_freight + tax_per_unit + logistics_cost + packaging_cost + other_variable_cost + amazon_fee_amount;
  const contribution_margin_amount = current_price - total_variable_cost;
  const contribution_margin_percent = (contribution_margin_amount / current_price) * 100;
  const break_even_acos = contribution_margin_percent; // em %
  const target_acos = Math.min(break_even_acos, break_even_acos * SAFETY_FACTOR);
  const target_roas = target_acos > 0 ? 100 / target_acos : 0;
  const cvr = conversion_rate > 0 ? conversion_rate : FALLBACK_CVR;
  const safe_max_cpc = current_price * cvr * (target_acos / 100);

  return {
    total_variable_cost_per_unit: Math.round(total_variable_cost * 100) / 100,
    contribution_margin_amount: Math.round(contribution_margin_amount * 100) / 100,
    contribution_margin_percent: Math.round(contribution_margin_percent * 100) / 100,
    break_even_acos: Math.round(break_even_acos * 100) / 100,
    target_acos: Math.round(target_acos * 100) / 100,
    target_roas: Math.round(target_roas * 100) / 100,
    safe_max_cpc: Math.round(safe_max_cpc * 100) / 100,
    missing_price: false,
  };
}

function calcEconomicStatus(rec: any): string {
  if (!rec.unit_cost || rec.unit_cost <= 0) return 'missing_cost';
  if (!rec.current_price || rec.current_price <= 0) return 'missing_price';
  if (!rec.amazon_fee_amount && !rec.amazon_fee_percent) return 'missing_fees';
  if (rec.contribution_margin_percent === null) return 'invalid';
  return 'complete';
}

function calcConfidence(rec: any): { cost: number; price: number; fees: number; final: number } {
  const cost = rec.cost_source === 'manual_confirmed' || rec.cost_source === 'manual_confirmed_import' ? 1.0
    : rec.cost_source === 'historical_import' ? 0.85
    : rec.unit_cost > 0 ? 0.6 : 0.0;
  const price = rec.price_source === 'sp_api_listing' ? 0.95
    : rec.price_source === 'manual_confirmed' ? 1.0
    : rec.price_source === 'sp_api_sales_average' ? 0.75
    : rec.current_price > 0 ? 0.5 : 0.0;
  const fees = rec.fees_source === 'amazon_fee_report' ? 0.95
    : rec.amazon_fee_amount > 0 ? 0.6
    : 0.3; // tarifa estimada padrão
  const final = cost * 0.40 + price * 0.40 + fees * 0.20;
  return { cost, price, fees, final: Math.round(final * 100) / 100 };
}

function classifyEconomics(rec: any): string {
  if (!rec.unit_cost || !rec.current_price || rec.current_price <= 0) return 'unknown';
  if (rec.contribution_margin_percent === null) return 'unknown';
  const cm = rec.contribution_margin_percent;
  if (cm <= 0) return 'unprofitable';
  if (cm < 5) return 'break_even';
  if (cm < 15) return 'low_margin';
  if (cm < 25) return 'profitable';
  return 'highly_profitable';
}

Deno.serve(async (req) => {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const base44 = createClientFromRequest(req);

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, items, recalculate_only } = body;

    if (!amazon_account_id) return Response.json({ error: 'amazon_account_id obrigatório' }, { status: 400 });

    const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let created = 0, updated = 0, skipped = 0, historyCreated = 0;
    const errors: any[] = [];
    const results: any[] = [];

    // Carregar todos os ProductEconomics existentes para esta conta (indexed por normalized_sku)
    const existing = await base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id }, null, 500);
    const existingByNsku = new Map(existing.map((e: any) => [normalizeSku(e.sku), e]));

    // Carregar Products para vincular asin/product_id
    const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id }, null, 500);
    const productByNsku = new Map(products.map((p: any) => [normalizeSku(p.sku), p]));

    // Se recalculate_only, reprocessar todos os existentes
    const toProcess: any[] = recalculate_only
      ? existing.map((e: any) => ({
          sku: e.sku, unit_cost: e.unit_cost, current_price: e.current_price,
          average_sale_price: e.average_sale_price, amazon_fee_amount: e.amazon_fee_amount,
          amazon_fee_percent: e.amazon_fee_percent,
          inbound_freight_per_unit: e.inbound_freight_per_unit || 0,
          tax_per_unit: e.tax_per_unit || 0,
          logistics_cost_per_unit: e.logistics_cost_per_unit || 0,
          packaging_cost_per_unit: e.packaging_cost_per_unit || 0,
          other_variable_cost_per_unit: e.other_variable_cost_per_unit || 0,
          other_cost_description: e.other_cost_description,
          cost_source: e.cost_source, price_source: e.price_source, fees_source: e.fees_source,
          product_name: e.product_name,
          _recalculate: true,
        }))
      : (items || []);

    for (const item of toProcess) {
      const nsku = normalizeSku(item.sku);
      if (!nsku) { errors.push({ sku: item.sku, error: 'SKU vazio após normalização' }); continue; }

      const existingRec = existingByNsku.get(nsku);
      const linkedProduct = productByNsku.get(nsku);

      // Custo: usar o informado; se recalculate_only, manter o existente
      const unit_cost = item._recalculate
        ? (existingRec?.unit_cost || 0)
        : (item.unit_cost != null ? Number(item.unit_cost) : (existingRec?.unit_cost || 0));

      // Preço: usar o informado; fallback para o que já está no banco
      let current_price = item.current_price != null && Number(item.current_price) > 0
        ? Number(item.current_price)
        : (item.average_sale_price != null && Number(item.average_sale_price) > 0
            ? Number(item.average_sale_price)
            : (existingRec?.current_price || linkedProduct?.price || 0));

      // Taxas Amazon: usar configurado ou estimar
      const amazon_fee_percent = item.amazon_fee_percent != null
        ? Number(item.amazon_fee_percent)
        : (existingRec?.amazon_fee_percent || AMAZON_FEE_DEFAULT_PCT * 100);
      const amazon_fee_amount = item.amazon_fee_amount != null
        ? Number(item.amazon_fee_amount)
        : (current_price > 0
            ? Math.round(current_price * (amazon_fee_percent / 100) * 100) / 100
            : (existingRec?.amazon_fee_amount || 0));

      const inbound = Number(item.inbound_freight_per_unit || existingRec?.inbound_freight_per_unit || 0);
      const tax = Number(item.tax_per_unit || existingRec?.tax_per_unit || 0);
      const logistics = Number(item.logistics_cost_per_unit || existingRec?.logistics_cost_per_unit || 0);
      const packaging = Number(item.packaging_cost_per_unit || existingRec?.packaging_cost_per_unit || 0);
      const other = Number(item.other_variable_cost_per_unit || existingRec?.other_variable_cost_per_unit || 0);

      const cvr = linkedProduct?.conversion_rate_30d || FALLBACK_CVR;

      const calc = calcEconomics({
        unit_cost, inbound_freight: inbound, tax_per_unit: tax,
        logistics_cost: logistics, packaging_cost: packaging,
        other_variable_cost: other, amazon_fee_amount, current_price, conversion_rate: cvr,
      });

      const cost_source = item._recalculate
        ? (existingRec?.cost_source || 'unknown')
        : (item.cost_source || (item.unit_cost != null ? 'manual_confirmed_import' : 'unknown'));
      const price_source = item._recalculate
        ? (existingRec?.price_source || 'unknown')
        : (item.price_source || (item.current_price > 0 ? 'manual_confirmed' : (item.average_sale_price > 0 ? 'sp_api_sales_average' : 'unknown')));
      const fees_source = item._recalculate
        ? (existingRec?.fees_source || 'account_configuration')
        : (item.fees_source || 'account_configuration');

      const recData: any = {
        amazon_account_id,
        sku: item.sku,
        normalized_sku: nsku,
        product_name: item.product_name || existingRec?.product_name || linkedProduct?.product_name || item.sku,
        asin: linkedProduct?.asin || existingRec?.asin || null,
        product_id: linkedProduct?.id || existingRec?.product_id || null,
        unit_cost,
        inbound_freight_per_unit: inbound,
        tax_per_unit: tax,
        logistics_cost_per_unit: logistics,
        packaging_cost_per_unit: packaging,
        other_variable_cost_per_unit: other,
        other_cost_description: item.other_cost_description || existingRec?.other_cost_description || null,
        total_variable_cost_per_unit: calc.total_variable_cost_per_unit,
        current_price,
        average_sale_price: item.average_sale_price || existingRec?.average_sale_price || current_price,
        amazon_fee_amount,
        amazon_fee_percent,
        contribution_margin_amount: calc.contribution_margin_amount,
        contribution_margin_percent: calc.contribution_margin_percent,
        break_even_acos: calc.break_even_acos,
        target_acos: calc.target_acos,
        target_roas: calc.target_roas,
        safe_max_cpc: calc.safe_max_cpc,
        cost_source,
        price_source,
        fees_source,
        product_link_status: linkedProduct?.asin ? 'linked' : 'pending',
        import_batch_id: batchId,
        imported_by: user.email || user.id,
        imported_at: now,
        effective_from: item.effective_from || today,
        last_calculated_at: now,
        updated_at: now,
      };

      // Calcular status e confiança
      recData.economics_status = calcEconomicStatus(recData);
      const conf = calcConfidence(recData);
      recData.cost_confidence = conf.cost;
      recData.price_confidence = conf.price;
      recData.fees_confidence = conf.fees;
      recData.final_economic_confidence = conf.final;
      recData.economic_classification = classifyEconomics(recData);

      if (existingRec) {
        // Registrar histórico apenas se o custo mudou
        const costChanged = Math.abs((existingRec.unit_cost || 0) - unit_cost) > 0.001;
        const priceChanged = Math.abs((existingRec.current_price || 0) - current_price) > 0.001;
        if ((costChanged || priceChanged) && !item._recalculate) {
          await base44.asServiceRole.entities.ProductEconomicsHistory.create({
            amazon_account_id,
            product_id: existingRec.product_id || null,
            asin: existingRec.asin || null,
            sku: item.sku,
            normalized_sku: nsku,
            unit_cost_before: existingRec.unit_cost || 0,
            unit_cost_after: unit_cost,
            additional_cost_before: (existingRec.inbound_freight_per_unit || 0) + (existingRec.logistics_cost_per_unit || 0),
            additional_cost_after: inbound + logistics,
            price_before: existingRec.current_price || 0,
            price_after: current_price,
            fee_before: existingRec.amazon_fee_amount || 0,
            fee_after: amazon_fee_amount,
            margin_before: existingRec.contribution_margin_percent || 0,
            margin_after: calc.contribution_margin_percent || 0,
            break_even_before: existingRec.break_even_acos || 0,
            break_even_after: calc.break_even_acos || 0,
            source: cost_source,
            reason: item.reason || `Atualização via importação - batch ${batchId}`,
            import_batch_id: batchId,
            effective_from: item.effective_from || today,
            changed_by: user.email || user.id,
            changed_at: now,
          }).catch(() => null);
          historyCreated++;
        }

        await base44.asServiceRole.entities.ProductEconomics.update(existingRec.id, recData);
        updated++;
        results.push({ sku: item.sku, nsku, action: 'updated', acos_break_even: calc.break_even_acos, target_acos: calc.target_acos, status: recData.economics_status });
      } else {
        recData.created_at = now;
        await base44.asServiceRole.entities.ProductEconomics.create(recData);
        created++;
        results.push({ sku: item.sku, nsku, action: 'created', acos_break_even: calc.break_even_acos, target_acos: calc.target_acos, status: recData.economics_status });
      }
    }

    return Response.json({
      ok: true,
      batch_id: batchId,
      processed: toProcess.length,
      created, updated, skipped, history_records: historyCreated,
      errors: errors.length,
      results,
      error_details: errors,
    });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
});