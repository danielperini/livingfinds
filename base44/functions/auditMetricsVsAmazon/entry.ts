/**
 * auditMetricsVsAmazon
 *
 * 1. Baixa o relatório de campanhas dos últimos 30 dias direto da Amazon Ads API
 * 2. Compara com os dados em CampaignMetricsDaily no banco
 * 3. Detecta divergências por campanha/data (missing, extra, delta)
 * 4. Usa IA para classificar e priorizar as divergências
 * 5. Corrige automaticamente: upsert dos registros divergentes no banco
 * 6. Persiste resultado em AmazonDataAuditSnapshot
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function todayBRT() { return new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10); }
function daysAgo(n: number) { return new Date(Date.now() - 3 * 3600000 - n * 86400000).toISOString().slice(0, 10); }
function nowIso() { return new Date().toISOString(); }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function getAmazonToken(base44: any, accountId: string): Promise<string | null> {
  try {
    const res = await base44.asServiceRole.functions.invoke('amazonAdsTokenManager', {
      _service_role: true,
      amazon_account_id: accountId,
      action: 'get_token',
    });
    return res?.data?.access_token || null;
  } catch { return null; }
}

async function requestReport(accessToken: string, profileId: string, startDate: string, endDate: string): Promise<string | null> {
  try {
    const url = 'https://advertising-api.amazon.com/reporting/reports';
    const body = {
      name: `audit_${startDate}_${endDate}`,
      startDate,
      endDate,
      configuration: {
        adProduct: 'SPONSORED_PRODUCTS',
        groupBy: ['campaign'],
        columns: ['impressions', 'clicks', 'cost', 'purchases1d', 'purchases7d', 'purchases14d', 'purchases30d',
          'sales1d', 'sales7d', 'sales14d', 'sales30d', 'campaignId', 'campaignName', 'campaignStatus',
          'campaignBudgetAmount', 'campaignBudgetType', 'campaignBudgetCurrencyCode'],
        reportTypeId: 'spCampaigns',
        format: 'GZIP_JSON',
        timeUnit: 'DAILY',
      },
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
        'Amazon-Advertising-API-Scope': profileId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error('[auditMetricsVsAmazon] report request failed:', resp.status, err.slice(0, 200));
      return null;
    }

    const data = await resp.json();
    return data.reportId || null;
  } catch (e: any) {
    console.error('[auditMetricsVsAmazon] requestReport error:', e.message);
    return null;
  }
}

async function pollReport(accessToken: string, profileId: string, reportId: string, maxWaitMs = 60000): Promise<string | null> {
  const url = `https://advertising-api.amazon.com/reporting/reports/${reportId}`;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const resp = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
        'Amazon-Advertising-API-Scope': profileId,
      },
    });
    if (!resp.ok) break;
    const data = await resp.json();
    if (data.status === 'COMPLETED' && data.url) return data.url;
    if (data.status === 'FAILED') break;
    await sleep(5000);
  }
  return null;
}

async function downloadReport(downloadUrl: string): Promise<any[]> {
  const resp = await fetch(downloadUrl);
  if (!resp.ok) return [];

  const contentType = resp.headers.get('content-type') || '';
  const isGzip = contentType.includes('gzip') || downloadUrl.includes('.gz');

  let text = '';
  if (isGzip) {
    const buf = await resp.arrayBuffer();
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    writer.write(new Uint8Array(buf));
    writer.close();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { merged.set(c, offset); offset += c.length; }
    text = new TextDecoder().decode(merged);
  } else {
    text = await resp.text();
  }

  try { return JSON.parse(text); } catch { return []; }
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    // ── Resolver conta ──────────────────────────────────────────────────────
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter(
      { status: 'connected' }, '-updated_date', 1
    ).catch(() => []);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta conectada' });

    const aid = account.id;
    const profileId = account.ads_profile_id;
    if (!profileId) return Response.json({ ok: false, error: 'ads_profile_id não configurado' });

    const startDate = daysAgo(30);
    const endDate = daysAgo(1); // Ontem — dia fechado
    const today = todayBRT();

    console.log(`[audit] account=${aid} período=${startDate}→${endDate}`);

    // ── 1. Token Amazon ─────────────────────────────────────────────────────
    const accessToken = await getAmazonToken(base44, aid);
    if (!accessToken) return Response.json({ ok: false, error: 'Token Amazon não disponível' });

    // ── 2. Buscar dados do banco (30 dias) ──────────────────────────────────
    const dbRows = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: aid }, '-date', 2000
    ).catch(() => []);
    const recentDB = dbRows.filter((r: any) => r.date >= startDate && r.date <= endDate);

    // Índice: campaign_id+date → row
    const dbIndex: Record<string, any> = {};
    for (const r of recentDB) {
      dbIndex[`${r.campaign_id}__${r.date}`] = r;
    }

    // ── 3. Solicitar relatório Amazon (ou reutilizar existente) ────────────
    let reportId: string | null = body.use_existing_report_id || null;

    if (!reportId) {
      reportId = await requestReport(accessToken, profileId, startDate, endDate);
    }

    if (!reportId) {
      // Fallback: usar dados brutos de jobs já processados
      return Response.json({
        ok: false,
        error: 'Não foi possível solicitar relatório à Amazon',
        fallback: 'Verifique token e profileId',
        db_records: recentDB.length,
      });
    }

    console.log(`[audit] reportId=${reportId} aguardando...`);

    // ── 4. Aguardar conclusão (até 60s) ─────────────────────────────────────
    const downloadUrl = await pollReport(accessToken, profileId, reportId, 70000);
    if (!downloadUrl) {
      // Relatório ainda não pronto — salvar job para processar depois
      await base44.asServiceRole.entities.AmazonAdsReportJob.create({
        amazon_account_id: aid,
        report_id: reportId,
        report_type_id: 'spCampaigns_audit',
        status: 'pending',
        start_date: startDate,
        end_date: endDate,
        created_at: nowIso(),
      }).catch(() => {});

      return Response.json({
        ok: true,
        status: 'report_pending',
        report_id: reportId,
        message: 'Relatório solicitado. Amazon ainda processando — tente novamente em 5 minutos.',
        db_records: recentDB.length,
      });
    }

    // ── 5. Baixar e parsear relatório ────────────────────────────────────────
    const amazonRows: any[] = await downloadReport(downloadUrl);
    console.log(`[audit] Amazon rows: ${amazonRows.length}`);

    if (amazonRows.length === 0) {
      return Response.json({ ok: false, error: 'Relatório Amazon vazio ou não parseável' });
    }

    // ── 6. Comparar banco vs Amazon ─────────────────────────────────────────
    const divergences: any[] = [];
    const amazonIndex: Record<string, any> = {};

    for (const row of amazonRows) {
      // Campo pode ser date ou Date dependendo da versão da API
      const date = (row.date || row.Date || '').slice(0, 10);
      const campaignId = String(row.campaignId || row.CampaignId || '');
      if (!date || !campaignId) continue;

      const key = `${campaignId}__${date}`;
      amazonIndex[key] = row;

      const dbRow = dbIndex[key];
      const amazonSpend = parseFloat(row.cost || row.Cost || '0');
      const amazonImpressions = parseInt(row.impressions || row.Impressions || '0', 10);
      const amazonClicks = parseInt(row.clicks || row.Clicks || '0', 10);
      const amazonSales = parseFloat(row.sales14d || row.Sales14d || '0');
      const amazonOrders = parseInt(row.purchases14d || row.Purchases14d || '0', 10);

      if (!dbRow) {
        // Registro na Amazon mas NÃO no banco
        divergences.push({
          type: 'missing_in_db',
          campaign_id: campaignId,
          date,
          amazon: { spend: amazonSpend, impressions: amazonImpressions, clicks: amazonClicks, sales: amazonSales, orders: amazonOrders },
          db: null,
          delta_spend: amazonSpend,
          delta_impressions: amazonImpressions,
          severity: amazonSpend > 1 ? 'high' : 'low',
        });
      } else {
        // Comparar valores
        const deltaSpend = Math.abs((dbRow.spend || 0) - amazonSpend);
        const deltaImpressions = Math.abs((dbRow.impressions || 0) - amazonImpressions);
        const deltaSales = Math.abs((dbRow.sales || 0) - amazonSales);
        const deltaOrders = Math.abs((dbRow.orders || 0) - amazonOrders);

        const threshold = 0.05; // 5 centavos de diferença
        if (deltaSpend > threshold || deltaImpressions > 5 || deltaSales > threshold || deltaOrders > 0) {
          divergences.push({
            type: 'value_mismatch',
            campaign_id: campaignId,
            date,
            amazon: { spend: amazonSpend, impressions: amazonImpressions, clicks: amazonClicks, sales: amazonSales, orders: amazonOrders },
            db: { spend: dbRow.spend, impressions: dbRow.impressions, clicks: dbRow.clicks, sales: dbRow.sales, orders: dbRow.orders },
            delta_spend: deltaSpend,
            delta_impressions: deltaImpressions,
            delta_sales: deltaSales,
            delta_orders: deltaOrders,
            severity: deltaSpend > 5 || deltaSales > 10 ? 'high' : 'medium',
            db_id: dbRow.id,
          });
        }
      }
    }

    // Registros no banco mas NÃO na Amazon (possível dado fantasma)
    for (const key of Object.keys(dbIndex)) {
      if (!amazonIndex[key]) {
        const dbRow = dbIndex[key];
        if ((dbRow.spend || 0) > 0 || (dbRow.impressions || 0) > 0) {
          divergences.push({
            type: 'extra_in_db',
            campaign_id: dbRow.campaign_id,
            date: dbRow.date,
            amazon: null,
            db: { spend: dbRow.spend, impressions: dbRow.impressions, clicks: dbRow.clicks, sales: dbRow.sales, orders: dbRow.orders },
            delta_spend: dbRow.spend || 0,
            severity: (dbRow.spend || 0) > 5 ? 'medium' : 'low',
            db_id: dbRow.id,
          });
        }
      }
    }

    const highDivergences = divergences.filter(d => d.severity === 'high');
    const mediumDivergences = divergences.filter(d => d.severity === 'medium');
    const lowDivergences = divergences.filter(d => d.severity === 'low');

    // ── 7. IA classifica e prioriza divergências ────────────────────────────
    let aiAnalysis: any = null;
    if (divergences.length > 0) {
      const summary = {
        total_divergences: divergences.length,
        by_type: {
          missing_in_db: divergences.filter(d => d.type === 'missing_in_db').length,
          value_mismatch: divergences.filter(d => d.type === 'value_mismatch').length,
          extra_in_db: divergences.filter(d => d.type === 'extra_in_db').length,
        },
        by_severity: { high: highDivergences.length, medium: mediumDivergences.length, low: lowDivergences.length },
        total_delta_spend: divergences.reduce((s, d) => s + (d.delta_spend || 0), 0).toFixed(2),
        total_delta_sales: divergences.filter(d => d.delta_sales).reduce((s, d) => s + (d.delta_sales || 0), 0).toFixed(2),
        top_5: divergences.sort((a, b) => (b.delta_spend || 0) - (a.delta_spend || 0)).slice(0, 5),
      };

      try {
        aiAnalysis = await base44.asServiceRole.integrations.Core.InvokeLLM({
          prompt: `Você é auditor de dados Amazon Ads da plataforma LivingFinds.

Divergências encontradas comparando banco de dados vs relatório direto da Amazon (30 dias):
${JSON.stringify(summary, null, 2)}

Analise e retorne JSON com:
- root_cause: causa provável das divergências
- impact_assessment: impacto financeiro estimado
- auto_fix_safe: true se é seguro corrigir automaticamente (sobrescrever banco com dados Amazon)
- priority_fixes: lista dos campaign_id+date mais críticos para corrigir primeiro
- recommendations: lista de até 3 ações recomendadas`,
          response_json_schema: {
            type: 'object',
            properties: {
              root_cause: { type: 'string' },
              impact_assessment: { type: 'string' },
              auto_fix_safe: { type: 'boolean' },
              priority_fixes: { type: 'array', items: { type: 'string' } },
              recommendations: { type: 'array', items: { type: 'string' } },
            },
          },
        });
      } catch (e: any) {
        console.warn('[audit] IA analysis failed:', e.message);
      }
    }

    // ── 8. Corrigir automaticamente se seguro ───────────────────────────────
    let fixedCount = 0;
    let fixErrors = 0;

    const shouldAutoFix = aiAnalysis?.auto_fix_safe !== false; // Fix por padrão se IA não bloqueou
    if (shouldAutoFix && divergences.length > 0) {
      // Corrigir em batches de 20
      const toFix = divergences.filter(d => d.type === 'missing_in_db' || d.type === 'value_mismatch');
      const batches = [];
      for (let i = 0; i < toFix.length; i += 20) batches.push(toFix.slice(i, i + 20));

      for (const batch of batches) {
        await Promise.all(batch.map(async (div) => {
          try {
            const amazonData = div.amazon;
            const payload = {
              amazon_account_id: aid,
              campaign_id: div.campaign_id,
              date: div.date,
              impressions: amazonData.impressions,
              clicks: amazonData.clicks,
              spend: amazonData.spend,
              sales: amazonData.sales,
              orders: amazonData.orders,
              acos: amazonData.sales > 0 ? amazonData.spend / amazonData.sales * 100 : 0,
              roas: amazonData.spend > 0 ? amazonData.sales / amazonData.spend : 0,
              ctr: amazonData.impressions > 0 ? amazonData.clicks / amazonData.impressions * 100 : 0,
              cpc: amazonData.clicks > 0 ? amazonData.spend / amazonData.clicks : 0,
            };

            if (div.type === 'value_mismatch' && div.db_id) {
              await base44.asServiceRole.entities.CampaignMetricsDaily.update(div.db_id, payload);
            } else if (div.type === 'missing_in_db') {
              await base44.asServiceRole.entities.CampaignMetricsDaily.create(payload);
            }
            fixedCount++;
          } catch (e: any) {
            fixErrors++;
            console.warn('[audit] fix error:', e.message?.slice(0, 100));
          }
        }));
        if (batches.length > 1) await sleep(500);
      }
    }

    // ── 9. Salvar snapshot de auditoria ─────────────────────────────────────
    await base44.asServiceRole.entities.AmazonDataAuditSnapshot.create({
      amazon_account_id: aid,
      audit_date: today,
      audit_type: 'metrics_vs_amazon_report',
      status: divergences.length === 0 ? 'clean' : fixedCount > 0 ? 'fixed' : 'divergences_found',
      total_records_checked: recentDB.length,
      total_amazon_records: amazonRows.length,
      total_divergences: divergences.length,
      high_severity_count: highDivergences.length,
      medium_severity_count: mediumDivergences.length,
      low_severity_count: lowDivergences.length,
      auto_fixed_count: fixedCount,
      fix_errors_count: fixErrors,
      ai_analysis: aiAnalysis ? JSON.stringify(aiAnalysis) : null,
      divergences_sample: JSON.stringify(divergences.slice(0, 20)),
      period_start: startDate,
      period_end: endDate,
      created_at: nowIso(),
    }).catch(() => {});

    const duration_ms = Date.now() - t0;

    return Response.json({
      ok: true,
      audit_date: today,
      period: { start: startDate, end: endDate },
      db_records: recentDB.length,
      amazon_records: amazonRows.length,
      divergences: {
        total: divergences.length,
        high: highDivergences.length,
        medium: mediumDivergences.length,
        low: lowDivergences.length,
        by_type: {
          missing_in_db: divergences.filter(d => d.type === 'missing_in_db').length,
          value_mismatch: divergences.filter(d => d.type === 'value_mismatch').length,
          extra_in_db: divergences.filter(d => d.type === 'extra_in_db').length,
        },
      },
      corrections: {
        applied: fixedCount,
        errors: fixErrors,
        auto_fix_safe: aiAnalysis?.auto_fix_safe,
      },
      ai_analysis: aiAnalysis,
      top_divergences: divergences
        .sort((a, b) => (b.delta_spend || 0) - (a.delta_spend || 0))
        .slice(0, 10),
      duration_ms,
    });

  } catch (error: any) {
    console.error('[auditMetricsVsAmazon]', error.message);
    return Response.json({ ok: false, error: error?.message }, { status: 500 });
  }
});