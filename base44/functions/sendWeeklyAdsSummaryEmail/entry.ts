import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

function fmtBRL(v: number): string {
  if (!v || !isFinite(v)) return 'R$ 0,00';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}
function fmtPct(v: number): string {
  if (!v || !isFinite(v)) return '—';
  return `${Number(v).toFixed(1)}%`;
}
function fmtNum(v: number): string {
  if (!v || !isFinite(v)) return '0';
  return Number(v).toLocaleString('pt-BR');
}
function fmtDate(iso: string): string {
  if (!iso) return '';
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}
function getYesterdayBRT(): string {
  const nowBRT = new Date(Date.now() - 3 * 3600000);
  const d = nowBRT.toISOString().slice(0, 10);
  const date = new Date(d + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}
function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function buildHtml(opts: any): string {
  const {
    weekStart, weekEnd, spend, adsSales, realSales, realSalesSource,
    acos, roas, tacos, orders, units, profitable, unprofitable,
    decisionsExecuted, executiveSummary, targetAcos, targetRoas, targetTacos,
  } = opts;

  const acosColor = acos > 0 && targetAcos > 0
    ? (acos <= targetAcos ? '#10B981' : acos <= targetAcos * 1.3 ? '#F59E0B' : '#EF4444')
    : '#64748B';
  const roasColor = roas > 0 && targetRoas > 0 ? (roas >= targetRoas ? '#10B981' : '#EF4444') : '#64748B';
  const tacosColor = tacos > 0 && targetTacos > 0
    ? (tacos <= targetTacos ? '#10B981' : tacos <= targetTacos * 1.3 ? '#F59E0B' : '#EF4444')
    : '#64748B';

  const realSalesDisplay = realSalesSource === 'none'
    ? '<span style="color:#94A3B8;font-size:11px">— aguardando sincronização SP-API</span>'
    : fmtBRL(realSales);

  const now = new Date().toLocaleDateString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
  });

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Resumo Semanal LivingFinds</title></head>
<body style="margin:0;padding:0;background:#0B1120;font-family:'Inter',Arial,sans-serif;color:#F8FAFC;">
<div style="max-width:600px;margin:0 auto;padding:24px 16px;">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#1E3A8A,#1D4ED8);border-radius:16px;padding:24px 28px;margin-bottom:20px;">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
      <div style="width:40px;height:40px;background:rgba(255,255,255,0.15);border-radius:10px;font-size:20px;text-align:center;line-height:40px;">📊</div>
      <div>
        <h1 style="margin:0;font-size:20px;font-weight:800;color:#FFFFFF;">LivingFinds</h1>
        <p style="margin:0;font-size:12px;color:#93C5FD;">Resumo Semanal de Anúncios</p>
      </div>
    </div>
    <p style="margin:8px 0 0;font-size:14px;color:#DBEAFE;">Semana: ${fmtDate(weekStart)} a ${fmtDate(weekEnd)}</p>
  </div>

  <!-- 3 KPI Cards -->
  <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
    <tr>
      <td style="width:33%;padding-right:6px;">
        <div style="background:#111827;border:1px solid #1E3A8A;border-radius:12px;padding:16px;text-align:center;">
          <p style="margin:0 0 6px;font-size:10px;color:#64748B;text-transform:uppercase;letter-spacing:0.05em;">GASTO ADS</p>
          <p style="margin:0;font-size:20px;font-weight:800;color:#3B82F6;">${fmtBRL(spend)}</p>
        </div>
      </td>
      <td style="width:33%;padding:0 3px;">
        <div style="background:#111827;border:1px solid #92400E;border-radius:12px;padding:16px;text-align:center;">
          <p style="margin:0 0 6px;font-size:10px;color:#64748B;text-transform:uppercase;letter-spacing:0.05em;">FAT. REAL</p>
          <p style="margin:0;font-size:20px;font-weight:800;color:#FB923C;">${realSalesSource === 'none' ? '—' : fmtBRL(realSales)}</p>
        </div>
      </td>
      <td style="width:33%;padding-left:6px;">
        <div style="background:#111827;border:1px solid ${acosColor}40;border-radius:12px;padding:16px;text-align:center;">
          <p style="margin:0 0 6px;font-size:10px;color:#64748B;text-transform:uppercase;letter-spacing:0.05em;">ACoS</p>
          <p style="margin:0;font-size:20px;font-weight:800;color:${acosColor};">${fmtPct(acos)}</p>
          ${targetAcos > 0 ? `<p style="margin:4px 0 0;font-size:10px;color:#64748B;">Meta: ${targetAcos}%</p>` : ''}
        </div>
      </td>
    </tr>
  </table>

  <!-- Tabela comparativa -->
  <div style="background:#111827;border:1px solid #1E2A40;border-radius:12px;overflow:hidden;margin-bottom:20px;">
    <div style="padding:16px 20px;border-bottom:1px solid #1E2A40;">
      <h2 style="margin:0;font-size:14px;font-weight:700;color:#F8FAFC;">Comparativo da semana</h2>
    </div>
    <table style="width:100%;border-collapse:collapse;">
      <tr style="border-bottom:1px solid #1E2A40;">
        <td style="padding:12px 20px;font-size:12px;color:#94A3B8;">Gasto em Anúncios</td>
        <td style="padding:12px 20px;font-size:13px;font-weight:700;color:#3B82F6;text-align:right;">${fmtBRL(spend)}</td>
      </tr>
      <tr style="border-bottom:1px solid #1E2A40;">
        <td style="padding:12px 20px;font-size:12px;color:#94A3B8;">Vendas Ads (atribuição Amazon)</td>
        <td style="padding:12px 20px;font-size:13px;font-weight:700;color:#10B981;text-align:right;">${fmtBRL(adsSales)}</td>
      </tr>
      <tr style="border-bottom:1px solid #1E2A40;">
        <td style="padding:12px 20px;font-size:12px;color:#94A3B8;">Faturamento Real (SP-API)</td>
        <td style="padding:12px 20px;font-size:13px;font-weight:700;color:#FB923C;text-align:right;">${realSalesDisplay}</td>
      </tr>
      <tr style="border-bottom:1px solid #1E2A40;">
        <td style="padding:12px 20px;font-size:12px;color:#94A3B8;">ACoS${targetAcos > 0 ? ` (meta ${targetAcos}%)` : ''}</td>
        <td style="padding:12px 20px;font-size:13px;font-weight:700;color:${acosColor};text-align:right;">${fmtPct(acos)}</td>
      </tr>
      <tr style="border-bottom:1px solid #1E2A40;">
        <td style="padding:12px 20px;font-size:12px;color:#94A3B8;">ROAS${targetRoas > 0 ? ` (meta ${targetRoas}x)` : ''}</td>
        <td style="padding:12px 20px;font-size:13px;font-weight:700;color:${roasColor};text-align:right;">${roas > 0 ? `${Number(roas).toFixed(2)}x` : '—'}</td>
      </tr>
      <tr style="border-bottom:1px solid #1E2A40;">
        <td style="padding:12px 20px;font-size:12px;color:#94A3B8;">TACoS Real${targetTacos > 0 ? ` (meta ${targetTacos}%)` : ''}</td>
        <td style="padding:12px 20px;font-size:13px;font-weight:700;color:${tacosColor};text-align:right;">${fmtPct(tacos)}</td>
      </tr>
      <tr style="border-bottom:1px solid #1E2A40;">
        <td style="padding:12px 20px;font-size:12px;color:#94A3B8;">Pedidos</td>
        <td style="padding:12px 20px;font-size:13px;font-weight:700;color:#F8FAFC;text-align:right;">${fmtNum(orders)}</td>
      </tr>
      <tr style="border-bottom:1px solid #1E2A40;">
        <td style="padding:12px 20px;font-size:12px;color:#94A3B8;">Unidades vendidas</td>
        <td style="padding:12px 20px;font-size:13px;font-weight:700;color:#F8FAFC;text-align:right;">${fmtNum(units)}</td>
      </tr>
      <tr style="border-bottom:1px solid #1E2A40;">
        <td style="padding:12px 20px;font-size:12px;color:#94A3B8;">Produtos lucrativos</td>
        <td style="padding:12px 20px;font-size:13px;font-weight:700;color:#10B981;text-align:right;">${fmtNum(profitable)}</td>
      </tr>
      <tr style="border-bottom:1px solid #1E2A40;">
        <td style="padding:12px 20px;font-size:12px;color:#94A3B8;">Produtos com prejuízo</td>
        <td style="padding:12px 20px;font-size:13px;font-weight:700;color:${unprofitable > 0 ? '#EF4444' : '#10B981'};text-align:right;">${fmtNum(unprofitable)}</td>
      </tr>
      <tr>
        <td style="padding:12px 20px;font-size:12px;color:#94A3B8;">Decisões executadas pelo motor</td>
        <td style="padding:12px 20px;font-size:13px;font-weight:700;color:#8B5CF6;text-align:right;">${fmtNum(decisionsExecuted)}</td>
      </tr>
    </table>
  </div>

  ${executiveSummary ? `
  <div style="background:#111827;border:1px solid #1E2A40;border-radius:12px;padding:16px 20px;margin-bottom:20px;">
    <h3 style="margin:0 0 10px;font-size:13px;font-weight:700;color:#F8FAFC;">Análise da Semana</h3>
    <p style="margin:0;font-size:13px;color:#94A3B8;line-height:1.6;">${executiveSummary}</p>
  </div>` : ''}

  <!-- Footer -->
  <div style="text-align:center;padding:16px 0;">
    <p style="margin:0;font-size:11px;color:#334155;">Gerado automaticamente · LivingFinds · ${now}</p>
  </div>

</div>
</body>
</html>`;
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 403 });
    }

    const db = base44.asServiceRole;

    // Período: semana de ontem - 6 dias até ontem (BRT)
    const weekEnd = getYesterdayBRT();
    const weekStart = addDays(weekEnd, -6);

    // Idempotência — verificar envio nas últimas 20h para o mesmo week_end
    const cutoff20h = new Date(Date.now() - 20 * 3600000).toISOString();
    const existingLogs = await db.entities.SyncExecutionLog.filter(
      { operation: 'weekly_email_summary', execution_date: weekEnd },
      '-created_date', 5
    ).catch(() => [] as any[]);
    const alreadySent = existingLogs.some((l: any) =>
      l.status === 'success' && (l.created_date || l.started_at || '') >= cutoff20h
    );
    if (alreadySent) {
      return Response.json({ ok: true, skipped: true, reason: 'already_sent', week_end: weekEnd });
    }

    // Conta Amazon
    const accounts = await db.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_date', 1).catch(() => [] as any[]);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon conectada' });
    const aid = account.id;

    // WeeklyAdsPerformanceReport mais recente
    const reports = await db.entities.WeeklyAdsPerformanceReport.filter(
      { amazon_account_id: aid }, '-week_end', 1
    ).catch(() => [] as any[]);
    const report = reports[0] || null;

    // Metas
    const perfList = await db.entities.PerformanceSettings.filter({ amazon_account_id: aid }, null, 1).catch(() => [] as any[]);
    const perf: any = perfList[0] || {};

    // Métricas base do relatório
    let spend: number = report?.total_spend || 0;
    let adsSales: number = report?.total_ads_sales || 0;
    let realSales: number = report?.total_real_sales || 0;
    let acos: number = report?.account_acos || 0;
    let roas: number = report?.account_roas || 0;
    let tacos: number = report?.account_tacos || 0;
    let orders: number = report?.total_orders || 0;
    let units: number = report?.total_units || 0;
    const profitable: number = report?.products_profitable || 0;
    const unprofitable: number = report?.products_unprofitable || 0;
    let decisionsExecuted: number = report?.decisions_executed || 0;
    const executiveSummary: string = report?.executive_summary || '';
    let realSalesSource = realSales > 0 ? 'report' : 'none';

    // Fallback: CampaignMetricsDaily
    if (spend === 0) {
      const metrics = await db.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, null, 5000).catch(() => [] as any[]);
      for (const m of metrics.filter((m: any) => m.date >= weekStart && m.date <= weekEnd)) {
        spend += m.spend || 0;
        adsSales += m.sales || 0;
        orders += m.orders || 0;
      }
      acos = adsSales > 0 ? (spend / adsSales) * 100 : 0;
      roas = spend > 0 ? adsSales / spend : 0;
    }

    // Fallback: SalesDaily para faturamento real
    if (realSales === 0) {
      const salesDaily = await db.entities.SalesDaily.filter({ amazon_account_id: aid }, null, 500).catch(() => [] as any[]);
      for (const s of salesDaily.filter((s: any) => s.date >= weekStart && s.date <= weekEnd)) {
        const rev = s.finance_sync_status === 'synced' && (s.gross_revenue || 0) > 0
          ? s.gross_revenue : (s.ordered_product_sales || 0);
        realSales += rev;
        units += s.units_ordered || 0;
      }
      if (realSales > 0) realSalesSource = 'sales_daily';
    }

    if (realSales > 0 && tacos === 0) tacos = (spend / realSales) * 100;

    // Fallback: decisões executadas na semana
    if (decisionsExecuted === 0) {
      const decisions = await db.entities.OptimizationDecision.filter(
        { amazon_account_id: aid, status: 'executed' }, null, 1000
      ).catch(() => [] as any[]);
      decisionsExecuted = decisions.filter((d: any) => {
        const dt = d.executed_at || d.updated_at || d.created_date || '';
        return dt >= weekStart && dt <= weekEnd + 'T23:59:59Z';
      }).length;
    }

    const html = buildHtml({
      weekStart, weekEnd, spend, adsSales, realSales, realSalesSource,
      acos, roas, tacos, orders, units, profitable, unprofitable,
      decisionsExecuted, executiveSummary,
      targetAcos: perf.target_acos || 0,
      targetRoas: perf.target_roas || 0,
      targetTacos: perf.target_tacos || 0,
    });

    const fmt = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
    const acosStr = acos > 0 ? ` · ACoS ${Number(acos).toFixed(1)}%` : '';
    const realStr = realSalesSource !== 'none' ? ` · Fat. Real ${fmt(realSales)}` : '';
    const subject = `📊 Resumo Semanal ${fmtDate(weekStart)}–${fmtDate(weekEnd)} · Gasto ${fmt(spend)}${acosStr}${realStr}`;

    await db.integrations.Core.SendEmail({
      to: 'contato@livingfinds.com.br',
      subject,
      body: html,
    });

    await db.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'weekly_email_summary',
      trigger_type: 'automatic',
      status: 'success',
      execution_date: weekEnd,
      started_at: new Date(t0).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - t0,
      result_summary: `E-mail enviado · ${weekStart} a ${weekEnd} · spend ${spend.toFixed(2)} · acos ${acos.toFixed(1)}%`,
    }).catch(() => {});

    return Response.json({
      ok: true,
      sent_to: 'contato@livingfinds.com.br',
      week_start: weekStart,
      week_end: weekEnd,
      spend,
      acos,
      real_sales: realSales,
      real_sales_source: realSalesSource,
      duration_ms: Date.now() - t0,
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
});