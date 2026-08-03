import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { secrets } from 'base44:runtime';

/**
 * scrapeAmazonKeywords
 * Usa ScrapingBee para extrair sugestões de autocomplete da Amazon BR
 * e resultados orgânicos de busca para uma keyword/ASIN.
 *
 * Payload: { asin?: string, keyword: string, marketplace?: string }
 * Retorna: { suggestions: string[], related: string[], sponsored_keywords: string[] }
 */
export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { keyword, asin, marketplace = 'BR' } = body as any;

    if (!keyword || typeof keyword !== 'string' || keyword.trim().length < 2) {
      return Response.json({ error: 'keyword é obrigatório (min 2 chars)' }, { status: 400 });
    }

    const apiKey = secrets.get('SCRAPINGBEE_API_KEY');
    if (!apiKey) return Response.json({ error: 'SCRAPINGBEE_API_KEY não configurada' }, { status: 500 });

    const domainMap: Record<string, string> = {
      BR: 'www.amazon.com.br',
      US: 'www.amazon.com',
      MX: 'www.amazon.com.mx',
    };
    const domain = domainMap[marketplace] || 'www.amazon.com.br';

    // ── 1. Autocomplete suggestions via search endpoint ──────────────────
    const autocompleteUrl = `https://completion.amazon.${marketplace === 'BR' ? 'com.br' : 'com'}/search/complete?q=${encodeURIComponent(keyword.trim())}&search-alias=aps&mkt=5&client=amzn-search-suggestions`;

    const acParams = new URLSearchParams({
      api_key: apiKey,
      url: autocompleteUrl,
      render_js: 'false',
      premium_proxy: 'false',
      country_code: 'br',
    });

    let suggestions: string[] = [];
    const diagnostics: Array<{ source: string; http_status: number | null; detail?: string }> = [];
    try {
      const acResp = await fetch(`https://app.scrapingbee.com/api/v1/?${acParams.toString()}`);
      diagnostics.push({ source: 'autocomplete', http_status: acResp.status, detail: acResp.ok ? undefined : (await acResp.text()).slice(0, 180) });
      if (acResp.ok) {
        const acText = await acResp.text();
        // Autocomplete retorna JSON array: ["query", ["sug1","sug2",...]]
        const parsed = JSON.parse(acText);
        if (Array.isArray(parsed) && Array.isArray(parsed[1])) {
          suggestions = parsed[1].slice(0, 20);
        }
      }
    } catch (error: any) { diagnostics.push({ source: 'autocomplete', http_status: null, detail: error?.message || 'network_error' }); }

    // ── 2. SERP da Amazon para extrair keywords relacionadas ─────────────
    const serpUrl = `https://${domain}/s?k=${encodeURIComponent(keyword.trim())}`;

    const serpParams = new URLSearchParams({
      api_key: apiKey,
      url: serpUrl,
      render_js: 'false',
      premium_proxy: 'true',
      country_code: 'br',
      extract_rules: JSON.stringify({
        related_searches: {
          selector: '[class*="s-related-search-phrases"] a, [data-component-type="s-related-searches"] a, .a-carousel-card .a-link-normal span',
          type: 'list',
          output: 'text',
        },
        sponsored_titles: {
          selector: '[data-component-type="sp-sponsored-result"] h2 a span, .s-result-item[data-index] h2 a span',
          type: 'list',
          output: 'text',
        },
        organic_titles: {
          selector: '.s-result-item:not([class*="s-sponsored"]) h2 a span',
          type: 'list',
          output: 'text',
        },
        people_also_buy: {
          selector: '[data-component-type="s-frequently-bought-together"] h2 span, .s-card-container h2 span',
          type: 'list',
          output: 'text',
        },
      }),
    });

    let related: string[] = [];
    let sponsored_keywords: string[] = [];
    let organic_titles: string[] = [];
    let people_also_buy: string[] = [];
    let raw_html_snippet = '';

    try {
      const serpResp = await fetch(`https://app.scrapingbee.com/api/v1/?${serpParams.toString()}`);
      if (!serpResp.ok) {
        diagnostics.push({ source: 'amazon_search', http_status: serpResp.status, detail: (await serpResp.text()).slice(0, 180) });
      } else {
        diagnostics.push({ source: 'amazon_search', http_status: serpResp.status });
        const serpData = await serpResp.json().catch(async () => {
          raw_html_snippet = (await serpResp.text()).slice(0, 500);
          return {};
        });
        related = (serpData?.related_searches || []).filter((s: string) => s && s.trim().length > 2).slice(0, 20);
        sponsored_keywords = (serpData?.sponsored_titles || []).filter((s: string) => s && s.trim().length > 2).slice(0, 10);
        organic_titles = (serpData?.organic_titles || []).filter((s: string) => s && s.trim().length > 2).slice(0, 15);
        people_also_buy = (serpData?.people_also_buy || []).filter((s: string) => s && s.trim().length > 2).slice(0, 10);
      }
    } catch (error: any) { diagnostics.push({ source: 'amazon_search', http_status: null, detail: error?.message || 'network_error' }); }

    // ── 3. Se ASIN fornecido, buscar página do produto para keywords ──────
    let product_keywords: string[] = [];
    if (asin) {
      const asinUrl = `https://${domain}/dp/${asin}`;
      const asinParams = new URLSearchParams({
        api_key: apiKey,
        url: asinUrl,
        render_js: 'false',
        premium_proxy: 'true',
        country_code: 'br',
        extract_rules: JSON.stringify({
          title: { selector: '#productTitle', type: 'item', output: 'text' },
          bullet_points: { selector: '#feature-bullets li span', type: 'list', output: 'text' },
          category: { selector: '#wayfinding-breadcrumbs_container a', type: 'list', output: 'text' },
        }),
      });

      try {
        const asinResp = await fetch(`https://app.scrapingbee.com/api/v1/?${asinParams.toString()}`);
        diagnostics.push({ source: 'asin_page', http_status: asinResp.status, detail: asinResp.ok ? undefined : (await asinResp.clone().text()).slice(0, 180) });
        if (asinResp.ok) {
          const asinData = await asinResp.json().catch(() => ({}));
          const title = asinData?.title || '';
          const bullets = (asinData?.bullet_points || []).join(' ');
          const categories = (asinData?.category || []);

          // Extrair tokens relevantes do título + bullets
          const combined = `${title} ${bullets}`.toLowerCase();
          const stopWords = new Set(['de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'para', 'com', 'por', 'que', 'e', 'a', 'o', 'os', 'as', 'um', 'uma', 'the', 'for', 'with', 'and', 'in', 'of']);
          const tokens = combined.split(/\s+/).filter(t => t.length >= 4 && !stopWords.has(t) && /^[a-záéíóúàãõ]+$/i.test(t));
          const tokenFreq = new Map<string, number>();
          for (const t of tokens) tokenFreq.set(t, (tokenFreq.get(t) || 0) + 1);
          product_keywords = Array.from(tokenFreq.entries())
            .filter(([, freq]) => freq >= 2)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 20)
            .map(([word]) => word);

          // Adicionar categorias como contexto
          if (categories.length > 0) {
            product_keywords.unshift(...categories.slice(0, 3));
          }
        }
      } catch (error: any) { diagnostics.push({ source: 'asin_page', http_status: null, detail: error?.message || 'network_error' }); }
    }

    const total = suggestions.length + related.length + sponsored_keywords.length + organic_titles.length + product_keywords.length;
    const failedSources = diagnostics.filter((item) => item.http_status === null || (item.http_status || 0) >= 400);
    if (total === 0 && failedSources.length > 0) {
      const quota = failedSources.some((item) => item.http_status === 429 || /limit|quota|credit/i.test(item.detail || ''));
      return Response.json({
        ok: false,
        error: quota ? 'ScrapingBee sem créditos ou temporariamente limitada; nenhuma keyword foi inventada.' : 'ScrapingBee não conseguiu consultar a Amazon nesta tentativa.',
        diagnostics,
      }, { status: quota ? 429 : 502 });
    }

    return Response.json({
      ok: true,
      keyword: keyword.trim(),
      asin: asin || null,
      marketplace,
      suggestions,
      related,
      sponsored_keywords,
      organic_titles,
      people_also_buy,
      product_keywords,
      total,
      diagnostics,
      warning: total === 0 ? 'A Amazon respondeu, mas não forneceu termos extraíveis para esta consulta.' : null,
    });

  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
