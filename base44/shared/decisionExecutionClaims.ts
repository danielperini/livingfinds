type ClaimResponse = { authorized?: boolean; renewed?: boolean; reason?: string; ownerId?: string; version?: number; attempt?: number; leaseExpiresAt?: string; ok?: boolean };

function internalUrl(path: string): string {
  const base = Deno.env.get('MOTOR_RUNS_INTERNAL_URL') || `http://127.0.0.1:${Deno.env.get('PORT') || '8000'}`;
  return `${base.replace(/\/$/, '')}${path}`;
}

function internalHeaders(): Headers {
  const headers = new Headers({ 'content-type': 'application/json' });
  const token = Deno.env.get('API_TOKEN') || Deno.env.get('ADMIN_PASSWORD');
  if (token) headers.set('x-api-token', token);
  return headers;
}

export async function reserveDecisionExecution(decisionId: string, accountId: string): Promise<ClaimResponse> {
  const response = await fetch(internalUrl('/internal/optimization-decision-claims/reserve'), {
    method: 'POST', headers: internalHeaders(), signal: AbortSignal.timeout(8_000),
    body: JSON.stringify({ decision_id: decisionId, account_id: accountId }),
  });
  const result = await response.json().catch(() => ({})) as ClaimResponse;
  if (!response.ok) throw new Error(`Reserva atômica da decisão indisponível (HTTP ${response.status}).`);
  return result;
}

export async function renewDecisionExecutionClaim(input: { decisionId: string; ownerId: string; version: number }): Promise<ClaimResponse> {
  const response = await fetch(internalUrl('/internal/optimization-decision-claims/renew'), {
    method: 'POST', headers: internalHeaders(), signal: AbortSignal.timeout(8_000),
    body: JSON.stringify({ decision_id: input.decisionId, owner_id: input.ownerId, version: input.version }),
  });
  const result = await response.json().catch(() => ({})) as ClaimResponse;
  if (!response.ok) throw new Error(`Renovação da posse da decisão indisponível (HTTP ${response.status}).`);
  return result;
}

export async function finishDecisionExecutionClaim(input: {
  decisionId: string;
  ownerId: string;
  version: number;
  status: 'remote_acknowledged' | 'remote_unknown' | 'failed_before_send';
}): Promise<ClaimResponse> {
  const response = await fetch(internalUrl('/internal/optimization-decision-claims/finish'), {
    method: 'POST', headers: internalHeaders(), signal: AbortSignal.timeout(8_000),
    body: JSON.stringify({ decision_id: input.decisionId, owner_id: input.ownerId, version: input.version, status: input.status }),
  });
  if (!response.ok) throw new Error(`Registro da reserva atômica indisponível (HTTP ${response.status}).`);
  return await response.json().catch(() => ({})) as ClaimResponse;
}
