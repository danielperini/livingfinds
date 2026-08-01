/**
 * Persiste somente custos e limites informados pelo usuário.
 * Dados Amazon (preço, tarifas, estoque e vendas) são preservados e atualizados
 * exclusivamente pelos sincronizadores SP-API e pelo motor de repricing.
 */
import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import {
  economicsAtPrice,
  normalizeSku,
  resolveMargins,
  validateRepricingEconomics,
} from "../../shared/repricingPolicy.ts";

const SAFETY_FACTOR = 0.80;
const FALLBACK_CVR = 0.05;

function finite(value: unknown): value is number {
  return value !== null && value !== undefined && value !== "" &&
    Number.isFinite(Number(value));
}

function valueOrExisting(value: unknown, existing: unknown, fallback = 0) {
  if (finite(value)) return Number(value);
  if (finite(existing)) return Number(existing);
  return fallback;
}

function optionalPositiveValue(item: any, key: string, existing: unknown) {
  if (!Object.prototype.hasOwnProperty.call(item, key)) {
    return finite(existing) && Number(existing) > 0 ? Number(existing) : null;
  }
  return finite(item[key]) && Number(item[key]) > 0 ? Number(item[key]) : null;
}

function invalidNonNegativeFields(item: any) {
  const fields: Array<[string, string]> = [
    ["unit_cost", "Custo unitário"],
    ["inbound_freight_per_unit", "Frete de entrada"],
    ["tax_per_unit", "Impostos adicionais"],
    ["logistics_cost_per_unit", "Logística"],
    ["packaging_cost_per_unit", "Embalagem"],
    ["other_variable_cost_per_unit", "Outros custos"],
    ["estimated_return_cost", "Custo estimado de devolução"],
    ["manual_min_price", "Preço mínimo manual"],
    ["manual_max_price", "Preço máximo manual"],
  ];
  return fields
    .filter(([key]) =>
      item[key] !== null && item[key] !== undefined && item[key] !== "" &&
      (!finite(item[key]) || Number(item[key]) < 0)
    )
    .map(([, label]) => `${label} deve ser maior ou igual a zero.`);
}

function legacyAdsEconomics(rec: any, conversionRate: number) {
  const price = Number(rec.current_price || 0);
  const referralPct = Number(rec.amazon_fee_percent || 0);
  const referralAmount = price > 0 && referralPct >= 0
    ? price * referralPct / 100
    : Number(rec.amazon_fee_amount || 0);
  const costsBeforeAds = Number(rec.unit_cost || 0) +
    Number(rec.inbound_freight_per_unit || 0) +
    Number(rec.tax_per_unit || 0) +
    Number(rec.logistics_cost_per_unit || 0) +
    Number(rec.packaging_cost_per_unit || 0) +
    Number(rec.other_variable_cost_per_unit || 0) +
    Number(rec.fba_fee || 0) +
    Number(rec.amazon_fixed_fee || 0) +
    Number(rec.estimated_return_cost || 0) +
    referralAmount;
  if (price <= 0) return {};
  const contribution = price - costsBeforeAds;
  const contributionPct = contribution / price * 100;
  const targetAcos = Math.max(0, contributionPct * SAFETY_FACTOR);
  const cvr = conversionRate > 0 ? conversionRate : FALLBACK_CVR;
  return {
    total_variable_cost_per_unit: Math.round(costsBeforeAds * 100) / 100,
    contribution_margin_amount: Math.round(contribution * 100) / 100,
    contribution_margin_percent: Math.round(contributionPct * 100) / 100,
    break_even_acos: Math.round(contributionPct * 100) / 100,
    target_acos: Math.round(targetAcos * 100) / 100,
    target_roas: targetAcos > 0 ? Math.round(100 / targetAcos * 100) / 100 : 0,
    safe_max_cpc: Math.round(price * cvr * targetAcos / 100 * 100) / 100,
  };
}

function policyInputs(rec: any) {
  return {
    unitProductCost: finite(rec.unit_cost) ? Number(rec.unit_cost) : null,
    inboundFreight: Number(rec.inbound_freight_per_unit || 0),
    packagingCost: Number(rec.packaging_cost_per_unit || 0),
    additionalTax: Number(rec.tax_per_unit || 0),
    otherCost: Number(rec.logistics_cost_per_unit || 0) +
      Number(rec.other_variable_cost_per_unit || 0),
    fbaFee: finite(rec.fba_fee) ? Number(rec.fba_fee) : null,
    fixedAmazonFee: finite(rec.amazon_fixed_fee)
      ? Number(rec.amazon_fixed_fee)
      : null,
    estimatedReturnCost: Number(rec.estimated_return_cost || 0),
    adsCostPerOrder: finite(rec.estimated_ads_cost_per_order)
      ? Number(rec.estimated_ads_cost_per_order)
      : null,
    referralFeePct: finite(rec.amazon_fee_percent)
      ? Number(rec.amazon_fee_percent)
      : null,
    costsConfirmed: rec.costs_confirmed_by_user === true,
    feesConfirmed: Boolean(
      rec.fees_verified_at &&
        String(rec.fees_source || "").startsWith("sp_api"),
    ),
    adsCostConfirmed: Boolean(
      rec.ads_cost_verified_at && rec.ads_cost_source &&
        rec.ads_cost_source !== "missing",
    ),
    minimumMarginPct: rec.minimum_margin_pct,
    targetMarginPct: rec.target_margin_pct,
    manualMinPrice: rec.manual_min_price,
    manualMaxPrice: rec.manual_max_price,
  };
}

function economicsStatus(rec: any, complete: boolean) {
  if (
    rec.costs_confirmed_by_user !== true || !finite(rec.unit_cost) ||
    Number(rec.unit_cost) < 0
  ) return "missing_cost";
  if (
    !rec.current_price || rec.current_price <= 0 ||
    !String(rec.price_source || "").startsWith("sp_api")
  ) return "missing_price";
  if (
    !rec.fees_verified_at || !String(rec.fees_source || "").startsWith("sp_api")
  ) return "missing_fees";
  return complete ? "complete" : "partial";
}

Deno.serve(async (req) => {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const base44 = createClientFromRequest(req);

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const {
      amazon_account_id,
      items,
      recalculate_only,
      file_url,
      enable_repricing_for_active,
      run_decision_engine,
      refresh_amazon_status,
    } = body;
    if (!amazon_account_id) {
      return Response.json({ error: "amazon_account_id obrigatório" }, {
        status: 400,
      });
    }

    const batchId = `batch_${Date.now()}_${
      Math.random().toString(36).slice(2, 8)
    }`;
    let created = 0;
    let updated = 0;
    let historyCreated = 0;
    let activeUpdated = 0;
    let inactiveUpdated = 0;
    let unmatched = 0;
    const errors: any[] = [];
    const results: any[] = [];
    let amazonStatusSync: any = null;
    if (file_url && refresh_amazon_status === true) {
      const syncResponse = await base44.asServiceRole.functions.invoke(
        "syncProductCatalogV2",
        {
          amazon_account_id,
          trigger_type: "repricing_cost_import",
          _service_role: true,
        },
      ).catch((syncError: any) => ({
        data: { ok: false, error: syncError?.message || String(syncError) },
      }));
      amazonStatusSync = syncResponse?.data || syncResponse || {};
      if (amazonStatusSync.ok !== true) {
        return Response.json({
          ok: false,
          error:
            "Não foi possível atualizar ativos/inativos pela Amazon SP-API. Nenhum custo foi importado.",
          amazon_status_sync: amazonStatusSync,
        }, { status: 503 });
      }
    }
    const existing = await base44.asServiceRole.entities.ProductEconomics
      .filter({ amazon_account_id }, undefined, 5000);
    const existingBySku = new Map(
      existing.map((record: any) => [normalizeSku(record.sku), record]),
    );
    const products = await base44.asServiceRole.entities.Product.filter(
      { amazon_account_id },
      undefined,
      5000,
    );
    const productBySku = new Map(
      products.map((product: any) => [normalizeSku(product.sku), product]),
    );
    let spreadsheetItems: any[] | null = null;
    if (file_url) {
      const extraction = await base44.asServiceRole.integrations.Core
        .ExtractDataFromUploadedFile({
          file_url,
          json_schema: {
            type: "object",
            properties: {
              rows: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    "SKU Interno": { type: "string" },
                    "SKU externo (opcional)": { type: "string" },
                    "Título": { type: "string" },
                    "Preço de Custo": { type: "number" },
                    "Custo Extra (opcional)": { type: "number" },
                  },
                },
              },
            },
          },
        });
      if (extraction.status !== "success" || !extraction.output?.rows) {
        return Response.json({
          ok: false,
          error: "Não foi possível extrair linhas válidas da planilha de custos.",
          details: extraction.details || null,
        }, { status: 400 });
      }
      spreadsheetItems = extraction.output.rows.map((row: any) => ({
        sku: row["SKU Interno"] || row["SKU externo (opcional)"] || "",
        product_name: row["Título"] || "",
        unit_cost: row["Preço de Custo"],
        other_variable_cost_per_unit: row["Custo Extra (opcional)"] ?? 0,
        repricing_enabled: enable_repricing_for_active === true,
        reason: "Custo confirmado por planilha enviada pelo usuário.",
      }));
    }
    const toProcess = recalculate_only
      ? existing.map((record: any) => ({ ...record, _recalculate: true }))
      : Array.isArray(spreadsheetItems)
      ? spreadsheetItems
      : Array.isArray(items)
      ? items
      : [];

    for (const item of toProcess) {
      const normalizedSku = normalizeSku(item.sku);
      if (!normalizedSku) {
        errors.push({ sku: item.sku, error: "SKU vazio após normalização." });
        continue;
      }
      const validationErrors = item._recalculate
        ? []
        : invalidNonNegativeFields(item);
      if (
        !item._recalculate &&
        !Object.prototype.hasOwnProperty.call(item, "unit_cost")
      ) {
        validationErrors.push(
          "Custo unitário deve ser informado explicitamente; o sistema não inventa custos.",
        );
      }
      if (validationErrors.length) {
        errors.push({ sku: item.sku, error: validationErrors.join(" ") });
        continue;
      }

      const previous: any = existingBySku.get(normalizedSku) || null;
      const product: any = productBySku.get(normalizedSku) || null;
      if (file_url && !product) {
        unmatched += 1;
        errors.push({
          sku: item.sku,
          error: "SKU não encontrado no catálogo Product desta conta; custo não aplicado.",
        });
        continue;
      }
      const productStatus = String(product?.status || "").toLowerCase();
      const productStock = Number(
        product?.available_quantity ?? product?.fba_inventory ?? 0,
      );
      const catalogAgeHours = product?.last_catalog_sync_at
        ? (Date.now() - new Date(product.last_catalog_sync_at).getTime()) /
          3600000
        : Number.POSITIVE_INFINITY;
      const productActive = ["active", "enabled"].includes(productStatus) &&
        productStock > 0 && product?.inventory_status !== "out_of_stock" &&
        product?.catalog_sync_status === "success" && catalogAgeHours <= 2;
      if (file_url && enable_repricing_for_active === true) {
        item.repricing_enabled = productActive;
      }
      const margins = resolveMargins(
        item.minimum_margin_pct ?? previous?.minimum_margin_pct,
        item.target_margin_pct ?? previous?.target_margin_pct,
      );
      if (
        finite(item.minimum_margin_pct) && Number(item.minimum_margin_pct) < 15
      ) {
        errors.push({
          sku: item.sku,
          error: "Margem mínima nunca pode ser inferior a 15%.",
        });
        continue;
      }
      if (
        finite(item.target_margin_pct) &&
        Number(item.target_margin_pct) < margins.minimumMarginPct
      ) {
        errors.push({
          sku: item.sku,
          error: "Margem-alvo nunca pode ser inferior à margem mínima.",
        });
        continue;
      }

      const record: any = {
        ...(previous || {}),
        amazon_account_id,
        marketplace_id: previous?.marketplace_id || product?.marketplace_id ||
          null,
        product_id: product?.id || previous?.product_id || null,
        asin: product?.asin || previous?.asin || null,
        sku: item.sku || previous?.sku,
        normalized_sku: normalizedSku,
        product_name: item.product_name || previous?.product_name ||
          product?.display_name || product?.product_name || item.sku,
        unit_cost: item._recalculate
          ? Number(previous?.unit_cost || 0)
          : Number(item.unit_cost),
        inbound_freight_per_unit: valueOrExisting(
          item.inbound_freight_per_unit,
          previous?.inbound_freight_per_unit,
        ),
        tax_per_unit: valueOrExisting(
          item.tax_per_unit,
          previous?.tax_per_unit,
        ),
        logistics_cost_per_unit: valueOrExisting(
          item.logistics_cost_per_unit,
          previous?.logistics_cost_per_unit,
        ),
        packaging_cost_per_unit: valueOrExisting(
          item.packaging_cost_per_unit,
          previous?.packaging_cost_per_unit,
        ),
        other_variable_cost_per_unit: valueOrExisting(
          item.other_variable_cost_per_unit,
          previous?.other_variable_cost_per_unit,
        ),
        estimated_return_cost: valueOrExisting(
          item.estimated_return_cost,
          previous?.estimated_return_cost,
        ),
        other_cost_description: item.other_cost_description ??
          previous?.other_cost_description ?? null,
        minimum_margin_pct: margins.minimumMarginPct,
        target_margin_pct: margins.targetMarginPct,
        manual_min_price: optionalPositiveValue(
          item,
          "manual_min_price",
          previous?.manual_min_price,
        ),
        manual_max_price: optionalPositiveValue(
          item,
          "manual_max_price",
          previous?.manual_max_price,
        ),
        costs_confirmed_by_user: item._recalculate
          ? previous?.costs_confirmed_by_user === true
          : true,
        cost_source: item._recalculate
          ? previous?.cost_source || "unknown"
          : "manual_confirmed",
        current_price: previous?.current_price || product?.price || 0,
        price_source: previous?.price_source ||
          (product?.price > 0 ? "sp_api_product_sync" : "unknown"),
        product_link_status: product?.asin ? "linked" : "pending",
        import_batch_id: batchId,
        imported_by: user.email || user.id,
        imported_at: now,
        effective_from: item.effective_from || today,
        updated_by: user.email || user.id,
        updated_at: now,
        last_calculated_at: now,
      };

      const policy = policyInputs(record);
      const repricingValidation = validateRepricingEconomics(policy);
      const current = economicsAtPrice(
        Number(record.current_price || 0),
        policy,
      );
      const invalidManualLimit = repricingValidation.reasons.find((reason) =>
        reason.includes("manual inferior ao piso rentável") ||
        reason.includes("mínimo manual superior ao preço máximo manual")
      );
      if (!item._recalculate && invalidManualLimit) {
        errors.push({ sku: item.sku, error: invalidManualLimit });
        continue;
      }
      const requestedEnabled = item._recalculate
        ? previous?.repricing_requested === true ||
          previous?.repricing_enabled === true
        : item.repricing_enabled === undefined
        ? previous?.repricing_requested === true ||
          previous?.repricing_enabled === true
        : item.repricing_enabled === true;
      record.economic_data_complete = repricingValidation.complete &&
        Boolean(current);
      record.economic_data_updated_at = now;
      record.minimum_profitable_price =
        repricingValidation.minimumProfitablePrice;
      record.target_margin_price = repricingValidation.targetMarginPrice;
      record.current_margin_pct = current?.marginPct ?? null;
      record.projected_margin_pct = current?.marginPct ?? null;
      record.projected_unit_profit = current?.unitProfit ?? null;
      record.repricing_requested = requestedEnabled;
      record.repricing_enabled = requestedEnabled &&
        record.economic_data_complete;
      record.repricing_status = record.repricing_enabled
        ? "eligible"
        : requestedEnabled
        ? "blocked"
        : "disabled";
      record.repricing_block_reason =
        requestedEnabled && !record.economic_data_complete
          ? repricingValidation.reasons.join(" ")
          : null;
      Object.assign(
        record,
        legacyAdsEconomics(record, Number(product?.conversion_rate_30d || 0)),
      );
      record.economics_status = economicsStatus(
        record,
        record.economic_data_complete,
      );
      record.cost_confidence = 1;
      record.price_confidence =
        String(record.price_source || "").startsWith("sp_api") ? 0.95 : 0;
      record.fees_confidence =
        String(record.fees_source || "").startsWith("sp_api") ? 0.95 : 0;
      record.final_economic_confidence = Math.round(
        (record.cost_confidence * 0.4 + record.price_confidence * 0.3 +
          record.fees_confidence * 0.3) * 100,
      ) / 100;

      const changed = !previous || [
        "unit_cost",
        "inbound_freight_per_unit",
        "tax_per_unit",
        "logistics_cost_per_unit",
        "packaging_cost_per_unit",
        "other_variable_cost_per_unit",
        "estimated_return_cost",
        "minimum_margin_pct",
        "target_margin_pct",
        "manual_min_price",
        "manual_max_price",
        "repricing_enabled",
      ].some((field) =>
        String(previous?.[field] ?? "") !== String(record[field] ?? "")
      );

      let saved: any;
      if (previous) {
        const {
          id: _id,
          created_date: _createdDate,
          updated_date: _updatedDate,
          created_by: _createdBy,
          created_by_id: _createdById,
          is_sample: _isSample,
          ...update
        } = record;
        saved = await base44.asServiceRole.entities.ProductEconomics.update(
          previous.id,
          update,
        );
        updated += 1;
      } else {
        record.created_at = now;
        saved = await base44.asServiceRole.entities.ProductEconomics.create(
          record,
        );
        created += 1;
      }
      existingBySku.set(
        normalizedSku,
        saved || { ...record, id: previous?.id },
      );
      if (productActive) activeUpdated += 1;
      else inactiveUpdated += 1;

      if (changed && !item._recalculate) {
        await base44.asServiceRole.entities.ProductEconomicsHistory.create({
          amazon_account_id,
          product_id: product?.id || previous?.product_id || null,
          asin: product?.asin || previous?.asin || null,
          sku: item.sku,
          normalized_sku: normalizedSku,
          history_type: "cost_change",
          unit_cost_before: previous?.unit_cost ?? null,
          unit_cost_after: record.unit_cost,
          additional_cost_before: previous
            ? Number(previous.inbound_freight_per_unit || 0) +
              Number(previous.tax_per_unit || 0) +
              Number(previous.logistics_cost_per_unit || 0) +
              Number(previous.packaging_cost_per_unit || 0) +
              Number(previous.other_variable_cost_per_unit || 0)
            : 0,
          additional_cost_after: Number(record.inbound_freight_per_unit || 0) +
            Number(record.tax_per_unit || 0) +
            Number(record.logistics_cost_per_unit || 0) +
            Number(record.packaging_cost_per_unit || 0) +
            Number(record.other_variable_cost_per_unit || 0),
          price_before: previous?.current_price ?? null,
          price_after: record.current_price || null,
          margin_before: previous?.current_margin_pct ?? null,
          margin_after: record.current_margin_pct,
          minimum_profitable_price: record.minimum_profitable_price,
          target_margin_price: record.target_margin_price,
          source: "manual_confirmed",
          reason: item.reason ||
            "Edição manual dos custos e limites econômicos.",
          decision_evidence: {
            fields_changed: changed,
            repricing_requested: requestedEnabled,
            repricing_enabled: record.repricing_enabled,
            block_reason: record.repricing_block_reason,
          },
          import_batch_id: batchId,
          effective_from: item.effective_from || today,
          changed_by: user.email || user.id,
          changed_at: now,
          status: "confirmed",
        }).catch(() => null);
        historyCreated += 1;
      }

      if (product?.id && !item._recalculate) {
        const additional = Number(record.inbound_freight_per_unit || 0) +
          Number(record.tax_per_unit || 0) +
          Number(record.logistics_cost_per_unit || 0) +
          Number(record.packaging_cost_per_unit || 0) +
          Number(record.other_variable_cost_per_unit || 0) +
          Number(record.estimated_return_cost || 0);
        await base44.asServiceRole.entities.Product.update(product.id, {
          product_cost: record.unit_cost,
          extra_cost: Math.round(additional * 100) / 100,
          cost_confirmed: true,
          cost_confirmation_required: false,
          cost_source: "manual",
          cost_confirmed_at: now,
          cost_confirmed_by: user.email || user.id,
        }).catch(() => {});
      }

      results.push({
        sku: item.sku,
        action: previous ? "updated" : "created",
        product_status: productStatus || "unknown",
        stock: productStock,
        active_for_repricing: productActive,
        status_source: "amazon_sp_api_fba_inventory",
        status_checked_at: product?.last_catalog_sync_at || null,
        economics_status: record.economics_status,
        repricing_enabled: record.repricing_enabled,
        repricing_block_reason: record.repricing_block_reason,
        minimum_profitable_price: record.minimum_profitable_price,
        target_margin_price: record.target_margin_price,
      });
    }

    let decisionEngine: any = null;
    if (run_decision_engine === true && created + updated > 0) {
      const engineResponse = await base44.asServiceRole.functions.invoke(
        "runUnifiedDecisionEngine",
        {
          amazon_account_id,
          source_function: "importProductEconomics:spreadsheet",
          full_repricing_evaluation: true,
          _service_role: true,
        },
      ).catch((engineError: any) => ({
        data: { ok: false, error: engineError?.message || String(engineError) },
      }));
      decisionEngine = engineResponse?.data || engineResponse || null;
    }

    return Response.json({
      ok: true,
      batch_id: batchId,
      processed: toProcess.length,
      created,
      updated,
      history_records: historyCreated,
      active_updated: activeUpdated,
      inactive_updated: inactiveUpdated,
      unmatched,
      errors: errors.length,
      results,
      error_details: errors,
      decision_engine: decisionEngine,
      amazon_status_sync: amazonStatusSync,
    });
  } catch (error: any) {
    return Response.json({
      ok: false,
      error: error?.message || "Falha ao salvar dados econômicos.",
    }, { status: 500 });
  }
});
