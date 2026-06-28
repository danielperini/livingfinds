/**
 * xanoProxy — Gateway seguro Base44 → Xano
 * Payload: { method, path, body?, params? }
 * XANO_BASE_URL deve apontar para: https://x8ki-letl-twmt.n7.xano.io/api:amazon
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { method = 'GET', path, body, params } = await req.json();
    if (!path) return Response.json({ error: 'path is required' }, { status: 400 });

    const xanoBase = (Deno.env.get('XANO_BASE_URL') || '').replace(/\/$/, '');
    const xanoKey = Deno.env.get('XANO_API_KEY') || '';

    if (!xanoBase) return Response.json({ ok: false, error: 'XANO_BASE_URL não configurada.' }, { status: 503 });
    if (!xanoKey) return Response.json({ ok: false, error: 'XANO_API_KEY não configurada.' }, { status: 503 });

    let url = `${xanoBase}${path}`;
    if (params && Object.keys(params).length > 0) {
      url += '?' + new URLSearchParams(params).toString();
    }

    const fetchOptions = {
      method: method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': xanoKey,
      },
    };

    if (body && ['POST', 'PATCH', 'PUT'].includes(method.toUpperCase())) {
      fetchOptions.body = JSON.stringify(body);
    }

    const xanoRes = await fetch(url, fetchOptions);
    const text = await xanoRes.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!xanoRes.ok) {
      return Response.json({
        ok: false,
        status: xanoRes.status,
        error: data?.message || data?.error || `Xano respondeu com ${xanoRes.status}`,
        data,
      }, { status: xanoRes.status });
    }

    return Response.json({ ok: true, data });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});