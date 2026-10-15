/** Enqueues a durable motor execution and returns its run_id immediately. */
Deno.serve(async (request) => {
  try {
    const body = await request.json().catch(() => ({}));
    const origin = new URL(request.url).origin;
    const headers = new Headers({ 'content-type': 'application/json' });
    for (const name of ['authorization', 'x-api-token']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const response = await fetch(`${origin}/api/motor-runs`, {
      method: 'POST', headers,
      body: JSON.stringify({
        function_name: body.function_name || 'runCanonicalDecisionCycle',
        request_key: body.request_key || body.payload?.correlation_id || crypto.randomUUID(),
        account_id: body.account_id || body.payload?.amazon_account_id || null,
        payload: body.payload || {},
      }),
      signal: AbortSignal.timeout(8_000),
    });
    const result = await response.json().catch(() => ({}));
    return Response.json(result, { status: response.status });
  } catch (error) {
    return Response.json({ ok: false, error: `Não foi possível aceitar a execução durável: ${String((error as Error)?.message || error).slice(0, 250)}` }, { status: 503 });
  }
});
