import { buildOpenAIRequest, invokeOpenAI, resolveLLMProvider } from './integrations.ts';

Deno.test('Hostinger V6SIA explicit OpenAI provider never silently falls back to Anthropic', () => {
  if (resolveLLMProvider('openai', true, true) !== 'openai') throw new Error('must use OpenAI when requested and configured');
  if (resolveLLMProvider('openai', false, true) !== 'missing_openai') throw new Error('missing OpenAI key must fail visibly instead of using Anthropic');
});

Deno.test('Hostinger default LLM routing prefers OpenAI and only uses Anthropic as general fallback', () => {
  if (resolveLLMProvider(undefined, true, true) !== 'openai') throw new Error('OpenAI must be preferred');
  if (resolveLLMProvider(undefined, false, true) !== 'anthropic') throw new Error('Anthropic fallback should remain for non-forced calls');
  if (resolveLLMProvider(undefined, false, false) !== 'none') throw new Error('no configured provider must be explicit');
});

Deno.test('GPT-6 Luna V6SIA request uses supported reasoning and completion parameters', () => {
  const request = buildOpenAIRequest({
    provider: 'openai',
    model: 'gpt-6-luna',
    reasoning_effort: 'low',
    max_tokens: 4000,
    response_json_schema: { type: 'object' },
    prompt: 'diagnostic',
  });
  if (request.model !== 'gpt-6-luna') throw new Error('must select GPT-6 Luna');
  if (request.max_completion_tokens !== 4000) throw new Error('must use max_completion_tokens');
  if (request.reasoning_effort !== 'low') throw new Error('must set low reasoning effort');
  if ('temperature' in request || 'max_tokens' in request) throw new Error('must omit legacy unsupported parameters for GPT-6 reasoning');
  if (request.response_format?.type !== 'json_object') throw new Error('must preserve JSON output mode');
});

Deno.test('legacy OpenAI model retains legacy request parameters', () => {
  const request = buildOpenAIRequest({ model: 'gpt-4o', max_tokens: 1000, temperature: 0.1 });
  if (request.max_tokens !== 1000 || request.temperature !== 0.1) throw new Error('legacy request parameters should remain compatible');
  if ('reasoning_effort' in request || 'max_completion_tokens' in request) throw new Error('legacy model should not receive GPT-6 parameters');
});

Deno.test('V6SIA adapter sends GPT-6 Luna to OpenAI and preserves auditable request metadata', async () => {
  let requestBody: any;
  const result = await invokeOpenAI('test-key', {
    model: 'gpt-6-luna',
    reasoning_effort: 'low',
    max_tokens: 4000,
    response_json_schema: { type: 'object' },
    prompt: 'diagnostic',
  }, async (input, init) => {
    if (String(input) !== 'https://api.openai.com/v1/chat/completions') throw new Error('request must go to OpenAI');
    if (new Headers(init?.headers).get('authorization') !== 'Bearer test-key') throw new Error('request must use configured key');
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      id: 'chatcmpl-v6sia-test',
      model: 'gpt-6-luna',
      usage: { prompt_tokens: 21, completion_tokens: 8, total_tokens: 29 },
      choices: [{ finish_reason: 'stop', message: { content: '{"diagnosis":"ok"}' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  if (requestBody.model !== 'gpt-6-luna' || requestBody.reasoning_effort !== 'low') throw new Error('request must carry chosen GPT-6 model settings');
  if (result.request_id !== 'chatcmpl-v6sia-test' || result.model !== 'gpt-6-luna' || result.provider !== 'openai') throw new Error('successful call must report request ID and model');
  if (!result.ok || result.data?.diagnosis !== 'ok' || result.usage?.total_tokens !== 29) throw new Error('structured result and usage must be returned');
});

Deno.test('V6SIA adapter rejects length-limited OpenAI output as incomplete', async () => {
  const result = await invokeOpenAI('test-key', { model: 'gpt-6-luna', max_tokens: 5 }, async () =>
    new Response(JSON.stringify({
      id: 'chatcmpl-v6sia-short',
      model: 'gpt-6-luna',
      choices: [{ finish_reason: 'length', message: { content: '{"partial":' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  );
  if (result.ok || !result.incomplete || result.request_id !== 'chatcmpl-v6sia-short') throw new Error('truncated output must fail with its request metadata');
});
