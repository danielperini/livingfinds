import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { extractAmazonAsin, zyteExtract } from "../../shared/zyteApi.ts";

const nowIso = () => new Date().toISOString();
const finite = (value: unknown) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
const numberValue = (value: unknown, fallback = 0) => finite(value) ? Number(value) : fallback;
const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const normalizeSku = (value: unknown) => String(value || "").trim().toUpperCase().replace(/\s+/g, "-").replace(/-{2,}/g, "-");

function tokens(value: unknown) {
  return new Set(String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/)
    .filter((token) => token.length > 2));
}

const FAMILIES = ["lixeira", "moedor", "headset", "interruptor", "fechadura", "abridor", "microfone", "ventilador", "organizador", "ferramentas", "fone"];
const ATTRIBUTES = new Set(["automatico", "automatica", "sensor", "eletrico", "eletrica", "wifi", "touch", "usb", "portatil", "digital", "biometrica", "recarregavel", "inteligente", "gamer", "preto", "preta", "branco", "branca", "cinza", "vermelho", "vermelha", "azul", "rosa"]);
const COLORS = ["preto", "preta", "branco", "branca", "cinza", "vermelho", "vermelha", "azul", "verde", "rosa", "bege", "prata"];

function searchQueries(title: unknown) {
  const all = [...tokens(title)];
  const family = FAMILIES.find((item) => all.includes(item)) || all[0];
  const attrs = all.filter((item) => item !== family && (ATTRIBUTES.has(item) || /\d/.test(item)));
  const descriptive = all.filter((item) => item !== family && !attrs.includes(item));
  return [...new Set([
    [family, ...attrs.slice(0, 3), ...descriptive.slice(0, 1)].filter(Boolean).join(" "),
    [family, ...descriptive.slice(0, 2)].filter(Boolean).join(" "),
  ].filter((query) => query.split(/\s+/).length >= 2))].slice(0, 2);
}

function signature(value: unknown) {
  const normalized = String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/,/g, ".").replace(/[^a-z0-9.]+/g, " ").trim();
  const parts = normalized.split(/\s+/).filter(Boolean);
  const colors = COLORS.filter((color) => parts.includes(color));
  const models = parts.filter((part) => part.length >= 3 && /[a-z]/.test(part) && /\d/.test(part) && !/^\d+(?:\.\d+)?(?:ml|cm|mm|kg|gb|w|v|l)$/.test(part));
  const sizes = [...normalized.matchAll(/\b\d+(?:\.\d+)?\s*(?:ml|litros?|l|cm|mm|metros?|m|kg|gramas?|g|polegadas?|pol|botoes?|vias?|pecas?|unidades?)\b/g)].map((match) => match[0].replace(/\s+/g, ""));
  return { colors: [...new Set(colors)], models: [...new Set(models)], sizes: [...new Set(sizes)] };
}

function compatible(sourceTitle: unknown, candidateTitle: unknown) {
  const source = signature(sourceTitle);
  const candidate = signature(candidateTitle);
  const overlaps = (left: string[], right: string[]) => left.some((value) => right.includes(value));
  if (source.models.length && candidate.models.length && !overlaps(source.models, candidate.models)) return false;
  if (source.colors.length && candidate.colors.length && !overlaps(source.colors, candidate.colors)) return false;
  if (source.sizes.length && candidate.sizes.length && !overlaps(source.sizes, candidate.sizes)) return false;
  return true;
}

function similarity(sourceTitle: unknown, candidateTitle: unknown) {
  const source = tokens(sourceTitle);
  const candidate = tokens(candidateTitle);
  if (!source.size || !candidate.size) return 0;
  const shared = [...source].filter((token) => candidate.has(token)).length;
  if (shared < 2) return 0;
  const coverage = shared / Math.max(1, Math.min(source.size, candidate.size));
  return Math.min(0.99, 0.82 + Math.min(0.12, shared * 0.05) + Math.min(0.05, coverage * 0.05));
}

function marketDomain(account: any) {
  if (account.marketplace_id === "ATVPDKIKX0DER") return "www.amazon.com";
  if (String(account.country_code || "").toUpperCase() === "MX") return "www.amazon.com.mx";
  return "www.amazon.com.br";
}

async function research(base44: any, account: any, product: any) {
  const title = product.display_name || product.product_name || product.title || "";
  const queries = searchQueries(title);
  const checkedAt = nowIso();
  if (!product.asin || !queries.length) return { count: 0, matches: [], checkedAt, error: "Título ou ASIN insuficiente para pesquisa." };

  const domain = marketDomain(account);
  const found: any[] = [];
  const errors: string[] = [];
  for (const query of queries) {
    const url = new URL(`https://${domain}/s`);
    url.searchParams.set("k", query);
    try {
      const response = await zyteExtract({
        base44,
        amazonAccountId: account.id,
        operation: "repricing_competitor_search_v2",
        url: url.toString(),
        output: "productList",
        extractFrom: "browserHtml",
        cacheTtlMs: 6 * 60 * 60 * 1000,
        tags: { marketplace_id: account.marketplace_id || "unknown", asin: product.asin },
      });
      const products = Array.isArray(response.data?.productList?.products) ? response.data.productList.products : [];
      found.push(...products.map((item: any, index: number) => ({ ...item, asin: extractAmazonAsin(item?.url), position: index + 1, cache_hit: response.cacheHit })));
      if (!products.length) errors.push(`${query}: resposta sem produtos`);
    } catch (error: any) {
      errors.push(`${query}: ${String(error?.code || error?.message || "falha Zyte").slice(0, 160)}`);
    }
  }

  const unique = [...new Map(found.filter((item) => item.asin).map((item) => [item.asin, item])).values()];
  const matches = unique.map((item: any) => {
    const candidateTitle = String(item.name || "");
    return {
      asin: item.asin,
      title: candidateTitle,
      brand: item.brand?.name || null,
      similarity: similarity(title, candidateTitle),
      averagePrice: numberValue(item.price || item.regularPrice, 0),
      currency: item.currency || "BRL",
      amazonUrl: item.url || `https://${domain}/dp/${item.asin}`,
      organic_position: numberValue(item.position, 0) || null,
      sponsored: false,
      extraction_probability: finite(item.metadata?.probability) ? Number(item.metadata.probability) : null,
      cache_hit: item.cache_hit === true,
      data_source: "zyte_amazon_product_list",
      variant_compatible: compatible(title, candidateTitle),
    };
  }).filter((item: any) => item.asin !== product.asin && item.averagePrice > 0 && item.similarity >= 0.90 && item.variant_compatible)
    .sort((a: any, b: any) => b.similarity - a.similarity || numberValue(a.organic_position, 999) - numberValue(b.organic_position, 999))
    .slice(0, 10);

  const prices = matches.map((item: any) => item.averagePrice).filter((value: number) => value > 0);
  return {
    count: matches.length,
    matches,
    average: prices.length ? roundMoney(prices.reduce((sum: number, value: number) => sum + value, 0) / prices.length) : null,
    minimum: prices.length ? Math.min(...prices) : null,
    maximum: prices.length ? Math.max(...prices) : null,
    checkedAt,
    queries,
    error: matches.length ? null : (errors.join(" | ").slice(0, 500) || "Nenhum concorrente equivalente com preço válido."),
  };
}

Deno.serve(async (req) => {
  const startedAt = nowIso();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: "Não autorizado" }, { status: 401 });
    }

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, undefined, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: "connected" }, undefined, 100);
    const maxProducts = Math.max(1, Math.min(numberValue(body.max_products, 20), 100));
    const results: any[] = [];

    for (const account of accounts) {
      const [products, economicsRows] = await Promise.all([
        base44.asServiceRole.entities.Product.filter({ amazon_account_id: account.id }, "-updated_date", 5000).catch(() => []),
        base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: account.id }, "-updated_at", 5000).catch(() => []),
      ]);
      const economicsBySku = new Map<string, any>();
      for (const row of economicsRows) {
        const key = normalizeSku(row.sku);
        if (key && !economicsBySku.has(key)) economicsBySku.set(key, row);
      }
      const eligible = products.filter((product: any) => product.status === "active" && numberValue(product.available_quantity ?? product.fba_inventory, 0) > 0 && product.sku && product.asin && economicsBySku.has(normalizeSku(product.sku)))
        .slice(0, maxProducts);

      let populated = 0;
      let failed = 0;
      const items: any[] = [];
      for (const product of eligible) {
        const economics = economicsBySku.get(normalizeSku(product.sku));
        const outcome = await research(base44, account, product);
        const previous = economics.decision_evidence || {};
        await base44.asServiceRole.entities.ProductEconomics.update(economics.id, {
          decision_evidence: {
            ...previous,
            similar_competitor_price_average: outcome.average ?? null,
            similar_competitor_price_minimum: outcome.minimum ?? null,
            similar_competitor_price_maximum: outcome.maximum ?? null,
            similar_competitor_product_count: outcome.count,
            similar_competitor_products: outcome.matches,
            similar_competition_checked_at: outcome.checkedAt,
            similar_competition_source: "zyte_amazon_product_list_real",
            similar_competition_search_queries: outcome.queries || [],
            similar_competition_error: outcome.error || null,
            similar_competition_ai_assisted: false,
            similar_competition_canonical_title: product.display_name || product.product_name || product.title || null,
            similar_competition_threshold: 0.90,
            similar_competition_algorithm_version: 7,
          },
          updated_at: nowIso(),
        });
        if (outcome.count > 0) populated += 1; else failed += 1;
        items.push({ sku: product.sku, asin: product.asin, competitors: outcome.count, average: outcome.average, error: outcome.error });
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      results.push({ account_id: account.id, eligible: eligible.length, populated, failed, items });
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: account.id,
        operation: "refreshZyteCompetitorResearch",
        status: failed === eligible.length && eligible.length > 0 ? "warning" : "success",
        trigger_type: body._service_role ? "automatic" : "manual",
        started_at: startedAt,
        completed_at: nowIso(),
        records_processed: eligible.length,
        records_imported: populated,
        response_summary: JSON.stringify({ eligible: eligible.length, populated, failed }).slice(0, 1000),
      }).catch(() => {});
    }
    return Response.json({ ok: true, provider: "zyte", real_data_only: true, results });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error), provider: "zyte" }, { status: Number(error?.status || 500) });
  }
});
