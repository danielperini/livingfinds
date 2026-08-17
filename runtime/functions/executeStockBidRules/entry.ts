/**
 * executeStockBidRules — Executa ações de bid pendentes geradas pelo motor determinístico.
 *
 * Lê a entidade RuleExecution (status: 'pending'), aplica os bids via Amazon Ads API
 * e atualiza o status para 'executed' ou 'failed'.
 *
 * Chamado:
 *  - Pelo pipeline diário (runDailyFullReportPipeline) após runDeterministicDecisionEngine
 *  - Manualmente via dashboard para forçar execução imediata
 *
 * Guardrails internos:
 *  - Bid mínimo: R$0.10 | máximo: R$5.00
 *  - Máx 200 execuções por chamada (evitar timeout)
 *  - Pausa 300ms entre lotes de 10 para evitar rate limit 429
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MIN_BID = 0.10;
const MAX_BID = 5.0;
const BATCH_SIZE = 10;
const PAUSE_MS = 300;
const MAX_EXECUTIONS = 200;

function getAdsBaseUrl(region: string) {
  const r = (region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function getAdsToken(refreshToken: string) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: Deno.env.get('ADS_CLIENT_ID') || '',
    client_secret: Deno.env.get('ADS_CLIENT_SECRET') || '',
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token refresh failed');
  return data.access_token as string;
}

async function updateKeywordBid(
  keywordId: string, newBid: number,
  token: string, profileId: string, region: string
) {
  const baseUrl = getAdsBaseUrl(region);
  const res = await fetch(`${baseUrl}/sp/keywords`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': 'application/vnd.spKeyword.v3+json',
      'Accept': 'application/vnd.spKeyword.v3+json',
    },
    body: JSON.stringify({ keywords: [{ keywordId, bid: newBid }] }),
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (res.status === 429) throw new Error('RATE_LIMIT_429');
  if (!res.ok && res.status !== 207) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  // HTTP 207: verificar resultado individual
  const item = data?.keywords?.success?.[0] || data?.keywords?.[0];
  if (data?.keywords?.error?.length > 0) {
    const err = data.keywords.error[0];
    throw new Error(`Amazon error: ${err.errorType || 'unknown'} - ${JSON.stringify(err.errors || '')}`);
  }
  return data;
}

async function pause(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, dry_run = false } = body;

    // Resolver conta
    let account: any = null;
    if (amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id });
      account = accs[0] || null;
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0] || null;
    }
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' });

    const aid = account.id;
    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '';
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';
    const region = account.region || Deno.env.get('ADS_REGION') || 'NA';

    // Buscar execuções pendentes — priorizar regras de estoque (rule_key starts with 'stock')
    const pending = await base44.asServiceRole.entities.RuleExecution.filter(
      { amazon_account_id: aid, status: 'pending' },
      'created_date',
      MAX_EXECUTIONS
    );

    if (pending.length === 0) {
      return Response.json({ ok: true, message: 'Nenhuma ação pendente', executed: 0, duration_ms: Date.now() - startTime });
    }

    // Filtrar apenas ações de bid (set_bid, increase_bid_percent, decrease_bid_percent)
    const BID_ACTIONS = new Set(['set_bid', 'increase_bid_percent', 'decrease_bid_percent']);
    const bidActions = pending.filter(a => BID_ACTIONS.has(a.action_type) && a.keyword_id);

    if (bidActions.length === 0) {
      return Response.json({ ok: true, message: 'Nenhuma ação de bid pendente', total_pending: pending.length, executed: 0, duration_ms: Date.now() - startTime });
    }

    // Obter token uma vez
    let token: string;
    try {
      token = await getAdsToken(refreshToken);
    } catch (e: any) {
      return Response.json({ ok: false, error: `Token refresh falhou: ${e.message}`, duration_ms: Date.now() - startTime });
    }

    const now = new Date().toISOString();
    let executed = 0, failed = 0, skipped = 0;
    const results: any[] = [];
    const adsBidChangeLogs: any[] = [];

    // Processar em lotes com pausa
    for (let i = 0; i < bidActions.length; i += BATCH_SIZE) {
      const batch = bidActions.slice(i, i + BATCH_SIZE);

      for (const action of batch) {
        const keywordId = action.keyword_id;
        const newBid = Math.min(MAX_BID, Math.max(MIN_BID, Number(action.value_after) || MIN_BID));
        const oldBid = Number(action.value_before) || 0;

        if (dry_run) {
          skipped++;
          results.push({ action_id: action.id, dry_run: true, keyword_id: keywordId, old_bid: oldBid, new_bid: newBid });
          continue;
        }

        try {
          await updateKeywordBid(keywordId, newBid, token, profileId, region);

          // Marcar como executado
          await base44.asServiceRole.entities.RuleExecution.update(action.id, {
            status: 'executed',
            executed_at: now,
          });

          // Atualizar bid na entidade Keyword localmente
          if (action.entity_id) {
            const kwList = await base44.asServiceRole.entities.Keyword.filter({
              amazon_account_id: aid,
              keyword_id: keywordId,
            }).catch(() => []);
            if (kwList.length > 0) {
              await base44.asServiceRole.entities.Keyword.update(kwList[0].id, {
                current_bid: newBid,
                bid: newBid,
              }).catch(() => {});
            }
          }

          // Log de alteração de bid
          adsBidChangeLogs.push({
            amazon_account_id: aid,
            date: now.slice(0, 10),
            keyword_id: keywordId,
            keyword: action.keyword_text || '',
            campaign_id: action.campaign_id || '',
            asin: action.asin || '',
            old_bid: oldBid,
            new_bid: newBid,
            change_amount: newBid - oldBid,
            change_percent: oldBid > 0 ? ((newBid - oldBid) / oldBid) * 100 : 0,
            direction: newBid > oldBid ? 'increase' : newBid < oldBid ? 'decrease' : 'unchanged',
            reason: action.reason || action.rule_key || 'stock_rule',
            status: 'executed',
            decision_id: action.correlation_id || '',
            created_at: now,
          });

          executed++;
          results.push({ action_id: action.id, status: 'executed', keyword_id: keywordId, old_bid: oldBid, new_bid: newBid });

        } catch (e: any) {
          const isRateLimit = e.message === 'RATE_LIMIT_429';

          await base44.asServiceRole.entities.RuleExecution.update(action.id, {
            status: isRateLimit ? 'pending' : 'failed',
            executed_at: now,
            error_message: e.message.slice(0, 300),
          }).catch(() => {});

          failed++;
          results.push({ action_id: action.id, status: 'failed', keyword_id: keywordId, error: e.message.slice(0, 200) });

          if (isRateLimit) {
            // Aguardar 5s e continuar
            await pause(5000);
          }
        }
      }

      // Pausa entre lotes
      if (i + BATCH_SIZE < bidActions.length) {
        await pause(PAUSE_MS);
      }
    }

    // Gravar logs de alteração em lote
    if (adsBidChangeLogs.length > 0) {
      for (let i = 0; i < adsBidChangeLogs.length; i += 50) {
        await base44.asServiceRole.entities.AdsBidChangeLog.bulkCreate(adsBidChangeLogs.slice(i, i + 50)).catch(() => {});
      }
    }

    // Log de execução
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'executeStockBidRules',
      trigger_type: 'automatic',
      status: failed === 0 ? 'success' : executed > 0 ? 'partial' : 'error',
      started_at: new Date(startTime).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      records_processed: executed + failed,
      records_upserted: executed,
      error_message: failed > 0 ? `${failed} ações falharam` : null,
    }).catch(() => {});

    return Response.json({
      ok: true,
      dry_run,
      total_pending: pending.length,
      bid_actions_found: bidActions.length,
      executed,
      failed,
      skipped,
      duration_ms: Date.now() - startTime,
      results: results.slice(0, 50), // limitar resposta
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});