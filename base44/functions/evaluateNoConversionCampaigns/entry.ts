/**
 * evaluateNoConversionCampaigns — Pausa imediata de campanhas MANUAIS com gasto acima do
 * limiar e zero vendas/pedidos.
 *
 * Regras refinadas (2026-07):
 *  - Escopo: apenas campanhas targeting_type=MANUAL (AUTO têm período de aprendizado diferente)
 *  - Limiar de gasto: R$ 10,00 (antes R$30)
 *  - Cliques mínimos: 3 (antes 20)
 *  - Dias mínimos: 2 (antes 14) — evita pausar no primeiro dia
 *  - Condição: orders=0 E sales=0
 *  - Execução: direta via Amazon Ads API (não via fila intermediária)
 *  - Proteção: campanhas com ads_protected=true são ignoradas
 *  - Idempotência: não repete pausa se já existe decisão aprovada para a campanha hoje
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function daysSince(startDate: string | null): number {
  if (!startDate) return 0;
  const ts = new Date(startDate).getTime();
  if (!Number.isFinite(ts)) return 0;
  return Math.max(0, Math.floor((Date.now() - ts) / 86400000));
}

async function getAdsAccessToken(base44: any, accountId: string): Promise<string | null> {
  try {
    const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: accountId }, null, 1);
    const acc = accs[0];
    if (!acc) return null;

    // Usar access token em cache se ainda válido (5 min de margem)
    if (acc.ads_access_token && acc.ads_access_token_expires_at) {
      const expiresAt = new Date(acc.ads_access_token_expires_at).getTime();
      if (expiresAt - Date.now() > 5 * 60 * 1000) return acc.ads_access_token;
    }

    // Renovar via refresh token
    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
    const clientSecret = Deno.env.get('ADS_CLIENT_SECRET') || '';
    const refreshToken = acc.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '';
    if (!refreshToken) return null;

    const res = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const token = data.access_token;
    if (!token) return null;

    // Persistir token renovado
    const expiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();
    await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
      ads_access_token: token,
      ads_access_token_expires_at: expiresAt,
      ads_last_token_refresh_at: new Date().toISOString(),
      ads_token_status: 'active',
    }).catch(() => {});

    return token;
  } catch { return null; }
}

async function pauseCampaignOnAmazon(
  campaignId: string,
  profileId: string,
  token: string,
  region: string
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const baseUrl = region === 'EU'
    ? 'https://advertising-api-eu.amazon.com'
    : region === 'FE'
    ? 'https://advertising-api-fe.amazon.com'
    : 'https://advertising-api.amazon.com';

  const res = await fetch(`${baseUrl}/sp/campaigns`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': profileId,
      'Content-Type': 'application/vnd.spCampaign.v3+json',
      'Accept': 'application/vnd.spCampaign.v3+json',
    },
    body: JSON.stringify({
      campaigns: [{ campaignId, state: 'PAUSED' }],
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: err.slice(0, 300) };
  }
  return { ok: true, status: res.status };
}

Deno.serve(async (req) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, dry_run = false } = body;

    // Resolver conta
    let account: any = null;
    if (amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id }, null, 1);
      account = accs[0] || null;
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0] || null;
    }
    if (!account) return Response.json({ ok: true, skipped: true, reason: 'Nenhuma conta conectada' });

    const accountId = account.id;
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';
    const region = account.region || Deno.env.get('ADS_REGION') || 'NA';
    const now = new Date().toISOString();
    const today = now.slice(0, 10);

    // ── Thresholds refinados ──────────────────────────────────────────────
    // Leitura de BudgetRule (permite override via painel), mas com defaults muito mais agressivos
    const rules = await base44.asServiceRole.entities.BudgetRule.filter({ amazon_account_id: accountId }).catch(() => []);
    const rule: any = rules[0] || {};

    const MIN_SPEND  = Number(rule.manual_pause_min_spend  ?? 10);  // R$10 (antes R$30)
    const MIN_CLICKS = Number(rule.manual_pause_min_clicks ?? 3);   // 3 cliques (antes 20)
    const MIN_DAYS   = Number(rule.manual_pause_min_days   ?? 2);   // 2 dias (antes 14)

    // Buscar token Amazon (para execução direta)
    let adsToken: string | null = null;
    if (!dry_run) {
      adsToken = await getAdsAccessToken(base44, accountId);
    }

    // Buscar campanhas MANUAIS ativas
    const allCampaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: accountId }, '-spend', 1000
    );

    const manualActive = allCampaigns.filter((c: any) =>
      (c.state || c.status) === 'enabled' &&
      c.archived !== true &&
      c.targeting_type === 'MANUAL' &&
      (c as any).ads_protected !== true
    );

    const results: any[] = [];
    let paused = 0;
    let queued = 0;
    let skipped = 0;

    for (const campaign of manualActive) {
      const daysRunning = Number(campaign.days_running || daysSince(campaign.start_date || campaign.created_at));
      const clicks      = Number(campaign.clicks  || 0);
      const spend       = Number(campaign.spend   || campaign.current_spend || 0);
      const orders      = Number(campaign.orders  || 0);
      const sales       = Number(campaign.sales   || 0);

      // Critérios de pausa
      const meetsSpend  = spend  >= MIN_SPEND;
      const meetsClicks = clicks >= MIN_CLICKS;
      const meetsDays   = daysRunning >= MIN_DAYS;
      const zeroConv    = orders === 0 && sales === 0;

      if (!meetsSpend || !meetsClicks || !meetsDays || !zeroConv) {
        skipped++;
        continue;
      }

      const reason = `Pausa automática MANUAL: R$${spend.toFixed(2).replace('.', ',')} gasto · ${clicks} cliques · ${daysRunning} dias · 0 conversões.`;
      const idempKey = `${accountId}|auto_pause_manual|${campaign.campaign_id}|${today}`;

      if (dry_run) {
        results.push({ campaign_id: campaign.campaign_id, name: campaign.name, status: 'candidate', spend, clicks, daysRunning, reason });
        continue;
      }

      // Idempotência — não duplicar pausa do dia
      const existing = await base44.asServiceRole.entities.OptimizationDecision.filter({
        amazon_account_id: accountId,
        campaign_id: campaign.campaign_id,
        action: 'pause_campaign',
        status: { $in: ['approved', 'executing', 'executed'] },
        idempotency_key: idempKey,
      }, null, 1).catch(() => []);

      if (existing.length > 0) {
        results.push({ campaign_id: campaign.campaign_id, status: 'already_paused_today', reason });
        continue;
      }

      // Tentar pausa direta na Amazon
      let amazonResult: any = { ok: false, error: 'token_unavailable' };
      if (adsToken && profileId && campaign.amazon_campaign_id) {
        amazonResult = await pauseCampaignOnAmazon(
          campaign.amazon_campaign_id,
          profileId,
          adsToken,
          region
        );
      }

      // Atualizar estado local
      await base44.asServiceRole.entities.Campaign.update(campaign.id, {
        state: 'paused',
        status: 'paused',
        last_activity_at: now,
      }).catch(() => {});

      // Registrar decisão executada
      await base44.asServiceRole.entities.OptimizationDecision.create({
        amazon_account_id: accountId,
        decision_type: 'pause',
        entity_type: 'campaign',
        entity_id: campaign.campaign_id,
        campaign_id: campaign.campaign_id,
        asin: campaign.asin,
        action: 'pause_campaign',
        rationale: reason,
        data_used: `spend=${spend}, clicks=${clicks}, days=${daysRunning}, orders=0, sales=0`,
        risk: 'low',
        requires_approval: false,
        status: amazonResult.ok ? 'executed' : 'approved',
        confidence: 98,
        country_code: account.country_code || 'BR',
        currency_code: account.currency_code || 'BRL',
        currency_symbol: account.currency_symbol || 'R$',
        idempotency_key: idempKey,
        source_function: 'evaluateNoConversionCampaigns',
        amazon_response_status: amazonResult.status,
        executed_at: amazonResult.ok ? now : null,
        created_at: now,
      }).catch(() => {});

      if (amazonResult.ok) {
        paused++;
        results.push({ campaign_id: campaign.campaign_id, name: campaign.name, status: 'paused_amazon', spend, clicks, daysRunning });
      } else {
        queued++;
        results.push({ campaign_id: campaign.campaign_id, name: campaign.name, status: 'queued_retry', spend, clicks, daysRunning, error: amazonResult.error });
      }
    }

    return Response.json({
      ok: true,
      dry_run,
      thresholds: { min_spend_brl: MIN_SPEND, min_clicks: MIN_CLICKS, min_days: MIN_DAYS },
      scope: 'MANUAL only',
      evaluated: manualActive.length,
      paused_amazon: paused,
      queued_retry: queued,
      skipped_no_criteria: skipped,
      results,
      token_available: !!adsToken,
      duration_ms: Date.now() - startedAt,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message, duration_ms: Date.now() - startedAt }, { status: 500 });
  }
});