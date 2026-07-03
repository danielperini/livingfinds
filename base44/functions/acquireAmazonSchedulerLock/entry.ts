import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    if (!body._service_role || !body.amazon_account_id || !body.lock_key) {
      return Response.json({ ok: false, error: 'Parâmetros inválidos' }, { status: 400 });
    }

    const now = new Date();
    const ownerId = body.owner_id || crypto.randomUUID();
    const ttlMs = Math.max(60000, Math.min(Number(body.ttl_ms || 900000), 3600000));
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

    const active = await base44.asServiceRole.entities.AmazonSchedulerLock.filter({
      amazon_account_id: body.amazon_account_id,
      lock_key: body.lock_key,
      status: 'acquired',
    }, 'acquired_at', 20).catch(() => []);

    for (const lock of active) {
      if (lock.expires_at && new Date(lock.expires_at).getTime() > now.getTime()) {
        return Response.json({ ok: true, acquired: false, owner_id: lock.owner_id, expires_at: lock.expires_at });
      }
      await base44.asServiceRole.entities.AmazonSchedulerLock.update(lock.id, { status: 'expired' }).catch(() => {});
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

    const candidates = await base44.asServiceRole.entities.AmazonSchedulerLock.filter({
      amazon_account_id: body.amazon_account_id,
      lock_key: body.lock_key,
      status: 'candidate',
    }, 'created_date', 50);

    const winner = candidates[0];
    if (!winner || winner.id !== candidate.id) {
      await base44.asServiceRole.entities.AmazonSchedulerLock.update(candidate.id, { status: 'released', released_at: new Date().toISOString() }).catch(() => {});
      return Response.json({ ok: true, acquired: false, owner_id: winner?.owner_id || null, expires_at: winner?.expires_at || null });
    }

    await base44.asServiceRole.entities.AmazonSchedulerLock.update(candidate.id, { status: 'acquired' });
    return Response.json({ ok: true, acquired: true, lock_id: candidate.id, owner_id: ownerId, expires_at: expiresAt });
  } catch (error) {
    return Response.json({ ok: false, acquired: false, error: error?.message || 'Erro ao adquirir lock' }, { status: 500 });
  }
});
