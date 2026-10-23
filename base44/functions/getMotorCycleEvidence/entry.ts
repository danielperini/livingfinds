/** Read-only historical evidence. Does not change status, reconcile or replay. */
Deno.serve(async (request) => {
  try {
    const body = await request.json();
    const headers = new Headers();
    for (const name of ['authorization', 'x-api-token']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const url = new URL('/api/motor-cycle-evidence', request.url);
    for (const name of ['account_id', 'date', 'correlation_id', 'source', 'offset']) {
      if (body[name] != null) url.searchParams.set(name, String(body[name]));
    }
    const response = await fetch(url, { method: 'GET', headers, cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    return Response.json(await response.json(), { status: response.status });
  } catch {
    return Response.json({ ok: false, read_only: true, error: 'Não foi possível consultar a evidência histórica.' }, { status: 503 });
  }
});
