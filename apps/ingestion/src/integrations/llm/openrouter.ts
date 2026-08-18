import { OpenAICompatLLM } from './openai-compat';

/** Default extraction model when the OpenRouter adapter is selected. */
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
