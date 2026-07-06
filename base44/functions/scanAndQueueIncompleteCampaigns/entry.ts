// Varre campanhas com status 'incomplete' no banco local e as enfileira para reparo automático.
// Chamado a cada 12 horas pela automação "Varredura de Campanhas Incompletas".
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });

    // 1. Buscar todas as contas ativas
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter(
      { status: 'connected' }, null, 50
    ).catch(() => []);

    if (!accounts.length) {
      return Response.json({ ok: true, message: 'Nenhuma conta conectada', queued: 0 });
    }

    let totalQueued = 0;
    let totalSkipped = 0;
    const report: any[] = [];

    for (const account of accounts) {
      const accountId = account.id;

      // 2. Buscar campanhas com status 'incomplete' no banco local
      const incompleteCampaigns = await base44.asServiceRole.entities.Campaign.filter({
        amazon_account_id: accountId,
        status: 'incomplete',
      }, '-updated_date', 200).catch(() => []);

      // Também buscar campanhas com state = 'incomplete'
      const incompleteCampaignsByState = await base44.asServiceRole.entities.Campaign.filter({
        amazon_account_id: accountId,
        state: 'incomplete',
      }, '-updated_date', 200).catch(() => []);

      // Deduplicar por campaign_id
      const allIncomplete = [...incompleteCampaigns, ...incompleteCampaignsByState];
      const seen = new Set<string>();
      const unique = allIncomplete.filter((c: any) => {
        const key = c.campaign_id || c.amazon_campaign_id || c.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      if (!unique.length) continue;

      // 3. Buscar itens já na fila (scheduled ou processing) para evitar duplicatas
      const existingQueue = await base44.asServiceRole.entities.AutoCampaignRepairQueue.filter({
        amazon_account_id: accountId,
        status: 'scheduled',
      }, null, 500).catch(() => []);

      const existingProcessing = await base44.asServiceRole.entities.AutoCampaignRepairQueue.filter({
        amazon_account_id: accountId,
        status: 'processing',
      }, null, 100).catch(() => []);

      const queuedCampaignIds = new Set([
        ...existingQueue.map((q: any) => String(q.campaign_id || '')),
        ...existingProcessing.map((q: any) => String(q.campaign_id || '')),
      ]);

      // 4. Enfileirar as que ainda não estão na fila
      const scheduledAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 min a partir de agora
      let accountQueued = 0;

      for (const campaign of unique) {
        const campaignId = String(campaign.campaign_id || campaign.amazon_campaign_id || '').trim();
        if (!campaignId || queuedCampaignIds.has(campaignId)) {
          totalSkipped++;
          continue;
        }

        const asin = String(campaign.asin || '').trim().toUpperCase();
        if (!asin) {
          totalSkipped++;
          continue;
        }

        await base44.asServiceRole.entities.AutoCampaignRepairQueue.create({
          amazon_account_id: accountId,
          campaign_id: campaignId,
          asin,
          sku: campaign.sku || null,
          status: 'scheduled',
          scheduled_at: scheduledAt,
          attempt_count: 0,
          max_attempts: 5,
          source: 'auto_scan',
          notes: `Detectada por varredura automática a cada 12h — ${new Date().toISOString()}`,
        }).catch(() => {});

        accountQueued++;
        totalQueued++;
      }

      report.push({
        account_id: accountId,
        seller_name: account.seller_name || accountId,
        incomplete_found: unique.length,
        queued: accountQueued,
        skipped_already_queued: unique.length - accountQueued,
      });
    }

    return Response.json({
      ok: true,
      scanned_accounts: accounts.length,
      total_queued: totalQueued,
      total_skipped: totalSkipped,
      report,
      next_repair_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Erro na varredura' }, { status: 500 });
  }
});