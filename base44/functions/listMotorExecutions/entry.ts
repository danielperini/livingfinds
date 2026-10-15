/** Lists recent durable runs for the authenticated account. */
Deno.serve(async (request) => {
  try {
    const body = await request.json().catch(() => ({}));
    const origin = new URL(request.url).origin;
    const headers = new Headers();
    for (const name of ['authorization', 'x-api-token']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const query = new URLSearchParams({
      account_id: String(body.account_id || 'default-account'),
      limit: String(body.limit || 10),
    });
    const response = await fetch(`${origin}/api/motor-runs?${query}`, {
      method: 'GET', headers, signal: AbortSignal.timeout(5_000),
    });
    const result = await response.json().catch(() => ({}));
    return Response.json(result, { status: response.status });
  } catch (error) {
    return Response.json({ ok: false, error: `Falha ao consultar execuções: ${String((error as Error)?.message || error).slice(0, 250)}` }, { status: 503 });
  }
});
