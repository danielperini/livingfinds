/**
 * downloadAndProcessAmazonAdsReportJob
 *
 * Baixa URL do relatório, descompacta GZIP_JSON, parseia e faz upsert em CampaignMetricsDaily.
 * Marca job como processed.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

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

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function bulkUpsertBatched(entity: any, records: any[], batchSize = 100) {
  for (let i = 0; i < records.length; i += batchSize) {
    await entity.bulkCreate(records.slice(i, i + batchSize));
    if (i + batchSize < records.length) await sleep(150);
  }
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    if (!body._service_role) {
      return Response.json({ ok: false, error: 'Uso interno apenas' }, { status: 403 });
    }

    const { job_id } = body;
    if (!job_id) return Response.json({ ok: false, error: 'job_id obrigatório' }, { status: 400 });

    const now = new Date().toISOString();

    // Carregar job
    const jobs = await base44.asServiceRole.entities.AmazonAdsReportJob.filter({ id: job_id }, null, 1);
    const job = jobs[0];
    if (!job) return Response.json({ ok: false, error: 'Job não encontrado' }, { status: 404 });

    if (!job.url) {
      // Verificar se URL expirou
      if (job.status === 'expired') {
        return Response.json({ ok: false, error: 'URL do relatório expirada — recriação necessária', expired: true });
      }
      return Response.json({ ok: false, error: 'Job sem URL de download ainda' });
    }

    // Verificar se URL expirou
    if (job.url_expires_at && job.url_expires_at < now) {
      await base44.asServiceRole.entities.AmazonAdsReportJob.update(job_id, {
        status: 'expired',
        error_message: 'URL de download expirou antes do download',
        updated_at: now,
      }).catch(() => {});
      return Response.json({ ok: false, error: 'URL do relatório expirada', expired: true });
    }

    // Marcar como downloading
    await base44.asServiceRole.entities.AmazonAdsReportJob.update(job_id, {
      status: 'downloaded',
      downloaded_at: now,
      updated_at: now,
    }).catch(() => {});

    // Baixar arquivo
    const dlRes = await fetch(job.url);
    if (!dlRes.ok) {
      await base44.asServiceRole.entities.AmazonAdsReportJob.update(job_id, {
        status: 'failed',
        error_message: `Falha ao baixar: HTTP ${dlRes.status}`,
        updated_at: now,
      }).catch(() => {});
      return Response.json({ ok: false, error: `Falha ao baixar relatório: HTTP ${dlRes.status}` });
    }

    const buf = await dlRes.arrayBuffer();
    const rows = await decompress(buf);

    console.log(`[downloadProcess] Job ${job_id}: ${rows.length} linhas no relatório`);

    if (rows.length === 0) {
      await base44.asServiceRole.entities.AmazonAdsReportJob.update(job_id, {
        status: 'processed',
        processed_at: now,
        records_processed: 0,
        updated_at: now,
      }).catch(() => {});
      return Response.json({ ok: true, records: 0, message: 'Relatório vazio processado' });
    }

    const accountId = job.amazon_account_id;
    const endDate = job.end_date;

    // Construir registros de métricas por data+campanha
    const metricsMap = new Map<string, any>();

    // Detectar tipo de relatório pelo conteúdo da primeira linha
    const firstRow = rows[0] || {};
    const isTargetingReport = 'targetingId' in firstRow || 'targetingExpression' in firstRow;
    const isKeywordsReport = 'keywordId' in firstRow && !isTargetingReport;
    const isSearchTermReport = 'searchTerm' in firstRow;

    for (const row of rows) {
      const date = row.date || endDate;
      const campaignId = String(row.campaignId || '');
      if (!campaignId) continue;

      // spTargeting: targetingId/targetingText/bid — excluir product targets (targetingExpression começa com 'asin=')
      // spKeywords: keywordId/keyword/keywordBid
      const targetingExpr = String(row.targetingExpression || '');
      const isProductTarget = isTargetingReport && (targetingExpr.startsWith('asin=') || targetingExpr.startsWith('similar-product'));

      const keywordId = String(row.targetingId || row.keywordId || '');
      const keywordText = row.targetingText || row.keyword || '';
      const bid = Number(row.bid || row.keywordBid) || 0;
      const matchType = (row.matchType || '').toLowerCase();

      // Para relatórios de keyword/targeting (excluindo product targets): popular entidade Keyword
      if ((isTargetingReport || isKeywordsReport) && keywordId && !isSearchTermReport && !isProductTarget) {
        const kwKey = `kw|${keywordId}|${date}`;
        if (!metricsMap.has(kwKey)) {
          metricsMap.set(kwKey, {
            _type: 'keyword',
            amazon_account_id: accountId,
            campaign_id: campaignId,
            campaign_name: row.campaignName || '',
            ad_group_id: String(row.adGroupId || ''),
            ad_group_name: row.adGroupName || '',
            keyword_id: keywordId,
            keyword_text: keywordText,
            match_type: matchType,
            bid,
            date,
            impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0,
          });
        }
        const kw = metricsMap.get(kwKey)!;
        kw.impressions += Number(row.impressions) || 0;
        kw.clicks += Number(row.clicks) || 0;
        kw.spend += Number(row.cost) || 0;
        kw.sales += Number(row.sales14d || row.sales7d || row.sales30d) || 0;
        kw.orders += Number(row.purchases14d || row.purchases7d || row.purchases30d) || 0;
        continue;
      }

      const key = `${campaignId}|${date}`;
      if (!metricsMap.has(key)) {
        metricsMap.set(key, {
          _type: 'campaign',
          amazon_account_id: accountId,
          campaign_id: campaignId,
          campaign_name: row.campaignName || '',
          date,
          impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0,
        });
      }

      const m = metricsMap.get(key)!;
      m.impressions += Number(row.impressions) || 0;
      m.clicks += Number(row.clicks) || 0;
      m.spend += Number(row.cost) || 0;
      m.sales += Number(row.sales14d || row.sales7d || row.sales30d) || 0;
      m.orders += Number(row.purchases14d || row.purchases7d || row.purchases30d) || 0;
    }

    // Separar registros por tipo
    const allEntries = Array.from(metricsMap.values());
    const keywordEntries = allEntries.filter(m => m._type === 'keyword');
    const campaignEntries = allEntries.filter(m => m._type !== 'keyword');

    // ── CampaignMetricsDaily ──
    const metricsRecords = campaignEntries.map(({ _type, ...m }) => ({
      ...m,
      acos: m.sales > 0 ? (m.spend / m.sales * 100) : 0,
      roas: m.spend > 0 ? (m.sales / m.spend) : 0,
      ctr: m.impressions > 0 ? (m.clicks / m.impressions * 100) : 0,
      cpc: m.clicks > 0 ? (m.spend / m.clicks) : 0,
    }));

    if (metricsRecords.length > 0) {
      // Purgar registros com mais de 90 dias (retenção de dados)
      const cutoff90d = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
      await base44.asServiceRole.entities.CampaignMetricsDaily.deleteMany({
        amazon_account_id: accountId,
        date: { $lt: cutoff90d },
      }).catch(() => {});
      await sleep(150);

      // Deletar apenas as datas cobertas por este relatório antes de reescrever
      const datesToReplace = [...new Set(metricsRecords.map((r: any) => r.date))];
      for (const d of datesToReplace) {
        await base44.asServiceRole.entities.CampaignMetricsDaily.deleteMany({ amazon_account_id: accountId, date: d }).catch(() => {});
        await sleep(80);
      }
      await bulkUpsertBatched(base44.asServiceRole.entities.CampaignMetricsDaily, metricsRecords);
      console.log(`[downloadProcess] CampaignMetricsDaily: ${metricsRecords.length} registros em ${datesToReplace.length} datas (retenção 90d)`);
    }

    // ── Keyword (spTargeting) — upsert por keyword_id ──
    if (keywordEntries.length > 0) {
      const existingKeywords = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId }, null, 5000).catch(() => []);
      const kwById = new Map((existingKeywords as any[]).map(k => [String(k.keyword_id), k]));

      // Agregar por keyword_id (soma 30d)
      const kwAgg = new Map<string, any>();
      for (const kw of keywordEntries) {
        if (!kwAgg.has(kw.keyword_id)) {
          kwAgg.set(kw.keyword_id, { ...kw, spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0 });
        }
        const a = kwAgg.get(kw.keyword_id)!;
        a.spend += kw.spend; a.sales += kw.sales; a.clicks += kw.clicks; a.impressions += kw.impressions; a.orders += kw.orders;
        if (kw.bid > 0) a.bid = kw.bid; // manter bid mais recente
      }

      const kwCreates: any[] = [];
      const kwUpdates: any[] = [];
      for (const [kid, agg] of kwAgg.entries()) {
        const { _type, date, ...baseFields } = agg;
        const record = {
          ...baseFields,
          acos: agg.sales > 0 ? agg.spend / agg.sales * 100 : 0,
          roas: agg.spend > 0 ? agg.sales / agg.spend : 0,
          ctr: agg.impressions > 0 ? agg.clicks / agg.impressions * 100 : 0,
          cpc: agg.clicks > 0 ? agg.spend / agg.clicks : 0,
          synced_at: now,
        };
        const existing = kwById.get(kid);
        if (existing) kwUpdates.push({ id: existing.id, ...record });
        else kwCreates.push(record);
      }
      await bulkUpsertBatched(base44.asServiceRole.entities.Keyword, kwCreates);
      if (kwUpdates.length > 0) {
        for (let i = 0; i < kwUpdates.length; i += 100) {
          await base44.asServiceRole.entities.Keyword.bulkUpdate(kwUpdates.slice(i, i + 100)).catch(() => {});
          if (i + 100 < kwUpdates.length) await sleep(150);
        }
      }
      console.log(`[downloadProcess] Keyword (spTargeting): ${kwCreates.length} criadas + ${kwUpdates.length} atualizadas`);
    }

    // ── Atualizar métricas agregadas em Campaign ──
    const campAgg = new Map<string, any>();
    for (const m of campaignEntries) {
      if (!campAgg.has(m.campaign_id)) campAgg.set(m.campaign_id, { spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0 });
      const c = campAgg.get(m.campaign_id)!;
      c.spend += m.spend; c.sales += m.sales; c.clicks += m.clicks; c.impressions += m.impressions; c.orders += m.orders;
    }

    const existingCamps = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, null, 5000).catch(() => []);
    const campMap = new Map((existingCamps as any[]).map(c => [c.campaign_id, c]));
    const campUpdates = Array.from(campAgg.entries())
      .filter(([id]) => campMap.has(id))
      .map(([id, agg]) => {
        const existing = campMap.get(id) as any;
        return {
          id: existing.id,
          spend: agg.spend, sales: agg.sales, clicks: agg.clicks, impressions: agg.impressions, orders: agg.orders,
          acos: agg.sales > 0 ? (agg.spend / agg.sales * 100) : 0,
          roas: agg.spend > 0 ? (agg.sales / agg.spend) : 0,
          ctr: agg.impressions > 0 ? (agg.clicks / agg.impressions * 100) : 0,
          cpc: agg.clicks > 0 ? (agg.spend / agg.clicks) : 0,
          synced_at: now,
        };
      });

    if (campUpdates.length > 0) {
      for (let i = 0; i < campUpdates.length; i += 100) {
        await base44.asServiceRole.entities.Campaign.bulkUpdate(campUpdates.slice(i, i + 100)).catch(() => {});
        if (i + 100 < campUpdates.length) await sleep(150);
      }
    }
    console.log(`[downloadProcess] Campaign: ${campUpdates.length} atualizadas`);

    // Atualizar job como processed
    await base44.asServiceRole.entities.AmazonAdsReportJob.update(job_id, {
      status: 'processed',
      processed_at: now,
      records_processed: metricsRecords.length + keywordEntries.length,
      updated_at: now,
    }).catch(() => {});

    // Atualizar last_sync_at da conta + sinalizar dados frescos para todas as páginas
    await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
      last_sync_at: now,
      status: 'connected',
      ads_metrics_last_sync_at: now,
      ads_data_fresh_at: now,
    }).catch(() => {});

    // Registrar SyncExecutionLog
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'ads_sync',
      trigger_type: 'automatic',
      status: 'success',
      execution_date: now.slice(0, 10),
      started_at: now,
      completed_at: now,
      records_processed: metricsRecords.length,
      duration_ms: Date.now() - t0,
    }).catch(() => {});

    // ── Atualizar HourlySalesPattern quando o relatório tiver dados por ASIN (spAdvertisedProduct) ──
    if (job.report_type_id === 'spAdvertisedProduct' && rows.some((r: any) => r.advertisedAsin)) {
      console.log('[downloadProcess] Atualizando HourlySalesPattern a partir de spAdvertisedProduct...');
      try {
        // Carregar target_acos
        const perfList = await base44.asServiceRole.entities.PerformanceSettings
          .filter({ amazon_account_id: accountId }, null, 1).catch(() => []);
        const targetAcos = Number((perfList as any[])[0]?.target_acos || 15);

        // Agregar por day_of_week + hour (via data, sem hora — mapear por dia da semana)
        const slotMap = new Map<string, any>();
        const DAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
        for (const r of rows) {
          const date = r.date || '';
          if (!date) continue;
          const d = new Date(date);
          if (isNaN(d.getTime())) continue;
          const dow = d.getDay();
          // Sem granularidade horária real neste relatório — usar hora 0 como agregado do dia
          // O snapshotHourlySalesPattern existente já usa HourlyMetric com hora real
          // Aqui populamos apenas o padrão de dia-da-semana (hour=0) com dados ASIN
          const key = `${dow}|0`;
          if (!slotMap.has(key)) {
            slotMap.set(key, { day_of_week: dow, hour: 0, orders: 0, sales: 0, spend: 0, clicks: 0, impressions: 0, occurrences: 0 });
          }
          const s = slotMap.get(key)!;
          s.orders      += Number(r.purchases14d || r.purchases7d || 0);
          s.sales       += Number(r.sales14d || r.sales7d || 0);
          s.spend       += Number(r.cost || 0);
          s.clicks      += Number(r.clicks || 0);
          s.impressions += Number(r.impressions || 0);
          s.occurrences++;
        }

        const totalOrders = Array.from(slotMap.values()).reduce((s, v) => s + v.orders, 0);
        const patterns: any[] = [];
        const nowPat = new Date().toISOString();

        for (const [, s] of slotMap) {
          const cvr  = s.clicks > 0 ? s.orders / s.clicks : 0;
          const acos = s.sales  > 0 ? (s.spend / s.sales) * 100 : 0;
          const roas = s.spend  > 0 ? s.sales / s.spend : 0;
          const cpc  = s.clicks > 0 ? s.spend / s.clicks : 0;
          const aov  = s.orders > 0 ? s.sales / s.orders : 0;
          const ordersSharePct = totalOrders > 0 ? (s.orders / totalOrders) * 100 : 0;
          const shareScore = Math.min(40, ordersSharePct * 8);
          const cvrScore   = Math.min(35, cvr * 3500);
          const acosScore  = acos > 0 && targetAcos > 0 ? Math.min(25, Math.max(0, (1 - acos / targetAcos) * 30)) : 0;
          const rawScore   = shareScore + cvrScore + acosScore;
          const peakScore  = Math.round(Math.max(0, Math.min(100, s.occurrences >= 4 ? rawScore : rawScore * 0.5)));
          const classifyFn = (sc: number) => sc >= 80 ? 'PEAK_ELITE' : sc >= 60 ? 'PEAK_STRONG' : sc >= 40 ? 'NORMAL' : sc >= 20 ? 'WEAK' : 'LOSS';
          const classification = s.occurrences >= 2 ? classifyFn(peakScore) : 'INSUFFICIENT_DATA';
          const bm = classification === 'PEAK_ELITE' ? parseFloat((1.0 + Math.min(0.20, peakScore / 500)).toFixed(4))
                   : classification === 'PEAK_STRONG' ? parseFloat((1.0 + Math.min(0.12, peakScore / 600)).toFixed(4))
                   : classification === 'WEAK' ? 0.92 : classification === 'LOSS' ? 0.85 : 1.0;
          patterns.push({
            amazon_account_id: accountId,
            day_of_week: s.day_of_week, hour: s.hour,
            slot_label: `${DAY_LABELS[s.day_of_week]}_dia`,
            orders: s.orders, sales: parseFloat(s.sales.toFixed(4)), spend: parseFloat(s.spend.toFixed(4)),
            clicks: s.clicks, impressions: s.impressions, cvr: parseFloat(cvr.toFixed(4)),
            acos: parseFloat(acos.toFixed(4)), roas: parseFloat(roas.toFixed(4)),
            cpc: parseFloat(cpc.toFixed(4)), aov: parseFloat(aov.toFixed(4)),
            occurrences: s.occurrences, orders_share_pct: parseFloat(ordersSharePct.toFixed(4)),
            peak_score: peakScore, classification, bid_multiplier: bm,
            is_peak_hour: classification === 'PEAK_ELITE' || classification === 'PEAK_STRONG',
            data_window_days: 14, last_computed_at: nowPat,
          });
        }

        // Upsert
        const existing: any[] = await base44.asServiceRole.entities.HourlySalesPattern
          .filter({ amazon_account_id: accountId }, null, 200).catch(() => []);
        const existingMap = new Map(existing.map((e: any) => [`${e.day_of_week}|${e.hour}`, e]));
        for (const p of patterns) {
          const k = `${p.day_of_week}|${p.hour}`;
          if (existingMap.has(k)) {
            await base44.asServiceRole.entities.HourlySalesPattern.update((existingMap.get(k) as any).id, p).catch(() => {});
          } else {
            await base44.asServiceRole.entities.HourlySalesPattern.create(p).catch(() => {});
          }
        }
        console.log(`[downloadProcess] HourlySalesPattern: ${patterns.length} slots atualizados`);

        // Disparo de dayparting se slot atual for ELITE/STRONG e dayparting habilitado
        const autopilotList = await base44.asServiceRole.entities.AutopilotConfig
          .filter({ amazon_account_id: accountId }, null, 1).catch(() => []);
        const daypartingEnabled = (autopilotList as any[])[0]?.dayparting_enabled !== false;
        if (daypartingEnabled) {
          const brtNow = new Date(Date.now() - 3 * 3600000);
          const brtHour = brtNow.getUTCHours();
          const brtDow  = brtNow.getUTCDay();
          const currentSlot = patterns.find(p => p.day_of_week === brtDow && p.hour === brtHour);
          const isElite = currentSlot && (currentSlot.classification === 'PEAK_ELITE' || currentSlot.classification === 'PEAK_STRONG');
          if (isElite) {
            const acos14d = (() => {
              const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
              const recent = allEntries.filter(m => m._type !== 'keyword' && (m.date || '') >= cutoff);
              const ts = recent.reduce((s: number, m: any) => s + m.spend, 0);
              const tv = recent.reduce((s: number, m: any) => s + m.sales, 0);
              return tv > 0 ? (ts / tv) * 100 : 0;
            })();
            if (acos14d === 0 || acos14d <= targetAcos * 1.20) {
              base44.asServiceRole.functions.invoke('runDaypartingDecisionEngine', {
                amazon_account_id: accountId, dry_run: false, _service_role: true,
              }).catch((e: any) => console.warn('[downloadProcess] Dayparting (não crítico):', e.message));
              console.log(`[downloadProcess] ✓ Dayparting disparado — slot ${brtDow}|${brtHour} = ${currentSlot.classification}`);
            }
          }
        }
      } catch (patErr: any) {
        console.warn('[downloadProcess] HourlySalesPattern update (não crítico):', patErr.message);
      }
    }

    // Disparar motor de decisão com os dados recém-processados
    // Só para relatórios de campanha (spCampaigns) — são os que têm métricas diárias completas
    if ((metricsRecords.length > 0 || campUpdates.length > 0) && (job.report_type_id === 'spCampaigns' || !job.report_type_id)) {
      console.log(`[downloadProcess] Disparando motor de decisão após processamento de ${metricsRecords.length} registros`);
      base44.asServiceRole.functions.invoke('runFullAccountOptimizationWithNewLogic', {
        amazon_account_id: accountId,
        trigger: 'report_processed',
        _service_role: true,
      }).catch((e: any) => console.warn('[downloadProcess] Motor de decisão (não crítico):', e.message));
    }

    return Response.json({
      ok: true,
      job_id,
      report_type_id: job.report_type_id,
      records: metricsRecords.length,
      campaigns_updated: campUpdates.length,
      duration_ms: Date.now() - t0,
      message: 'Relatório pronto e processado.',
    });

  } catch (err: any) {
    console.error('[downloadProcess] Erro:', err.message);
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
});