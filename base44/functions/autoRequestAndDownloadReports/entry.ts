/**
 * autoRequestAndDownloadReports
 * Pipeline completo: solicita relatórios Amazon Ads → aguarda → baixa → grava no banco.
 * Chamado por automação agendada (06:00 BRT). Não usa auth de usuário.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

async function invokeFunction(fnName: string, payload: any): Promise<any> {
  const appId = Deno.env.get('BASE44_APP_ID') || '';
  const url = `https://api.base44.app/api/apps/${appId}/functions/${fnName}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return await res.json().catch(() => ({}));
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  try {
    const base44 = createClientFromRequest(req);

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
      return Response.json({ ok: false, error: 'Credenciais Amazon Ads não configuradas' });
    }

    // ── Obter token ──
    const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenData.access_token) {
      return Response.json({ ok: false, error: `Token falhou: ${tokenData.error_description || tokenRes.status}` });
    }
    const token = tokenData.access_token;

    const region = (account.region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
    const adsBase = region.includes('EU')
      ? 'https://advertising-api-eu.amazon.com'
      : region.includes('FE')
      ? 'https://advertising-api-fe.amazon.com'
      : 'https://advertising-api.amazon.com';

    function fmt(d: Date) { return d.toISOString().slice(0, 10); }

    const endDate = new Date();
    endDate.setDate(endDate.getDate() - 1);
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 29);

    const REPORT_CONFIGS = [
      { key: 'campaigns', reportTypeId: 'spCampaigns', groupBy: ['campaign'], columns: ['date','campaignId','campaignName','campaignStatus','campaignBudgetAmount','impressions','clicks','cost','purchases1d','purchases7d','purchases14d','purchases30d','sales1d','sales7d','sales14d','sales30d','acosClicks14d','roasClicks14d'] },
      { key: 'searchTerms', reportTypeId: 'spSearchTerm', groupBy: ['searchTerm'], columns: ['date','campaignId','campaignName','adGroupId','adGroupName','keywordId','keyword','matchType','searchTerm','impressions','clicks','cost','purchases7d','purchases14d','purchases30d','sales7d','sales14d','sales30d','acosClicks14d','roasClicks14d'] },
      { key: 'products', reportTypeId: 'spAdvertisedProduct', groupBy: ['advertiser'], columns: ['date','campaignId','campaignName','adGroupId','adGroupName','advertisedAsin','advertisedSku','impressions','clicks','cost','purchases14d','purchases30d','sales14d','sales30d'] },
    ];

    const headers = {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': clientId,
      'Amazon-Advertising-API-Scope': profileId,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };

    // 1. Solicitar relatórios
    console.log('[autoReports] Solicitando relatórios...');
    const reportIds: Record<string, string> = {};

    await Promise.all(REPORT_CONFIGS.map(async (rc) => {
      try {
        const r = await fetch(`${adsBase}/reporting/reports`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            name: `SP_${rc.key}_${fmt(endDate)}_${Date.now()}`,
            startDate: fmt(startDate),
            endDate: fmt(endDate),
            configuration: {
              adProduct: 'SPONSORED_PRODUCTS',
              groupBy: rc.groupBy,
              columns: rc.columns,
              reportTypeId: rc.reportTypeId,
              timeUnit: 'DAILY',
              format: 'GZIP_JSON',
            },
          }),
        });
        const d = await r.json().catch(() => ({}));
        // 425 = duplicate — extrair reportId do erro
        if (!r.ok && r.status === 425) {
          const match = JSON.stringify(d).match(/[0-9a-f-]{36}/i);
          if (match) reportIds[rc.key] = match[0];
        } else if (d.reportId) {
          reportIds[rc.key] = d.reportId;
        }
        console.log(`[autoReports] ${rc.key}: ${reportIds[rc.key] || 'FALHOU'}`);
      } catch (e: any) {
        console.error(`[autoReports] ${rc.key} erro: ${e.message}`);
      }
    }));

    if (Object.keys(reportIds).length === 0) {
      return Response.json({ ok: false, error: 'Todos os relatórios falharam ao ser solicitados' });
    }

    // Salvar syncRun
    const syncRun = await base44.asServiceRole.entities.SyncRun.create({
      amazon_account_id: aid,
      operation: `autoReports:${fmt(endDate)}:${JSON.stringify(reportIds)}`,
      status: 'running',
      started_at: new Date().toISOString(),
    }).catch(() => null);

    // 2. Poll até relatórios ficarem prontos (até 20 min, a cada 3 min)
    const POLL_MS = 3 * 60 * 1000;
    const MAX_MS = 20 * 60 * 1000;
    const pollStart = Date.now();
    let downloadResult = null;

    while (Date.now() - pollStart < MAX_MS) {
      await new Promise(r => setTimeout(r, POLL_MS));
      console.log(`[autoReports] Verificando status (${Math.round((Date.now() - pollStart) / 60000)}min)...`);

      // Checar status de todos
      const statuses = await Promise.all(
        Object.entries(reportIds).map(async ([key, rid]) => {
          const r = await fetch(`${adsBase}/reporting/reports/${rid}`, { headers });
          const d = await r.json().catch(() => ({}));
          return { key, status: d.status, url: d.url };
        })
      );

      const ready = statuses.filter(s => s.status === 'COMPLETED' && s.url);
      const pending = statuses.filter(s => !['COMPLETED', 'FAILED', 'EXPIRED'].includes(s.status));

      if (pending.length > 0 && ready.length === 0) {
        console.log(`[autoReports] Ainda pendente: ${pending.map(s => s.key).join(', ')}`);
        continue;
      }
      if (ready.length === 0) {
        return Response.json({ ok: false, error: 'Todos os relatórios falharam/expiraram' });
      }

      // 3. Baixar e descomprimir relatórios prontos
      console.log(`[autoReports] Baixando ${ready.length} relatório(s)...`);
      const data: Record<string, any[]> = {};

      for (const s of ready) {
        try {
          const r = await fetch(s.url!);
          if (!r.ok) continue;
          const buf = await r.arrayBuffer();
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
          data[s.key] = JSON.parse(new TextDecoder().decode(merged));
          console.log(`[autoReports] ${s.key}: ${data[s.key].length} linhas`);
        } catch (e: any) {
          console.error(`[autoReports] download ${s.key}: ${e.message}`);
        }
      }

      if (Object.keys(data).length === 0) {
        return Response.json({ ok: false, error: 'Falha ao baixar relatórios' });
      }

      // 4. Limpar dados antigos e gravar tudo no banco
      const now = new Date().toISOString();

      // Limpar
      await Promise.all([
        base44.asServiceRole.entities.SearchTerm.deleteMany({ amazon_account_id: aid }),
        base44.asServiceRole.entities.AdsMetricsHistory.deleteMany({ amazon_account_id: aid }),
        base44.asServiceRole.entities.AdsReportRaw.deleteMany({ amazon_account_id: aid }),
      ]).catch(() => {});

      // AdsMetricsHistory
      const historyRecords: any[] = [];
      const seen = new Set<string>();

      for (const [key, rows] of Object.entries(data)) {
        for (const row of rows) {
          const date = row.date || fmt(endDate);
          const campaignId = String(row.campaignId || '');
          const adGroupId = String(row.adGroupId || '');
          const searchTerm = row.searchTerm || '';
          const keywordId = String(row.keywordId || '');
          const asin = row.advertisedAsin || '';
          const uniqueKey = `${date}|${key}|${campaignId}|${adGroupId}|${searchTerm}|${keywordId}|${asin}`;
          if (seen.has(uniqueKey)) continue;
          seen.add(uniqueKey);

          const spend = Number(row.cost) || 0;
          historyRecords.push({
            amazon_account_id: aid,
            date,
            campaign_id: campaignId,
            campaign_name: row.campaignName || '',
            ad_group_id: adGroupId,
            ad_group_name: row.adGroupName || '',
            keyword_id: keywordId,
            keyword_text: row.keyword || '',
            search_term: searchTerm,
            match_type: (row.matchType || '').toLowerCase(),
            advertised_asin: asin,
            advertised_sku: row.advertisedSku || '',
            report_type: key,
            impressions: Number(row.impressions) || 0,
            clicks: Number(row.clicks) || 0,
            spend,
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
          });
        }
      }

      for (let i = 0; i < historyRecords.length; i += 500) {
        await base44.asServiceRole.entities.AdsMetricsHistory.bulkCreate(historyRecords.slice(i, i + 500));
      }
      console.log(`[autoReports] AdsMetricsHistory: ${historyRecords.length}`);

      // SearchTerm
      const stRecords = historyRecords.filter(r => r.report_type === 'searchTerms').map(r => ({
        amazon_account_id: aid,
        date: r.date,
        campaign_id: r.campaign_id,
        campaign_name: r.campaign_name,
        ad_group_id: r.ad_group_id,
        ad_group_name: r.ad_group_name,
        keyword_id: r.keyword_id,
        keyword_text: r.keyword_text,
        keyword_type: '',
        match_type: r.match_type,
        search_term: r.search_term,
        advertised_asin: r.advertised_asin,
        advertised_sku: r.advertised_sku,
        impressions: r.impressions,
        clicks: r.clicks,
        ctr: r.impressions > 0 ? (r.clicks / r.impressions * 100) : 0,
        cpc: r.clicks > 0 ? (r.spend / r.clicks) : 0,
        spend: r.spend,
        orders_7d: r.orders_7d,
        orders_14d: r.orders_14d,
        orders_30d: r.orders_30d,
        sales_7d: r.sales_7d,
        sales_14d: r.sales_14d,
        sales_30d: r.sales_30d,
        acos_14d: r.acos_14d,
        roas_14d: r.roas_14d,
        conversion_rate: r.clicks > 0 ? (r.orders_14d / r.clicks * 100) : 0,
        unique_key: r.unique_key,
        synced_at: now,
      }));

      for (let i = 0; i < stRecords.length; i += 500) {
        await base44.asServiceRole.entities.SearchTerm.bulkCreate(stRecords.slice(i, i + 500));
      }

      // CampaignMetricsDaily — agregar por campaign+date (priorizar report_type=campaigns)
      const metricsMap = new Map<string, any>();
      for (const r of historyRecords) {
        if (!r.campaign_id) continue;
        const key2 = `${r.campaign_id}|${r.date}`;
        if (!metricsMap.has(key2)) {
          metricsMap.set(key2, { amazon_account_id: aid, campaign_id: r.campaign_id, campaign_name: r.campaign_name, date: r.date, spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0, _prio: false });
        }
        const m = metricsMap.get(key2)!;
        if (r.report_type === 'campaigns') {
          m.spend = r.spend; m.sales = r.sales_14d; m.clicks = r.clicks; m.impressions = r.impressions; m.orders = r.orders_14d; m._prio = true;
        } else if (!m._prio) {
          m.spend += r.spend; m.sales += r.sales_14d; m.clicks += r.clicks; m.impressions += r.impressions; m.orders += r.orders_14d;
        }
      }

      const metricsRecords = Array.from(metricsMap.values()).map(({ _prio, ...m }) => ({
        ...m,
        acos: m.sales > 0 ? (m.spend / m.sales * 100) : 0,
        roas: m.spend > 0 ? (m.sales / m.spend) : 0,
        ctr: m.impressions > 0 ? (m.clicks / m.impressions * 100) : 0,
        cpc: m.clicks > 0 ? (m.spend / m.clicks) : 0,
        synced_at: now,
      }));

      // Limpar CampaignMetricsDaily antes de inserir
      await base44.asServiceRole.entities.CampaignMetricsDaily.deleteMany({ amazon_account_id: aid }).catch(() => {});
      for (let i = 0; i < metricsRecords.length; i += 500) {
        await base44.asServiceRole.entities.CampaignMetricsDaily.bulkCreate(metricsRecords.slice(i, i + 500));
      }
      console.log(`[autoReports] CampaignMetricsDaily: ${metricsRecords.length}`);

      // Atualizar campanhas com métricas agregadas 30d
      const campAgg = new Map<string, any>();
      for (const r of historyRecords) {
        if (!r.campaign_id) continue;
        if (!campAgg.has(r.campaign_id)) campAgg.set(r.campaign_id, { spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0, name: r.campaign_name });
        const c = campAgg.get(r.campaign_id)!;
        c.spend += r.spend; c.sales += r.sales_14d; c.clicks += r.clicks; c.impressions += r.impressions; c.orders += r.orders_14d;
      }
      const existingCamps = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 5000).catch(() => []);
      const campMap = new Map(existingCamps.map((c: any) => [c.campaign_id, c]));
      const campUpdates = Array.from(campAgg.entries())
        .filter(([id]) => campMap.has(id))
        .map(([id, agg]) => {
          const existing = campMap.get(id)! as any;
          return {
            id: existing.id,
            spend: agg.spend,
            sales: agg.sales,
            clicks: agg.clicks,
            impressions: agg.impressions,
            orders: agg.orders,
            acos: agg.sales > 0 ? (agg.spend / agg.sales * 100) : 0,
            roas: agg.spend > 0 ? (agg.sales / agg.spend) : 0,
            ctr: agg.impressions > 0 ? (agg.clicks / agg.impressions * 100) : 0,
            cpc: agg.clicks > 0 ? (agg.spend / agg.clicks) : 0,
            synced_at: now,
          };
        });
      for (let i = 0; i < campUpdates.length; i += 500) {
        await base44.asServiceRole.entities.Campaign.bulkUpdate(campUpdates.slice(i, i + 500)).catch(() => {});
      }

      // Finalizar
      await base44.asServiceRole.entities.AmazonAccount.update(aid, {
        last_sync_at: now,
        status: 'connected',
      }).catch(() => {});

      if (syncRun) {
        await base44.asServiceRole.entities.SyncRun.update(syncRun.id, {
          status: 'success',
          records_upserted: historyRecords.length,
          completed_at: now,
          duration_ms: Date.now() - startTime,
        }).catch(() => {});
      }

      downloadResult = {
        ok: true,
        history_records: historyRecords.length,
        campaign_metrics: metricsRecords.length,
        search_terms: stRecords.length,
        duration_s: ((Date.now() - startTime) / 1000).toFixed(1),
      };
      break;
    }

    if (!downloadResult) {
      return Response.json({ ok: false, error: 'Timeout: relatórios não ficaram prontos em 20 min' });
    }

    console.log('[autoReports] ✅ Concluído:', JSON.stringify(downloadResult));
    return Response.json(downloadResult);

  } catch (err: any) {
    console.error('[autoReports] Erro crítico:', err.message);
    return Response.json({ ok: false, error: err.message });
  }
});