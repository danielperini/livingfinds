import {
  electSchedulerLock,
  isLiveSchedulerLock,
} from "./schedulerLockPolicy.ts";

const now = new Date("2026-08-01T15:00:00.000Z").getTime();
const base = {
  amazon_account_id: "account-1",
  lock_key: "automatic_repricing_engine",
  expires_at: "2026-08-01T16:00:00.000Z",
};

Deno.test("lock adquirido vence candidato posterior", () => {
  const winner = electSchedulerLock(
    [
      {
        ...base,
        id: "candidate",
        status: "candidate",
        created_date: "2026-08-01T14:59:00.000Z",
      },
      {
        ...base,
        id: "acquired",
        status: "acquired",
        created_date: "2026-08-01T14:59:30.000Z",
      },
    ],
    base.amazon_account_id,
    base.lock_key,
    now,
  );
  if (winner?.id !== "acquired") {
    throw new Error("candidato ultrapassou lock já adquirido");
  }
});

Deno.test("primeiro candidato vence eleição simultânea", () => {
  const winner = electSchedulerLock(
    [
      {
        ...base,
        id: "second",
        status: "candidate",
        created_date: "2026-08-01T14:59:20.000Z",
      },
      {
        ...base,
        id: "first",
        status: "candidate",
        created_date: "2026-08-01T14:59:10.000Z",
      },
    ],
    base.amazon_account_id,
    base.lock_key,
    now,
  );
  if (winner?.id !== "first") throw new Error("eleição não foi determinística");
});

Deno.test("lock expirado ou de outro escopo não participa", () => {
  const expired = {
    ...base,
    id: "expired",
    status: "acquired",
    expires_at: "2026-08-01T14:00:00.000Z",
  };
  if (
    isLiveSchedulerLock(expired, base.amazon_account_id, base.lock_key, now)
  ) {
    throw new Error("lock expirado foi considerado ativo");
  }
  const winner = electSchedulerLock(
    [
      expired,
      {
        ...base,
        id: "other-account",
        status: "acquired",
        amazon_account_id: "account-2",
      },
    ],
    base.amazon_account_id,
    base.lock_key,
    now,
  );
  if (winner) throw new Error("lock fora do escopo bloqueou a conta");
});
