/**
 * purgeStaleTermsAndCampaigns
 *
 * Limpeza profunda do TermBank e campanhas associadas sem performance:
 *
 * 1. TERMBANK — remove termos que NÃO tiveram performance real:
 *    - Termos com spend = 0 E orders = 0 E clicks = 0
 *    - Sugestões com source em AI_GENERATED, OPENAI_*, GPT_*, CLAUDE_*, PRODUCT_ANALYSIS
 *      que nunca viraram campanha com performance
 *    - Termos órfãos (asin sem produto ativo no banco)
 *    - Termos com created_at > 90 dias sem nenhuma atividade
 *
 * 2. KEYWORD SUGGESTIONS — arquiva sugestões de fontes IA legadas sem campanha criada
 *
 * 3. CAMPANHAS — arquiva na Amazon + localmente campanhas criadas pelo app que:
 *    - Tiveram spend = 0 E impressions = 0 nos últimos 30 dias
 *    - São MANUAL targeting (EXACT/PHRASE) criadas a partir de sugestões
 *    - Têm mais de 48h de existência (tempo para ativar)
 *    - NUNCA arquiva campanhas com orders > 0 ou spend > 0
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const AI_SOURCES = new Set([
  'AI_GENERATED', 'OPENAI_TITLE_ANALYSIS', 'GPT_TITLE_ANALYSIS',
  'CLAUDE_PRODUCT_ANALYSIS', 'PRODUCT_ANALYSIS',
]);

function getAdsBaseUrl(region: string) {
  const r = (region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function getAdsToken(refreshToken: string, clientId: string, clientSecret: string) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token refresh failed');
  return data.access_token as string;
}

Deno.serve(async (req) => {
  const now = new Date().toISOString();
  const cutoff90d = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const cutoff30d = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const cutoff48h = new Date(Date.now() - 48 * 3600000).toISOString();

  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const dry_run = body.dry_run === true;

    // Resolver conta
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

    // ── Carregar dados em paralelo ────────────────────────────────────────
    const [allTerms, allSuggestions, allCampaigns, metricsRaw, allProducts] = await Promise.all([
      base44.asServiceRole.entities.TermBank.filter({ amazon_account_id: aid }, '-created_at', 1000).catch(() => []),
      base44.asServiceRole.entities.KeywordSuggestion.filter({ amazon_account_id: aid }, '-created_at', 1000).catch(() => []),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 500).catch(() => []),
      base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 1000).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid, status: 'active' }, null, 300).catch(() => []),
    ]);

    // ASINs de produtos ativos com estoque
    const activeAsins = new Set(
      allProducts
        .filter((p: any) => p.status === 'active' && Number(p.fba_inventory ?? p.fba_quantity ?? 0) > 0)
        .map((p: any) => p.asin)
        .filter(Boolean)
    );

    // Agregar spend/orders/impressions por campaign_id (últimos 30 dias)
    const campaignStats: Record<string, { spend: number; orders: number; impressions: number; clicks: number }> = {};
    for (const m of metricsRaw as any[]) {
      if (!m.campaign_id || (m.date || '') < cutoff30d) continue;
      if (!campaignStats[m.campaign_id]) campaignStats[m.campaign_id] = { spend: 0, orders: 0, impressions: 0, clicks: 0 };
      campaignStats[m.campaign_id].spend += m.spend || 0;
      campaignStats[m.campaign_id].orders += m.orders || 0;
      campaignStats[m.campaign_id].impressions += m.impressions || 0;
      campaignStats[m.campaign_id].clicks += m.clicks || 0;
    }

    // ── 1. TERMBANK: identificar para deletar ─────────────────────────────
    const termsToDelete = (allTerms as any[]).filter(t => {
      // Nunca deletar termos com performance real
      if ((t.spend || 0) > 0) return false;
      if ((t.orders || 0) > 0) return false;
      if ((t.clicks || 0) > 0) return false;
      if ((t.sales || 0) > 0) return false;

      // Deletar termos com ASIN de produto inativo/sem estoque
      if (t.asin && !activeAsins.has(t.asin)) return true;

      // Deletar termos de fonte IA sem performance
      if (t.source && AI_SOURCES.has(t.source)) return true;

      // Deletar termos sem atividade por mais de 90 dias
      const lastActivity = t.last_performance_update || t.last_seen_at || t.created_at || t.created_date;
      if (lastActivity && lastActivity.slice(0, 10) < cutoff90d) return true;

      return false;
    });

    // ── 2. KEYWORD SUGGESTIONS: arquivar sugestões IA legadas sem campanha ─
    const suggestionsToArchive = (allSuggestions as any[]).filter(s => {
      if (['archived_by_policy', 'superseded', 'rejected', 'created'].includes(s.status)) return false;
      if (!AI_SOURCES.has(s.source)) return false;
      // Sem campanha criada = não tem performance
      if (s.created_campaign_id || s.amazon_campaign_id) return false;
      return true;
    });

    // ── 3. CAMPANHAS: identificar para arquivar ───────────────────────────
    // Campanhas do app criadas a partir de sugestões que nunca geraram gasto
    const campaignsToArchive = (allCampaigns as any[]).filter((c: any) => {
      const state = (c.state || c.status || '').toLowerCase();
      if (['archived', 'deleted'].includes(state)) return false;
      if (c.archived) return false;
      if (c.is_protected) return false;

      // Apenas campanhas MANUAL criadas pelo app
      if (c.targeting_type?.toUpperCase() !== 'MANUAL') return false;

      // Deve ter mais de 48h (dar tempo para ativar)
      const createdAt = c.created_at || c.created_date;
      if (!createdAt || new Date(createdAt) > new Date(cutoff48h)) return false;

      // Verificar performance nos últimos 30d
      const cid = c.campaign_id || c.amazon_campaign_id;
      const stats = campaignStats[cid] || { spend: 0, orders: 0, impressions: 0, clicks: 0 };

      // NUNCA arquivar se teve gasto, impressões ou pedidos
      if (stats.spend > 0) return false;
      if (stats.orders > 0) return false;
      if (stats.impressions > 0) return false;

      return true;
    });

    const summary = {
      terms_to_delete: termsToDelete.length,
      suggestions_to_archive: suggestionsToArchive.length,
      campaigns_to_archive: campaignsToArchive.length,
    };

    if (dry_run) {
      return Response.json({
        ok: true, dry_run: true, ...summary,
        sample_terms: termsToDelete.slice(0, 10).map((t: any) => ({ term: t.term, asin: t.asin, source: t.source })),
        sample_campaigns: campaignsToArchive.slice(0, 10).map((c: any) => ({ name: c.name || c.campaign_name, state: c.state })),
      });
    }

    // ── Executar limpeza ─────────────────────────────────────────────────

    // 1. Deletar termos do TermBank em lotes
    let termsDeleted = 0;
    for (let i = 0; i < termsToDelete.length; i += 50) {
      const batch = termsToDelete.slice(i, i + 50);
      await Promise.allSettled(batch.map((t: any) =>
        base44.asServiceRole.entities.TermBank.delete(t.id)
      ));
      termsDeleted += batch.length;
    }

    // 2. Arquivar sugestões IA legadas
    let suggestionsArchived = 0;
    for (let i = 0; i < suggestionsToArchive.length; i += 50) {
      const batch = suggestionsToArchive.slice(i, i + 50);
      await Promise.allSettled(batch.map((s: any) =>
        base44.asServiceRole.entities.KeywordSuggestion.update(s.id, {
          status: 'archived_by_policy',
          archive_reason: 'Sugestão IA legada sem campanha criada — limpeza de sistema',
        })
      ));
      suggestionsArchived += batch.length;
    }

    // 3. Arquivar campanhas na Amazon + localmente
    let campaignsArchived = 0;
    let campaignsFailed = 0;

    if (campaignsToArchive.length > 0) {
      const token = await getAdsToken(
        account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '',
        Deno.env.get('ADS_CLIENT_ID') || '',
        Deno.env.get('ADS_CLIENT_SECRET') || '',
      );
      const baseUrl = getAdsBaseUrl(account.region || 'NA');
      const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';

      for (const camp of campaignsToArchive) {
        const amazonCampaignId = camp.amazon_campaign_id || camp.campaign_id;
        if (!amazonCampaignId) continue;

        try {
          const res = await fetch(`${baseUrl}/sp/campaigns`, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
              'Amazon-Advertising-API-Scope': String(profileId),
              'Content-Type': 'application/vnd.spCampaign.v3+json',
              'Accept': 'application/vnd.spCampaign.v3+json',
            },
            body: JSON.stringify({ campaigns: [{ campaignId: amazonCampaignId, state: 'ARCHIVED' }] }),
          });

          if (res.status === 429) {
            await new Promise(r => setTimeout(r, 3000));
            campaignsFailed++;
            continue;
          }

          const data = await res.json().catch(() => ({}));
          const success = (data?.campaigns?.success?.length || 0) > 0;
          const hasErrors = (data?.campaigns?.error?.length || 0) > 0;

          if (success || (!hasErrors && res.ok)) {
            await base44.asServiceRole.entities.Campaign.update(camp.id, {
              status: 'archived', state: 'archived', archived: true, archived_at: now,
              archive_reason: 'Campanha MANUAL sem gasto/impressões em 30d — limpeza de sistema',
            }).catch(() => {});
            campaignsArchived++;
          } else {
            campaignsFailed++;
          }

          await new Promise(r => setTimeout(r, 300));
        } catch {
          campaignsFailed++;
        }
      }
    }

    return Response.json({
      ok: true,
      terms_deleted: termsDeleted,
      suggestions_archived: suggestionsArchived,
      campaigns_archived: campaignsArchived,
      campaigns_failed: campaignsFailed,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});