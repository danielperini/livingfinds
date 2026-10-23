/** Authenticated read proxy: never dispatches an engine or creates a ledger row. */
Deno.serve(async (request) => {
  try {
    const body = await request.json();
    if (!body.account_id) return Response.json({ ok: false, error: 'account_id obrigatório' }, { status: 400 });
    const headers = new Headers();
    for (const name of ['authorization', 'x-api-token']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const url = new URL('/api/motor-status', request.url);
    url.searchParams.set('account_id', String(body.account_id));
    const response = await fetch(url, { method: 'GET', headers, cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    return Response.json(await response.json(), { status: response.status });
  } catch {
    return Response.json({ ok: false, read_only: true, error: 'Não foi possível consultar o diagnóstico do motor.' }, { status: 503 });
  }
});
