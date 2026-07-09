/**
 * sendPrelectionReportEmail
 * Disparado automaticamente quando WeeklyMotorPrelection é atualizado para status=completed.
 * Envia email comparando métricas reais vs metas configuradas + trend diário de efetividade do motor.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function pct(v: number) { return `${Number(v || 0).toFixed(1)}%`; }
function brl(v: number) { return `R$${Number(v || 0).toFixed(2)}`; }
function x(v: number)   { return `${Number(v || 0).toFixed(2)}x`; }

function statusIcon(status: string) {
  if (status === 'ok') return '✅';
  if (status === 'warning') return '⚠️';
  if (status === 'critical') return '🔴';
  return '—';
}

function statusLabel(status: string) {
  if (status === 'ok') return 'OK';
  if (status === 'warning') return 'Atenção';
  if (status === 'critical') return 'Crítico';
  return 'Sem dados';
}

function rowColor(status: string) {
  if (status === 'ok') return '#d1fae5';
  if (status === 'warning') return '#fef3c7';
  if (status === 'critical') return '#fee2e2';
  return '#f1f5f9';
}

function fmt2(v: number) { return Math.round(v * 100) / 100; }

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));

    // Aceita prelection_id direto ou busca o mais recente
    let prelection: any = null;
    if (body.prelection_id) {
      const rows = await base44.asServiceRole.entities.WeeklyMotorPrelection.filter({ id: body.prelection_id });
      prelection = rows[0];
    }
    if (!prelection && body.data?.id) {
      prelection = body.data;
    }
    if (!prelection) {
      const rows = await base44.asServiceRole.entities.WeeklyMotorPrelection.filter(
        { status: 'completed' }, '-completed_at', 1
      );
      prelection = rows[0];
    }
    if (!prelection) return Response.json({ ok: false, error: 'Preleção não encontrada.' });

    if (prelection.status !== 'completed') {
      return Response.json({ ok: true, skipped: true, reason: `Status ${prelection.status} — email não enviado.` });
    }

    // ── Metas configuradas ──────────────────────────────────────────────────
    const gs = prelection.goal_status || {};
    const targetAcos  = prelection.target_acos  || 10;
    const maxAcos     = prelection.max_acos      || 15;
    const targetRoas  = prelection.target_roas   || 4;
    const targetTacos = prelection.target_tacos  || 5;
    const maxTacos    = prelection.max_tacos     || 10;
    const budgetCap   = prelection.daily_budget_cap || 56;

    // ── Métricas reais da semana ───────────────────────────────────────────
    const realAcos   = prelection.acos       || 0;
    const realRoas   = prelection.roas       || 0;
    const realCpc    = prelection.avg_cpc    || 0;
    const realSpend  = prelection.total_spend || 0;
    const realSales  = prelection.total_sales || 0;
    const realOrders = prelection.total_orders || 0;
    const avgDailySpend = realSpend / 7;
    const tacosStatus = gs.tacos || 'no_data';

    // ── Buscar trend diário (CampaignMetricsDaily da semana) ───────────────
    const aid = prelection.amazon_account_id;
    const sevenDaysAgo = prelection.week_start ||
      new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const yesterday = prelection.week_end ||
      new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    const dailyMetrics = aid
      ? await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
          { amazon_account_id: aid }, '-date', 500
        ).catch(() => [])
      : [];

    // Agregar por data dentro da janela da semana
    const byDate: Record<string, { spend: number; sales: number; clicks: number; orders: number }> = {};
    for (const m of dailyMetrics) {
      if (!m.date || m.date < sevenDaysAgo || m.date > yesterday) continue;
      if (!byDate[m.date]) byDate[m.date] = { spend: 0, sales: 0, clicks: 0, orders: 0 };
      byDate[m.date].spend  += m.spend  || 0;
      byDate[m.date].sales  += m.sales  || 0;
      byDate[m.date].clicks += m.clicks || 0;
      byDate[m.date].orders += m.orders || 0;
    }

    // Gerar linha por dia (ordem cronológica)
    const sortedDates = Object.keys(byDate).sort();
    const trendRows = sortedDates.map(date => {
      const d = byDate[date];
      const acos = d.sales > 0 ? fmt2(d.spend / d.sales * 100) : null;
      const roas = d.spend > 0 ? fmt2(d.sales / d.spend) : null;
      const cpc  = d.clicks > 0 ? fmt2(d.spend / d.clicks) : null;

      const acosStatus = acos == null ? 'no_data'
        : acos <= targetAcos ? 'ok'
        : acos <= maxAcos    ? 'warning'
        : 'critical';

      const roasStatus = roas == null ? 'no_data'
        : roas >= targetRoas           ? 'ok'
        : roas >= targetRoas * 0.75    ? 'warning'
        : 'critical';

      // Dia efetivo: ACoS + ROAS ambos ok ou warning, sem critical
      const dayOk = acosStatus !== 'critical' && roasStatus !== 'critical' && acosStatus !== 'no_data';

      const dow = new Date(date + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'short', timeZone: 'America/Sao_Paulo' });

      return { date, dow, acos, roas, cpc, spend: d.spend, sales: d.sales, orders: d.orders, acosStatus, roasStatus, dayOk };
    });

    const effectiveDays = trendRows.filter(r => r.dayOk).length;
    const totalDays = trendRows.length || 1;
    const dailyEffectiveness = Math.round(effectiveDays / totalDays * 100);

    // ── Efetividade geral do motor (metas semanais) ────────────────────────
    const allStatuses = [gs.acos, gs.roas, gs.cpc, gs.budget].filter(s => s && s !== 'no_data');
    const okCount = allStatuses.filter(s => s === 'ok').length;
    const motorEffectiveness = allStatuses.length > 0 ? Math.round(okCount / allStatuses.length * 100) : dailyEffectiveness;

    const effectivenessText =
      motorEffectiveness >= 75 ? '🟢 Motor está sendo <strong>efetivo</strong> — maioria das metas atingidas' :
      motorEffectiveness >= 50 ? '🟡 Motor <strong>parcialmente efetivo</strong> — ajustes necessários' :
                                  '🔴 Motor com <strong>baixa efetividade</strong> — revisão urgente necessária';

    const weekLabel = `${prelection.week_start} – ${prelection.week_end}`;
    const completedAt = prelection.completed_at
      ? new Date(prelection.completed_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '—';

    // ── Tabela de metas vs real ────────────────────────────────────────────
    const metricsRows = [
      { label: 'ACoS',            real: pct(realAcos),      meta: `Alvo: ${pct(targetAcos)} / Máx: ${pct(maxAcos)}`, status: gs.acos   || 'no_data' },
      { label: 'ROAS',            real: x(realRoas),        meta: `Alvo: ${x(targetRoas)}`,                          status: gs.roas   || 'no_data' },
      { label: 'TACoS',           real: tacosStatus === 'no_data' ? 'Sem dados' : '—', meta: `Alvo: ${pct(targetTacos)} / Máx: ${pct(maxTacos)}`, status: tacosStatus },
      { label: 'CPC Médio',       real: brl(realCpc),       meta: `Configurado nas metas`,                           status: gs.cpc    || 'no_data' },
      { label: 'Gasto Médio/dia', real: brl(avgDailySpend), meta: `Cap: ${brl(budgetCap)}/dia`,                      status: gs.budget || 'no_data' },
    ];

    const tableRows = metricsRows.map(r => `
      <tr style="background:${rowColor(r.status)}">
        <td style="padding:10px 14px;font-weight:600;color:#1e293b;">${r.label}</td>
        <td style="padding:10px 14px;font-size:16px;font-weight:700;color:#0f172a;">${r.real}</td>
        <td style="padding:10px 14px;color:#475569;font-size:12px;">${r.meta}</td>
        <td style="padding:10px 14px;text-align:center;">${statusIcon(r.status)} <span style="font-size:11px;font-weight:600;">${statusLabel(r.status)}</span></td>
      </tr>
    `).join('');

    // ── Tabela de trend diário ─────────────────────────────────────────────
    const trendTableRows = trendRows.map(r => {
      const acosCell = r.acos == null ? '—' : pct(r.acos);
      const roasCell = r.roas == null ? '—' : x(r.roas);
      const cpcCell  = r.cpc  == null ? '—' : brl(r.cpc);
      const dayBg    = r.dayOk ? '#f0fdf4' : r.acosStatus === 'critical' || r.roasStatus === 'critical' ? '#fff1f2' : '#fffbeb';
      const effIcon  = r.acosStatus === 'no_data' ? '⬜' : r.dayOk ? '🟢' : r.acosStatus === 'critical' ? '🔴' : '🟡';
      return `
        <tr style="background:${dayBg}">
          <td style="padding:8px 12px;font-weight:600;color:#374151;white-space:nowrap;">${r.dow} ${r.date.slice(5)}</td>
          <td style="padding:8px 12px;font-weight:700;color:${r.acosStatus === 'ok' ? '#166534' : r.acosStatus === 'critical' ? '#991b1b' : '#92400e'};">${acosCell}</td>
          <td style="padding:8px 12px;font-weight:700;color:${r.roasStatus === 'ok' ? '#166534' : r.roasStatus === 'critical' ? '#991b1b' : '#92400e'};">${roasCell}</td>
          <td style="padding:8px 12px;color:#475569;">${cpcCell}</td>
          <td style="padding:8px 12px;color:#6b7280;font-size:12px;">${brl(r.spend)}</td>
          <td style="padding:8px 12px;font-size:13px;text-align:center;">${effIcon}</td>
        </tr>
      `;
    }).join('');

    const trendSection = trendRows.length > 0 ? `
      <h2 style="font-size:15px;font-weight:700;color:#1e293b;margin:24px 0 8px;">Trend Diário — Efetividade do Motor</h2>
      <p style="margin:0 0 12px;font-size:12px;color:#64748b;">
        🟢 Dia efetivo (metas ok/atenção) &nbsp;|&nbsp; 🟡 Atenção &nbsp;|&nbsp; 🔴 Crítico &nbsp;|&nbsp;
        <strong style="color:#0f172a;">${effectiveDays}/${totalDays} dias dentro das metas</strong>
      </p>
      <table style="width:100%;border-collapse:collapse;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0;">
        <thead>
          <tr style="background:#f1f5f9;">
            <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b;">Dia</th>
            <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b;">ACoS<br><span style="font-weight:400;color:#94a3b8;">meta ≤${pct(targetAcos)}</span></th>
            <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b;">ROAS<br><span style="font-weight:400;color:#94a3b8;">meta ≥${x(targetRoas)}</span></th>
            <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b;">CPC</th>
            <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b;">Gasto</th>
            <th style="padding:8px 12px;text-align:center;font-size:11px;text-transform:uppercase;color:#64748b;">Status</th>
          </tr>
        </thead>
        <tbody>${trendTableRows}</tbody>
      </table>
    ` : '';

    const executiveSummary = prelection.executive_summary
      ? `<div style="background:#f8fafc;border-left:4px solid #6366f1;padding:14px 18px;margin:20px 0;border-radius:0 8px 8px 0;">
          <p style="margin:0;font-size:13px;color:#334155;line-height:1.6;"><strong>Resumo do Claude:</strong> ${prelection.executive_summary}</p>
        </div>`
      : '';

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:Inter,Arial,sans-serif;background:#f1f5f9;margin:0;padding:24px;">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#6366f1,#4f46e5);padding:28px 32px;">
      <p style="margin:0;color:#c7d2fe;font-size:12px;text-transform:uppercase;letter-spacing:1px;">LivingFinds · Motor de Anúncios</p>
      <h1 style="margin:8px 0 4px;color:#fff;font-size:22px;">Relatório de Preleção Semanal</h1>
      <p style="margin:0;color:#e0e7ff;font-size:13px;">Semana ${weekLabel} · Gerado em ${completedAt}</p>
    </div>

    <div style="padding:28px 32px;">

      <!-- Efetividade do motor -->
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px 20px;margin-bottom:24px;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
          <div style="text-align:center;flex:1;">
            <p style="margin:0 0 2px;font-size:28px;font-weight:800;color:#0f172a;">${motorEffectiveness}%</p>
            <p style="margin:0;font-size:12px;color:#475569;">Metas semanais atingidas</p>
          </div>
          <div style="text-align:center;flex:1;border-left:1px solid #e2e8f0;padding-left:16px;">
            <p style="margin:0 0 2px;font-size:28px;font-weight:800;color:#0f172a;">${effectiveDays}<span style="font-size:16px;font-weight:400;color:#94a3b8;">/${totalDays}</span></p>
            <p style="margin:0;font-size:12px;color:#475569;">Dias dentro das metas</p>
          </div>
        </div>
        <p style="margin:12px 0 0;font-size:13px;text-align:center;">${effectivenessText}</p>
      </div>

      <!-- KPIs de volume -->
      <div style="display:flex;gap:12px;margin-bottom:24px;">
        <div style="flex:1;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px;text-align:center;">
          <p style="margin:0;font-size:20px;font-weight:700;color:#166534;">${brl(realSales)}</p>
          <p style="margin:4px 0 0;font-size:11px;color:#15803d;">Vendas na semana</p>
        </div>
        <div style="flex:1;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:14px;text-align:center;">
          <p style="margin:0;font-size:20px;font-weight:700;color:#1e40af;">${brl(realSpend)}</p>
          <p style="margin:4px 0 0;font-size:11px;color:#1d4ed8;">Gasto total</p>
        </div>
        <div style="flex:1;background:#faf5ff;border:1px solid #e9d5ff;border-radius:8px;padding:14px;text-align:center;">
          <p style="margin:0;font-size:20px;font-weight:700;color:#6b21a8;">${realOrders}</p>
          <p style="margin:4px 0 0;font-size:11px;color:#7e22ce;">Pedidos</p>
        </div>
      </div>

      <!-- Tabela de metas vs real -->
      <h2 style="font-size:15px;font-weight:700;color:#1e293b;margin:0 0 12px;">Métricas vs Metas Configuradas</h2>
      <table style="width:100%;border-collapse:collapse;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0;">
        <thead>
          <tr style="background:#f1f5f9;">
            <th style="padding:10px 14px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b;letter-spacing:0.5px;">Métrica</th>
            <th style="padding:10px 14px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b;">Real</th>
            <th style="padding:10px 14px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b;">Meta</th>
            <th style="padding:10px 14px;text-align:center;font-size:11px;text-transform:uppercase;color:#64748b;">Status</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>

      <!-- Trend diário -->
      ${trendSection}

      ${executiveSummary}

      <!-- Ações da preleção -->
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 18px;margin-top:20px;">
        <h3 style="margin:0 0 10px;font-size:13px;font-weight:700;color:#1e293b;">Ações desta preleção</h3>
        <div style="display:flex;gap:16px;flex-wrap:wrap;">
          <span style="font-size:12px;color:#475569;">🏆 <strong>${prelection.winning_terms_count || 0}</strong> termos vencedores</span>
          <span style="font-size:12px;color:#475569;">🚀 <strong>${prelection.new_manual_campaigns_created || 0}</strong> campanhas criadas</span>
          <span style="font-size:12px;color:#475569;">⚠️ <strong>${prelection.campaigns_to_pause || 0}</strong> campanhas para tratar</span>
          <span style="font-size:12px;color:#475569;">📋 <strong>${prelection.rules_reviewed || 0}</strong> regras revisadas</span>
        </div>
      </div>

      <p style="margin:24px 0 0;font-size:11px;color:#94a3b8;text-align:center;">
        Enviado automaticamente pelo LivingFinds · Motor Determinístico opera de forma independente da IA
      </p>
    </div>
  </div>
</body>
</html>`;

    await base44.asServiceRole.integrations.Core.SendEmail({
      to: user.email,
      subject: `📊 Preleção Semanal ${weekLabel} — Motor ${motorEffectiveness}% efetivo | ACoS ${pct(realAcos)} vs meta ${pct(targetAcos)} | ${effectiveDays}/${totalDays} dias OK`,
      body: html,
    });

    return Response.json({ ok: true, sent_to: user.email, week: weekLabel, motor_effectiveness: motorEffectiveness, effective_days: effectiveDays, total_days: totalDays });

  } catch (error: any) {
    console.error('[sendPrelectionReportEmail]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});