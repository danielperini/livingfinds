import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import {
  decodeZyteHttpBody,
  extractAmazonAsin,
  ZyteApiError,
  zyteExtract,
} from "../../shared/zyteApi.ts";

const DOMAIN_BY_MARKETPLACE: Record<string, string> = {
  BR: "www.amazon.com.br",
  US: "www.amazon.com",
  MX: "www.amazon.com.mx",
};

const AUTOCOMPLETE_DOMAIN_BY_MARKETPLACE: Record<string, string> = {
  BR: "completion.amazon.com.br",
  US: "completion.amazon.com",
  MX: "completion.amazon.com.mx",
};

function uniqueText(values: unknown[], limit = 30) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = String(value || "").replace(/\s+/g, " ").trim();
    const key = normalized.toLocaleLowerCase("pt-BR");
    if (normalized.length < 3 || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function productTerms(product: any) {
  const properties = Array.isArray(product?.additionalProperties)
    ? product.additionalProperties.flatMap((
      item: any,
    ) => [item?.name, item?.value])
    : [];
  return uniqueText([
    ...(product?.breadcrumbs || []).map((item: any) => item?.name),
    ...(product?.features || []),
    product?.color,
    product?.size,
    product?.style,
    ...properties,
  ], 30);
}

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    const body = await req.json().catch(() => ({}));
    if (!user && !body?._service_role) {
      return Response.json({ ok: false, error: "Não autorizado." }, {
        status: 401,
      });
    }

    const keyword = String(body?.keyword || "").replace(/\s+/g, " ").trim();
    const asin = String(body?.asin || "").trim().toUpperCase();
    const marketplace = String(body?.marketplace || "BR").trim().toUpperCase();
    const amazonAccountId = String(
      body?.amazon_account_id || "external-research",
    );
    if (keyword.length < 2 || keyword.length > 200) {
      return Response.json({
        ok: false,
        error: "keyword é obrigatória e deve ter entre 2 e 200 caracteres.",
      }, { status: 400 });
    }
    if (asin && !/^[A-Z0-9]{10}$/.test(asin)) {
      return Response.json({ ok: false, error: "ASIN inválido." }, {
        status: 400,
      });
    }
    const domain = DOMAIN_BY_MARKETPLACE[marketplace];
    const autocompleteDomain = AUTOCOMPLETE_DOMAIN_BY_MARKETPLACE[marketplace];
    if (!domain || !autocompleteDomain) {
      return Response.json({
        ok: false,
        error: "Marketplace não suportado. Use BR, US ou MX.",
      }, { status: 400 });
    }

    const diagnostics: Array<Record<string, unknown>> = [];
    let suggestions: string[] = [];
    let organicTitles: string[] = [];
    let productKeywords: string[] = [];

    const autocompleteUrl = new URL(
      `https://${autocompleteDomain}/search/complete`,
    );
    autocompleteUrl.searchParams.set("q", keyword);
    autocompleteUrl.searchParams.set("search-alias", "aps");
    autocompleteUrl.searchParams.set("client", "amzn-search-suggestions");
    try {
      const result = await zyteExtract({
        base44,
        amazonAccountId,
        operation: "keyword_autocomplete",
        url: autocompleteUrl.toString(),
        output: "httpResponseBody",
        cacheTtlMs: 24 * 60 * 60 * 1000,
        tags: { marketplace },
      });
      const parsed = JSON.parse(
        decodeZyteHttpBody(result.data?.httpResponseBody) || "null",
      );
      suggestions = uniqueText(Array.isArray(parsed?.[1]) ? parsed[1] : [], 20);
      diagnostics.push({
        source: "autocomplete",
        ok: true,
        cache_hit: result.cacheHit,
        total: suggestions.length,
      });
    } catch (error: any) {
      diagnostics.push({
        source: "autocomplete",
        ok: false,
        code: error?.code,
        error: String(error?.message || error).slice(0, 300),
      });
    }

    const searchUrl = new URL(`https://${domain}/s`);
    searchUrl.searchParams.set("k", keyword);
    try {
      const result = await zyteExtract({
        base44,
        amazonAccountId,
        operation: "keyword_product_list",
        url: searchUrl.toString(),
        output: "productList",
        cacheTtlMs: 24 * 60 * 60 * 1000,
        extractFrom: "browserHtml",
        tags: { marketplace },
      });
      const products = Array.isArray(result.data?.productList?.products)
        ? result.data.productList.products
        : [];
      organicTitles = uniqueText(products.map((item: any) => item?.name), 20);
      diagnostics.push({
        source: "amazon_search",
        ok: true,
        cache_hit: result.cacheHit,
        total: organicTitles.length,
      });
    } catch (error: any) {
      diagnostics.push({
        source: "amazon_search",
        ok: false,
        code: error?.code,
        error: String(error?.message || error).slice(0, 300),
      });
    }

    if (asin) {
      try {
        const result = await zyteExtract({
          base44,
          amazonAccountId,
          operation: "keyword_product_detail",
          url: `https://${domain}/dp/${asin}`,
          output: "product",
          cacheTtlMs: 48 * 60 * 60 * 1000,
          extractFrom: "browserHtml",
          tags: { marketplace, asin },
        });
        const extractedAsin = extractAmazonAsin(
          result.data?.product?.canonicalUrl || result.data?.product?.url,
        );
        if (extractedAsin && extractedAsin !== asin) {
          throw new Error(`A Zyte retornou outro ASIN (${extractedAsin}).`);
        }
        productKeywords = productTerms(result.data?.product || {});
        diagnostics.push({
          source: "asin_page",
          ok: true,
          cache_hit: result.cacheHit,
          total: productKeywords.length,
        });
      } catch (error: any) {
        diagnostics.push({
          source: "asin_page",
          ok: false,
          code: error?.code,
          error: String(error?.message || error).slice(0, 300),
        });
      }
    }

    const total = suggestions.length + organicTitles.length +
      productKeywords.length;
    if (total === 0 && diagnostics.some((item) => item.ok === false)) {
      const failed = diagnostics.filter((item) => item.ok === false);
      const missingKey = failed.some((item) =>
        item.code === "ZYTE_API_KEY_MISSING"
      );
      const dailyLimit = failed.some((item) =>
        item.code === "ZYTE_DAILY_LIMIT_REACHED"
      );
      return Response.json({
        ok: false,
        error: missingKey
          ? "ZYTE_API_KEY não está disponível no container do backend."
          : dailyLimit
          ? "O limite diário interno da Zyte foi atingido; tente novamente amanhã."
          : "A Zyte não conseguiu obter dados públicos da Amazon nesta tentativa; nenhuma keyword foi inventada.",
        code: missingKey
          ? "ZYTE_API_KEY_MISSING"
          : dailyLimit
          ? "ZYTE_DAILY_LIMIT_REACHED"
          : "ZYTE_EXTRACTION_FAILED",
        diagnostics,
      }, { status: missingKey ? 503 : dailyLimit ? 429 : 502 });
    }

    return Response.json({
      ok: true,
      provider: "zyte",
      keyword,
      asin: asin || null,
      marketplace,
      suggestions,
      related: [],
      sponsored_keywords: [],
      organic_titles: organicTitles,
      people_also_buy: [],
      product_keywords: productKeywords,
      total,
      diagnostics,
      warning: total === 0
        ? "A Amazon respondeu, mas a Zyte não extraiu termos utilizáveis."
        : null,
    });
  } catch (error: any) {
    const status = error instanceof ZyteApiError ? error.status : 500;
    return Response.json({
      ok: false,
      error: error?.message || "Falha na pesquisa pública via Zyte.",
      code: error?.code || "ZYTE_KEYWORD_RESEARCH_FAILED",
    }, { status });
  }
}
