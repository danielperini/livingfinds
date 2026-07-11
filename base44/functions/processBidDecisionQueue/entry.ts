import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms:number) => new Promise((resolve) => setTimeout(resolve, ms));
const BID_ACTIONS = new Set(['reduce_bid', 'increase_bid', 'update_bid']);
const WINDOW_HOURS = [16, 17];
const WINDOW_START = 16;
const WINDOW_END = 18;
const MAX_ATTEMPTS = 6;
const DEFAULT_SPACING_MS = 2500;
const DEFAULT_RUNTIME_MS = 240000;
const MIN_KEYWORD_IMPRESSIONS_FOR_REDUCTION = 200;
const MIN_KEYWORD_CLICKS_FOR_REDUCTION = 10;
const MIN_KEYWORD_SPEND_FOR_REDUCTION = 12;

function brazilHour() {
  const parts = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).formatToParts(new Date());
  return Number(parts.find((part) => part.type === 'hour')?.value || 0);
}

function nextWindowDate() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (type:string) => Number(parts.find((part) => part.type === type)?.value || 0);
  const currentHour = get('hour');
  const target = new Date(Date.UTC(get('year'), get('month') - 1, get('day'), WINDOW_START + 3, 0, 0));
  if (currentHour >= WINDOW_END) target.setUTCDate(target.getUTCDate() + 1);
  return target.toISOString();
}

function isUsableAccount(account:any) {
  const status = String(account?.status || '').toLowerCase();
  return ['connected', 'active', 'enabled'].includes(status) || Boolean(account?.ads_profile_id || account?.ads_refresh_token);
}

function isTransientError(value:any) {
  const text = JSON.stringify(value || '').toLowerCase();
  return /(^|\D)(429|500|502|503|504|524)(\D|$)|rate.?limit|timeout|temporar|throttl/.test(text);
}

async function resolveAccounts(base44:any, requestedAccountId?:string|null) {
  if (requestedAccountId) {
    const rows = await base44.asServiceRole.entities.AmazonAccount.filter({ id: requestedAccountId });
    if (!rows.length) throw new Error(`AmazonAccount não encontrada: ${requestedAccountId}`);
    return rows;
  }
  const connected = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }).catch(() => []);
  if (connected.length) return connected;
  const all = await base44.asServiceRole.entities.AmazonAccount.list().catch(() => []);
  return all.filter(isUsableAccount);
}

function dueBidDecision(decision:any, recoveryMode:boolean) {
  if (!BID_ACTIONS.has(String(decision?.action || ''))) return false;
  if (decision?.decision_type && decision.decision_type !== 'bid_change') return false;
  if (['executed', 'rejected', 'rolled_back', 'skipped'].includes(String(decision?.status || ''))) return false;
  if (String(decision?.queue_status || '') === 'cancelled') return false;
  if (Number(decision?.attempt_count || 0) >= MAX_ATTEMPTS) return false;
  const retryAt = decision?.next_retry_at || decision?.scheduled_for;
  if (retryAt && new Date(retryAt).getTime() > Date.now()) return false;
  if (recoveryMode) return true;
  return String(decision?.queue_status || '') === 'scheduled';
}

async function validateReduction(base44:any, decision:any, targetAcos:number) {
  if (decision.action !== 'reduce_bid') return { ok: true };
  const keywordId = String(decision.entity_id || decision.keyword_id || '');
  if (!keywordId) return { ok: false, reason: 'Redução bloqueada: keyword_id ausente.' };

  const rows = await base44.asServiceRole.entities.Keyword.filter({
    amazon_account_id: decision.amazon_account_id,
    keyword_id: keywordId,
  }, null, 1).catch(() => []);
  const keyword = rows[0];
  if (!keyword) return { ok: false, reason: 'Redução bloqueada: não há métricas persistidas da keyword.' };

  const impressions = Number(keyword.impressions || 0);
  const clicks = Number(keyword.clicks || 0);
  const spend = Number(keyword.spend || 0);
  const orders = Number(keyword.orders || 0);
  const sales = Number(keyword.sales || 0);
  const acos = Number(keyword.acos || (sales > 0 ? (spend / sales) * 100 : 0));

  if (impressions < MIN_KEYWORD_IMPRESSIONS_FOR_REDUCTION || clicks < MIN_KEYWORD_CLICKS_FOR_REDUCTION || spend < MIN_KEYWORD_SPEND_FOR_REDUCTION) {
    return {
      ok: false,
      reason: `Redução bloqueada por amostra insuficiente da keyword: ${impressions} impressões, ${clicks} cliques, R$ ${spend.toFixed(2)} de gasto.`,
    };
  }

  if (orders > 0 && !(acos > targetAcos * 1.2)) {
    return {
      ok: false,
      reason: `Redução bloqueada: keyword possui ${orders} pedido(s) e ACoS ${acos.toFixed(1)}%, sem evidência suficiente acima da meta ${targetAcos}%.`,
    };
  }

  if (orders === 0 && spend < Math.max(MIN_KEYWORD_SPEND_FOR_REDUCTION, Number(decision.value_before || 0) * 10)) {
    return { ok: false, reason: 'Redução bloqueada: gasto sem venda ainda abaixo do limite de segurança para o bid atual.' };
  }

  return { ok: true };
}

Deno.serve(async (request) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });

    const recoveryMode = body.recovery_mode === true;
    const hour = Number(body.hour ?? brazilHour());
    if (!recoveryMode && !WINDOW_HOURS.includes(hour)) {
      return Response.json({ ok: true, skipped: true, reason: 'Fora da janela Amazon 16:00-18:00 BRT', hour, window: '16:00-18:00' });
    }

    const spacingMs = Math.max(1500, Number(body.spacing_ms || DEFAULT_SPACING_MS));
    const runtimeMs = Math.min(480000, Math.max(60000, Number(body.max_runtime_ms || DEFAULT_RUNTIME_MS)));
    const accounts = await resolveAccounts(base44, body.amazon_account_id || null);
    const output:any[] = [];

    for (const account of accounts) {
      const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: account.id }, null, 1).catch(() => []);
      const targetAcos = Number(configs[0]?.target_acos || 10);
      const result:any = { amazon_account_id: account.id, hour, recovery_mode: recoveryMode, decisions: [], total_due: 0, executed: 0, retried: 0, failed: 0, skipped_unsafe: 0, remaining: 0 };
      const allDecisions = await base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: account.id }, 'created_at', 1000).catch(() => []);
      const due = allDecisions.filter((item:any) => dueBidDecision(item, recoveryMode)).sort((a:any, b:any) => new Date(a.queued_at || a.created_at || 0).getTime() - new Date(b.queued_at || b.created_at || 0).getTime());
      result.total_due = due.length;

      for (let index = 0; index < due.length; index++) {
        if (Date.now() - startedAt >= runtimeMs) { result.remaining = due.length - index; break; }
        const decision = due[index];
        try {
          const validation = await validateReduction(base44, decision, targetAcos);
          if (!validation.ok) {
            await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
              status: 'skipped', queue_status: 'cancelled', error_message: validation.reason, updated_at: new Date().toISOString(),
            });
            result.skipped_unsafe++;
            result.decisions.push({ id: decision.id, ok: false, status: 'skipped_unsafe', action: decision.action, reason: validation.reason });
            continue;
          }

          await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
            status: 'approved', queue_status: 'scheduled', queue_hour: WINDOW_START,
            queue_window: recoveryMode ? 'recuperação imediata' : '16:00-18:00',
            error_message: null, updated_at: new Date().toISOString(),
          });

          const response = await base44.asServiceRole.functions.invoke('executeAutopilotDecision', {
            decision_id: decision.id, decision_ids: [decision.id], _window_execution: true, _service_role: true,
          });
          const data = response?.data || response || {};
          const item = data?.results?.find((row:any) => row.id === decision.id) || data?.results?.[0] || data;
          const success = Number(data?.executed || 0) > 0 || item?.status === 'executed' || item?.ok === true;

          if (success) {
            result.executed++;
            result.decisions.push({ id: decision.id, ok: true, status: 'executed', action: decision.action });
          } else if (isTransientError(item)) {
            const retryAt = nextWindowDate();
            await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
              status: 'approved', queue_status: 'scheduled', queue_hour: WINDOW_START,
              queue_window: '16:00-18:00', scheduled_for: retryAt, next_retry_at: retryAt,
              error_message: String(item?.error || data?.error || 'Falha temporária Amazon').slice(0, 500), updated_at: new Date().toISOString(),
            });
            result.retried++;
            result.decisions.push({ id: decision.id, ok: false, status: 'retry_scheduled', next_retry_at: retryAt, error: item?.error || data?.error || null });
          } else {
            result.failed++;
            result.decisions.push({ id: decision.id, ok: false, status: 'failed', error: item?.error || data?.error || 'Falha Amazon' });
          }
        } catch (error) {
          const retryAt = nextWindowDate();
          const attempts = Number(decision.attempt_count || 0) + 1;
          if (attempts < MAX_ATTEMPTS) {
            await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
              status: 'approved', queue_status: 'scheduled', queue_hour: WINDOW_START,
              queue_window: '16:00-18:00', scheduled_for: retryAt, next_retry_at: retryAt,
              error_message: String(error?.message || error).slice(0, 500), updated_at: new Date().toISOString(),
            }).catch(() => {});
            result.retried++;
          } else result.failed++;
          result.decisions.push({ id: decision.id, ok: false, status: attempts < MAX_ATTEMPTS ? 'retry_scheduled' : 'failed', error: error?.message || String(error) });
        }
        if (index < due.length - 1) await wait(spacingMs);
      }

      const remainingRows = await base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: account.id }, 'created_at', 1000).catch(() => []);
      result.remaining = Math.max(result.remaining, remainingRows.filter((item:any) => dueBidDecision(item, recoveryMode)).length);
      output.push(result);
    }

    const totalRemaining = output.reduce((sum, item) => sum + Number(item.remaining || 0), 0);
    return Response.json({
      ok: output.every((item) => item.failed === 0), hour, recovery_mode: recoveryMode,
      operational_window: '16:00-18:00 America/Sao_Paulo',
      accounts_processed: accounts.length, spacing_ms: spacingMs, max_attempts: MAX_ATTEMPTS,
      reduction_guard: {
        minimum_keyword_impressions: MIN_KEYWORD_IMPRESSIONS_FOR_REDUCTION,
        minimum_keyword_clicks: MIN_KEYWORD_CLICKS_FOR_REDUCTION,
        minimum_keyword_spend: MIN_KEYWORD_SPEND_FOR_REDUCTION,
      },
      queue_policy: 'sequential_until_empty', continuation_required: totalRemaining > 0,
      remaining: totalRemaining, results: output,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro na fila de bids' }, { status: 500 });
  }
});