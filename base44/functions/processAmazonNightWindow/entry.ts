import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms:number) => new Promise((resolve) => setTimeout(resolve, ms));
const BID_ACTIONS = new Set(['reduce_bid', 'increase_bid', 'update_bid']);

function brazilHour() {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  return Number(parts.find((part) => part.type === 'hour')?.value || 0);
}

function isUsableAccount(account:any) {
  const status = String(account?.status || '').toLowerCase();
  const connected = ['connected', 'active', 'enabled'].includes(status);
  const hasAdsContext = Boolean(account?.ads_profile_id || account?.ads_refresh_token);
  return connected || hasAdsContext;
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

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });

    const hour = Number(body.hour ?? brazilHour());
    if (![0, 1, 2, 3, 13].includes(hour)) {
      return Response.json({ ok: true, skipped: true, reason: 'Fora das janelas Amazon', hour });
    }

    const accounts = await resolveAccounts(base44, body.amazon_account_id || null);
    if (!accounts.length) {
      return Response.json({ ok: false, error: 'Nenhuma AmazonAccount conectada ou com credenciais Ads foi encontrada.', accounts_processed: 0 }, { status: 409 });
    }

    const output:any[] = [];
    for (const account of accounts) {
      const result:any = {
        amazon_account_id: account.id,
        account_name: account.name || account.seller_name || null,
        hour,
        products_ads_sync: null,
        bid_queue: null,
        suggestions: [],
        decisions: [],
        kickoffs: [],
      };

      try {
        const syncResponse = await base44.asServiceRole.functions.invoke('syncProductsAdsWindow', {
          amazon_account_id: account.id,
          _window_execution: true,
          _service_role: true,
        });
        result.products_ads_sync = syncResponse?.data || syncResponse || {};
      } catch (error) {
        result.products_ads_sync = { ok: false, error: error?.message || String(error) };
      }

      // Bids são drenados por processador dedicado, um a um, sem limite fixo de 5.
      try {
        const bidResponse = await base44.asServiceRole.functions.invoke('processBidDecisionQueue', {
          amazon_account_id: account.id,
          hour,
          spacing_ms: 2500,
          max_runtime_ms: 240000,
          _service_role: true,
        });
        result.bid_queue = bidResponse?.data || bidResponse || {};
      } catch (error) {
        result.bid_queue = { ok: false, error: error?.message || String(error) };
      }

      const suggestions = hour === 13 ? [] : await base44.asServiceRole.entities.KeywordSuggestion.filter({
        amazon_account_id: account.id,
        status: 'approved',
        queue_status: 'scheduled',
        queue_hour: hour,
      }, 'approved_at', 5).catch(() => []);

      const decisions = await base44.asServiceRole.entities.OptimizationDecision.filter({
        amazon_account_id: account.id,
        status: 'approved',
        queue_status: 'scheduled',
        queue_hour: hour,
      }, 'created_at', 50).catch(() => []);

      const kickoffs = await base44.asServiceRole.entities.ProductKickoffQueue.filter({
        amazon_account_id: account.id,
        status: 'scheduled',
        queue_hour: hour,
      }, 'scheduled_at', 5).catch(() => []);

      for (const item of kickoffs) {
        if (item.scheduled_at && new Date(item.scheduled_at).getTime() > Date.now()) continue;
        try {
          await base44.asServiceRole.entities.ProductKickoffQueue.update(item.id, {
            status: 'processing', started_at: new Date().toISOString(), attempt_count: Number(item.attempt_count || 0) + 1,
          });
          const response = item.mode === 'manual_only'
            ? await base44.asServiceRole.functions.invoke('createManualCampaignFromKeywordSuggestion', {
                amazon_account_id: account.id, asin: item.asin, sku: item.sku || null,
                product_name: item.product_name || item.asin, keyword: item.keyword,
                match_type: 'exact', bid: 0.5, _window_execution: true, _service_role: true,
              })
            : await base44.asServiceRole.functions.invoke('autoKickoffProduct', {
                amazon_account_id: account.id, asin: item.asin, sku: item.sku || null,
                product_name: item.product_name || item.asin, max_keywords: 4,
                minimum_ai_confidence: 0.95, _window_execution: true, _service_role: true,
              });
          const data = response?.data || response || {};
          const success = data?.ok !== false;
          await base44.asServiceRole.entities.ProductKickoffQueue.update(item.id, {
            status: success ? 'completed' : 'failed', completed_at: new Date().toISOString(),
            last_error: success ? null : data?.error || data?.message || 'Falha no Kick-off',
          });
          result.kickoffs.push({ id: item.id, asin: item.asin, ok: success });
        } catch (error) {
          await base44.asServiceRole.entities.ProductKickoffQueue.update(item.id, {
            status: 'failed', completed_at: new Date().toISOString(), last_error: error?.message || String(error),
          }).catch(() => {});
          result.kickoffs.push({ id: item.id, asin: item.asin, ok: false, error: error?.message || String(error) });
        }
        await wait(14000);
      }

      for (const suggestion of suggestions) {
        try {
          const response = await base44.asServiceRole.functions.invoke('createManualCampaignFromKeywordSuggestion', {
            amazon_account_id: account.id, suggestion_ids: [suggestion.id], _window_execution: true, _service_role: true,
          });
          const item = response?.data?.results?.[0] || response?.results?.[0];
          const success = Boolean(item?.ok || item?.already_exists);
          await base44.asServiceRole.entities.KeywordSuggestion.update(suggestion.id, {
            queue_status: success ? 'completed' : 'failed', queue_processed_at: new Date().toISOString(),
          });
          result.suggestions.push({ id: suggestion.id, ok: success });
        } catch (error) {
          result.suggestions.push({ id: suggestion.id, ok: false, error: error?.message || String(error) });
        }
        await wait(14000);
      }

      // Mantém outras decisões; bids já foram processados acima.
      for (const decision of decisions.filter((item:any) => item.action !== 'pause_campaign' && !BID_ACTIONS.has(String(item.action || '')))) {
        try {
          const response = await base44.asServiceRole.functions.invoke('executeAutopilotDecision', {
            decision_id: decision.id, decision_ids: [decision.id], _window_execution: true, _service_role: true,
          });
          const data = response?.data || response || {};
          const success = Number(data?.executed || 0) > 0 || data?.results?.some((item:any) => item.ok);
          result.decisions.push({ id: decision.id, ok: Boolean(success), action: decision.action });
        } catch (error) {
          result.decisions.push({ id: decision.id, ok: false, action: decision.action, error: error?.message || String(error) });
        }
        await wait(14000);
      }

      output.push(result);
    }

    return Response.json({
      ok: output.every((item) => item.bid_queue?.ok !== false),
      hour,
      account_resolution: body.amazon_account_id ? 'explicit' : 'automatic',
      accounts_processed: accounts.length,
      windows: ['00:00-04:00', '13:00-14:00'],
      bid_policy: 'all_due_sequentially',
      bid_spacing_seconds: 2.5,
      products_ads_auto_sync: true,
      results: output,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro na fila Amazon' }, { status: 500 });
  }
});
