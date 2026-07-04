import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function brazilHour() {
  const p = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).formatToParts(new Date());
  return Number(p.find((x) => x.type === 'hour')?.value || 0);
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const hour = Number(body.hour ?? brazilHour());
    if (![0, 1, 2, 3, 13].includes(hour)) return Response.json({ ok: true, skipped: true, hour });

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id })
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' });

    const output = [];
    for (const account of accounts) {
      const result = { amazon_account_id: account.id, hour, products_ads_sync: null, suggestions: [], decisions: [], kickoffs: [] };

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

      const suggestions = hour === 13 ? [] : await base44.asServiceRole.entities.KeywordSuggestion.filter({ amazon_account_id: account.id, status: 'approved', queue_status: 'scheduled', queue_hour: hour }, 'approved_at', 5);
      const decisions = await base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: account.id, status: 'approved', queue_status: 'scheduled', queue_hour: hour }, 'created_at', 5);
      const kickoffs = await base44.asServiceRole.entities.ProductKickoffQueue.filter({ amazon_account_id: account.id, status: 'scheduled', queue_hour: hour }, 'scheduled_at', 5).catch(() => []);

      for (const item of kickoffs) {
        if (item.scheduled_at && new Date(item.scheduled_at).getTime() > Date.now()) continue;
        try {
          await base44.asServiceRole.entities.ProductKickoffQueue.update(item.id, { status: 'processing', started_at: new Date().toISOString(), attempt_count: Number(item.attempt_count || 0) + 1 });
          let response;
          if (item.mode === 'manual_only') {
            response = await base44.asServiceRole.functions.invoke('createManualCampaignFromKeywordSuggestion', {
              amazon_account_id: item.amazon_account_id,
              asin: item.asin,
              sku: item.sku || null,
              product_name: item.product_name || item.asin,
              keyword: item.keyword,
              match_type: 'exact',
              bid: 0.5,
              _window_execution: true,
              _service_role: true,
            });
          } else {
            response = await base44.asServiceRole.functions.invoke('autoKickoffProduct', {
              amazon_account_id: item.amazon_account_id,
              asin: item.asin,
              sku: item.sku || null,
              product_name: item.product_name || item.asin,
              max_keywords: 4,
              minimum_ai_confidence: 0.95,
              _window_execution: true,
              _service_role: true,
            });
          }
          const data = response?.data || response || {};
          const success = data?.ok !== false;
          await base44.asServiceRole.entities.ProductKickoffQueue.update(item.id, { status: success ? 'completed' : 'failed', completed_at: new Date().toISOString(), last_error: success ? null : data?.error || data?.message || 'Falha no Kick-off' });
          result.kickoffs.push({ id: item.id, asin: item.asin, ok: success });
        } catch (error) {
          await base44.asServiceRole.entities.ProductKickoffQueue.update(item.id, { status: 'failed', completed_at: new Date().toISOString(), last_error: error?.message || String(error) }).catch(() => {});
          result.kickoffs.push({ id: item.id, asin: item.asin, ok: false, error: error?.message || String(error) });
        }
        await wait(14000);
      }

      for (const s of suggestions) {
        try {
          const res = await base44.asServiceRole.functions.invoke('createManualCampaignFromKeywordSuggestion', { amazon_account_id: account.id, suggestion_ids: [s.id], _window_execution: true, _service_role: true });
          const item = res?.data?.results?.[0] || res?.results?.[0];
          await base44.asServiceRole.entities.KeywordSuggestion.update(s.id, { queue_status: item?.ok || item?.already_exists ? 'completed' : 'failed', queue_processed_at: new Date().toISOString() });
          result.suggestions.push({ id: s.id, ok: Boolean(item?.ok || item?.already_exists) });
        } catch (e) {
          result.suggestions.push({ id: s.id, ok: false, error: e?.message || String(e) });
        }
        await wait(14000);
      }

      for (const d of decisions.filter((x) => x.action !== 'pause_campaign')) {
        try {
          const res = await base44.asServiceRole.functions.invoke('executeAutopilotDecision', { decision_id: d.id, _window_execution: true, _service_role: true });
          result.decisions.push({ id: d.id, ok: (res?.data?.executed || 0) > 0, action: d.action });
        } catch (e) {
          result.decisions.push({ id: d.id, ok: false, action: d.action, error: e?.message || String(e) });
        }
        await wait(14000);
      }

      output.push(result);
    }

    return Response.json({ ok: true, hour, windows: ['00:00-04:00', '13:00-14:00'], spacing_seconds: 14, products_ads_auto_sync: true, max_items_per_account: 15, results: output });
  } catch (e) {
    return Response.json({ ok: false, error: e?.message || 'Erro na fila Amazon' }, { status: 500 });
  }
});
