import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const s = (v: unknown) => String(v || '').trim();
const low = (v: unknown) => s(v).toLowerCase();
const n = (v: unknown, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const TERMINAL = new Set(['blocked', 'cancelled', 'expired', 'skipped', 'rejected', 'failed_final']);

function isKeywordNegative(row: any) {
  const action = low(row.action);
  return action.includes('negative') || action.includes('negativ');
}

function entityTarget(row: any) {
  const action = low(row.action);
  if (action.includes('pause') || action.includes('enable') || action.includes('archive')) return 'state';
  if (action.includes('budget')) return 'budget';
  if (isKeywordNegative(row)) return 'negative';
  return 'bid';
}

function mutationKey(row: any) {
  const aid = s(row.amazon_account_id);
  const entityType = low(row.entity_type || (row.keyword_id ? 'keyword' : row.campaign_id ? 'campaign' : 'entity'));
  const entityId = s(row.keyword_id || row.product_target_id || row.target_id || row.entity_id || row.campaign_id);
  const base = s(row.conflict_group) || `${aid}|${entityType}|${entityId}`;
  return `${base}|${entityTarget(row)}`;
}

function isBidMutation(row: any) {
  const action = low(row.action);
  return ['set_bid', 'update_bid', 'reduce_bid', 'increase_bid', 'bid_change', 'bid_increase', 'bid_decrease'].includes(action) ||
    (Number.isFinite(Number(row.value_before)) && Number.isFinite(Number(row.value_after)) && entityTarget(row) === 'bid');
}

function isTerminalMutation(row: any) {
  const action = low(row.action);
  return action.includes('pause') || action.includes('archive') || isKeywordNegative(row);
}

function priority(row: any) {
  const text = `${low(row.rule_key)} ${low(row.reason_code)} ${low(row.source_function)} ${low(row.rationale)} ${low(row.error_message)}`;
  if (/out.of.stock|sem estoque|stock|inventory|product_inactive|eligibility|not_eligible|not_buyable|listing_inactive|break.?even|strong_containment|economic.*loss|loss.*economic|negative_margin|daily.?cap/.test(text)) return 0;
  if (/winner|protected_high_performance|protection/.test(text)) return 1;
  if (/budget|pacing|safe.?cpc|margin|acos/.test(text)) return 1;
  if (/daypart|hour|hor[aá]rio|season|weekend|holiday/.test(text)) return 2;
  if (/zero.?delivery|explor|impression|delivery|recovery|sales/.test(text)) return 3;
  return 2;
}

// P1_STRUCTURED_HARD_TERMINAL_V3
const HARD_TERMINAL_REASON_CODES = new Set([
  'out_of_stock',
  'sem_estoque',
  'not_buyable',
  'listing_inactive',
  'listing_suppressed',
  'product_inactive',
  'not_eligible',
  'negative_margin',
  'confirmed_economic_loss',
  'break_even_violation',
  'daily_cap',
  'account_daily_cap',
  'budget_exceeded',
  'user_pause',
  'manual_pause',
  // Pausa somente após progressão de redução + prova econômica persistente.
  'waste_persistent_after_reductions',
]);

function isHardTerminal(row: any) {
  if (!isTerminalMutation(row)) return false;

  const reasonCode = low(row.reason_code).replace(/[^a-z0-9]+/g, '_');
  const ruleKey = low(row.rule_key).replace(/[^a-z0-9]+/g, '_');

  if (HARD_TERMINAL_REASON_CODES.has(reasonCode)) return true;
  if (HARD_TERMINAL_REASON_CODES.has(ruleKey)) return true;

  // Compatibilidade somente para códigos estruturados legados.
  const structured = `${reasonCode} ${ruleKey}`;
  return /out_of_stock|not_buyable|listing_inactive|listing_suppressed|product_inactive|not_eligible|negative_margin|confirmed_economic_loss|break_even|daily_cap|budget_exceeded|waste_persistent_after_reductions/.test(structured);
}

function chooseBidWinner(rows: any[]) {
  const ranked = [...rows].sort((a, b) => {
    const pa = priority(a), pb = priority(b);
    if (pa !== pb) return pa - pb;
    const aBefore = n(a.value_before, NaN), aAfter = n(a.value_after, NaN);
    const bBefore = n(b.value_before, NaN), bAfter = n(b.value_after, NaN);
    const hard = pa <= 1;
    if (hard && Number.isFinite(aAfter) && Number.isFinite(bAfter)) return aAfter - bAfter;
    // Sales-first: quando os hard guards já aprovaram a entidade, favorece a
    // proposta que recupera mais entrega/vendas, sempre dentro do evidence gate.
    if (!hard && Number.isFinite(aAfter) && Number.isFinite(bAfter)) return bAfter - aAfter;
    const aDelta = Number.isFinite(aBefore) && Number.isFinite(aAfter) ? Math.abs(aAfter - aBefore) : 0;
    const bDelta = Number.isFinite(bBefore) && Number.isFinite(bAfter) ? Math.abs(bAfter - bBefore) : 0;
    return aDelta - bDelta;
  });
  return ranked[0] || null;
}

async function closeTerminalStates(base44: any, aid: string) {
  let closed = 0;
  for (const status of TERMINAL) {
    const rows = await base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: aid, status }, '-updated_at', 1000).catch(() => []);
    for (const row of rows) {
      const queue = low(row.queue_status);
      const confirmation = low(row.amazon_confirmation_status || row.confirmation_status);
      const patch: any = {};
      if (['pending', 'processing', 'scheduled', 'approved', ''].includes(queue)) patch.queue_status = 'closed';
      if (['pending', 'processing', ''].includes(confirmation)) {
        patch.confirmation_status = 'not_applicable';
        patch.amazon_confirmation_status = 'not_applicable';
      }
      if (Object.keys(patch).length) {
        patch.updated_at = new Date().toISOString();
        await base44.asServiceRole.entities.OptimizationDecision.update(row.id, patch).catch(() => {});
        closed++;
      }
    }
  }
  return closed;
}

Deno.serve(async (request) => {
  try {
    const base44: any = createClientFromRequest(request) as any;
    const body: any = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const since = s(body.since) || new Date(Date.now() - 20 * 60_000).toISOString();
    const accounts: any[] = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, undefined, 1).catch(() => [])
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 100).catch(() => []);
    const results: any[] = [];

    for (const account of accounts) {
      const aid = s(account.id);
      const approved = await base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: aid, status: 'approved', created_at: { $gte: since } }, '-created_at', 3000).catch(() => []);
      const groups = new Map<string, any[]>();
      for (const row of approved) {
        const key = mutationKey(row);
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(row);
      }

      let groupsArbitrated = 0, cancelled = 0, preserved = 0, softPausesSuperseded = 0;
      const decisions: any[] = [];
      for (const [key, rows] of groups.entries()) {
        if (rows.length === 1) {
          const only = rows[0];

          // P1_SOFT_PAUSE_TO_NO_DECISION_V3:
          // Uma pausa não-hard sem alternativa concorrente não é uma ação.
          // Fecha como NO_DECISION e deixa o próximo ciclo procurar recuperação,
          // redução de bid, realocação ou nova evidência.
          if (isTerminalMutation(only) && !isHardTerminal(only)) {
            const now = new Date().toISOString();
            await base44.asServiceRole.entities.OptimizationDecision.update(
              only.id,
              {
                status: 'cancelled',
                queue_status: 'closed',
                approval_status: 'no_decision_soft_pause',
                confirmation_status: 'not_applicable',
                amazon_confirmation_status: 'not_applicable',
                canonical_arbitrated: true,
                canonical_arbitration_key: key,
                canonical_arbitrated_at: now,
                hide_from_live_operational_feed: true,
                error_message:
                  'NO_DECISION_SOFT_PAUSE: sem hard guard ou alternativa executável no snapshot atual.',
                updated_at: now,
              },
            ).catch(() => {});
            cancelled++;
            softPausesSuperseded++;
            groupsArbitrated++;
            decisions.push({
              key,
              winner_id: null,
              proposals: 1,
              winner_action: 'NO_DECISION',
              hard_terminal: false,
            });
            continue;
          }

          await base44.asServiceRole.entities.OptimizationDecision.update(only.id, {
            canonical_arbitrated: true,
            canonical_arbitration_key: key,
            canonical_arbitrated_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).catch(() => {});
          preserved++;
          continue;
        }

        const terminalRows = rows.filter(isTerminalMutation);
        const hardTerminalRows = terminalRows.filter(isHardTerminal);
        const bidRows = rows.filter(isBidMutation);
        const nonTerminalRows = rows.filter((row: any) => !isTerminalMutation(row));
        let winner: any = null;

        // HARD terminal wins only for real safety/economic limits. A soft pause
        // can no longer kill a valid recovery/growth proposal. This prevents
        // PAUSE->CANCELLED storms and forces the motor to prefer an executable
        // sales alternative when evidence allows one.
        if (hardTerminalRows.length) {
          winner = [...hardTerminalRows].sort(
            (a, b) => priority(a) - priority(b),
          )[0];
        } else if (bidRows.length) {
          winner = chooseBidWinner(bidRows);
        } else if (nonTerminalRows.length) {
          winner = [...nonTerminalRows].sort(
            (a, b) => priority(a) - priority(b),
          )[0];
        } else if (terminalRows.length) {
          // P1_ONLY_SOFT_PAUSES_NO_DECISION_V3
          const now = new Date().toISOString();
          for (const row of terminalRows) {
            await base44.asServiceRole.entities.OptimizationDecision.update(
              row.id,
              {
                status: 'cancelled',
                queue_status: 'closed',
                approval_status: 'no_decision_soft_pause',
                confirmation_status: 'not_applicable',
                amazon_confirmation_status: 'not_applicable',
                canonical_arbitrated: true,
                canonical_arbitration_key: key,
                canonical_arbitrated_at: now,
                hide_from_live_operational_feed: true,
                error_message:
                  'NO_DECISION_SOFT_PAUSE: nenhuma alternativa executável no snapshot atual.',
                updated_at: now,
              },
            ).catch(() => {});
          }
          cancelled += terminalRows.length;
          softPausesSuperseded += terminalRows.length;
          groupsArbitrated++;
          decisions.push({
            key,
            winner_id: null,
            proposals: terminalRows.length,
            winner_action: 'NO_DECISION',
            hard_terminal: false,
          });
          continue;
        }

        if (!winner) continue;

        const now = new Date().toISOString();
        const proposalSummary = rows.map((r: any) => ({ id: r.id, action: r.action, before: r.value_before ?? null, after: r.value_after ?? null, priority: priority(r), hard_terminal: isHardTerminal(r), source: r.source_function || null }));
        await base44.asServiceRole.entities.OptimizationDecision.update(winner.id, {
          canonical_arbitrated: true,
          canonical_arbitration_key: key,
          canonical_arbitrated_at: now,
          arbitration_proposal_count: rows.length,
          arbitration_proposals: JSON.stringify(proposalSummary),
          engine_version: body.sales_engine_version || winner.engine_version || 'sales-risk-v1',
          rationale: `${winner.rationale || ''} [SALES_FIRST_ARBITER: ${rows.length} propostas consolidadas; hard safety prevalece, senão a alternativa executável de vendas/entrega tem preferência.]`,
          updated_at: now,
        }).catch(() => {});

        for (const loser of rows) {
          if (loser.id === winner.id) continue;
          const softPause = isTerminalMutation(loser) && !isHardTerminal(loser);
          await base44.asServiceRole.entities.OptimizationDecision.update(loser.id, {
            status: 'cancelled',
            queue_status: 'closed',
            confirmation_status: 'not_applicable',
            amazon_confirmation_status: 'not_applicable',
            approval_status: softPause ? 'replaced_by_sales_alternative' : 'superseded_by_canonical_arbiter',
            cancelled_by_decision_id: winner.id,
            canonical_arbitrated: true,
            canonical_arbitration_key: key,
            canonical_arbitrated_at: now,
            superseded_proposal: true,
            hide_from_live_operational_feed: true,
            error_message: softPause
              ? `SOFT_PAUSE_REPLACED_BY_SALES_ALTERNATIVE: decisão ${winner.id}.`
              : `CANONICAL_ARBITRATION_SUPERSEDED: consolidada pela decisão ${winner.id}.`,
            updated_at: now,
          }).catch(() => {});
          if (softPause) softPausesSuperseded++;
          cancelled++;
        }
        groupsArbitrated++;
        decisions.push({ key, winner_id: winner.id, proposals: rows.length, winner_action: winner.action, winner_after: winner.value_after ?? null, hard_terminal: isHardTerminal(winner) });
      }

      const terminalStatesClosed = await closeTerminalStates(base44, aid);
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: aid,
        operation: 'canonical_decision_arbitration',
        trigger_type: body.trigger_type || 'canonical_cycle',
        status: 'success',
        records_processed: approved.length,
        result_summary: `approved=${approved.length}; groups=${groups.size}; arbitrated=${groupsArbitrated}; cancelled=${cancelled}; soft_pauses_replaced=${softPausesSuperseded}; single=${preserved}; terminal_states_closed=${terminalStatesClosed}`,
        started_at: since,
        completed_at: new Date().toISOString(),
      }).catch(() => {});
      results.push({ amazon_account_id: aid, approved: approved.length, groups: groups.size, groups_arbitrated: groupsArbitrated, cancelled, soft_pauses_replaced: softPausesSuperseded, preserved_single: preserved, terminal_states_closed: terminalStatesClosed, decisions: decisions.slice(0, 100) });
    }

    return Response.json({ ok: true, arbiter: 'sales-first-canonical-pre-execution-v3', policy: 'hard safety/economic terminal -> otherwise executable sales/recovery proposal -> one net mutation per entity+domain -> executor -> Amazon confirmation', results });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
});
