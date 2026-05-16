import type { Env } from '../../bindings';
import { OpenAILLM } from './openai';
import { OpenRouterLLM } from './openrouter';
import type { LLM } from './port';

export type { LLM, LLMUsage, CompleteOptions, CompleteJsonOptions } from './port';
export { LLMRequestError } from './openai-compat';

/**
 * Returns the configured LLM for this environment. Selection is driven by
 * `env.LLM_PROVIDER` (default `"openrouter"`). The pipeline should always go
 * through this factory — never instantiate a provider directly.
 *
 * Throws if the selected provider's API key is missing, because ingestion is
 * meaningless without an LLM (unlike email, which silently no-ops in dev).
 */
export function getLLM(env: Env): LLM {
  const provider = env.LLM_PROVIDER ?? 'openrouter';

  if (provider === 'openai') {
    if (!env.OPENAI_API_KEY) {
      throw new Error('LLM_PROVIDER=openai but OPENAI_API_KEY is not set');
    }
    return new OpenAILLM({ apiKey: env.OPENAI_API_KEY });
  }

  // Default: OpenRouter.
  if (!env.OPENROUTER_API_KEY) {
    throw new Error('LLM_PROVIDER=openrouter but OPENROUTER_API_KEY is not set');
  }
  return new OpenRouterLLM({
    apiKey: env.OPENROUTER_API_KEY,
    appUrl: 'https://crosmos.dev',
    appName: 'Crosmos',
  });
}
