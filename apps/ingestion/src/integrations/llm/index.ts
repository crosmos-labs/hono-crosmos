import type { Env } from '../../bindings';
import { getIngestionConfig } from '../../config';
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
  const config = getIngestionConfig(env).llm;
  if (config.provider === 'openai') {
    return new OpenAILLM({ apiKey: config.apiKey });
  }

  return new OpenRouterLLM({
    apiKey: config.apiKey,
    appUrl: 'https://crosmos.dev',
    appName: 'Crosmos',
  });
}
