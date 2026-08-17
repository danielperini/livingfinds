/**
 * testAmazonAdsReportCapabilities
 *
 * Testa quais reportTypeId a conta Amazon Ads suporta via Reports API v3.
 * Salva resultado por report type na entidade AmazonAdsReportCapability.
 * Nunca quebra o sync geral — cada teste é independente.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function adsBase(region: string): string {
  const r = (region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

function yesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Payloads de teste por report type
function buildPayload(reportTypeId: string, date: string, minimal = false): Record<string, any> {
  const base = { name: `Capability test ${reportTypeId}${minimal ? ' minimal' : ''} ${date}`, startDate: date, endDate: date };

  if (reportTypeId === 'spCampaigns') {
    return { ...base, configuration: {
      adProduct: 'SPONSORED_PRODUCTS', groupBy: ['campaign'],
      columns: ['campaignId', 'campaignName', 'impressions', 'clicks', 'cost'],
      reportTypeId, timeUnit: 'SUMMARY', format: 'GZIP_JSON',
    }};
  }

  // spTargeting BR: só permite groupBy=adGroup e colunas de atribuição + matchType + date
  // NÃO suporta targetingId, targetingExpression, bid, etc.
  if (reportTypeId === 'spTargeting') {
    if (minimal) {
      return { ...base, configuration: {
        adProduct: 'SPONSORED_PRODUCTS', groupBy: ['adGroup'],
        columns: ['date', 'matchType', 'impressions', 'clicks', 'cost'],
        reportTypeId, timeUnit: 'SUMMARY', format: 'GZIP_JSON',
      }};
    }
    return { ...base, configuration: {
      adProduct: 'SPONSORED_PRODUCTS', groupBy: ['adGroup'],
      columns: ['date', 'matchType', 'impressions', 'clicks', 'cost',
        'purchases7d', 'purchases14d', 'purchases30d',
        'sales7d', 'sales14d', 'sales30d', 'roasClicks14d'],
      reportTypeId, timeUnit: 'SUMMARY', format: 'GZIP_JSON',
    }};
  }

  // spKeywords BR: groupBy=adGroup (não keyword); colunas limitadas — apenas atribuição
  if (reportTypeId === 'spKeywords') {
    if (minimal) {
      return { ...base, configuration: {
        adProduct: 'SPONSORED_PRODUCTS', groupBy: ['adGroup'],
        columns: ['date', 'impressions', 'clicks', 'cost'],
        reportTypeId, timeUnit: 'SUMMARY', format: 'GZIP_JSON',
      }};
    }
    return { ...base, configuration: {
      adProduct: 'SPONSORED_PRODUCTS', groupBy: ['adGroup'],
      columns: ['date', 'impressions', 'clicks', 'cost',
        'purchases7d', 'purchases14d', 'purchases30d',
        'sales7d', 'sales14d', 'sales30d'],
      reportTypeId, timeUnit: 'SUMMARY', format: 'GZIP_JSON',
    }};
  }

  if (reportTypeId === 'spSearchTerm') {
    return { ...base, configuration: {
      adProduct: 'SPONSORED_PRODUCTS', groupBy: ['searchTerm'],
      columns: ['campaignId', 'adGroupId', 'searchTerm', 'impressions', 'clicks', 'cost', 'purchases7d', 'sales7d'],
      reportTypeId, timeUnit: 'SUMMARY', format: 'GZIP_JSON',
    }};
  }

  // spPurchasedProduct BR: groupBy deve ser 'asin' (não 'advertiser')
  if (reportTypeId === 'spPurchasedProduct') {
    return { ...base, configuration: {
      adProduct: 'SPONSORED_PRODUCTS', groupBy: ['asin'],
      columns: ['date', 'advertisedAsin', 'purchases7d', 'sales7d', 'unitsSoldClicks7d'],
      reportTypeId, timeUnit: 'SUMMARY', format: 'GZIP_JSON',
    }};
  }

  return { ...base, configuration: { adProduct: 'SPONSORED_PRODUCTS', groupBy: ['campaign'], columns: ['impressions', 'clicks', 'cost'], reportTypeId, timeUnit: 'SUMMARY', format: 'GZIP_JSON' }};
}

// Teste de um único report type
async function testReportType(params: {
  reportTypeId: string;
  accessToken: string;
  clientId: string;
  profileId: string;
  region: string;
  date: string;
}): Promise<{ status: string; http_status: number; error_code?: string; error_message?: string; notes?: string; payload: any; requestId?: string }> {
  const { reportTypeId, accessToken, clientId, profileId, region, date } = params;
  const adsUrl = adsBase(region);

  const tryRequest = async (payload: any): Promise<{ ok: boolean; status: number; data: any; requestId: string }> => {
    const res = await fetch(`${adsUrl}/reporting/reports`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Amazon-Advertising-API-ClientId': clientId,
        'Amazon-Advertising-API-Scope': profileId,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const requestId = res.headers.get('x-amzn-RequestId') || '';
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok || res.status === 202, status: res.status, data, requestId };
  };

  // Tentativa 1: payload completo
  const payload1 = buildPayload(reportTypeId, date, false);
  const r1 = await tryRequest(payload1);

  console.log(`[Capability] ${reportTypeId} | HTTP ${r1.status} | requestId=${r1.requestId} | ${JSON.stringify(r1.data).slice(0, 200)}`);

  // Sucesso (200, 202, ou 425 = já enviado = suportado)
  if (r1.ok || r1.status === 425) {
    return { status: 'supported', http_status: r1.status, payload: payload1, requestId: r1.requestId, notes: r1.status === 425 ? 'Already requested (425) — report type is supported.' : undefined };
  }

  // Erro de autenticação → unknown
  if (r1.status === 401 || r1.status === 403) {
    return { status: 'unknown', http_status: r1.status, error_code: r1.data?.code || String(r1.status), error_message: r1.data?.message || r1.data?.details || 'Auth error — verify token.', payload: payload1, requestId: r1.requestId };
  }

  // Rate limit → unknown
  if (r1.status === 429) {
    return { status: 'unknown', http_status: r1.status, error_code: '429', error_message: 'Rate limited — reschedule test.', payload: payload1, requestId: r1.requestId };
  }

  // Erro 400/422 → pode ser coluna inválida → tentar payload mínimo para spTargeting/spKeywords
  if ((r1.status === 400 || r1.status === 422) && (reportTypeId === 'spTargeting' || reportTypeId === 'spKeywords')) {
    const errMsg = (r1.data?.message || r1.data?.details || '').toLowerCase();
    const isColumnError = errMsg.includes('column') || errMsg.includes('field') || errMsg.includes('invalid') || errMsg.includes('unsupported');

    if (isColumnError || true) { // sempre tentar minimal em caso de 400
      const payload2 = buildPayload(reportTypeId, date, true);
      const r2 = await tryRequest(payload2);

      console.log(`[Capability] ${reportTypeId} minimal | HTTP ${r2.status} | requestId=${r2.requestId} | ${JSON.stringify(r2.data).slice(0, 200)}`);

      if (r2.ok || r2.status === 425) {
        return { status: 'supported', http_status: r2.status, payload: payload2, requestId: r2.requestId, notes: 'Supported with minimal columns; some columns unavailable.' };
      }

      if (r2.status === 400 || r2.status === 422 || r2.status === 404) {
        const notes = reportTypeId === 'spTargeting'
          ? `spTargeting não suportado. Use spKeywords como fallback. Full error: ${(r1.data?.message || '').slice(0, 200)}`
          : `Full payload error: ${(r1.data?.message || '').slice(0, 200)}`;
        return { status: 'unsupported', http_status: r2.status, error_code: r2.data?.code || String(r2.status), error_message: (r2.data?.message || r2.data?.details || '').slice(0, 500), payload: payload2, requestId: r2.requestId, notes };
      }
    }
  }

  // Erro 400/404 em outros report types → unsupported
  if (r1.status === 400 || r1.status === 404 || r1.status === 422) {
    return { status: 'unsupported', http_status: r1.status, error_code: r1.data?.code || String(r1.status), error_message: (r1.data?.message || r1.data?.details || '').slice(0, 500), payload: payload1, requestId: r1.requestId };
  }

  // Qualquer outro erro → error
  return { status: 'error', http_status: r1.status, error_code: r1.data?.code || String(r1.status), error_message: (r1.data?.message || r1.data?.details || '').slice(0, 500), payload: payload1, requestId: r1.requestId };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    const auth = await base44.auth.isAuthenticated().catch(() => false);
    if (!auth && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    // Resolver conta
    let amazon_account_id = body.amazon_account_id;
    if (!amazon_account_id) {
      const me = await base44.auth.me().catch(() => null);
      if (me) {
        const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ user_id: me.id }, null, 1);
        amazon_account_id = accounts[0]?.id;
      }
    }
    if (!amazon_account_id) {
      return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });
    }

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id }, null, 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' }, { status: 404 });

    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
    const clientSecret = Deno.env.get('ADS_CLIENT_SECRET') || '';
    const profileId = body.profile_id || account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';
    const region = body.region || account.region || Deno.env.get('ADS_REGION') || 'NA';
    const marketplaceId = body.marketplace_id || account.marketplace_id || '';
    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '';

    if (!refreshToken || !clientId || !clientSecret) {
      return Response.json({ ok: false, error: 'Credenciais Amazon Ads não configuradas' }, { status: 400 });
    }

    // Obter access token
    const lwaRes = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }).toString(),
    });
    const lwaData = await lwaRes.json().catch(() => ({}));
    if (!lwaRes.ok || !lwaData.access_token) {
      return Response.json({ ok: false, error: `Falha ao obter token LWA: ${lwaData.error || lwaData.error_description || 'unknown'}` }, { status: 401 });
    }
    const accessToken = lwaData.access_token;

    const date = yesterday();
    const REPORT_TYPES = ['spCampaigns', 'spTargeting', 'spKeywords', 'spSearchTerm', 'spPurchasedProduct'];
    const now = new Date().toISOString();
    const results: Record<string, any> = {};

    for (const reportTypeId of REPORT_TYPES) {
      console.log(`[Capability] Testando: ${reportTypeId}`);
      const result = await testReportType({ reportTypeId, accessToken, clientId, profileId, region, date });
      results[reportTypeId] = { ...result, reportTypeId };

      // Buscar registro existente
      const existing = await base44.asServiceRole.entities.AmazonAdsReportCapability.filter(
        { amazon_account_id, profile_id: profileId, report_type_id: reportTypeId },
        null, 1
      ).catch(() => []);

      const record: Record<string, any> = {
        amazon_account_id,
        profile_id: profileId,
        marketplace_id: marketplaceId,
        region,
        report_type_id: reportTypeId,
        ad_product: 'SPONSORED_PRODUCTS',
        group_by: result.payload?.configuration?.groupBy || [],
        status: result.status,
        http_status: result.http_status,
        amazon_error_code: result.error_code || null,
        amazon_error_message: result.error_message || null,
        tested_payload: JSON.stringify(result.payload).slice(0, 2000),
        tested_at: now,
        notes: result.notes || null,
      };

      if (result.status === 'supported') {
        record.last_success_at = now;
        record.fallback_report_type = null;
      } else if (result.status === 'unsupported') {
        record.last_failure_at = now;
        record.fallback_report_type = reportTypeId === 'spTargeting'
          ? 'spCampaigns + spSearchTerm + campaign entities'
          : null;
      } else {
        record.last_failure_at = now;
      }

      if (existing[0]) {
        // Preservar last_success_at se o teste atual falhou
        if (result.status !== 'supported' && existing[0].last_success_at) {
          record.last_success_at = existing[0].last_success_at;
        }
        await base44.asServiceRole.entities.AmazonAdsReportCapability.update(existing[0].id, record).catch((e: any) => {
          console.error(`[Capability] Erro ao atualizar ${reportTypeId}:`, e.message);
        });
      } else {
        await base44.asServiceRole.entities.AmazonAdsReportCapability.create(record).catch((e: any) => {
          console.error(`[Capability] Erro ao criar ${reportTypeId}:`, e.message);
        });
      }

      console.log(`[Capability] ${reportTypeId} → ${result.status} (HTTP ${result.http_status})`);
    }

    // Resumo
    const summary = Object.fromEntries(
      REPORT_TYPES.map(rt => [rt, { status: results[rt].status, http_status: results[rt].http_status, notes: results[rt].notes, error: results[rt].error_message }])
    );

    return Response.json({ ok: true, tested_at: now, profile_id: profileId, region, marketplace_id: marketplaceId, summary });

  } catch (err: any) {
    console.error('[Capability] Erro geral:', err.message);
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
});