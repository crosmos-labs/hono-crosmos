import { OpenAICompatEmbedder } from './openai-compat';

/**
 * OpenRouter embeddings (`https://openrouter.ai/api/v1/embeddings`), an
 * OpenAI-compatible gateway. Default model `openai/text-embedding-3-small` so a
 * direct-OpenAI vs. via-OpenRouter latency comparison uses the same underlying
 * model; pinned to the deployment dimension (default 1024) via the `dimensions`
 * param, which OpenRouter forwards to the OpenAI-family model. Requires
 * `OPENROUTER_API_KEY`.
 *
 * Mirrors `OpenRouterLLM` (ingestion): same base URL + attribution headers.
 */
const DEFAULT_MODEL = 'openai/text-embedding-3-small';
const DEFAULT_DIMENSIONS = 1024;
const BASE_URL = 'https://openrouter.ai/api/v1';

export interface OpenRouterEmbedderConfig {
  apiKey: string;
  /** Output dimensionality. Default 1024 (the Vectorize index dimension). */
  dimensions?: number;
  /** Override the default model id. */
  model?: string;
  /** Optional referrer/title used by OpenRouter for app attribution. */
  appUrl?: string;
  appName?: string;
}

export class OpenRouterEmbedder extends OpenAICompatEmbedder {
  constructor(config: OpenRouterEmbedderConfig) {
    const extraHeaders: Record<string, string> = {};
    if (config.appUrl) extraHeaders['HTTP-Referer'] = config.appUrl;
    if (config.appName) extraHeaders['X-Title'] = config.appName;

    super({
      baseUrl: BASE_URL,
      apiKey: config.apiKey,
      model: config.model ?? DEFAULT_MODEL,
      dimensions: config.dimensions ?? DEFAULT_DIMENSIONS,
      extraHeaders,
      providerLabel: 'OpenRouter',
    });
  }
}
