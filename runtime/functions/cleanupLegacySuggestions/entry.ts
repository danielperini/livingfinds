/**
 * cleanupLegacySuggestions
 *
 * 1. Busca sugestões de origem IA (legadas) que ainda não estão arquivadas
 * 2. Para cada uma, verifica se a campanha associada teve GASTO > 0 nos últimos 30d
 *    - SE gastou: move keyword para TermBank (se não existir) e arquiva a sugestão
 *    - SE não gastou: arquiva a sugestão + arquiva a campanha na Amazon (se existir)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const AI_SOURCES = [
  'CLAUDE_PRODUCT_ANALYSIS', 'OPENAI_TITLE_ANALYSIS', 'AI_GENERATED',
  'GPT_TITLE_ANALYSIS', 'PRODUCT_ANALYSIS',
  'AUTOMATIC_SEARCH_TERM', 'MANUAL_SEARCH_TERM', 'CONVERTED_TERM_EXPANSION', 'USER',
];

function getAdsBaseUrl(region: string) {
  const r = (region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function getAdsToken(refreshToken: string, clientId: string, clientSecret: string) {
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token refresh failed');
  return data.access_token as string;
}

async function archiveCampaignOnAmazon(amazonCampaignId: string, token: string, baseUrl: string, profileId: string, clientId: string) {
  const res = await fetch(`${baseUrl}/sp/campaigns`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': clientId,
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': 'application/vnd.spCampaign.v3+json',
      'Accept': 'application/vnd.spCampaign.v3+json',
    },
    body: JSON.stringify({ campaigns: [{ campaignId: amazonCampaignId, state: 'ARCHIVED' }] }),
  });
  if (res.status === 429) { await new Promise(r => setTimeout(r, 3000)); return false; }
  return res.ok;
}

Deno.serve(async (req) => {
  const now = new Date().toISOString();
  const cutoff30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    let account: any = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
      account = accs[0];
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' });

    const aid = account.id;

    // 1. Buscar sugestões legadas não arquivadas
    const allSuggestions: any[] = [];
    for (const src of AI_SOURCES) {
      const batch = await base44.asServiceRole.entities.KeywordSuggestion.filter(
        { amazon_account_id: aid, source: src }, null, 200
      ).catch(() => []);
      allSuggestions.push(...batch.filter((s: any) => s.status !== 'archived_by_policy'));
    }

    if (!allSuggestions.length) {
      return Response.json({ ok: true, message: 'Nenhuma sugestão legada pendente', archived: 0, migrated_to_termbank: 0 });
    }

    // 2. Métricas de gasto dos últimos 30 dias por campaign_id
    const metrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: aid }, '-date', 500
    ).catch(() => []);

    const spendByCampaign: Record<string, number> = {};
    for (const m of metrics) {
      if (!m.campaign_id || m.date < cutoff30) continue;
      spendByCampaign[m.campaign_id] = (spendByCampaign[m.campaign_id] || 0) + (m.spend || 0);
    }

    // 3. Buscar campanhas criadas pelo app para fazer join
    const campaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: aid, created_by_app: true }, null, 300
    ).catch(() => []);
    const campaignByKeyword: Record<string, any> = {};
    for (const c of campaigns) {
      if (c.name) campaignByKeyword[c.name.toLowerCase()] = c;
    }

    // 4. TermBank existente (para dedup)
    const existingTerms = await base44.asServiceRole.entities.TermBank.filter(
      { amazon_account_id: aid }, null, 500
    ).catch(() => []);
    const termBankKeys = new Set(existingTerms.map((t: any) => `${t.asin}|${(t.term || '').toLowerCase().trim()}`));

    // 5. Token para arquivar na Amazon
    let token = '';
    let baseUrl = '';
    let profileId = '';
    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
    try {
      token = await getAdsToken(
        account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '',
        clientId,
        Deno.env.get('ADS_CLIENT_SECRET') || '',
      );
      baseUrl = getAdsBaseUrl(account.region || 'NA');
      profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';
    } catch {}

    let migrated = 0, archived = 0, campaignsArchived = 0;

    for (const s of allSuggestions) {
      const keyword = (s.keyword || '').trim();
      if (!keyword || !s.asin) {
        // Arquivar direto se incompleto
        await base44.asServiceRole.entities.KeywordSuggestion.update(s.id, {
          status: 'archived_by_policy',
          archive_reason: 'Sugestão IA legada removida — sem keyword/ASIN válido',
          reactivation_blocked: true,
        }).catch(() => {});
        archived++;
        continue;
      }

      // Verificar se a campanha vinculada teve gasto
      const linkedCampaignId = s.created_campaign_id || s.amazon_campaign_id || s.source_campaign_id;
      const campaignSpend = linkedCampaignId ? (spendByCampaign[linkedCampaignId] || 0) : 0;

      if (campaignSpend > 0) {
        // Teve gasto → migrar para TermBank
        const tKey = `${s.asin}|${keyword.toLowerCase()}`;
        if (!termBankKeys.has(tKey)) {
          await base44.asServiceRole.entities.TermBank.create({
            amazon_account_id: aid,
            term: keyword,
            term_normalized: keyword.toLowerCase().trim(),
            asin: s.asin,
            sku: s.sku || '',
            product_name: s.product_name || '',
            match_type: (s.match_type || 'exact').toLowerCase(),
            recommended_match_type: s.recommended_match_type || 'EXACT',
            source: 'search_term_auto',
            status: 'active',
            confidence: s.ai_confidence || s.confidence || 0.8,
            spend: s.historical_spend || 0,
            sales: s.historical_sales || 0,
            orders: s.historical_orders || 0,
            campaign_id: linkedCampaignId || '',
            created_at: now,
          }).catch(() => {});
          termBankKeys.add(tKey);
          migrated++;
        }
      } else {
        // Sem gasto → arquivar campanha associada também
        if (linkedCampaignId && token) {
          // Buscar campanha local
          const localCamp = campaigns.find((c: any) =>
            c.campaign_id === linkedCampaignId ||
            c.amazon_campaign_id === linkedCampaignId
          );
          if (localCamp && !['archived'].includes((localCamp.state || localCamp.status || '').toLowerCase())) {
            const amazonId = localCamp.amazon_campaign_id || localCamp.campaign_id;
            if (amazonId) {
              const ok = await archiveCampaignOnAmazon(amazonId, token, baseUrl, profileId, clientId);
              if (ok) {
                await base44.asServiceRole.entities.Campaign.update(localCamp.id, {
                  status: 'archived', state: 'archived', archived: true, archived_at: now,
                  archive_reason: 'Campanha IA legada sem gasto — removida na limpeza',
                }).catch(() => {});
                campaignsArchived++;
              }
            }
            await new Promise(r => setTimeout(r, 300));
          }
        }
      }

      // Arquivar a sugestão em ambos os casos
      await base44.asServiceRole.entities.KeywordSuggestion.update(s.id, {
        status: 'archived_by_policy',
        archive_reason: campaignSpend > 0
          ? 'Migrada para TermBank — campanha com gasto preservada'
          : 'Sugestão IA legada sem performance — campanha arquivada',
        reactivation_blocked: true,
      }).catch(() => {});
      archived++;

      await new Promise(r => setTimeout(r, 100));
    }

    return Response.json({
      ok: true,
      total_suggestions: allSuggestions.length,
      archived,
      migrated_to_termbank: migrated,
      campaigns_archived: campaignsArchived,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});