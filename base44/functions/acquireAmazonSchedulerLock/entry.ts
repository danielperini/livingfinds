import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import {
  electSchedulerLock,
  isLiveSchedulerLock,
} from '../../shared/schedulerLockPolicy.ts';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadContenders(
  base44: any,
  accountId: string,
  lockKey: string,
): Promise<any[]> {
  const [candidates, acquired] = await Promise.all([
    base44.asServiceRole.entities.AmazonSchedulerLock.filter({
      amazon_account_id: accountId,
      lock_key: lockKey,
      status: 'candidate',
    }, 'created_date', 100).catch(() => []),
    base44.asServiceRole.entities.AmazonSchedulerLock.filter({
      amazon_account_id: accountId,
      lock_key: lockKey,
      status: 'acquired',
    }, 'created_date', 100).catch(() => []),
  ]);
  return [...candidates, ...acquired];
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    if (!body._service_role || !body.amazon_account_id || !body.lock_key) {
      return Response.json({ ok: false, error: 'Parâmetros inválidos' }, { status: 400 });
    }

    const now = new Date();
    const ownerId = body.owner_id || crypto.randomUUID();

    if (body.action === 'release') {
      const locks = await loadContenders(base44, body.amazon_account_id, body.lock_key);
      const owned = body.owner_id
        ? locks.filter((lock: any) =>
          ['candidate', 'acquired'].includes(String(lock.status || '')) &&
          String(lock.owner_id) === String(body.owner_id)
        )
        : locks.filter((lock: any) => ['candidate', 'acquired'].includes(String(lock.status || '')));
      for (const lock of owned) {
        await base44.asServiceRole.entities.AmazonSchedulerLock.update(lock.id, {
          status: 'released',
          released_at: now.toISOString(),
          heartbeat_at: now.toISOString(),
        }).catch(() => {});
      }
      return Response.json({
        ok: true,
        released: owned.length,
        owner_id: body.owner_id || null,
        lock_key: body.lock_key,
      });
    }

    const ttlMs = Math.max(60000, Math.min(Number(body.ttl_ms || 900000), 3600000));
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

    const existing = await loadContenders(base44, body.amazon_account_id, body.lock_key);

    for (const lock of existing) {
      if (
        ['candidate', 'acquired'].includes(String(lock.status || '')) &&
        !isLiveSchedulerLock(lock, body.amazon_account_id, body.lock_key, now.getTime())
      ) {
        await base44.asServiceRole.entities.AmazonSchedulerLock.update(lock.id, { status: 'expired' }).catch(() => {});
      }
    }
    const activeWinner = electSchedulerLock(existing, body.amazon_account_id, body.lock_key, now.getTime());
    if (activeWinner?.status === 'acquired') {
      return Response.json({ ok: true, acquired: false, owner_id: activeWinner.owner_id, expires_at: activeWinner.expires_at });
    }

    const candidate = await base44.asServiceRole.entities.AmazonSchedulerLock.create({
      amazon_account_id: body.amazon_account_id,
      lock_key: body.lock_key,
      owner_id: ownerId,
      status: 'candidate',
      acquired_at: now.toISOString(),
      heartbeat_at: now.toISOString(),
      expires_at: expiresAt,
    });

    await wait(150 + Math.floor(Math.random() * 150));

    const contenders = await loadContenders(base44, body.amazon_account_id, body.lock_key);

    const winner = electSchedulerLock(contenders, body.amazon_account_id, body.lock_key, Date.now());
    if (!winner || winner.id !== candidate.id) {
      await base44.asServiceRole.entities.AmazonSchedulerLock.update(candidate.id, { status: 'released', released_at: new Date().toISOString() }).catch(() => {});
      return Response.json({ ok: true, acquired: false, owner_id: winner?.owner_id || null, expires_at: winner?.expires_at || null });
    }

    await base44.asServiceRole.entities.AmazonSchedulerLock.update(candidate.id, { status: 'acquired' });
    // Releitura inclui candidate + acquired. Um segundo concorrente nunca pode
    // se eleger só porque o primeiro mudou de status durante a disputa.
    await wait(100);
    const verifiedContenders = await loadContenders(base44, body.amazon_account_id, body.lock_key);
    const verifiedWinner = electSchedulerLock(
      verifiedContenders,
      body.amazon_account_id,
      body.lock_key,
      Date.now(),
    );
    if (!verifiedWinner || verifiedWinner.id !== candidate.id) {
      await base44.asServiceRole.entities.AmazonSchedulerLock.update(candidate.id, {
        status: 'released',
        released_at: new Date().toISOString(),
      }).catch(() => {});
      return Response.json({
        ok: true,
        acquired: false,
        owner_id: verifiedWinner?.owner_id || null,
        expires_at: verifiedWinner?.expires_at || null,
      });
    }
    return Response.json({ ok: true, acquired: true, lock_id: candidate.id, owner_id: ownerId, expires_at: expiresAt });
  } catch (error: any) {
    return Response.json({ ok: false, acquired: false, error: error?.message || 'Erro ao adquirir lock' }, { status: 500 });
  }
});
