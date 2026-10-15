import { sql } from './db.ts';

let ensurePromise: Promise<void> | null = null;

export async function ensureDecisionExecutionClaimTable(): Promise<void> {
  if (ensurePromise) return await ensurePromise;
  ensurePromise = (async () => {
    await sql.unsafe(`
      create table if not exists motor_decision_execution_claims (
        decision_id text primary key,
        account_id text not null,
        idempotency_key text not null default '',
        owner_id text not null,
        attempt integer not null default 1,
        lease_expires_at timestamptz not null,
        version bigint not null default 1,
        status text not null check (status in ('authorized','remote_acknowledged','remote_unknown','failed_before_send')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        finished_at timestamptz
      )
    `);
    await sql.unsafe(
      `alter table motor_decision_execution_claims add column if not exists owner_id text`,
    );
    await sql.unsafe(
      `alter table motor_decision_execution_claims add column if not exists attempt integer not null default 1`,
    );
    await sql.unsafe(
      `alter table motor_decision_execution_claims add column if not exists lease_expires_at timestamptz`,
    );
    await sql.unsafe(
      `alter table motor_decision_execution_claims add column if not exists version bigint not null default 1`,
    );
    // The table is introduced by this service and never had legacy owners. The
    // fallback only makes a previous local prototype schema readable.
    await sql.unsafe(
      `update motor_decision_execution_claims set owner_id=coalesce(owner_id,'legacy'), lease_expires_at=coalesce(lease_expires_at,updated_at + interval '3 minutes')`,
    );
    await sql.unsafe(
      `alter table motor_decision_execution_claims alter column owner_id set not null`,
    );
    await sql.unsafe(
      `create unique index if not exists motor_decision_execution_claims_idempotency_unique on motor_decision_execution_claims(account_id,idempotency_key) where idempotency_key <> ''`,
    );
  })();
  try {
    await ensurePromise;
  } catch (error) {
    ensurePromise = null;
    throw error;
  }
}

/** Atomically reserves one approved decision before any Amazon mutation is sent. */
export async function reserveOptimizationDecisionExecution(input: {
  decisionId: string;
  accountId: string;
}): Promise<
  {
    authorized: boolean;
    reason?: string;
    ownerId?: string;
    version?: number;
    attempt?: number;
    leaseExpiresAt?: string;
  }
> {
  await ensureDecisionExecutionClaimTable();
  return await reserveOptimizationDecisionExecutionWithSql(sql, input);
}

function quoteTable(name: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error('Nome interno de tabela inválido.');
  return `"${name}"`;
}

/** Exported with injectable table names for isolated PostgreSQL integration tests. */
export async function reserveOptimizationDecisionExecutionWithSql(
  client: any,
  input: { decisionId: string; accountId: string },
  tables = { decision: 'optimization_decision', claim: 'motor_decision_execution_claims' },
): Promise<
  {
    authorized: boolean;
    reason?: string;
    ownerId?: string;
    version?: number;
    attempt?: number;
    leaseExpiresAt?: string;
  }
> {
  const decisionId = String(input.decisionId || '').trim();
  const accountId = String(input.accountId || '').trim();
  if (!decisionId || !accountId) return { authorized: false, reason: 'missing_scope' };
  const decisionTable = quoteTable(tables.decision);
  const claimTable = quoteTable(tables.claim);

  return await client.begin(async (tx: any) => {
    await tx.unsafe('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `decision-execution:${accountId}:${decisionId}`,
    ]);
    const current = await tx.unsafe(
      `select data from ${decisionTable} where id=$1 and data->>'amazon_account_id'=$2 limit 1`,
      [decisionId, accountId] as any[],
    ) as unknown as Array<{ data: Record<string, unknown> | string }>;
    const row = current[0];
    if (!row) return { authorized: false, reason: 'decision_not_found_or_account_mismatch' };
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    if (data?.status !== 'approved') {
      return { authorized: false, reason: `decision_status_${String(data?.status || 'missing')}` };
    }

    const owner = crypto.randomUUID();
    const leaseSeconds = Math.max(
      30,
      Math.min(600, Number(Deno.env.get('DECISION_EXECUTION_LEASE_SECONDS') || 180)),
    );
    const inserted = await tx.unsafe(
      `insert into ${claimTable}(decision_id,account_id,idempotency_key,owner_id,attempt,lease_expires_at,version,status)
       values($1,$2,$3,$4,1,now()+($5::int * interval '1 second'),1,'authorized') on conflict do nothing returning decision_id,owner_id,attempt,version,lease_expires_at`,
      [decisionId, accountId, String(data.idempotency_key || ''), owner, leaseSeconds] as any[],
    ) as unknown as Array<
      {
        decision_id: string;
        owner_id: string;
        attempt: number;
        version: number;
        lease_expires_at: string;
      }
    >;
    if (!inserted[0]) {
      const existing = await tx.unsafe(
        `select decision_id,status,lease_expires_at from ${claimTable} where decision_id=$1 or (account_id=$2 and idempotency_key=$3 and idempotency_key<>'') limit 1`,
        [decisionId, accountId, String(data.idempotency_key || '')] as any[],
      ) as unknown as Array<{ decision_id: string; status: string; lease_expires_at: string }>;
      const claim = existing[0];
      if (
        claim?.status === 'authorized' && new Date(claim.lease_expires_at).getTime() <= Date.now()
      ) {
        // Expired ownership after a possible remote write is uncertainty, never
        // permission for a replacement worker to replay the action.
        await tx.unsafe(
          `update ${claimTable} set status='remote_unknown',version=version+1,updated_at=now(),finished_at=now() where decision_id=$1 and status='authorized' and lease_expires_at<=now()`,
          [claim.decision_id] as any[],
        );
        await tx.unsafe(
          `update ${decisionTable} set data=jsonb_set(jsonb_set(data,'{status}','"conflict_reconciling"'::jsonb,true),'{queue_status}','"remote_unknown"'::jsonb,true),updated_date=now() where id=$1 and data->>'status'='executing'`,
          [claim.decision_id] as any[],
        );
        return { authorized: false, reason: 'remote_outcome_requires_reconciliation' };
      }
      return {
        authorized: false,
        reason: `decision_already_reserved:${String(claim?.decision_id || 'unknown')}`,
      };
    }

    const changed = await tx.unsafe(
      `update ${decisionTable}
       set data=jsonb_set(
         jsonb_set(
           jsonb_set(data,'{status}','"executing"'::jsonb,true),
           '{queue_status}','"processing"'::jsonb,true),
         '{last_attempt_at}',to_jsonb(now()::text),true),
         updated_date=now()
       where id=$1 and data->>'amazon_account_id'=$2 and data->>'status'='approved'
       returning id`,
      [decisionId, accountId] as any[],
    ) as unknown as Array<{ id: string }>;
    if (!changed[0]) {
      await tx.unsafe(
        `delete from ${claimTable} where decision_id=$1 and owner_id=$2`,
        [decisionId, owner] as any[],
      );
      return { authorized: false, reason: 'decision_status_changed_during_reservation' };
    }
    return {
      authorized: true,
      ownerId: owner,
      attempt: Number(inserted[0].attempt),
      version: Number(inserted[0].version),
      leaseExpiresAt: String(inserted[0].lease_expires_at),
    };
  });
}

export async function renewOptimizationDecisionExecution(input: {
  decisionId: string;
  ownerId: string;
  version: number;
}): Promise<{ renewed: boolean; version?: number; leaseExpiresAt?: string }> {
  await ensureDecisionExecutionClaimTable();
  return await renewOptimizationDecisionExecutionWithSql(sql, input);
}

export async function renewOptimizationDecisionExecutionWithSql(
  client: any,
  input: {
    decisionId: string;
    ownerId: string;
    version: number;
  },
  claimTable = 'motor_decision_execution_claims',
): Promise<{ renewed: boolean; version?: number; leaseExpiresAt?: string }> {
  const leaseSeconds = Math.max(
    30,
    Math.min(600, Number(Deno.env.get('DECISION_EXECUTION_LEASE_SECONDS') || 180)),
  );
  const table = quoteTable(claimTable);
  const rows = await client.unsafe(
    `update ${table} set lease_expires_at=now()+($4::int * interval '1 second'),version=version+1,updated_at=now()
     where decision_id=$1 and owner_id=$2 and version=$3 and status='authorized' and lease_expires_at>now()
     returning version,lease_expires_at`,
    [input.decisionId, input.ownerId, input.version, leaseSeconds] as any[],
  ) as unknown as Array<{ version: number; lease_expires_at: string }>;
  return rows[0]
    ? {
      renewed: true,
      version: Number(rows[0].version),
      leaseExpiresAt: String(rows[0].lease_expires_at),
    }
    : { renewed: false };
}

export async function finishOptimizationDecisionExecution(input: {
  decisionId: string;
  ownerId: string;
  version: number;
  status: 'remote_acknowledged' | 'remote_unknown' | 'failed_before_send';
}): Promise<boolean> {
  await ensureDecisionExecutionClaimTable();
  return await finishOptimizationDecisionExecutionWithSql(sql, input);
}

export async function finishOptimizationDecisionExecutionWithSql(
  client: any,
  input: {
    decisionId: string;
    ownerId: string;
    version: number;
    status: 'remote_acknowledged' | 'remote_unknown' | 'failed_before_send';
  },
  tables = { decision: 'optimization_decision', claim: 'motor_decision_execution_claims' },
): Promise<boolean> {
  const decisionTable = quoteTable(tables.decision);
  const claimTable = quoteTable(tables.claim);
  try {
    return await client.begin(async (tx: any) => {
      const eligible = await tx.unsafe(
        `select id from ${decisionTable} where id=$1 and data->>'amazon_account_id'=(select account_id from ${claimTable} where decision_id=$1 and owner_id=$2 and version=$3 and status='authorized') and data->>'status'='executing' for update`,
        [input.decisionId, input.ownerId, input.version] as any[],
      ) as unknown as Array<{ id: string }>;
      if (!eligible[0]) return false;
      const rows = await tx.unsafe(
        `update ${claimTable} set status=$4,updated_at=now(),finished_at=now(),version=version+1
       where decision_id=$1 and owner_id=$2 and version=$3 and status='authorized' returning account_id`,
        [input.decisionId, input.ownerId, input.version, input.status] as any[],
      ) as unknown as Array<{ account_id: string }>;
      if (!rows[0]) return false;
      const nextDecisionStatus = input.status === 'remote_acknowledged'
        ? 'confirming'
        : input.status === 'remote_unknown'
        ? 'conflict_reconciling'
        : 'failed';
      const nextQueueStatus = input.status === 'remote_acknowledged'
        ? 'completed'
        : input.status === 'remote_unknown'
        ? 'remote_unknown'
        : 'failed';
      const updated = await tx.unsafe(
        `update ${decisionTable} set data=jsonb_set(jsonb_set(data,'{status}',to_jsonb($3::text),true),'{queue_status}',to_jsonb($4::text),true),updated_date=now()
       where id=$1 and data->>'amazon_account_id'=$2 and data->>'status'='executing' returning id`,
        [input.decisionId, rows[0].account_id, nextDecisionStatus, nextQueueStatus] as any[],
      ) as unknown as Array<{ id: string }>;
      if (!updated[0]) throw new Error('decision_execution_fence_lost');
      return true;
    });
  } catch (error) {
    if (String((error as Error)?.message || error).includes('decision_execution_fence_lost')) {
      return false;
    }
    throw error;
  }
}
