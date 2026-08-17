import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

/**
 * fixZeroCampaignBids
 *
 * Corrige bids de keywords SP Manual Exact com zero impressões e bid abaixo do mínimo competitivo.
 *
 * Payload:
 *   amazon_account_id: string
 *   dry_run?: boolean  — se true, retorna preview sem executar (default false)
 */

const MIN_COMPETITIVE_BID = 0.75;
const MAX_BID = 1.00;

// Detecção de categoria por keyword_text
function detectCategory(text) {
  const t = (text || '').toLowerCase();
  if (/lixeira|lixo/.test(t)) return { name: 'lixeira', bid: 1.20 };
  if (/fechadura/.test(t)) return { name: 'fechadura', bid: 1.50 };
  if (/headset|fone|gamer/.test(t)) return { name: 'headset', bid: 1.00 };
  if (/microfone/.test(t)) return { name: 'microfone', bid: 0.90 };
  return { name: 'outros', bid: 0.85 };
}

function calcNewBid(keyword) {
  // Se o bid registrado já é >= mínimo competitivo, usa ele (até o teto)
  const currentStoredBid = keyword.bid || keyword.current_bid || 0;
  if (currentStoredBid >= MIN_COMPETITIVE_BID) {
    return Math.min(currentStoredBid, MAX_BID);
  }
  const { bid: catBid } = detectCategory(keyword.keyword_text);
  return Math.min(catBid, MAX_BID);
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, dry_run = false } = body;

    if (!amazon_account_id) {
      return Response.json({ error: 'amazon_account_id obrigatório' }, { status: 400 });
    }

    // ── 1. Buscar todas as keywords habilitadas da conta ─────────────────────
    // Filtramos por state=enabled e baixo bid
    const allKeywords = await base44.asServiceRole.entities.Keyword.filter(
      { amazon_account_id, state: 'enabled' }, null, 2000
    );

    // ── 2. Buscar campanhas para verificar criação > 12h ─────────────────────
    const campaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id, targeting_type: 'MANUAL' }, null, 500
    );

    const now = Date.now();
    const twelveHoursMs = 12 * 3600 * 1000;

    // Mapas rápidos
    const campaignMap = new Map(campaigns.map(c => [c.campaign_id || c.amazon_campaign_id || c.id, c]));
    const campaignByDbId = new Map(campaigns.map(c => [c.id, c]));

    // ── 3. Filtrar keywords elegíveis ────────────────────────────────────────
    const eligible = [];

    for (const kw of allKeywords) {
      // Skip se já tem impressions > 0 ou spend > 0
      if ((kw.impressions || 0) > 0 || (kw.spend || 0) > 0) continue;

      // Skip se bid já está acima do mínimo competitivo
      const currentBid = kw.current_bid || kw.bid || 0;
      if (currentBid >= MIN_COMPETITIVE_BID) continue;

      // Verificar se campanha existe há mais de 12h
      const campaign = campaignMap.get(kw.campaign_id) || campaignByDbId.get(kw.campaign_id);
      if (!campaign) continue;

      const campaignCreatedAt = campaign.created_at || campaign.start_date;
      if (campaignCreatedAt) {
        const campaignAge = now - new Date(campaignCreatedAt).getTime();
        if (campaignAge < twelveHoursMs) continue; // Campanha muito nova
      } else {
        // Se não temos data de criação, considera elegível (campanha antiga)
      }

      // Skip campanhas archived
      if ((campaign.status || '').toLowerCase() === 'archived') continue;

      const newBid = calcNewBid(kw);
      const category = detectCategory(kw.keyword_text);

      eligible.push({
        keyword_id: kw.id,
        keyword_text: kw.keyword_text || '(sem texto)',
        match_type: kw.match_type || 'EXACT',
        current_bid: currentBid,
        new_bid: newBid,
        category: category.name,
        campaign_id: kw.campaign_id,
        campaign_name: campaign.campaign_name || campaign.name || kw.campaign_id,
        ad_group_id: kw.ad_group_id,
        asin: campaign.asin || '',
        amazon_keyword_id: kw.keyword_id || kw.amazon_keyword_id,
        amazon_campaign_id: campaign.campaign_id || campaign.amazon_campaign_id,
      });
    }

    // ── 4. Se dry_run, retornar preview ──────────────────────────────────────
    if (dry_run) {
      // Agrupar por campanha
      const byCampaign = {};
      for (const item of eligible) {
        const key = item.campaign_id;
        if (!byCampaign[key]) byCampaign[key] = { campaign_name: item.campaign_name, campaign_id: item.campaign_id, keywords: [] };
        byCampaign[key].keywords.push(item);
      }

      return Response.json({
        ok: true,
        dry_run: true,
        total_eligible: eligible.length,
        campaigns_affected: Object.keys(byCampaign).length,
        preview: Object.values(byCampaign),
      });
    }

    // ── 5. Executar: enviar novos bids para Amazon em lotes por campanha ─────
    if (eligible.length === 0) {
      return Response.json({ ok: true, total_analyzed: allKeywords.length, total_fixed: 0, total_skipped: 0, errors: [] });
    }

    // Agrupar por campaign_id para lotes
    const byCampaignId = new Map();
    for (const item of eligible) {
      if (!byCampaignId.has(item.campaign_id)) byCampaignId.set(item.campaign_id, []);
      byCampaignId.get(item.campaign_id).push(item);
    }

    let totalFixed = 0;
    const errors = [];
    const executedItems = [];

    for (const [campaignId, items] of byCampaignId.entries()) {
      // Montar payload para bulkAdjustKeywordBids
      const keywordUpdates = items
        .filter(i => i.amazon_keyword_id) // só com ID Amazon real
        .map(i => ({
          keyword_id: i.amazon_keyword_id,
          ad_group_id: i.ad_group_id,
          campaign_id: i.amazon_campaign_id,
          bid: i.new_bid,
          keyword_text: i.keyword_text,
        }));

      if (keywordUpdates.length === 0) {
        // Sem amazon_keyword_id — pular mas registrar
        for (const item of items) {
          errors.push({ keyword: item.keyword_text, campaign: item.campaign_name, reason: 'Sem amazon_keyword_id' });
        }
        continue;
      }

      try {
        const result = await base44.functions.invoke('bulkAdjustKeywordBids', {
          amazon_account_id,
          keywords: keywordUpdates,
        });

        const resultData = result?.data || result;
        const isOk = resultData?.ok || resultData?.success || resultData?.updated > 0;

        if (isOk) {
          // Atualizar banco para cada keyword
          for (const item of items.filter(i => i.amazon_keyword_id)) {
            await base44.asServiceRole.entities.Keyword.update(item.keyword_id, {
              bid: item.new_bid,
              current_bid: item.new_bid,
            }).catch(() => {});

            // Registrar em AdsBidChangeLog
            await base44.asServiceRole.entities.AdsBidChangeLog.create({
              amazon_account_id,
              campaign_id: item.campaign_id,
              campaign_name: item.campaign_name,
              ad_group_id: item.ad_group_id,
              keyword_id: item.amazon_keyword_id,
              keyword: item.keyword_text,
              keyword_text: item.keyword_text,
              asin: item.asin,
              old_bid: item.current_bid,
              new_bid: item.new_bid,
              bid_before: item.current_bid,
              bid_after: item.new_bid,
              change_amount: item.new_bid - item.current_bid,
              change_percent: item.current_bid > 0 ? ((item.new_bid - item.current_bid) / item.current_bid) * 100 : 100,
              direction: 'increase',
              action: 'increase_zero_impression_fix',
              reason: `zero_impressions_fix · categoria: ${item.category} · bid ${item.current_bid} → ${item.new_bid}`,
              classification: item.category,
              risk_level: 'low',
              status: 'executed',
              date: new Date().toISOString().slice(0, 10),
              created_at: new Date().toISOString(),
            }).catch(() => {});

            totalFixed++;
            executedItems.push(item);
          }
        } else {
          for (const item of items) {
            errors.push({ keyword: item.keyword_text, campaign: item.campaign_name, reason: resultData?.error || 'Erro na API Amazon' });
          }
        }
      } catch (e) {
        for (const item of items) {
          errors.push({ keyword: item.keyword_text, campaign: item.campaign_name, reason: e.message });
        }
      }
    }

    return Response.json({
      ok: true,
      dry_run: false,
      total_analyzed: allKeywords.length,
      total_eligible: eligible.length,
      total_fixed: totalFixed,
      total_skipped: eligible.length - totalFixed,
      errors,
      fixed_items: executedItems.slice(0, 50), // resumo dos primeiros 50
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
