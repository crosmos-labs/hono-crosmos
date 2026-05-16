import { OpenAICompatLLM } from './openai-compat';

/**
 * Default extraction model when talking to OpenAI directly. Note this is
 * the bare OpenAI model id, not OpenRouter's prefixed form — the OpenRouter
 * adapter uses `openai/gpt-4.1-mini`.
 */
const DEFAULT_MODEL = 'gpt-4.1-mini';

export interface OpenAIConfig {
  apiKey: string;
}

export class OpenAILLM extends OpenAICompatLLM {
  constructor(cfg: OpenAIConfig) {
    super({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: cfg.apiKey,
      defaultModel: DEFAULT_MODEL,
      providerLabel: 'OpenAI',
    });
  }
}
