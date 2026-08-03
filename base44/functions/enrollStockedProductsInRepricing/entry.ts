import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";

const normalizedSku = (value: any) => String(value || "").trim().toUpperCase();
const positive = (value: any) => Number.isFinite(Number(value)) && Number(value) > 0;

/**
 * Inscreve produtos com estoque na gestão do repricing sem autorizar publicação.
 * repricing_requested é a intenção persistente; runAutomaticRepricing decide se a
 * execução pode ser habilitada após validar listing, preço, custos, taxas e margem.
 */
Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: "Não autorizado" }, { status: 401 });
    }

    const requestedSkus = new Set(
      (Array.isArray(body.skus) ? body.skus : []).map(normalizedSku).filter(Boolean),
    );
    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id })
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: "connected" });
    const results: any[] = [];

    for (const account of accounts as any[]) {
      const [products, economicsRows] = await Promise.all([
        base44.asServiceRole.entities.Product.filter(
          { amazon_account_id: account.id }, "-last_catalog_sync_at", 5000,
        ).catch(() => []),
        base44.asServiceRole.entities.ProductEconomics.filter(
          { amazon_account_id: account.id }, "-updated_at", 5000,
        ).catch(() => []),
      ]);
      const economicsBySku = new Map<string, any>();
      for (const row of economicsRows as any[]) {
        const key = normalizedSku(row.normalized_sku || row.sku);
        if (key && !economicsBySku.has(key)) economicsBySku.set(key, row);
      }

      let matched = 0, enrolled = 0, created = 0, skippedNoStock = 0, notFound = 0;
      const items: any[] = [];
      const seen = new Set<string>();
      for (const product of products as any[]) {
        const key = normalizedSku(product.sku);
        if (!key || seen.has(key) || (requestedSkus.size && !requestedSkus.has(key))) continue;
        seen.add(key);
        matched++;
        const stock = Number(product.available_quantity ?? product.fba_inventory ?? 0);
        if (!(stock > 0) || product.status === "archived") {
          skippedNoStock++;
          items.push({ sku: product.sku, status: "skipped_no_stock", stock });
          continue;
        }
        const current = economicsBySku.get(key);
        const price = Number(product.price ?? product.buy_box_price ?? 0);
        const incompleteReason = !positive(price)
          ? "Inscrito na gestão; execução bloqueada até a Amazon confirmar o preço atual."
          : product.listing_buyable !== true
          ? "Inscrito na gestão; execução bloqueada até a Amazon confirmar a oferta como comprável."
          : "Inscrito na gestão; execução depende da validação de custos, taxas, margem e preço mínimo.";
        if (current) {
          await base44.asServiceRole.entities.ProductEconomics.update(current.id, {
            product_id: product.id,
            asin: product.asin || current.asin,
            normalized_sku: key,
            product_name: product.display_name || product.product_name || current.product_name,
            ...(positive(price) && !positive(current.current_price) ? { current_price: price } : {}),
            repricing_requested: true,
            repricing_status: current.repricing_enabled === true ? current.repricing_status : "blocked",
            ...(current.repricing_enabled === true ? {} : { repricing_block_reason: incompleteReason }),
            updated_at: new Date().toISOString(),
          });
        } else {
          await base44.asServiceRole.entities.ProductEconomics.create({
            amazon_account_id: account.id,
            marketplace_id: account.marketplace_id,
            product_id: product.id,
            asin: product.asin,
            sku: product.sku,
            normalized_sku: key,
            product_name: product.display_name || product.product_name || product.sku,
            current_price: positive(price) ? price : 0,
            repricing_requested: true,
            repricing_enabled: false,
            repricing_status: "blocked",
            repricing_block_reason: incompleteReason,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
          created++;
        }
        enrolled++;
        items.push({ sku: product.sku, asin: product.asin, stock, price: positive(price) ? price : null, status: "managed" });
      }
      if (requestedSkus.size) notFound = [...requestedSkus].filter((sku) => !seen.has(sku)).length;
      results.push({ account_id: account.id, requested: requestedSkus.size || null, matched, enrolled, created, skipped_no_stock: skippedNoStock, not_found: notFound, items });
    }
    return Response.json({ ok: true, results });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || "Falha ao inscrever produtos no repricing" }, { status: 500 });
  }
});
