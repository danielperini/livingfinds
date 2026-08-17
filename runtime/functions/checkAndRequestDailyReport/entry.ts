/**
 * checkAndRequestDailyReport
 *
 * Chamado diariamente pelo scheduler (08h BRT).
 * Sincroniza campanhas SP diretamente via Amazon Ads API (sem chamar outras funções).
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ── Token cache ────────────────────────────────────────────────────────────────
const tokenCache: Record<string, { access_token: string; expires_at: number }> = {};

async function getAdsToken(refreshToken: string) {
  const cached = tokenCache['ads'];
  if (cached && cached.expires_at > Date.now() + 5000) return cached.access_token;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: Deno.env.get('ADS_CLIENT_ID') || '',
    client_secret: Deno.env.get('ADS_CLIENT_SECRET') || '',
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || `Token refresh failed (${res.status})`);
  tokenCache['ads'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function getAdsBaseUrl() {
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

function hoursAgo(h: number) {
  return new Date(Date.now() - h * 3600000).toISOString();
}

Deno.serve(async (req) => {
  const startTime = Date.now();

  try {
    const base44 = createClientFromRequest(req);

    const body = await req.json().catch(() => ({}));
    const targetAccountId = body.amazon_account_id;

    // Resolver conta
    const accountFilter = targetAccountId ? { id: targetAccountId } : { status: 'connected' };
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter(accountFilter, '-created_date', 1);
    const account = accounts[0] || null;

    if (!account) {
      return Response.json({ ok: true, skipped: true, reason: 'Nenhuma conta Amazon conectada.' });
    }

    const aid = account.id;
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    // Verificar relatório fresco (< 8h) — se já tem, pular
    const freshCutoff = hoursAgo(8);
    const recentReports = await base44.asServiceRole.entities.AdsMetricsHistory.filter(
      { amazon_account_id: aid, report_type: 'campaigns' }, '-date', 5
    );
    const hasFreshReport = recentReports.some(r => {
      const isRecentDate = r.date === today || r.date === yesterday;
      const isFresh = r.synced_at && r.synced_at >= freshCutoff;
      return isRecentDate && isFresh;
    });

    if (hasFreshReport) {
      return Response.json({ ok: true, skipped: true, reason: 'Relatório já atualizado (< 8h)', duration_ms: Date.now() - startTime });
    }

    // Verificar limite de syncs diários (6/dia)
    const todaySyncs = await base44.asServiceRole.entities.SyncExecutionLog.filter({
      amazon_account_id: aid,
      execution_date: today,
      status: { $in: ['success', 'started'] },
    });
    if (todaySyncs.length >= 6) {
      return Response.json({ ok: true, skipped: true, reason: `Limite de 6 syncs diários atingido (${todaySyncs.length}/6)`, duration_ms: Date.now() - startTime });
    }

    // Registrar início do sync
    const logRecord = await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'ads_sync',
      trigger_type: 'automatic',
      status: 'started',
      execution_date: today,
      started_at: new Date().toISOString(),
    });

    // ── Sync inline: listar campanhas SP via Amazon Ads API ────────────────
    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '';
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';

    if (!refreshToken || !profileId) {
      await base44.asServiceRole.entities.SyncExecutionLog.update(logRecord.id, {
        status: 'error',
        completed_at: new Date().toISOString(),
        error_message: 'Credenciais Amazon Ads não configuradas (refresh_token ou profile_id)',
        duration_ms: Date.now() - startTime,
      });
      return Response.json({ ok: false, error: 'Credenciais Amazon Ads não configuradas', duration_ms: Date.now() - startTime });
    }

    const token = await getAdsToken(refreshToken);
    const adsBase = getAdsBaseUrl();
    const now = new Date().toISOString();

    const res = await fetch(`${adsBase}/sp/campaigns/list`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
        'Amazon-Advertising-API-Scope': String(profileId),
        'Content-Type': 'application/vnd.spCampaign.v3+json',
        'Accept': 'application/vnd.spCampaign.v3+json',
      },
      body: JSON.stringify({ stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] }, maxResults: 500 }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(`Amazon Ads API ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);

    const campaignList = data?.campaigns || [];
    console.log(`[checkAndRequestDailyReport] ${campaignList.length} campanhas recebidas da Amazon`);

    // Upsert campanhas
    const existingCamps = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: aid }, '-created_date', 2000
    );
    const existingMap: Record<string, string> = {};
    for (const c of existingCamps) existingMap[c.campaign_id] = c.id;

    const toCreate: object[] = [], toUpdate: object[] = [];
    for (const c of campaignList) {
      const rec = {
        amazon_account_id: aid,
        campaign_id: String(c.campaignId),
        name: c.name,
        campaign_name: c.name,
        campaign_type: 'SP',
        targeting_type: c.targetingType || 'AUTO',
        state: (c.state || 'ENABLED').toLowerCase(),
        status: (c.state || 'ENABLED').toLowerCase(),
        daily_budget: c.budget?.budget || c.dailyBudget || 0,
        start_date: c.startDate || null,
        end_date: c.endDate || null,
        bidding_strategy: c.dynamicBidding?.strategy || null,
        synced_at: now,
        last_sync_at: now,
      };
      if (existingMap[rec.campaign_id]) {
        toUpdate.push({ id: existingMap[rec.campaign_id], ...rec });
      } else {
        toCreate.push(rec);
      }
    }

    for (let i = 0; i < toCreate.length; i += 500) {
      await base44.asServiceRole.entities.Campaign.bulkCreate(toCreate.slice(i, i + 500));
    }
    for (let i = 0; i < toUpdate.length; i += 500) {
      await base44.asServiceRole.entities.Campaign.bulkUpdate(toUpdate.slice(i, i + 500));
    }

    const upserted = toCreate.length + toUpdate.length;
    console.log(`[checkAndRequestDailyReport] Campanhas: ${toCreate.length} criadas, ${toUpdate.length} atualizadas`);

    // Atualizar conta
    await base44.asServiceRole.entities.AmazonAccount.update(aid, {
      last_sync_at: now,
      status: 'connected',
      error_message: null,
    }).catch(() => {});

    // Finalizar log
    await base44.asServiceRole.entities.SyncExecutionLog.update(logRecord.id, {
      status: 'success',
      completed_at: now,
      duration_ms: Date.now() - startTime,
      records_processed: upserted,
    });

    return Response.json({
      ok: true,
      campaigns_received: campaignList.length,
      campaigns_upserted: upserted,
      duration_ms: Date.now() - startTime,
    });

  } catch (error) {
    console.error('[checkAndRequestDailyReport] Erro:', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});