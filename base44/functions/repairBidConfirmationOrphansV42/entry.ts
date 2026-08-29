import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

const BID_ACTIONS = new Set(['set_bid', 'increase_bid', 'reduce_bid', 'update_bid']);
const CONFIRMABLE_STATUSES = ['executed', 'confirming', 'completed', 'awaiting_confirmation', 'conflict_reconciling'];
const LOCAL_TERMINAL_STATUSES = ['blocked', 'cancelled', 'skipped', 'superseded', 'expired'];

function ts(row: any): number {
  const raw = row?.executed_at || row?.last_attempt_at || row?.updated_at || row?.created_at || 0;
  const value = Date.parse(String(raw));
  return Number.isFinite(value) ? value : 0;
}

function attempted(row: any): boolean {
  // last_attempt_at sozinho NÃO é evidência de envio à Amazon: gates locais também
  // gravam esse campo. Só estes sinais demonstram tentativa operacional real.
  return Boolean(row?.amazon_request_id || row?.amazon_response || row?.executed_at || Number(row?.attempt_count || 0) > 0);
}

async function resolveKeyword(base44: any, row: any): Promise<any | null> {
  const aid = String(row.amazon_account_id || '');
  if (!aid) return null;
  if (row.keyword_id) {
    const direct = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid, keyword_id: String(row.keyword_id) }, '-updated_at', 2).catch(() => []);
    if (direct[0]) return direct[0];
  }
  const filters: any = { amazon_account_id: aid };
  if (row.asin) filters.asin = String(row.asin);
  if (row.keyword_text) filters.keyword_text = String(row.keyword_text);
  if (!row.asin && !row.keyword_text) return null;
  const candidates = await base44.asServiceRole.entities.Keyword.filter(filters, '-updated_at', 20).catch(() => []);
  return candidates.find((item: any) => String(item.state || item.status || '').toLowerCase() === 'enabled') || candidates[0] || null;
}

function entityKey(row: any): string {
  const provisional = String(row.keyword_id || row.entity_id || `${row.asin || ''}|${row.keyword_text || ''}` || row.id);
  return `${row.amazon_account_id || ''}|${provisional}`;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accountId = body.amazon_account_id ? String(body.amazon_account_id) : '';
    const cutoff = Date.now() - 24 * 3600_000;
    const allStatuses = [...CONFIRMABLE_STATUSES, ...LOCAL_TERMINAL_STATUSES];
    const batches = await Promise.all(allStatuses.map((status) =>
      base44.asServiceRole.entities.OptimizationDecision.filter(
        accountId ? { amazon_account_id: accountId, status } : { status }, '-updated_at', 500
      ).catch(() => [])
    ));
    const rows = batches.flat()
      .filter((row: any) => BID_ACTIONS.has(String(row.action || '')))
      .filter((row: any) => ts(row) >= cutoff)
      .filter((row: any) => String(row.confirmation_status || '').toLowerCase() !== 'confirmed');

    // 1) Estados terminais locais que nunca chegaram à Amazon não possuem
    // confirmação pendente. Normalizamos isso sem reenviar qualquer mutação.
    let terminalNormalized = 0;
    for (const row of rows) {
      const status = String(row.status || '').toLowerCase();
      if (!LOCAL_TERMINAL_STATUSES.includes(status) || attempted(row)) continue;
      await base44.asServiceRole.entities.OptimizationDecision.update(row.id, {
        confirmation_required: false,
        confirmation_status: 'not_applicable',
        confirmation_error: null,
        queue_status: ['blocked'].includes(status) ? 'cancelled' : (row.queue_status || 'completed'),
        updated_at: new Date().toISOString(),
      }).catch(() => null);
      terminalNormalized++;
    }

    // 2) Apenas decisões realmente tentadas podem entrar na confirmação remota.
    const confirmable = rows.filter((row: any) =>
      CONFIRMABLE_STATUSES.includes(String(row.status || '').toLowerCase()) && attempted(row)
    );
    const byEntity = new Map<string, any[]>();
    for (const row of confirmable) {
      const key = entityKey(row);
      const group = byEntity.get(key) || [];
      group.push(row);
      byEntity.set(key, group);
    }

    let normalized = 0, resolvedIds = 0, superseded = 0;
    const accounts = new Set<string>();

    for (const group of byEntity.values()) {
      group.sort((a, b) => ts(b) - ts(a));
      const latest = group[0];
      for (const older of group.slice(1)) {
        await base44.asServiceRole.entities.OptimizationDecision.update(older.id, {
          status: 'superseded', queue_status: 'completed', confirmation_required: false,
          confirmation_status: 'not_applicable',
          confirmation_error: `SUPERSEDED_BY_NEWER_BID_DECISION:${latest.id}`,
          updated_at: new Date().toISOString(),
        }).catch(() => null);
        superseded++;
      }

      const keyword = await resolveKeyword(base44, latest);
      const patch: any = {
        status: 'confirming', queue_status: 'completed', confirmation_required: true,
        confirmation_status: 'pending', confirmation_error: null,
        last_attempt_at: latest.last_attempt_at || latest.executed_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (keyword) {
        const kid = String(keyword.keyword_id || keyword.keywordId || '');
        if (kid) {
          patch.keyword_id = kid;
          if (String(latest.entity_type || '') === 'keyword') patch.entity_id = kid;
          resolvedIds++;
        }
        if (!latest.campaign_id && keyword.campaign_id) patch.campaign_id = String(keyword.campaign_id);
        if (!latest.ad_group_id && keyword.ad_group_id) patch.ad_group_id = String(keyword.ad_group_id);
      }
      await base44.asServiceRole.entities.OptimizationDecision.update(latest.id, patch).catch(() => null);
      normalized++;
      if (latest.amazon_account_id) accounts.add(String(latest.amazon_account_id));
    }

    const confirmations: any[] = [];
    for (const aid of accounts) {
      const response = await base44.asServiceRole.functions.invoke('confirmExecutedDecisions', {
        _service_role: true, amazon_account_id: aid, trigger_type: 'repair_bid_confirmation_orphans_v42'
      }).catch((error: any) => ({ ok: false, error: error?.message || String(error) }));
      confirmations.push({ amazon_account_id: aid, ok: response?.ok !== false, data: response?.data || response });
    }

    return Response.json({
      ok: true,
      scanned: rows.length,
      terminal_normalized: terminalNormalized,
      normalized,
      resolved_remote_keyword_ids: resolvedIds,
      superseded,
      confirmations,
      amazon_mutations_sent: 0,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
});
