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
    const hour = body.hour ?? brazilHour();
    if (hour < 0 || hour > 3) return Response.json({ ok: true, skipped: true, hour });

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id })
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' });

    const output = [];
    for (const account of accounts) {
      const suggestions = await base44.asServiceRole.entities.KeywordSuggestion.filter({ amazon_account_id: account.id, status: 'approved', queue_hour: hour }, 'approved_at', 5);
      const decisions = await base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: account.id, status: 'approved' }, 'created_at', 5);
      const result = { amazon_account_id: account.id, suggestions: [], decisions: [] };

      for (const s of suggestions) {
        try {
          const res = await base44.asServiceRole.functions.invoke('createManualCampaignFromKeywordSuggestion', { amazon_account_id: account.id, suggestion_ids: [s.id], _window_execution: true, _service_role: true });
          const item = res?.data?.results?.[0] || res?.results?.[0];
          await base44.asServiceRole.entities.KeywordSuggestion.update(s.id, { queue_status: item?.ok || item?.already_exists ? 'completed' : 'failed', queue_processed_at: new Date().toISOString() });
          result.suggestions.push({ id: s.id, ok: Boolean(item?.ok || item?.already_exists) });
        } catch (e) {
          result.suggestions.push({ id: s.id, ok: false, error: e?.message || String(e) });
        }
        await wait(12000);
      }

      for (const d of decisions.filter((x) => x.action !== 'pause_campaign')) {
        try {
          const res = await base44.asServiceRole.functions.invoke('executeAutopilotDecision', { decision_id: d.id, _window_execution: true, _service_role: true });
          result.decisions.push({ id: d.id, ok: (res?.data?.executed || 0) > 0 });
        } catch (e) {
          result.decisions.push({ id: d.id, ok: false, error: e?.message || String(e) });
        }
        await wait(12000);
      }

      output.push(result);
    }

    return Response.json({ ok: true, hour, spacing_seconds: 12, max_items_per_account: 10, results: output });
  } catch (e) {
    return Response.json({ ok: false, error: e?.message || 'Erro na fila Amazon' }, { status: 500 });
  }
});
