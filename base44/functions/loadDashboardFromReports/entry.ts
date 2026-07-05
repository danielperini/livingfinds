/**
 * loadDashboardFromReports
 *
 * Atualiza CampaignMetricsDaily a partir dos relatórios já baixados hoje
 * (AdsMetricsHistory) — SEM chamar a API Amazon.
 * Usa espaçamento de 20s entre escritas em lote para evitar rate/time limit.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BATCH = 100;
const WRITE_DELAY_MS = 20000; // 20s entre lotes de escrita

Deno.serve(async (request) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const auth = await base44.auth.isAuthenticated().catch(() => false);
    if (!auth && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    // Resolver conta
    let accountId = body.amazon_account_id;
    if (!accountId) {
      const me = await base44.auth.me().catch(() => null);
      if (me) {
        const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ user_id: me.id }, null, 1);
        accountId = accs[0]?.id;
      }
      if (!accountId) {
        const accs = await base44.asServiceRole.entities.AmazonAccount.list('-created_date', 1);
        accountId = accs[0]?.id;
      }
    }
    if (!accountId) return Response.json({ ok: false, error: 'Conta Amazon não encontrada' });

    // Buscar histórico disponível (AdsMetricsHistory) — relatórios já baixados
    console.log('[loadDashboard] Carregando AdsMetricsHistory...');
    const history = await base44.asServiceRole.entities.AdsMetricsHistory.filter(
      { amazon_account_id: accountId },
      '-date',
      10000
    ).catch(() => []);

    if (history.length === 0) {
      return Response.json({ ok: false, error: 'Nenhum dado de relatório encontrado. Execute scheduledAdsReportSync action=download primeiro.' });
    }

    console.log(`[loadDashboard] ${history.length} registros encontrados`);

    // Agregar por campaign_id + date (source campaigns report tem prioridade)
    const metricsMap = new Map<string, any>();
    const now = new Date().toISOString();

    for (const r of history) {
      if (!r.campaign_id || !r.date) continue;
      const key = `${r.campaign_id}|${r.date}`;
      if (!metricsMap.has(key)) {
        metricsMap.set(key, {
          amazon_account_id: accountId,
          campaign_id: r.campaign_id,
          campaign_name: r.campaign_name || null,
          date: r.date,
          spend: 0,
          sales: 0,
          clicks: 0,
          impressions: 0,
          orders: 0,
          _has_campaign_report: false,
        });
      }
      const m = metricsMap.get(key);
      // report_type "campaigns" tem os dados mais precisos — não somar por cima
      if (r.report_type === 'campaigns') {
        m.spend = Number(r.spend) || 0;
        m.sales = Number(r.sales_14d) || 0;
        m.clicks = Number(r.clicks) || 0;
        m.impressions = Number(r.impressions) || 0;
        m.orders = Number(r.orders_14d) || 0;
        m._has_campaign_report = true;
      } else if (!m._has_campaign_report) {
        m.spend += Number(r.spend) || 0;
        m.sales += Number(r.sales_14d) || 0;
        m.clicks += Number(r.clicks) || 0;
        m.impressions += Number(r.impressions) || 0;
        m.orders += Number(r.orders_14d) || 0;
      }
    }

    const newRecords = Array.from(metricsMap.values()).map((m) => {
      const { _has_campaign_report, ...rec } = m;
      return {
        ...rec,
        acos: rec.sales > 0 ? (rec.spend / rec.sales * 100) : 0,
        roas: rec.spend > 0 ? (rec.sales / rec.spend) : 0,
        ctr: rec.impressions > 0 ? (rec.clicks / rec.impressions * 100) : 0,
        cpc: rec.clicks > 0 ? (rec.spend / rec.clicks) : 0,
        source: 'ads_report',
        synced_at: now,
        updated_at: now,
      };
    });

    console.log(`[loadDashboard] ${newRecords.length} registros CampaignMetricsDaily a sincronizar`);

    // Carregar existentes para upsert
    const existing = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: accountId }, '-date', 10000
    ).catch(() => []);

    const existingByKey = new Map<string, any>();
    for (const row of existing) {
      const key = `${row.campaign_id}|${row.date}`;
      if (!existingByKey.has(key)) existingByKey.set(key, row);
    }

    const toCreate: any[] = [];
    const toUpdate: any[] = [];
    for (const rec of newRecords) {
      const key = `${rec.campaign_id}|${rec.date}`;
      const cur = existingByKey.get(key);
      if (cur) toUpdate.push({ id: cur.id, ...rec });
      else toCreate.push(rec);
    }

    console.log(`[loadDashboard] create=${toCreate.length} update=${toUpdate.length}`);

    // Escrever com pausa de 20s entre lotes para evitar rate/time limit
    let created = 0;
    let updated = 0;

    for (let i = 0; i < toCreate.length; i += BATCH) {
      await base44.asServiceRole.entities.CampaignMetricsDaily.bulkCreate(toCreate.slice(i, i + BATCH));
      created += Math.min(BATCH, toCreate.length - i);
      if (i + BATCH < toCreate.length) await wait(WRITE_DELAY_MS);
    }

    for (let i = 0; i < toUpdate.length; i += BATCH) {
      await base44.asServiceRole.entities.CampaignMetricsDaily.bulkUpdate(toUpdate.slice(i, i + BATCH));
      updated += Math.min(BATCH, toUpdate.length - i);
      if (i + BATCH < toUpdate.length) await wait(WRITE_DELAY_MS);
    }

    // Atualizar last_sync_at da conta
    await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
      last_sync_at: now,
      ads_metrics_last_sync_at: now,
    }).catch(() => {});

    const summary = {
      ok: true,
      source: 'AdsMetricsHistory',
      history_records_used: history.length,
      metrics_records: newRecords.length,
      created,
      updated,
      duration_s: ((Date.now() - startedAt) / 1000).toFixed(1),
    };

    console.log('[loadDashboard] concluído:', JSON.stringify(summary));
    return Response.json(summary);

  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao carregar dashboard de relatórios' }, { status: 500 });
  }
});