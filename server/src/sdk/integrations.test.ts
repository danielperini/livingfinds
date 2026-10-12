import { resolveLLMProvider } from './integrations.ts';

Deno.test('Hostinger V6SIA explicit OpenAI provider never silently falls back to Anthropic', () => {
  if (resolveLLMProvider('openai', true, true) !== 'openai') throw new Error('must use OpenAI when requested and configured');
  if (resolveLLMProvider('openai', false, true) !== 'missing_openai') throw new Error('missing OpenAI key must fail visibly instead of using Anthropic');
});

Deno.test('Hostinger default LLM routing prefers OpenAI and only uses Anthropic as general fallback', () => {
  if (resolveLLMProvider(undefined, true, true) !== 'openai') throw new Error('OpenAI must be preferred');
  if (resolveLLMProvider(undefined, false, true) !== 'anthropic') throw new Error('Anthropic fallback should remain for non-forced calls');
  if (resolveLLMProvider(undefined, false, false) !== 'none') throw new Error('no configured provider must be explicit');
});
