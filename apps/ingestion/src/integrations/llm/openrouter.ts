import { OpenAICompatLLM } from './openai-compat';

/**
 * Default extraction model on OpenRouter. Matches Python's
 * `extractors/constants.py:MODEL_NAME` — do not change without confirming
 * extraction parity (see docs/ingestion_migration/README.md §Critical Numbers).
 */
const DEFAULT_MODEL = 'openai/gpt-4.1-mini';

export interface OpenRouterConfig {
  apiKey: string;
  /** Optional referrer/title used by OpenRouter for app attribution. */
  appUrl?: string;
  appName?: string;
}

export class OpenRouterLLM extends OpenAICompatLLM {
  constructor(cfg: OpenRouterConfig) {
    const extraHeaders: Record<string, string> = {};
    if (cfg.appUrl) extraHeaders['HTTP-Referer'] = cfg.appUrl;
    if (cfg.appName) extraHeaders['X-Title'] = cfg.appName;

    super({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: cfg.apiKey,
      defaultModel: DEFAULT_MODEL,
      extraHeaders,
      providerLabel: 'OpenRouter',
    });
  }
}
