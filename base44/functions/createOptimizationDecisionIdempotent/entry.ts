/** Explicit Hostinger operation: transactionally create or reuse one logical decision. */
Deno.serve(async (request) => {
  try {
    const body = await request.json().catch(() => ({}));
    if (!body._service_role || !body.decision) return Response.json({ ok: false, error: 'Uso interno e decision obrigatórios.' }, { status: 403 });
    const base = Deno.env.get('MOTOR_RUNS_INTERNAL_URL') || `http://127.0.0.1:${Deno.env.get('PORT') || '8000'}`;
    const headers = new Headers({ 'content-type': 'application/json' });
    const token = Deno.env.get('API_TOKEN') || Deno.env.get('ADMIN_PASSWORD');
    if (token) headers.set('x-api-token', token);
    const response = await fetch(`${base.replace(/\/$/, '')}/internal/optimization-decisions/create-idempotent`, {
      method: 'POST', headers, signal: AbortSignal.timeout(8_000), body: JSON.stringify({ decision: body.decision }),
    });
    const result = await response.json().catch(() => ({}));
    return Response.json(result, { status: response.status });
  } catch (error) {
    return Response.json({ ok: false, error: `Criação idempotente indisponível: ${String((error as Error)?.message || error).slice(0, 200)}` }, { status: 503 });
  }
});
