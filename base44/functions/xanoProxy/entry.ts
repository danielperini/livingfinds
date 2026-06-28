/**
 * xanoProxy — Gateway seguro Base44 → Xano
 *
 * O frontend NUNCA chama o Xano diretamente.
 * Esta função injeta XANO_BASE_URL e XANO_API_KEY (secrets seguros).
 *
 * Payload: { method, path, body?, params? }
 * Resposta padrão Xano: { success, data, message, error }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { method = 'GET', path, body, params } = await req.json();
    if (!path) return Response.json({ error: 'path is required' }, { status: 400 });

    // XANO_BASE_URL deve ser: https://x8ki-letl-twmt.n7.xano.io/api:living-finds-api
    const xanoBase = (Deno.env.get('XANO_BASE_URL') || '').replace(/\/api:workspace:[^/]+/, '/api:living-finds-api').replace(/\/$/, '') || 'https://x8ki-letl-twmt.n7.xano.io/api:living-finds-api';
    const xanoKey = Deno.env.get('XANO_API_KEY') || '';

    if (!xanoKey) {
      return Response.json({
        ok: false,
        error: 'XANO_API_KEY não configurada. Acede a Dashboard → Settings → Environment Variables.',
      }, { status: 503 });
    }

    // Construir URL com query params
    let url = `${xanoBase}${path}`;
    if (params && Object.keys(params).length > 0) {
      url += '?' + new URLSearchParams(params).toString();
    }

    const fetchOptions = {
      method: method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': xanoKey,
        'x-api-key': xanoKey,
        'Authorization': `Bearer ${xanoKey}`,
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