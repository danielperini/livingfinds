import postgres from 'npm:postgres';
import { claimNextRunWithSql, recoverExpiredMotorRunsWithSql } from './motorRuns.ts';
import { createOptimizationDecisionIdempotentWithSql } from './sdk/entities.ts';
import {
  finishOptimizationDecisionExecutionWithSql,
  renewOptimizationDecisionExecutionWithSql,
  reserveOptimizationDecisionExecutionWithSql,
} from './decisionExecutionClaims.ts';

const databaseUrl = Deno.env.get('LIVINGFINDS_TEST_DATABASE_URL');
const testName = 'PostgreSQL integration: idempotent decision lifecycle and fenced execution';

Deno.test({
  name: testName,
  ignore: !databaseUrl,
  fn: async () => {
    if (!databaseUrl) throw new Error('LIVINGFINDS_TEST_DATABASE_URL não configurada.');
    const client = postgres(databaseUrl, { max: 8, connect_timeout: 8, idle_timeout: 5 });
    const suffix = crypto.randomUUID().replaceAll('-', '').toLowerCase();
    const decisionTable = `lf_test_decisions_${suffix}`;
    const claimTable = `lf_test_claims_${suffix}`;
    const runTable = `lf_test_runs_${suffix}`;
    const q = (name: string) => `"${name}"`;
    try {
      await client.unsafe(
        `create table ${
          q(decisionTable)
        } (id text primary key, created_date timestamptz not null default now(), updated_date timestamptz not null default now(), created_by text, data jsonb not null)`,
      );
      await client.unsafe(
        `create unique index ${q(decisionTable + '_idem')} on ${
          q(decisionTable)
        } ((data->>'amazon_account_id'),(data->>'idempotency_key')) where data->>'amazon_account_id' is not null and data->>'idempotency_key' is not null`,
      );
      await client.unsafe(
        `create unique index ${q(decisionTable + '_logical')} on ${
          q(decisionTable)
        } ((data->>'amazon_account_id'),(data->>'logical_key')) where data->>'amazon_account_id' is not null and data->>'logical_key' is not null`,
      );
      await client.unsafe(`create table ${q(claimTable)} (
        decision_id text primary key, account_id text not null, idempotency_key text not null default '',
        owner_id text not null, attempt integer not null default 1, lease_expires_at timestamptz not null,
        version bigint not null default 1,
        status text not null check(status in ('authorized','remote_acknowledged','remote_unknown','failed_before_send')),
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), finished_at timestamptz
      )`);
      await client.unsafe(
        `create unique index ${q(claimTable + '_idem')} on ${
          q(claimTable)
        }(account_id,idempotency_key) where idempotency_key<>''`,
      );
      await client.unsafe(`create table ${q(runTable)} (
        id text primary key, request_key text not null unique, function_name text not null, account_scope text not null,
        status text not null, current_stage text, accepted_at timestamptz not null default now(), started_at timestamptz,
        last_activity_at timestamptz not null default now(), finished_at timestamptz, attempt_count integer not null default 0,
        stage_results jsonb not null default '{}'::jsonb, counters jsonb not null default '{}'::jsonb,
        errors jsonb not null default '[]'::jsonb, result_summary jsonb, request_payload jsonb not null default '{}'::jsonb,
        remote_outcome text not null default 'not_attempted', lease_id text, lease_expires_at timestamptz, created_at timestamptz not null default now()
      )`);

      const tables = { decision: decisionTable, claim: claimTable };
      const payload = {
        amazon_account_id: 'acct-a',
        idempotency_key: 'AUTO_LIFECYCLE_RETIRE|acct-a|campaign-1|rule-a|2026-10-15',
        decision_type: 'automatic_campaign_lifecycle',
        entity_type: 'campaign',
        entity_id: 'campaign-1',
        campaign_id: 'campaign-1',
        rule_key: 'rule-a',
        reason_code: 'rule-a',
        cycle_key: '2026-10-15',
        action: 'pause_campaign',
        value_before: 'ENABLED',
        value_after: 'PAUSED',
        status: 'approved',
      };

      // Two simultaneous writers must serialize on the transaction advisory lock.
      const [first, second] = await Promise.all([
        createOptimizationDecisionIdempotentWithSql(client, decisionTable, payload),
        createOptimizationDecisionIdempotentWithSql(client, decisionTable, payload),
      ]);
      if (
        first.decision?.id !== second.decision?.id ||
        Number(first.created) + Number(second.created) !== 1 ||
        Number(first.reused) + Number(second.reused) !== 1
      ) {
        throw new Error('Duas criações concorrentes não retornaram uma decisão canônica.');
      }
      const decisionId = String(first.decision?.id);
      await client.unsafe(`update ${q(decisionTable)} set data=data||$2::jsonb where id=$1`, [
        decisionId,
        { status: 'approved', history_marker: 'preserve-me', confirmation_status: 'confirmed' },
      ]);
      const beforeReuse = await client.unsafe(`select data from ${q(decisionTable)} where id=$1`, [
        decisionId,
      ]);
      const reused = await createOptimizationDecisionIdempotentWithSql(
        client,
        decisionTable,
        payload,
      );
      const afterReuse = await client.unsafe(`select data from ${q(decisionTable)} where id=$1`, [
        decisionId,
      ]);
      if (
        !reused.reused || JSON.stringify(beforeReuse[0].data) !== JSON.stringify(afterReuse[0].data)
      ) throw new Error('Reuso idempotente alterou o estado/histórico existente.');

      const divergence = await createOptimizationDecisionIdempotentWithSql(client, decisionTable, {
        ...payload,
        value_after: '0.91',
      });
      if (
        divergence.conflict?.constraint !== 'optimization_decision_idempotency_unique' ||
        !divergence.conflict.fields.includes('value_after')
      ) throw new Error('Intenção divergente não produziu conflito explícito.');
      const beforeValueDivergence = await createOptimizationDecisionIdempotentWithSql(
        client,
        decisionTable,
        { ...payload, value_before: 'PAUSED' },
      );
      if (!beforeValueDivergence.conflict?.fields.includes('value_before')) {
        throw new Error('Intenção divergente no estado anterior não produziu conflito explícito.');
      }
      const identityDivergence = await createOptimizationDecisionIdempotentWithSql(
        client,
        decisionTable,
        {
          ...payload,
          entity_id: 'campaign-2',
          campaign_id: 'campaign-2',
        },
      );
      if (!identityDivergence.conflict?.fields.includes('logical_key')) {
        throw new Error('A mesma chave de origem não pode ser reutilizada para outra entidade.');
      }
      const otherAccount = await createOptimizationDecisionIdempotentWithSql(
        client,
        decisionTable,
        { ...payload, amazon_account_id: 'acct-b' },
      );
      if (!otherAccount.created || otherAccount.decision?.id === decisionId) {
        throw new Error('Contas diferentes colidiram.');
      }
      const nextCycle = await createOptimizationDecisionIdempotentWithSql(client, decisionTable, {
        ...payload,
        cycle_key: '2026-10-16',
        idempotency_key: payload.idempotency_key.replace('2026-10-15', '2026-10-16'),
      });
      if (!nextCycle.created || nextCycle.decision?.id === decisionId) {
        throw new Error('Novo ciclo legítimo foi bloqueado pelo histórico.');
      }

      const identityRaceKey = `${payload.idempotency_key}|identity-race`;
      const identityRace = await Promise.all([
        createOptimizationDecisionIdempotentWithSql(client, decisionTable, {
          ...payload,
          idempotency_key: identityRaceKey,
        }),
        createOptimizationDecisionIdempotentWithSql(client, decisionTable, {
          ...payload,
          idempotency_key: identityRaceKey,
          entity_id: 'campaign-2',
          campaign_id: 'campaign-2',
        }),
      ]);
      const identityRaceRows = await client.unsafe(
        `select count(*)::int as count from ${
          q(decisionTable)
        } where data->>'amazon_account_id'=$1 and data->>'idempotency_key'=$2`,
        ['acct-a', identityRaceKey],
      ) as unknown as Array<{ count: number }>;
      if (
        identityRaceRows[0].count !== 1 || !identityRace.some((result) => result.conflict) ||
        Number(identityRace.filter((result) => result.created).length) !== 1
      ) {
        throw new Error(
          'Criações concorrentes divergentes com a mesma chave de origem não foram serializadas em uma linha e um conflito.',
        );
      }

      // Seed a separate approved action and simulate two workers; only the reserved worker may call the fake Amazon.
      const executionPayload = {
        ...payload,
        idempotency_key: `${payload.idempotency_key}|execution`,
        cycle_key: `${payload.cycle_key}-execution`,
        status: 'approved',
      };
      const execution = await createOptimizationDecisionIdempotentWithSql(
        client,
        decisionTable,
        executionPayload,
      );
      const executionId = String(execution.decision?.id);
      let simulatedAmazonSends = 0;
      const simulatedAmazonMutation = async () => {
        simulatedAmazonSends++;
      };
      const reservations = await Promise.all([
        reserveOptimizationDecisionExecutionWithSql(client, {
          decisionId: executionId,
          accountId: 'acct-a',
        }, tables),
        reserveOptimizationDecisionExecutionWithSql(client, {
          decisionId: executionId,
          accountId: 'acct-a',
        }, tables),
      ]);
      const winner = reservations.find((item) => item.authorized);
      if (
        reservations.filter((item) => item.authorized).length !== 1 ||
        !reservations.some((item) => !item.authorized)
      ) {
        throw new Error('Apenas uma chamada concorrente pode obter a reserva atômica.');
      }
      if (winner) await simulatedAmazonMutation();
      if (!winner?.ownerId || simulatedAmazonSends !== 1) {
        throw new Error('Reserva concorrente autorizou mais de um envio simulado.');
      }
      const finished = await finishOptimizationDecisionExecutionWithSql(client, {
        decisionId: executionId,
        ownerId: winner.ownerId,
        version: Number(winner.version),
        status: 'remote_acknowledged',
      }, tables);
      const replay = await reserveOptimizationDecisionExecutionWithSql(client, {
        decisionId: executionId,
        accountId: 'acct-a',
      }, tables);
      if (!finished || replay.authorized || simulatedAmazonSends !== 1) {
        throw new Error('Decisão confirmada foi enviada novamente.');
      }

      // Simulate timeout after possible acceptance, process restart, and stale-owner return.
      const uncertain = await createOptimizationDecisionIdempotentWithSql(client, decisionTable, {
        ...payload,
        idempotency_key: `${payload.idempotency_key}|uncertain`,
        cycle_key: `${payload.cycle_key}-uncertain`,
        status: 'approved',
      });
      const uncertainId = String(uncertain.decision?.id);
      const oldWorker = await reserveOptimizationDecisionExecutionWithSql(client, {
        decisionId: uncertainId,
        accountId: 'acct-a',
      }, tables);
      if (!oldWorker.authorized || !oldWorker.ownerId) {
        throw new Error('Worker inicial não obteve reserva.');
      }
      let fakeAmazonApplied = false;
      let uncertainAmazonSends = 0;
      try {
        // The simulated endpoint accepts the write, then the client times out
        // before seeing its response.
        uncertainAmazonSends++;
        fakeAmazonApplied = true;
        throw new Error('simulated_timeout_after_remote_acceptance');
      } catch (error) {
        if (
          !String((error as Error).message).includes('simulated_timeout_after_remote_acceptance')
        ) throw error;
      }
      const unknownStored = await finishOptimizationDecisionExecutionWithSql(client, {
        decisionId: uncertainId,
        ownerId: oldWorker.ownerId,
        version: Number(oldWorker.version),
        status: 'remote_unknown',
      }, tables);
      if (!unknownStored) throw new Error('Timeout incerto não foi persistido para reconciliação.');
      const restartedWorker = postgres(databaseUrl, {
        max: 2,
        connect_timeout: 8,
        idle_timeout: 5,
      });
      const afterRestart = await reserveOptimizationDecisionExecutionWithSql(restartedWorker, {
        decisionId: uncertainId,
        accountId: 'acct-a',
      }, tables);
      const reconciled = await Promise.resolve(fakeAmazonApplied); // simulated read-only remote-state reconciliation; no resend
      await restartedWorker.end({ timeout: 3 });
      if (
        !unknownStored || afterRestart.authorized ||
        !String(afterRestart.reason).includes('decision_status_conflict_reconciling')
      ) throw new Error('Ação incerta após reinício não exigiu reconciliação.');
      if (!reconciled || uncertainAmazonSends !== 1 || simulatedAmazonSends !== 1) {
        throw new Error('Reconciliação após timeout repetiu a alteração remota.');
      }

      const fenced = await createOptimizationDecisionIdempotentWithSql(client, decisionTable, {
        ...payload,
        idempotency_key: `${payload.idempotency_key}|fenced`,
        cycle_key: `${payload.cycle_key}-fenced`,
        status: 'approved',
      });
      const fencedId = String(fenced.decision?.id);
      const lease = await reserveOptimizationDecisionExecutionWithSql(client, {
        decisionId: fencedId,
        accountId: 'acct-a',
      }, tables);
      if (!lease.authorized || !lease.ownerId) {
        throw new Error('Worker de fencing não obteve reserva.');
      }
      const renewed = await renewOptimizationDecisionExecutionWithSql(client, {
        decisionId: fencedId,
        ownerId: lease.ownerId,
        version: Number(lease.version),
      }, claimTable);
      const staleFinish = await finishOptimizationDecisionExecutionWithSql(client, {
        decisionId: fencedId,
        ownerId: lease.ownerId,
        version: Number(lease.version),
        status: 'remote_acknowledged',
      }, tables);
      const currentFinish = renewed.renewed &&
        await finishOptimizationDecisionExecutionWithSql(client, {
          decisionId: fencedId,
          ownerId: lease.ownerId,
          version: Number(renewed.version),
          status: 'failed_before_send',
        }, tables);
      if (!renewed.renewed || staleFinish || !currentFinish) {
        throw new Error('Worker antigo atualizou após perder a versão/posse.');
      }

      await client.unsafe(
        `insert into ${q(runTable)}(id,request_key,function_name,account_scope,status) values
         ('queued-1','request-queued','runUnifiedDecisionEngine','scope-queued','queued')`,
      );
      const restartedQueueWorker = postgres(databaseUrl, {
        max: 2,
        connect_timeout: 8,
        idle_timeout: 5,
      });
      const resumed = await claimNextRunWithSql(restartedQueueWorker, runTable);
      if (
        resumed?.id !== 'queued-1' || resumed.status !== 'running' ||
        Number(resumed.attempt_count) !== 1
      ) {
        throw new Error('Worker reiniciado não retomou tarefa persistida em fila.');
      }
      await client.unsafe(
        `update ${
          q(runTable)
        } set current_stage='executeApprovedDecisionQueue',remote_outcome='sent_unconfirmed',lease_expires_at=now()-interval '1 second' where id=$1`,
        ['queued-1'],
      );
      const recovered = await recoverExpiredMotorRunsWithSql(restartedQueueWorker, runTable);
      const stale = await restartedQueueWorker.unsafe(
        `select status,remote_outcome from ${q(runTable)} where id=$1`,
        ['queued-1'],
      ) as unknown as Array<{ status: string; remote_outcome: string }>;
      const afterRecovery = await claimNextRunWithSql(restartedQueueWorker, runTable);
      await restartedQueueWorker.end({ timeout: 3 });
      if (
        recovered !== 1 || stale[0]?.status !== 'remote_unknown' ||
        stale[0]?.remote_outcome !== 'unknown' || afterRecovery
      ) {
        throw new Error(
          'Recuperação após lease expirado reenfileirou ação com resultado remoto desconhecido.',
        );
      }
    } finally {
      await client.unsafe(`drop table if exists ${q(runTable)}`);
      await client.unsafe(`drop table if exists ${q(claimTable)}`);
      await client.unsafe(`drop table if exists ${q(decisionTable)}`);
      await client.end({ timeout: 3 });
    }
  },
});
