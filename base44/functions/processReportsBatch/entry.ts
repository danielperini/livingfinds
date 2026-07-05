/**
 * processReportsBatch — Processa relatórios Amazon Ads baixados em lotes pequenos.
 *
 * Design one-step-per-call (sem timeout):
 *   step=0 → limpa dados antigos + prepara cursor
 *   step=1 → insere lote de AdsMetricsHistory (rows 0..BATCH_SIZE)
 *   step=2 → insere próximo lote de AdsMetricsHistory
 *   ...
 *   stepN → insere SearchTerm
 *   stepN+1 → insere CampaignMetricsDaily + atualiza Campaign + finaliza
 *
 * Estado salvo no SyncRun.operation como JSON para retomar entre chamadas.
 * A automação chama a cada 5 min; cada chamada processa 1 lote e retorna.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const BATCH_SIZE = 200; // registros por lote (seguro para rate limit)

function fmt(d: Date) { return d.toISOString().slice(0, 10); }

async function decompress(buf: ArrayBuffer): Promise<any[]> {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(new Uint8Array(buf));
  writer.close();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  return JSON.parse(new TextDecoder().decode(merged));
}

function buildHistoryRecord(row: any, key: string, aid: string, endDate: string, now: string) {
  const date = row.date || endDate;
  const campaignId = String(row.campaignId || '');
  const adGroupId = String(row.adGroupId || '');
  const searchTerm = row.searchTerm || '';
  const keywordId = String(row.keywordId || '');
  const asin = row.advertisedAsin || '';
  const uniqueKey = `${date}|${key}|${campaignId}|${adGroupId}|${searchTerm}|${keywordId}|${asin}`;
  return {
    amazon_account_id: aid,
    date, campaign_id: campaignId, campaign_name: row.campaignName || '',
    ad_group_id: adGroupId, ad_group_name: row.adGroupName || '',
    keyword_id: keywordId, keyword_text: row.keyword || '',
    search_term: searchTerm, match_type: (row.matchType || '').toLowerCase(),
    advertised_asin: asin, advertised_sku: row.advertisedSku || '',
    report_type: key,
    impressions: Number(row.impressions) || 0,
    clicks: Number(row.clicks) || 0,
    spend: Number(row.cost) || 0,
    orders_1d: Number(row.purchases1d) || 0,
    orders_7d: Number(row.purchases7d) || 0,
    orders_14d: Number(row.purchases14d) || 0,
    orders_30d: Number(row.purchases30d) || 0,
    sales_1d: Number(row.sales1d) || 0,
    sales_7d: Number(row.sales7d) || 0,
    sales_14d: Number(row.sales14d) || 0,
    sales_30d: Number(row.sales30d) || 0,
    acos_14d: Number(row.acosClicks14d) || 0,
    roas_14d: Number(row.roasClicks14d) || 0,
    unique_key: uniqueKey,
    synced_at: now,
    _uniqueKey: uniqueKey, // campo interno para dedup, não salvo
  };
}

Deno.serve(async (req) => {
  const startMs = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    // Resolver conta
    const accounts = await base44.asServiceRole.entities.AmazonAccount.list('-created_date', 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon encontrada' });

    const aid = account.id;
    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
    const clientSecret = Deno.env.get('ADS_CLIENT_SECRET') || '';

    if (!refreshToken || !profileId || !clientId || !clientSecret) {
      return Response.json({ ok: false, error: 'Credenciais não configuradas' });
    }

    // ── Encontrar SyncRun com relatórios prontos ──
    const runs = await base44.asServiceRole.entities.SyncRun.filter(
      { amazon_account_id: aid }, '-started_at', 10
    ).catch(() => []);

    // Procurar SyncRun "em processamento" (batch)
    let syncRun = (runs as any[]).find(r => r.operation?.startsWith('batchProcess:'));
    // Ou SyncRun "running" com relatórios (ainda não começou o batch)
    if (!syncRun) {
      syncRun = (runs as any[]).find(r => r.operation?.startsWith('adsReports:') && r.status === 'running');
    }

    if (!syncRun) {
      return Response.json({ ok: false, ready: false, message: 'Nenhum SyncRun pendente. Execute autoRequestAndDownloadReports primeiro.' });
    }

    const now = new Date().toISOString();

    // ── Inicialização: baixar relatórios e montar estado ──
    if (syncRun.operation?.startsWith('adsReports:')) {
      const match = syncRun.operation.match(/^adsReports:([^:]+):(.+)$/);
      if (!match) return Response.json({ ok: false, error: 'Formato de SyncRun inválido' });
      const endDate = match[1];
      const reportIds: Record<string, string> = JSON.parse(match[2]);

      // Obter token LWA
      const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }).toString(),
      });
      const tokenData = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok || !tokenData.access_token) {
        return Response.json({ ok: false, error: `Token falhou: ${tokenData.error_description || tokenRes.status}` });
      }
      const token = tokenData.access_token;
      const region = account.region || Deno.env.get('ADS_REGION') || 'NA';
      const r = region.toUpperCase();
      const adsBase = r.includes('EU') ? 'https://advertising-api-eu.amazon.com' : r.includes('FE') ? 'https://advertising-api-fe.amazon.com' : 'https://advertising-api.amazon.com';
      const adsHeaders: Record<string, string> = { Authorization: `Bearer ${token}`, 'Amazon-Advertising-API-ClientId': clientId, 'Amazon-Advertising-API-Scope': profileId, Accept: 'application/json' };

      // Verificar status dos relatórios
      const statuses = await Promise.all(
        Object.entries(reportIds).map(async ([key, rid]) => {
          const rs = await fetch(`${adsBase}/reporting/reports/${rid}`, { headers: adsHeaders });
          const d = await rs.json().catch(() => ({}));
          return { key, status: d.status, url: d.url };
        })
      );
      const ready = statuses.filter(s => s.status === 'COMPLETED' && s.url);
      const pending = statuses.filter(s => !['COMPLETED', 'FAILED', 'EXPIRED'].includes(s.status));

      if (pending.length > 0 && ready.length === 0) {
        return Response.json({ ok: true, ready: false, pending: pending.map(s => s.key), message: 'Relatórios ainda sendo gerados pela Amazon. Aguarde.' });
      }
      if (ready.length === 0) {
        await base44.asServiceRole.entities.SyncRun.update(syncRun.id, { status: 'error', error_message: 'Todos os relatórios falharam ou expiraram', completed_at: now }).catch(() => {});
        return Response.json({ ok: false, error: 'Todos os relatórios falharam' });
      }

      // Baixar e descomprimir
      const rawRows: any[] = [];
      for (const s of ready) {
        try {
          const dl = await fetch(s.url!);
          if (!dl.ok) throw new Error(`HTTP ${dl.status}`);
          const rows = await decompress(await dl.arrayBuffer());
          for (const row of rows) rawRows.push({ ...row, _reportKey: s.key });
          console.log(`[processReportsBatch] Baixado ${s.key}: ${rows.length} linhas`);
        } catch (e: any) { console.error(`[processReportsBatch] Falha download ${s.key}: ${e.message}`); }
      }

      if (rawRows.length === 0) return Response.json({ ok: false, error: 'Nenhuma linha nos relatórios baixados' });

      // Construir todos os registros de uma vez (só lógica, sem I/O)
      const seen = new Set<string>();
      const historyRecords: any[] = [];
      for (const row of rawRows) {
        const rec = buildHistoryRecord(row, row._reportKey, aid, endDate, now);
        if (seen.has(rec._uniqueKey)) continue;
        seen.add(rec._uniqueKey);
        const { _uniqueKey, ...clean } = rec;
        historyRecords.push(clean);
      }

      console.log(`[processReportsBatch] Total registros: ${historyRecords.length}. Iniciando batch...`);

      // Limpar dados antigos (uma vez só)
      await Promise.all([
        base44.asServiceRole.entities.AdsMetricsHistory.deleteMany({ amazon_account_id: aid }),
        base44.asServiceRole.entities.SearchTerm.deleteMany({ amazon_account_id: aid }),
        base44.asServiceRole.entities.CampaignMetricsDaily.deleteMany({ amazon_account_id: aid }),
      ]).catch(() => {});

      // Salvar estado do batch no SyncRun para retomar
      // Os dados ficam em AdsReportRaw para não perder em caso de falha
      await base44.asServiceRole.entities.AdsReportRaw.deleteMany({ amazon_account_id: aid }).catch(() => {});
      const STORE_BATCH = 200;
      for (let i = 0; i < historyRecords.length; i += STORE_BATCH) {
        await base44.asServiceRole.entities.AdsReportRaw.bulkCreate(
          historyRecords.slice(i, i + STORE_BATCH).map(r => ({
            amazon_account_id: aid,
            report_type: r.report_type,
            report_id: 'batch',
            report_date: r.date,
            period_start: endDate,
            period_end: endDate,
            raw_data: r,
            processed: false,
            synced_at: now,
          }))
        );
      }

      // Atualizar SyncRun para modo batch
      const state = { total: historyRecords.length, offset: 0, phase: 'history', endDate };
      await base44.asServiceRole.entities.SyncRun.update(syncRun.id, {
        operation: `batchProcess:${JSON.stringify(state)}`,
      }).catch(() => {});

      return Response.json({
        ok: true, phase: 'initialized', total_records: historyRecords.length,
        message: `Dados preparados. ${Math.ceil(historyRecords.length / BATCH_SIZE)} lotes de ${BATCH_SIZE} para processar.`,
        duration_s: ((Date.now() - startMs) / 1000).toFixed(1),
      });
    }

    // ── Processar próximo lote ──
    const stateMatch = syncRun.operation.match(/^batchProcess:(.+)$/);
    if (!stateMatch) return Response.json({ ok: false, error: 'Estado de batch inválido' });
    const state = JSON.parse(stateMatch[1]);
    const { total, offset, phase, endDate } = state;

    if (phase === 'history') {
      // Buscar lote de AdsReportRaw não processados
      const batch = await base44.asServiceRole.entities.AdsReportRaw.filter(
        { amazon_account_id: aid, processed: false }, 'report_date', BATCH_SIZE
      ).catch(() => []);

      if ((batch as any[]).length === 0) {
        // Fase history concluída — passar para aggregation
        const newState = { total, offset: 0, phase: 'aggregate', endDate };
        await base44.asServiceRole.entities.SyncRun.update(syncRun.id, {
          operation: `batchProcess:${JSON.stringify(newState)}`,
        }).catch(() => {});
        return Response.json({ ok: true, phase: 'history_done', message: 'AdsMetricsHistory completo. Próximo: agregação.' });
      }

      // Inserir em AdsMetricsHistory
      const records = (batch as any[]).map(r => r.raw_data);
      await base44.asServiceRole.entities.AdsMetricsHistory.bulkCreate(records).catch(() => {});

      // Marcar como processado
      await base44.asServiceRole.entities.AdsReportRaw.bulkUpdate(
        (batch as any[]).map(r => ({ id: r.id, processed: true }))
      ).catch(() => {});

      const newOffset = offset + (batch as any[]).length;
      const newState = { total, offset: newOffset, phase: 'history', endDate };
      await base44.asServiceRole.entities.SyncRun.update(syncRun.id, {
        operation: `batchProcess:${JSON.stringify(newState)}`,
      }).catch(() => {});

      const pct = total > 0 ? Math.round(newOffset / total * 100) : 0;
      console.log(`[processReportsBatch] history lote ${newOffset}/${total} (${pct}%)`);
      return Response.json({ ok: true, phase: 'history', inserted: (batch as any[]).length, offset: newOffset, total, pct, duration_s: ((Date.now() - startMs) / 1000).toFixed(1) });
    }

    if (phase === 'aggregate') {
      // Buscar todos os registros de AdsMetricsHistory para agregar
      const allHistory = await base44.asServiceRole.entities.AdsMetricsHistory.filter(
        { amazon_account_id: aid }, 'date', 5000
      ).catch(() => []);

      const histArr = allHistory as any[];

      // SearchTerm
      const stRecords = histArr.filter(r => r.report_type === 'searchTerms').map(r => ({
        amazon_account_id: aid,
        date: r.date, campaign_id: r.campaign_id, campaign_name: r.campaign_name,
        ad_group_id: r.ad_group_id, ad_group_name: r.ad_group_name,
        keyword_id: r.keyword_id, keyword_text: r.keyword_text, keyword_type: '',
        match_type: r.match_type, search_term: r.search_term,
        advertised_asin: r.advertised_asin, advertised_sku: r.advertised_sku,
        impressions: r.impressions, clicks: r.clicks,
        ctr: r.impressions > 0 ? (r.clicks / r.impressions * 100) : 0,
        cpc: r.clicks > 0 ? (r.spend / r.clicks) : 0,
        spend: r.spend,
        orders_7d: r.orders_7d, orders_14d: r.orders_14d, orders_30d: r.orders_30d,
        sales_7d: r.sales_7d, sales_14d: r.sales_14d, sales_30d: r.sales_30d,
        acos_14d: r.acos_14d, roas_14d: r.roas_14d,
        conversion_rate: r.clicks > 0 ? (r.orders_14d / r.clicks * 100) : 0,
        unique_key: r.unique_key, synced_at: now,
      }));

      for (let i = 0; i < stRecords.length; i += BATCH_SIZE) {
        await base44.asServiceRole.entities.SearchTerm.bulkCreate(stRecords.slice(i, i + BATCH_SIZE));
      }

      // CampaignMetricsDaily
      const metricsMap = new Map<string, any>();
      for (const r of histArr) {
        if (!r.campaign_id) continue;
        const k = `${r.campaign_id}|${r.date}`;
        if (!metricsMap.has(k)) metricsMap.set(k, { amazon_account_id: aid, campaign_id: r.campaign_id, campaign_name: r.campaign_name, date: r.date, spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0, _prio: false });
        const m = metricsMap.get(k)!;
        if (r.report_type === 'campaigns') { m.spend = r.spend; m.sales = r.sales_14d; m.clicks = r.clicks; m.impressions = r.impressions; m.orders = r.orders_14d; m._prio = true; }
        else if (!m._prio) { m.spend += r.spend; m.sales += r.sales_14d; m.clicks += r.clicks; m.impressions += r.impressions; m.orders += r.orders_14d; }
      }
      const metricsRecords = Array.from(metricsMap.values()).map(({ _prio, ...m }) => ({
        ...m,
        acos: m.sales > 0 ? (m.spend / m.sales * 100) : 0,
        roas: m.spend > 0 ? (m.sales / m.spend) : 0,
        ctr: m.impressions > 0 ? (m.clicks / m.impressions * 100) : 0,
        cpc: m.clicks > 0 ? (m.spend / m.clicks) : 0,
        synced_at: now,
      }));
      for (let i = 0; i < metricsRecords.length; i += BATCH_SIZE) {
        await base44.asServiceRole.entities.CampaignMetricsDaily.bulkCreate(metricsRecords.slice(i, i + BATCH_SIZE));
      }

      // Atualizar Campaign (métricas agregadas)
      const campAgg = new Map<string, any>();
      for (const r of histArr) {
        if (!r.campaign_id) continue;
        if (!campAgg.has(r.campaign_id)) campAgg.set(r.campaign_id, { spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0 });
        const c = campAgg.get(r.campaign_id)!;
        c.spend += r.spend; c.sales += r.sales_14d; c.clicks += r.clicks; c.impressions += r.impressions; c.orders += r.orders_14d;
      }
      const existingCamps = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 5000).catch(() => []);
      const campEntityMap = new Map((existingCamps as any[]).map(c => [c.campaign_id, c]));
      const campUpdates = Array.from(campAgg.entries()).filter(([id]) => campEntityMap.has(id)).map(([id, agg]) => {
        const ex = campEntityMap.get(id) as any;
        return { id: ex.id, spend: agg.spend, sales: agg.sales, clicks: agg.clicks, impressions: agg.impressions, orders: agg.orders, acos: agg.sales > 0 ? (agg.spend / agg.sales * 100) : 0, roas: agg.spend > 0 ? (agg.sales / agg.spend) : 0, synced_at: now };
      });
      for (let i = 0; i < campUpdates.length; i += BATCH_SIZE) {
        await base44.asServiceRole.entities.Campaign.bulkUpdate(campUpdates.slice(i, i + BATCH_SIZE)).catch(() => {});
      }

      // Finalizar
      await base44.asServiceRole.entities.AmazonAccount.update(aid, { last_sync_at: now, status: 'connected' }).catch(() => {});
      await base44.asServiceRole.entities.SyncRun.update(syncRun.id, {
        status: 'success',
        operation: `batchProcess:done:${endDate}`,
        records_upserted: histArr.length,
        completed_at: now,
        duration_ms: Date.now() - startMs,
      }).catch(() => {});

      console.log(`[processReportsBatch] ✅ Concluído: ${stRecords.length} searchTerms, ${metricsRecords.length} metricsDaily, ${campUpdates.length} campanhas`);
      return Response.json({
        ok: true, done: true, phase: 'complete',
        history_records: histArr.length,
        search_terms: stRecords.length,
        campaign_metrics: metricsRecords.length,
        campaigns_updated: campUpdates.length,
        duration_s: ((Date.now() - startMs) / 1000).toFixed(1),
      });
    }

    // Já finalizado
    return Response.json({ ok: true, done: true, message: 'Processamento já concluído.' });

  } catch (err: any) {
    console.error('[processReportsBatch] Erro:', err.message);
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
});