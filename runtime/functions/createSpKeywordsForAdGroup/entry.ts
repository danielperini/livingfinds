/**
 * createSpKeywordsForAdGroup
 *
 * Cria keywords em um ad group existente via Amazon Ads SP Keywords API v3.
 * Endpoint: POST /sp/keywords (Campaign Management API)
 *
 * Payload esperado:
 *   amazon_account_id: string
 *   ad_group_id: string         — ID do ad group Amazon
 *   campaign_id: string         — ID da campanha Amazon
 *   keywords: Array<{
 *     keyword_text: string
 *     match_type: 'exact' | 'phrase' | 'broad'
 *     bid?: number              — bid em BRL; usa default_bid se omitido
 *   }>
 *   default_bid?: number        — bid padrão se não informado por keyword (default: 1.00)
 *   state?: 'ENABLED' | 'PAUSED'  — estado inicial (default: ENABLED)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function adsBase(region: string): string {
  const r = (region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function getLwaToken(account: any): Promise<string> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '',
    client_id: Deno.env.get('ADS_CLIENT_ID') || '',
    client_secret: Deno.env.get('ADS_CLIENT_SECRET') || '',
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const d = await res.json();
  if (!res.ok || !d.access_token) throw new Error(`LWA error: ${d.error_description || d.error || res.status}`);
  return d.access_token;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    // Auth
    const isAuth = await base44.auth.isAuthenticated().catch(() => false);
    if (!isAuth && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const {
      amazon_account_id,
      ad_group_id,
      campaign_id,
      default_bid = 1.00,
      state = 'ENABLED',
    } = body;
    let keywords: any[] = Array.isArray(body.keywords) ? [...body.keywords] : [];

    if (!amazon_account_id || !ad_group_id || !campaign_id) {
      return Response.json({ ok: false, error: 'amazon_account_id, ad_group_id e campaign_id são obrigatórios' }, { status: 400 });
    }
    if (!Array.isArray(keywords) || keywords.length === 0) {
      return Response.json({ ok: false, error: 'keywords[] deve ter pelo menos 1 item' }, { status: 400 });
    }

    // ── Validação anti-duplicata ────────────────────────────────────────────
    // Buscar ASIN da campanha para validação cross-campanha
    const campRows = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id, campaign_id: String(campaign_id) }, null, 1
    ).catch(() => []);
    const asinForDedup = campRows[0]?.asin || body.asin || null;
    if (asinForDedup) {
      const dedupResult = await base44.asServiceRole.functions.invoke('checkKeywordDuplicates', {
        amazon_account_id,
        asin: asinForDedup,
        keywords: keywords.map((kw: any) => ({ keyword_text: kw.keyword_text, match_type: kw.match_type || 'broad' })),
        campaign_id: String(campaign_id),
        _service_role: true,
      }).catch(() => null);
      const dedup = dedupResult?.data || dedupResult;
      if (dedup?.has_duplicates) {
        const allowedTexts = new Set((dedup.allowed || []).map((k: any) => (k.keyword_text || '').toLowerCase().trim()));
        keywords = keywords.filter((kw: any) => allowedTexts.has((kw.keyword_text || '').toLowerCase().trim()));
        if (keywords.length === 0) {
          return Response.json({
            ok: false, blocked_all: true,
            error: `Todas as ${dedup.blocked_count} keywords já existem para este produto.`,
            blocked: dedup.blocked,
          });
        }
      }
    }

    // Carregar conta
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id }, null, 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' }, { status: 404 });

    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';
    const region = account.region || Deno.env.get('ADS_REGION') || 'NA';
    const baseUrl = adsBase(region);

    const accessToken = await getLwaToken(account);

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${accessToken}`,
      'Amazon-Advertising-API-ClientId': clientId,
      'Amazon-Advertising-API-Scope': profileId,
      'Content-Type': 'application/vnd.spKeyword.v3+json',
      'Accept': 'application/vnd.spKeyword.v3+json',
    };

    // Montar payload de keywords v3
    const kwPayload = keywords.map((kw: any) => ({
      campaignId: String(campaign_id),
      adGroupId: String(ad_group_id),
      keywordText: kw.keyword_text,
      matchType: (kw.match_type || 'broad').toUpperCase(),
      bid: { value: Number(kw.bid || default_bid).toFixed(2), currencyCode: account.currency_code || 'BRL' },
      state: state,
    }));

    console.log(`[createSpKeywords] Criando ${kwPayload.length} keywords no adGroup ${ad_group_id}`);

    // POST /sp/keywords (SP Keywords API v3)
    const res = await fetch(`${baseUrl}/sp/keywords`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ keywords: kwPayload }),
    });

    const requestId = res.headers.get('x-amzn-RequestId') || '';
    const resData = await res.json().catch(() => ({}));

    console.log(`[createSpKeywords] HTTP ${res.status} requestId=${requestId}`, JSON.stringify(resData).slice(0, 300));

    // Log da API
    await base44.asServiceRole.entities.AmazonApiRequestLog.create({
      amazon_account_id,
      api_family: 'ads_v3',
      operation: 'createSpKeywords',
      method: 'POST',
      endpoint: '/sp/keywords',
      http_status: res.status,
      success: res.ok,
      request_id: requestId,
      created_at: new Date().toISOString(),
    }).catch(() => {});

    if (!res.ok) {
      return Response.json({
        ok: false,
        http_status: res.status,
        error: resData?.message || resData?.details || `HTTP ${res.status}`,
        amazon_response: resData,
      });
    }

    // Processar resultado — API v3 retorna { keywords: [{ keywordId, code, details }] }
    const created = (resData?.keywords || []).filter((k: any) => k.code === 'SUCCESS' || !k.code);
    const failed = (resData?.keywords || []).filter((k: any) => k.code && k.code !== 'SUCCESS');

    // Persistir keywords criados na entidade Keyword
    if (created.length > 0) {
      const now = new Date().toISOString();
      const asinToPersist = asinForDedup || body.asin || campRows[0]?.asin || null;
      const kwRecords = created.map((k: any, idx: number) => {
        const original = kwPayload[idx] || {};
        return {
          amazon_account_id,
          campaign_id: String(campaign_id),
          ad_group_id: String(ad_group_id),
          keyword_id: String(k.keywordId || ''),
          keyword_text: original.keywordText || '',
          keyword: original.keywordText || '',
          match_type: (original.matchType || '').toLowerCase(),
          bid: Number(original.bid?.value || default_bid),
          current_bid: Number(original.bid?.value || default_bid),
          state: state.toLowerCase(),
          status: state.toLowerCase(),
          asin: asinToPersist,
          synced_at: now,
        };
      }).filter((k: any) => k.keyword_id);

      if (kwRecords.length > 0) {
        await base44.asServiceRole.entities.Keyword.bulkCreate(kwRecords).catch((e: any) => {
          console.warn('[createSpKeywords] Erro ao salvar keywords:', e.message);
        });
      }
    }

    return Response.json({
      ok: true,
      created: created.length,
      failed: failed.length,
      failed_details: failed.length > 0 ? failed.slice(0, 5) : undefined,
      amazon_response: resData,
    });

  } catch (err: any) {
    console.error('[createSpKeywords] Erro:', err.message);
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
});