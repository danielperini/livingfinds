/**
 * snapshotHourlySalesPattern
 *
 * 1. Agrega HourlyMetric (28 dias) por day_of_week + hour
 * 2. Calcula peak_score, bid_multiplier, classification por slot
 * 3. Upsert em HourlySalesPattern
 * 4. Backup JSON no Google Drive
 *
 * Roda automaticamente todo dia às 02:00 BRT (sem botão na UI).
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

const DAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];

function r2(v: number): number { return parseFloat((v || 0).toFixed(4)); }

function classifyByPeakScore(score: number): string {
  if (score >= 80) return 'PEAK_ELITE';
  if (score >= 60) return 'PEAK_STRONG';
  if (score >= 40) return 'NORMAL';
  if (score >= 20) return 'WEAK';
  return 'LOSS';
}

// bid_multiplier: PEAK_ELITE até +20%, PEAK_STRONG até +12%, WEAK -8%, LOSS -15%
function calcBidMultiplier(classification: string, peakScore: number): number {
  if (classification === 'PEAK_ELITE')  return r2(1.0 + Math.min(0.20, peakScore / 500));
  if (classification === 'PEAK_STRONG') return r2(1.0 + Math.min(0.12, peakScore / 600));
  if (classification === 'WEAK')        return 0.92;
  if (classification === 'LOSS')        return 0.85;
  return 1.0;
}

Deno.serve(async (req: Request) => {
  const t0 = Date.now();
  const now = new Date().toISOString();
  const brtNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const todayBRT = brtNow.toISOString().slice(0, 10);

  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const isDry = body.dry_run === true;

    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    // Resolver conta
    let account: any;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1);
      account = accs[0];
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta conectada' }, { status: 404 });
    const aid = account.id;

    const WINDOW_DAYS = Number(body.window_days || 28);
    const cutoffDate = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString().slice(0, 10);

    // Carregar dados horários
    const hourlyMetrics: any[] = await base44.asServiceRole.entities.HourlyMetric.filter(
      { amazon_account_id: aid }, '-date', 5000
    ).catch(() => []);

    const windowMetrics = hourlyMetrics.filter((m: any) => (m.date || '').slice(0, 10) >= cutoffDate);

    // Agregar por day_of_week + hour
    const slotMap = new Map<string, any>();
    for (const m of windowMetrics) {
      const mDate = new Date(m.date || m.created_date || '');
      if (isNaN(mDate.getTime())) continue;
      const dow  = m.day_of_week ?? mDate.getDay();
      const hour = m.hour ?? mDate.getHours();
      const key  = `${dow}|${hour}`;
      if (!slotMap.has(key)) {
        slotMap.set(key, { day_of_week: dow, hour, orders: 0, sales: 0, spend: 0, clicks: 0, impressions: 0, occurrences: 0 });
      }
      const s = slotMap.get(key)!;
      s.orders      += Number(m.orders || m.conversions || 0);
      s.sales       += Number(m.sales  || m.revenue    || 0);
      s.spend       += Number(m.spend  || 0);
      s.clicks      += Number(m.clicks || 0);
      s.impressions += Number(m.impressions || 0);
      s.occurrences++;
    }

    // Target ACoS da conta
    const perfList: any[] = await base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, null, 1).catch(() => []);
    const TARGET_ACOS = Number(perfList[0]?.target_acos || 15);
    const totalOrders = Array.from(slotMap.values()).reduce((s, v) => s + v.orders, 0);

    // Calcular padrões
    const patterns: any[] = [];
    for (const [, s] of slotMap) {
      const cvr  = s.clicks > 0 ? s.orders / s.clicks : 0;
      const acos = s.sales  > 0 ? (s.spend / s.sales) * 100 : 0;
      const roas = s.spend  > 0 ? s.sales / s.spend : 0;
      const cpc  = s.clicks > 0 ? s.spend / s.clicks : 0;
      const aov  = s.orders > 0 ? s.sales / s.orders : 0;
      const ordersSharePct = totalOrders > 0 ? (s.orders / totalOrders) * 100 : 0;

      // Peak Score: share de vendas (40pts) + CVR (35pts) + ACoS Efficiency (25pts)
      const shareScore = Math.min(40, ordersSharePct * 8);
      const cvrScore   = Math.min(35, cvr * 3500);
      const acosScore  = acos > 0 && TARGET_ACOS > 0 ? Math.min(25, Math.max(0, (1 - acos / TARGET_ACOS) * 30)) : 0;
      const rawScore   = shareScore + cvrScore + acosScore;
      // Penalizar se poucas ocorrências (dados imaturos)
      const peakScore  = Math.round(Math.max(0, Math.min(100, s.occurrences >= 4 ? rawScore : rawScore * 0.5)));

      const classification = s.occurrences >= 2 ? classifyByPeakScore(peakScore) : 'INSUFFICIENT_DATA';
      const bidMultiplier  = s.occurrences >= 2 ? calcBidMultiplier(classification, peakScore) : 1.0;

      patterns.push({
        amazon_account_id: aid,
        day_of_week:  s.day_of_week,
        hour:         s.hour,
        slot_label:   `${DAY_LABELS[s.day_of_week]}_${s.hour}h`,
        orders:       s.orders,
        sales:        r2(s.sales),
        spend:        r2(s.spend),
        clicks:       s.clicks,
        impressions:  s.impressions,
        cvr:          r2(cvr),
        acos:         r2(acos),
        roas:         r2(roas),
        cpc:          r2(cpc),
        aov:          r2(aov),
        occurrences:  s.occurrences,
        orders_share_pct: r2(ordersSharePct),
        peak_score:      peakScore,
        classification,
        bid_multiplier:  r2(bidMultiplier),
        is_peak_hour:    classification === 'PEAK_ELITE' || classification === 'PEAK_STRONG',
        data_window_days: WINDOW_DAYS,
        last_computed_at: now,
      });
    }

    // Upsert em HourlySalesPattern
    if (!isDry) {
      const existing: any[] = await base44.asServiceRole.entities.HourlySalesPattern.filter(
        { amazon_account_id: aid }, null, 200
      ).catch(() => []);
      const existingMap = new Map<string, any>();
      for (const e of existing) existingMap.set(`${e.day_of_week}|${e.hour}`, e);

      for (const p of patterns) {
        const key = `${p.day_of_week}|${p.hour}`;
        if (existingMap.has(key)) {
          await base44.asServiceRole.entities.HourlySalesPattern.update(existingMap.get(key).id, p).catch(() => {});
        } else {
          await base44.asServiceRole.entities.HourlySalesPattern.create(p).catch(() => {});
        }
      }
    }

    // Backup Google Drive
    let driveFileId: string | null = null;
    let driveError: string | null = null;

    if (!isDry) {
      try {
        const conn = await base44.asServiceRole.connectors.getConnection('googledrive').catch(() => null);
        if (conn?.access_token) {
          const backupJson = JSON.stringify({
            computed_at: now, date: todayBRT, window_days: WINDOW_DAYS,
            total_slots: patterns.length,
            peak_elite:  patterns.filter((p: any) => p.classification === 'PEAK_ELITE').length,
            peak_strong: patterns.filter((p: any) => p.classification === 'PEAK_STRONG').length,
            target_acos: TARGET_ACOS,
            patterns,
          }, null, 2);

          const boundary = 'bf_boundary_lf';
          const meta = JSON.stringify({ name: `hourly_sales_pattern_${todayBRT}.json`, mimeType: 'application/json', description: `Padrão horário de vendas — ${todayBRT}` });
          const body2 = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${backupJson}\r\n--${boundary}--`;

          const uploadRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${conn.access_token}`,
              'Content-Type': `multipart/related; boundary=${boundary}`,
            },
            body: body2,
          });
          const uploaded = await uploadRes.json();
          driveFileId = uploaded.id || null;

          // Atualizar drive_backup_at nos padrões salvos
          if (driveFileId) {
            const saved: any[] = await base44.asServiceRole.entities.HourlySalesPattern.filter({ amazon_account_id: aid }, null, 200).catch(() => []);
            for (const e of saved) {
              await base44.asServiceRole.entities.HourlySalesPattern.update(e.id, { drive_backup_at: now, drive_file_id: driveFileId }).catch(() => {});
            }
          }
        }
      } catch (err: any) {
        driveError = String(err?.message || err).slice(0, 200);
      }

      // Log de execução
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: aid,
        operation: 'snapshotHourlySalesPattern',
        trigger_type: 'automatic',
        status: 'success',
        execution_date: todayBRT,
        started_at: new Date(t0).toISOString(),
        completed_at: now,
        duration_ms: Date.now() - t0,
        records_processed: patterns.length,
        result_summary: JSON.stringify({
          slots_computed: patterns.length,
          peak_elite:  patterns.filter((p: any) => p.classification === 'PEAK_ELITE').length,
          peak_strong: patterns.filter((p: any) => p.classification === 'PEAK_STRONG').length,
          window_days: WINDOW_DAYS,
          drive_file_id: driveFileId,
          drive_error: driveError,
        }),
      }).catch(() => {});
    }

    const peakElite  = patterns.filter((p: any) => p.classification === 'PEAK_ELITE');
    const peakStrong = patterns.filter((p: any) => p.classification === 'PEAK_STRONG');

    return Response.json({
      ok: true,
      dry_run: isDry,
      date: todayBRT,
      window_days: WINDOW_DAYS,
      slots_computed: patterns.length,
      peak_elite:  peakElite.length,
      peak_strong: peakStrong.length,
      normal:      patterns.filter((p: any) => p.classification === 'NORMAL').length,
      drive_file_id: driveFileId,
      drive_error: driveError,
      sample_peaks: [...peakElite, ...peakStrong]
        .sort((a: any, b: any) => b.peak_score - a.peak_score)
        .slice(0, 10)
        .map((p: any) => ({
          slot: p.slot_label, score: p.peak_score,
          orders_share: r2(p.orders_share_pct) + '%',
          cvr: (p.cvr * 100).toFixed(1) + '%',
          bid_multiplier: 'x' + p.bid_multiplier,
          classification: p.classification,
        })),
      duration_ms: Date.now() - t0,
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});