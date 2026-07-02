/**
 * claudeAdsAgent — Teste de conectividade + utilitário central Claude/Anthropic
 *
 * Usado como função de teste e como ponto de entrada para análises do Claude
 * que não se encaixam em suggestProductKeywordsWithAI.
 *
 * Payload:
 *   mode: "ping" | "analyze"  (padrão: "ping")
 *   prompt: string            (obrigatório para mode=analyze)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const mode = body.mode || 'ping';

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) {
      return Response.json({ ok: false, error: 'ANTHROPIC_API_KEY não configurada.' }, { status: 500 });
    }

    const model = 'claude-haiku-4-5';
    const prompt = mode === 'ping'
      ? 'Responda apenas: {"status":"ok","message":"Claude conectado com sucesso ao LivingFinds."}'
      : (body.prompt || 'Olá');

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 256,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return Response.json({
        ok: false,
        http_status: res.status,
        error: err.error?.message || JSON.stringify(err),
      }, { status: 502 });
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || '';

    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}

    return Response.json({
      ok: true,
      model,
      response: parsed || text,
      input_tokens: data.usage?.input_tokens,
      output_tokens: data.usage?.output_tokens,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});