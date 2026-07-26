/**
 * deduplicateAutoCampaignsByAsin
 * Para cada ASIN com mais de 1 campanha AUTO não-arquivada:
 * - Mantém a com maior spend (desempate: created_at mais antiga)
 * - Marca as demais como archived no banco
 * - Pausa as demais na Amazon via amazonAdsCommand (PAUSED, não ARCHIVED)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

const ASIN_REGEX = /B0[A-Z0-9]{8}/i;

function extractAsin(campaign: any): string | null {
  if (campaign.asin) return campaign.asin;
  const name = campaign.name || campaign.campaign_name || '';
  const match = name.match(ASIN_REGEX);
  return match ? match[0].toUpperCase() : null;
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const { amazon_account_id } = body;

    // Resolver conta
    let account: any;
    if (amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id }, null, 1);
      account = accs[0];
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({}, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta configurada' }, { status: 404 });

    const accountId = account.id;

    // Carregar todas as campanhas AUTO não-arquivadas
    const allCampaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: accountId, targeting_type: 'AUTO' }, null, 500
    ).catch(() => [] as any[]);

    const activeCampaigns = allCampaigns.filter((c: any) => {
      const s = (c.state || c.status || '').toLowerCase();
      return s !== 'archived';
    });

    // Agrupar por ASIN
    const byAsin = new Map<string, any[]>();
    for (const c of activeCampaigns) {
      const asin = extractAsin(c);
      if (!asin) continue;
      if (!byAsin.has(asin)) byAsin.set(asin, []);
      byAsin.get(asin)!.push(c);
    }

    const details: any[] = [];
    let totalDeduped = 0;

    for (const [asin, group] of byAsin) {
      if (group.length <= 1) continue;

      // Ordenar: maior spend primeiro, desempate por created_at mais antiga
      group.sort((a: any, b: any) => {
        const spendDiff = Number(b.spend || b.current_spend || 0) - Number(a.spend || a.current_spend || 0);
        if (spendDiff !== 0) return spendDiff;
        const dateA = new Date(a.created_at || a.created_date || 0).getTime();
        const dateB = new Date(b.created_at || b.created_date || 0).getTime();
        return dateA - dateB; // mais antiga primeiro (menor timestamp)
      });

      const canonical = group[0];
      const duplicates = group.slice(1);

      for (const dup of duplicates) {
        // 1. Marcar como archived no banco local
        await base44.asServiceRole.entities.Campaign.update(dup.id, {
          state: 'archived',
          status: 'archived',
          archive_reason: 'DUPLICATE_AUTO_CAMPAIGN_DEDUP',
          archived: true,
          archived_at: new Date().toISOString(),
        }).catch(() => {});

        // 2. Pausar na Amazon (não arquivar — apenas PAUSED)
        const amazonId = dup.amazon_campaign_id || dup.campaign_id;
        if (amazonId && String(amazonId) !== 'undefined' && String(amazonId) !== 'null') {
          await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
            _service_role: true,
            amazon_account_id: accountId,
            path: '/sp/campaigns',
            method: 'PUT',
            content_type: 'application/vnd.spCampaign.v3+json',
            payload: { campaigns: [{ campaignId: String(amazonId), state: 'PAUSED' }] },
          }).catch(() => {});
          await sleep(200);
        }

        details.push({
          asin,
          canonical_id: canonical.campaign_id,
          canonical_name: canonical.name || canonical.campaign_name,
          canonical_spend: Number(canonical.spend || 0),
          deduped_id: dup.campaign_id,
          deduped_name: dup.name || dup.campaign_name,
          deduped_spend: Number(dup.spend || 0),
        });
        totalDeduped++;
      }
    }

    return Response.json({
      ok: true,
      deduped: totalDeduped,
      asins_processed: byAsin.size,
      details,
      duration_ms: Date.now() - t0,
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});