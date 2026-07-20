/**
 * Integrations — reimplementa `base44.integrations.Core.*`.
 *
 * Principal: InvokeLLM (usado pelas funções de IA p/ gerar/priorizar keywords, auditar dados,
 * avaliar relevância semântica). Aqui chamamos a API da Anthropic (Claude) diretamente.
 * Quando `response_json_schema` é passado, instruímos o modelo a devolver SÓ JSON e retornamos
 * o objeto já parseado (mesma semântica que as funções esperam: usam o objeto direto).
 */
// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

function pickModel(): string {
  return (
    Deno.env.get('ANTHROPIC_MODEL_FAST') ??
    Deno.env.get('ANTHROPIC_MODEL') ??
    'claude-3-5-sonnet-20241022'
  );
}

function extractJson(text: string): Json | null {
  if (!text) return null;
  // remove cercas ```json ... ```
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  try {
    return JSON.parse(candidate);
  } catch (_e) {
    // tenta achar o primeiro objeto/array balanceado
    const start = candidate.search(/[[{]/);
    if (start === -1) return null;
    for (let end = candidate.length; end > start; end--) {
      const slice = candidate.slice(start, end);
      try {
        return JSON.parse(slice);
      } catch (_e2) { /* continua */ }
    }
    return null;
  }
}

async function invokeLLM(payload: Json): Promise<Json> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  const prompt: string = payload?.prompt ?? '';
  const schema = payload?.response_json_schema;

  if (!apiKey) {
    return { ok: false, error: 'ANTHROPIC_API_KEY não configurada', data: null };
  }

  let system = 'Você é um assistente de automação de Amazon Ads da plataforma Living Finds.';
  if (schema) {
    system +=
      ' Responda EXCLUSIVAMENTE com um JSON válido que satisfaça este JSON Schema, sem texto fora do JSON:\n' +
      JSON.stringify(schema);
  }
  if (payload?.add_context_from_internet) {
    system += ' Use seu conhecimento para inferir contexto de mercado quando útil.';
  }

  const body = {
    model: pickModel(),
    max_tokens: Number(payload?.max_tokens ?? 4096),
    temperature: Number(payload?.temperature ?? 0.2),
    system,
    messages: [{ role: 'user', content: prompt }],
  };

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  const raw = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, error: raw?.error?.message ?? `HTTP ${res.status}`, data: null };
  }
  const text: string = (raw?.content ?? []).map((b: Json) => b?.text ?? '').join('').trim();

  if (schema) {
    const parsed = extractJson(text);
    // devolve o objeto parseado direto (as funções fazem `res.campo`) e também sob .data
    return parsed ? { ...parsed, data: parsed, ok: true, text } : { ok: false, error: 'JSON inválido do modelo', text, data: null };
  }
  return { ok: true, text, data: text };
}

async function sendEmail(payload: Json): Promise<Json> {
  // Sem provedor de e-mail configurado no self-host ainda — registra e segue sem quebrar.
  console.warn('[integrations] SendEmail chamado (stub, não enviado):', payload?.to ?? payload?.subject);
  return { ok: true, stub: true };
}

async function uploadFile(payload: Json): Promise<Json> {
  console.warn('[integrations] UploadFile chamado (stub não implementado)');
  return { ok: false, error: 'UploadFile não implementado no self-host', stub: true };
}

export function makeIntegrations() {
  return {
    Core: {
      InvokeLLM: invokeLLM,
      SendEmail: sendEmail,
      UploadFile: uploadFile,
    },
  };
}
