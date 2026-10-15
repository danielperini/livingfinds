/** Reads durable motor status without waiting for the run to finish. */
Deno.serve(async (request) => {
  try {
    const body = await request.json().catch(() => ({}));
    const runId = String(body.run_id || '').trim();
    if (!runId) return Response.json({ ok: false, error: 'run_id obrigatório.' }, { status: 400 });
    const origin = new URL(request.url).origin;
    const headers = new Headers();
    for (const name of ['authorization', 'x-api-token']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const response = await fetch(`${origin}/api/motor-runs/${encodeURIComponent(runId)}`, {
      method: 'GET', headers, signal: AbortSignal.timeout(5_000),
    });
    const result = await response.json().catch(() => ({}));
    return Response.json(result, { status: response.status });
  } catch (error) {
    return Response.json({ ok: false, error: `Falha ao consultar execução: ${String((error as Error)?.message || error).slice(0, 250)}` }, { status: 503 });
  }
});
