import { buildOpenAIRequest, resolveLLMProvider } from './integrations.ts';

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
